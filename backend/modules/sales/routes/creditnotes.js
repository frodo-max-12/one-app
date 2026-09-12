// =====================================================================
// modules/sales/routes/creditnotes.js — Credit Notes "Yet to Approve"
//
// Mounted at /api/sales/cn/*. Holds credit notes the electrical team gave to
// customers (Cash Discount / FOC) that are NOT yet posted in NAV. They net down
// the customer's Remaining Outstanding in the Customer Detail modal until Accounts
// posts the real credit memo in NAV (then the row is deleted). "Approved CN"
// (already posted) is read straight from NAV (Cust. Ledger Entry Document Type=3)
// by the customers route — this table is ONLY the "Yet to Approve" ones.
//
// Endpoints:
//   GET    /?customerCode=&customerName=  — list a customer's active CN (scoped)
//   POST   /import                        — bulk Excel import (admin only)
//   DELETE /:id                           — soft delete (admin only)
//
// Permission: any logged-in user sees CN for customers in their salesperson scope;
// import + delete are admin/accounts (isFullAccess) only.
// =====================================================================

const express = require('express');
const multer  = require('multer');
const xlsx    = require('xlsx');
const router  = express.Router();
const { sql, getPool, getAppPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const { getCompany }               = require('../../../shared/company');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// CN access is limited to the electrical leadership (user decision 2026-08-11):
// admin + Electrical Head (a colleague Porwal, role 'electrical head') + Sales Head
// Electrical (the retail account, role 'sales head electrical'). Everyone else gets
// NO CN — the tab/netting/import are all gated on this. Admin is unrestricted (see
// resolveCnScope via isFullAccess); the two heads are scoped to their team customers.
const CN_ROLES = new Set(['admin', 'electrical head', 'sales head electrical']);
const isCnUser = (u) => CN_ROLES.has(String((u && u.role) || '').toLowerCase().trim());

// ── helpers ──────────────────────────────────────────────────────────────────

// Anchor a calendar day at 12:00 UTC so neither UTC nor IST-local date extraction
// can shift it to an adjacent day (same pattern the DC module uses).
function middayUTC(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)); }

// Parse a Bill Date cell. Workbook is read with cellDates:false so a real date
// arrives as an Excel serial → convert via xlsx.SSF (pure calendar, no TZ math).
// Also handles dd-mm-yyyy / yyyy-mm-dd text.
function parseCnDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const o = xlsx.SSF.parse_date_code(v);
    return (o && o.y) ? middayUTC(o.y, o.m, o.d) : null;
  }
  if (v instanceof Date) return isNaN(v.getTime()) ? null : middayUTC(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return middayUTC(y, +m[2], +m[1]); }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return middayUTC(+m[1], +m[2], +m[3]);
  return null;
}

