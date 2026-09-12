// =====================================================================
// modules/hr/routes/location.js — GPS ping ingestion
//
// Mounted at /api/hr/location/* by ../index.js.
// Phase 0 endpoints:
//   POST /ping     — record one GPS sample (called every 60-120s by the mobile app)
//   POST /batch    — record many GPS samples in one call (offline sync drain)
//   GET  /latest   — return current user's most recent ping (debug helper)
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin, isFaeHead, isAnyHead } = require('../../../auth');
const visitDetector        = require('../services/visitDetector');
const anomalyDetector      = require('../services/anomalyDetector');
const attendanceCompliance = require('../services/attendanceCompliance');

// Fire-and-forget — never blocks the ping response or surfaces detector errors to the client.
function runDetectorAsync(user, ping) {
  setImmediate(() => {
    visitDetector.processPing(user, ping).catch(() => {});
    anomalyDetector.processPing(user, ping).catch(() => {});
    attendanceCompliance.processPing(user, ping).catch(() => {});
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function pickCompany(user) {
  // Lens does not yet route by company at the user level — the same staff
  // may visit both COMPANYA and CompanyB customers in one day. Default to whichever
  // code is non-empty so admin filters work. Visit-level routing happens later
  // via HRM_Visit.Company from the geofence.
  if (user.companyaCode && user.companyaCode.trim())    return 'COMPANYA';
  if (user.companybCode && user.companybCode.trim()) return 'CompanyB';
  return null;
}

function pickUserCode(user) {
  return (user.companyaCode && user.companyaCode.trim())
    ? user.companyaCode.split('/')[0].trim()
    : (user.companybCode && user.companybCode.trim())
      ? user.companybCode.split('/')[0].trim()
      : null;
}

function clampLat(n) { return (typeof n === 'number' && n >= -90  && n <= 90)  ? n : null; }
function clampLng(n) { return (typeof n === 'number' && n >= -180 && n <= 180) ? n : null; }

// Use the client-supplied GPS fix time (lets buffered/burst-delivered fixes keep
// their true capture time so the journey stays in order). Guard against an
// unparseable value or a phone clock skewed into the future — those fall back to
// server-now. Legitimately OLD timestamps (offline buffering) are kept as-is.
function resolvePingTime(raw) {
  if (!raw) return new Date();
  const t = new Date(raw);
  if (isNaN(t.getTime())) return new Date();
  if (t.getTime() > Date.now() + 5 * 60 * 1000) return new Date();   // future clock skew
  return t;
}

function bindPing(reqObj, body, user) {
  reqObj.input('userId',     sql.Int,           user.id);
  reqObj.input('userCode',   sql.NVarChar(50),  pickUserCode(user));
  reqObj.input('company',    sql.NVarChar(10),  pickCompany(user));
  reqObj.input('pingTime',   sql.DateTime2,     resolvePingTime(body.pingTime));
  reqObj.input('lat',        sql.Decimal(9, 6), clampLat(Number(body.lat)));
  reqObj.input('lng',        sql.Decimal(9, 6), clampLng(Number(body.lng)));
  // Accuracy is DECIMAL(6,2) (max 9999.99 m) — clamp so a WFH/desktop fix of 10000+ m
  // doesn't overflow the column and crash the ping INSERT. (Fixed 2026-06-30.)
  reqObj.input('accuracy',   sql.Decimal(6, 2), (body.accuracy != null && Number.isFinite(Number(body.accuracy)) && Number(body.accuracy) >= 0) ? Math.min(Number(body.accuracy), 9999.99) : null);
  reqObj.input('speedMps',   sql.Decimal(6, 2), body.speedMps   != null ? Number(body.speedMps)   : null);
  reqObj.input('headingDeg', sql.Decimal(6, 2), body.headingDeg != null ? Number(body.headingDeg) : null);
  reqObj.input('altitude',   sql.Decimal(8, 2), body.altitude   != null ? Number(body.altitude)   : null);
  reqObj.input('batteryPct', sql.TinyInt,       body.batteryPct != null ? Number(body.batteryPct) : null);
  reqObj.input('isMocked',   sql.Bit,           body.isMocked ? 1 : 0);
  reqObj.input('isOnline',   sql.Bit,           body.isOnline === false ? 0 : 1);
  reqObj.input('source',     sql.NVarChar(20),  body.source || 'gps');
}

// ── POST /ping ───────────────────────────────────────────────────────────────
router.post('/ping', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number') {
      return res.status(400).json({ message: 'lat and lng are required (number)' });
    }
    if (clampLat(b.lat) === null || clampLng(b.lng) === null) {
      return res.status(400).json({ message: 'lat/lng out of range' });
    }

    const pool = await getAppPool();
    const r = pool.request();
    bindPing(r, b, req.user);

    const out = await r.query(`
      INSERT INTO [dbo].[HRM_LocationPing]
        (UserId, UserCode, Company, PingTime, Lat, Lng, Accuracy, SpeedMps, HeadingDeg, Altitude,
         BatteryPct, IsMocked, IsOnline, Source)
      OUTPUT INSERTED.PingId, INSERTED.ServerInsertedAt
      VALUES
        (@userId, @userCode, @company, @pingTime, @lat, @lng, @accuracy, @speedMps, @headingDeg, @altitude,
         @batteryPct, @isMocked, @isOnline, @source);
    `);

    const row = out.recordset[0];
    // Kick off visit-detector in the background — does not affect this response.
    runDetectorAsync(req.user, { PingId: row.PingId, PingTime: new Date(), Lat: Number(b.lat), Lng: Number(b.lng) });

    return res.status(201).json({
      ok: true,
      pingId: row.PingId,
      serverInsertedAt: row.ServerInsertedAt,
    });
  } catch (err) {
    console.error('[/api/hr/location/ping] insert failed:', err.message);
    return res.status(500).json({ message: 'Ping insert failed', detail: err.message });
  }
});

