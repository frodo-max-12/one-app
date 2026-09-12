// =====================================================================
// modules/hr/routes/officePresence.js — live "who's in / who's out" dashboard
// Mounted at /api/hr/office-presence/* by ../index.js.
//
// GET /              — per-office headcount + per-employee status snapshot
// GET /employees     — flat list of employees with office assignment (for the
//                       Manage Assignments modal)
// POST /assign       — bulk assign / re-assign employees to office geofences
//                       Body: { assignments: [ { userId, officeId|null } ] }
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');
const anomalyDetector = require('../services/anomalyDetector');

const OFFICE_GRACE_M = 100;   // matches anomalyDetector

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function haversineM(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lat2 == null) return Infinity;
  const R = 6371000;
  const toRad = (x) => (Number(x) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can view Office Presence' });
    const pool = await getAppPool();
    const today = todayISO();

    // Load all 'office' geofences
    const fenceRes = await pool.request().query(`
      SELECT GeofenceId, Name, Kind, CenterLat, CenterLng, RadiusM, City, Company
      FROM [dbo].[HRM_Geofence]
      WHERE IsActive = 1 AND Kind = 'office'
      ORDER BY Name;
    `);
    const offices = fenceRes.recordset;

    // Single join query — every employee with their office + today's attendance + latest ping
    const empRes = await pool.request()
      .input('dt', sql.Date, today)
      .query(`
        SELECT
          UL.Id              AS UserId,
          UL.Name            AS UserName,
          UL.Email           AS Email,
          UL.Role            AS Role,
          UL.CompanyACode         AS CompanyACode,
          UL.CompanyBCode      AS CompanyBCode,
          E.OfficeId         AS OfficeId,
          A.AttId            AS AttId,
          A.SignInTime       AS SignInTime,
          A.SignOutTime      AS SignOutTime,
          P.PingId           AS LatestPingId,
          P.PingTime         AS LatestPingTime,
          P.Lat              AS LatestLat,
          P.Lng              AS LatestLng
        FROM [dbo].[User_Login] UL
        LEFT JOIN [dbo].[HRM_Employee] E ON E.UserId = UL.Id
        OUTER APPLY (
          SELECT TOP 1 AttId, SignInTime, SignOutTime
          FROM [dbo].[HRM_Attendance]
          WHERE UserId = UL.Id AND AttDate = @dt
          ORDER BY Session DESC
        ) A
        OUTER APPLY (
          SELECT TOP 1 PingId, PingTime, Lat, Lng
          FROM [dbo].[HRM_LocationPing]
          WHERE UserId = UL.Id AND CAST(PingTime AS DATE) = @dt
          ORDER BY PingTime DESC
        ) P
        WHERE UL.IsActive = 1
        ORDER BY UL.Name;
      `);

    // Build office → employees mapping
    const employees = empRes.recordset.map(e => {
      const office = offices.find(o => o.GeofenceId === e.OfficeId) || null;
      let status = 'unassigned';
      let detail = '';
      if (e.OfficeId) {
        if (!e.SignInTime) {
          status = 'not_in';
          detail = 'Not yet signed in today';
        } else if (e.SignOutTime) {
          status = 'signed_out';
          detail = `Worked ${fmtHMM(e.SignInTime, e.SignOutTime)}`;
        } else if (e.LatestLat != null && office) {
          const dist = haversineM(office.CenterLat, office.CenterLng, e.LatestLat, e.LatestLng);
          if (dist <= office.RadiusM + OFFICE_GRACE_M) {
            status = 'in_office';
            detail = `Last ping ${ago(e.LatestPingTime)}`;
          } else {
            status = 'out_of_office';
            detail = `${Math.round(dist)}m away · last ping ${ago(e.LatestPingTime)}`;
          }
        } else {
          status = 'signed_in_no_ping';
          detail = 'Signed in, no GPS pings yet';
        }
      }
      return {
        userId:     e.UserId,
        name:       e.UserName,
        email:      e.Email,
        role:       e.Role,
        companyaCode:    e.CompanyACode,
        officeId:   e.OfficeId,
        officeName: office ? office.Name : null,
        attId:      e.AttId,
        signInTime: e.SignInTime,
        signOutTime: e.SignOutTime,
        latestPingTime: e.LatestPingTime,
        latestLat:  e.LatestLat,
        latestLng:  e.LatestLng,
        status,
        detail,
      };
    });

    // Compute per-office tile aggregates
    const officeStats = offices.map(o => {
      const assigned = employees.filter(e => e.officeId === o.GeofenceId);
      return {
        ...o,
        totals: {
          assigned:    assigned.length,
          inOffice:    assigned.filter(e => e.status === 'in_office').length,
          outOffice:   assigned.filter(e => e.status === 'out_of_office').length,
          notIn:       assigned.filter(e => e.status === 'not_in').length,
          signedOut:   assigned.filter(e => e.status === 'signed_out').length,
          noPing:      assigned.filter(e => e.status === 'signed_in_no_ping').length,
        },
      };
    });

    const unassignedCount = employees.filter(e => !e.officeId).length;

    return res.json({
      ok: true,
      date: today,
      offices: officeStats,
      employees,
      unassignedCount,
    });
  } catch (err) {
    console.error('[/api/hr/office-presence] failed:', err.message);
    return res.status(500).json({ message: 'Office presence failed', detail: err.message });
  }
});

