// =====================================================================
// modules/hr/services/attendanceCompliance.js
//
// Watches each incoming GPS ping and maintains the 4-time-point
// attendance day:
//   Sign-in → (work) → Lunch out → Lunch in → (work) → Sign-out
//
// Triggers per ping (only when user has an open HRM_Attendance row):
//   * LunchOutTime  — stamped when user EXITS the office geofence inside
//                     the lunch window (12:30-2:30 PM) and LunchOutTime is null.
//   * LunchInTime   — stamped when user RE-ENTERS office after LunchOutTime
//                     was set. Sets LunchDurationMin + LateLunchReturn flag.
//   * SignOutTime   — auto-stamped when user is OUTSIDE office at or after
//                     ExpectedSignOutTime - 10 min AND has been outside for
//                     ≥ 10 min. AutoSignOut=1. Captures last known location.
//
// The user explicitly asked for "direct logout" when an employee crosses the
// 100m office boundary at end-of-day — that's what the auto sign-out does.
// During the day, brief geofence exits (lunch, customer visit) are tracked
// separately and don't trigger logout.
//
// Fire-and-forget like visitDetector — never blocks /ping response.
// =====================================================================

const { sql, getAppPool } = require('../../../db');

// Lunch window: an exit during this band is considered a lunch start.
// Outside this band, geofence exits get ignored by lunch logic (could be a
// customer visit or end-of-day logout, handled elsewhere).
// Window per admin 2026-05-27: lunch starts no earlier than 1:30 PM (some
// employees do go at 1:45 PM, so we keep the band wide enough on the late side
// while ruling out late-morning errands).
const LUNCH_WINDOW_START_H = 13; // 1:30 PM
const LUNCH_WINDOW_START_M = 30;
const LUNCH_WINDOW_END_H   = 14; // 2:30 PM — after this, no new LunchOutTime gets stamped
const LUNCH_WINDOW_END_M   = 30;

const LUNCH_RETURN_DEADLINE_H = 14;  // 2:15 PM — past this counts as LateLunchReturn
const LUNCH_RETURN_DEADLINE_M = 15;

// Auto sign-out only fires after this many minutes outside office past expected logout.
const AUTO_LOGOUT_MIN_OUTSIDE = 10;

// Sign-in grace cutoff — past this is LateSignIn
const LATE_SIGNIN_DEADLINE_H = 10; // 10:30 AM
const LATE_SIGNIN_DEADLINE_M = 30;

// Office-geofence cache (60s TTL) — same pattern as visitDetector
let officeCache    = null;
let officeCacheAt  = 0;
const OFFICE_TTL_MS = 60_000;

async function getOfficeFences(pool) {
  const now = Date.now();
  if (officeCache && (now - officeCacheAt) < OFFICE_TTL_MS) return officeCache;
  const r = await pool.request().query(`
    SELECT GeofenceId, Name, Company, CenterLat, CenterLng, RadiusM
    FROM [dbo].[HRM_Geofence]
    WHERE Kind = 'office' AND IsActive = 1
  `);
  officeCache = r.recordset;
  officeCacheAt = now;
  return officeCache;
}
function invalidateOfficeCache() { officeCache = null; officeCacheAt = 0; }

// Haversine distance in metres
function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function isInsideOffice(lat, lng, fences) {
  if (lat == null || lng == null) return false;
  for (const f of fences) {
    if (distM(Number(lat), Number(lng), Number(f.CenterLat), Number(f.CenterLng)) <= Number(f.RadiusM)) {
      return true;
    }
  }
  return false;
}

// Returns the user's open HRM_Attendance row for today, or null.
async function loadOpenAttendance(pool, userId) {
  const r = await pool.request()
    .input('uid', sql.Int, userId)
    .query(`
      SELECT TOP 1
        AttId, Session, SignInTime, SignOutTime,
        ExpectedSignOutTime, LunchOutTime, LunchInTime
      FROM [dbo].[HRM_Attendance]
      WHERE UserId = @uid AND AttDate = CAST(GETDATE() AS DATE)
        AND SignInTime IS NOT NULL AND SignOutTime IS NULL
      ORDER BY Session DESC, AttId DESC;
    `);
  return r.recordset[0] || null;
}

