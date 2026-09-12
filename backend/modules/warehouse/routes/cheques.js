// =====================================================================
// modules/warehouse/routes/cheques.js — Cheque-issue ledger (Company B SG)
//
// Pure-manual ledger (no NAV joins). Warehouse user logs every cheque the
// office issues — typically Bank B SGD cheques to local couriers / suppliers
// — with the bank's pre-printed cheque number, payee, amount, dates.
//
// Auth:
//   role='warehouse'                      → full CRUD
//   admin/director/operation head/HR head → READ-only (oversight)
//   everyone else                          → 403
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

// ── GET /api/warehouse/cheques ──────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();   // Blank / Issued / Cleared / all
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
      where += ' AND (ChequeNo LIKE @q OR IssueTo LIKE @q OR Remark LIKE @q OR BankName LIKE @q)';
    }
    if (status && status.toLowerCase() !== 'all') {
      r.input('st', sql.NVarChar(20), status);
      where += ' AND BlankOrIssued = @st';
    }

    const result = await r.query(`
      SELECT
        Id, SrNo, BlankOrIssued, IssueDate, BankName, ChequeNo, ChequeDate,
        IssueTo, Currency, Amount, Remark, ClearingDate, ReceivedDate,
        CreatedAt, UpdatedAt,
        COUNT(*) OVER () AS TotalRows
      FROM dbo.BN_WhCheque
      ${where}
      ORDER BY IssueDate DESC, Id DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);
    const rows = result.recordset || [];
    const total = rows.length > 0 ? rows[0].TotalRows : 0;
    res.json({ data: rows, total, page, limit });
  } catch (err) {
    console.error('GET /warehouse/cheques error:', err.message);
    res.status(500).json({ message: 'Failed to list cheques', error: err.message });
  }
});

// ── GET /api/warehouse/cheques/:id ─────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const pool = await getAppPool();
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('co', sql.NVarChar(10), COMPANY)
      .query(`SELECT * FROM dbo.BN_WhCheque WHERE Id = @id AND Company = @co;`);
    if (!r.recordset.length) return res.status(404).json({ message: 'Cheque not found' });
    res.json({ data: r.recordset[0] });
  } catch (err) {
    console.error('GET /warehouse/cheques/:id error:', err.message);
    res.status(500).json({ message: 'Failed to fetch cheque', error: err.message });
  }
});

// ── POST /api/warehouse/cheques ────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const b = req.body || {};
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co',       sql.NVarChar(10),  COMPANY);
    r.input('srno',     sql.Int,           b.SrNo || null);
    r.input('boi',      sql.NVarChar(10),  b.BlankOrIssued || 'Blank');
    r.input('issdt',    sql.Date,          b.IssueDate || null);
    r.input('bank',     sql.NVarChar(50),  b.BankName || null);
    r.input('chno',     sql.NVarChar(50),  b.ChequeNo || null);
    r.input('chdt',     sql.Date,          b.ChequeDate || null);
    r.input('issto',    sql.NVarChar(200), b.IssueTo || null);
    r.input('cur',      sql.NVarChar(10),  b.Currency || 'SGD');
    r.input('amt',      sql.Decimal(18,2), b.Amount != null ? Number(b.Amount) : null);
    r.input('rmk',      sql.NVarChar(500), b.Remark || null);
    r.input('clrdt',    sql.Date,          b.ClearingDate || null);
    r.input('rcvdt',    sql.Date,          b.ReceivedDate || null);
    r.input('createdBy',sql.Int,           req.user.id);
    const result = await r.query(`
      INSERT INTO dbo.BN_WhCheque
        (Company, SrNo, BlankOrIssued, IssueDate, BankName, ChequeNo, ChequeDate,
         IssueTo, Currency, Amount, Remark, ClearingDate, ReceivedDate, CreatedBy)
      OUTPUT INSERTED.Id
      VALUES
        (@co, @srno, @boi, @issdt, @bank, @chno, @chdt, @issto, @cur, @amt,
         @rmk, @clrdt, @rcvdt, @createdBy);
    `);
    res.status(201).json({ ok: true, Id: result.recordset[0].Id });
  } catch (err) {
    console.error('POST /warehouse/cheques error:', err.message);
    res.status(500).json({ message: 'Failed to create cheque', error: err.message });
  }
});

// ── PUT /api/warehouse/cheques/:id ─────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const b = req.body || {};
    const pool = await getAppPool();
    const r = pool.request();
    r.input('id',     sql.Int,           id);
    r.input('co',     sql.NVarChar(10),  COMPANY);
    r.input('srno',   sql.Int,           b.SrNo || null);
    r.input('boi',    sql.NVarChar(10),  b.BlankOrIssued || null);
    r.input('issdt',  sql.Date,          b.IssueDate || null);
    r.input('bank',   sql.NVarChar(50),  b.BankName || null);
    r.input('chno',   sql.NVarChar(50),  b.ChequeNo || null);
    r.input('chdt',   sql.Date,          b.ChequeDate || null);
    r.input('issto',  sql.NVarChar(200), b.IssueTo || null);
    r.input('cur',    sql.NVarChar(10),  b.Currency || 'SGD');
    r.input('amt',    sql.Decimal(18,2), b.Amount != null ? Number(b.Amount) : null);
    r.input('rmk',    sql.NVarChar(500), b.Remark || null);
    r.input('clrdt',  sql.Date,          b.ClearingDate || null);
    r.input('rcvdt',  sql.Date,          b.ReceivedDate || null);
    const result = await r.query(`
      UPDATE dbo.BN_WhCheque SET
        SrNo = @srno, BlankOrIssued = @boi, IssueDate = @issdt, BankName = @bank,
        ChequeNo = @chno, ChequeDate = @chdt, IssueTo = @issto, Currency = @cur,
        Amount = @amt, Remark = @rmk, ClearingDate = @clrdt, ReceivedDate = @rcvdt,
        UpdatedAt = SYSDATETIME()
      WHERE Id = @id AND Company = @co;
      SELECT @@ROWCOUNT AS Updated;
    `);
    if (!result.recordset[0].Updated) return res.status(404).json({ message: 'Cheque not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /warehouse/cheques/:id error:', err.message);
    res.status(500).json({ message: 'Failed to update cheque', error: err.message });
  }
});

// ── DELETE /api/warehouse/cheques/:id (soft delete) ────────────────────
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
        UPDATE dbo.BN_WhCheque SET IsActive = 0, UpdatedAt = SYSDATETIME()
        WHERE Id = @id AND Company = @co;
        SELECT @@ROWCOUNT AS Deleted;
      `);
    if (!result.recordset[0].Deleted) return res.status(404).json({ message: 'Cheque not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /warehouse/cheques/:id error:', err.message);
    res.status(500).json({ message: 'Failed to delete cheque', error: err.message });
  }
});

