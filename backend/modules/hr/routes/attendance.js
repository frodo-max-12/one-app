// =====================================================================
// modules/hr/routes/attendance.js — Sign-In / Sign-Out flow
//
// Mounted at /api/hr/attendance/* by ../index.js.
// Endpoints:
//   POST /sign-in   — record sign-in with GPS + selfie + remarks
//   POST /sign-out  — record sign-out; computes TotalWorkMin
//   GET  /today     — current user's attendance state for today
//   GET  /summary   — last 14 days summary + exception count
// =====================================================================

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');

// metres between two lat/lng points (for the office / WFH flag)
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── selfie storage ──────────────────────────────────────────────────────────
const SELFIE_ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'hr', 'selfies');
try { fs.mkdirSync(SELFIE_ROOT, { recursive: true }); } catch (_) {}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function pickCompany(user) {
  if (user.companyaCode && user.companyaCode.trim())       return 'COMPANYA';
  if (user.companybCode && user.companybCode.trim()) return 'CompanyB';
  return null;
}
function pickUserCode(user) {
  if (user.companyaCode && user.companyaCode.trim())       return user.companyaCode.split('/')[0].trim();
  if (user.companybCode && user.companybCode.trim()) return user.companybCode.split('/')[0].trim();
  return null;
}

// Save base64 data URI as a JPEG file. Returns relative URL ('/uploads/...').
function saveSelfie(userId, kind, dataUri) {
  if (!dataUri || typeof dataUri !== 'string') return null;
  const m = dataUri.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return null;  // hard cap 5 MB
  const userDir = path.join(SELFIE_ROOT, String(userId));
  try { fs.mkdirSync(userDir, { recursive: true }); } catch (_) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file  = `${todayISO()}_${kind}_${stamp}.${ext}`;
  const full  = path.join(userDir, file);
  fs.writeFileSync(full, buf);
  return `/uploads/hr/selfies/${userId}/${file}`;
}

// Insert a HRM_LocationPing for this sign-in/out event and return the PingId.
async function insertSignPing(pool, user, body, source) {
  // Accuracy is DECIMAL(6,2) on HRM_LocationPing (max 9999.99 m). A desktop / WFH
  // browser without GPS can report 10000+ m, which overflowed the column and crashed
  // sign-in with "scale greater than precision". Clamp to the column max. (Fixed 2026-06-30.)
  const rawAcc  = body && body.accuracy != null ? Number(body.accuracy) : null;
  const safeAcc = (rawAcc != null && Number.isFinite(rawAcc) && rawAcc >= 0) ? Math.min(rawAcc, 9999.99) : null;
  const r = pool.request();
  r.input('userId',     sql.Int,           user.id);
  r.input('userCode',   sql.NVarChar(50),  pickUserCode(user));
  r.input('company',    sql.NVarChar(10),  pickCompany(user));
  r.input('pingTime',   sql.DateTime2,     new Date());
  r.input('lat',        sql.Decimal(9, 6), Number(body.lat));
  r.input('lng',        sql.Decimal(9, 6), Number(body.lng));
  r.input('accuracy',   sql.Decimal(6, 2), safeAcc);
  r.input('batteryPct', sql.TinyInt,       body.batteryPct != null ? Number(body.batteryPct) : null);
  r.input('isMocked',   sql.Bit,           body.isMocked ? 1 : 0);
  r.input('source',     sql.NVarChar(20),  source);
  const out = await r.query(`
    INSERT INTO [dbo].[HRM_LocationPing]
      (UserId, UserCode, Company, PingTime, Lat, Lng, Accuracy, BatteryPct, IsMocked, IsOnline, Source)
    OUTPUT INSERTED.PingId
    VALUES
      (@userId, @userCode, @company, @pingTime, @lat, @lng, @accuracy, @batteryPct, @isMocked, 1, @source);
  `);
  return out.recordset[0].PingId;
}

