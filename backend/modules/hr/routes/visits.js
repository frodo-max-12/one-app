// =====================================================================
// modules/hr/routes/visits.js — HRM_Visit list + label management (Phase 2.4)
//
// Mounted at /api/hr/visits/* by ../index.js.
//
// Endpoints:
//   GET  /                  — list visits (filterable by date, user, kind)
//   GET  /unknown           — list unknown stops (geofenceId IS NULL, unlabelled)
//   PUT  /:id/label         — assign label ('personal' | 'lunch' | 'skip' | NULL)
//   POST /:id/promote       — turn unknown stop into a new geofence (creates HRM_Geofence row)
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isFullAccess, isSalesHead, isLensAdmin } = require('../../../auth');
const visitDetector = require('../services/visitDetector');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Build a "User in scope" SQL fragment based on caller's role.
// Returns { whereSql, addParams(req) }
function userScopeClause(reqUser) {
  if (isLensAdmin(reqUser)) return { whereSql: '', addParams: () => {} };
  if (isSalesHead(reqUser)) {
    const codes = ((reqUser.companyaCode || '') + '/' + (reqUser.companybCode || ''))
      .split('/').map(s => s.trim()).filter(Boolean);
    if (codes.length === 0) {
      return { whereSql: 'AND V.UserId = @selfId', addParams: (r) => r.input('selfId', sql.Int, reqUser.id) };
    }
    const placeholders = codes.map((_, i) => '@hc' + i).join(',');
    return {
      whereSql: `AND (
        V.UserId = @selfId
        OR EXISTS (
          SELECT 1 FROM [dbo].[User_Login] UL
          WHERE UL.Id = V.UserId
            AND (
              EXISTS (SELECT 1 FROM string_split(UL.CompanyACode,    '/') s WHERE LTRIM(RTRIM(s.value)) IN (${placeholders}))
              OR EXISTS (SELECT 1 FROM string_split(UL.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${placeholders}))
            )
        )
      )`,
      addParams: (r) => {
        r.input('selfId', sql.Int, reqUser.id);
        codes.forEach((c, i) => r.input('hc' + i, sql.NVarChar(50), c));
      },
    };
  }
  // Regular user — only own visits
  return {
    whereSql: 'AND V.UserId = @selfId',
    addParams: (r) => r.input('selfId', sql.Int, reqUser.id),
  };
}

// ── GET /  list visits with filters ────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const dateFrom  = (req.query.from || '').slice(0, 10);
    const dateTo    = (req.query.to   || '').slice(0, 10);
    const userId    = parseInt(req.query.userId) || null;
    const kind      = (req.query.kind || '').trim();          // 'known' | 'unknown' | 'unlabelled' | ''
    const includeLabelled = req.query.includeLabelled === 'true';

    const pool = await getAppPool();
    const r = pool.request();
    const scope = userScopeClause(req.user);
    scope.addParams(r);

    const where = ['V.UserId IS NOT NULL', scope.whereSql].filter(Boolean);
    if (dateFrom) { where.push('CAST(V.EntryTime AS DATE) >= @dFrom'); r.input('dFrom', sql.Date, dateFrom); }
    if (dateTo)   { where.push('CAST(V.EntryTime AS DATE) <= @dTo');   r.input('dTo',   sql.Date, dateTo); }
    if (userId)   { where.push('V.UserId = @uid');                     r.input('uid',   sql.Int,  userId); }
    if (kind === 'known')      where.push('V.GeofenceId IS NOT NULL');
    if (kind === 'unknown')    where.push('V.GeofenceId IS NULL');
    if (kind === 'unlabelled') where.push('V.GeofenceId IS NULL AND V.Label IS NULL');
    if (!includeLabelled)      where.push('(V.Label IS NULL OR V.Label NOT IN (\'personal\',\'lunch\',\'skip\'))');

    const result = await r.query(`
      SELECT
        V.VisitId, V.UserId, UL.Name AS UserName, UL.CompanyACode AS CompanyACode,
        V.UserCode, V.Company, V.Department,
        V.GeofenceId, G.Name AS GeofenceName, G.Kind AS GeofenceKind,
        V.CustomerCode, V.CustomerName,
        V.EntryTime, V.ExitTime, V.DurationMin,
        V.Lat, V.Lng,
        V.IsConfirmedVisit, V.AutoConfirmedAt, V.VisitPlanId,
        V.Label, V.MOM, V.Notes
      FROM [dbo].[HRM_Visit] V
      LEFT JOIN [dbo].[User_Login]    UL ON UL.Id = V.UserId
      LEFT JOIN [dbo].[HRM_Geofence]  G  ON G.GeofenceId = V.GeofenceId
      WHERE ${where.join(' AND ')}
      ORDER BY V.EntryTime DESC;
    `);
    return res.json({ ok: true, visits: result.recordset });
  } catch (err) {
    console.error('[/api/hr/visits] failed:', err.message);
    return res.status(500).json({ message: 'Visits list failed', detail: err.message });
  }
});