// How long (in minutes) has the user been continuously outside office?
// Looks at the most recent inside-office ping today; if none, returns time since SignInTime.
async function minutesContinuouslyOutside(pool, userId, fences, currentPingTime) {
  const r = await pool.request()
    .input('uid', sql.Int, userId)
    .query(`
      SELECT TOP 50 PingId, PingTime, Lat, Lng
      FROM [dbo].[HRM_LocationPing]
      WHERE UserId = @uid AND CAST(PingTime AS DATE) = CAST(GETDATE() AS DATE)
      ORDER BY PingTime DESC;
    `);
  for (const p of r.recordset) {
    if (isInsideOffice(p.Lat, p.Lng, fences)) {
      return (currentPingTime.getTime() - new Date(p.PingTime).getTime()) / 60000;
    }
  }
  // No inside-office ping today at all → assume since sign-in
  return Infinity;
}

function withinLunchWindow(t) {
  const h = t.getHours(), m = t.getMinutes();
  const minutes = h * 60 + m;
  const start = LUNCH_WINDOW_START_H * 60 + LUNCH_WINDOW_START_M;
  const end   = LUNCH_WINDOW_END_H   * 60 + LUNCH_WINDOW_END_M;
  return minutes >= start && minutes <= end;
}
function isLateLunchReturn(t) {
  const h = t.getHours(), m = t.getMinutes();
  return (h * 60 + m) > (LUNCH_RETURN_DEADLINE_H * 60 + LUNCH_RETURN_DEADLINE_M);
}
function isLateSignIn(t) {
  const h = t.getHours(), m = t.getMinutes();
  return (h * 60 + m) > (LATE_SIGNIN_DEADLINE_H * 60 + LATE_SIGNIN_DEADLINE_M);
}

// Build the ComplianceFlags cached string from the row's current state.
function flagsFor(att) {
  const f = [];
  if (att.LateSignIn === 1 || att.LateSignIn === true) f.push('late_signin');
  if (att.LateLunchReturn === 1 || att.LateLunchReturn === true) f.push('late_lunch');
  if (att.ShortDay === 1 || att.ShortDay === true) f.push('short_day');
  if (att.AutoSignOut === 1 || att.AutoSignOut === true) f.push('auto_signout');
  if (att.LunchOutTime && !att.LunchInTime) f.push('lunch_pending');
  if (!att.LunchOutTime && att.SignOutTime) f.push('no_lunch');
  return f.join(',') || null;
}

