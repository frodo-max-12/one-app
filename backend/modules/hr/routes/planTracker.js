// =====================================================================
// modules/hr/routes/planTracker.js — Visit Plan vs Reality (Phase 2.5)
// Mounted at /api/hr/plan-tracker/* by ../index.js.
//
// GET /day?userId=X&date=YYYY-MM-DD
//   For a given employee + date, returns:
//     - planned[]:    rows from BN_VisitPlan for that date+salesperson
//     - actual[]:     rows from HRM_Visit (confirmed) for that date+user
//     - pings[]:      HRM_LocationPing trail for the day (for the map polyline)
//     - kpis:         { plannedCount, completed, missed, adHoc, totalCustomerMin }
//
// Permission scoping mirrors /journey/day:
//   - admin / operation head / director → any userId
//   - heads → own + team (CompanyACode/CompanyBCode prefix match)
//   - everyone else → only self
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

async function canViewUser(reqUser, targetUserId, pool) {
  if (Number(targetUserId) === Number(reqUser.id)) return true;
  if (isLensAdmin(reqUser)) return true;

  // FAE Head supervises the FAE team → may view any user whose role is fae/fae head.
  if (isFaeHead(reqUser)) {
    const fr = await pool.request().input('uid', sql.Int, targetUserId)
      .query(`SELECT TOP 1 1 AS hit FROM [dbo].[User_Login] WHERE Id = @uid AND LOWER(Role) IN ('fae','fae head');`);
    return fr.recordset.length > 0;
  }

  if (!isAnyHead(reqUser)) return false;

  // *head with codes: covers sales head / Sales Head Electrical / Electrical
  // Head / north sales head — anyone whose role contains 'head' AND has codes.
  const codes = ((reqUser.companyaCode || '') + '/' + (reqUser.companybCode || ''))
    .split('/').map(s => s.trim()).filter(Boolean);
  if (codes.length === 0) return false;

  const r = pool.request().input('uid', sql.Int, targetUserId);
  codes.forEach((c, i) => r.input('hc' + i, sql.NVarChar(50), c));
  const result = await r.query(`
    SELECT TOP 1 1 AS hit
    FROM [dbo].[User_Login] UL
    WHERE UL.Id = @uid
      AND (
        EXISTS (SELECT 1 FROM string_split(UL.CompanyACode,    '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@hc'+i).join(',')}))
        OR EXISTS (SELECT 1 FROM string_split(UL.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@hc'+i).join(',')}))
      );
  `);
  return result.recordset.length > 0;
}