// ── POST /sign-in ───────────────────────────────────────────────────────────
// Allows MULTIPLE sessions per day (lunch break / split shift / retest):
//   - If there's an open session (sign-in without sign-out) → 409, must sign out first.
//   - Otherwise insert a NEW row with Session = MAX(Session) + 1.
router.post('/sign-in', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number') {
      return res.status(400).json({ message: 'lat and lng are required (number)' });
    }
    const pool    = await getAppPool();
    const today   = todayISO();

    // 1. Block if there's an OPEN session (need to sign out first)
    const openCheck = await pool.request()
      .input('userId', sql.Int,  req.user.id)
      .input('date',   sql.Date, today)
      .query(`
        SELECT TOP 1 AttId, Session, SignInTime
        FROM [dbo].[HRM_Attendance]
        WHERE UserId = @userId AND AttDate = @date AND SignOutTime IS NULL
        ORDER BY Session DESC;
      `);
    if (openCheck.recordset[0]) {
      return res.status(409).json({
        message: 'You are already signed in — please sign out first',
        attId:   openCheck.recordset[0].AttId,
        session: openCheck.recordset[0].Session,
        signInTime: openCheck.recordset[0].SignInTime,
      });
    }

    // 2. Find next session number for today
    const maxQ = await pool.request()
      .input('userId', sql.Int,  req.user.id)
      .input('date',   sql.Date, today)
      .query(`
        SELECT ISNULL(MAX(Session), 0) AS MaxSession
        FROM [dbo].[HRM_Attendance]
        WHERE UserId = @userId AND AttDate = @date;
      `);
    const nextSession = (maxQ.recordset[0].MaxSession || 0) + 1;

    // 3. Record the sign-in ping
    const pingId    = await insertSignPing(pool, req.user, b, 'signin');
    const selfieUrl = saveSelfie(req.user.id, 'in', b.selfieData);

    // 4. Insert HRM_Attendance row
    // ExpectedSignOutTime = SignInTime + 8h 30m (8h work + 30 min lunch). Rule confirmed
    // with admin 2026-05-25 — examples: 10:00 → 18:30, 10:30 → 19:00.
    const signInTime         = new Date();
    const expectedSignOutTime = new Date(signInTime.getTime() + (8 * 60 + 30) * 60_000);
    // LateSignIn: any sign-in after 10:30 AM crosses the grace cutoff.
    const lateCutoff = new Date(signInTime); lateCutoff.setHours(10, 30, 0, 0);
    const lateSignIn = signInTime > lateCutoff ? 1 : 0;

    const r = pool.request();
    r.input('userId',     sql.Int,           req.user.id);
    r.input('userCode',   sql.NVarChar(50),  pickUserCode(req.user));
    r.input('company',    sql.NVarChar(10),  pickCompany(req.user));
    r.input('attDate',    sql.Date,          today);
    r.input('session',    sql.TinyInt,       nextSession);
    r.input('signInTime', sql.DateTime2,     signInTime);
    r.input('expSignOut', sql.DateTime2,     expectedSignOutTime);
    r.input('lateSignIn', sql.Bit,           lateSignIn);
    r.input('pingId',     sql.BigInt,        pingId);
    r.input('lat',        sql.Decimal(9, 6), Number(b.lat));
    r.input('lng',        sql.Decimal(9, 6), Number(b.lng));
    r.input('remarks',    sql.NVarChar(200), (b.remarks || '').slice(0, 200));
    r.input('selfieUrl',  sql.NVarChar(500), selfieUrl);
    r.input('faceScore',  sql.Decimal(5, 4), b.faceScore != null ? Number(b.faceScore) : null);
    r.input('shiftCode',  sql.NVarChar(20),  b.shiftCode || '09:45-18:15');
    const out = await r.query(`
      INSERT INTO [dbo].[HRM_Attendance]
        (UserId, UserCode, Company, AttDate, Session, Status,
         SignInTime, SignInPingId, SignInLat, SignInLng, SignInRemarks, SignInSelfieUrl, SignInFaceScore,
         ExpectedSignOutTime, LateSignIn, ShiftCode)
      OUTPUT INSERTED.AttId, INSERTED.SignInTime, INSERTED.ExpectedSignOutTime, INSERTED.Session
      VALUES
        (@userId, @userCode, @company, @attDate, @session, 'P',
         @signInTime, @pingId, @lat, @lng, @remarks, @selfieUrl, @faceScore,
         @expSignOut, @lateSignIn, @shiftCode);
    `);

    return res.status(201).json({
      ok: true,
      attId:               out.recordset[0].AttId,
      session:             out.recordset[0].Session,
      signInTime:          out.recordset[0].SignInTime,
      expectedSignOutTime: out.recordset[0].ExpectedSignOutTime,
      lateSignIn:          !!lateSignIn,
      pingId,
      selfieUrl,
    });
  } catch (err) {
    console.error('[/api/hr/attendance/sign-in] failed:', err.message);
    return res.status(500).json({ message: 'Sign-in failed', detail: err.message });
  }
});

