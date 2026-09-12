// ============================================================================
// modules/hr/services/visitDetector.js — auto visit-confirm engine (Phase 2.4)
//
// Called fire-and-forget from POST /api/hr/location/ping after the ping row
// is inserted. Does NOT block the ping response. Errors are logged, not thrown.
//
// On each ping it does FOUR things:
//
//   A. Close open visits the user has now exited
//      (open HRM_Visit row whose geofence the user is no longer inside)
//
//   B. Confirm visits whose dwell time has reached the geofence's threshold
//      (open HRM_Visit + dwell ≥ geofence.DwellMinForVisit  →  IsConfirmedVisit=1
//       + AutoConfirmedAt + try-match against today's BN_VisitPlan)
//
//   C. Open new visits when the user enters a geofence they're not already in
//
//   D. Detect "unknown stops" — stationary periods ≥15 min outside any geofence
//      (creates HRM_Visit row with GeofenceId=NULL, IsConfirmedVisit=0 — these
//       show up in the Unknown Stops admin page for review)
//
// Constants are at the top of the file for easy tuning.
// ============================================================================

const { sql, getAppPool } = require('../../../db');

const UNKNOWN_DWELL_MIN     = 15;     // minutes — must be stationary this long
const UNKNOWN_CLUSTER_M     = 75;     // meters — max wander to still be "stationary"
const UNKNOWN_EXIT_M        = 150;    // meters — moving this far from centroid closes the stop
const REVISIT_GAP_MIN       = 120;    // minutes — a re-entry within this window is the SAME dwell
                                      // (GPS drift); a longer gap is a genuine re-visit → new row
const MAX_DWELL_CONFIRM_MIN = 720;    // minutes (12h) — a "dwell" longer than this is NOT a real
                                      // stay: it's a visit openNewVisits opened but never closed
                                      // (pings stopped / app killed). Confirming it stamps a phantom
                                      // "Visit Done" — this is how 20 June-16 opens got mass-confirmed
                                      // weeks later onto a rep's plan. Close it unconfirmed instead.
const GEOFENCE_CACHE_MS     = 5 * 60 * 1000;

let _geoCache    = null;
let _geoCacheAt  = 0;

function invalidateGeofenceCache() { _geoCache = null; _geoCacheAt = 0; _beatCache = null; _beatCacheAt = 0; }

async function getActiveGeofences(pool) {
  if (_geoCache && Date.now() - _geoCacheAt < GEOFENCE_CACHE_MS) return _geoCache;
  const r = await pool.request().query(`
    SELECT GeofenceId, Name, Kind, CustomerCode, Company,
           CenterLat, CenterLng, RadiusM, DwellMinForVisit
    FROM [dbo].[HRM_Geofence]
    WHERE IsActive = 1;
  `);
  _geoCache   = r.recordset;
  _geoCacheAt = Date.now();
  return _geoCache;
}

