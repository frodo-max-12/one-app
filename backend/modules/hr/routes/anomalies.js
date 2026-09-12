// =====================================================================
// modules/hr/routes/anomalies.js — HR anomaly review queue (Phase 2.6)
// Mounted at /api/hr/anomalies/* by ../index.js
//
// GET /              — list anomalies (filters: from, to, kind, isResolved)
// PUT /:id/resolve   — mark resolved with a note
// PUT /:id/approve   — close as "approved" (i.e. not a real anomaly, employee had legit reason)
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');

router.get('/', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can view anomalies' });
    const pool = await getAppPool();
    const dateFrom = (req.query.from || '').slice(0, 10);
    const dateTo   = (req.query.to   || '').slice(0, 10);
    const kind     = (req.query.kind || '').trim();
    const onlyOpen = (req.query.onlyOpen === 'true');

    const r = pool.request();
    const where = ['1=1'];
    if (dateFrom) { where.push('A.AnomalyDate >= @dFrom'); r.input('dFrom', sql.Date, dateFrom); }
    if (dateTo)   { where.push('A.AnomalyDate <= @dTo');   r.input('dTo',   sql.Date, dateTo); }
    if (kind)     { where.push('A.Kind = @kind');         r.input('kind',  sql.NVarChar(30), kind); }
    if (onlyOpen) where.push('A.IsResolved = 0');

    const result = await r.query(`
      SELECT
        A.AnomalyId, A.UserId, UL.Name AS UserName, UL.CompanyACode AS CompanyACode,
        A.Company, A.Kind, A.Severity, A.DetectedAt, A.AnomalyDate,
        A.AttId, A.OfficeGeofenceId, G.Name AS OfficeName,
        A.TriggerPingId, A.Title, A.Detail,
        A.LastSeenLat, A.LastSeenLng,
        A.IsResolved, A.ResolvedBy, RB.Name AS ResolvedByName,
        A.ResolvedAt, A.ResolutionNote
      FROM [dbo].[HRM_Anomaly] A
      LEFT JOIN [dbo].[User_Login]   UL ON UL.Id = A.UserId
      LEFT JOIN [dbo].[HRM_Geofence] G  ON G.GeofenceId = A.OfficeGeofenceId
      LEFT JOIN [dbo].[User_Login]   RB ON RB.Id = A.ResolvedBy
      WHERE ${where.join(' AND ')}
      ORDER BY A.DetectedAt DESC;
    `);
    return res.json({ ok: true, anomalies: result.recordset });
  } catch (err) {
    console.error('[/api/hr/anomalies] failed:', err.message);
    return res.status(500).json({ message: 'Anomalies fetch failed', detail: err.message });
  }
});

router.put('/:id/resolve', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin' });
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const note = (req.body && req.body.note) || null;

    const pool = await getAppPool();
    await pool.request()
      .input('id',   sql.Int, id)
      .input('uid',  sql.Int, req.user.id)
      .input('note', sql.NVarChar(500), note)
      .query(`
        UPDATE [dbo].[HRM_Anomaly]
        SET IsResolved = 1, ResolvedBy = @uid, ResolvedAt = SYSDATETIME(),
            ResolutionNote = @note, UpdatedAt = SYSDATETIME()
        WHERE AnomalyId = @id;
      `);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Resolve failed', detail: err.message });
  }
});

router.put('/:id/approve', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin' });
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });

    const pool = await getAppPool();
    await pool.request()
      .input('id',   sql.Int, id)
      .input('uid',  sql.Int, req.user.id)
      .query(`
        UPDATE [dbo].[HRM_Anomaly]
        SET IsResolved = 1, ResolvedBy = @uid, ResolvedAt = SYSDATETIME(),
            ResolutionNote = ISNULL(ResolutionNote, '') + N' [Approved by HR — legitimate]',
            UpdatedAt = SYSDATETIME()
        WHERE AnomalyId = @id;
      `);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Approve failed', detail: err.message });
  }
});

module.exports = router;