// ── POST /sign-out ──────────────────────────────────────────────────────────
// Location is PREFERRED but optional on sign-out (unlike sign-in). Reason: by
// end of day the employee may be in a basement / underground parking / poor
// GPS area, and forcing them to wait or stay outdoors just to clock out is
// hostile UX. We still record whatever location we do get.
router.post('/sign-out', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    const hasLoc = (typeof b.lat === 'number' && typeof b.lng === 'number');
    const pool  = await getAppPool();
    const today = todayISO();

    // Find today's latest OPEN session (any session number)
    const open = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('date',   sql.Date, today)
      .query(`
        SELECT TOP 1 AttId, SignInTime, ExpectedSignOutTime,
                     LunchOutTime, LunchInTime, LateSignIn, LateLunchReturn
        FROM [dbo].[HRM_Attendance]
        WHERE UserId = @userId AND AttDate = @date AND SignOutTime IS NULL
        ORDER BY Session DESC, AttId DESC;
      `);
    if (open.recordset.length === 0) {
      return res.status(409).json({ message: 'No open sign-in found for today' });
    }
    const row = open.recordset[0];
    const { AttId, SignInTime } = row;

    // Insert a sign-out ping only if we have a location — otherwise just
    // close the attendance row without a fake (0,0) coordinate.
    const pingId    = hasLoc ? await insertSignPing(pool, req.user, b, 'signout') : null;
    const selfieUrl = saveSelfie(req.user.id, 'out', b.selfieData);
    const now       = new Date();
    const totalMin  = Math.max(0, Math.floor((now - new Date(SignInTime)) / 60000));
    // ShortDay = signing out more than 10 min before expected sign-out
    let shortDay = null;
    if (row.ExpectedSignOutTime) {
      const exp = new Date(row.ExpectedSignOutTime);
      shortDay = (now < new Date(exp.getTime() - 10 * 60_000)) ? 1 : 0;
    }
    const flags = [];
    if (row.LateSignIn)       flags.push('late_signin');
    if (row.LateLunchReturn)  flags.push('late_lunch');
    if (shortDay === 1)       flags.push('short_day');
    if (!row.LunchOutTime)    flags.push('no_lunch');

    const r = pool.request();
    r.input('attId',         sql.BigInt,        AttId);
    r.input('signOutTime',   sql.DateTime2,     now);
    r.input('pingId',        sql.BigInt,        pingId);
    r.input('lat',           sql.Decimal(9, 6), hasLoc ? Number(b.lat) : null);
    r.input('lng',           sql.Decimal(9, 6), hasLoc ? Number(b.lng) : null);
    r.input('remarks',       sql.NVarChar(200), (b.remarks || '').slice(0, 200));
    r.input('selfieUrl',     sql.NVarChar(500), selfieUrl);
    r.input('totalMin',      sql.Int,           totalMin);
    r.input('distanceKm',    sql.Decimal(8, 2), b.distanceKm != null ? Number(b.distanceKm) : null);
    r.input('shortDay',      sql.Bit,           shortDay);
    r.input('flags',         sql.NVarChar(200), flags.join(',') || null);
    await r.query(`
      UPDATE [dbo].[HRM_Attendance] SET
        SignOutTime      = @signOutTime,
        SignOutPingId    = @pingId,
        SignOutLat       = @lat,
        SignOutLng       = @lng,
        SignOutRemarks   = @remarks,
        SignOutSelfieUrl = @selfieUrl,
        TotalWorkMin     = @totalMin,
        DistanceKm       = @distanceKm,
        ShortDay         = @shortDay,
        AutoSignOut      = 0,
        ComplianceFlags  = @flags,
        UpdatedAt        = SYSDATETIME()
      WHERE AttId = @attId;
    `);

    return res.json({
      ok: true,
      attId:        AttId,
      signOutTime:  now,
      totalWorkMin: totalMin,
      pingId,
      selfieUrl,
    });
  } catch (err) {
    console.error('[/api/hr/attendance/sign-out] failed:', err.message);
    return res.status(500).json({ message: 'Sign-out failed', detail: err.message });
  }
});

