// ============================================================================
// modules/hr/services/anomalyDetector.js — anomaly engine (Phase 2.6)
//
// Runs alongside visitDetector on every ping. Detects "looks off" patterns
// and writes them to HRM_Anomaly so HR sees them in the review queue.
//
// Slice A (this file): focuses on OFFICE_EXIT — the most common honor-system
// loophole ("signed in at office, then left without signing out").
//
// Other anomaly kinds (stale_session, no_show, prolonged_absence) will move
// to a periodic cron in slice B since they need a time-based scan, not a
// per-ping check.
//
// Rules for office_exit (slice A):
//   1. User has HRM_Employee.OfficeId assigned
//   2. User has an OPEN HRM_Attendance row (signed in, not signed out)
//   3. Latest ping is OUTSIDE the office geofence, with the configured grace
//   4. 3+ consecutive recent pings (~last few minutes) are also outside
//   5. NOT already inside another active geofence (i.e. not visiting a customer)
//   6. No open office_exit anomaly already exists for this attendance session
//
// Dedup: detector checks for existing open anomaly on the same (UserId, AttId,
// Kind) before inserting — so one session can't generate many copies.
// ============================================================================

const { sql, getAppPool } = require('../../../db');

const OFFICE_GRACE_M     = 100;   // metres outside fence before considered "out"
const CONSECUTIVE_OUTSIDE = 3;    // need this many consecutive outside pings
const EMP_CACHE_MS        = 5 * 60 * 1000;
const FENCE_CACHE_MS      = 5 * 60 * 1000;

let _empCache    = new Map();    // userId -> { fetchedAt, row }
let _fenceCache  = new Map();    // geofenceId -> { fetchedAt, row }
let _allFences   = null;
let _allFencesAt = 0;

