// =====================================================================
// modules/hr/routes/payroll.js — Payroll Run + Payslip lifecycle (Phase 5B)
// Mounted at /api/hr/payroll/* by ../index.js
//
// Endpoints:
//   HR (LENS_ADMIN_ROLES):
//     GET    /options
//     GET    /runs?year=YYYY
//     POST   /runs                            — create draft for {year, month}
//     GET    /runs/:id                        — detail (run + payslip table)
//     POST   /runs/:id/process                — compute payslips (idempotent — replaces draft rows)
//     POST   /runs/:id/lock                   — freeze + reveal to employees
//     POST   /runs/:id/unlock                 — revert to draft (only if still locked, not paid)
//     POST   /runs/:id/mark-paid              — final disbursed state (terminal)
//     DELETE /runs/:id                        — only if draft + no payslips processed
//
//   Everyone (with self-check):
//     GET    /payslips/mine?year=YYYY         — own locked/paid payslips
//     GET    /payslips/:id                    — single payslip + lines (self or HR)
//     GET    /payslips/:id/pdf                — auth-gated PDF stream
//
// Pro-rata: PayableDays = DaysInMonth − LopDays
//           EachComponent.EarnedAmount = MonthlyAmount × (PayableDays / DaysInMonth)
// LOP days are summed from HRM_Leave where LeaveTypeCode='LOP' and Status='approved'
// overlapping the month.
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');
const { fetchPayslipData, streamPayslipPdf, netPayInWords } = require('../../../services/payslipPdf');

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// FY math (COMPANYA uses Apr→Mar)
function fyOfDate(d) {
  const m = d.getMonth();          // 0=Jan, 3=Apr
  const y = d.getFullYear();
  return m >= 3 ? y : y - 1;       // FY start year
}
function fyMonthCode(year, monthNo) {
  // monthNo is calendar 1..12. Within FYyear-(year+1), Apr=M01 … Mar=M12.
  const m = monthNo - 4;
  const slot = m >= 0 ? m + 1 : m + 13;        // Apr=1 … Mar=12
  return `FY${year}-${String((year + 1) % 100).padStart(2,'0')}-M${String(slot).padStart(2,'0')}`;
}

router.use(authenticate);

