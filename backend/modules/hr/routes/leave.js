// =====================================================================
// modules/hr/routes/leave.js — Leave application + approval (Phase 3 slice A)
// Mounted at /api/hr/leave/* by ../index.js
//
// Endpoints:
//   GET  /types                  — list active leave types (for Apply dropdown)
//   GET  /balance?userId=X       — current FY balance (default self)
//   GET  /reviewers              — possible AppliedTo options for current user
//   POST /apply                  — submit a new application
//   GET  /requests               — list (filter: scope=mine|team|all, status=, fy=)
//   PUT  /:id/approve            — reviewer / HR approves
//   PUT  /:id/reject             — reviewer / HR rejects
//   PUT  /:id/cancel             — applicant cancels OWN pending request
//
// Permission model:
//   - scope=mine                       → only own rows
//   - scope=team (sales heads)         → own + matching CompanyACode prefixes
//   - scope=all  (isLensAdmin)         → everyone
//   - approve / reject:
//       allowed if isLensAdmin
//       OR caller.Id === row.AppliedToUserId
//       OR caller is sales head and row applicant is in their team
//   - cancel: only the applicant of a pending row
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin, isSalesHead } = require('../../../auth');
const wf = require('../../../services/workflowEngine');     // Phase 6B — multi-level workflow integration
const { notify } = require('../../../services/notify');      // v1.13 — notification hooks

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Indian financial year for a given Date (Apr 1 → Mar 31). e.g. 2026-05-20 → 'FY2026-27'
function fyOf(d) {
  const date = (d instanceof Date) ? d : new Date(d);
  const y = date.getFullYear();
  const m = date.getMonth(); // 0-based
  const start = m >= 3 ? y : y - 1;
  const end   = (start + 1).toString().slice(-2);
  return `FY${start}-${end}`;
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

// Count working days between (FromDate, FromSession) and (ToDate, ToSession). Skips Sundays.
// FromSession=1 means starts at AM. FromSession=2 means starts at PM (half day).
// ToSession=2 means ends at PM (full last day). ToSession=1 means ends at AM (half day).
function computeDaysApplied(fromDate, fromSession, toDate, toSession) {
  const start = new Date(fromDate);
  const end   = new Date(toDate);
  if (end < start) return 0;
  let days = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const isSunday = cur.getDay() === 0;
    if (!isSunday) days += 1;
    cur.setDate(cur.getDate() + 1);
  }
  // Half-day deductions
  if (fromSession === 2) days -= 0.5;   // start at PM
  if (toSession === 1)   days -= 0.5;   // end at AM
  return Math.max(0, days);
}

async function findReviewerScope(reqUser, pool) {
  if (isLensAdmin(reqUser)) return { mode: 'all' };
  if (isSalesHead(reqUser)) {
    const codes = ((reqUser.companyaCode || '') + '/' + (reqUser.companybCode || ''))
      .split('/').map(s => s.trim()).filter(Boolean);
    return { mode: 'team', codes };
  }
  return { mode: 'self' };
}

// ── GET /types ───────────────────────────────────────────────────────────────
router.get('/types', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = await pool.request().query(`
      SELECT LeaveTypeId, Code, Name, ShortLabel, Description,
             IsPaid, AnnualGrant, MonthlyGrant, GrantMode, CarryForward,
             AllowHalfDay, AllowNegative, FixedDays, PoolWith,
             Color, Icon
      FROM [dbo].[HRM_LeaveType]
      WHERE IsActive = 1
      ORDER BY
        CASE Code WHEN 'CL' THEN 1 WHEN 'SHORT' THEN 2 WHEN 'LOP' THEN 3 ELSE 4 END,
        Code;
    `);
    return res.json({ ok: true, types: r.recordset });
  } catch (err) {
    console.error('[/api/hr/leave/types] failed:', err.message);
    return res.status(500).json({ message: 'Types fetch failed', detail: err.message });
  }
});

// ── Months elapsed in the COMPANYA financial year (Apr–Mar). Includes current month.
function monthsElapsedInFY(now, fyStr) {
  const startYear = parseInt(fyStr.slice(2, 6));  // 'FY2026-27' → 2026
  const fyStart = new Date(startYear, 3, 1);      // April 1
  const today = (now instanceof Date) ? now : new Date(now);
  if (today < fyStart) return 0;
  // months inclusive: e.g. Apr→1, May→2, …
  return (today.getFullYear() - fyStart.getFullYear()) * 12
       + (today.getMonth() - fyStart.getMonth()) + 1;
}

// Ensure the per-month grant has been credited for a monthly-grant leave type.
async function ensureMonthlyGrant(pool, userId, code, fy, type) {
  if (!type || type.GrantMode !== 'monthly' || !type.MonthlyGrant) return;
  const months = monthsElapsedInFY(new Date(), fy);
  if (months <= 0) return;
  const expected = Number((months * Number(type.MonthlyGrant)).toFixed(2));
  // Cap at AnnualGrant
  const capped = type.AnnualGrant ? Math.min(expected, Number(type.AnnualGrant)) : expected;

  // Upsert: create row at expected, or top up existing row when Granted < expected
  const exist = await pool.request()
    .input('uid',  sql.Int,         userId)
    .input('code', sql.NVarChar(10), code)
    .input('fy',   sql.NVarChar(10), fy)
    .query(`SELECT BalanceId, Granted FROM [dbo].[HRM_LeaveBalance]
            WHERE UserId = @uid AND LeaveTypeCode = @code AND FinancialYear = @fy;`);

  if (exist.recordset.length === 0) {
    await pool.request()
      .input('uid',  sql.Int,           userId)
      .input('code', sql.NVarChar(10),  code)
      .input('fy',   sql.NVarChar(10),  fy)
      .input('g',    sql.Decimal(6, 2), capped)
      .query(`INSERT INTO [dbo].[HRM_LeaveBalance]
              (UserId, LeaveTypeCode, FinancialYear, OpeningBalance, Granted, Consumed, Pending, Lapsed, LastGrantedAt)
              VALUES (@uid, @code, @fy, 0, @g, 0, 0, 0, SYSDATETIME());`);
  } else if (Number(exist.recordset[0].Granted) < capped) {
    await pool.request()
      .input('uid',  sql.Int,           userId)
      .input('code', sql.NVarChar(10),  code)
      .input('fy',   sql.NVarChar(10),  fy)
      .input('g',    sql.Decimal(6, 2), capped)
      .query(`UPDATE [dbo].[HRM_LeaveBalance]
              SET Granted = @g, LastGrantedAt = SYSDATETIME(), UpdatedAt = SYSDATETIME()
              WHERE UserId = @uid AND LeaveTypeCode = @code AND FinancialYear = @fy;`);
  }
}