// ── GET /unknown/list  — unknown stops in a date range ─────────────────────
router.get('/unknown/list', authenticate, async (req, res) => {
  try {
    const dateFrom = (req.query.from || '').slice(0, 10);
    const dateTo   = (req.query.to   || '').slice(0, 10);
    const pool = await getAppPool();
    const r = pool.request();
    const scope = userScopeClause(req.user);
    scope.addParams(r);

    const where = ['V.GeofenceId IS NULL', 'V.Label IS NULL', scope.whereSql].filter(Boolean);
    if (dateFrom) { where.push('CAST(V.EntryTime AS DATE) >= @dFrom'); r.input('dFrom', sql.Date, dateFrom); }
    if (dateTo)   { where.push('CAST(V.EntryTime AS DATE) <= @dTo');   r.input('dTo',   sql.Date, dateTo); }

    const result = await r.query(`
      SELECT
        V.VisitId, V.UserId, UL.Name AS UserName, UL.CompanyACode,
        V.EntryTime, V.ExitTime, V.DurationMin,
        V.Lat, V.Lng, V.Department, V.Company
      FROM [dbo].[HRM_Visit] V
      LEFT JOIN [dbo].[User_Login] UL ON UL.Id = V.UserId
      WHERE ${where.join(' AND ')}
      ORDER BY V.EntryTime DESC;
    `);
    return res.json({ ok: true, stops: result.recordset });
  } catch (err) {
    console.error('[/api/hr/visits/unknown/list] failed:', err.message);
    return res.status(500).json({ message: 'Unknown stops fetch failed', detail: err.message });
  }
});

// ── PUT /:id/label ──────────────────────────────────────────────────────────
router.put('/:id/label', authenticate, async (req, res) => {
  try {
    const id    = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const label = (req.body && req.body.label) || null;
    const allowed = ['personal', 'lunch', 'skip', null, ''];
    if (!allowed.includes(label)) return res.status(400).json({ message: 'invalid label' });

    const pool = await getAppPool();
    await pool.request()
      .input('id',    sql.Int,          id)
      .input('label', sql.NVarChar(50), label || null)
      .input('uid',   sql.Int,          req.user.id)
      .query(`
        UPDATE [dbo].[HRM_Visit]
        SET Label = @label, UpdatedBy = @uid, UpdatedAt = SYSDATETIME()
        WHERE VisitId = @id;
      `);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /api/hr/visits/:id/label] failed:', err.message);
    return res.status(500).json({ message: 'Label set failed', detail: err.message });
  }
});

// ── POST /:id/promote  → create geofence here and link unknown stop ────────
router.post('/:id/promote', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const b  = req.body || {};
    if (!b.name) return res.status(400).json({ message: 'name required' });
    const pool = await getAppPool();

    // Load the unknown stop
    const vRes = await pool.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM [dbo].[HRM_Visit] WHERE VisitId = @id;`);
    if (vRes.recordset.length === 0)             return res.status(404).json({ message: 'visit not found' });
    const v = vRes.recordset[0];
    if (v.GeofenceId)                            return res.status(400).json({ message: 'already linked to a geofence' });

    // Create geofence
    const gIns = await pool.request()
      .input('name',     sql.NVarChar(200), b.name.trim())
      .input('kind',     sql.NVarChar(20),  (b.kind || 'customer').trim())
      .input('custCode', sql.NVarChar(50),  (b.customerCode || '').trim() || null)
      .input('company',  sql.NVarChar(10),  (b.company || v.Company || '').trim() || null)
      .input('lat',      sql.Decimal(9, 6), Number(b.centerLat ?? v.Lat))
      .input('lng',      sql.Decimal(9, 6), Number(b.centerLng ?? v.Lng))
      .input('radius',   sql.Int,           Math.max(20, Math.min(2000, parseInt(b.radiusM) || 100)))
      .input('address',  sql.NVarChar(500), b.address || null)
      .input('city',     sql.NVarChar(100), b.city    || null)
      .input('dwell',    sql.Int,           Math.max(1, Math.min(240, parseInt(b.dwellMinForVisit) || 10)))
      .input('createdBy',sql.Int,           req.user.id)
      .query(`
        INSERT INTO [dbo].[HRM_Geofence]
          (Name, Kind, CustomerCode, Company, CenterLat, CenterLng, RadiusM,
           Address, City, DwellMinForVisit, CreatedBy)
        OUTPUT INSERTED.GeofenceId
        VALUES
          (@name, @kind, @custCode, @company, @lat, @lng, @radius,
           @address, @city, @dwell, @createdBy);
      `);
    const newFenceId = gIns.recordset[0].GeofenceId;

    // Link the visit to the new geofence + flag it confirmed retroactively
    await pool.request()
      .input('vid',   sql.Int,          id)
      .input('fid',   sql.Int,          newFenceId)
      .input('cc',    sql.NVarChar(50), (b.customerCode || '').trim() || null)
      .input('cn',    sql.NVarChar(200), b.name.trim())
      .input('uid',   sql.Int,          req.user.id)
      .query(`
        UPDATE [dbo].[HRM_Visit]
        SET GeofenceId = @fid, CustomerCode = @cc, CustomerName = @cn,
            IsConfirmedVisit = 1, AutoConfirmedAt = SYSDATETIME(),
            UpdatedAt = SYSDATETIME(), UpdatedBy = @uid
        WHERE VisitId = @vid;
      `);

    visitDetector.invalidateGeofenceCache();
    return res.json({ ok: true, geofenceId: newFenceId });
  } catch (err) {
    console.error('[POST /api/hr/visits/:id/promote] failed:', err.message);
    return res.status(500).json({ message: 'Promote failed', detail: err.message });
  }
});

module.exports = router;
