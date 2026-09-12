// =====================================================================
// modules/hr/routes/itDeclaration.js — IT Declaration + Statement (Phase 5D)
// Mounted at /api/hr/it-declaration/* by ../index.js
//
// Endpoints:
//   Everyone (self-scoped):
//     GET    /options                    — sections + sub-categories
//     GET    /mine?fy=YYYY               — own declaration (creates draft if absent)
//     POST   /mine                       — upsert header (regime, draft saves)
//     POST   /mine/submit                — lock + submit for HR approval
//     POST   /mine/items                 — add item
//     PATCH  /mine/items/:id             — update item
//     DELETE /mine/items/:id             — remove item
//     POST   /mine/items/:id/proof       — upload proof file (multipart)
//     GET    /mine/items/:id/proof       — download own proof
//     GET    /statement?fy=YYYY          — projected tax statement (own)
//
//   HR (LENS_ADMIN_ROLES):
//     GET    /all?fy=YYYY&status=        — review queue
//     GET    /:id                        — full detail (header + items)
//     POST   /:id/approve                — approve whole declaration (all items must be decided)
//     POST   /:id/reject                 — reject with reason
//     PATCH  /items/:id/decision         — approve/reject one item w/ optional partial approval
// =====================================================================

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');
const { computeTax, computeHraExemption, recommendRegime } = require('../../../services/taxEngine');
const wf = require('../../../services/workflowEngine');     // Phase 6B — multi-level workflow integration

const SECTIONS = [
  { code: '80C',      label: 'Section 80C',        cap: 150000, subCategories: ['LIC Premium','PPF','EPF','ELSS Mutual Funds','NSC','5-Year FD','Sukanya Samriddhi','Tuition Fees','Home Loan Principal','Other 80C'] },
  { code: '80D',      label: 'Section 80D (Mediclaim)', cap: 50000, subCategories: ['Self + Spouse + Children','Parents (Non-Senior)','Parents (Senior Citizen)','Preventive Health Checkup'] },
  { code: '80E',      label: 'Section 80E (Education Loan Interest)', cap: null, subCategories: ['Education Loan'] },
  { code: '80G',      label: 'Section 80G (Donations)', cap: null, subCategories: ['Approved Charity 50% Limit','Approved Charity No Limit'] },
  { code: '80TTA',    label: 'Section 80TTA (Savings Interest)', cap: 10000, subCategories: ['Savings A/c Interest'] },
  { code: 'HRA',      label: 'HRA Exemption',      cap: null,   subCategories: ['Rent Paid'] },
  { code: 'HomeLoan', label: 'Home Loan Interest', cap: 200000, subCategories: ['Self-Occupied Property','Let-Out Property'] },
  { code: 'Other',    label: 'Other Income / Loss',cap: null,   subCategories: ['House Property Loss','Other Income'] },
];

function fyOfDate(d) { const m = d.getMonth(); return m >= 3 ? d.getFullYear() : d.getFullYear() - 1; }

const UPLOAD_ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'hr', 'it-proofs');
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch (_) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, String(req.params.declarationId || 'misc'));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${stamp}_${safe}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },   // 5 MB per proof
});

router.use(authenticate);

// ── GET /options ─────────────────────────────────────────────────────────────
router.get('/options', (req, res) => {
  res.json({ sections: SECTIONS, regimes: ['Old', 'New'] });
});

// ── Self-scoped helpers ────────────────────────────────────────────────────
async function loadOrCreateDeclaration(pool, userId, fy) {
  const r = await pool.request().input('uid', sql.Int, userId).input('fy', sql.Int, fy)
    .query('SELECT * FROM HRM_IT_Declaration WHERE UserId = @uid AND FYYear = @fy;');
  if (r.recordset.length) return r.recordset[0];
  const ins = await pool.request().input('uid', sql.Int, userId).input('fy', sql.Int, fy).query(`
    INSERT INTO HRM_IT_Declaration (UserId, FYYear, Regime, Status) OUTPUT INSERTED.*
    VALUES (@uid, @fy, 'Old', 'draft');
  `);
  return ins.recordset[0];
}

async function loadDeclarationItems(pool, declarationId) {
  const r = await pool.request().input('id', sql.Int, declarationId).query(`
    SELECT ItemId, SectionCode, SubCategory, DeclaredAmount, ApprovedAmount, Notes,
           ProofFileName, ProofMimeType, ProofFileSize,
           Status, DecidedBy, DecidedAt, RejectionReason, CreatedAt
    FROM HRM_IT_Declaration_Item WHERE DeclarationId = @id ORDER BY SectionCode, ItemId;
  `);
  return r.recordset;
}