// ── POST /batch ──────────────────────────────────────────────────────────────
// Accepts {pings: [...]} where each item has the same shape as /ping body.
// Used by the mobile app when it comes back online after offline tracking.
router.post('/batch', authenticate, async (req, res) => {
  try {
    const pings = Array.isArray(req.body && req.body.pings) ? req.body.pings : null;
    if (!pings || pings.length === 0) {
      return res.status(400).json({ message: 'pings[] required' });
    }
    if (pings.length > 500) {
      return res.status(400).json({ message: 'batch too large (max 500)' });
    }

    const pool = await getAppPool();
    let inserted = 0;
    let skipped  = 0;

    for (const b of pings) {
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number')      { skipped++; continue; }
      if (clampLat(b.lat) === null  || clampLng(b.lng) === null)        { skipped++; continue; }
      const r = pool.request();
      bindPing(r, { ...b, isOnline: false }, req.user);
      await r.query(`
        INSERT INTO [dbo].[HRM_LocationPing]
          (UserId, UserCode, Company, PingTime, Lat, Lng, Accuracy, SpeedMps, HeadingDeg, Altitude,
           BatteryPct, IsMocked, IsOnline, Source)
        VALUES
          (@userId, @userCode, @company, @pingTime, @lat, @lng, @accuracy, @speedMps, @headingDeg, @altitude,
           @batteryPct, @isMocked, @isOnline, @source);
      `);
      inserted++;
    }

    return res.status(201).json({ ok: true, inserted, skipped });
  } catch (err) {
    console.error('[/api/hr/location/batch] failed:', err.message);
    return res.status(500).json({ message: 'Batch insert failed', detail: err.message });
  }
});

// ── GET /latest ──────────────────────────────────────────────────────────────
router.get('/latest', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .query(`
        SELECT TOP 1
          PingId, PingTime, Lat, Lng, Accuracy, SpeedMps, BatteryPct, IsMocked, Source, ServerInsertedAt
        FROM [dbo].[HRM_LocationPing]
        WHERE UserId = @userId
        ORDER BY PingTime DESC;
      `);
    return res.json({ ok: true, ping: r.recordset[0] || null });
  } catch (err) {
    console.error('[/api/hr/location/latest] failed:', err.message);
    return res.status(500).json({ message: 'Latest fetch failed', detail: err.message });
  }
});

