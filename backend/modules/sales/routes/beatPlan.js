// =====================================================================
// modules/sales/routes/beatPlan.js — Electrical vertical weekly beat plan
//
//   GET    /                 list beats (?weekday=1..6&salespersonCode=)
//   GET    /reps             distinct reps in the beat table (scoped)
//   POST   /                 add outlet to a rep+weekday        (admin/heads)
//   PATCH  /:id              edit / move weekday                (admin/heads)
//   DELETE /:id              soft delete IsActive=0             (admin/heads)
//   POST   /generate         expand beats -> BN_VisitPlan rows for a month
//                            (admin/heads; idempotent via BeatId+VisitDate)
//
// Model: each outlet sits on ONE weekday (1=Mon..6=Sat) and repeats every
// week of the month (IvyDMS beat model). The generator creates normal
// BN_VisitPlan rows (Source='beat') so Visit Tracker / Punch-In / dwell
// auto-confirm work unchanged. A cron regenerates each new month.
//
// Mounted under /api/sales/beatplan by modules/sales/index.js.
// =====================================================================

const express = require('express');
const router  = express.Router();
const cron    = require('node-cron');
const multer  = require('multer');
const XLSX    = require('xlsx');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { sql, getAppPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const { resolveGeofence } = require('../../../shared/visitGeofence');

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function weekdayToNum(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  if (n >= 1 && n <= 6) return n;
  const s = String(v).trim().toLowerCase().slice(0, 3);
  const map = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return map[s] || null;
}
// flexible column lookup (case/space-insensitive)
function col(row, names) {
  for (const n of names) {
    const k = Object.keys(row).find(x => x.trim().toLowerCase() === n.toLowerCase());
    if (k !== undefined) return row[k];
  }
  return null;
}

// Beat plan is COMPANYA-only (Retailer Electrical vertical). Heads carry the team's
// code union in CompanyACode, so scoping by attribute covers the sales head (Sales Head
// Electrical) and a colleague (Electrical Head) without role-string matching.
function userCodes(user) {
  return (user.companyaCode || '').split('/').map(s => s.trim()).filter(Boolean);
}
function canEdit(user) {
  return isFullAccess(user) || (/\bhead\b/i.test(user.role || '') && userCodes(user).length > 0);
}
// Appends " AND SalespersonCode IN (...)" for non-admins. Empty codes -> 1=0.
function scopeAnd(req, r, prefix = 'sc') {
  if (isFullAccess(req.user)) return '';
  const codes = userCodes(req.user);
  if (!codes.length) return ' AND 1=0 ';
  const ph = codes.map((c, i) => { r.input(prefix + i, sql.NVarChar(100), c); return '@' + prefix + i; });
  return ` AND SalespersonCode IN (${ph.join(',')}) `;
}

// ─── GET /api/sales/beatplan ───────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = pool.request();
    let where = ' WHERE IsActive = 1 ' + scopeAnd(req, r);

    const weekday = parseInt(req.query.weekday, 10);
    if (weekday >= 1 && weekday <= 6) { where += ' AND [Weekday] = @wd '; r.input('wd', sql.TinyInt, weekday); }
    if (req.query.salespersonCode) { where += ' AND SalespersonCode = @sp '; r.input('sp', sql.NVarChar(100), String(req.query.salespersonCode)); }

    const q = await r.query(`
      SELECT Id, SalespersonCode, SalespersonName, [Weekday], OutletCode, OutletName,
             RouteCode, RouteName, Phone, Address, Lat, Lng, GeofenceId, WalkSeq
      FROM dbo.BN_BeatPlan ${where}
      ORDER BY [Weekday], WalkSeq, OutletName;

      SELECT [Weekday], COUNT(*) AS N
      FROM dbo.BN_BeatPlan ${where.replace(' AND [Weekday] = @wd ', ' ')}
      GROUP BY [Weekday];
    `);
    const dayCounts = {};
    (q.recordsets[1] || []).forEach(x => dayCounts[x.Weekday] = x.N);
    res.json({ data: q.recordsets[0] || [], dayCounts });
  } catch (err) {
    console.error('beatplan list error:', err.message);
    res.status(500).json({ message: 'Failed to load beat plan', error: err.message });
  }
});