// ── GET /today ──────────────────────────────────────────────────────────────
// Returns: { today: latestSession, sessions: [allTodaysSessions] }
router.get('/today', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = await pool.request()
      .input('userId', sql.Int,  req.user.id)
      .input('date',   sql.Date, todayISO())
      .query(`
        SELECT AttId, AttDate, Session, Status, SignInTime, SignOutTime, TotalWorkMin, ShiftCode,
               SignInLat, SignInLng, SignInRemarks, SignInSelfieUrl,
               SignOutLat, SignOutLng, SignOutRemarks, SignOutSelfieUrl,
               ExpectedSignOutTime,
               LunchOutTime, LunchOutLat, LunchOutLng,
               LunchInTime,  LunchInLat,  LunchInLng,
               LunchDurationMin,
               LateSignIn, LateLunchReturn, ShortDay, AutoSignOut, ComplianceFlags
        FROM [dbo].[HRM_Attendance]
        WHERE UserId = @userId AND AttDate = @date
        ORDER BY Session;
      `);
    const sessions = r.recordset || [];
    const latest = sessions.length ? sessions[sessions.length - 1] : null;
    return res.json({ ok: true, today: latest, sessions });
  } catch (err) {
    console.error('[/api/hr/attendance/today] failed:', err.message);
    return res.status(500).json({ message: 'Fetch failed', detail: err.message });
  }
});

// ── GET /log ────────────────────────────────────────────────────────────────
// Recent attendance entries with full location detail for "My Attendance" page.
// Query params: days (default 7, max 30), userId (admin/head only — defaults to self)
router.get('/log', authenticate, async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 7));
    // For now: only own log. Admin/team filter comes in Phase 2 (Lens admin view).
    const targetUserId = req.user.id;

    const pool = await getAppPool();
    const r = await pool.request()
      .input('userId', sql.Int, targetUserId)
      .input('days',   sql.Int, days)
      .query(`
        SELECT
          A.AttId, A.AttDate, A.Session, A.Status, A.ShiftCode,
          A.SignInTime,   A.SignInLat,   A.SignInLng,   A.SignInRemarks,   A.SignInSelfieUrl,
          A.SignOutTime,  A.SignOutLat,  A.SignOutLng,  A.SignOutRemarks,  A.SignOutSelfieUrl,
          A.TotalWorkMin, A.DistanceKm,
          UL.Name AS UserName,
          UL.CompanyACode AS CompanyACode
        FROM [dbo].[HRM_Attendance] A
        INNER JOIN [dbo].[User_Login] UL ON UL.Id = A.UserId
        WHERE A.UserId = @userId
          AND A.AttDate >= DATEADD(day, -@days, CAST(GETDATE() AS DATE))
        ORDER BY A.AttDate DESC, A.Session DESC;
      `);
    return res.json({ ok: true, rows: r.recordset, days });
  } catch (err) {
    console.error('[/api/hr/attendance/log] failed:', err.message);
    return res.status(500).json({ message: 'Log fetch failed', detail: err.message });
  }
});