function invalidateCaches() {
  _empCache = new Map();
  _fenceCache = new Map();
  _allFences = null;
  _allFencesAt = 0;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (Number(x) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function getEmployee(pool, userId) {
  const cached = _empCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < EMP_CACHE_MS) return cached.row;
  const r = await pool.request()
    .input('uid', sql.Int, userId)
    .query(`SELECT EmpId, UserId, OfficeId FROM [dbo].[HRM_Employee] WHERE UserId = @uid;`);
  const row = r.recordset[0] || null;
  _empCache.set(userId, { fetchedAt: Date.now(), row });
  return row;
}

async function getFence(pool, geofenceId) {
  if (!geofenceId) return null;
  const cached = _fenceCache.get(geofenceId);
  if (cached && Date.now() - cached.fetchedAt < FENCE_CACHE_MS) return cached.row;
  const r = await pool.request()
    .input('id', sql.Int, geofenceId)
    .query(`
      SELECT GeofenceId, Name, Kind, CustomerCode, Company,
             CenterLat, CenterLng, RadiusM, DwellMinForVisit, IsActive
      FROM [dbo].[HRM_Geofence] WHERE GeofenceId = @id;
    `);
  const row = r.recordset[0] || null;
  _fenceCache.set(geofenceId, { fetchedAt: Date.now(), row });
  return row;
}

async function getAllActiveFences(pool) {
  if (_allFences && Date.now() - _allFencesAt < FENCE_CACHE_MS) return _allFences;
  const r = await pool.request().query(`
    SELECT GeofenceId, Name, Kind, CenterLat, CenterLng, RadiusM
    FROM [dbo].[HRM_Geofence] WHERE IsActive = 1;
  `);
  _allFences = r.recordset;
  _allFencesAt = Date.now();
  return _allFences;
}

async function getOpenAttendance(pool, userId) {
  const today = todayISO();
  const r = await pool.request()
    .input('uid', sql.Int, userId)
    .input('dt',  sql.Date, today)
    .query(`
      SELECT TOP 1 AttId, Session, SignInTime
      FROM [dbo].[HRM_Attendance]
      WHERE UserId = @uid AND AttDate = @dt AND SignOutTime IS NULL
      ORDER BY Session DESC;
    `);
  return r.recordset[0] || null;
}

async function getRecentPings(pool, userId, n) {
  const r = await pool.request()
    .input('uid', sql.Int, userId)
    .input('n',   sql.Int, n)
    .query(`
      SELECT TOP (@n) PingId, PingTime, Lat, Lng
      FROM [dbo].[HRM_LocationPing]
      WHERE UserId = @uid
      ORDER BY PingTime DESC;
    `);
  return r.recordset || [];
}

async function hasOpenAnomaly(pool, userId, attId, kind) {
  const r = await pool.request()
    .input('uid',  sql.Int,         userId)
    .input('att',  sql.BigInt,      attId)
    .input('kind', sql.NVarChar(30), kind)
    .query(`
      SELECT TOP 1 AnomalyId FROM [dbo].[HRM_Anomaly]
      WHERE UserId = @uid AND AttId = @att AND Kind = @kind AND IsResolved = 0;
    `);
  return r.recordset.length > 0;
}

async function insertAnomaly(pool, payload) {
  const r = pool.request();
  r.input('uid',     sql.Int,           payload.userId);
  r.input('uc',      sql.NVarChar(50),  payload.userCode || null);
  r.input('co',      sql.NVarChar(10),  payload.company  || null);
  r.input('kind',    sql.NVarChar(30),  payload.kind);
  r.input('sev',     sql.NVarChar(10),  payload.severity || 'warning');
  r.input('att',     sql.BigInt,        payload.attId || null);
  r.input('fence',   sql.Int,           payload.officeGeofenceId || null);
  r.input('ping',    sql.BigInt,        payload.triggerPingId || null);
  r.input('title',   sql.NVarChar(200), payload.title);
  r.input('detail',  sql.NVarChar(sql.MAX), payload.detail || null);
  r.input('lat',     sql.Decimal(9, 6), payload.lat != null ? Number(payload.lat) : null);
  r.input('lng',     sql.Decimal(9, 6), payload.lng != null ? Number(payload.lng) : null);
  await r.query(`
    INSERT INTO [dbo].[HRM_Anomaly]
      (UserId, UserCode, Company, Kind, Severity,
       AttId, OfficeGeofenceId, TriggerPingId, Title, Detail, LastSeenLat, LastSeenLng)
    VALUES
      (@uid, @uc, @co, @kind, @sev,
       @att, @fence, @ping, @title, @detail, @lat, @lng);
  `);
  console.log(`[anomalyDetector] ${payload.kind} for user ${payload.userId}: ${payload.title}`);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Main entry ─────────────────────────────────────────────────────────────
async function processPing(userCtx, ping) {
  try {
    const pool = await getAppPool();

    const emp = await getEmployee(pool, userCtx.id);
    if (!emp || !emp.OfficeId) return;     // employee not assigned to an office

    const office = await getFence(pool, emp.OfficeId);
    if (!office || !office.IsActive) return;

    // Is the current ping inside the office (with grace)?
    const distOffice = haversineM(office.CenterLat, office.CenterLng, ping.Lat, ping.Lng);
    if (distOffice <= (office.RadiusM + OFFICE_GRACE_M)) return;   // still in office

    // Confirm with consecutive outside pings (avoid GPS-drift false positives)
    const recent = await getRecentPings(pool, userCtx.id, CONSECUTIVE_OUTSIDE);
    if (recent.length < CONSECUTIVE_OUTSIDE) return;
    const allOutside = recent.every(p => haversineM(office.CenterLat, office.CenterLng, p.Lat, p.Lng) > (office.RadiusM + OFFICE_GRACE_M));
    if (!allOutside) return;

    // Are we inside ANY other active geofence (customer / warehouse / site)?
    // If yes, this is a legitimate field visit, not an unauthorized exit.
    const fences = await getAllActiveFences(pool);
    const insideOther = fences.some(f => {
      if (f.GeofenceId === office.GeofenceId) return false;
      return haversineM(f.CenterLat, f.CenterLng, ping.Lat, ping.Lng) <= f.RadiusM;
    });
    if (insideOther) return;

    // Need an OPEN attendance session — anomaly only matters during work
    const open = await getOpenAttendance(pool, userCtx.id);
    if (!open) return;

    // Dedupe — already raised for this session?
    if (await hasOpenAnomaly(pool, userCtx.id, open.AttId, 'office_exit')) return;

    const userCode = ((userCtx.companyaCode || userCtx.companybCode || '').split('/')[0] || '').trim();
    const company  = userCtx.companyaCode ? 'COMPANYA' : (userCtx.companybCode ? 'CompanyB' : null);

    await insertAnomaly(pool, {
      userId:           userCtx.id,
      userCode,
      company,
      kind:             'office_exit',
      severity:         'warning',
      attId:            open.AttId,
      officeGeofenceId: office.GeofenceId,
      triggerPingId:    ping.PingId,
      title:            `Left ${office.Name} during work hours`,
      detail:           `Currently ${Math.round(distOffice)}m away from the assigned office. No active customer visit detected. Sign-in at ${new Date(open.SignInTime).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12: true })}, still showing OPEN.`,
      lat:              ping.Lat,
      lng:              ping.Lng,
    });
  } catch (err) {
    console.error('[anomalyDetector] processPing failed:', err.message);
  }
}

module.exports = { processPing, invalidateCaches };
