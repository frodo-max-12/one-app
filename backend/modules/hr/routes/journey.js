// =====================================================================
// modules/hr/routes/journey.js — Day Journey (Phase 2)
//
// Mounted at /api/hr/journey/* by ../index.js.
//
// GET /day?userId=X&date=YYYY-MM-DD
//   Returns one day's full timeline for an employee:
//     - sessions: HRM_Attendance rows for the day (1..N sessions)
//     - pings:    HRM_LocationPing rows for the day, time-ordered
//     - visits:   HRM_Visit rows for the day (empty until geofence is set up)
//
// Scope rules (same buckets as auth.js):
//   - admin / operation head / director → can view ANY userId
//   - sales head / north sales head     → own + team (matched via CompanyACode/CompanyBCode prefixes)
//   - everyone else                     → only their own userId
//
// GET /pickable-users — list of users the caller may inspect (for the dropdown)
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isFullAccess, isSalesHead, isLensAdmin, isFaeHead, isAnyHead } = require('../../../auth');
const { snapToRoads } = require('../services/roadsSnap');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function canViewUser(reqUser, targetUserId, pool) {
  // returns Promise<boolean>
  if (Number(targetUserId) === Number(reqUser.id)) return Promise.resolve(true);
  if (isLensAdmin(reqUser)) return Promise.resolve(true);

  // FAE Head supervises the FAE team → may view any user whose role is fae/fae head.
  if (isFaeHead(reqUser)) {
    return pool.request().input('uid', sql.Int, targetUserId)
      .query(`SELECT TOP 1 1 AS hit FROM [dbo].[User_Login] WHERE Id = @uid AND LOWER(Role) IN ('fae','fae head');`)
      .then(r => r.recordset.length > 0);
  }

  if (!isAnyHead(reqUser)) return Promise.resolve(false);

  // *head with codes: check that target's CompanyACode/CompanyBCode codes intersect
  // the head's code list (covers sales head / Sales Head Electrical / Electrical
  // Head / north sales head — anyone whose role contains 'head' AND has codes).
  const headCodes = ((reqUser.companyaCode || '') + '/' + (reqUser.companybCode || ''))
    .split('/').map(s => s.trim()).filter(Boolean);
  if (headCodes.length === 0) return Promise.resolve(false);

  const req = pool.request().input('uid', sql.Int, targetUserId);
  headCodes.forEach((c, i) => req.input('hc' + i, sql.NVarChar(50), c));
  return req.query(`
    SELECT TOP 1 1 AS hit
    FROM [dbo].[User_Login] UL
    WHERE UL.Id = @uid
      AND (
        EXISTS (SELECT 1 FROM string_split(UL.CompanyACode,    '/') s WHERE LTRIM(RTRIM(s.value)) IN (${headCodes.map((_,i)=>'@hc'+i).join(',')}))
        OR EXISTS (SELECT 1 FROM string_split(UL.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${headCodes.map((_,i)=>'@hc'+i).join(',')}))
      );
  `).then(r => r.recordset.length > 0);
}