// ── GET /options — list of FY-months for the year picker ────────────────────
router.get('/options', (req, res) => {
  const today = new Date();
  const fy    = fyOfDate(today);
  // Build last 24 months of FY-month codes (descending)
  const months = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const f = fyOfDate(d);
    months.push({
      year:        d.getFullYear(),
      monthNo:     d.getMonth() + 1,
      monthLabel:  `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
      periodStart: d.toISOString().slice(0,10),
      fy:          f,
      fyMonthCode: fyMonthCode(f, d.getMonth() + 1),
    });
  }
  res.json({ currentFY: fy, months, isHr: isLensAdmin(req.user) });
});

// ───────────────────────────────────────────────────────────────────────────
// HR-only sections
// ───────────────────────────────────────────────────────────────────────────
function hrOnly(req, res, next) {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  next();
}

// GET /runs?year=YYYY
router.get('/runs', hrOnly, async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || fyOfDate(new Date());
    const pool = await getAppPool();
    const r = await pool.request().input('y', sql.Int, year).query(`
      SELECT RunId, FYYear, MonthNo, PeriodStart, PeriodEnd, DaysInMonth, FYMonthCode,
             PayDate, Status, TotalGross, TotalDeductions, TotalNet, EmployeeCount,
             CreatedBy, CreatedAt, ProcessedAt, LockedAt, PaidAt,
             (SELECT Name FROM User_Login WHERE Id = CreatedBy) AS CreatedByName,
             (SELECT Name FROM User_Login WHERE Id = LockedBy)  AS LockedByName,
             (SELECT Name FROM User_Login WHERE Id = PaidBy)    AS PaidByName
      FROM HRM_Payroll_Run
      WHERE FYYear = @y
      ORDER BY MonthNo;
    `);
    res.json({ year, runs: r.recordset });
  } catch (e) { console.error('[payroll/runs]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// POST /runs — create draft for {year, month}
router.post('/runs', hrOnly, async (req, res) => {
  const yearCal  = parseInt(req.body?.year, 10);      // calendar year of the month being run
  const monthNo  = parseInt(req.body?.monthNo, 10);
  if (!yearCal || !Number.isFinite(yearCal))               return res.status(400).json({ message: 'year required' });
  if (!monthNo || monthNo < 1 || monthNo > 12)             return res.status(400).json({ message: 'monthNo must be 1..12' });
  try {
    const pool = await getAppPool();
    const periodStart = new Date(yearCal, monthNo - 1, 1);
    const periodEnd   = new Date(yearCal, monthNo, 0);     // last day
    const daysInMonth = periodEnd.getDate();
    const fy          = fyOfDate(periodStart);
    const fyCode      = fyMonthCode(fy, monthNo);

    // Refuse duplicate runs for same FY+MonthNo
    const dup = await pool.request().input('fy', sql.Int, fy).input('mn', sql.TinyInt, monthNo)
      .query('SELECT RunId FROM HRM_Payroll_Run WHERE FYYear = @fy AND MonthNo = @mn;');
    if (dup.recordset.length) return res.status(409).json({ message: 'Payroll run already exists for this month', runId: dup.recordset[0].RunId });

    const r = await pool.request()
      .input('fy',  sql.Int,           fy)
      .input('mn',  sql.TinyInt,       monthNo)
      .input('ps',  sql.Date,          periodStart)
      .input('pe',  sql.Date,          periodEnd)
      .input('dm',  sql.TinyInt,       daysInMonth)
      .input('fmc', sql.NVarChar(15),  fyCode)
      .input('cb',  sql.Int,           req.user.id)
      .query(`
        INSERT INTO HRM_Payroll_Run (FYYear, MonthNo, PeriodStart, PeriodEnd, DaysInMonth, FYMonthCode, CreatedBy)
        OUTPUT INSERTED.RunId
        VALUES (@fy, @mn, @ps, @pe, @dm, @fmc, @cb);
      `);
    res.status(201).json({ runId: r.recordset[0].RunId, fyMonthCode: fyCode });
  } catch (e) { console.error('[payroll/createRun]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// GET /runs/:id — header + payslip list
router.get('/runs/:id', hrOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const hQ = await pool.request().input('id', sql.Int, id).query(`
      SELECT R.*,
             (SELECT Name FROM User_Login WHERE Id = R.CreatedBy)   AS CreatedByName,
             (SELECT Name FROM User_Login WHERE Id = R.ProcessedBy) AS ProcessedByName,
             (SELECT Name FROM User_Login WHERE Id = R.LockedBy)    AS LockedByName,
             (SELECT Name FROM User_Login WHERE Id = R.PaidBy)      AS PaidByName
      FROM HRM_Payroll_Run R WHERE RunId = @id;
    `);
    const run = hQ.recordset[0];
    if (!run) return res.status(404).json({ message: 'Run not found' });

    const pQ = await pool.request().input('id', sql.Int, id).query(`
      SELECT PayslipId, PayslipNo, UserId, EmpCode, EmpName, Designation, Department,
             DaysInMonth, LopDays, PayableDays, PaidLeaveDays,
             MonthlyGross, TotalDeductions, NetPay, Status
      FROM HRM_Payslip
      WHERE RunId = @id
      ORDER BY EmpCode, EmpName;
    `);
    res.json({ run, payslips: pQ.recordset });
  } catch (e) { console.error('[payroll/run-detail]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── POST /runs/:id/process — compute payslips ───────────────────────────────
router.post('/runs/:id/process', hrOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });

  try {
    const pool = await getAppPool();
    const runQ = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM HRM_Payroll_Run WHERE RunId = @id;');
    const run = runQ.recordset[0];
    if (!run)                   return res.status(404).json({ message: 'Run not found' });
    if (run.Status !== 'draft') return res.status(400).json({ message: 'Only draft runs can be (re)processed; current status: ' + run.Status });

    // Eligible employees: active users with an active salary effective in this month
    const empQ = await pool.request()
      .input('id', sql.Int, id)
      .input('ps', sql.Date, run.PeriodStart)
      .input('pe', sql.Date, run.PeriodEnd)
      .query(`
        -- NB column-name aliases: HRM_Employee uses BankAccountNo / PFUAN / ESINo,
        -- but the snapshot table HRM_Payslip uses BankAccount / UAN / ESINumber.
        -- Alias here so the downstream INSERT into HRM_Payslip stays simple.
        SELECT U.Id AS UserId, U.Name, E.EmpCode, E.Designation, E.Department, E.DateOfJoining,
               E.PAN,
               E.PFUAN          AS UAN,
               E.PFNo,
               E.ESINo          AS ESINumber,
               E.BankName,
               E.BankAccountNo  AS BankAccount,
               E.IFSC,
               S.SalaryId, S.CTC
        FROM User_Login U
        JOIN HRM_Employee E ON E.UserId = U.Id
        CROSS APPLY (
          SELECT TOP 1 SalaryId, CTC
          FROM HRM_Employee_Salary
          WHERE UserId = U.Id
            AND Status = 'active'
            AND EffectiveFrom <= @pe
            AND (EffectiveTo IS NULL OR EffectiveTo >= @ps)
          ORDER BY EffectiveFrom DESC
        ) S
        WHERE U.IsActive = 1;
      `);
    const employees = empQ.recordset;
    if (!employees.length) {
      return res.status(400).json({ message: 'No active employees with assigned salaries for this month. Assign salaries first.' });
    }

    // Wipe any existing payslips for this run (idempotent reprocess)
    await pool.request().input('id', sql.Int, id).query(`
      DELETE FROM HRM_Payslip_Line
      WHERE PayslipId IN (SELECT PayslipId FROM HRM_Payslip WHERE RunId = @id);
      DELETE FROM HRM_Payslip WHERE RunId = @id;
    `);

    let totalGross = 0, totalDed = 0, totalNet = 0;
    const errors = [];

    for (const emp of employees) {
      try {
        // Component lines (frozen snapshot)
        const linesQ = await pool.request().input('sid', sql.Int, emp.SalaryId).query(`
          SELECT ComponentCode, ComponentName, Kind, FormulaSummary, MonthlyAmount, DisplayOrder
          FROM HRM_Employee_Salary_Component
          WHERE SalaryId = @sid
          ORDER BY DisplayOrder;
        `);
        const baseLines = linesQ.recordset;

        // LOP days overlapping this month (sum approved 'LOP' leaves clipped to month)
        const lopQ = await pool.request()
          .input('uid', sql.Int, emp.UserId)
          .input('ps',  sql.Date, run.PeriodStart)
          .input('pe',  sql.Date, run.PeriodEnd)
          .query(`
            SELECT ISNULL(SUM(
              CASE
                WHEN FromDate < @ps AND ToDate > @pe THEN DATEDIFF(DAY, @ps, @pe) + 1
                WHEN FromDate < @ps                  THEN DATEDIFF(DAY, @ps, ToDate) + 1
                WHEN ToDate   > @pe                  THEN DATEDIFF(DAY, FromDate, @pe) + 1
                ELSE DaysApplied
              END
            ), 0) AS LopDays
            FROM HRM_Leave
            WHERE UserId = @uid
              AND Status = 'approved'
              AND LeaveTypeCode = 'LOP'
              AND NOT (ToDate < @ps OR FromDate > @pe);
          `);
        const lopDays = Math.min(Number(lopQ.recordset[0].LopDays || 0), run.DaysInMonth);

        // Paid-leave days (info only — any approved non-LOP leave overlapping)
        const plQ = await pool.request()
          .input('uid', sql.Int, emp.UserId)
          .input('ps',  sql.Date, run.PeriodStart)
          .input('pe',  sql.Date, run.PeriodEnd)
          .query(`
            SELECT ISNULL(SUM(
              CASE
                WHEN FromDate < @ps AND ToDate > @pe THEN DATEDIFF(DAY, @ps, @pe) + 1
                WHEN FromDate < @ps                  THEN DATEDIFF(DAY, @ps, ToDate) + 1
                WHEN ToDate   > @pe                  THEN DATEDIFF(DAY, FromDate, @pe) + 1
                ELSE DaysApplied
              END
            ), 0) AS PaidLeaveDays
            FROM HRM_Leave
            WHERE UserId = @uid
              AND Status = 'approved'
              AND LeaveTypeCode <> 'LOP'
              AND NOT (ToDate < @ps OR FromDate > @pe);
          `);
        const paidLeaveDays = Number(plQ.recordset[0].PaidLeaveDays || 0);

        const payableDays = Math.max(0, run.DaysInMonth - lopDays);
        const proRate     = run.DaysInMonth > 0 ? payableDays / run.DaysInMonth : 0;

        // Compute earned lines + totals
        let gross = 0, deductions = 0;
        const earnedLines = baseLines.map(l => {
          const earned = round2(Number(l.MonthlyAmount || 0) * proRate);
          if (l.Kind === 'Earning')         gross      += earned;
          else if (l.Kind === 'Deduction')  deductions += earned;
          return { ...l, EarnedAmount: earned };
        });
        const netPay = round2(gross - deductions);

        // Insert payslip header.
        // PayslipNo column is NVARCHAR(30) — keep the generated string under that
        // hard cap. "PS-FY2026-27-M02-" is already 17 chars, so the EmpCode slice
        // gets at most 13 chars.
        const empCodePart = (emp.EmpCode || ('USR' + emp.UserId)).replace(/[^A-Z0-9]/gi,'').slice(0, 13);
        const psNo = `PS-${run.FYMonthCode}-${empCodePart}`.slice(0, 30);
        // Defensive truncations — HRM_Employee columns are sometimes wider than
        // the HRM_Payslip snapshot columns we freeze them into. SQL Server with
        // ANSI_WARNINGS ON errors on truncation; clip in JS so the INSERT can't fail.
        const clip = (s, n) => s == null ? null : String(s).slice(0, n);
        const ins = await pool.request()
          .input('no',   sql.NVarChar(30),  psNo)
          .input('rid',  sql.Int,           id)
          .input('uid',  sql.Int,           emp.UserId)
          .input('sid',  sql.Int,           emp.SalaryId)
          .input('ec',   sql.NVarChar(50),  clip(emp.EmpCode,    50))
          .input('en',   sql.NVarChar(150), clip(emp.Name,      150))
          .input('dsg',  sql.NVarChar(150), clip(emp.Designation, 150))
          .input('dep',  sql.NVarChar(50),  clip(emp.Department, 50))
          .input('doj',  sql.Date,          emp.DateOfJoining || null)
          .input('pan',  sql.NVarChar(20),  clip(emp.PAN,        20))
          .input('uan',  sql.NVarChar(20),  clip(emp.UAN,        20))
          .input('pfn',  sql.NVarChar(30),  clip(emp.PFNo,       30))
          .input('esi',  sql.NVarChar(30),  clip(emp.ESINumber,  30))
          .input('bn',   sql.NVarChar(80),  clip(emp.BankName,   80))
          .input('ba',   sql.NVarChar(40),  clip(emp.BankAccount, 40))
          .input('ifsc', sql.NVarChar(20),  clip(emp.IFSC,       20))
          .input('dim',  sql.TinyInt,       run.DaysInMonth)
          .input('lop',  sql.Decimal(6,2),  lopDays)
          .input('pay',  sql.Decimal(6,2),  payableDays)
          .input('pld',  sql.Decimal(6,2),  paidLeaveDays)
          .input('mg',   sql.Decimal(15,2), gross)
          .input('td',   sql.Decimal(15,2), deductions)
          .input('np',   sql.Decimal(15,2), netPay)
          .input('npw',  sql.NVarChar(500), netPayInWords(netPay))
          .query(`
            INSERT INTO HRM_Payslip
              (PayslipNo, RunId, UserId, SalaryId, EmpCode, EmpName, Designation, Department, DateOfJoining,
               PAN, UAN, PFNo, ESINumber, BankName, BankAccount, IFSC,
               DaysInMonth, LopDays, PayableDays, PaidLeaveDays,
               MonthlyGross, TotalDeductions, NetPay, NetPayWords, Status)
            OUTPUT INSERTED.PayslipId
            VALUES (@no, @rid, @uid, @sid, @ec, @en, @dsg, @dep, @doj, @pan, @uan, @pfn, @esi, @bn, @ba, @ifsc,
                    @dim, @lop, @pay, @pld, @mg, @td, @np, @npw, 'draft');
          `);
        const payslipId = ins.recordset[0].PayslipId;

        // Insert lines
        for (const line of earnedLines) {
          await pool.request()
            .input('pid',  sql.Int,           payslipId)
            .input('cc',   sql.NVarChar(20),  line.ComponentCode)
            .input('cn',   sql.NVarChar(100), line.ComponentName)
            .input('k',    sql.NVarChar(15),  line.Kind)
            .input('fm',   sql.Decimal(15,2), Number(line.MonthlyAmount || 0))
            .input('ea',   sql.Decimal(15,2), line.EarnedAmount)
            .input('fs',   sql.NVarChar(100), line.FormulaSummary || null)
            .input('ord',  sql.Int,           line.DisplayOrder || 50)
            .query(`
              INSERT INTO HRM_Payslip_Line
                (PayslipId, ComponentCode, ComponentName, Kind, FullMonthlyAmt, EarnedAmount, FormulaSummary, DisplayOrder)
              VALUES (@pid, @cc, @cn, @k, @fm, @ea, @fs, @ord);
            `);
        }
        totalGross += gross; totalDed += deductions; totalNet += netPay;
      } catch (perErr) {
        console.error('[payroll/process] employee error', emp.UserId, perErr);
        errors.push({ userId: emp.UserId, name: emp.Name, message: perErr.message });
      }
    }

    // Update run totals + ProcessedAt
    await pool.request()
      .input('id',  sql.Int,           id)
      .input('tg',  sql.Decimal(15,2), totalGross)
      .input('td',  sql.Decimal(15,2), totalDed)
      .input('tn',  sql.Decimal(15,2), totalNet)
      .input('ec',  sql.Int,           employees.length - errors.length)
      .input('pb',  sql.Int,           req.user.id)
      .query(`
        UPDATE HRM_Payroll_Run
        SET TotalGross = @tg, TotalDeductions = @td, TotalNet = @tn,
            EmployeeCount = @ec, ProcessedBy = @pb, ProcessedAt = SYSDATETIME()
        WHERE RunId = @id;
      `);

    res.json({ ok: true, employeesProcessed: employees.length - errors.length, totalGross, totalDed, totalNet, errors });
  } catch (e) {
    console.error('[payroll/process]', e);
    res.status(500).json({ message: 'Failed to process payroll', error: e.message });
  }
});

// POST /runs/:id/lock — freeze + reveal to employees
router.post('/runs/:id/lock', hrOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT Status, ProcessedAt FROM HRM_Payroll_Run WHERE RunId = @id;');
    const cur = r.recordset[0];
    if (!cur)                   return res.status(404).json({ message: 'Not found' });
    if (cur.Status !== 'draft') return res.status(400).json({ message: 'Only draft runs can be locked' });
    if (!cur.ProcessedAt)       return res.status(400).json({ message: 'Process the run before locking' });

    const payDateRaw = req.body?.payDate;
    const payDate    = payDateRaw ? new Date(payDateRaw) : null;
    await pool.request()
      .input('id', sql.Int, id)
      .input('lb', sql.Int, req.user.id)
      .input('pd', sql.Date, (payDate && !isNaN(payDate)) ? payDate : null)
      .query(`
        UPDATE HRM_Payroll_Run
        SET Status = 'locked', LockedBy = @lb, LockedAt = SYSDATETIME(), PayDate = @pd
        WHERE RunId = @id;
        UPDATE HRM_Payslip SET Status = 'locked' WHERE RunId = @id;
      `);
    res.json({ ok: true });
  } catch (e) { console.error('[payroll/lock]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// POST /runs/:id/unlock — revert to draft (only if not paid)
router.post('/runs/:id/unlock', hrOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT Status FROM HRM_Payroll_Run WHERE RunId = @id;');
    const cur = r.recordset[0];
    if (!cur)                    return res.status(404).json({ message: 'Not found' });
    if (cur.Status !== 'locked') return res.status(400).json({ message: 'Only locked runs can be unlocked' });
    await pool.request().input('id', sql.Int, id).query(`
      UPDATE HRM_Payroll_Run
      SET Status = 'draft', LockedBy = NULL, LockedAt = NULL, PayDate = NULL
      WHERE RunId = @id;
      UPDATE HRM_Payslip SET Status = 'draft' WHERE RunId = @id;
    `);
    res.json({ ok: true });
  } catch (e) { console.error('[payroll/unlock]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// POST /runs/:id/mark-paid — terminal state
router.post('/runs/:id/mark-paid', hrOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT Status FROM HRM_Payroll_Run WHERE RunId = @id;');
    const cur = r.recordset[0];
    if (!cur)                    return res.status(404).json({ message: 'Not found' });
    if (cur.Status !== 'locked') return res.status(400).json({ message: 'Lock the run before marking paid' });
    await pool.request().input('id', sql.Int, id).input('pb', sql.Int, req.user.id).query(`
      UPDATE HRM_Payroll_Run SET Status = 'paid', PaidBy = @pb, PaidAt = SYSDATETIME() WHERE RunId = @id;
      UPDATE HRM_Payslip SET Status = 'paid' WHERE RunId = @id;
    `);
    res.json({ ok: true });
  } catch (e) { console.error('[payroll/mark-paid]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// DELETE /runs/:id — only if draft + no payslips
router.delete('/runs/:id', hrOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query("SELECT Status, (SELECT COUNT(*) FROM HRM_Payslip WHERE RunId = @id) AS Cnt FROM HRM_Payroll_Run WHERE RunId = @id;");
    const cur = r.recordset[0];
    if (!cur)                   return res.status(404).json({ message: 'Not found' });
    if (cur.Status !== 'draft') return res.status(400).json({ message: 'Only draft runs can be deleted' });
    if (cur.Cnt > 0)            return res.status(400).json({ message: 'Run has processed payslips; reprocess won\'t help — please process to clear, or contact admin' });
    await pool.request().input('id', sql.Int, id).query('DELETE FROM HRM_Payroll_Run WHERE RunId = @id;');
    res.json({ ok: true });
  } catch (e) { console.error('[payroll/delete-run]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ───────────────────────────────────────────────────────────────────────────
// Payslips — employee + HR
// ───────────────────────────────────────────────────────────────────────────

// GET /payslips/mine?year=YYYY — own locked/paid payslips
router.get('/payslips/mine', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  try {
    const pool = await getAppPool();
    const r = pool.request().input('uid', sql.Int, req.user.id);
    // Both HRM_Payslip and HRM_Payroll_Run carry Status + CreatedAt columns —
    // every reference MUST be table-prefixed or SQL Server errors with
    // "Ambiguous column name". Filter by the year of the PERIOD, not row creation,
    // so a payslip processed in April for the March period filters correctly.
    let where = "P.UserId = @uid AND P.Status IN ('locked','paid')";
    if (Number.isFinite(year)) {
      r.input('y', sql.Int, year);
      where += ' AND YEAR(R.PeriodStart) = @y';
    }
    const result = await r.query(`
      SELECT P.PayslipId, P.PayslipNo, P.Status, P.MonthlyGross, P.TotalDeductions, P.NetPay,
             P.PayableDays, P.LopDays, P.DaysInMonth, P.CreatedAt,
             R.FYMonthCode, R.PeriodStart, R.PeriodEnd, R.PayDate, R.MonthNo, R.FYYear
      FROM HRM_Payslip P
      JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
      WHERE ${where}
      ORDER BY R.PeriodStart DESC;
    `);
    res.json({ payslips: result.recordset });
  } catch (e) { console.error('[payslips/mine]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// Helper used by both /payslips/:id and /payslips/:id/pdf
async function loadPayslipForUser(pool, payslipId, user) {
  const r = await pool.request().input('id', sql.Int, payslipId).query(`
    SELECT P.*,
           R.FYMonthCode, R.PeriodStart, R.PeriodEnd, R.PayDate, R.MonthNo, R.FYYear,
           R.Status AS RunStatus
    FROM HRM_Payslip P
    JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
    WHERE P.PayslipId = @id;
  `);
  const ps = r.recordset[0];
  if (!ps) return { ps: null, canRead: false };
  const isSelf = ps.UserId === user.id;
  const isHr   = isLensAdmin(user);
  // Employees can only see their own LOCKED or PAID payslips
  if (!isHr && !(isSelf && (ps.Status === 'locked' || ps.Status === 'paid'))) {
    return { ps, canRead: false };
  }
  return { ps, canRead: true };
}

// GET /payslips/:id — header + lines (self or HR)
router.get('/payslips/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const { ps, canRead } = await loadPayslipForUser(pool, id, req.user);
    if (!ps)      return res.status(404).json({ message: 'Payslip not found' });
    if (!canRead) return res.status(403).json({ message: 'Not allowed' });
    const lQ = await pool.request().input('id', sql.Int, id).query(`
      SELECT ComponentCode, ComponentName, Kind, FullMonthlyAmt, EarnedAmount, FormulaSummary, DisplayOrder
      FROM HRM_Payslip_Line WHERE PayslipId = @id ORDER BY DisplayOrder, ComponentCode;
    `);
    res.json({ payslip: ps, lines: lQ.recordset });
  } catch (e) { console.error('[payslips/detail]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// GET /payslips/:id/pdf — auth-gated stream
router.get('/payslips/:id/pdf', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const { ps, canRead } = await loadPayslipForUser(pool, id, req.user);
    if (!ps)      return res.status(404).json({ message: 'Payslip not found' });
    if (!canRead) return res.status(403).json({ message: 'Not allowed' });

    const data = await fetchPayslipData(pool, id);
    const safe = (ps.PayslipNo || ('PS' + id)).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Payslip_${safe}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    streamPayslipPdf(data, res);
  } catch (e) {
    console.error('[payslips/pdf]', e);
    if (!res.headersSent) res.status(500).json({ message: 'Failed to generate PDF', error: e.message });
    else res.end();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// YTD STATEMENT (Phase 5C)
// ───────────────────────────────────────────────────────────────────────────

// GET /ytd/mine?fy=YYYY — own FY aggregation (locked or paid payslips only)
router.get('/ytd/mine', async (req, res) => {
  const fy = parseInt(req.query.fy, 10) || fyOfDate(new Date());
  try {
    const pool = await getAppPool();
    const data = await ytdFor(pool, req.user.id, fy);
    res.json(data);
  } catch (e) { console.error('[ytd/mine]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// GET /ytd/all?fy=YYYY — HR-wide YTD summary
router.get('/ytd/all', hrOnly, async (req, res) => {
  const fy = parseInt(req.query.fy, 10) || fyOfDate(new Date());
  try {
    const pool = await getAppPool();
    const fyStart = new Date(fy, 3, 1);
    const fyEnd   = new Date(fy + 1, 2, 31);
    const r = await pool.request()
      .input('ps', sql.Date, fyStart).input('pe', sql.Date, fyEnd)
      .query(`
        SELECT
          P.UserId,
          MAX(P.EmpCode) AS EmpCode,
          MAX(P.EmpName) AS EmpName,
          MAX(P.Department) AS Department,
          COUNT(*) AS PayslipCount,
          SUM(P.MonthlyGross)    AS TotalGross,
          SUM(P.TotalDeductions) AS TotalDeductions,
          SUM(P.NetPay)          AS TotalNet,
          SUM(P.LopDays)         AS LopDays
        FROM HRM_Payslip P
        JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
        WHERE R.PeriodStart BETWEEN @ps AND @pe
          AND P.Status IN ('locked','paid')
        GROUP BY P.UserId
        ORDER BY MAX(P.EmpCode);
      `);
    res.json({ fy, fyLabel: `FY${fy}-${String((fy+1)%100).padStart(2,'0')}`, employees: r.recordset });
  } catch (e) { console.error('[ytd/all]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// GET /ytd/employee/:userId?fy= — HR drill-down for one employee
router.get('/ytd/employee/:userId', hrOnly, async (req, res) => {
  const uid = parseInt(req.params.userId, 10);
  const fy  = parseInt(req.query.fy, 10) || fyOfDate(new Date());
  if (!Number.isFinite(uid)) return res.status(400).json({ message: 'Invalid userId' });
  try {
    const pool = await getAppPool();
    const data = await ytdFor(pool, uid, fy);
    res.json(data);
  } catch (e) { console.error('[ytd/emp]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

async function ytdFor(pool, userId, fy) {
  const fyStart = new Date(fy, 3, 1);
  const fyEnd   = new Date(fy + 1, 2, 31);
  // Per-month rollup (header level)
  const mQ = await pool.request()
    .input('uid', sql.Int, userId)
    .input('ps',  sql.Date, fyStart).input('pe', sql.Date, fyEnd)
    .query(`
      SELECT R.MonthNo, R.FYYear, R.FYMonthCode, R.PeriodStart,
             P.PayslipId, P.PayslipNo, P.MonthlyGross, P.TotalDeductions, P.NetPay,
             P.DaysInMonth, P.LopDays, P.PayableDays, P.Status
      FROM HRM_Payslip P
      JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
      WHERE P.UserId = @uid
        AND P.Status IN ('locked','paid')
        AND R.PeriodStart BETWEEN @ps AND @pe
      ORDER BY R.PeriodStart;
    `);
  const months = mQ.recordset;

  // Per-component rollup
  const cQ = await pool.request()
    .input('uid', sql.Int, userId)
    .input('ps',  sql.Date, fyStart).input('pe', sql.Date, fyEnd)
    .query(`
      SELECT L.ComponentCode, MAX(L.ComponentName) AS ComponentName, MAX(L.Kind) AS Kind,
             SUM(L.EarnedAmount) AS YTDAmount,
             COUNT(*) AS MonthsPaid,
             MAX(L.DisplayOrder) AS DisplayOrder
      FROM HRM_Payslip_Line L
      JOIN HRM_Payslip P ON P.PayslipId = L.PayslipId
      JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
      WHERE P.UserId = @uid
        AND P.Status IN ('locked','paid')
        AND R.PeriodStart BETWEEN @ps AND @pe
      GROUP BY L.ComponentCode
      ORDER BY MAX(L.DisplayOrder), L.ComponentCode;
    `);
  const components = cQ.recordset;

  // Employee identity (latest payslip)
  const eQ = await pool.request().input('uid', sql.Int, userId).query(`
    SELECT TOP 1 EmpCode, EmpName, Designation, Department, PAN, UAN
    FROM HRM_Payslip WHERE UserId = @uid ORDER BY CreatedAt DESC;
  `);

  const totals = months.reduce((a, m) => ({
    gross:      a.gross      + Number(m.MonthlyGross    || 0),
    deductions: a.deductions + Number(m.TotalDeductions || 0),
    net:        a.net        + Number(m.NetPay          || 0),
    lopDays:    a.lopDays    + Number(m.LopDays         || 0),
  }), { gross: 0, deductions: 0, net: 0, lopDays: 0 });

  return {
    fy, fyLabel: `FY${fy}-${String((fy+1)%100).padStart(2,'0')}`,
    employee: eQ.recordset[0] || null,
    months, components, totals,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = router;
