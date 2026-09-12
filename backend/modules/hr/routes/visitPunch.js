// =====================================================================
// modules/hr/routes/visitPunch.js — Punch-In / Punch-Out at customer (v1.8)
//
// Mounted at /api/hr/visit-punch/* by ../index.js.
//
// Endpoints:
//   POST /in                   — Punch-In  (creates HRM_Visit row, opens visit)
//   POST /out/:visitId         — Punch-Out (closes the visit)
//   GET  /today                — Today's visits for the current user (own only)
//   GET  /open                 — Currently open punch (or null)
//
// Photo handling (matches the v1.7 attendance.js selfie pattern):
//   • Photos arrive as base64 data URIs in the JSON body
//     (Punch-In  → selfieData + premisePhotoData)
//     (Punch-Out → premisePhotoData only — no second selfie per design)
//   • Decoded + written to disk under backend/uploads/visit-punches/{userId}/{date}/
//   • Per-photo size cap: 3 MB (so two photos fit comfortably under the 8 MB
//     express.json() limit even with base64's ~33 % overhead).
//   • DB stores the relative URL only (/uploads/visit-punches/...). Files are
//     served by server.js' express.static('/uploads', ...) mount.
//
// Geofence:
//   • Reuses backend/shared/visitGeofence.js → resolveGeofence(). First-ever
//     visits to a customer auto-create a 100 m fence from the punch GPS;
//     repeat visits dedup by NAV CustomerCode (or by exact Name for prospects).
//   • Auto-detect (visitDetector.js) keeps running as belt-and-braces. Reps
//     who forget to punch still get visits via geofence dwell — they just
//     don't have photos.
//
// MOM dropped by design (2026-06-03) — salespersons already fill MOM in
// another software. Visit closes on Punch-Out with timestamp + premise photo.
//
// One-open-punch rule: a user cannot have two open punch-in visits at once.
// Punch-In returns 409 if there's already an open row with PunchInTime IS NOT
// NULL AND PunchOutTime IS NULL — caller must punch out first.
// =====================================================================

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin, isFaeHead, isAnyHead } = require('../../../auth');
const { resolveGeofence } = require('../../../shared/visitGeofence');

const PUNCH_PHOTO_ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'visit-punches');
try { fs.mkdirSync(PUNCH_PHOTO_ROOT, { recursive: true }); } catch (_) {}

const MAX_PHOTO_BYTES = 3 * 1024 * 1024;   // 3 MB per photo