// ── Electrical beat-plan scoping ────────────────────────────────────────────
// The HRM_Geofence library is GLOBAL and ~90% of it (601/666) is the Electrical
// vertical's beat-plan retail shops. openNewVisits matches a ping to the NEAREST
// geofence in the WHOLE library — so a non-electrical rep/FAE passing through a dense
// electrical-retail area got their HRM_Visit (and thus the Live-Map "last visit" and
// visit history) stamped with an electrical shop's name they never dealt with.
// Fix: for users NOT on the electrical beat, exclude beat-plan geofences from matching.
// They then fall through to their own (non-beat) customer geofence, or to an unknown
// stop — never a foreign vertical's customer. The 6 actual beat reps are unaffected.
let _beatCache = null, _beatCacheAt = 0;
async function getBeatContext(pool) {
  if (_beatCache && Date.now() - _beatCacheAt < GEOFENCE_CACHE_MS) return _beatCache;
  const codes = await pool.request().query(`
    SELECT DISTINCT LTRIM(RTRIM(SalespersonCode)) AS Code
    FROM [dbo].[BN_VisitPlan]
    WHERE BeatId IS NOT NULL AND ISNULL(SalespersonCode,'') <> '';`);
  const geos = await pool.request().query(`
    SELECT g.GeofenceId
    FROM [dbo].[HRM_Geofence] g
    WHERE g.IsActive = 1 AND (
      EXISTS (SELECT 1 FROM [dbo].[BN_VisitPlan] v WHERE v.BeatId IS NOT NULL
        AND LTRIM(RTRIM(v.CustomerName)) COLLATE SQL_Latin1_General_CP1_CI_AS
          = LTRIM(RTRIM(g.Name)) COLLATE SQL_Latin1_General_CP1_CI_AS)
      OR (ISNULL(g.CustomerCode,'') <> '' AND EXISTS (
        SELECT 1 FROM [dbo].[BN_VisitPlan] v WHERE v.BeatId IS NOT NULL AND v.CustomerCode = g.CustomerCode)));`);
  _beatCache = {
    beatCodes:  new Set(codes.recordset.map(r => (r.Code || '').toUpperCase())),
    beatGeoIds: new Set(geos.recordset.map(r => r.GeofenceId)),
  };
  _beatCacheAt = Date.now();
  return _beatCache;
}
// True if this user is one of the electrical beat reps (any of their codes is on the beat).
function isBeatRep(userCtx, beat) {
  const codes = ((userCtx.companyaCode || '') + '/' + (userCtx.companybCode || ''))
    .split('/').map(s => s.trim().toUpperCase()).filter(Boolean);
  return codes.some(c => beat.beatCodes.has(c));
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (Number(x) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isInsideFence(lat, lng, fence) {
  return haversineM(Number(fence.CenterLat), Number(fence.CenterLng), Number(lat), Number(lng)) <= Number(fence.RadiusM);
}

// ── A. Close open visits the user has now exited ───────────────────────────
async function closeExitedVisits(pool, userId, ping, insideFenceIds) {
  const r = await pool.request()
    .input('uid', sql.Int, userId)
    .query(`
      SELECT VisitId, GeofenceId, EntryTime, Lat, Lng
      FROM [dbo].[HRM_Visit]
      WHERE UserId = @uid AND ExitTime IS NULL;
    `);
  for (const v of r.recordset) {
    let stillInside;
    if (v.GeofenceId) {
      stillInside = insideFenceIds.has(v.GeofenceId);
    } else {
      // unknown stop — close when user wanders too far from entry centroid
      stillInside = haversineM(Number(v.Lat), Number(v.Lng), Number(ping.Lat), Number(ping.Lng)) <= UNKNOWN_EXIT_M;
    }
    if (!stillInside) {
      const durMin = Math.max(0, Math.round((new Date(ping.PingTime) - new Date(v.EntryTime)) / 60000));
      await pool.request()
        .input('vid',   sql.Int,         v.VisitId)
        .input('exitT', sql.DateTime2,   ping.PingTime)
        .input('exitP', sql.BigInt,      ping.PingId)
        .input('dur',   sql.Int,         durMin)
        .query(`
          UPDATE [dbo].[HRM_Visit]
          SET ExitTime = @exitT, ExitPingId = @exitP, DurationMin = @dur, UpdatedAt = SYSDATETIME()
          WHERE VisitId = @vid;
        `);
    }
  }
}

// ── C. Open a new visit for the geofence the user just entered ─────────────
// Only the SINGLE NEAREST in-range fence is opened. In dense areas many 100m
// geofences overlap, so a single ping can sit "inside" several — opening one per
// fence created the "8 different customers at the same second" bug. And we skip
// if this fence already has an OPEN visit, or one that CLOSED within the last
// REVISIT_GAP_MIN, so GPS-drift exit/re-entry doesn't spawn duplicates while a
// genuine return after a longer gap still logs a fresh visit.
// NOTE: caller still passes the FULL in-range set to closeExitedVisits(), which
// must keep seeing every fence the user is inside — do not narrow that here.
async function openNewVisits(pool, userId, userCode, company, ping, insideFences) {
  if (!insideFences || insideFences.length === 0) return;

  let fence = null, best = Infinity;
  for (const f of insideFences) {
    const d = haversineM(Number(f.CenterLat), Number(f.CenterLng), Number(ping.Lat), Number(ping.Lng));
    if (d < best) { best = d; fence = f; }
  }
  if (!fence) return;

  const e = await pool.request()
    .input('uid', sql.Int,       userId)
    .input('fid', sql.Int,       fence.GeofenceId)
    .input('pt',  sql.DateTime2, ping.PingTime)
    .input('gap', sql.Int,       REVISIT_GAP_MIN)
    .query(`
      SELECT TOP 1 VisitId FROM [dbo].[HRM_Visit]
      WHERE UserId = @uid AND GeofenceId = @fid
        AND (ExitTime IS NULL OR ExitTime >= DATEADD(MINUTE, -@gap, @pt));
    `);
  if (e.recordset.length > 0) return;

  const dept = inferDept(company, userCode);
  await pool.request()
    .input('uid', sql.Int,           userId)
    .input('uc',  sql.NVarChar(50),  userCode)
    .input('co',  sql.NVarChar(10),  company)
    .input('fid', sql.Int,           fence.GeofenceId)
    .input('cc',  sql.NVarChar(50),  fence.CustomerCode)
    .input('cn',  sql.NVarChar(200), fence.Name)
    .input('dept', sql.NVarChar(10), dept)
    .input('et',  sql.DateTime2,     ping.PingTime)
    .input('ep',  sql.BigInt,        ping.PingId)
    .input('lat', sql.Decimal(9, 6), ping.Lat)
    .input('lng', sql.Decimal(9, 6), ping.Lng)
    .query(`
      INSERT INTO [dbo].[HRM_Visit]
        (UserId, UserCode, Company, GeofenceId, CustomerCode, CustomerName,
         Department, EntryTime, EntryPingId, Lat, Lng)
      VALUES
        (@uid, @uc, @co, @fid, @cc, @cn, @dept, @et, @ep, @lat, @lng);
    `);
}

function inferDept(_company, _userCode) {
  // Phase 2.4: leave as SALES default. Phase 3 will pull from HRM_Employee.Department.
  return 'SALES';
}

// ── B. Confirm visits whose dwell ≥ threshold ──────────────────────────────
async function confirmDwelledVisits(pool, userId, ping, insideFences) {
  if (insideFences.length === 0) return;
  // Get all open visits matching current insideFences
  const fenceById = new Map(insideFences.map(f => [f.GeofenceId, f]));
  const fenceIds  = [...fenceById.keys()];
  const r = pool.request().input('uid', sql.Int, userId);
  fenceIds.forEach((id, i) => r.input('fid' + i, sql.Int, id));
  const result = await r.query(`
    SELECT VisitId, GeofenceId, EntryTime, IsConfirmedVisit
    FROM [dbo].[HRM_Visit]
    WHERE UserId = @uid
      AND GeofenceId IN (${fenceIds.map((_, i) => '@fid' + i).join(',')})
      AND ExitTime IS NULL
      AND IsConfirmedVisit = 0;
  `);
  for (const v of result.recordset) {
    const f = fenceById.get(v.GeofenceId);
    const threshold = (f && f.DwellMinForVisit) || 10;
    const dwellMin  = (new Date(ping.PingTime) - new Date(v.EntryTime)) / 60000;
    // Stale-open guard: an over-long "dwell" is a visit that was opened but never
    // closed (see MAX_DWELL_CONFIRM_MIN). Close it UNCONFIRMED — never confirm it,
    // never create a BN_VisitPlan row — so it can't resurface as a phantom visit.
    if (dwellMin > MAX_DWELL_CONFIRM_MIN) {
      await pool.request()
        .input('vid', sql.Int,       v.VisitId)
        .input('xt',  sql.DateTime2, ping.PingTime)
        .query(`
          UPDATE [dbo].[HRM_Visit]
          SET ExitTime = @xt, DurationMin = NULL, UpdatedAt = SYSDATETIME()
          WHERE VisitId = @vid AND ExitTime IS NULL;
        `);
      continue;
    }
    if (dwellMin >= threshold) {
      await pool.request()
        .input('vid', sql.Int,         v.VisitId)
        .input('cf',  sql.DateTime2,   ping.PingTime)
        .query(`
          UPDATE [dbo].[HRM_Visit]
          SET IsConfirmedVisit = 1, AutoConfirmedAt = @cf, UpdatedAt = SYSDATETIME()
          WHERE VisitId = @vid;
        `);
      // Try to match BN_VisitPlan
      await matchVisitPlan(pool, userId, v.VisitId, f, ping).catch(err =>
        console.error('[visitDetector] matchVisitPlan failed:', err.message)
      );
    }
  }
}

// ── Match confirmed visit to BN_VisitPlan ──────────────────────────────────
async function matchVisitPlan(pool, userId, visitId, fence, ping) {
  // Get user info for SalespersonCode + Company
  const uRes = await pool.request()
    .input('uid', sql.Int, userId)
    .query(`SELECT Name, CompanyACode, CompanyBCode FROM [dbo].[User_Login] WHERE Id = @uid;`);
  if (uRes.recordset.length === 0) return;
  const user = uRes.recordset[0];

  // Determine which company codes to scan against (use the fence's company if set)
  const company = fence.Company || (user.CompanyACode ? 'COMPANYA' : 'CompanyB');
  const codeList = ((company === 'COMPANYA' ? user.CompanyACode : user.CompanyBCode) || '')
    .split('/').map(s => s.trim()).filter(Boolean);
  if (codeList.length === 0) return;

  // Find a matching BN_VisitPlan row for today
  const today = new Date(ping.PingTime).toISOString().slice(0, 10);
  const r = pool.request()
    .input('co',   sql.NVarChar(10), company)
    .input('dt',   sql.Date,         today)
    .input('cc',   sql.NVarChar(50), fence.CustomerCode)
    .input('name', sql.NVarChar(200), fence.Name);
  codeList.forEach((c, i) => r.input('sp' + i, sql.NVarChar(50), c));
  const spList = codeList.map((_, i) => '@sp' + i).join(',');
  const matchRes = await r.query(`
    SELECT TOP 1 Id, CustomerName, VisitDone
    FROM [dbo].[BN_VisitPlan]
    WHERE Company = @co
      AND VisitDate = @dt
      AND SalespersonCode IN (${spList})
      AND (
        (CustomerCode IS NOT NULL AND CustomerCode = @cc)
        OR LTRIM(RTRIM(CustomerName)) COLLATE SQL_Latin1_General_CP1_CI_AS = LTRIM(RTRIM(@name)) COLLATE SQL_Latin1_General_CP1_CI_AS
      )
    ORDER BY Id;
  `);

  // Get the open visit's EntryPingId, ExitPingId for stamping
  const vRes = await pool.request()
    .input('vid', sql.Int, visitId)
    .query(`SELECT EntryPingId, ExitPingId FROM [dbo].[HRM_Visit] WHERE VisitId = @vid;`);
  const visit = vRes.recordset[0] || {};

  if (matchRes.recordset.length > 0) {
    // Mark planned visit as done
    const planRow = matchRes.recordset[0];
    await pool.request()
      .input('id',   sql.Int,        planRow.Id)
      .input('vid',  sql.Int,        visitId)
      .input('cf',   sql.DateTime2,  ping.PingTime)
      .input('ep',   sql.BigInt,     visit.EntryPingId || null)
      .input('xp',   sql.BigInt,     visit.ExitPingId  || null)
      .input('cc',   sql.NVarChar(50), fence.CustomerCode || null)
      .query(`
        UPDATE [dbo].[BN_VisitPlan]
        SET VisitDone        = 1,
            AutoConfirmedAt  = @cf,
            EntryPingId      = @ep,
            ExitPingId       = @xp,
            CustomerCode     = ISNULL(CustomerCode, @cc),
            UpdatedAt        = GETDATE()
        WHERE Id = @id;
      `);
    // Link the visit back to the plan
    await pool.request()
      .input('vid', sql.Int, visitId)
      .input('pid', sql.Int, planRow.Id)
      .query(`
        UPDATE [dbo].[HRM_Visit] SET VisitPlanId = @pid, UpdatedAt = SYSDATETIME() WHERE VisitId = @vid;
      `);
  }
  // NO planned visit for this customer → DO NOTHING (product decision 2026-07-06).
  //
  // Auto-detection now only marks DONE the customers a rep actually planned/imported
  // into their Visit Plan. It must NOT auto-create "visits" for whatever geofence the
  // rep happened to dwell near — that pulled in OTHER verticals' customers (a COMPANYA
  // salesperson driving through the Electrical Beat Plan's retail-shop geofences got
  // dozens of phantom "Visit Done" rows on their plan). Unplanned / walk-in visits are
  // captured by the rep tapping Visit Punch In/Out, not by the geofence engine.
  //
  // The confirmed HRM_Visit row still stands as geo-tracking (Live Map / time-on-site);
  // it simply won't create or touch a Visit Plan row unless the customer was planned.
}

// ── D. Detect unknown stops (stationary ≥15 min outside any geofence) ──────
async function detectUnknownStop(pool, userId, userCode, company, ping) {
  // Already inside an open unknown-stop visit?
  const open = await pool.request()
    .input('uid', sql.Int, userId)
    .query(`
      SELECT TOP 1 VisitId FROM [dbo].[HRM_Visit]
      WHERE UserId = @uid AND GeofenceId IS NULL AND ExitTime IS NULL
      ORDER BY VisitId DESC;
    `);
  if (open.recordset.length > 0) return;     // already tracking one

  // Look back at recent pings to detect ≥15 min stationary cluster
  const lookback = await pool.request()
    .input('uid', sql.Int, userId)
    .query(`
      SELECT TOP 50 PingId, PingTime, Lat, Lng
      FROM [dbo].[HRM_LocationPing]
      WHERE UserId = @uid
        AND PingTime >= DATEADD(minute, -30, SYSDATETIME())
      ORDER BY PingTime DESC;
    `);
  const recent = (lookback.recordset || []).slice().reverse();   // chronological
  if (recent.length < 2) return;

  // Find earliest ping within UNKNOWN_CLUSTER_M of current ping
  const curLat = Number(ping.Lat), curLng = Number(ping.Lng);
  let earliest = null;
  for (const p of recent) {
    const d = haversineM(curLat, curLng, Number(p.Lat), Number(p.Lng));
    if (d <= UNKNOWN_CLUSTER_M) {
      if (!earliest) earliest = p;
    } else {
      earliest = null;   // gap → restart
    }
  }
  if (!earliest) return;

  const dwellMin = (new Date(ping.PingTime) - new Date(earliest.PingTime)) / 60000;
  if (dwellMin < UNKNOWN_DWELL_MIN) return;

  // Insert unknown-stop HRM_Visit row anchored to the earliest cluster ping
  await pool.request()
    .input('uid',  sql.Int,           userId)
    .input('uc',   sql.NVarChar(50),  userCode)
    .input('co',   sql.NVarChar(10),  company)
    .input('dept', sql.NVarChar(10),  inferDept(company, userCode))
    .input('et',   sql.DateTime2,     earliest.PingTime)
    .input('ep',   sql.BigInt,        earliest.PingId)
    .input('lat',  sql.Decimal(9, 6), earliest.Lat)
    .input('lng',  sql.Decimal(9, 6), earliest.Lng)
    .query(`
      INSERT INTO [dbo].[HRM_Visit]
        (UserId, UserCode, Company, Department,
         EntryTime, EntryPingId, Lat, Lng)
      VALUES
        (@uid, @uc, @co, @dept, @et, @ep, @lat, @lng);
    `);
}

// ── Main entry ─────────────────────────────────────────────────────────────
async function processPing(userCtx, ping) {
  // userCtx = { id, companyaCode, companybCode } from JWT
  // ping    = { PingId, PingTime, Lat, Lng, ... }
  try {
    const pool   = await getAppPool();
    const fences = await getActiveGeofences(pool);
    const allInside = fences.filter(f => isInsideFence(ping.Lat, ping.Lng, f));

    // Electrical beat-plan scoping: a non-beat user must not be attributed to the
    // electrical vertical's retail-shop geofences (601/666 of the library). Drop those
    // from consideration so they can't be opened/confirmed/kept for this user; the beat
    // reps themselves see the full library. (closeExitedVisits also uses the scoped set,
    // so any pre-existing beat visit wrongly open on a non-beat user gets closed out.)
    const beat   = await getBeatContext(pool);
    const inside = isBeatRep(userCtx, beat)
      ? allInside
      : allInside.filter(f => !beat.beatGeoIds.has(f.GeofenceId));
    const insideIds = new Set(inside.map(f => f.GeofenceId));
    const userCode  = ((userCtx.companyaCode || userCtx.companybCode || '').split('/')[0] || '').trim();
    const company   = userCtx.companyaCode ? 'COMPANYA' : (userCtx.companybCode ? 'CompanyB' : null);

    // Office guard: if the ping is inside an OFFICE geofence (Kind='office'), the person
    // is at the office — NOT visiting a customer. Do not open/confirm any visit. This
    // stops the "everyone at the office shows a customer as their last visit" bug — the
    // COMPANYA office has ~24 customer geofences (Sharp Electronics, mis-geocoded beat shops)
    // piled on top of it, and openNewVisits would otherwise match the nearest one.
    const atOffice = allInside.some(f => (f.Kind || '').toLowerCase() === 'office');

    // A. Close visits the user has exited
    await closeExitedVisits(pool, userCtx.id, ping, insideIds);
    if (!atOffice) {
      // C. Open new visits the user has entered
      await openNewVisits(pool, userCtx.id, userCode, company, ping, inside);
      // B. Confirm visits whose dwell has reached threshold
      await confirmDwelledVisits(pool, userCtx.id, ping, inside);
    }
    // D. If not inside any (in-scope) geofence AND not at the office, look for a stop
    if (inside.length === 0 && !atOffice) {
      await detectUnknownStop(pool, userCtx.id, userCode, company, ping);
    }
  } catch (err) {
    console.error('[visitDetector] processPing failed:', err.message);
  }
}

module.exports = { processPing, invalidateGeofenceCache };