// ─── GET /api/sales/beatplan/reps ──────────────────────────────────────────
router.get('/reps', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = pool.request();
    const q = await r.query(`
      SELECT SalespersonCode, MAX(SalespersonName) AS SalespersonName, COUNT(*) AS Outlets
      FROM dbo.BN_BeatPlan
      WHERE IsActive = 1 ${scopeAnd(req, r)}
      GROUP BY SalespersonCode
      ORDER BY MAX(SalespersonName);
    `);
    res.json({ data: q.recordset || [] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load reps', error: err.message });
  }
});

// ─── GET /api/sales/beatplan/summary ───────────────────────────────────────
// By-salesperson Planned / Completed / Pending for the beat-GENERATED visits
// (BN_VisitPlan where BeatId IS NOT NULL) — i.e. what each electrical rep planned
// this month via their beat and how many they've actually done. Scoped: admin →
// all, a head → their team's codes. This is the electrical counterpart to the
// Visit Plan dashboard (which now excludes these beat visits).
router.get('/summary', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = pool.request();
    const month = (req.query.month || '').trim();
    let monthAnd = ' AND MONTH(VisitDate) = MONTH(GETDATE()) AND YEAR(VisitDate) = YEAR(GETDATE()) ';
    if (/^\d{4}-\d{2}$/.test(month)) { const [y, m] = month.split('-').map(Number); monthAnd = ` AND YEAR(VisitDate) = ${y} AND MONTH(VisitDate) = ${m} `; }
    const scope = scopeAnd(req, r);   // '' for admin, ' AND SalespersonCode IN (...)' for heads
    const base = `FROM dbo.BN_VisitPlan WHERE Company = 'COMPANYA' AND BeatId IS NOT NULL ${monthAnd} ${scope}`;
    const q = await r.query(`
      SELECT SalespersonCode, MAX(SalespersonName) AS SalespersonName,
             COUNT(*)                                        AS Planned,
             SUM(CASE WHEN VisitDone = 1 THEN 1 ELSE 0 END)  AS Completed,
             SUM(CASE WHEN VisitDone = 0 THEN 1 ELSE 0 END)  AS Pending
      ${base}
      GROUP BY SalespersonCode
      ORDER BY Planned DESC;

      SELECT COUNT(*)                                        AS Planned,
             SUM(CASE WHEN VisitDone = 1 THEN 1 ELSE 0 END)  AS Completed,
             SUM(CASE WHEN VisitDone = 0 THEN 1 ELSE 0 END)  AS Pending
      ${base};
    `);
    res.json({ byRep: q.recordsets[0] || [], totals: (q.recordsets[1] || [])[0] || { Planned: 0, Completed: 0, Pending: 0 } });
  } catch (err) {
    console.error('beatplan summary error:', err.message);
    res.status(500).json({ message: 'Failed to load beat summary', error: err.message });
  }
});