// ── Recompute Consumed + Pending from authoritative HRM_Leave data ─────────
// Self-healing: re-derives the CL Consumed/Pending columns from the source-of-
// truth HRM_Leave applications. Runs automatically before every /balance fetch
// so the displayed numbers can't drift from reality.
async function recomputeBalanceForUser(pool, userId, fy) {
  await pool.request()
    .input('uid', sql.Int, userId)
    .input('fy',  sql.NVarChar(10), fy)
    .query(`
      WITH rollup AS (
        SELECT
          SUM(CASE WHEN Status = 'approved' THEN DaysApplied ELSE 0 END) AS Consumed,
          SUM(CASE WHEN Status = 'pending'  THEN DaysApplied ELSE 0 END) AS Pending
        FROM [dbo].[HRM_Leave]
        WHERE UserId = @uid
          AND LeaveTypeCode = 'CL'
          AND YEAR(FromDate) IN (
            CAST(SUBSTRING(@fy, 3, 4) AS INT),
            CAST(SUBSTRING(@fy, 3, 4) AS INT) + 1
          )
          AND (
            (YEAR(FromDate) =  CAST(SUBSTRING(@fy, 3, 4) AS INT)     AND MONTH(FromDate) >= 4)
            OR
            (YEAR(FromDate) =  CAST(SUBSTRING(@fy, 3, 4) AS INT) + 1 AND MONTH(FromDate) <= 3)
          )
      )
      UPDATE B SET B.Consumed = ISNULL(R.Consumed, 0),
                   B.Pending  = ISNULL(R.Pending, 0),
                   B.UpdatedAt = SYSDATETIME()
      FROM [dbo].[HRM_LeaveBalance] B
      CROSS APPLY (SELECT TOP 1 Consumed, Pending FROM rollup) R
      WHERE B.UserId = @uid AND B.LeaveTypeCode = 'CL' AND B.FinancialYear = @fy;
    `);
}

// ── GET /balance?userId=X ────────────────────────────────────────────────────
router.get('/balance', authenticate, async (req, res) => {
  try {
    const targetUserId = parseInt(req.query.userId) || req.user.id;
    const fy = req.query.fy || fyOf(new Date());
    const pool = await getAppPool();

    if (targetUserId !== req.user.id && !isLensAdmin(req.user) && !isSalesHead(req.user)) {
      return res.status(403).json({ message: 'Not allowed to view this user\'s balance' });
    }

    // Auto-grant monthly accruals up to current month before computing
    const typesRes = await pool.request().query(`
      SELECT Code, AnnualGrant, MonthlyGrant, GrantMode, PoolWith
      FROM [dbo].[HRM_LeaveType]
      WHERE IsActive = 1 AND GrantMode = 'monthly';
    `);
    for (const t of typesRes.recordset) {
      await ensureMonthlyGrant(pool, targetUserId, t.Code, fy, t);
    }

    // Self-heal: recompute CL Consumed/Pending from authoritative HRM_Leave
    await recomputeBalanceForUser(pool, targetUserId, fy);

    // Fetch balances. ManualGrant is HR-issued additions kept separate from
    // auto-monthly Granted so ensureMonthlyGrant top-ups don't erase them.
    const r = await pool.request()
      .input('uid', sql.Int,         targetUserId)
      .input('fy',  sql.NVarChar(10), fy)
      .query(`
        SELECT
          T.Code, T.Name, T.ShortLabel, T.IsPaid, T.AnnualGrant, T.MonthlyGrant,
          T.GrantMode, T.CarryForward, T.AllowNegative, T.FixedDays, T.PoolWith,
          T.Color, T.Icon,
          ISNULL(B.OpeningBalance, 0)            AS OpeningBalance,
          ISNULL(B.Granted,        0)            AS Granted,
          ISNULL(B.ManualGrant,    0)            AS ManualGrant,
          ISNULL(B.Consumed,       0)            AS Consumed,
          ISNULL(B.Pending,        0)            AS Pending,
          ISNULL(B.Lapsed,         0)            AS Lapsed
        FROM [dbo].[HRM_LeaveType] T
        LEFT JOIN [dbo].[HRM_LeaveBalance] B
          ON B.LeaveTypeCode = T.Code AND B.UserId = @uid AND B.FinancialYear = @fy
        WHERE T.IsActive = 1
        ORDER BY
          CASE T.Code WHEN 'CL' THEN 1 WHEN 'SHORT' THEN 2 WHEN 'LOP' THEN 3 ELSE 4 END;
      `);

    // Compute Available for each. For pooled members, Available mirrors the host's.
    // Short Leave is special — show MONTH-scope usage (2/month cap) instead of FY-level math.
    const rows = r.recordset.map(b => ({ ...b }));

    // For SHORT, compute this month's usage
    let shortMonthUsed = null;
    if (rows.some(b => b.Code === 'SHORT')) {
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
      const monthEnd   = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1);
      const usedRes = await pool.request()
        .input('uid', sql.Int, targetUserId)
        .input('ms',  sql.Date, monthStart.toISOString().slice(0, 10))
        .input('me',  sql.Date, monthEnd.toISOString().slice(0, 10))
        .query(`
          SELECT ISNULL(SUM(DaysApplied), 0) AS Used
          FROM [dbo].[HRM_Leave]
          WHERE UserId = @uid AND LeaveTypeCode = 'SHORT'
            AND Status IN ('pending','approved')
            AND FromDate >= @ms AND FromDate < @me;
        `);
      shortMonthUsed = Number(usedRes.recordset[0].Used || 0);
    }

    rows.forEach(b => {
      if (b.Code === 'SHORT') {
        // Short Leave: month-scoped — Available = MonthlyGrant + ManualGrant − usedThisMonth
        // (HR can bonus +1 SHORT this month with a manual grant)
        const cap = Number(b.MonthlyGrant || 2) + Number(b.ManualGrant || 0);
        b.MonthUsed = shortMonthUsed;
        b.MonthCap  = cap;
        b.Available = Math.max(0, cap - shortMonthUsed);
        return;
      }
      if (b.PoolWith) {
        const host = rows.find(h => h.Code === b.PoolWith);
        if (host) {
          b.Available = Number(host.OpeningBalance) + Number(host.Granted) + Number(host.ManualGrant || 0)
                      - Number(host.Consumed) - Number(host.Pending) - Number(host.Lapsed);
          b.PoolHostCode = host.Code;
          b.PoolHostName = host.Name;
          return;
        }
      }
      b.Available = Number(b.OpeningBalance) + Number(b.Granted) + Number(b.ManualGrant || 0)
                  - Number(b.Consumed) - Number(b.Pending) - Number(b.Lapsed);
    });
    return res.json({ ok: true, userId: targetUserId, fy, balances: rows });
  } catch (err) {
    console.error('[/api/hr/leave/balance] failed:', err.message);
    return res.status(500).json({ message: 'Balance fetch failed', detail: err.message });
  }
});