// ── GET /mine ───────────────────────────────────────────────────────────────
router.get('/mine', async (req, res) => {
  const fy = parseInt(req.query.fy, 10) || fyOfDate(new Date());
  try {
    const pool = await getAppPool();
    const dec  = await loadOrCreateDeclaration(pool, req.user.id, fy);
    const items = await loadDeclarationItems(pool, dec.DeclarationId);
    res.json({ declaration: dec, items });
  } catch (e) { console.error('[it/mine]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── POST /mine — upsert regime / quick header save ───────────────────────────
router.post('/mine', async (req, res) => {
  const fy = parseInt(req.body?.fy, 10) || fyOfDate(new Date());
  const regime = (req.body?.regime === 'New') ? 'New' : 'Old';
  try {
    const pool = await getAppPool();
    const dec = await loadOrCreateDeclaration(pool, req.user.id, fy);
    if (dec.Status === 'submitted' || dec.Status === 'approved') {
      return res.status(400).json({ message: 'Cannot edit a ' + dec.Status + ' declaration' });
    }
    await pool.request().input('id', sql.Int, dec.DeclarationId).input('rg', sql.NVarChar(10), regime)
      .query("UPDATE HRM_IT_Declaration SET Regime = @rg, Status = 'draft', UpdatedAt = SYSDATETIME() WHERE DeclarationId = @id;");
    res.json({ ok: true, declarationId: dec.DeclarationId });
  } catch (e) { console.error('[it/upsert]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── POST /mine/submit ───────────────────────────────────────────────────────
router.post('/mine/submit', async (req, res) => {
  const fy = parseInt(req.body?.fy, 10) || fyOfDate(new Date());
  try {
    const pool = await getAppPool();
    const dec = await loadOrCreateDeclaration(pool, req.user.id, fy);
    if (!['draft','rejected'].includes(dec.Status)) {
      return res.status(400).json({ message: 'Already ' + dec.Status });
    }
    const items = await loadDeclarationItems(pool, dec.DeclarationId);
    const total = items.reduce((s, it) => s + Number(it.DeclaredAmount || 0), 0);
    await pool.request().input('id', sql.Int, dec.DeclarationId).input('t', sql.Decimal(15,2), total).query(`
      UPDATE HRM_IT_Declaration
      SET Status = 'submitted', SubmittedAt = SYSDATETIME(), TotalDeclared = @t,
          RejectionReason = NULL, UpdatedAt = SYSDATETIME()
      WHERE DeclarationId = @id;
      UPDATE HRM_IT_Declaration_Item SET Status = 'pending', UpdatedAt = SYSDATETIME()
      WHERE DeclarationId = @id;
    `);

    // Phase 6B: try to attach a multi-level workflow. Failures must not fail the submit.
    let workflowInfo = null;
    try {
      const empQ = await pool.request().input('uid', sql.Int, req.user.id)
        .query('SELECT Department FROM HRM_Employee WHERE UserId = @uid;');
      const dept = empQ.recordset[0]?.Department || null;
      const wfDef = await wf.selectWorkflow(pool, 'ITDeclaration', { amount: total, department: dept });
      if (wfDef) {
        await wf.startInstance(pool, 'ITDeclaration', dec.DeclarationId, req.user.id, wfDef);
        workflowInfo = { workflowCode: wfDef.Code, workflowName: wfDef.Name, totalLevels: wfDef.levels.length, currentLevel: 1 };
      }
    } catch (wfErr) {
      console.warn('[it/submit wf-start]', wfErr.message);
    }

    res.json({ ok: true, workflow: workflowInfo });
  } catch (e) { console.error('[it/submit]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── POST /mine/items — add item ─────────────────────────────────────────────
router.post('/mine/items', async (req, res) => {
  const fy = parseInt(req.body?.fy, 10) || fyOfDate(new Date());
  const section = String(req.body?.sectionCode || '').trim();
  const sub     = String(req.body?.subCategory || '').trim();
  const amount  = Number(req.body?.declaredAmount);
  const notes   = req.body?.notes || null;
  if (!SECTIONS.find(s => s.code === section)) return res.status(400).json({ message: 'Invalid section' });
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ message: 'Invalid amount' });
  try {
    const pool = await getAppPool();
    const dec = await loadOrCreateDeclaration(pool, req.user.id, fy);
    if (!['draft','rejected'].includes(dec.Status)) {
      return res.status(400).json({ message: 'Declaration is locked (status=' + dec.Status + ')' });
    }
    const r = await pool.request()
      .input('did',  sql.Int,           dec.DeclarationId)
      .input('s',    sql.NVarChar(20),  section)
      .input('sub',  sql.NVarChar(100), sub || null)
      .input('amt',  sql.Decimal(15,2), amount)
      .input('n',    sql.NVarChar(sql.MAX), notes)
      .query(`
        INSERT INTO HRM_IT_Declaration_Item (DeclarationId, SectionCode, SubCategory, DeclaredAmount, Notes)
        OUTPUT INSERTED.*
        VALUES (@did, @s, @sub, @amt, @n);
      `);
    res.status(201).json({ item: r.recordset[0] });
  } catch (e) { console.error('[it/add-item]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── PATCH /mine/items/:id ───────────────────────────────────────────────────
router.patch('/mine/items/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const cur = await pool.request().input('id', sql.Int, id).query(`
      SELECT I.*, D.UserId, D.Status AS DStatus
      FROM HRM_IT_Declaration_Item I JOIN HRM_IT_Declaration D ON D.DeclarationId = I.DeclarationId
      WHERE I.ItemId = @id;
    `);
    const row = cur.recordset[0];
    if (!row) return res.status(404).json({ message: 'Not found' });
    if (row.UserId !== req.user.id) return res.status(403).json({ message: 'Not allowed' });
    if (!['draft','rejected'].includes(row.DStatus)) return res.status(400).json({ message: 'Declaration locked' });

    const b = req.body || {};
    const r = pool.request().input('id', sql.Int, id);
    const sets = [];
    if (b.subCategory    != null) { r.input('sub', sql.NVarChar(100), String(b.subCategory)); sets.push('SubCategory = @sub'); }
    if (b.declaredAmount != null) {
      const amt = Number(b.declaredAmount);
      if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ message: 'Invalid amount' });
      r.input('amt', sql.Decimal(15,2), amt); sets.push('DeclaredAmount = @amt');
    }
    if (b.notes !== undefined) { r.input('n', sql.NVarChar(sql.MAX), b.notes || null); sets.push('Notes = @n'); }
    if (!sets.length) return res.json({ ok: true, noChanges: true });
    sets.push('UpdatedAt = SYSDATETIME()');
    await r.query(`UPDATE HRM_IT_Declaration_Item SET ${sets.join(', ')} WHERE ItemId = @id;`);
    res.json({ ok: true });
  } catch (e) { console.error('[it/patch-item]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.delete('/mine/items/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const cur = await pool.request().input('id', sql.Int, id).query(`
      SELECT D.UserId, D.Status AS DStatus FROM HRM_IT_Declaration_Item I
      JOIN HRM_IT_Declaration D ON D.DeclarationId = I.DeclarationId WHERE I.ItemId = @id;
    `);
    const row = cur.recordset[0];
    if (!row) return res.status(404).json({ message: 'Not found' });
    if (row.UserId !== req.user.id) return res.status(403).json({ message: 'Not allowed' });
    if (!['draft','rejected'].includes(row.DStatus)) return res.status(400).json({ message: 'Declaration locked' });
    await pool.request().input('id', sql.Int, id).query('DELETE FROM HRM_IT_Declaration_Item WHERE ItemId = @id;');
    res.json({ ok: true });
  } catch (e) { console.error('[it/del-item]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── POST /mine/items/:id/proof — upload PDF/img ─────────────────────────────
router.post('/items/:id/proof', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  upload.single('file')(req, res, async (err) => {
    if (err)        return res.status(400).json({ message: 'Upload failed', error: err.message });
    if (!req.file)  return res.status(400).json({ message: 'No file' });
    try {
      const pool = await getAppPool();
      const cur = await pool.request().input('id', sql.Int, id).query(`
        SELECT D.UserId, D.Status AS DStatus, D.DeclarationId FROM HRM_IT_Declaration_Item I
        JOIN HRM_IT_Declaration D ON D.DeclarationId = I.DeclarationId WHERE I.ItemId = @id;
      `);
      const row = cur.recordset[0];
      if (!row) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ message: 'Not found' }); }
      if (row.UserId !== req.user.id) { fs.unlink(req.file.path, () => {}); return res.status(403).json({ message: 'Not allowed' }); }
      // Move file to the correct DeclarationId folder if necessary
      const targetDir = path.join(UPLOAD_ROOT, String(row.DeclarationId));
      fs.mkdirSync(targetDir, { recursive: true });
      const finalPath = path.join(targetDir, req.file.filename);
      if (finalPath !== req.file.path) {
        try { fs.renameSync(req.file.path, finalPath); } catch (_) {}
      }
      await pool.request()
        .input('id',   sql.Int,           id)
        .input('fn',   sql.NVarChar(255), req.file.originalname)
        .input('sp',   sql.NVarChar(600), finalPath)
        .input('mt',   sql.NVarChar(150), req.file.mimetype)
        .input('sz',   sql.BigInt,        req.file.size)
        .query(`
          UPDATE HRM_IT_Declaration_Item
          SET ProofFileName = @fn, ProofStoredPath = @sp, ProofMimeType = @mt, ProofFileSize = @sz,
              UpdatedAt = SYSDATETIME()
          WHERE ItemId = @id;
        `);
      res.status(201).json({ ok: true });
    } catch (e) { console.error('[it/upload]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
  });
});

// ── GET /items/:id/proof — download (self or HR) ────────────────────────────
router.get('/items/:id/proof', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const cur = await pool.request().input('id', sql.Int, id).query(`
      SELECT I.ProofFileName, I.ProofStoredPath, I.ProofMimeType, D.UserId
      FROM HRM_IT_Declaration_Item I JOIN HRM_IT_Declaration D ON D.DeclarationId = I.DeclarationId
      WHERE I.ItemId = @id;
    `);
    const row = cur.recordset[0];
    if (!row || !row.ProofStoredPath) return res.status(404).json({ message: 'No proof uploaded' });
    if (row.UserId !== req.user.id && !isLensAdmin(req.user)) return res.status(403).json({ message: 'Not allowed' });
    if (!fs.existsSync(row.ProofStoredPath)) return res.status(410).json({ message: 'File missing on disk' });
    if (row.ProofMimeType) res.setHeader('Content-Type', row.ProofMimeType);
    res.setHeader('Content-Disposition', `inline; filename="${(row.ProofFileName || 'proof').replace(/"/g,'')}"`);
    fs.createReadStream(row.ProofStoredPath).pipe(res);
  } catch (e) { console.error('[it/dl-proof]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── GET /statement?fy= — projected tax statement (own) ───────────────────────
// Phase 6A rewrite: uses services/taxEngine for proper FY26-27 computation
// (surcharge bands + 4% cess + 87A rebate + marginal relief + HRA exemption +
// regime auto-recommendation). Pre-6A this was a 4-line slab estimator that
// gave wrong tax for anyone above ₹50L or anyone eligible for HRA exemption.
router.get('/statement', async (req, res) => {
  const fy = parseInt(req.query.fy, 10) || fyOfDate(new Date());
  try {
    const pool = await getAppPool();
    const fyStart = new Date(fy, 3, 1), fyEnd = new Date(fy + 1, 2, 31);

    // YTD payslip rollup + identify the active salary line for current-month figures
    const psQ = await pool.request().input('uid', sql.Int, req.user.id)
      .input('ps', sql.Date, fyStart).input('pe', sql.Date, fyEnd)
      .query(`
        SELECT ISNULL(SUM(P.MonthlyGross),0)    AS YTDGross,
               ISNULL(SUM(P.TotalDeductions),0) AS YTDDeductions,
               ISNULL(SUM(P.NetPay),0)          AS YTDNet,
               COUNT(*) AS MonthsPaid
        FROM HRM_Payslip P JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
        WHERE P.UserId = @uid AND P.Status IN ('locked','paid')
          AND R.PeriodStart BETWEEN @ps AND @pe;
      `);
    const ytd = psQ.recordset[0];

    // Pull active salary + monthly Basic + monthly HRA from the breakdown snapshot
    const empSal = await pool.request().input('uid', sql.Int, req.user.id).query(`
      SELECT TOP 1 SalaryId, CTC, MonthlyGross FROM HRM_Employee_Salary
      WHERE UserId = @uid AND Status = 'active' ORDER BY EffectiveFrom DESC;
    `);
    const monthlyGross = Number(empSal.recordset[0]?.MonthlyGross) || 0;
    const salaryId     = empSal.recordset[0]?.SalaryId;

    let monthlyBasic = 0, monthlyHraComp = 0, monthlyPT = 0;
    if (salaryId) {
      const cQ = await pool.request().input('sid', sql.Int, salaryId).query(`
        SELECT ComponentCode, MonthlyAmount FROM HRM_Employee_Salary_Component
        WHERE SalaryId = @sid AND ComponentCode IN ('BASIC','HRA','PT_MH');
      `);
      cQ.recordset.forEach(r => {
        if (r.ComponentCode === 'BASIC')  monthlyBasic   = Number(r.MonthlyAmount);
        if (r.ComponentCode === 'HRA')    monthlyHraComp = Number(r.MonthlyAmount);
        if (r.ComponentCode === 'PT_MH')  monthlyPT      = Number(r.MonthlyAmount);
      });
    }

    // Metro flag for HRA exemption rule
    const metroQ = await pool.request().input('uid', sql.Int, req.user.id)
      .query("SELECT TOP 1 ISNULL(IsMetroEmployee, 0) AS IsMetro FROM HRM_Employee WHERE UserId = @uid;");
    const isMetro = !!(metroQ.recordset[0]?.IsMetro);

    const remainingMonths = Math.max(0, 12 - Number(ytd.MonthsPaid || 0));
    const projectedAnnualGross = Number(ytd.YTDGross || 0) + monthlyGross * remainingMonths;
    const annualBasic    = monthlyBasic   * 12;
    const annualHraComp  = monthlyHraComp * 12;
    const annualPT       = monthlyPT      * 12;

    // Approved-or-declared per section
    const dec = await loadOrCreateDeclaration(pool, req.user.id, fy);
    const decTotals = await pool.request().input('id', sql.Int, dec.DeclarationId).query(`
      SELECT SectionCode, SUM(DeclaredAmount) AS Declared, SUM(ISNULL(ApprovedAmount, DeclaredAmount)) AS EffectiveDeduction
      FROM HRM_IT_Declaration_Item WHERE DeclarationId = @id GROUP BY SectionCode;
    `);
    const sectionMap = Object.fromEntries(SECTIONS.map(s => [s.code, s]));
    let chapterVIA = 0;
    let declaredAnnualRent = 0;
    const sections = decTotals.recordset.map(r => {
      const cap = sectionMap[r.SectionCode]?.cap;
      const effective = cap != null ? Math.min(Number(r.EffectiveDeduction), cap) : Number(r.EffectiveDeduction);
      // HRA is a Section 10 exemption — NOT part of Chapter VI-A. Track separately.
      if (r.SectionCode === 'HRA') {
        declaredAnnualRent = Number(r.EffectiveDeduction);   // user enters annual rent paid here
      } else {
        chapterVIA += effective;
      }
      return {
        sectionCode:        r.SectionCode,
        sectionLabel:       sectionMap[r.SectionCode]?.label,
        declared:           Number(r.Declared),
        effectiveDeduction: effective,
        cap,
      };
    });

    // HRA exemption (annual). Reuses the engine — no inline math here.
    const hra = computeHraExemption({
      rentPaid:     declaredAnnualRent,
      basic:        annualBasic,
      hraComponent: annualHraComp,
      isMetro,
    });

    // Regime recommendation
    const reco = recommendRegime({
      grossSalary:  projectedAnnualGross,
      ptDeducted:   annualPT,
      chapterVIA,
      hraExempt:    hra.exempt,
    });

    // Tax in current regime (whatever the user picked)
    const taxableInCurrent = (dec.Regime === 'Old')
      ? Math.max(0, projectedAnnualGross - 50000 - annualPT - chapterVIA - hra.exempt)
      : Math.max(0, projectedAnnualGross - 50000 - annualPT);
    const taxResult = computeTax({ taxableIncome: taxableInCurrent, regime: dec.Regime });

    res.json({
      fy, fyLabel: `FY${fy}-${String((fy+1)%100).padStart(2,'0')}`,
      declaration: dec, sections,
      ytd: {
        gross: Number(ytd.YTDGross || 0), deductions: Number(ytd.YTDDeductions || 0),
        net: Number(ytd.YTDNet || 0), monthsPaid: Number(ytd.MonthsPaid || 0),
      },
      projectedAnnualGross,
      annualBasic, annualHraComp, annualPT, declaredAnnualRent, isMetro,
      hraExemption: hra,
      chapterVIA,
      standardDeduction: 50000,
      taxableIncome: taxableInCurrent,
      tax: taxResult,           // full breakdown: base / rebate / surcharge / cess / total
      regimeRecommendation: reco,
      remainingMonths,
    });
  } catch (e) { console.error('[it/statement]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────
// HR endpoints
// ────────────────────────────────────────────────────────────────────────────
function hrOnly(req, res, next) {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  next();
}

// GET /all?fy=&status=
router.get('/all', hrOnly, async (req, res) => {
  const fy     = parseInt(req.query.fy, 10) || fyOfDate(new Date());
  const status = (req.query.status || '').toLowerCase();
  try {
    const pool = await getAppPool();
    const r = pool.request().input('fy', sql.Int, fy);
    let where = 'D.FYYear = @fy';
    if (status) { r.input('st', sql.NVarChar(15), status); where += ' AND D.Status = @st'; }
    const result = await r.query(`
      SELECT D.DeclarationId, D.UserId, D.FYYear, D.Regime, D.Status, D.TotalDeclared,
             D.SubmittedAt, D.DecidedAt, D.RejectionReason,
             U.Name AS EmpName, E.EmpCode, E.Department,
             (SELECT COUNT(*) FROM HRM_IT_Declaration_Item WHERE DeclarationId = D.DeclarationId) AS ItemCount,
             (SELECT COUNT(*) FROM HRM_IT_Declaration_Item WHERE DeclarationId = D.DeclarationId AND Status = 'pending') AS PendingCount,
             WI.CurrentLevel  AS WfCurrentLevel,
             WI.TotalLevels   AS WfTotalLevels,
             WI.CurrentReviewerUserId AS WfCurrentReviewerUserId,
             WD.Code          AS WfCode,
             WD.Name          AS WfName
      FROM HRM_IT_Declaration D
      JOIN User_Login U   ON U.Id = D.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = D.UserId
      LEFT JOIN HRM_Workflow_Instance WI ON WI.EntityKind = 'ITDeclaration' AND WI.EntityId = D.DeclarationId
      LEFT JOIN HRM_Workflow_Definition WD ON WD.WorkflowId = WI.WorkflowId
      WHERE ${where}
      ORDER BY D.SubmittedAt DESC, U.Name;
    `);
    res.json({ declarations: result.recordset });
  } catch (e) { console.error('[it/all]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// GET /:id — full detail
router.get('/:id', hrOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const pool = await getAppPool();
    const hQ = await pool.request().input('id', sql.Int, id).query(`
      SELECT D.*, U.Name AS EmpName, E.EmpCode, E.Department, E.PAN, E.Designation
      FROM HRM_IT_Declaration D
      JOIN User_Login U ON U.Id = D.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = D.UserId
      WHERE D.DeclarationId = @id;
    `);
    const dec = hQ.recordset[0];
    if (!dec) return res.status(404).json({ message: 'Not found' });
    const items = await loadDeclarationItems(pool, id);
    res.json({ declaration: dec, items });
  } catch (e) { console.error('[it/detail]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// PATCH /items/:id/decision — approve/reject one item (HR)
router.patch('/items/:id/decision', hrOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const b = req.body || {};
  const decision = (b.decision || '').toLowerCase();
  if (!['approved','rejected','pending'].includes(decision)) return res.status(400).json({ message: 'decision required' });
  try {
    const pool = await getAppPool();
    const r = pool.request().input('id', sql.Int, id).input('dec', sql.NVarChar(15), decision).input('by', sql.Int, req.user.id);
    let sets = ['Status = @dec', 'DecidedBy = @by', 'DecidedAt = SYSDATETIME()', 'UpdatedAt = SYSDATETIME()'];
    if (decision === 'approved') {
      const approved = b.approvedAmount != null ? Number(b.approvedAmount) : null;
      if (approved != null && (!Number.isFinite(approved) || approved < 0)) return res.status(400).json({ message: 'Invalid approvedAmount' });
      r.input('amt', sql.Decimal(15,2), approved);
      sets.push('ApprovedAmount = COALESCE(@amt, DeclaredAmount)');
      sets.push('RejectionReason = NULL');
    }
    if (decision === 'rejected') {
      r.input('rr', sql.NVarChar(500), b.rejectionReason || null);
      sets.push('RejectionReason = @rr');
      sets.push('ApprovedAmount = 0');
    }
    if (decision === 'pending') {
      sets.push('ApprovedAmount = NULL', 'RejectionReason = NULL');
    }
    await r.query(`UPDATE HRM_IT_Declaration_Item SET ${sets.join(', ')} WHERE ItemId = @id;`);
    res.json({ ok: true });
  } catch (e) { console.error('[it/decision]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// POST /:id/approve | /:id/reject — header decision
router.post('/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();

    // Phase 6B: workflow gate. If a multi-level workflow is attached, the
    // current-level reviewer (not just any HR) is the only one allowed to
    // approve. The legacy `hrOnly` middleware is bypassed for multi-level
    // because intermediate reviewers (e.g. Reporting Manager) may not be HR.
    const inst = await wf.getInstance(pool, 'ITDeclaration', id);
    if (inst && inst.Status === 'in-progress') {
      if (Number(inst.CurrentReviewerUserId) !== Number(req.user.id) && !isLensAdmin(req.user)) {
        return res.status(403).json({
          message: `Not your turn — waiting on ${inst.CurrentReviewerName || ('user ' + inst.CurrentReviewerUserId)} at level ${inst.CurrentLevel}/${inst.TotalLevels}`,
        });
      }
      // Final-level approval still requires the items to be decided
      if (inst.CurrentLevel >= inst.TotalLevels) {
        const p = await pool.request().input('id', sql.Int, id)
          .query("SELECT COUNT(*) AS Cnt FROM HRM_IT_Declaration_Item WHERE DeclarationId = @id AND Status = 'pending';");
        if (p.recordset[0].Cnt > 0) return res.status(400).json({ message: 'Decide all items first; ' + p.recordset[0].Cnt + ' still pending' });
      }
      const r = await wf.advance(pool, inst.InstanceId, 'approved', req.user.id, req.body?.note || null);
      if (r.status === 'in-progress') {
        return res.json({ ok: true, workflowAdvanced: true, currentLevel: r.currentLevel, totalLevels: r.totalLevels, nextReviewer: r.nextReviewer });
      }
      // Final approval — fall through
    } else {
      // No workflow → enforce HR-only fallback
      if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
    }

    const p = await pool.request().input('id', sql.Int, id)
      .query("SELECT COUNT(*) AS Cnt FROM HRM_IT_Declaration_Item WHERE DeclarationId = @id AND Status = 'pending';");
    if (p.recordset[0].Cnt > 0) return res.status(400).json({ message: 'Decide all items first; ' + p.recordset[0].Cnt + ' still pending' });
    await pool.request().input('id', sql.Int, id).input('by', sql.Int, req.user.id)
      .query("UPDATE HRM_IT_Declaration SET Status = 'approved', DecidedBy = @by, DecidedAt = SYSDATETIME() WHERE DeclarationId = @id;");
    res.json({ ok: true });
  } catch (e) { console.error('[it/approve]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.post('/:id/reject', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const reason = req.body?.reason || null;
  try {
    const pool = await getAppPool();

    // Phase 6B: same workflow gate as approve. Rejection at any level closes the chain.
    const inst = await wf.getInstance(pool, 'ITDeclaration', id);
    if (inst && inst.Status === 'in-progress') {
      if (Number(inst.CurrentReviewerUserId) !== Number(req.user.id) && !isLensAdmin(req.user)) {
        return res.status(403).json({
          message: `Not your turn — waiting on ${inst.CurrentReviewerName || ('user ' + inst.CurrentReviewerUserId)} at level ${inst.CurrentLevel}/${inst.TotalLevels}`,
        });
      }
      await wf.advance(pool, inst.InstanceId, 'rejected', req.user.id, reason);
      // Fall through to legacy reject (flips Status='rejected')
    } else {
      if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
    }

    await pool.request().input('id', sql.Int, id).input('by', sql.Int, req.user.id).input('rr', sql.NVarChar(500), reason).query(`
      UPDATE HRM_IT_Declaration SET Status = 'rejected', DecidedBy = @by, DecidedAt = SYSDATETIME(),
             RejectionReason = @rr WHERE DeclarationId = @id;
    `);
    res.json({ ok: true });
  } catch (e) { console.error('[it/reject]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

module.exports = router;