router.get('/day', authenticate, async (req, res) => {
  try {
    const date         = (req.query.date || todayISO()).slice(0, 10);
    const targetUserId = parseInt(req.query.userId) || req.user.id;
    const pool         = await getAppPool();

    if (!(await canViewUser(req.user, targetUserId, pool))) {
      return res.status(403).json({ message: 'Not allowed to view this user' });
    }

    // user info — also gives us CompanyACode/CompanyBCode so we can scan BN_VisitPlan correctly
    const uRes = await pool.request()
      .input('uid', sql.Int, targetUserId)
      .query(`SELECT Id, Name, Email, Role, CompanyACode, CompanyBCode FROM [dbo].[User_Login] WHERE Id = @uid;`);
    const target = uRes.recordset[0] || null;
    if (!target) return res.status(404).json({ message: 'user not found' });

    // ── Planned visits ───────────────────────────────────────────────────
    // BN_VisitPlan keys on SalespersonCode (the CompanyACode/CompanyBCode list for the user).
    const companyaCodes = (target.CompanyACode    || '').split('/').map(s => s.trim()).filter(Boolean);
    const advCodes = (target.CompanyBCode || '').split('/').map(s => s.trim()).filter(Boolean);

    let planned = [];
    if (companyaCodes.length > 0 || advCodes.length > 0) {
      const r = pool.request().input('dt', sql.Date, date);
      const conds = [];
      if (companyaCodes.length > 0) {
        companyaCodes.forEach((c, i) => r.input('companya' + i, sql.NVarChar(50), c));
        conds.push(`(Company = 'COMPANYA' AND SalespersonCode IN (${companyaCodes.map((_, i) => '@companya' + i).join(',')}))`);
      }
      if (advCodes.length > 0) {
        advCodes.forEach((c, i) => r.input('adv' + i, sql.NVarChar(50), c));
        conds.push(`(Company = 'CompanyB' AND SalespersonCode IN (${advCodes.map((_, i) => '@adv' + i).join(',')}))`);
      }
      const planRes = await r.query(`
        SELECT Id, Company, Week, SalespersonCode, SalespersonName, VisitDate,
               CustomerName, CustomerCode, Application, CustomerType, VisitAgenda, Location,
               ContactPerson, ContactDetails,
               VisitDone, MOM,
               IsAdHoc, Source, Department,
               AutoConfirmedAt, ManualConfirmedAt, ManualConfirmedByUserId,
               EntryPingId, ExitPingId,
               CreatedAt, UpdatedAt
        FROM [dbo].[BN_VisitPlan]
        WHERE VisitDate = @dt
          AND (${conds.join(' OR ')})
        ORDER BY ISNULL(AutoConfirmedAt, ISNULL(ManualConfirmedAt, CONVERT(datetime2(0), VisitDate)));
      `);
      planned = planRes.recordset;
    }

    // ── Actual confirmed visits from the GPS detector ─────────────────────
    const actRes = await pool.request()
      .input('uid', sql.Int, targetUserId)
      .input('dt',  sql.Date, date)
      .query(`
        SELECT V.VisitId, V.GeofenceId, V.CustomerCode, V.CustomerName,
               V.EntryTime, V.ExitTime, V.DurationMin, V.Lat, V.Lng,
               V.IsConfirmedVisit, V.AutoConfirmedAt, V.VisitPlanId,
               V.Department, V.Label,
               -- v1.8 Punch-In/Out evidence: GPS + photos for head-level review.
               V.PunchInTime,  V.PunchInLat,  V.PunchInLng,
               V.PunchInSelfieUrl, V.PunchInPremisePhotoUrl,
               V.PunchOutTime, V.PunchOutLat, V.PunchOutLng,
               V.PunchOutPremisePhotoUrl,
               G.Name AS GeofenceName, G.Kind AS GeofenceKind, G.RadiusM
        FROM [dbo].[HRM_Visit] V
        LEFT JOIN [dbo].[HRM_Geofence] G ON G.GeofenceId = V.GeofenceId
        WHERE V.UserId = @uid
          AND CAST(V.EntryTime AS DATE) = @dt
          AND V.IsConfirmedVisit = 1
          AND (V.Label IS NULL OR V.Label NOT IN ('personal','lunch','skip'))
        ORDER BY V.EntryTime;
      `);
    const actual = actRes.recordset;

    // ── Pings for the map polyline ───────────────────────────────────────
    const pingRes = await pool.request()
      .input('uid', sql.Int, targetUserId)
      .input('dt',  sql.Date, date)
      .query(`
        SELECT PingId, PingTime, Lat, Lng
        FROM [dbo].[HRM_LocationPing]
        WHERE UserId = @uid AND CAST(PingTime AS DATE) = @dt
        ORDER BY PingTime;
      `);
    const pings = pingRes.recordset;

    // ── Effective visit duration ──────────────────────────────────────────
    // DurationMin is only written when the GPS detector CLOSES a visit (user
    // exits the geofence). If the app stopped pinging while the rep was still
    // at the customer — or the visit simply never closed — DurationMin stays
    // NULL and Customer Time wrongly reads 0. Fall back to:
    //   ExitTime → else last ping of the day → else (today only) now.
    // (Fix 2026-05-28 — a rep showed 0.0h despite a completed visit.)
    const isToday      = date === todayISO();
    const lastPingTime = pings.length ? new Date(pings[pings.length - 1].PingTime) : null;
    function effectiveDur(v) {
      if (v.DurationMin != null) return v.DurationMin;
      const entry = new Date(v.EntryTime);
      let end = null;
      if (v.ExitTime)               end = new Date(v.ExitTime);
      else if (isToday)             end = new Date();
      else if (lastPingTime && lastPingTime > entry) end = lastPingTime;
      if (!end) return 0;
      return Math.max(0, Math.round((end - entry) / 60000));
    }
    actual.forEach(v => { v.EffectiveDurationMin = effectiveDur(v); });

    // ── KPIs ─────────────────────────────────────────────────────────────
    const plannedCount = planned.length;
    const completed    = planned.filter(p => p.VisitDone === true || p.VisitDone === 1).length;
    const missed       = plannedCount - completed;
    const adHoc        = planned.filter(p => p.IsAdHoc === true || p.IsAdHoc === 1).length;
    const totalCustomerMin = actual.reduce((s, v) => s + (v.EffectiveDurationMin || 0), 0);

    // Road-snapped + noise-filtered polyline (clean map track). Graceful
    // fallback to filtered raw path if Roads API key absent / errors.
    const snap = await snapToRoads(pings, { userId: targetUserId, date });

    return res.json({
      ok: true,
      date,
      user: target,
      planned, actual, pings,
      snappedPath: snap.path,
      snapped:     snap.snapped,
      kpis: { plannedCount, completed, missed, adHoc, totalCustomerMin },
    });
  } catch (err) {
    console.error('[/api/hr/plan-tracker/day] failed:', err.message);
    return res.status(500).json({ message: 'Plan tracker fetch failed', detail: err.message });
  }
});

module.exports = router;