// ── GET /day ─────────────────────────────────────────────────────────────────
router.get('/day', authenticate, async (req, res) => {
  try {
    const date = (req.query.date || todayISO()).slice(0, 10);
    const targetUserId = parseInt(req.query.userId) || req.user.id;
    const pool = await getAppPool();

    const allowed = await canViewUser(req.user, targetUserId, pool);
    if (!allowed) return res.status(403).json({ message: 'Not allowed to view this user' });

    // user info
    const uRes = await pool.request()
      .input('uid', sql.Int, targetUserId)
      .query(`SELECT Id, Name, Email, CompanyACode, CompanyBCode, Role FROM [dbo].[User_Login] WHERE Id = @uid;`);
    const userRow = uRes.recordset[0] || null;

    // sessions
    const sRes = await pool.request()
      .input('uid', sql.Int,  targetUserId)
      .input('dt',  sql.Date, date)
      .query(`
        SELECT AttId, Session, Status, ShiftCode,
               SignInTime,  SignInLat,  SignInLng,  SignInRemarks,  SignInSelfieUrl,
               SignOutTime, SignOutLat, SignOutLng, SignOutRemarks, SignOutSelfieUrl,
               TotalWorkMin, DistanceKm
        FROM [dbo].[HRM_Attendance]
        WHERE UserId = @uid AND AttDate = @dt
        ORDER BY Session;
      `);

    // pings (whole 24h of selected date)
    const pRes = await pool.request()
      .input('uid', sql.Int,  targetUserId)
      .input('dt',  sql.Date, date)
      .query(`
        SELECT PingId, PingTime, Lat, Lng, Accuracy, SpeedMps, BatteryPct, IsMocked, Source
        FROM [dbo].[HRM_LocationPing]
        WHERE UserId = @uid
          AND CAST(PingTime AS DATE) = @dt
        ORDER BY PingTime;
      `);

    // visits (will be empty until geofence work in next chunk)
    const vRes = await pool.request()
      .input('uid', sql.Int,  targetUserId)
      .input('dt',  sql.Date, date)
      .query(`
        SELECT VisitId, GeofenceId, CustomerCode, CustomerName,
               EntryTime, ExitTime, DurationMin,
               EntryPingId, ExitPingId, Lat, Lng,
               IsConfirmedVisit, AutoConfirmedAt, Department, VisitPlanId, MOM, Notes
        FROM [dbo].[HRM_Visit]
        WHERE UserId = @uid
          AND CAST(EntryTime AS DATE) = @dt
        ORDER BY EntryTime;
      `);

    // Road-snapped + noise-filtered polyline for a clean map track. Falls back
    // to the filtered raw path if the Roads API key is absent or errors.
    const snap = await snapToRoads(pRes.recordset, { userId: targetUserId, date });

    return res.json({
      ok: true,
      date,
      user: userRow,
      sessions:    sRes.recordset,
      pings:       pRes.recordset,
      visits:      vRes.recordset,
      snappedPath: snap.path,
      snapped:     snap.snapped,
    });
  } catch (err) {
    console.error('[/api/hr/journey/day] failed:', err.message);
    return res.status(500).json({ message: 'Day fetch failed', detail: err.message });
  }
});

// ── GET /pickable-users ──────────────────────────────────────────────────────
router.get('/pickable-users', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = pool.request();
    let where = '';
    if (isLensAdmin(req.user)) {
      where = '';
    } else if (isFaeHead(req.user)) {
      // FAE Head → the whole FAE team (fae + fae head)
      where = "AND LOWER(UL.Role) IN ('fae','fae head')";
    } else if (isAnyHead(req.user)) {
      const codes = ((req.user.companyaCode || '') + '/' + (req.user.companybCode || ''))
        .split('/').map(s => s.trim()).filter(Boolean);
      if (codes.length === 0) {
        return res.json({ ok: true, users: [{ Id: req.user.id, Name: req.user.name, Email: req.user.email }] });
      }
      codes.forEach((c, i) => r.input('c' + i, sql.NVarChar(50), c));
      where = `AND (
        EXISTS (SELECT 1 FROM string_split(UL.CompanyACode,    '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@c'+i).join(',')}))
        OR EXISTS (SELECT 1 FROM string_split(UL.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@c'+i).join(',')}))
        OR UL.Id = @selfId
      )`;
      r.input('selfId', sql.Int, req.user.id);
    } else {
      r.input('selfId', sql.Int, req.user.id);
      where = 'AND UL.Id = @selfId';
    }
    const result = await r.query(`
      SELECT UL.Id, UL.Name, UL.Email, UL.CompanyACode, UL.CompanyBCode, UL.Role
      FROM [dbo].[User_Login] UL
      WHERE UL.IsActive = 1
        ${where}
      ORDER BY UL.Name;
    `);
    return res.json({ ok: true, users: result.recordset });
  } catch (err) {
    console.error('[/api/hr/journey/pickable-users] failed:', err.message);
    return res.status(500).json({ message: 'Pickable users failed', detail: err.message });
  }
});

module.exports = router;