// ─── POST /api/sales/beatplan ──────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    if (!canEdit(req.user)) return res.status(403).json({ message: 'Heads / admin only' });
    const { salespersonCode, salespersonName, weekday, phone, routeName, lat, lng } = req.body || {};
    // Cap at 200 to match BN_VisitPlan.CustomerName / HRM_Geofence.Name widths.
    const outletName = String((req.body || {}).outletName || '').trim().slice(0, 200);
    const wd = parseInt(weekday, 10);
    if (!salespersonCode || !outletName || !(wd >= 1 && wd <= 6)) {
      return res.status(400).json({ message: 'salespersonCode, outletName and weekday (1-6) are required' });
    }
    // Non-admin heads may only touch their own team's codes
    if (!isFullAccess(req.user) && !userCodes(req.user).includes(salespersonCode)) {
      return res.status(403).json({ message: 'Not authorized for this salesperson' });
    }

    const pool = await getAppPool();
    let geofenceId = null;
    const nLat = Number(lat), nLng = Number(lng);
    if (isFinite(nLat) && isFinite(nLng) && nLat > 1 && nLng > 1) {
      const g = await resolveGeofence(pool, {
        customerName: String(outletName).trim(), lat: nLat, lng: nLng,
        company: 'COMPANYA', userId: req.user.id,
      });
      geofenceId = g.geofenceId;
    }

    const ins = await pool.request()
      .input('sc',  sql.NVarChar(100), salespersonCode)
      .input('sn',  sql.NVarChar(200), salespersonName || null)
      .input('wd',  sql.TinyInt,       wd)
      .input('on',  sql.NVarChar(400), String(outletName).trim())
      .input('rn',  sql.NVarChar(200), routeName || null)
      .input('ph',  sql.NVarChar(40),  phone || null)
      .input('lat', sql.Decimal(10,7), isFinite(nLat) && nLat > 1 ? nLat : null)
      .input('lng', sql.Decimal(10,7), isFinite(nLng) && nLng > 1 ? nLng : null)
      .input('gid', sql.Int,           geofenceId)
      .input('by',  sql.NVarChar(100), req.user.name || req.user.username || '')
      .query(`
        INSERT INTO dbo.BN_BeatPlan
          (Company, SalespersonCode, SalespersonName, [Weekday], OutletName, RouteName, Phone, Lat, Lng, GeofenceId, CreatedBy)
        OUTPUT INSERTED.Id
        VALUES ('COMPANYA', @sc, @sn, @wd, @on, @rn, @ph, @lat, @lng, @gid, @by);
      `);
    res.json({ message: 'Outlet added to beat', id: ins.recordset[0].Id });
  } catch (err) {
    console.error('beatplan create error:', err.message);
    res.status(500).json({ message: 'Failed to add outlet', error: err.message });
  }
});

// ─── PATCH /api/sales/beatplan/:id ─────────────────────────────────────────
router.patch('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    if (!canEdit(req.user)) return res.status(403).json({ message: 'Heads / admin only' });
    const pool = await getAppPool();

    const chk = pool.request().input('id', sql.Int, parseInt(req.params.id, 10));
    const row = await chk.query(`SELECT Id, SalespersonCode FROM dbo.BN_BeatPlan WHERE Id = @id AND IsActive = 1 ${scopeAnd({ user: req.user }, chk, 'ck')}`);
    if (!row.recordset.length) return res.status(404).json({ message: 'Beat row not found (or out of your scope)' });

    const sets = [];
    const r = pool.request().input('id', sql.Int, parseInt(req.params.id, 10));
    const wd = parseInt(req.body?.weekday, 10);
    if (wd >= 1 && wd <= 6)            { sets.push('[Weekday] = @wd');   r.input('wd', sql.TinyInt, wd); }
    if (req.body?.outletName)          { sets.push('OutletName = @on');  r.input('on', sql.NVarChar(400), String(req.body.outletName).trim()); }
    if (req.body?.phone !== undefined) { sets.push('Phone = @ph');       r.input('ph', sql.NVarChar(40), req.body.phone || null); }
    if (req.body?.routeName !== undefined) { sets.push('RouteName = @rn'); r.input('rn', sql.NVarChar(200), req.body.routeName || null); }
    if (req.body?.walkSeq !== undefined)   { sets.push('WalkSeq = @ws');   r.input('ws', sql.Int, parseInt(req.body.walkSeq, 10) || 0); }
    if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });

    r.input('by', sql.NVarChar(100), req.user.name || req.user.username || '');
    await r.query(`UPDATE dbo.BN_BeatPlan SET ${sets.join(', ')}, UpdatedAt = SYSDATETIME(), UpdatedBy = @by WHERE Id = @id;`);
    res.json({ message: 'Beat updated' });
  } catch (err) {
    console.error('beatplan patch error:', err.message);
    res.status(500).json({ message: 'Failed to update beat', error: err.message });
  }
});