// ── GET /employees ─────────────────────────────────────────────────────────
router.get('/employees', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can manage assignments' });
    const pool = await getAppPool();
    const r = await pool.request().query(`
      SELECT
        UL.Id         AS UserId,
        UL.Name       AS UserName,
        UL.Email      AS Email,
        UL.Role       AS Role,
        UL.CompanyACode    AS CompanyACode,
        E.OfficeId    AS OfficeId
      FROM [dbo].[User_Login] UL
      LEFT JOIN [dbo].[HRM_Employee] E ON E.UserId = UL.Id
      WHERE UL.IsActive = 1
      ORDER BY UL.Name;
    `);
    const offices = await pool.request().query(`
      SELECT GeofenceId, Name, City FROM [dbo].[HRM_Geofence]
      WHERE IsActive = 1 AND Kind = 'office' ORDER BY Name;
    `);
    return res.json({ ok: true, employees: r.recordset, offices: offices.recordset });
  } catch (err) {
    return res.status(500).json({ message: 'Employees fetch failed', detail: err.message });
  }
});

// ── POST /assign ────────────────────────────────────────────────────────────
// Body: { assignments: [ { userId, officeId|null }, ... ] }
// Creates / updates HRM_Employee row(s). HR can detach by passing officeId=null.
router.post('/assign', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can manage assignments' });
    const list = Array.isArray(req.body && req.body.assignments) ? req.body.assignments : null;
    if (!list || list.length === 0) return res.status(400).json({ message: 'assignments[] required' });
    if (list.length > 500) return res.status(400).json({ message: 'too many (max 500)' });

    const pool = await getAppPool();
    let updated = 0, inserted = 0;

    for (const a of list) {
      const uid = parseInt(a.userId);
      if (!Number.isFinite(uid) || uid <= 0) continue;
      const officeId = a.officeId != null && Number.isFinite(parseInt(a.officeId))
        ? parseInt(a.officeId) : null;

      // MERGE-style: update existing HRM_Employee row, or insert minimal one
      const existing = await pool.request()
        .input('uid', sql.Int, uid)
        .query(`SELECT EmpId FROM [dbo].[HRM_Employee] WHERE UserId = @uid;`);
      if (existing.recordset.length > 0) {
        await pool.request()
          .input('uid',      sql.Int, uid)
          .input('officeId', sql.Int, officeId)
          .query(`
            UPDATE [dbo].[HRM_Employee]
            SET OfficeId = @officeId, UpdatedAt = SYSDATETIME()
            WHERE UserId = @uid;
          `);
        updated++;
      } else {
        await pool.request()
          .input('uid',      sql.Int, uid)
          .input('officeId', sql.Int, officeId)
          .query(`
            INSERT INTO [dbo].[HRM_Employee] (UserId, OfficeId)
            VALUES (@uid, @officeId);
          `);
        inserted++;
      }
    }
    // Invalidate the anomalyDetector's employee cache so changes take effect immediately
    anomalyDetector.invalidateCaches();
    return res.json({ ok: true, inserted, updated });
  } catch (err) {
    console.error('[POST /api/hr/office-presence/assign] failed:', err.message);
    return res.status(500).json({ message: 'Assign failed', detail: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtHMM(start, end) {
  if (!start) return '—';
  const ms = (end ? new Date(end) : new Date()) - new Date(start);
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function ago(t) {
  if (!t) return 'never';
  const ms = Date.now() - new Date(t).getTime();
  if (ms < 60_000)   return Math.round(ms / 1000) + 's ago';
  if (ms < 3600_000) return Math.round(ms / 60000) + ' min ago';
  return Math.round(ms / 3600000) + 'h ago';
}

module.exports = router;
