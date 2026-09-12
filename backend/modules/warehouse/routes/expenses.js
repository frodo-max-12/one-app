// =====================================================================
// modules/warehouse/routes/expenses.js — Petty expense ledger (Company B SG)
//
// Pure-manual ledger. Warehouse user logs petty cash / non-PO expenses
// (paper, printer toner, courier handover fees, etc.) with date +
// explanation + amount.
//
// Same auth model as cheques.js: warehouse → CRUD, isFullAccess → read-only.
// =====================================================================

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const X = require('../_excel');

const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const COMPANY = 'COMPANYB';

function isWarehouseRole(user) {
  return ((user && user.role) || '').toLowerCase().trim() === 'warehouse';
}
function canRead(user)  { return isWarehouseRole(user) || isFullAccess(user); }
function canWrite(user) { return isWarehouseRole(user); }

// ── GET /api/warehouse/expenses ────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const search = (req.query.search || '').trim();
    const dateFrom = (req.query.dateFrom || '').trim();   // YYYY-MM-DD
    const dateTo   = (req.query.dateTo   || '').trim();
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const pool = await getAppPool();
    const r = pool.request();
    r.input('co', sql.NVarChar(10), COMPANY);
    r.input('offset', sql.Int, offset);
    r.input('limit',  sql.Int, limit);

    let where = 'WHERE Company = @co AND IsActive = 1';
    if (search) {
      r.input('q', sql.NVarChar(200), '%' + search + '%');
      where += ' AND (Explanation LIKE @q OR Remark LIKE @q)';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      r.input('df', sql.Date, dateFrom);
      where += ' AND ExpenseDate >= @df';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      r.input('dt', sql.Date, dateTo);
      where += ' AND ExpenseDate <= @dt';
    }

    const result = await r.query(`
      SELECT
        Id, ExpenseDate, Explanation, Amount, Currency, Remark,
        CreatedAt, UpdatedAt,
        COUNT(*) OVER () AS TotalRows,
        SUM(ISNULL(Amount, 0)) OVER () AS TotalAmount
      FROM dbo.BN_WhExpense
      ${where}
      ORDER BY ExpenseDate DESC, Id DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);
    const rows = result.recordset || [];
    res.json({
      data:        rows,
      total:       rows.length > 0 ? rows[0].TotalRows : 0,
      totalAmount: rows.length > 0 ? Number(rows[0].TotalAmount || 0) : 0,
      page, limit,
    });
  } catch (err) {
    console.error('GET /warehouse/expenses error:', err.message);
    res.status(500).json({ message: 'Failed to list expenses', error: err.message });
  }
});

// ── GET /api/warehouse/expenses/:id ────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const pool = await getAppPool();
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('co', sql.NVarChar(10), COMPANY)
      .query(`SELECT * FROM dbo.BN_WhExpense WHERE Id = @id AND Company = @co;`);
    if (!r.recordset.length) return res.status(404).json({ message: 'Expense not found' });
    res.json({ data: r.recordset[0] });
  } catch (err) {
    console.error('GET /warehouse/expenses/:id error:', err.message);
    res.status(500).json({ message: 'Failed to fetch expense', error: err.message });
  }
});

// ── POST /api/warehouse/expenses ───────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const b = req.body || {};
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co',        sql.NVarChar(10),  COMPANY);
    r.input('dt',        sql.Date,          b.ExpenseDate || null);
    r.input('exp',       sql.NVarChar(500), b.Explanation || null);
    r.input('amt',       sql.Decimal(18,2), b.Amount != null ? Number(b.Amount) : null);
    r.input('cur',       sql.NVarChar(10),  b.Currency || 'SGD');
    r.input('rmk',       sql.NVarChar(500), b.Remark || null);
    r.input('createdBy', sql.Int,           req.user.id);
    const result = await r.query(`
      INSERT INTO dbo.BN_WhExpense
        (Company, ExpenseDate, Explanation, Amount, Currency, Remark, CreatedBy)
      OUTPUT INSERTED.Id
      VALUES (@co, @dt, @exp, @amt, @cur, @rmk, @createdBy);
    `);
    res.status(201).json({ ok: true, Id: result.recordset[0].Id });
  } catch (err) {
    console.error('POST /warehouse/expenses error:', err.message);
    res.status(500).json({ message: 'Failed to create expense', error: err.message });
  }
});

// ── PUT /api/warehouse/expenses/:id ────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const b = req.body || {};
    const pool = await getAppPool();
    const r = pool.request();
    r.input('id',   sql.Int,           id);
    r.input('co',   sql.NVarChar(10),  COMPANY);
    r.input('dt',   sql.Date,          b.ExpenseDate || null);
    r.input('exp',  sql.NVarChar(500), b.Explanation || null);
    r.input('amt',  sql.Decimal(18,2), b.Amount != null ? Number(b.Amount) : null);
    r.input('cur',  sql.NVarChar(10),  b.Currency || 'SGD');
    r.input('rmk',  sql.NVarChar(500), b.Remark || null);
    const result = await r.query(`
      UPDATE dbo.BN_WhExpense SET
        ExpenseDate = @dt, Explanation = @exp, Amount = @amt,
        Currency = @cur, Remark = @rmk, UpdatedAt = SYSDATETIME()
      WHERE Id = @id AND Company = @co;
      SELECT @@ROWCOUNT AS Updated;
    `);
    if (!result.recordset[0].Updated) return res.status(404).json({ message: 'Expense not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /warehouse/expenses/:id error:', err.message);
    res.status(500).json({ message: 'Failed to update expense', error: err.message });
  }
});

// ── DELETE /api/warehouse/expenses/:id (soft delete) ───────────────────
router.delete('/:id', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const pool = await getAppPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('co', sql.NVarChar(10), COMPANY)
      .query(`
        UPDATE dbo.BN_WhExpense SET IsActive = 0, UpdatedAt = SYSDATETIME()
        WHERE Id = @id AND Company = @co;
        SELECT @@ROWCOUNT AS Deleted;
      `);
    if (!result.recordset[0].Deleted) return res.status(404).json({ message: 'Expense not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /warehouse/expenses/:id error:', err.message);
    res.status(500).json({ message: 'Failed to delete expense', error: err.message });
  }
});

// ── POST /api/warehouse/expenses/import ───────────────────────────────
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can import' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name = "file")' });
  try {
    const wb = X.xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheetName = X.resolveSheet(wb, ['expence', 'expense']);
    if (!sheetName) return res.status(400).json({ message: 'No Expense sheet found. Sheets: ' + wb.SheetNames.join(', ') });
    const { headers, rows } = X.readSheet(wb, sheetName);
    if (!rows.length) return res.json({ sheet: sheetName, inserted: 0, message: 'Sheet had no data rows' });
    const pool = await getAppPool();
    let wiped = 0;
    if (req.query.wipe === '1' || req.query.wipe === 'true') {
      const w = await pool.request().input('co', sql.NVarChar(10), COMPANY)
        .query(`UPDATE dbo.BN_WhExpense SET IsActive=0 WHERE Company=@co AND IsActive=1; SELECT @@ROWCOUNT AS Wiped;`);
      wiped = w.recordset[0].Wiped || 0;
    }
    let inserted = 0; let failed = 0; const errors = [];
    for (const r of rows) {
      try {
        const req2 = pool.request();
        req2.input('co',        sql.NVarChar(10),  COMPANY);
        req2.input('dt',        sql.Date,          X.toDate(X.cell(r, headers, 'Date','Expense Date','Exp Date')));
        req2.input('exp',       sql.NVarChar(500), X.toStr(X.cell(r, headers, 'Explanation','Description','Particulars','Reason','Remark')));
        req2.input('amt',       sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Amt','Amount','Value')));
        req2.input('cur',       sql.NVarChar(10),  X.toStr(X.cell(r, headers, 'Currency','Cur')) || 'SGD');
        req2.input('rmk',       sql.NVarChar(500), X.toStr(X.cell(r, headers, 'Remark','Remarks','Notes')));
        req2.input('createdBy', sql.Int,           req.user.id);
        await req2.query(`
          INSERT INTO dbo.BN_WhExpense (Company, ExpenseDate, Explanation, Amount, Currency, Remark, CreatedBy)
          VALUES (@co, @dt, @exp, @amt, @cur, @rmk, @createdBy);`);
        inserted++;
      } catch (e) { failed++; if (errors.length < 10) errors.push(e.message); }
    }
    res.json({ ok: true, sheet: sheetName, inserted, failed, wiped, errors });
  } catch (err) {
    console.error('POST /warehouse/expenses/import error:', err.message);
    res.status(500).json({ message: 'Import failed', error: err.message });
  }
});

// ── GET /api/warehouse/expenses/export ────────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co', sql.NVarChar(10), COMPANY);
    let where = 'WHERE Company = @co AND IsActive = 1';
    if (req.query.search) {
      r.input('q', sql.NVarChar(200), '%' + req.query.search + '%');
      where += ' AND (Explanation LIKE @q OR Remark LIKE @q)';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom || '')) {
      r.input('df', sql.Date, req.query.dateFrom); where += ' AND ExpenseDate >= @df';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo || '')) {
      r.input('dt', sql.Date, req.query.dateTo); where += ' AND ExpenseDate <= @dt';
    }
    const data = (await r.query(`
      SELECT ExpenseDate, Explanation, Amount, Currency, Remark
      FROM dbo.BN_WhExpense ${where} ORDER BY ExpenseDate DESC, Id DESC;`)).recordset;
    const buf = X.buildXlsx(data, [
      { key: 'ExpenseDate', label: 'Date', type: 'date' },
      { key: 'Explanation', label: 'Explanation' },
      { key: 'Amount',      label: 'Amount' },
      { key: 'Currency',    label: 'Currency' },
      { key: 'Remark',      label: 'Remark' },
    ], 'Expenses');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Expenses_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('GET /warehouse/expenses/export error:', err.message);
    res.status(500).json({ message: 'Export failed', error: err.message });
  }
});

module.exports = router;