// ── POST /api/warehouse/cheques/import — upload xlsx, append rows ─────
// Accepts the whole workbook; auto-picks the sheet whose name contains "cheque".
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can import' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name = "file")' });
  try {
    const wb = X.xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheetName = X.resolveSheet(wb, 'cheque');
    if (!sheetName) return res.status(400).json({ message: 'No Cheque sheet found. Sheets: ' + wb.SheetNames.join(', ') });
    const { headers, rows } = X.readSheet(wb, sheetName);
    if (!rows.length) return res.json({ sheet: sheetName, inserted: 0, message: 'Sheet had no data rows' });

    const pool = await getAppPool();
    let wiped = 0;
    if (req.query.wipe === '1' || req.query.wipe === 'true') {
      const w = await pool.request().input('co', sql.NVarChar(10), COMPANY)
        .query(`UPDATE dbo.BN_WhCheque SET IsActive=0 WHERE Company=@co AND IsActive=1; SELECT @@ROWCOUNT AS Wiped;`);
      wiped = w.recordset[0].Wiped || 0;
    }
    let inserted = 0; let failed = 0; const errors = [];
    for (const r of rows) {
      try {
        const req2 = pool.request();
        req2.input('co',       sql.NVarChar(10),  COMPANY);
        req2.input('srno',     sql.Int,           X.toInt(X.cell(r, headers, 'Sr No','Sr No.','SN','#','Sl No')));
        req2.input('boi',      sql.NVarChar(10),  X.toStr(X.cell(r, headers, 'Blank/Issued','Blank / Issued','Blank /  Issued','Status','State')) || 'Blank');
        req2.input('issdt',    sql.Date,          X.toDate(X.cell(r, headers, 'Issue Date','Issued Date')));
        req2.input('bank',     sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Bank Name','Bank')));
        req2.input('chno',     sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Cheque No','Cheque Number','Chq No')));
        req2.input('chdt',     sql.Date,          X.toDate(X.cell(r, headers, 'Cheque Date','Chq Date')));
        req2.input('issto',    sql.NVarChar(200), X.toStr(X.cell(r, headers, 'Issue To','Issue to','Payee','Paid To')));
        req2.input('cur',      sql.NVarChar(10),  X.toStr(X.cell(r, headers, 'Currency','currency','Cur')) || 'SGD');
        req2.input('amt',      sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Amt','Amount','Value')));
        req2.input('rmk',      sql.NVarChar(500), X.toStr(X.cell(r, headers, 'Remark','Remarks','Notes')));
        req2.input('clrdt',    sql.Date,          X.toDate(X.cell(r, headers, 'Clearing Date','Cleared Date')));
        req2.input('rcvdt',    sql.Date,          X.toDate(X.cell(r, headers, 'Received Date','Receive Date')));
        req2.input('createdBy',sql.Int,           req.user.id);
        await req2.query(`
          INSERT INTO dbo.BN_WhCheque
            (Company, SrNo, BlankOrIssued, IssueDate, BankName, ChequeNo, ChequeDate,
             IssueTo, Currency, Amount, Remark, ClearingDate, ReceivedDate, CreatedBy)
          VALUES
            (@co, @srno, @boi, @issdt, @bank, @chno, @chdt, @issto, @cur, @amt,
             @rmk, @clrdt, @rcvdt, @createdBy);`);
        inserted++;
      } catch (e) {
        failed++; if (errors.length < 10) errors.push(e.message);
      }
    }
    res.json({ ok: true, sheet: sheetName, inserted, failed, wiped, errors });
  } catch (err) {
    console.error('POST /warehouse/cheques/import error:', err.message);
    res.status(500).json({ message: 'Import failed', error: err.message });
  }
});

// ── GET /api/warehouse/cheques/export — current view as xlsx ──────────
router.get('/export', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co', sql.NVarChar(10), COMPANY);
    let where = 'WHERE Company = @co AND IsActive = 1';
    if (req.query.search) {
      r.input('q', sql.NVarChar(200), '%' + req.query.search + '%');
      where += ' AND (ChequeNo LIKE @q OR IssueTo LIKE @q OR Remark LIKE @q OR BankName LIKE @q)';
    }
    if (req.query.status && req.query.status !== 'all') {
      r.input('st', sql.NVarChar(20), req.query.status);
      where += ' AND BlankOrIssued = @st';
    }
    const data = (await r.query(`
      SELECT SrNo, BlankOrIssued, IssueDate, BankName, ChequeNo, ChequeDate,
             IssueTo, Currency, Amount, Remark, ClearingDate, ReceivedDate
      FROM dbo.BN_WhCheque ${where} ORDER BY IssueDate DESC, Id DESC;
    `)).recordset;
    const buf = X.buildXlsx(data, [
      { key: 'SrNo',           label: 'Sr No' },
      { key: 'BlankOrIssued',  label: 'Blank/Issued' },
      { key: 'IssueDate',      label: 'Issue Date',   type: 'date' },
      { key: 'BankName',       label: 'Bank Name' },
      { key: 'ChequeNo',       label: 'Cheque No' },
      { key: 'ChequeDate',     label: 'Cheque Date',  type: 'date' },
      { key: 'IssueTo',        label: 'Issue To' },
      { key: 'Currency',       label: 'Currency' },
      { key: 'Amount',         label: 'Amount' },
      { key: 'Remark',         label: 'Remark' },
      { key: 'ClearingDate',   label: 'Clearing Date', type: 'date' },
      { key: 'ReceivedDate',   label: 'Received Date', type: 'date' },
    ], 'Cheques');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Cheques_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('GET /warehouse/cheques/export error:', err.message);
    res.status(500).json({ message: 'Export failed', error: err.message });
  }
});

module.exports = router;