// ── helpers ────────────────────────────────────────────────────────────────
function todayISO(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function pickCompany(user) {
  if (user.companyaCode && user.companyaCode.trim())       return 'COMPANYA';
  if (user.companybCode && user.companybCode.trim()) return 'CompanyB';
  return 'COMPANYA';   // FAE + HR with no codes default to COMPANYA context
}
function pickUserCode(user) {
  if (user.companyaCode && user.companyaCode.trim())       return user.companyaCode.split('/')[0].trim();
  if (user.companybCode && user.companybCode.trim()) return user.companybCode.split('/')[0].trim();
  return (user.username || '').slice(0, 50);
}

// Save a base64 data URI as a JPEG/PNG/WEBP file. Returns relative URL or null
// on invalid / oversized input. Caller decides whether to fail the punch when
// the photo can't be saved.
function savePunchPhoto(userId, visitId, kind, dataUri) {
  // kind ∈ { 'in-selfie', 'in-premise', 'out-premise' }
  if (!dataUri || typeof dataUri !== 'string') return null;
  const m = dataUri.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) return null;
  const dateISO = todayISO();
  const dir = path.join(PUNCH_PHOTO_ROOT, String(userId), dateISO);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file  = `${visitId}-${kind}-${stamp}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `/uploads/visit-punches/${userId}/${dateISO}/${file}`;
}

// Insert a HRM_LocationPing for a punch event so the trail picks up the moment.
async function insertPunchPing(pool, user, body, source) {
  // Accuracy is DECIMAL(6,2) on HRM_LocationPing (max 9999.99 m). A desktop
  // browser without GPS can report 10000+ m which overflows the column and
  // crashes the INSERT with "Arithmetic overflow converting float to numeric".
  // Clamp to the column's max and null out anything garbage. (Fixed 2026-06-03.)
  const rawAcc = body && body.accuracy != null ? Number(body.accuracy) : null;
  const safeAcc = (rawAcc != null && Number.isFinite(rawAcc) && rawAcc >= 0)
    ? Math.min(rawAcc, 9999.99)
    : null;

  const r = pool.request();
  r.input('userId',    sql.Int,           user.id);
  r.input('userCode',  sql.NVarChar(50),  pickUserCode(user));
  r.input('company',   sql.NVarChar(10),  pickCompany(user));
  r.input('pingTime',  sql.DateTime2,     new Date());
  r.input('lat',       sql.Decimal(9, 6), Number(body.lat));
  r.input('lng',       sql.Decimal(9, 6), Number(body.lng));
  r.input('accuracy',  sql.Decimal(6, 2), safeAcc);
  r.input('source',    sql.NVarChar(20),  source);
  const res = await r.query(`
    INSERT INTO [dbo].[HRM_LocationPing]
      (UserId, UserCode, Company, PingTime, Lat, Lng, Accuracy, Source)
    OUTPUT INSERTED.PingId, INSERTED.PingTime
    VALUES (@userId, @userCode, @company, @pingTime, @lat, @lng, @accuracy, @source);
  `);
  return res.recordset[0];   // { PingId, PingTime }
}

// ── POST /in — Punch-In ────────────────────────────────────────────────────
router.post('/in', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const b    = req.body || {};

    // Validate
    if (!b.customerName || !String(b.customerName).trim())
      return res.status(400).json({ message: 'customerName is required' });
    if (b.lat == null || b.lng == null || isNaN(Number(b.lat)) || isNaN(Number(b.lng)))
      return res.status(400).json({ message: 'lat / lng required (numeric)' });
    if (!b.selfieData)
      return res.status(400).json({ message: 'selfieData (base64 data URI) required' });
    if (!b.premisePhotoData)
      return res.status(400).json({ message: 'premisePhotoData (base64 data URI) required' });

    const pool = await getAppPool();

    // 1. Reject if there's already an open punch-in visit for this user.
    const openCheck = await pool.request().input('uid', sql.Int, user.id).query(`
      SELECT TOP 1 VisitId, CustomerName
      FROM [dbo].[HRM_Visit]
      WHERE UserId = @uid AND PunchInTime IS NOT NULL AND PunchOutTime IS NULL
      ORDER BY VisitId DESC;
    `);
    if (openCheck.recordset.length > 0) {
      const o = openCheck.recordset[0];
      return res.status(409).json({
        message: `Already punched in at "${o.CustomerName || 'a customer'}" — punch out first.`,
        openVisitId: o.VisitId,
      });
    }

    // 2. Resolve / auto-create geofence for this customer.
    const company = pickCompany(user);
    const customerName = String(b.customerName).trim();
    const { geofenceId } = await resolveGeofence(pool, {
      customerCode: b.customerCode || null,
      customerName,
      lat: b.lat,
      lng: b.lng,
      address: b.address || null,
      city:    b.city    || null,
      state:   b.state   || null,
      pincode: b.pincode || null,
      company,
      userId:  user.id,
    });

    // 3. Insert a HRM_LocationPing for the punch-in moment.
    const ping = await insertPunchPing(pool, user, b, 'punch-in');
    const punchTime = new Date(ping.PingTime);

    // 4. INSERT HRM_Visit row. EntryTime == PunchInTime — an explicit punch is
    //    the authoritative start of the visit. IsConfirmedVisit=1 immediately
    //    (no need to wait for dwell threshold) since the rep has self-attested.
    const insRes = await pool.request()
      .input('uid',  sql.Int,           user.id)
      .input('uc',   sql.NVarChar(50),  pickUserCode(user))
      .input('co',   sql.NVarChar(10),  company)
      .input('fid',  sql.Int,           geofenceId)
      .input('cc',   sql.NVarChar(50),  b.customerCode || null)
      .input('cn',   sql.NVarChar(200), customerName.slice(0, 200))
      .input('dept', sql.NVarChar(10),  'SALES')
      .input('et',   sql.DateTime2,     punchTime)
      .input('ep',   sql.BigInt,        ping.PingId)
      .input('lat',  sql.Decimal(9, 6), Number(b.lat))
      .input('lng',  sql.Decimal(9, 6), Number(b.lng))
      .input('pit',  sql.DateTime2,     punchTime)
      .input('plat', sql.Decimal(9, 6), Number(b.lat))
      .input('plng', sql.Decimal(9, 6), Number(b.lng))
      .input('acf',  sql.DateTime2,     punchTime)
      .input('vpid', sql.Int,           b.visitPlanId ? parseInt(b.visitPlanId) : null)
      .query(`
        INSERT INTO [dbo].[HRM_Visit]
          (UserId, UserCode, Company, GeofenceId, CustomerCode, CustomerName,
           Department, EntryTime, EntryPingId, Lat, Lng,
           PunchInTime, PunchInLat, PunchInLng,
           IsConfirmedVisit, AutoConfirmedAt, VisitPlanId)
        OUTPUT INSERTED.VisitId
        VALUES
          (@uid, @uc, @co, @fid, @cc, @cn, @dept, @et, @ep, @lat, @lng,
           @pit, @plat, @plng, 1, @acf, @vpid);
      `);
    const visitId = insRes.recordset[0].VisitId;

    // 5. Save photos with the real visitId in the filename.
    const selfieUrl  = savePunchPhoto(user.id, visitId, 'in-selfie',  b.selfieData);
    const premiseUrl = savePunchPhoto(user.id, visitId, 'in-premise', b.premisePhotoData);
    if (!selfieUrl || !premiseUrl) {
      // Roll back the visit row so we don't leave a punch with NULL photos.
      await pool.request().input('id', sql.Int, visitId)
        .query(`DELETE FROM [dbo].[HRM_Visit] WHERE VisitId = @id;`);
      return res.status(400).json({ message: 'Invalid or oversized photo (max 3 MB each).' });
    }

    // 6. UPDATE the row with the photo URLs.
    await pool.request()
      .input('id', sql.Int,            visitId)
      .input('s',  sql.NVarChar(500),  selfieUrl)
      .input('p',  sql.NVarChar(500),  premiseUrl)
      .query(`
        UPDATE [dbo].[HRM_Visit]
        SET PunchInSelfieUrl = @s,
            PunchInPremisePhotoUrl = @p,
            UpdatedAt = SYSDATETIME()
        WHERE VisitId = @id;
      `);

    // 7. If the punch was tied to a BN_VisitPlan row, mark that plan done too.
    if (b.visitPlanId) {
      await pool.request()
        .input('vpid', sql.Int,         parseInt(b.visitPlanId))
        .input('cf',   sql.DateTime2,   punchTime)
        .input('ep',   sql.BigInt,      ping.PingId)
        .input('cc',   sql.NVarChar(50), b.customerCode || null)
        .query(`
          UPDATE [dbo].[BN_VisitPlan]
          SET VisitDone        = 1,
              AutoConfirmedAt  = COALESCE(AutoConfirmedAt, @cf),
              EntryPingId      = COALESCE(EntryPingId, @ep),
              CustomerCode     = COALESCE(CustomerCode, @cc),
              UpdatedAt        = GETDATE()
          WHERE Id = @vpid AND Company = 'COMPANYA';
        `);
    }

    return res.json({
      ok: true,
      visitId,
      geofenceId,
      pingId: ping.PingId,
      punchInTime: punchTime,
      selfieUrl,
      premisePhotoUrl: premiseUrl,
    });
  } catch (err) {
    console.error('[visit-punch /in] failed:', err.message);
    return res.status(500).json({ message: 'Punch-In failed', error: err.message });
  }
});

// ── POST /out/:visitId — Punch-Out ─────────────────────────────────────────
router.post('/out/:visitId', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const visitId = parseInt(req.params.visitId);
    if (!Number.isFinite(visitId)) return res.status(400).json({ message: 'Invalid visitId' });

    const b = req.body || {};
    if (b.lat == null || b.lng == null || isNaN(Number(b.lat)) || isNaN(Number(b.lng)))
      return res.status(400).json({ message: 'lat / lng required (numeric)' });
    if (!b.premisePhotoData)
      return res.status(400).json({ message: 'premisePhotoData (base64 data URI) required' });

    const pool = await getAppPool();

    // Load the visit + verify ownership
    const vr = await pool.request().input('id', sql.Int, visitId).query(`
      SELECT VisitId, UserId, Company, EntryTime, PunchInTime, PunchOutTime, VisitPlanId
      FROM [dbo].[HRM_Visit] WHERE VisitId = @id;
    `);
    if (vr.recordset.length === 0) return res.status(404).json({ message: 'Visit not found' });
    const v = vr.recordset[0];
    if (Number(v.UserId) !== Number(user.id) && !isLensAdmin(user)) {
      return res.status(403).json({ message: 'Not authorised — visit belongs to a different user' });
    }
    if (v.PunchOutTime) return res.status(409).json({ message: 'Already punched out' });
    if (!v.PunchInTime) return res.status(409).json({
      message: 'This visit has no Punch-In (it was auto-detected). Use Mark Done instead.',
    });

    // Save the punch-out premise photo
    const premiseUrl = savePunchPhoto(user.id, visitId, 'out-premise', b.premisePhotoData);
    if (!premiseUrl) {
      return res.status(400).json({ message: 'Invalid or oversized premise photo (max 3 MB).' });
    }

    // Drop a ping for the exit moment
    const ping = await insertPunchPing(pool, user, b, 'punch-out');
    const punchOutTime = new Date(ping.PingTime);
    const durMin = Math.max(0, Math.round((punchOutTime - new Date(v.EntryTime)) / 60000));

    // Close the visit
    await pool.request()
      .input('id',   sql.Int,            visitId)
      .input('pot',  sql.DateTime2,      punchOutTime)
      .input('plat', sql.Decimal(9, 6),  Number(b.lat))
      .input('plng', sql.Decimal(9, 6),  Number(b.lng))
      .input('purl', sql.NVarChar(500),  premiseUrl)
      .input('xp',   sql.BigInt,         ping.PingId)
      .input('dur',  sql.Int,            durMin)
      .query(`
        UPDATE [dbo].[HRM_Visit]
        SET PunchOutTime            = @pot,
            PunchOutLat             = @plat,
            PunchOutLng             = @plng,
            PunchOutPremisePhotoUrl = @purl,
            ExitTime                = @pot,
            ExitPingId              = @xp,
            DurationMin             = @dur,
            UpdatedAt               = SYSDATETIME()
        WHERE VisitId = @id;
      `);

    // Mirror exit info onto the linked BN_VisitPlan row if any
    if (v.VisitPlanId) {
      await pool.request()
        .input('vpid', sql.Int,    v.VisitPlanId)
        .input('xp',   sql.BigInt, ping.PingId)
        .query(`
          UPDATE [dbo].[BN_VisitPlan]
          SET ExitPingId = COALESCE(ExitPingId, @xp), UpdatedAt = GETDATE()
          WHERE Id = @vpid AND Company = 'COMPANYA';
        `);
    }

    return res.json({
      ok: true,
      visitId,
      durationMin: durMin,
      punchOutTime,
      premisePhotoUrl: premiseUrl,
    });
  } catch (err) {
    console.error('[visit-punch /out] failed:', err.message);
    return res.status(500).json({ message: 'Punch-Out failed', error: err.message });
  }
});

// ── GET /today — own visits for a chosen date (default today) ──────────────
// Despite the name, accepts ?date=YYYY-MM-DD to view past/future days. The
// "Today" framing is preserved for backwards compatibility with the Phase 3
// frontend; new callers should treat this as "visits-on-date".
router.get('/today', authenticate, async (req, res) => {
  try {
    const user = req.user;
    // Validate date param; fall back to today on any junk input.
    const raw  = (req.query.date || '').slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
    const pool = await getAppPool();
    const r = pool.request().input('uid', sql.Int, user.id);
    if (date) r.input('dt', sql.Date, date);
    const dateClause = date
      ? 'CAST(V.EntryTime AS DATE) = @dt'
      : 'CAST(V.EntryTime AS DATE) = CAST(GETDATE() AS DATE)';

    // Visibility: a rep sees only their OWN punches; but a monitor role sees the
    // whole team's — admin/HR/lens-admin → everyone, FAE head → the FAE team, any
    // *head with codes → their team (by CompanyACode/CompanyBCode) + self. Monitors get the
    // actual PUNCHED visits only (PunchInTime NOT NULL) — "who did punch in/out" —
    // not the auto-detected geo rows, which would flood the list.
    let visWhere = 'V.UserId = @uid';
    let monitor  = false;
    if (isLensAdmin(user)) {
      visWhere = '1 = 1'; monitor = true;
    } else if (isFaeHead(user)) {
      visWhere = "V.UserId IN (SELECT Id FROM [dbo].[User_Login] WHERE LOWER(Role) IN ('fae','fae head'))";
      monitor = true;
    } else if (isAnyHead(user)) {
      const codes = ((user.companyaCode || '') + '/' + (user.companybCode || ''))
        .split('/').map(s => s.trim()).filter(Boolean);
      if (codes.length) {
        codes.forEach((c, i) => r.input('vc' + i, sql.NVarChar(50), c));
        const inList = codes.map((_, i) => '@vc' + i).join(',');
        visWhere = `(V.UserId = @uid OR EXISTS (
          SELECT 1 FROM [dbo].[User_Login] UL2 WHERE UL2.Id = V.UserId AND (
            EXISTS (SELECT 1 FROM string_split(UL2.CompanyACode,    '/') s WHERE LTRIM(RTRIM(s.value)) IN (${inList}))
            OR EXISTS (SELECT 1 FROM string_split(UL2.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${inList}))
          )))`;
        monitor = true;
      }
    }
    const punchOnly = monitor ? 'AND V.PunchInTime IS NOT NULL' : '';

    const result = await r.query(`
      SELECT
        V.VisitId, V.UserId, V.CustomerCode, V.CustomerName, V.GeofenceId,
        V.EntryTime, V.ExitTime, V.DurationMin,
        V.PunchInTime, V.PunchInLat, V.PunchInLng,
        V.PunchInSelfieUrl, V.PunchInPremisePhotoUrl,
        V.PunchOutTime, V.PunchOutLat, V.PunchOutLng,
        V.PunchOutPremisePhotoUrl,
        V.IsConfirmedVisit, V.AutoConfirmedAt, V.VisitPlanId,
        V.Label,
        G.Name AS GeofenceName,
        UL.Name AS EmployeeName, UL.Role AS EmployeeRole,
        -- Planned meeting contact from BN_VisitPlan so the rep can recall
        -- "who am I here to see" without leaving Visit Punch.
        P.ContactPerson, P.ContactDetails
      FROM [dbo].[HRM_Visit] V
      LEFT JOIN [dbo].[HRM_Geofence] G ON G.GeofenceId = V.GeofenceId
      LEFT JOIN [dbo].[BN_VisitPlan]  P ON P.Id = V.VisitPlanId
      LEFT JOIN [dbo].[User_Login]    UL ON UL.Id = V.UserId
      WHERE (${visWhere})
        AND ${dateClause} ${punchOnly}
      ORDER BY UL.Name ASC, V.EntryTime DESC;
    `);
    return res.json({ ok: true, visits: result.recordset, monitor });
  } catch (err) {
    console.error('[visit-punch /today] failed:', err.message);
    return res.status(500).json({ message: 'Failed to load visits', error: err.message });
  }
});

// ── GET /planned — own planned visits for a chosen date (default today) ────
// Powers the quick-pick chips at the top of the Punch-In form. Scoped to the
// caller's CompanyACode/CompanyBCode (sales reps see only their own plans; FAE sees
// own; admin/HR see all). Includes VisitDone flag so the chip can render
// "done" state for visits that have already been punched.
router.get('/planned', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const raw  = (req.query.date || '').slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : new Date().toISOString().slice(0, 10);

    const pool = await getAppPool();

    // Resolve caller's salesperson codes — same scoping pattern as Visit Plan.
    // FAE rows use Username as SalespersonCode; everyone else uses NAV codes.
    const role = (user.role || '').toLowerCase().trim();
    const companyaCodes = (user.companyaCode    || '').split('/').map(s => s.trim()).filter(Boolean);
    const advCodes = (user.companybCode || '').split('/').map(s => s.trim()).filter(Boolean);

    const r = pool.request().input('dt', sql.Date, date);
    let where = 'VisitDate = @dt';
    if (role === 'fae') {
      r.input('uname', sql.NVarChar(50), user.username || '');
      where += ' AND SalespersonCode = @uname';
    } else if (role === 'fae head') {
      where += " AND SalespersonCode IN (SELECT Username FROM dbo.User_Login WHERE LOWER(Role) IN ('fae','fae head'))";
    } else if (companyaCodes.length || advCodes.length) {
      const all = [...companyaCodes, ...advCodes];
      all.forEach((c, i) => r.input('sp' + i, sql.NVarChar(50), c));
      where += ' AND SalespersonCode IN (' + all.map((_, i) => '@sp' + i).join(',') + ')';
    }
    // Admin / HR / users with no codes → no scope, see all (rare, but useful
    // when ops needs to demo the page).

    const result = await r.query(`
      SELECT Id, Company, SalespersonCode, SalespersonName, VisitDate,
             CustomerName, CustomerCode, Location, VisitAgenda,
             ContactPerson, ContactDetails,
             VisitDone, AutoConfirmedAt, ManualConfirmedAt
      FROM [dbo].[BN_VisitPlan]
      WHERE ${where}
      ORDER BY VisitDone ASC, Id ASC;
    `);
    return res.json({ ok: true, date, planned: result.recordset });
  } catch (err) {
    console.error('[visit-punch /planned] failed:', err.message);
    return res.status(500).json({ message: 'Failed to load planned visits', error: err.message });
  }
});

// ── PUT /:visitId — admin/HR correction (wrong customer / wrong plan link) ─
// Admin/HR-only. Lets HR re-link a mis-punched visit to the right customer +
// the right BN_VisitPlan row without losing the photos, GPS, or timestamps
// already on the punch. Sales heads do NOT get this power — they could
// rewrite their team's history, defeating the audit purpose of punches.
router.put('/:visitId', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) {
      return res.status(403).json({ message: 'Only admin / HR can edit a punch.' });
    }
    const visitId = parseInt(req.params.visitId);
    if (!Number.isFinite(visitId)) return res.status(400).json({ message: 'Invalid visitId' });
    const b = req.body || {};
    if (!b.customerName || !String(b.customerName).trim()) {
      return res.status(400).json({ message: 'customerName is required' });
    }
    const pool = await getAppPool();

    // Make sure the visit exists before issuing the UPDATE.
    const vr = await pool.request().input('id', sql.Int, visitId)
      .query(`SELECT VisitId, VisitPlanId FROM [dbo].[HRM_Visit] WHERE VisitId = @id;`);
    if (!vr.recordset.length) return res.status(404).json({ message: 'Visit not found' });
    const oldPlanId = vr.recordset[0].VisitPlanId;
    const newPlanId = b.visitPlanId === '' || b.visitPlanId == null
      ? null
      : parseInt(b.visitPlanId);

    await pool.request()
      .input('id',   sql.Int,            visitId)
      .input('cc',   sql.NVarChar(50),   b.customerCode ? String(b.customerCode).trim() : null)
      .input('cn',   sql.NVarChar(200),  String(b.customerName).trim().slice(0, 200))
      .input('vpid', sql.Int,            Number.isFinite(newPlanId) ? newPlanId : null)
      .query(`
        UPDATE [dbo].[HRM_Visit]
        SET CustomerCode = @cc,
            CustomerName = @cn,
            VisitPlanId  = @vpid,
            UpdatedAt    = SYSDATETIME()
        WHERE VisitId = @id;
      `);

    // If the punch was previously linked to a plan but the link is changed
    // OR removed, reset the OLD plan's VisitDone (so it goes back to "Missed"
    // in reports unless another visit still backs it).
    if (oldPlanId && oldPlanId !== newPlanId) {
      await pool.request().input('vpid', sql.Int, oldPlanId).query(`
        UPDATE [dbo].[BN_VisitPlan]
        SET VisitDone = 0,
            AutoConfirmedAt = NULL,
            ManualConfirmedAt = NULL,
            EntryPingId = NULL,
            ExitPingId  = NULL,
            UpdatedAt   = GETDATE()
        WHERE Id = @vpid
          AND NOT EXISTS (SELECT 1 FROM [dbo].[HRM_Visit] WHERE VisitPlanId = @vpid);
      `);
    }
    // If a new plan link is given, mark it Done.
    if (Number.isFinite(newPlanId) && newPlanId && newPlanId !== oldPlanId) {
      await pool.request().input('vpid', sql.Int, newPlanId).query(`
        UPDATE [dbo].[BN_VisitPlan]
        SET VisitDone = 1, ManualConfirmedAt = SYSDATETIME(), UpdatedAt = GETDATE()
        WHERE Id = @vpid;
      `);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[visit-punch PUT] failed:', err.message);
    return res.status(500).json({ message: 'Update failed', error: err.message });
  }
});

// ── DELETE /:visitId — admin/HR removes a wholly-wrong punch ───────────────
// Hard-deletes the HRM_Visit row + linked HRM_LocationPing rows for the punch
// events (so the pings don't clutter the day's map). If the deleted visit was
// linked to a BN_VisitPlan, reset that plan's VisitDone unless another visit
// still backs it. Sales heads / reps cannot delete.
router.delete('/:visitId', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) {
      return res.status(403).json({ message: 'Only admin / HR can delete a punch.' });
    }
    const visitId = parseInt(req.params.visitId);
    if (!Number.isFinite(visitId)) return res.status(400).json({ message: 'Invalid visitId' });
    const pool = await getAppPool();

    const vr = await pool.request().input('id', sql.Int, visitId)
      .query(`SELECT VisitPlanId, EntryPingId, ExitPingId FROM [dbo].[HRM_Visit] WHERE VisitId = @id;`);
    if (!vr.recordset.length) return res.status(404).json({ message: 'Visit not found' });
    const { VisitPlanId, EntryPingId, ExitPingId } = vr.recordset[0];

    // Delete the punch row first.
    await pool.request().input('id', sql.Int, visitId)
      .query(`DELETE FROM [dbo].[HRM_Visit] WHERE VisitId = @id;`);

    // Clean up the two punch-specific HRM_LocationPing rows (source='punch-in' /
    // 'punch-out') so the day-journey map doesn't show stranded markers. Skip
    // pings that aren't tagged as punches (regular GPS trail stays intact).
    if (EntryPingId || ExitPingId) {
      const pr = pool.request();
      if (EntryPingId) pr.input('ep', sql.BigInt, EntryPingId);
      if (ExitPingId)  pr.input('xp', sql.BigInt, ExitPingId);
      const ids = [EntryPingId ? '@ep' : null, ExitPingId ? '@xp' : null].filter(Boolean).join(',');
      await pr.query(`
        DELETE FROM [dbo].[HRM_LocationPing]
        WHERE PingId IN (${ids})
          AND Source IN ('punch-in','punch-out');
      `);
    }

    // Roll back the plan's "done" state if this punch was the only thing closing it.
    if (VisitPlanId) {
      await pool.request().input('vpid', sql.Int, VisitPlanId).query(`
        UPDATE [dbo].[BN_VisitPlan]
        SET VisitDone = 0,
            AutoConfirmedAt = NULL,
            ManualConfirmedAt = NULL,
            EntryPingId = NULL,
            ExitPingId  = NULL,
            UpdatedAt   = GETDATE()
        WHERE Id = @vpid
          AND NOT EXISTS (SELECT 1 FROM [dbo].[HRM_Visit] WHERE VisitPlanId = @vpid);
      `);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[visit-punch DELETE] failed:', err.message);
    return res.status(500).json({ message: 'Delete failed', error: err.message });
  }
});

// ── GET /open — the currently open punch (or null) ─────────────────────────
router.get('/open', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const pool = await getAppPool();
    const r = await pool.request().input('uid', sql.Int, user.id).query(`
      SELECT TOP 1
        V.VisitId, V.CustomerCode, V.CustomerName, V.GeofenceId,
        V.EntryTime, V.PunchInTime, V.PunchInLat, V.PunchInLng,
        V.PunchInSelfieUrl, V.PunchInPremisePhotoUrl,
        V.VisitPlanId,
        G.Name AS GeofenceName,
        -- Planned meeting contact from BN_VisitPlan — surfaced on the Active
        -- Card so the rep can recall who they're meeting + tap-to-call the
        -- contact's phone without leaving the punch screen.
        P.ContactPerson, P.ContactDetails
      FROM [dbo].[HRM_Visit] V
      LEFT JOIN [dbo].[HRM_Geofence] G ON G.GeofenceId = V.GeofenceId
      LEFT JOIN [dbo].[BN_VisitPlan]  P ON P.Id = V.VisitPlanId
      WHERE V.UserId = @uid
        AND V.PunchInTime IS NOT NULL
        AND V.PunchOutTime IS NULL
      ORDER BY V.VisitId DESC;
    `);
    return res.json({ ok: true, open: r.recordset[0] || null });
  } catch (err) {
    console.error('[visit-punch /open] failed:', err.message);
    return res.status(500).json({ message: 'Failed to load open punch', error: err.message });
  }
});

module.exports = router;