// ─── DELETE /api/sales/beatplan/:id (soft) ─────────────────────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    if (!canEdit(req.user)) return res.status(403).json({ message: 'Heads / admin only' });
    const pool = await getAppPool();
    const r = pool.request()
      .input('id', sql.Int, parseInt(req.params.id, 10))
      .input('by', sql.NVarChar(100), req.user.name || req.user.username || '');
    const scope = scopeAnd({ user: req.user }, r, 'dl');
    const upd = await r.query(`
      UPDATE dbo.BN_BeatPlan SET IsActive = 0, UpdatedAt = SYSDATETIME(), UpdatedBy = @by
      WHERE Id = @id AND IsActive = 1 ${scope};
      SELECT @@ROWCOUNT AS N;
    `);
    if (!upd.recordset[0].N) return res.status(404).json({ message: 'Beat row not found (or out of your scope)' });
    res.json({ message: 'Outlet removed from beat (soft delete)' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to remove beat', error: err.message });
  }
});

// ─── GET /api/sales/beatplan/export ────────────────────────────────────────
// Round-trippable Excel of the current beats (scoped). Edit it and re-import.
router.get('/export', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = pool.request();
    let where = ' WHERE IsActive = 1 ' + scopeAnd(req, r);
    if (req.query.salespersonCode) { where += ' AND SalespersonCode = @sp '; r.input('sp', sql.NVarChar(100), String(req.query.salespersonCode)); }
    const q = await r.query(`
      SELECT Id, SalespersonCode, SalespersonName, [Weekday], OutletCode, OutletName,
             RouteName, Phone, Lat, Lng
      FROM dbo.BN_BeatPlan ${where}
      ORDER BY SalespersonName, [Weekday], WalkSeq, OutletName;
    `);
    const aoa = q.recordset.map(x => ({
      BeatId:          x.Id,
      SalespersonCode: x.SalespersonCode,
      SalespersonName: x.SalespersonName,
      Weekday:         DAY_NAMES[x.Weekday] || x.Weekday,
      OutletCode:      x.OutletCode || '',
      OutletName:      x.OutletName,
      RouteName:       x.RouteName || '',
      Phone:           x.Phone || '',
      Lat:             x.Lat != null ? Number(x.Lat) : '',
      Lng:             x.Lng != null ? Number(x.Lng) : '',
      Active:          1,
    }));
    const ws = XLSX.utils.json_to_sheet(aoa, {
      header: ['BeatId','SalespersonCode','SalespersonName','Weekday','OutletCode','OutletName','RouteName','Phone','Lat','Lng','Active'],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'BeatPlan');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="BeatPlan_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.end(buf);
  } catch (err) {
    console.error('beatplan export error:', err.message);
    res.status(500).json({ message: 'Failed to export beat plan', error: err.message });
  }
});