// ── Main entry ─────────────────────────────────────────────────────────────
async function processPing(userCtx, ping) {
  try {
    const pool = await getAppPool();
    const att  = await loadOpenAttendance(pool, userCtx.id);
    if (!att) return;   // not signed in → nothing to do

    const fences = await getOfficeFences(pool);
    if (!fences.length) return;   // no office geofence configured → skip

    const inside     = isInsideOffice(ping.Lat, ping.Lng, fences);
    const pingTime   = ping.PingTime instanceof Date ? ping.PingTime : new Date(ping.PingTime);
    const lat        = Number(ping.Lat);
    const lng        = Number(ping.Lng);

    // ── Stamp LunchOutTime when user EXITS office during the lunch window ──
    if (!att.LunchOutTime && !inside && withinLunchWindow(pingTime)) {
      await pool.request()
        .input('id',  sql.BigInt,      att.AttId)
        .input('t',   sql.DateTime2,   pingTime)
        .input('lat', sql.Decimal(9,6), lat)
        .input('lng', sql.Decimal(9,6), lng)
        .input('pid', sql.BigInt,      ping.PingId || null)
        .query(`
          UPDATE [dbo].[HRM_Attendance]
          SET LunchOutTime = @t, LunchOutLat = @lat, LunchOutLng = @lng,
              LunchOutPingId = @pid, UpdatedAt = SYSDATETIME()
          WHERE AttId = @id AND LunchOutTime IS NULL;
        `);
      att.LunchOutTime = pingTime;
    }

    // ── Stamp LunchInTime when user RE-ENTERS office after lunch out ──
    if (att.LunchOutTime && !att.LunchInTime && inside) {
      const lunchOut = new Date(att.LunchOutTime);
      const durMin   = Math.max(0, Math.floor((pingTime - lunchOut) / 60000));
      const late     = isLateLunchReturn(pingTime) ? 1 : 0;
      await pool.request()
        .input('id',  sql.BigInt,      att.AttId)
        .input('t',   sql.DateTime2,   pingTime)
        .input('lat', sql.Decimal(9,6), lat)
        .input('lng', sql.Decimal(9,6), lng)
        .input('pid', sql.BigInt,      ping.PingId || null)
        .input('dur', sql.Int,         durMin)
        .input('llr', sql.Bit,         late)
        .query(`
          UPDATE [dbo].[HRM_Attendance]
          SET LunchInTime = @t, LunchInLat = @lat, LunchInLng = @lng,
              LunchInPingId = @pid, LunchDurationMin = @dur,
              LateLunchReturn = @llr, UpdatedAt = SYSDATETIME()
          WHERE AttId = @id AND LunchInTime IS NULL;
        `);
      att.LunchInTime = pingTime;
      att.LateLunchReturn = late;
    }

    // ── Auto sign-out: outside office at/after ExpectedSignOutTime - 10min ──
    if (att.ExpectedSignOutTime && !inside) {
      const expected = new Date(att.ExpectedSignOutTime);
      const earliest = new Date(expected.getTime() - 10 * 60_000);
      if (pingTime >= earliest) {
        const outsideMin = await minutesContinuouslyOutside(pool, userCtx.id, fences, pingTime);
        if (outsideMin >= AUTO_LOGOUT_MIN_OUTSIDE) {
          const signIn   = new Date(att.SignInTime);
          const totalMin = Math.max(0, Math.floor((pingTime - signIn) / 60000));
          const shortDay = pingTime < expected ? 1 : 0;
          // Refresh att state for flag calc
          att.SignOutTime  = pingTime;
          att.AutoSignOut  = 1;
          att.ShortDay     = shortDay;
          att.LateSignIn   = isLateSignIn(new Date(att.SignInTime)) ? 1 : 0;
          const flags = flagsFor(att);
          await pool.request()
            .input('id',     sql.BigInt,        att.AttId)
            .input('t',      sql.DateTime2,     pingTime)
            .input('lat',    sql.Decimal(9,6),  lat)
            .input('lng',    sql.Decimal(9,6),  lng)
            .input('pid',    sql.BigInt,        ping.PingId || null)
            .input('total',  sql.Int,           totalMin)
            .input('sd',     sql.Bit,           shortDay)
            .input('lsi',    sql.Bit,           att.LateSignIn ? 1 : 0)
            .input('flags',  sql.NVarChar(200), flags)
            .query(`
              UPDATE [dbo].[HRM_Attendance]
              SET SignOutTime    = @t,
                  SignOutLat     = @lat,
                  SignOutLng     = @lng,
                  SignOutPingId  = @pid,
                  SignOutRemarks = ISNULL(SignOutRemarks, 'Auto sign-out — left office geofence'),
                  TotalWorkMin   = @total,
                  AutoSignOut    = 1,
                  ShortDay       = @sd,
                  LateSignIn     = @lsi,
                  ComplianceFlags = @flags,
                  UpdatedAt       = SYSDATETIME()
              WHERE AttId = @id AND SignOutTime IS NULL;
            `);
        }
      }
    }
  } catch (err) {
    console.error('[attendanceCompliance] processPing failed:', err.message);
  }
}

module.exports = { processPing, invalidateOfficeCache };