// ── GET /sign-locations ──────────────────────────────────────────────────────
// HR/heads view: WHERE each employee signed in & out on a given day (incl. WFH).
// Scope: Lens-admin (admin/op-head/director/HR) → everyone; a head → own team
// (by CompanyACode/CompanyBCode); anyone else → only their own rows.
// Office vs WFH is derived live from HRM_Geofence (Kind='office').
router.get('/sign-locations', authenticate, async (req, res) => {
  try {
    const date    = (req.query.date || todayISO()).trim();
    const company = (req.query.company || '').trim().toUpperCase();
    const q       = (req.query.q || '').trim();

    const pool = await getAppPool();
    const r = pool.request();
    const where = ['A.AttDate = @date', 'A.Session IS NOT NULL'];
    r.input('date', sql.Date, date);

    if (!isLensAdmin(req.user)) {
      const codes = ((req.user.companyaCode || '') + '/' + (req.user.companybCode || '')).split('/').map(s => s.trim()).filter(Boolean);
      if (codes.length) {
        codes.forEach((c, i) => r.input('c' + i, sql.NVarChar(50), c));
        where.push(`A.UserCode IN (${codes.map((_, i) => '@c' + i).join(',')})`);
      } else {
        where.push('A.UserId = @selfId'); r.input('selfId', sql.Int, req.user.id);
      }
    }
    if (company === 'COMPANYA' || company === 'COMPANYB') {
      // Codeless roles (FAE / HR / admin / product) sign in with NO company on the
      // attendance row, so a strict `Company = @co` silently drops them — that's why
      // an admin saw only the few sales-coded people, not everyone who signed in.
      // Include NULL/empty-company rows so every signed-in employee shows.
      where.push("(A.Company = @co OR ISNULL(A.Company,'') = '')");
      r.input('co', sql.NVarChar(10), company === 'COMPANYB' ? 'CompanyB' : 'COMPANYA');
    }
    if (q) {
      where.push("(ISNULL(UL.Name,'') LIKE @q OR ISNULL(A.UserCode,'') LIKE @q)");
      r.input('q', sql.NVarChar(120), '%' + q + '%');
    }

    const rows = (await r.query(`
      SELECT
        A.AttId, A.UserId, A.UserCode, A.Company, CONVERT(VARCHAR(10), A.AttDate, 23) AS AttDate, A.Session, A.Status,
        A.SignInTime,  A.SignInLat,  A.SignInLng,  A.SignInSelfieUrl,
        A.SignOutTime, A.SignOutLat, A.SignOutLng, A.SignOutSelfieUrl, A.TotalWorkMin,
        ISNULL(UL.Name, A.UserCode) AS UserName, UL.Role AS UserRole
      FROM [dbo].[HRM_Attendance] A
      LEFT JOIN [dbo].[User_Login] UL ON UL.Id = A.UserId
      WHERE ${where.join(' AND ')}
      ORDER BY UserName, A.Session;
    `)).recordset;

    let fences = [];
    try {
      fences = (await pool.request().query(
        "SELECT Name, Kind, CenterLat, CenterLng, RadiusM FROM [dbo].[HRM_Geofence] WHERE ISNULL(IsActive,1)=1 AND CenterLat IS NOT NULL"
      )).recordset;
    } catch (_) { /* geofence table absent -> everything reads as 'outside office' */ }
    const offices = fences.filter(f => /office/i.test(f.Kind || ''));

    function place(lat, lng) {
      if (lat == null || lng == null) return { label: '—', wfh: false };
      lat = Number(lat); lng = Number(lng);
      for (const f of offices) if (haversineM(lat, lng, Number(f.CenterLat), Number(f.CenterLng)) <= (f.RadiusM || 100)) return { label: 'Office: ' + f.Name, wfh: false };
      for (const f of fences) if (!/office/i.test(f.Kind || '') && haversineM(lat, lng, Number(f.CenterLat), Number(f.CenterLng)) <= (f.RadiusM || 100)) return { label: f.Name || 'On-site', wfh: false };
      return { label: 'Outside office (WFH/field)', wfh: true };
    }

    const data = rows.map(x => {
      const si = place(x.SignInLat, x.SignInLng);
      const so = place(x.SignOutLat, x.SignOutLng);
      return {
        ...x,
        SignInPlace:  si.label, SignInWfh:  si.wfh,
        SignOutPlace: x.SignOutTime ? so.label : null, SignOutWfh: x.SignOutTime ? so.wfh : false,
      };
    });

    return res.json({
      ok: true, date, total: data.length,
      wfhCount: data.filter(d => d.SignInWfh).length,
      data,
    });
  } catch (err) {
    console.error('[/api/hr/attendance/sign-locations] failed:', err.message);
    return res.status(500).json({ message: 'Sign-locations fetch failed', detail: err.message });
  }
});

// ── GET /summary ────────────────────────────────────────────────────────────
// last 30 days: counts P/A/L/H/HD/WO + total work hours + exception list
router.get('/summary', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .query(`
        SELECT
          SUM(CASE WHEN Status='P'  THEN 1 ELSE 0 END) AS Present,
          SUM(CASE WHEN Status='A'  THEN 1 ELSE 0 END) AS Absent,
          SUM(CASE WHEN Status='L'  THEN 1 ELSE 0 END) AS OnLeave,
          SUM(CASE WHEN Status='H'  THEN 1 ELSE 0 END) AS Holiday,
          SUM(CASE WHEN Status='HD' THEN 1 ELSE 0 END) AS HalfDay,
          SUM(CASE WHEN Status='WO' THEN 1 ELSE 0 END) AS WeeklyOff,
          ISNULL(SUM(TotalWorkMin), 0) AS TotalWorkMin
        FROM [dbo].[HRM_Attendance]
        WHERE UserId = @userId
          AND Session = 1
          AND AttDate >= DATEADD(day, -30, CAST(GETDATE() AS DATE));
      `);
    const exc = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .query(`
        SELECT COUNT(*) AS Cnt
        FROM [dbo].[HRM_Attendance]
        WHERE UserId = @userId
          AND Session = 1
          AND Status IN ('A','L','HD')
          AND AttDate >= DATEADD(day, -30, CAST(GETDATE() AS DATE));
      `);
    return res.json({
      ok: true,
      summary: r.recordset[0],
      exceptionDays: exc.recordset[0].Cnt,
    });
  } catch (err) {
    console.error('[/api/hr/attendance/summary] failed:', err.message);
    return res.status(500).json({ message: 'Summary failed', detail: err.message });
  }
});

module.exports = router;