// ── GET /live ──────────────────────────────────────────────────────────────
// Live-map feed: for every employee the caller may supervise, their LATEST
// ping today (null if not tracking yet). Scope ladder mirrors journey
// /pickable-users: lens-admin → all; FAE head → FAE team; any *head with codes
// → team by CompanyACode/CompanyBCode intersection + self; everyone else → self only.
// "Liveness" is derived client-side from MinsAgo (delivery-app style).
router.get('/live', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = pool.request();
    let where = '';

    if (isLensAdmin(req.user)) {
      where = '';
    } else if (isFaeHead(req.user)) {
      where = "AND LOWER(UL.Role) IN ('fae','fae head')";
    } else if (isAnyHead(req.user)) {
      const codes = ((req.user.companyaCode || '') + '/' + (req.user.companybCode || ''))
        .split('/').map(s => s.trim()).filter(Boolean);
      r.input('selfId', sql.Int, req.user.id);
      if (codes.length === 0) {
        where = 'AND UL.Id = @selfId';
      } else {
        codes.forEach((c, i) => r.input('c' + i, sql.NVarChar(50), c));
        const inList = codes.map((_, i) => '@c' + i).join(',');
        where = `AND (
          EXISTS (SELECT 1 FROM string_split(UL.CompanyACode,    '/') s WHERE LTRIM(RTRIM(s.value)) IN (${inList}))
          OR EXISTS (SELECT 1 FROM string_split(UL.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${inList}))
          OR UL.Id = @selfId
        )`;
      }
    } else {
      r.input('selfId', sql.Int, req.user.id);
      where = 'AND UL.Id = @selfId';
    }

    const result = await r.query(`
      ;WITH Visible AS (
        SELECT UL.Id, UL.Name, UL.Role
        FROM [dbo].[User_Login] UL
        WHERE UL.IsActive = 1 ${where}
      )
      SELECT v.Id AS UserId, v.Name, v.Role,
             p.Lat, p.Lng, p.Accuracy, p.PingTime, p.BatteryPct, p.IsMocked, p.SpeedMps,
             CASE WHEN p.PingTime IS NULL THEN NULL
                  ELSE DATEDIFF(MINUTE, p.PingTime, GETDATE()) END AS MinsAgo,
             lv.CustomerName AS LastVisitName
      FROM Visible v
      OUTER APPLY (
        SELECT TOP 1 lp.Lat, lp.Lng, lp.Accuracy, lp.PingTime, lp.BatteryPct, lp.IsMocked, lp.SpeedMps
        FROM [dbo].[HRM_LocationPing] lp
        WHERE lp.UserId = v.Id AND lp.PingTime >= CAST(GETDATE() AS DATE)
        ORDER BY lp.PingTime DESC
      ) p
      OUTER APPLY (
        SELECT TOP 1 hv.CustomerName
        FROM [dbo].[HRM_Visit] hv
        WHERE hv.UserId = v.Id AND hv.EntryTime >= CAST(GETDATE() AS DATE)
        ORDER BY hv.EntryTime DESC
      ) lv
      ORDER BY CASE WHEN p.PingTime IS NULL THEN 1 ELSE 0 END, p.PingTime DESC;
    `);

    const rows = result.recordset || [];
    res.json({
      ok: true,
      serverTime: new Date(),
      total: rows.length,
      live: rows.filter(x => x.MinsAgo != null && x.MinsAgo <= 15).length,
      tracking: rows.filter(x => x.Lat != null).length,
      users: rows,
    });
  } catch (err) {
    console.error('[/api/hr/location/live] failed:', err.message);
    res.status(500).json({ message: 'Live feed failed', detail: err.message });
  }
});

module.exports = router;