// ─── POST /api/sales/beatplan/import ───────────────────────────────────────
// UPSERT from the export shape. Keyed by BeatId, else (SalespersonCode +
// OutletCode), else (SalespersonCode + OutletName). Active=0 soft-deletes.
// ?dryRun=true previews counts without writing. Heads limited to their codes.
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!canEdit(req.user)) return res.status(403).json({ message: 'Heads / admin only' });
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const dryRun = String(req.query.dryRun || req.body?.dryRun || '').toLowerCase() === 'true';

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    if (!rows.length) return res.status(400).json({ message: 'Sheet is empty' });

    const myCodes = isFullAccess(req.user) ? null : userCodes(req.user);
    const pool = await getAppPool();
    const out = { rows: rows.length, inserted: 0, updated: 0, deactivated: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ln = i + 2;   // human row number (header = row 1)
      try {
        const spCode = String(col(row, ['SalespersonCode','Seller Code']) || '').trim();
        const outletName = String(col(row, ['OutletName','Outlet Name']) || '').trim().slice(0, 200);
        const wd = weekdayToNum(col(row, ['Weekday','Day']));
        const beatId = parseInt(col(row, ['BeatId','Id']), 10) || null;
        const activeRaw = col(row, ['Active','IsActive']);
        const active = activeRaw == null ? 1 : (parseInt(activeRaw, 10) === 0 ? 0 : 1);

        if (!spCode) { out.errors.push(`Row ${ln}: missing SalespersonCode`); out.skipped++; continue; }
        if (myCodes && !myCodes.includes(spCode)) { out.errors.push(`Row ${ln}: ${spCode} is outside your team`); out.skipped++; continue; }
        if (active === 1 && !outletName) { out.errors.push(`Row ${ln}: missing OutletName`); out.skipped++; continue; }
        if (active === 1 && !wd) { out.errors.push(`Row ${ln}: invalid Weekday`); out.skipped++; continue; }

        const spName = String(col(row, ['SalespersonName','Seller Name']) || '').trim() || null;
        const outletCode = String(col(row, ['OutletCode','Outlet Code']) || '').trim() || null;
        const routeName = String(col(row, ['RouteName','Route Name']) || '').trim() || null;
        const phoneRaw = col(row, ['Phone','Ret_Phone']);
        const phone = phoneRaw != null && String(phoneRaw).trim().length >= 10 ? String(phoneRaw).trim().slice(0, 40) : null;
        const latN = Number(col(row, ['Lat','Latitude']));
        const lngN = Number(col(row, ['Lng','Longitude']));
        const lat = isFinite(latN) && latN > 1 ? latN : null;
        const lng = isFinite(lngN) && lngN > 1 ? lngN : null;

        // Find existing beat: BeatId → (code+outletCode) → (code+outletName)
        const findR = pool.request().input('sp', sql.NVarChar(100), spCode);
        let findWhere;
        if (beatId) { findR.input('bid', sql.Int, beatId); findWhere = 'Id = @bid AND SalespersonCode = @sp'; }
        else if (outletCode) { findR.input('oc', sql.NVarChar(40), outletCode); findWhere = "SalespersonCode = @sp AND OutletCode = @oc AND IsActive = 1"; }
        else { findR.input('on', sql.NVarChar(400), outletName); findWhere = "SalespersonCode = @sp AND OutletName = @on AND IsActive = 1"; }
        const existing = await findR.query(`SELECT TOP 1 Id, GeofenceId FROM dbo.BN_BeatPlan WHERE ${findWhere} ORDER BY Id;`);
        const hit = existing.recordset[0];

        if (active === 0) {
          if (hit && !dryRun) {
            await pool.request().input('id', sql.Int, hit.Id).input('by', sql.NVarChar(100), req.user.name || req.user.username || '')
              .query(`UPDATE dbo.BN_BeatPlan SET IsActive = 0, UpdatedAt = SYSDATETIME(), UpdatedBy = @by WHERE Id = @id;`);
          }
          if (hit) out.deactivated++; else out.skipped++;
          continue;
        }

        // resolve geofence when coords are present (reuse-or-create)
        let geofenceId = hit ? hit.GeofenceId : null;
        if (lat != null && (!geofenceId)) {
          if (!dryRun) {
            const g = await resolveGeofence(pool, { customerName: outletName, lat, lng, company: 'COMPANYA', userId: req.user.id });
            geofenceId = g.geofenceId;
          }
        }

        if (hit) {
          if (!dryRun) {
            await pool.request()
              .input('id', sql.Int, hit.Id)
              .input('sn', sql.NVarChar(200), spName)
              .input('wd', sql.TinyInt, wd)
              .input('on', sql.NVarChar(400), outletName)
              .input('oc', sql.NVarChar(40), outletCode)
              .input('rn', sql.NVarChar(200), routeName)
              .input('ph', sql.NVarChar(40), phone)
              .input('lat', sql.Decimal(10,7), lat)
              .input('lng', sql.Decimal(10,7), lng)
              .input('gid', sql.Int, geofenceId)
              .input('by', sql.NVarChar(100), req.user.name || req.user.username || '')
              .query(`UPDATE dbo.BN_BeatPlan SET SalespersonName=@sn, [Weekday]=@wd, OutletName=@on,
                        OutletCode=COALESCE(@oc, OutletCode), RouteName=@rn, Phone=@ph,
                        Lat=@lat, Lng=@lng, GeofenceId=@gid, IsActive=1,
                        UpdatedAt=SYSDATETIME(), UpdatedBy=@by WHERE Id=@id;`);
          }
          out.updated++;
        } else {
          if (!dryRun) {
            await pool.request()
              .input('sc', sql.NVarChar(100), spCode)
              .input('sn', sql.NVarChar(200), spName)
              .input('wd', sql.TinyInt, wd)
              .input('oc', sql.NVarChar(40), outletCode)
              .input('on', sql.NVarChar(400), outletName)
              .input('rn', sql.NVarChar(200), routeName)
              .input('ph', sql.NVarChar(40), phone)
              .input('lat', sql.Decimal(10,7), lat)
              .input('lng', sql.Decimal(10,7), lng)
              .input('gid', sql.Int, geofenceId)
              .input('by', sql.NVarChar(100), req.user.name || req.user.username || '')
              .query(`INSERT INTO dbo.BN_BeatPlan
                        (Company, SalespersonCode, SalespersonName, [Weekday], OutletCode, OutletName,
                         RouteName, Phone, Lat, Lng, GeofenceId, CreatedBy)
                      VALUES ('COMPANYA', @sc, @sn, @wd, @oc, @on, @rn, @ph, @lat, @lng, @gid, @by);`);
          }
          out.inserted++;
        }
      } catch (e) {
        out.errors.push(`Row ${ln}: ${e.message}`);
        out.skipped++;
      }
    }

    const verb = dryRun ? 'Preview' : 'Imported';
    out.message = `${verb}: ${out.inserted} new, ${out.updated} updated, ${out.deactivated} removed, ${out.skipped} skipped`
      + (dryRun ? ' (no changes written — uncheck Preview to apply)' : '. Click "Generate This Month" to refresh the visit plans.');
    out.errors = out.errors.slice(0, 25);
    res.json(out);
  } catch (err) {
    console.error('beatplan import error:', err.message);
    res.status(500).json({ message: 'Failed to import beat plan', error: err.message });
  }
});