function parseAmount(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[,₹$\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Excel "Remark" → canonical CN type. CD = Cash Discount, FOC = Free of Cost.
function normalizeCnType(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return null;
  if (s.includes('FOC') || s.includes('FREE')) return 'FOC';
  if (s === 'CD' || s.includes('CASH') || s.includes('DISCOUNT')) return 'CD';
  return s.slice(0, 10);
}

// Match an Excel customer name to the NAV [Customer] master → returns NAV [No_] or null.
async function matchCustomerCode(navPool, prefix, customerName) {
  const cleaned = String(customerName || '').trim();
  if (!cleaned) return null;
  try {
    const r = await navPool.request()
      .input('nm', sql.NVarChar(200), cleaned)
      .query(`SELECT TOP 1 [No_] FROM ${prefix}Customer]
              WHERE UPPER(LTRIM(RTRIM([Name]))) = UPPER(LTRIM(RTRIM(@nm)))`);
    return r.recordset.length ? r.recordset[0].No_ : null;
  } catch (_) { return null; }
}

// Resolve which BN_CreditNote rows a user may see, by salesperson scope. SAME shape
// as PDC's resolvePdcScope so list stays consistent with the rest of the module.
//   { unrestricted:true }                          — full access (admin/op head/director)
//   { unrestricted:false, customerCodes:[...] }    — scoped (EMPTY → see NOTHING)
async function resolveCnScope(req, company) {
  if (isFullAccess(req.user)) return { unrestricted: true };
  const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';
  const codes   = (req.user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);
  if (!codes.length) return { unrestricted: false, customerCodes: [] };
  const navPool = await getPool();
  const navR = navPool.request();
  codes.forEach((c, i) => navR.input('sp' + i, sql.NVarChar(50), c));
  const navList = await navR.query(`
    SELECT [No_] AS CustomerCode FROM ${company.prefix}Customer]
    WHERE [Salesperson Code] IN (${codes.map((_, i) => '@sp' + i).join(',')})`);
  return { unrestricted: false, customerCodes: navList.recordset.map(x => x.CustomerCode).filter(Boolean) };
}

// ── GET / — list a customer's active CN (scoped) ─────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const company      = getCompany(req);
    const customerCode = (req.query.customerCode || '').trim();
    const customerName = (req.query.customerName || '').trim();
    if (!customerCode && !customerName) return res.status(400).json({ message: 'customerCode or customerName required' });

    // Only the CN roles get any CN data — others see nothing (no tab, no netting).
    if (!isCnUser(req.user)) return res.json({ ok: true, data: [], summary: { total: 0, cdTotal: 0, focTotal: 0 } });

    const scope = await resolveCnScope(req, company);
    if (!scope.unrestricted) {
      // A scoped user may only see CN of a customer they own.
      if (!scope.customerCodes.length) return res.json({ ok: true, data: [], summary: { total: 0, cdTotal: 0, focTotal: 0 } });
      if (customerCode && !scope.customerCodes.includes(customerCode)) {
        return res.json({ ok: true, data: [], summary: { total: 0, cdTotal: 0, focTotal: 0 } });
      }
    }

    const pool = await getAppPool();
    const r = pool.request().input('co', sql.NVarChar(10), company.code);
    const where = ['IsActive = 1', '(Company IS NULL OR Company = @co)'];
    if (customerCode) {
      // Match by code; also catch name-only rows (CustomerCode NULL) that resolve by name.
      if (customerName) {
        where.push(`( CustomerCode = @cc OR (CustomerCode IS NULL
          AND UPPER(LTRIM(RTRIM(CustomerName))) = UPPER(LTRIM(RTRIM(@cn)))) )`);
        r.input('cc', sql.NVarChar(50), customerCode);
        r.input('cn', sql.NVarChar(200), customerName);
      } else {
        where.push('CustomerCode = @cc'); r.input('cc', sql.NVarChar(50), customerCode);
      }
    } else {
      where.push('UPPER(LTRIM(RTRIM(CustomerName))) = UPPER(LTRIM(RTRIM(@cn)))');
      r.input('cn', sql.NVarChar(200), customerName);
    }

    const result = await r.query(`
      SELECT CnId, Company, CustomerCode, CustomerName, BillNo,
             CONVERT(varchar(10), BillDate, 23) AS BillDate,
             Amount, CnType, Reason, Status, CreatedAt
      FROM [dbo].[BN_CreditNote]
      WHERE ${where.join(' AND ')}
      ORDER BY BillDate DESC, CnId DESC;`);

    const rows = result.recordset;
    const summary = rows.reduce((a, x) => {
      const amt = Number(x.Amount) || 0; a.total += amt;
      if (x.CnType === 'CD') a.cdTotal += amt; else if (x.CnType === 'FOC') a.focTotal += amt;
      return a;
    }, { total: 0, cdTotal: 0, focTotal: 0 });

    return res.json({ ok: true, data: rows, summary });
  } catch (err) {
    console.error('[GET /api/sales/cn] failed:', err.message);
    return res.status(500).json({ message: 'CN list failed', detail: err.message });
  }
});