// ── GET /reviewers — list of possible reviewers ──────────────────────────────
// For now: returns everyone who could approve = HR + admins + sales heads.
// Phase 3 slice B will let HR assign default reviewer per employee in HRM_Employee.
router.get('/reviewers', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = await pool.request().query(`
      SELECT Id, Name, Email, Role
      FROM [dbo].[User_Login]
      WHERE IsActive = 1
        AND LOWER(Role) IN ('admin','operation head','director','hr','hr head',
                             'sales head','north sales head','electrical head')
      ORDER BY Role, Name;
    `);
    return res.json({ ok: true, reviewers: r.recordset });
  } catch (err) {
    return res.status(500).json({ message: 'Reviewers fetch failed', detail: err.message });
  }
});

// ── POST /apply ──────────────────────────────────────────────────────────────
router.post('/apply', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    const code = (b.leaveTypeCode || '').trim();
    if (!code)        return res.status(400).json({ message: 'leaveTypeCode required' });
    if (!b.fromDate)  return res.status(400).json({ message: 'fromDate required' });
    if (!b.toDate)    return res.status(400).json({ message: 'toDate required' });
    const fromSession = parseInt(b.fromSession) === 2 ? 2 : 1;
    const toSession   = parseInt(b.toSession)   === 1 ? 1 : 2;

    let days = computeDaysApplied(b.fromDate, fromSession, b.toDate, toSession);
    if (days <= 0) return res.status(400).json({ message: 'Selected range yields 0 days (Sundays excluded)' });

    const pool = await getAppPool();
    // Validate leave type exists
    const tRes = await pool.request()
      .input('code', sql.NVarChar(10), code)
      .query(`SELECT TOP 1 Code, AllowNegative, AnnualGrant, MonthlyGrant, GrantMode,
                          FixedDays, PoolWith
              FROM [dbo].[HRM_LeaveType] WHERE Code = @code AND IsActive = 1;`);
    if (tRes.recordset.length === 0) return res.status(400).json({ message: 'Invalid leave type' });

    const type = tRes.recordset[0];

    // SHORT (or any FixedDays type) — override the user's date math
    if (type.FixedDays != null && Number(type.FixedDays) > 0) {
      // Force a single-day, half-day application
      // FromSession=2 (PM only — late arrival) OR ToSession=1 (AM only — early departure)
      // Default: 1st half = late arrival
      if (fromSession === 1 && toSession === 2) {
        // user didn't pick a half — assume 1st half (late arrival)
        // i.e. they're skipping AM, starting at PM → from PM, to PM
        // we model as FromSession=2 to keep "they missed the morning"
      }
      // Final day count = the fixed amount
      // (FromDate already === ToDate is enforced below)
      // Nothing else to compute.
    }

    // Balance check (skip if AllowNegative). Pooled types check against the host.
    const checkCode = type.PoolWith || code;
    const checkDays = (type.FixedDays != null && Number(type.FixedDays) > 0) ? Number(type.FixedDays) : days;

    // ── SPECIAL CASE: Short Leave has a hard MONTHLY cap of MonthlyGrant ──
    // (not just an annual accumulator). 3rd Short Leave in the same calendar
    // month is blocked. Doesn't carry forward.
    if (code === 'SHORT' && Number(type.MonthlyGrant) > 0) {
      const monthStart = new Date(b.fromDate); monthStart.setDate(1);
      const monthEnd   = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1);
      const usedThisMonth = await pool.request()
        .input('uid', sql.Int, req.user.id)
        .input('ms',  sql.Date, monthStart.toISOString().slice(0, 10))
        .input('me',  sql.Date, monthEnd.toISOString().slice(0, 10))
        .query(`
          SELECT ISNULL(SUM(DaysApplied), 0) AS Used
          FROM [dbo].[HRM_Leave]
          WHERE UserId = @uid
            AND LeaveTypeCode = 'SHORT'
            AND Status IN ('pending','approved')
            AND FromDate >= @ms AND FromDate < @me;
        `);
      const used = Number(usedThisMonth.recordset[0].Used || 0);
      const monthCap = Number(type.MonthlyGrant);
      if (used + checkDays > monthCap) {
        return res.status(400).json({
          message: `You've already used ${used} of ${monthCap} Short Leaves this month. Only ${Math.max(0, monthCap - used)} left.`,
          monthUsed: used, monthCap,
        });
      }
      // SHORT is monthly-bounded — skip the cumulative balance check below
    } else if (!type.AllowNegative) {
      const fy = fyOf(new Date(b.fromDate));
      // Make sure the host type's monthly grant is up-to-date before we check
      const hostType = await pool.request()
        .input('code', sql.NVarChar(10), checkCode)
        .query(`SELECT Code, AnnualGrant, MonthlyGrant, GrantMode
                FROM [dbo].[HRM_LeaveType] WHERE Code = @code AND IsActive = 1;`);
      if (hostType.recordset.length > 0) {
        await ensureMonthlyGrant(pool, req.user.id, checkCode, fy, hostType.recordset[0]);
      }

      const balRes = await pool.request()
        .input('uid',  sql.Int,         req.user.id)
        .input('code', sql.NVarChar(10), checkCode)
        .input('fy',   sql.NVarChar(10), fy)
        .query(`
          SELECT TOP 1
            ISNULL(OpeningBalance, 0) + ISNULL(Granted, 0) - ISNULL(Consumed, 0) - ISNULL(Pending, 0) - ISNULL(Lapsed, 0) AS Available
          FROM [dbo].[HRM_LeaveBalance]
          WHERE UserId = @uid AND LeaveTypeCode = @code AND FinancialYear = @fy;
        `);
      const available = balRes.recordset.length ? Number(balRes.recordset[0].Available) : 0;
      if (available < checkDays) {
        return res.status(400).json({
          message: `Insufficient balance — available ${available} day(s), applying ${checkDays} day(s). For overruns, apply Loss-of-Pay (LOP) for the extra portion.`,
          available, applying: checkDays,
          poolWith: type.PoolWith || null,
        });
      }
    }

    // For FixedDays types (SHORT), force the day count + single date + correct sessions
    let effectiveFromDate = b.fromDate;
    let effectiveToDate   = b.toDate;
    let effectiveFromSession = fromSession;
    let effectiveToSession   = toSession;
    let effectiveDays = days;
    if (type.FixedDays != null && Number(type.FixedDays) > 0) {
      effectiveDays = Number(type.FixedDays);
      effectiveToDate = effectiveFromDate;   // always single-day
      // 1st-half short leave (late arrival) = from PM, to PM   → FromSession=2, ToSession=2
      // 2nd-half short leave (early depart) = from AM, to AM   → FromSession=1, ToSession=1
      if (fromSession === 2 && toSession === 2) {
        // already 1st-half (late arrival) — ok
      } else if (fromSession === 1 && toSession === 1) {
        // already 2nd-half (early departure) — ok
      } else {
        // default to 1st-half (late arrival)
        effectiveFromSession = 2;
        effectiveToSession   = 2;
      }
    }

    // Insert leave row
    const r = pool.request();
    r.input('uid',          sql.Int,           req.user.id);
    r.input('uc',           sql.NVarChar(50),  pickUserCode(req.user));
    r.input('co',           sql.NVarChar(10),  pickCompany(req.user));
    r.input('code',         sql.NVarChar(10),  code);
    r.input('fromDate',     sql.Date,          effectiveFromDate);
    r.input('fromSession',  sql.TinyInt,       effectiveFromSession);
    r.input('toDate',       sql.Date,          effectiveToDate);
    r.input('toSession',    sql.TinyInt,       effectiveToSession);
    r.input('days',         sql.Decimal(6, 2), effectiveDays);
    r.input('reason',       sql.NVarChar(sql.MAX), b.reason || null);
    r.input('contact',      sql.NVarChar(200), b.contactDetails || null);
    r.input('attachment',   sql.NVarChar(500), b.attachmentUrl || null);
    r.input('appliedTo',    sql.Int,           b.appliedToUserId ? parseInt(b.appliedToUserId) : null);
    r.input('cc',           sql.NVarChar(sql.MAX), b.ccList ? JSON.stringify(b.ccList) : null);

    const out = await r.query(`
      INSERT INTO [dbo].[HRM_Leave]
        (UserId, UserCode, Company, LeaveTypeCode,
         FromDate, FromSession, ToDate, ToSession, DaysApplied,
         Reason, ContactDetails, AttachmentUrl,
         AppliedToUserId, CCList)
      OUTPUT INSERTED.LeaveId, INSERTED.AppliedAt, INSERTED.DaysApplied
      VALUES
        (@uid, @uc, @co, @code,
         @fromDate, @fromSession, @toDate, @toSession, @days,
         @reason, @contact, @attachment,
         @appliedTo, @cc);
    `);

    // Update Pending balance — provisional hold on the POOL HOST (or self if no pool)
    // For SHORT we skip this (the monthly count check is the gate, not the cumulative balance)
    if (!type.AllowNegative && code !== 'SHORT') {
      const fy = fyOf(new Date(effectiveFromDate));
      const holdOn = type.PoolWith || code;
      await upsertPending(pool, req.user.id, holdOn, fy, effectiveDays, +1);
    }

    const newLeaveId = out.recordset[0].LeaveId;

    // ── Phase 6B: try to attach a multi-level workflow ────────────────────
    // If a HRM_Workflow_Definition matches this Leave's shape, the engine
    // starts a HRM_Workflow_Instance and overrides AppliedToUserId with the
    // resolved level-1 reviewer. If no workflow matches, the legacy
    // single-level flow (using the @appliedTo from the apply form) is
    // preserved unchanged. Failures here MUST NOT fail the apply.
    let workflowInfo = null;
    try {
      const empQ = await pool.request().input('uid', sql.Int, req.user.id)
        .query('SELECT Department FROM HRM_Employee WHERE UserId = @uid;');
      const dept = empQ.recordset[0]?.Department || null;
      const wfDef = await wf.selectWorkflow(pool, 'Leave', {
        days: out.recordset[0].DaysApplied,
        department: dept,
        leaveTypeCode: code,
      });
      if (wfDef) {
        const started = await wf.startInstance(pool, 'Leave', newLeaveId, req.user.id, wfDef);
        if (started?.currentReviewerUserId) {
          await pool.request().input('id', sql.Int, newLeaveId).input('to', sql.Int, started.currentReviewerUserId)
            .query('UPDATE HRM_Leave SET AppliedToUserId = @to, UpdatedAt = SYSDATETIME() WHERE LeaveId = @id;');
        }
        workflowInfo = {
          workflowCode: wfDef.Code,
          workflowName: wfDef.Name,
          totalLevels:  wfDef.levels.length,
          currentLevel: 1,
        };
      }
    } catch (wfErr) {
      console.warn('[leave/apply wf-start]', wfErr.message);
    }

    // v1.13 — notify the reviewer that a new leave request awaits them.
    try {
      const rv = await pool.request().input('id', sql.Int, newLeaveId)
        .query('SELECT AppliedToUserId FROM HRM_Leave WHERE LeaveId=@id');
      const reviewerId = rv.recordset[0] && rv.recordset[0].AppliedToUserId;
      if (reviewerId && Number(reviewerId) !== Number(req.user.id)) {
        notify({
          userId: reviewerId, category: 'hr', type: 'leave_applied', severity: 'info',
          title: 'New leave request',
          body: `${req.user.name || 'An employee'} applied for ${code} (${out.recordset[0].DaysApplied} day(s)).`,
          deepLink: '/modules/hr/leave-approvals.html', createdBy: req.user.id,
          refKey: `leave_applied:${newLeaveId}`,
        }).catch(() => {});
      }
    } catch (_) { /* notification must never fail the apply */ }

    return res.status(201).json({
      ok: true,
      leaveId: newLeaveId,
      daysApplied: out.recordset[0].DaysApplied,
      appliedAt:  out.recordset[0].AppliedAt,
      workflow:   workflowInfo,
    });
  } catch (err) {
    console.error('[POST /api/hr/leave/apply] failed:', err.message);
    return res.status(500).json({ message: 'Apply failed', detail: err.message });
  }
});