// ─── Month generation ──────────────────────────────────────────────────────
// Expands every active beat into BN_VisitPlan rows for the given month.
// Idempotent: skips (BeatId, VisitDate) pairs that already exist. For the
// CURRENT month only dates >= tomorrow are generated (history stays clean).
//
// scopeCodes: null = all beats (admin / cron); array = only these salesperson
//   codes (a non-admin head generates only their own team's beats).
//
// Notes vs review findings:
//   - CustomerName is LEFT(...,200) because BN_VisitPlan.CustomerName is
//     NVARCHAR(200) while BN_BeatPlan.OutletName is NVARCHAR(400) — without the
//     clamp one long name aborts the whole day's INSERT and the month.
//   - ContactPerson/ContactDetails are filled ('Counter' / phone-or-'NA') so
//     beat rows satisfy the Visit Plan edit screen's mandatory-contact gate.
async function generateMonth(year, month /* 1-12 */, startFrom /* Date|null */, scopeCodes /* string[]|null */) {
  const pool = await getAppPool();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const minDate = startFrom || new Date(today.getTime() + 86400000);   // tomorrow

  const dates = [];   // { d: Date, weekday: 1..6 }
  const last = new Date(year, month, 0).getDate();
  for (let day = 1; day <= last; day++) {
    const d = new Date(year, month - 1, day);
    const dow = d.getDay();                  // 0=Sun..6=Sat
    if (dow === 0) continue;                 // Sundays off
    if (d < minDate) continue;
    dates.push({ d, weekday: dow });         // Mon=1..Sat=6 matches getDay()
  }

  // Optional salesperson-code scope (non-admin head -> own team only)
  let scopeAndSql = '';
  const scopeBind = (r) => {};
  let bindScope = scopeBind;
  if (Array.isArray(scopeCodes)) {
    if (!scopeCodes.length) return { dates: dates.length, inserted: 0 };  // head with no codes
    const ph = scopeCodes.map((_, i) => '@gc' + i).join(',');
    scopeAndSql = ` AND b.SalespersonCode IN (${ph}) `;
    bindScope = (r) => scopeCodes.forEach((c, i) => r.input('gc' + i, sql.NVarChar(100), c));
  }

  let inserted = 0;
  for (const { d, weekday } of dates) {
    const r = pool.request()
      .input('d',  sql.Date,    d)
      .input('wd', sql.TinyInt, weekday);
    bindScope(r);
    const q = await r.query(`
      INSERT INTO dbo.BN_VisitPlan
        (Company, SalespersonCode, SalespersonName, VisitDate, CustomerName,
         Location, ContactPerson, ContactDetails, VisitDone, IsAdHoc, Source, Department,
         VisitLat, VisitLng, GeofenceId, BeatId, CreatedAt)
      SELECT 'COMPANYA', b.SalespersonCode, b.SalespersonName, @d, LEFT(b.OutletName, 200),
             b.RouteName, 'Counter', ISNULL(NULLIF(b.Phone, ''), 'NA'), 0, 0, 'beat', 'sales',
             b.Lat, b.Lng, b.GeofenceId, b.Id, GETDATE()
      FROM dbo.BN_BeatPlan b
      WHERE b.IsActive = 1 AND b.[Weekday] = @wd ${scopeAndSql}
        AND NOT EXISTS (SELECT 1 FROM dbo.BN_VisitPlan v WHERE v.BeatId = b.Id AND v.VisitDate = @d);
      SELECT @@ROWCOUNT AS N;
    `);
    inserted += q.recordset[0].N;
  }
  return { dates: dates.length, inserted };
}