// ── POST /import — Excel bulk import (admin only) ────────────────────────────
// CN Electricals.xlsx: S No | Name | Bill Date | Bill No | Amount | Reason | Remark.
// Merged cells (one customer/bill spanning several amount lines) are forward-filled.
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!isCnUser(req.user)) return res.status(403).json({ message: 'Only Admin / Electrical Head / Sales Head Electrical can import Credit Notes.' });
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const company = getCompany(req);
    const dryRun  = req.query.dryRun === 'true' || req.body.dryRun === 'true';

    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ message: 'No sheet found in workbook' });
    const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    const headers = (aoa[0] || []).map(h => String(h).trim().toLowerCase());
    const col = (...names) => headers.findIndex(h => names.includes(h));
    const iName   = col('name', 'customer name', 'customer');
    const iBillDt = col('bill date', 'date');
    const iBillNo = col('bill no', 'bill no.', 'invoice no', 'invoice no.');
    const iAmt    = col('amount', 'amt', 'cn amount');
    const iReason = col('reason', 'remarks', 'note');
    const iType   = col('remark', 'type', 'cn type');
    if (iName < 0 || iAmt < 0) return res.status(400).json({ message: 'Expected columns "Name" and "Amount" not found in the sheet.' });

    // forward-fill merged Name / Bill Date / Bill No down; keep a row only if Amount>0
    let name = '', billDate = '', billNo = '';
    const parsed = [];
    for (let i = 1; i < aoa.length; i++) {
      const row = aoa[i];
      if (!row || row.every(c => String(c).trim() === '')) continue;
      if (iName   >= 0 && String(row[iName]).trim())   name     = String(row[iName]).trim();
      if (iBillDt >= 0 && String(row[iBillDt]).trim()) billDate = row[iBillDt];
      if (iBillNo >= 0 && String(row[iBillNo]).trim()) billNo   = String(row[iBillNo]).trim();
      const amount = parseAmount(row[iAmt]);
      if (!(amount > 0) || !name) continue;
      parsed.push({
        customerName: name,
        billNo:  billNo || null,
        billDate: parseCnDate(billDate),
        amount,
        reason:  iReason >= 0 ? (String(row[iReason]).trim() || null) : null,
        cnType:  iType >= 0 ? normalizeCnType(row[iType]) : null,
      });
    }

    // Resolve NAV customer code by name (cached)
    const navPool = await getPool();
    const cache = new Map();
    for (const p of parsed) {
      const key = p.customerName.toUpperCase();
      if (!cache.has(key)) cache.set(key, await matchCustomerCode(navPool, company.prefix, p.customerName));
      p.customerCode = cache.get(key);
    }

    const matched   = parsed.filter(p => p.customerCode).length;
    const unmatched = parsed.length - matched;

    if (dryRun) {
      return res.json({
        ok: true, dryRun: true, rowsParsed: parsed.length, matched, unmatched,
        customers: [...new Set(parsed.map(p => p.customerName))].length,
        preview: parsed.slice(0, 12),
      });
    }

    // Real import — UPSERT on Company + CustomerCode(or Name) + BillNo + Amount + Reason
    const pool = await getAppPool();
    let inserted = 0, updated = 0, failed = 0; const failures = [];
    for (const p of parsed) {
      try {
        const dup = await pool.request()
          .input('co',  sql.NVarChar(10),  company.code)
          .input('cc',  sql.NVarChar(50),  p.customerCode)
          .input('cn',  sql.NVarChar(200), p.customerName)
          .input('bn',  sql.NVarChar(100), p.billNo || '')
          .input('am',  sql.Decimal(18,2), p.amount)
          .input('rs',  sql.NVarChar(500), p.reason || '')
          .query(`SELECT TOP 1 CnId FROM [dbo].[BN_CreditNote]
                  WHERE IsActive = 1 AND ISNULL(Company,'') = @co
                    AND ( (@cc IS NOT NULL AND CustomerCode = @cc)
                          OR (@cc IS NULL AND UPPER(LTRIM(RTRIM(CustomerName))) = UPPER(LTRIM(RTRIM(@cn)))) )
                    AND ISNULL(BillNo,'') = @bn AND ISNULL(Amount,0) = @am AND ISNULL(Reason,'') = @rs;`);

        if (dup.recordset.length) {
          await pool.request()
            .input('id',  sql.Int,          dup.recordset[0].CnId)
            .input('cc',  sql.NVarChar(50),  p.customerCode)
            .input('cn',  sql.NVarChar(200), p.customerName)
            .input('bd',  sql.Date,          p.billDate)
            .input('ct',  sql.NVarChar(10),  p.cnType)
            .input('by',  sql.Int,           req.user.id)
            .query(`UPDATE [dbo].[BN_CreditNote] SET
                      CustomerCode = COALESCE(@cc, CustomerCode),
                      CustomerName = COALESCE(NULLIF(@cn,''), CustomerName),
                      BillDate     = COALESCE(@bd, BillDate),
                      CnType       = COALESCE(@ct, CnType),
                      UpdatedBy = @by, UpdatedAt = SYSDATETIME()
                    WHERE CnId = @id;`);
          updated++;
          continue;
        }

        await pool.request()
          .input('co',  sql.NVarChar(10),  company.code)
          .input('cc',  sql.NVarChar(50),  p.customerCode)
          .input('cn',  sql.NVarChar(200), p.customerName)
          .input('bn',  sql.NVarChar(100), p.billNo)
          .input('bd',  sql.Date,          p.billDate)
          .input('am',  sql.Decimal(18,2), p.amount)
          .input('ct',  sql.NVarChar(10),  p.cnType)
          .input('rs',  sql.NVarChar(500), p.reason)
          .input('by',  sql.Int,           req.user.id)
          .query(`INSERT INTO [dbo].[BN_CreditNote]
                    (Company, CustomerCode, CustomerName, BillNo, BillDate, Amount, CnType, Reason, Status, CreatedBy)
                  VALUES (@co, @cc, @cn, @bn, @bd, @am, @ct, @rs, 'yet_to_approve', @by);`);
        inserted++;
      } catch (e) {
        failed++;
        if (failures.length < 10) failures.push({ reason: e.message, customerName: p.customerName, billNo: p.billNo, amount: p.amount });
        console.error('[cn/import] row failed:', e.message);
      }
    }

    return res.json({ ok: true, rowsParsed: parsed.length, matched, unmatched, inserted, updated, failed, failures });
  } catch (err) {
    console.error('[POST /api/sales/cn/import] failed:', err.message);
    return res.status(500).json({ message: 'CN import failed', detail: err.message });
  }
});

// ── DELETE /:id — soft delete (admin only; the manual double-count guard) ─────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (!isCnUser(req.user)) return res.status(403).json({ message: 'Only Admin / Electrical Head / Sales Head Electrical can delete Credit Notes.' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, id).input('by', sql.Int, req.user.id)
      .query(`UPDATE [dbo].[BN_CreditNote] SET IsActive = 0, UpdatedBy = @by, UpdatedAt = SYSDATETIME() WHERE CnId = @id;`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/sales/cn/:id] failed:', err.message);
    return res.status(500).json({ message: 'CN delete failed', detail: err.message });
  }
});

module.exports = router;