async function upsertPending(pool, userId, code, fy, days, sign) {
  const r = pool.request();
  r.input('uid',  sql.Int,           userId);
  r.input('code', sql.NVarChar(10),  code);
  r.input('fy',   sql.NVarChar(10),  fy);
  r.input('d',    sql.Decimal(6, 2), days);

  const existing = await r.query(`
    SELECT BalanceId FROM [dbo].[HRM_LeaveBalance]
    WHERE UserId = @uid AND LeaveTypeCode = @code AND FinancialYear = @fy;
  `);
  if (existing.recordset.length === 0) {
    // Pull AnnualGrant as default starting Granted
    const g = await pool.request()
      .input('code', sql.NVarChar(10), code)
      .query(`SELECT AnnualGrant FROM [dbo].[HRM_LeaveType] WHERE Code = @code;`);
    const annual = g.recordset[0] ? Number(g.recordset[0].AnnualGrant) : 0;
    await pool.request()
      .input('uid',     sql.Int,           userId)
      .input('code',    sql.NVarChar(10),  code)
      .input('fy',      sql.NVarChar(10),  fy)
      .input('granted', sql.Decimal(6, 2), annual)
      .input('p',       sql.Decimal(6, 2), sign > 0 ? Number(days) : -Number(days))
      .query(`
        INSERT INTO [dbo].[HRM_LeaveBalance]
          (UserId, LeaveTypeCode, FinancialYear, OpeningBalance, Granted, Consumed, Pending, Lapsed)
        VALUES (@uid, @code, @fy, 0, @granted, 0, @p, 0);
      `);
  } else {
    await pool.request()
      .input('uid',  sql.Int,           userId)
      .input('code', sql.NVarChar(10),  code)
      .input('fy',   sql.NVarChar(10),  fy)
      .input('d',    sql.Decimal(6, 2), sign > 0 ? Number(days) : -Number(days))
      .query(`
        UPDATE [dbo].[HRM_LeaveBalance]
        SET Pending = Pending + @d, UpdatedAt = SYSDATETIME()
        WHERE UserId = @uid AND LeaveTypeCode = @code AND FinancialYear = @fy;
      `);
  }
}