// ─── POST /api/sales/beatplan/generate ─────────────────────────────────────
router.post('/generate', authenticate, async (req, res) => {
  try {
    if (!canEdit(req.user)) return res.status(403).json({ message: 'Heads / admin only' });

    // Serialize: the monthly cron + any number of head clicks share one process,
    // so a global flag prevents the NOT-EXISTS idempotency race (duplicate rows).
    if (global.__beatGenRunning) {
      return res.status(409).json({ message: 'A generation run is already in progress — try again in a moment.' });
    }

    const now = new Date();
    const year  = parseInt(req.body?.year, 10)  || now.getFullYear();
    const month = parseInt(req.body?.month, 10) || (now.getMonth() + 1);
    if (month < 1 || month > 12) return res.status(400).json({ message: 'month must be 1-12' });
    // Clamp year to [this year, next year] so a stray {year:2040} can't flood the table.
    if (year < now.getFullYear() || year > now.getFullYear() + 1) {
      return res.status(400).json({ message: `year must be ${now.getFullYear()} or ${now.getFullYear() + 1}` });
    }

    // Non-admins generate ONLY their own team's beats (heads carry the code union).
    const scopeCodes = isFullAccess(req.user) ? null : userCodes(req.user);

    global.__beatGenRunning = true;
    let out;
    try {
      out = await generateMonth(year, month, null, scopeCodes);
    } finally {
      global.__beatGenRunning = false;
    }

    console.log(`[beatPlan] manual generate ${year}-${month} by ${req.user.username}: ${out.inserted} visit-plan rows over ${out.dates} day(s)`);
    res.json({ message: `Generated ${out.inserted} visit-plan rows across ${out.dates} day(s) for ${year}-${String(month).padStart(2, '0')}`, ...out });
  } catch (err) {
    global.__beatGenRunning = false;
    console.error('beatplan generate error:', err.message);
    res.status(500).json({ message: 'Failed to generate month', error: err.message });
  }
});

// ─── Monthly cron — 1st of every month, 01:30 IST ──────────────────────────
// Registered once at module load (this file is require()'d a single time at
// boot by modules/sales/index.js). Generates the full new month.
if (!global.__beatPlanCronRegistered) {
  global.__beatPlanCronRegistered = true;
  try {
    cron.schedule('30 1 1 * *', async () => {
      if (global.__beatGenRunning) { console.warn('[beatPlan] cron skipped — a generation run is already in progress'); return; }
      global.__beatGenRunning = true;
      try {
        const now = new Date();
        // startFrom = midnight of the 1st so day-1 visits are included
        // (cron fires at 01:30 — passing `now` would skip the 1st itself).
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const out = await generateMonth(now.getFullYear(), now.getMonth() + 1, monthStart, null);
        console.log(`[beatPlan] monthly cron generated ${out.inserted} visit-plan rows for ${now.getFullYear()}-${now.getMonth() + 1}`);
      } catch (e) {
        console.error('[beatPlan] monthly cron failed:', e.message);
      } finally {
        global.__beatGenRunning = false;
      }
    }, { timezone: 'Asia/Kolkata' });
    console.log('[beatPlan] monthly generation cron registered (1st, 01:30 IST)');
  } catch (e) {
    console.error('[beatPlan] cron registration failed:', e.message);
  }
}

module.exports = router;
