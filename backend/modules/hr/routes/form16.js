// =====================================================================
// modules/hr/routes/form16.js — Form 16 Part A upload + Part B gen (Phase 5E)
// Mounted at /api/hr/form16/* by ../index.js
//
// Endpoints:
//   Everyone:
//     GET    /mine?fy=                — list own Form 16 rows
//     GET    /:id/part-a              — download Part A (self or HR)
//     GET    /:id/part-b              — generate + stream Part B PDF (self or HR)
//
//   HR:
//     GET    /all?fy=                 — all employees with payslips for the FY
//     POST   /:userId/upload-part-a   — multipart upload TRACES Part A
//     POST   /:userId/generate-part-b — pre-generate Part B (no PDF stream — refreshes HRM_Form16 totals)
// =====================================================================

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');
const { fetchForm16Data, streamForm16PartB } = require('../../../services/form16Pdf');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'hr', 'form16-parta');
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch (_) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, String(req.params.userId), String(req.body.fy || new Date().getFullYear()));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${stamp}_${safe}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(authenticate);

// GET /mine?fy=
router.get('/mine', async (req, res) => {
  const fy = parseInt(req.query.fy, 10);
  try {
    const pool = await getAppPool();
    const r = pool.request().input('uid', sql.Int, req.user.id);
    let where = 'UserId = @uid';
    if (Number.isFinite(fy)) { r.input('fy', sql.Int, fy); where += ' AND FYYear = @fy'; }
    const result = await r.query(`
      SELECT Form16Id, FYYear, PartAFileName, PartAUploadedAt, PartBGeneratedAt,
             GrossSalary, TaxableIncome, TaxOnIncome, Regime, TANNumber, Form24QAckNo
      FROM HRM_Form16 WHERE ${where}
      ORDER BY FYYear DESC;
    `);
    res.json({ forms: result.recordset });
  } catch (e) { console.error('[form16/mine]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// GET /all (HR) — every employee with payslips for the FY + Form 16 status
router.get('/all', async (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  const fy = parseInt(req.query.fy, 10);
  if (!Number.isFinite(fy)) return res.status(400).json({ message: 'fy required' });
  try {
    const pool = await getAppPool();
    const fyStart = new Date(fy, 3, 1), fyEnd = new Date(fy + 1, 2, 31);
    const r = await pool.request()
      .input('fy', sql.Int, fy).input('ps', sql.Date, fyStart).input('pe', sql.Date, fyEnd)
      .query(`
        SELECT
          U.Id AS UserId, U.Name AS EmpName, E.EmpCode, E.Department, E.PAN,
          (SELECT COUNT(*) FROM HRM_Payslip P JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
            WHERE P.UserId = U.Id AND P.Status IN ('locked','paid')
              AND R.PeriodStart BETWEEN @ps AND @pe) AS MonthsPaid,
          F.Form16Id, F.PartAFileName, F.PartAUploadedAt, F.PartBGeneratedAt,
          F.GrossSalary, F.TaxOnIncome
        FROM User_Login U
        LEFT JOIN HRM_Employee E ON E.UserId = U.Id
        LEFT JOIN HRM_Form16 F ON F.UserId = U.Id AND F.FYYear = @fy
        WHERE U.IsActive = 1
        ORDER BY E.EmpCode;
      `);
    res.json({ employees: r.recordset });
  } catch (e) { console.error('[form16/all]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// POST /:userId/upload-part-a — HR uploads TRACES Part A
router.post('/:userId/upload-part-a', (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  const uid = parseInt(req.params.userId, 10);
  if (!Number.isFinite(uid)) return res.status(400).json({ message: 'Invalid userId' });
  upload.single('file')(req, res, async (err) => {
    if (err)        return res.status(400).json({ message: 'Upload failed', error: err.message });
    if (!req.file)  return res.status(400).json({ message: 'No file' });
    const fy = parseInt(req.body.fy, 10);
    if (!Number.isFinite(fy)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ message: 'fy required' }); }
    try {
      const pool = await getAppPool();
      await pool.request()
        .input('uid', sql.Int, uid).input('fy', sql.Int, fy)
        .input('fn',  sql.NVarChar(255), req.file.originalname)
        .input('sp',  sql.NVarChar(600), req.file.path)
        .input('by',  sql.Int, req.user.id)
        .input('tan', sql.NVarChar(20),  req.body.tan || null)
        .input('ack', sql.NVarChar(30),  req.body.form24QAckNo || null)
        .query(`
          MERGE INTO HRM_Form16 AS T
          USING (SELECT @uid AS UserId, @fy AS FYYear) AS S
          ON T.UserId = S.UserId AND T.FYYear = S.FYYear
          WHEN MATCHED THEN UPDATE SET
            PartAFileName = @fn, PartAStoredPath = @sp,
            PartAUploadedAt = SYSDATETIME(), PartAUploadedBy = @by,
            TANNumber = @tan, Form24QAckNo = @ack, UpdatedAt = SYSDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (UserId, FYYear, PartAFileName, PartAStoredPath, PartAUploadedAt, PartAUploadedBy, TANNumber, Form24QAckNo)
            VALUES (@uid, @fy, @fn, @sp, SYSDATETIME(), @by, @tan, @ack);
        `);
      res.status(201).json({ ok: true });
    } catch (e) { console.error('[form16/upload]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
  });
});

// POST /:userId/generate-part-b — pre-aggregate + persist (used by HR batch)
router.post('/:userId/generate-part-b', async (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  const uid = parseInt(req.params.userId, 10);
  const fy  = parseInt(req.body?.fy, 10);
  if (!Number.isFinite(uid) || !Number.isFinite(fy)) return res.status(400).json({ message: 'Invalid params' });
  try {
    const pool = await getAppPool();
    const data = await fetchForm16Data(pool, uid, fy);
    res.json({ ok: true, summary: { grossSalary: data.grossSalary, taxableIncome: data.taxableIncome, taxOnIncome: data.taxOnIncome } });
  } catch (e) { console.error('[form16/gen]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// GET /:id/part-a — download Part A (self or HR)
router.get('/:id/part-a', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT UserId, FYYear, PartAFileName, PartAStoredPath FROM HRM_Form16 WHERE Form16Id = @id;');
    const row = r.recordset[0];
    if (!row || !row.PartAStoredPath) return res.status(404).json({ message: 'Part A not uploaded' });
    if (row.UserId !== req.user.id && !isLensAdmin(req.user)) return res.status(403).json({ message: 'Not allowed' });
    if (!fs.existsSync(row.PartAStoredPath)) return res.status(410).json({ message: 'File missing' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Form16_PartA_FY${row.FYYear}.pdf"`);
    fs.createReadStream(row.PartAStoredPath).pipe(res);
  } catch (e) { console.error('[form16/part-a]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// GET /:id/part-b — generate Part B PDF (self or HR)
router.get('/:id/part-b', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT UserId, FYYear FROM HRM_Form16 WHERE Form16Id = @id;');
    const row = r.recordset[0];
    if (!row) return res.status(404).json({ message: 'Not found' });
    if (row.UserId !== req.user.id && !isLensAdmin(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const data = await fetchForm16Data(pool, row.UserId, row.FYYear);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Form16_PartB_FY${row.FYYear}.pdf"`);
    streamForm16PartB(data, res);
  } catch (e) {
    console.error('[form16/part-b]', e);
    if (!res.headersSent) res.status(500).json({ message: 'Failed', error: e.message });
    else res.end();
  }
});

module.exports = router;