async function moveToConsumed(pool, userId, code, fy, days) {
  await pool.request()
    .input('uid',  sql.Int,           userId)
    .input('code', sql.NVarChar(10),  code)
    .input('fy',   sql.NVarChar(10),  fy)
    .input('d',    sql.Decimal(6, 2), Number(days))
    .query(`
      UPDATE [dbo].[HRM_LeaveBalance]
      SET Pending  = CASE WHEN Pending - @d < 0 THEN 0 ELSE Pending - @d END,
          Consumed = Consumed + @d,
          UpdatedAt = SYSDATETIME()
      WHERE UserId = @uid AND LeaveTypeCode = @code AND FinancialYear = @fy;
    `);
}

// ── GET /requests ────────────────────────────────────────────────────────────
router.get('/requests', authenticate, async (req, res) => {
  try {
    const scope = (req.query.scope || 'mine').toLowerCase();    // mine | team | all | pending-mine
    const status = (req.query.status || '').toLowerCase();
    const fy = req.query.fy;
    const pool = await getAppPool();
    const r = pool.request();
    const where = ['1=1'];

    if (scope === 'mine') {
      where.push('L.UserId = @selfId');
      r.input('selfId', sql.Int, req.user.id);
    } else if (scope === 'pending-mine') {
      // for "approvals queue" - things assigned to me or where I'm a fallback approver
      where.push('(L.AppliedToUserId = @selfId OR (L.AppliedToUserId IS NULL AND @isAdmin = 1))');
      r.input('selfId',  sql.Int, req.user.id);
      r.input('isAdmin', sql.Bit, isLensAdmin(req.user) ? 1 : 0);
    } else if (scope === 'team') {
      const codes = ((req.user.companyaCode || '') + '/' + (req.user.companybCode || ''))
        .split('/').map(s => s.trim()).filter(Boolean);
      if (codes.length === 0 || !isSalesHead(req.user)) {
        return res.json({ ok: true, requests: [] });
      }
      codes.forEach((c, i) => r.input('tc' + i, sql.NVarChar(50), c));
      where.push(`(L.UserId = @selfId OR EXISTS (
        SELECT 1 FROM [dbo].[User_Login] UL
        WHERE UL.Id = L.UserId AND (
          EXISTS (SELECT 1 FROM string_split(UL.CompanyACode,    '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@tc'+i).join(',')}))
          OR EXISTS (SELECT 1 FROM string_split(UL.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@tc'+i).join(',')}))
        )
      ))`);
      r.input('selfId', sql.Int, req.user.id);
    } else if (scope === 'all') {
      if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin' });
      // no extra filter
    }
    if (status) { where.push('L.Status = @st'); r.input('st', sql.NVarChar(20), status); }
    if (fy)     { where.push("DATEDIFF(day, L.FromDate, @fyStart) <= 0"); /* simplified - phase B */ }

    const result = await r.query(`
      SELECT
        L.LeaveId, L.UserId, UL.Name AS UserName, UL.Email AS Email, UL.CompanyACode AS CompanyACode,
        L.LeaveTypeCode, T.Name AS LeaveTypeName, T.Color AS LeaveTypeColor, T.Icon AS LeaveTypeIcon,
        L.FromDate, L.FromSession, L.ToDate, L.ToSession, L.DaysApplied,
        L.Reason, L.ContactDetails, L.AttachmentUrl,
        L.AppliedAt, L.AppliedToUserId, AT.Name AS AppliedToName,
        L.Status,
        L.ApprovedBy, AB.Name AS ApprovedByName, L.ApprovedAt, L.ApprovalNote,
        L.RejectedBy, RB.Name AS RejectedByName, L.RejectedAt, L.RejectionReason,
        L.CancelledAt,
        WI.CurrentLevel  AS WfCurrentLevel,
        WI.TotalLevels   AS WfTotalLevels,
        WD.Code          AS WfCode,
        WD.Name          AS WfName
      FROM [dbo].[HRM_Leave] L
      LEFT JOIN [dbo].[HRM_LeaveType] T  ON T.Code = L.LeaveTypeCode
      LEFT JOIN [dbo].[User_Login]    UL ON UL.Id  = L.UserId
      LEFT JOIN [dbo].[User_Login]    AT ON AT.Id  = L.AppliedToUserId
      LEFT JOIN [dbo].[User_Login]    AB ON AB.Id  = L.ApprovedBy
      LEFT JOIN [dbo].[User_Login]    RB ON RB.Id  = L.RejectedBy
      LEFT JOIN [dbo].[HRM_Workflow_Instance] WI ON WI.EntityKind = 'Leave' AND WI.EntityId = L.LeaveId
      LEFT JOIN [dbo].[HRM_Workflow_Definition] WD ON WD.WorkflowId = WI.WorkflowId
      WHERE ${where.join(' AND ')}
      ORDER BY L.AppliedAt DESC;
    `);
    return res.json({ ok: true, requests: result.recordset });
  } catch (err) {
    console.error('[/api/hr/leave/requests] failed:', err.message);
    return res.status(500).json({ message: 'Requests fetch failed', detail: err.message });
  }
});

function canApprove(reqUser, leave) {
  if (isLensAdmin(reqUser)) return true;
  if (Number(leave.AppliedToUserId) === Number(reqUser.id)) return true;
  if (isSalesHead(reqUser)) {
    // sales head can approve own team — caller passes CompanyACode list of head; we check applicant has matching code
    const codes = ((reqUser.companyaCode || '') + '/' + (reqUser.companybCode || ''))
      .split('/').map(s => s.trim()).filter(Boolean);
    if (codes.length === 0) return false;
    // we'd need the applicant's codes; for slice A let's rely on AppliedTo = caller as the firm gate
  }
  return false;
}

async function loadLeave(pool, id) {
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM [dbo].[HRM_Leave] WHERE LeaveId = @id;`);
  return r.recordset[0] || null;
}

// ── PUT /:id/approve ────────────────────────────────────────────────────────
router.put('/:id/approve', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const note = (req.body && req.body.note) || null;
    const pool = await getAppPool();
    const leave = await loadLeave(pool, id);
    if (!leave) return res.status(404).json({ message: 'Not found' });
    if (leave.Status !== 'pending') return res.status(409).json({ message: 'Already ' + leave.Status });
    if (!canApprove(req.user, leave)) return res.status(403).json({ message: 'Not allowed to approve this request' });

    // ── Phase 6B: if a workflow instance is attached, advance it instead of
    // closing the leave directly. The leave's Status flips to 'approved' only
    // when the engine returns final state. Intermediate levels just hand off
    // AppliedToUserId to the next reviewer.
    const inst = await wf.getInstance(pool, 'Leave', id);
    if (inst && inst.Status === 'in-progress') {
      if (Number(inst.CurrentReviewerUserId) !== Number(req.user.id) && !isLensAdmin(req.user)) {
        return res.status(403).json({
          message: `Not your turn — waiting on ${inst.CurrentReviewerName || ('user ' + inst.CurrentReviewerUserId)} at level ${inst.CurrentLevel}/${inst.TotalLevels}`,
        });
      }
      const r = await wf.advance(pool, inst.InstanceId, 'approved', req.user.id, note);
      if (r.status === 'in-progress') {
        // More levels remain — keep leave pending, hand off to next reviewer
        await pool.request().input('id', sql.Int, id).input('to', sql.Int, r.nextReviewer?.userId || null)
          .query('UPDATE HRM_Leave SET AppliedToUserId = @to, UpdatedAt = SYSDATETIME() WHERE LeaveId = @id;');
        if (r.nextReviewer?.userId) notify({
          userId: r.nextReviewer.userId, category: 'hr', type: 'workflow_pending', severity: 'info',
          title: 'Leave awaiting your approval',
          body: `A leave request needs your review (level ${r.currentLevel}/${r.totalLevels}).`,
          deepLink: '/modules/hr/leave-approvals.html', createdBy: req.user.id,
          refKey: `leave_wf:${id}:L${r.currentLevel}`,
        }).catch(() => {});
        return res.json({ ok: true, workflowAdvanced: true, currentLevel: r.currentLevel, totalLevels: r.totalLevels, nextReviewer: r.nextReviewer });
      }
      // r.status === 'approved' → fall through to the legacy "close + move balance" block
    }

    await pool.request()
      .input('id',   sql.Int,           id)
      .input('uid',  sql.Int,           req.user.id)
      .input('note', sql.NVarChar(500), note)
      .query(`
        UPDATE [dbo].[HRM_Leave]
        SET Status = 'approved', ApprovedBy = @uid, ApprovedAt = SYSDATETIME(),
            ApprovalNote = @note, UpdatedAt = SYSDATETIME()
        WHERE LeaveId = @id;
      `);

    // Move provisional Pending balance → Consumed (skip LOP / SHORT which don't use cumulative balance)
    const t = await pool.request().input('code', sql.NVarChar(10), leave.LeaveTypeCode)
      .query(`SELECT AllowNegative, PoolWith FROM [dbo].[HRM_LeaveType] WHERE Code = @code;`);
    if (t.recordset[0] && !t.recordset[0].AllowNegative && leave.LeaveTypeCode !== 'SHORT') {
      const holdOn = t.recordset[0].PoolWith || leave.LeaveTypeCode;
      await moveToConsumed(pool, leave.UserId, holdOn, fyOf(leave.FromDate), leave.DaysApplied);
    }
    notify({
      userId: leave.UserId, category: 'hr', type: 'leave_approved', severity: 'success',
      title: 'Leave approved ✅',
      body: `Your ${leave.LeaveTypeCode || 'leave'} for ${leave.DaysApplied} day(s) has been approved.`,
      deepLink: '/modules/hr/leave.html', createdBy: req.user.id, refKey: `leave_approved:${id}`,
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    console.error('[PUT approve] failed:', err.message);
    return res.status(500).json({ message: 'Approve failed', detail: err.message });
  }
});

// ── PUT /:id/reject ─────────────────────────────────────────────────────────
router.put('/:id/reject', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const reason = (req.body && req.body.reason) || null;
    const pool = await getAppPool();
    const leave = await loadLeave(pool, id);
    if (!leave) return res.status(404).json({ message: 'Not found' });
    if (leave.Status !== 'pending') return res.status(409).json({ message: 'Already ' + leave.Status });
    if (!canApprove(req.user, leave)) return res.status(403).json({ message: 'Not allowed' });

    // Phase 6B: workflow short-circuit. A rejection at any level closes the
    // whole workflow (no further reviewers see it). Legacy single-level
    // requests bypass this branch.
    const inst = await wf.getInstance(pool, 'Leave', id);
    if (inst && inst.Status === 'in-progress') {
      if (Number(inst.CurrentReviewerUserId) !== Number(req.user.id) && !isLensAdmin(req.user)) {
        return res.status(403).json({
          message: `Not your turn — waiting on ${inst.CurrentReviewerName || ('user ' + inst.CurrentReviewerUserId)} at level ${inst.CurrentLevel}/${inst.TotalLevels}`,
        });
      }
      await wf.advance(pool, inst.InstanceId, 'rejected', req.user.id, reason);
      // Fall through to the legacy "close + release balance" block — leave gets Status='rejected'
    }

    await pool.request()
      .input('id', sql.Int, id).input('uid', sql.Int, req.user.id).input('reason', sql.NVarChar(500), reason)
      .query(`
        UPDATE [dbo].[HRM_Leave]
        SET Status = 'rejected', RejectedBy = @uid, RejectedAt = SYSDATETIME(),
            RejectionReason = @reason, UpdatedAt = SYSDATETIME()
        WHERE LeaveId = @id;
      `);
    // Release provisional Pending — release on the pool host (skip for SHORT)
    if (leave.LeaveTypeCode !== 'SHORT') {
      const tt = await pool.request().input('code', sql.NVarChar(10), leave.LeaveTypeCode)
        .query(`SELECT PoolWith FROM [dbo].[HRM_LeaveType] WHERE Code = @code;`);
      const releaseOn = (tt.recordset[0] && tt.recordset[0].PoolWith) || leave.LeaveTypeCode;
      await upsertPending(pool, leave.UserId, releaseOn, fyOf(leave.FromDate), leave.DaysApplied, -1);
    }
    notify({
      userId: leave.UserId, category: 'hr', type: 'leave_rejected', severity: 'warning',
      title: 'Leave rejected',
      body: reason ? `Reason: ${String(reason).slice(0, 160)}` : `Your ${leave.LeaveTypeCode || 'leave'} request was not approved.`,
      deepLink: '/modules/hr/leave.html', createdBy: req.user.id, refKey: `leave_rejected:${id}`,
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Reject failed', detail: err.message });
  }
});

// ── PUT /:id/cancel — applicant cancels own pending ────────────────────────
router.put('/:id/cancel', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    const leave = await loadLeave(pool, id);
    if (!leave) return res.status(404).json({ message: 'Not found' });
    if (Number(leave.UserId) !== Number(req.user.id)) return res.status(403).json({ message: 'Only the applicant can cancel' });
    if (leave.Status !== 'pending') return res.status(409).json({ message: 'Only pending requests can be cancelled' });

    await pool.request()
      .input('id', sql.Int, id)
      .query(`
        UPDATE [dbo].[HRM_Leave]
        SET Status = 'cancelled', CancelledAt = SYSDATETIME(), UpdatedAt = SYSDATETIME()
        WHERE LeaveId = @id;
      `);
    if (leave.LeaveTypeCode !== 'SHORT') {
      const tCancel = await pool.request().input('code', sql.NVarChar(10), leave.LeaveTypeCode)
        .query(`SELECT PoolWith FROM [dbo].[HRM_LeaveType] WHERE Code = @code;`);
      const releaseOn = (tCancel.recordset[0] && tCancel.recordset[0].PoolWith) || leave.LeaveTypeCode;
      await upsertPending(pool, leave.UserId, releaseOn, fyOf(leave.FromDate), leave.DaysApplied, -1);
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Cancel failed', detail: err.message });
  }
});

// =====================================================================
// LEAVE GRANTER (Phase 3C) — HR-only endpoints for manual leave grants
// =====================================================================

// Helper: upsert HRM_LeaveBalance row + bump ManualGrant by delta
async function applyManualGrant(pool, userId, code, fy, deltaDays, grantedBy) {
  // Ensure balance row exists
  const exist = await pool.request()
    .input('uid',  sql.Int,         userId)
    .input('code', sql.NVarChar(10), code)
    .input('fy',   sql.NVarChar(10), fy)
    .query(`SELECT BalanceId FROM [dbo].[HRM_LeaveBalance]
            WHERE UserId = @uid AND LeaveTypeCode = @code AND FinancialYear = @fy;`);

  if (exist.recordset.length === 0) {
    // Pull AnnualGrant default for the type
    const tInfo = await pool.request()
      .input('code', sql.NVarChar(10), code)
      .query(`SELECT AnnualGrant FROM [dbo].[HRM_LeaveType] WHERE Code = @code;`);
    const annual = tInfo.recordset[0] ? Number(tInfo.recordset[0].AnnualGrant) : 0;
    await pool.request()
      .input('uid',     sql.Int,           userId)
      .input('code',    sql.NVarChar(10),  code)
      .input('fy',      sql.NVarChar(10),  fy)
      .input('granted', sql.Decimal(6, 2), 0)              // auto-grant accrues separately
      .input('manual',  sql.Decimal(6, 2), Number(deltaDays))
      .query(`
        INSERT INTO [dbo].[HRM_LeaveBalance]
          (UserId, LeaveTypeCode, FinancialYear, OpeningBalance, Granted, ManualGrant, Consumed, Pending, Lapsed, LastGrantedAt)
        VALUES (@uid, @code, @fy, 0, @granted, @manual, 0, 0, 0, SYSDATETIME());
      `);
  } else {
    await pool.request()
      .input('uid',    sql.Int,           userId)
      .input('code',   sql.NVarChar(10),  code)
      .input('fy',     sql.NVarChar(10),  fy)
      .input('delta',  sql.Decimal(6, 2), Number(deltaDays))
      .query(`
        UPDATE [dbo].[HRM_LeaveBalance]
        SET ManualGrant = ManualGrant + @delta,
            LastGrantedAt = SYSDATETIME(),
            UpdatedAt = SYSDATETIME()
        WHERE UserId = @uid AND LeaveTypeCode = @code AND FinancialYear = @fy;
      `);
  }
}

async function loadUser(pool, userId) {
  const r = await pool.request()
    .input('uid', sql.Int, userId)
    .query(`SELECT Id, Name, CompanyACode, CompanyBCode FROM [dbo].[User_Login] WHERE Id = @uid AND IsActive = 1;`);
  return r.recordset[0] || null;
}

// ── POST /grant — single or batch ───────────────────────────────────────────
// Body: { assignments: [{userId, leaveTypeCode, days, kind?, reason}], reason?, kind? }
router.post('/grant', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin can grant leaves' });
    const b = req.body || {};
    const list = Array.isArray(b.assignments) ? b.assignments : null;
    if (!list || list.length === 0) return res.status(400).json({ message: 'assignments[] required' });
    if (list.length > 200)          return res.status(400).json({ message: 'too many in one batch (max 200)' });

    const pool = await getAppPool();
    let inserted = 0, skipped = 0;
    const errors = [];

    for (const a of list) {
      const uid  = parseInt(a.userId);
      const code = (a.leaveTypeCode || '').trim();
      const days = Number(a.days);
      const reason = (a.reason || b.reason || '').trim();
      const kind   = (a.kind   || b.kind   || 'bonus').trim();

      if (!Number.isFinite(uid) || uid <= 0)        { errors.push({ uid: a.userId, err: 'invalid userId' });        skipped++; continue; }
      if (!code)                                     { errors.push({ uid, err: 'leaveTypeCode required' });          skipped++; continue; }
      if (!Number.isFinite(days) || days === 0)     { errors.push({ uid, err: 'days must be a non-zero number' }); skipped++; continue; }
      if (Math.abs(days) > 30)                       { errors.push({ uid, err: 'days out of range (-30 to 30)' }); skipped++; continue; }
      if (!reason)                                   { errors.push({ uid, err: 'reason required' });                  skipped++; continue; }

      const target = await loadUser(pool, uid);
      if (!target)                                   { errors.push({ uid, err: 'user not found' });                   skipped++; continue; }

      // Validate leave type
      const tRes = await pool.request()
        .input('code', sql.NVarChar(10), code)
        .query(`SELECT Code FROM [dbo].[HRM_LeaveType] WHERE Code = @code AND IsActive = 1;`);
      if (tRes.recordset.length === 0)               { errors.push({ uid, err: 'leave type not active' });            skipped++; continue; }

      const fy = a.fy || fyOf(new Date());
      const userCode = ((target.CompanyACode || target.CompanyBCode || '').split('/')[0] || '').trim();
      const company  = target.CompanyACode ? 'COMPANYA' : (target.CompanyBCode ? 'CompanyB' : null);

      // Audit row
      await pool.request()
        .input('uid',    sql.Int,           uid)
        .input('uc',     sql.NVarChar(50),  userCode)
        .input('co',     sql.NVarChar(10),  company)
        .input('code',   sql.NVarChar(10),  code)
        .input('fy',     sql.NVarChar(10),  fy)
        .input('days',   sql.Decimal(6, 2), days)
        .input('kind',   sql.NVarChar(30),  kind)
        .input('reason', sql.NVarChar(sql.MAX), reason)
        .input('by',     sql.Int,           req.user.id)
        .query(`
          INSERT INTO [dbo].[HRM_LeaveGrant]
            (UserId, UserCode, Company, LeaveTypeCode, FinancialYear, Days, Kind, Reason, GrantedBy)
          VALUES (@uid, @uc, @co, @code, @fy, @days, @kind, @reason, @by);
        `);

      // Update balance
      await applyManualGrant(pool, uid, code, fy, days, req.user.id);
      inserted++;
    }

    return res.status(201).json({ ok: true, inserted, skipped, errors });
  } catch (err) {
    console.error('[POST /api/hr/leave/grant] failed:', err.message);
    return res.status(500).json({ message: 'Grant failed', detail: err.message });
  }
});

// ── GET /grants — history list (filterable) ────────────────────────────────
// Permission model:
//   - isLensAdmin: can query any userId (used by Leave Granter + HR Balance view)
//   - Non-admin:   forced to their own UserId (employee sees their OWN grants)
router.get('/grants', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = pool.request();
    const where = ['1=1'];

    const requestedUid = req.query.userId ? parseInt(req.query.userId) : null;
    if (!isLensAdmin(req.user)) {
      where.push('G.UserId = @uid');
      r.input('uid', sql.Int, req.user.id);
    } else if (requestedUid) {
      where.push('G.UserId = @uid');
      r.input('uid', sql.Int, requestedUid);
    }

    if (req.query.code)   { where.push('G.LeaveTypeCode = @code');   r.input('code', sql.NVarChar(10), req.query.code); }
    if (req.query.fy)     { where.push('G.FinancialYear = @fy');     r.input('fy', sql.NVarChar(10), req.query.fy); }
    if (req.query.onlyOpen === 'true') where.push('G.IsRevoked = 0');

    const result = await r.query(`
      SELECT TOP 200
        G.GrantId, G.UserId, UL.Name AS UserName, UL.Email AS Email, UL.CompanyACode AS CompanyACode,
        G.LeaveTypeCode, T.Name AS LeaveTypeName, T.Icon AS LeaveTypeIcon, T.Color AS LeaveTypeColor,
        G.FinancialYear, G.Days, G.Kind, G.Reason,
        G.GrantedBy, GB.Name AS GrantedByName, G.GrantedAt,
        G.IsRevoked, G.RevokedBy, RB.Name AS RevokedByName, G.RevokedAt, G.RevokeReason
      FROM [dbo].[HRM_LeaveGrant] G
      LEFT JOIN [dbo].[User_Login]    UL ON UL.Id = G.UserId
      LEFT JOIN [dbo].[User_Login]    GB ON GB.Id = G.GrantedBy
      LEFT JOIN [dbo].[User_Login]    RB ON RB.Id = G.RevokedBy
      LEFT JOIN [dbo].[HRM_LeaveType] T  ON T.Code = G.LeaveTypeCode
      WHERE ${where.join(' AND ')}
      ORDER BY G.GrantedAt DESC;
    `);
    return res.json({ ok: true, grants: result.recordset });
  } catch (err) {
    console.error('[/api/hr/leave/grants] failed:', err.message);
    return res.status(500).json({ message: 'Grants fetch failed', detail: err.message });
  }
});

// ── PUT /grants/:id/revoke — undo an earlier grant ──────────────────────────
router.put('/grants/:id/revoke', authenticate, async (req, res) => {
  try {
    if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin' });
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const reason = (req.body && req.body.reason) || null;

    const pool = await getAppPool();
    const g = await pool.request().input('id', sql.Int, id)
      .query(`SELECT * FROM [dbo].[HRM_LeaveGrant] WHERE GrantId = @id;`);
    if (g.recordset.length === 0)                return res.status(404).json({ message: 'Not found' });
    const grant = g.recordset[0];
    if (grant.IsRevoked)                         return res.status(409).json({ message: 'Already revoked' });

    // Reverse the balance change (subtract whatever Days was)
    await applyManualGrant(pool, grant.UserId, grant.LeaveTypeCode, grant.FinancialYear, -Number(grant.Days), req.user.id);

    await pool.request()
      .input('id',     sql.Int,           id)
      .input('by',     sql.Int,           req.user.id)
      .input('reason', sql.NVarChar(500), reason)
      .query(`
        UPDATE [dbo].[HRM_LeaveGrant]
        SET IsRevoked = 1, RevokedBy = @by, RevokedAt = SYSDATETIME(),
            RevokeReason = @reason, UpdatedAt = SYSDATETIME()
        WHERE GrantId = @id;
      `);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[PUT revoke grant] failed:', err.message);
    return res.status(500).json({ message: 'Revoke failed', detail: err.message });
  }
});

module.exports = router;
