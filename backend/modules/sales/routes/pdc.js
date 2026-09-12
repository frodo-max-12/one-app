// =====================================================================
// modules/sales/routes/pdc.js — Post-Dated Cheques (PDC) tracker
//
// Replaces the team's CHEQUES IN.xlsx spreadsheet. Mounted at /api/sales/pdc/*.
//
// Endpoints:
//   GET    /                 — list with filters (search, status, customerCode, dates, page, limit)
//   GET    /:id              — single PDC
//   POST   /                 — create
//   PATCH  /:id              — update (any subset of fields)
//   DELETE /:id              — soft delete (IsActive=0)
//   POST   /import           — bulk Excel import (multer; auto-matches customer by NAV name)
//   GET    /export           — Excel download (respects current filter)
//
// Permission: any logged-in user (sales / sales-head / admin). Sales reps see
// only their team's PDCs (filtered by customer's salesperson code).
//
// PDC is informational only — does NOT affect NAV's Cust. Ledger Entry. NAV
// remains the source of truth for outstanding. Cleared PDCs eventually create
// a Cash Receipt entry in NAV via a separate accounts workflow.
// =====================================================================

const express = require('express');
const multer  = require('multer');
const xlsx    = require('xlsx');
const router  = express.Router();
const { sql, getPool, getAppPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const { getCompany }               = require('../../../shared/company');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const STATUSES = new Set([
  'pending', 'not_deposited', 'with_salesperson',
  'deposited', 'cleared', 'online',
  'bounced', 'hold', 'cancelled',
]);

// Empty summary object returned by the list when a scoped user owns no customers.
const ZERO_SUMMARY = {
  Total: 0, TotalAmount: 0,
  PendingCount: 0,   PendingAmount: 0,
  DepositedCount: 0, DepositedAmount: 0,
  ClearedCount: 0,   ClearedAmount: 0,
  OnlineCount: 0,    OnlineAmount: 0,
  BouncedCount: 0,   BouncedAmount: 0,
  HoldCount: 0,      HoldAmount: 0,
  CancelledCount: 0, CancelledAmount: 0,
  MismatchCount: 0,  MismatchAmount: 0,
  LapsedCount: 0,    LapsedAmount: 0,
};

// ── helpers ──────────────────────────────────────────────────────────────────

// Map a free-text Status (from Excel or API) to one of the 9 internal keys.
// Handles human-readable labels ("Not Deposited", "Cheque Bounce", "Online Received")
// AND the canonical snake_case keys. Returns null if unrecognised.
function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (STATUSES.has(s)) return s;   // already canonical (e.g. "cleared", "not_deposited")
  const m = {
    'not deposited':         'not_deposited',
    'with salesperson':      'with_salesperson',
    'pdc with salesperson':  'with_salesperson',
    'online received':       'online',
    'neft received':         'online',
    'neft done':             'online',
    'online transfer':       'online',
    'cheque bounce':         'bounced',
    'bounce':                'bounced',
    'canceled':              'cancelled',
  };
  return m[s] || null;
}

// Bucket expression used by both list filter and stats. Status column is primary
// — if it carries one of the 7 explicit statuses (incl. Hold) we trust it; otherwise
// (NULL / pending / not_deposited / with_salesperson) we fall back to Remark text
// mining for legacy rows imported before the Status field was used.
// Tolerates raw human labels ("Cleared", "Cheque Bounce", "Not Deposited") so old
// rows from the first import work without a migration.
// NOTE (2026-08-07): `hold` is now its OWN bucket (was folded into 'pending') so the
// PDC page can show a dedicated Hold card in place of the Cancelled card.
function bucketExprForFilter(alias = 'p') {
  const A = alias ? alias + '.' : '';
  return `CASE
    WHEN LOWER(ISNULL(${A}Status,'')) IN ('cancelled','canceled')                                  THEN 'cancelled'
    WHEN LOWER(ISNULL(${A}Status,'')) IN ('bounced','cheque bounce','bounce')                      THEN 'bounced'
    WHEN LOWER(ISNULL(${A}Status,'')) = 'cleared'                                                  THEN 'cleared'
    WHEN LOWER(ISNULL(${A}Status,'')) IN ('online','online received','neft received','neft done','online transfer') THEN 'online'
    WHEN LOWER(ISNULL(${A}Status,'')) = 'deposited'                                                THEN 'deposited'
    WHEN LOWER(ISNULL(${A}Status,'')) = 'hold'                                                     THEN 'hold'
    WHEN LOWER(ISNULL(${A}Status,'')) IN ('pending','not_deposited','not deposited','with_salesperson','with salesperson','pdc with salesperson','-') THEN 'pending'
    WHEN UPPER(ISNULL(${A}Remark,'')) LIKE '%CANCEL%'                                              THEN 'cancelled'
    WHEN UPPER(ISNULL(${A}Remark,'')) LIKE '%BOUNC%'                                               THEN 'bounced'
    WHEN UPPER(ISNULL(${A}Remark,'')) LIKE '%CLEAR%'                                               THEN 'cleared'
    WHEN UPPER(ISNULL(${A}Remark,'')) LIKE '%ONLINE%' OR UPPER(ISNULL(${A}Remark,'')) LIKE '%NEFT%' THEN 'online'
    WHEN UPPER(ISNULL(${A}Remark,'')) LIKE '%DEPOSITED%'
      AND UPPER(ISNULL(${A}Remark,'')) NOT LIKE '%NOT %DEPOSIT%'
      AND UPPER(ISNULL(${A}Remark,'')) NOT LIKE '%NOT DEPOSIT%'                                    THEN 'deposited'
    WHEN UPPER(ISNULL(${A}Remark,'')) LIKE '%HOLD%'                                                THEN 'hold'
    ELSE                                                                                                 'pending'
  END`;
}

// "Mismatch" = a row that imported but has a data-quality problem the user must
// fix (2026-08-07, replaces the old "Unmatched" = empty-code-only card). A row is a
// Mismatch when ANY of these is true (all checked against STORED columns so the
// card/stats are cheap — no live NAV join):
//   • CustomerCode empty  → the Customer Name never resolved to a NAV customer
//   • ChequeDate NULL      → missing cheque date
//   • ChequeNo empty       → missing cheque number
//   • Amount 0/NULL        → missing amount
//   • Status empty         → no status set
// Orthogonal to the status buckets (a Cleared cheque with no Bill/Date is still a
// Mismatch), exactly like the old Unmatched flag it supersedes.
function mismatchExpr(alias = 'p') {
  const A = alias ? alias + '.' : '';
  return `(CASE WHEN ISNULL(${A}CustomerCode,'') = ''
                  OR ${A}ChequeDate IS NULL
                  OR ISNULL(${A}ChequeNo,'') = ''
                  OR ISNULL(${A}Amount, 0) = 0
                  OR ISNULL(${A}Status,'') = ''
             THEN 1 ELSE 0 END)`;
}

// "Lapsed" (2026-08-10 user request) = a cheque whose CHEQUE DATE has already
// passed (as-on today, server date) but is STILL un-banked — i.e. its bucket is
// 'hold' or 'pending' (which covers not_deposited / with_salesperson / blank).
// Deposited / Cleared / Online / Bounced / Cancelled cheques are NOT lapsed — they
// have already been actioned. Purpose: surface cheques the accounts team should
// have banked by their cheque date but hasn't, so they don't quietly sit on Hold /
// Not-Deposited past their date. Orthogonal to the status buckets (like Mismatch):
// a Lapsed cheque is ALSO still counted under Hold or Pending.
function lapsedExpr(alias = 'p') {
  const A = alias ? alias + '.' : '';
  return `(CASE WHEN ${A}ChequeDate < CAST(GETDATE() AS DATE)
                  AND (${bucketExprForFilter(alias)}) IN ('hold','pending')
             THEN 1 ELSE 0 END)`;
}

// Does a NAV customer with this exact [No_] exist? Used at import so we don't
// blindly trust a Customer Code column that points at a code NAV doesn't have.
async function customerCodeExists(navPool, prefix, code) {
  const c = String(code || '').trim();
  if (!c) return false;
  try {
    const r = await navPool.request()
      .input('cd', sql.NVarChar(50), c)
      .query(`SELECT TOP 1 1 AS X FROM ${prefix}Customer] WHERE [No_] = @cd`);
    return r.recordset.length > 0;
  } catch (_) {
    return false;
  }
}

// Try to match a customer name from Excel to the NAV [Customer] master.
// Returns the NAV [No_] (CustomerCode) or null if no exact match.
async function matchCustomerCode(navPool, prefix, customerName) {
  if (!customerName) return null;
  const cleaned = String(customerName).trim();
  if (!cleaned) return null;
  try {
    const r = await navPool.request()
      .input('nm', sql.NVarChar(200), cleaned)
      .query(`
        SELECT TOP 1 [No_]
        FROM ${prefix}Customer]
        WHERE UPPER(LTRIM(RTRIM([Name]))) = UPPER(LTRIM(RTRIM(@nm)))
      `);
    return r.recordset.length ? r.recordset[0].No_ : null;
  } catch (_) {
    return null;
  }
}

// Parse an Excel date cell. Excel stores dates as serial numbers (days since 1900)
// or sometimes as JS date objects depending on cell type. Handle both + DD-MM-YYYY strings.
function parseExcelDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    // Excel serial date — days since 1899-12-30 (account for the 1900 leap year bug)
    const epoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(epoch.getTime() + v * 86400000);
  }
  // String date — try DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseAmount(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,₹$\s]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Resolve which BN_PDC rows a user is allowed to see, by salesperson scope.
// SINGLE source of truth — applied identically by the list, the stats query AND
// the export endpoint so they can never diverge. (The export previously carried
// NO scope, leaking every customer's cheques to any logged-in rep — fixed 2026-06-26.)
//
// Returns:
//   { unrestricted: true }                          — full access only (admin / operation
//                                                      head / director): no filter.
//   { unrestricted: false, customerCodes: [...] }   — scoped: only these NAV customer
//                                                      codes (EMPTY array → see NOTHING).
async function resolvePdcScope(req, company) {
  // Only full-access roles see every cheque. EVERY other role is scoped by its
  // salesperson codes — and a non-admin with NO codes for this company (HR, FAE,
  // warehouse, store, retailer, or a misconfigured rep) sees NOTHING, never the whole
  // table. (Treating "no codes" as unrestricted is exactly what leaked the export.)
  if (isFullAccess(req.user)) return { unrestricted: true };
  const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';
  const codes   = (req.user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);
  if (!codes.length) return { unrestricted: false, customerCodes: [] };

  const navPool = await getPool();
  const navR = navPool.request();
  codes.forEach((c, i) => navR.input('sp' + i, sql.NVarChar(50), c));
  const navList = await navR.query(`
    SELECT [No_] AS CustomerCode FROM ${company.prefix}Customer]
    WHERE [Salesperson Code] IN (${codes.map((_, i) => '@sp' + i).join(',')})
  `);
  return {
    unrestricted: false,
    customerCodes: navList.recordset.map(x => x.CustomerCode).filter(Boolean),
  };
}

// ── GET / — list with filters ───────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const search       = (req.query.search       || '').trim();
    const status       = (req.query.status       || '').trim();
    const customerCode = (req.query.customerCode || '').trim();
    const customerName = (req.query.customerName || '').trim();   // fallback match when CustomerCode is null
    const fromDate     = (req.query.fromDate     || '').trim();
    const toDate       = (req.query.toDate       || '').trim();
    const bucket       = (req.query.bucket       || '').trim().toLowerCase();   // pending|deposited|cleared|online|bounced|cancelled
    const page  = Math.max(1, parseInt(req.query.page  || '1',   10));
    const limit = Math.max(1, parseInt(req.query.limit || '100', 10));
    const offset = (page - 1) * limit;

    // Salesperson scope — resolved ONCE and reused by the list filter, the stats
    // query below, AND (via the same helper) GET /export.
    const scope = await resolvePdcScope(req, company);

    const pool = await getAppPool();
    const r = pool.request();
    const where = ['p.IsActive = 1', '(p.Company IS NULL OR p.Company = @co)'];
    r.input('co', sql.NVarChar(10), company.code);

    if (status && STATUSES.has(status)) {
      where.push('p.Status = @status');
      r.input('status', sql.NVarChar(20), status);
    }
    if (customerCode) {
      // Match by CustomerCode. If customerName also passed (from the Customer-ledger
      // PDC tab), also catch rows that were saved name-only (CustomerCode IS NULL).
      // Lets users see PDCs added before the autocomplete existed.
      if (customerName) {
        where.push(`(
          p.CustomerCode = @cc
          OR (p.CustomerCode IS NULL
              AND UPPER(LTRIM(RTRIM(p.CustomerName))) = UPPER(LTRIM(RTRIM(@cn))))
        )`);
        r.input('cc', sql.NVarChar(50),  customerCode);
        r.input('cn', sql.NVarChar(200), customerName);
      } else {
        where.push('p.CustomerCode = @cc');
        r.input('cc', sql.NVarChar(50), customerCode);
      }
    }
    if (fromDate) {
      where.push('p.ChequeDate >= @from');
      r.input('from', sql.Date, new Date(fromDate));
    }
    if (toDate) {
      where.push('p.ChequeDate <= @to');
      r.input('to', sql.Date, new Date(toDate));
    }
    if (search) {
      where.push(`(
        p.CustomerName LIKE @q OR ISNULL(p.CustomerCode,'') LIKE @q
        OR ISNULL(p.ChequeNo,'') LIKE @q OR ISNULL(p.BillNo,'') LIKE @q
        OR ISNULL(p.BankName,'') LIKE @q OR ISNULL(p.Remark,'') LIKE @q
      )`);
      r.input('q', sql.NVarChar(300), '%' + search + '%');
    }

    // Bucket filter — used when user clicks a stat card. Same priority logic
    // as the stats query so list & stats stay in sync.
    // "mismatch" is orthogonal: rows with a data-quality problem (no NAV code, or
    // missing Cheque Date / No / Amount / Status). "unmatched" kept as an alias.
    const VALID_BUCKETS = new Set(['pending','deposited','cleared','online','bounced','hold','cancelled']);
    if (bucket === 'mismatch' || bucket === 'unmatched') {
      where.push(`${mismatchExpr('p')} = 1`);
    } else if (bucket === 'lapsed') {
      // Orthogonal filter (like mismatch): past-dated cheques still on Hold / Not-Deposited.
      where.push(`${lapsedExpr('p')} = 1`);
    } else if (bucket && VALID_BUCKETS.has(bucket)) {
      where.push(`(${bucketExprForFilter('p')}) = @bucket`);
      r.input('bucket', sql.NVarChar(20), bucket);
    }

    // Sales scoping — non-admin reps see only PDCs of customers they own
    // (resolved live via NAV Customer.[Salesperson Code]). The SAME `scope` is
    // applied to the stats query below and to GET /export.
    if (!scope.unrestricted) {
      if (!scope.customerCodes.length) {
        return res.json({ ok: true, total: 0, page, limit, data: [], summary: ZERO_SUMMARY });
      }
      scope.customerCodes.forEach((c, i) => r.input('mycc' + i, sql.NVarChar(50), c));
      where.push(`p.CustomerCode IN (${scope.customerCodes.map((_, i) => '@mycc' + i).join(',')})`);
    }

    r.input('offset', sql.Int, offset);
    r.input('limit',  sql.Int, limit);

    const result = await r.query(`
      WITH P AS (
        SELECT * FROM [dbo].[BN_PDC] p WHERE ${where.join(' AND ').replace(/p\./g, '')}
      )
      SELECT X.*,
             ISNULL(u.Name, u.Username) AS ImportedBy
      FROM (
        SELECT COUNT(*) OVER () AS TotalCount, * FROM P
      ) X
      LEFT JOIN [dbo].[User_Login] u ON u.Id = X.CreatedBy
      -- Oldest cheque date first (per user request 2026-05-26). NULL dates pushed to the end.
      ORDER BY CASE WHEN X.ChequeDate IS NULL THEN 1 ELSE 0 END,
               X.ChequeDate ASC, X.PDCId ASC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);

    const total = result.recordset[0] ? result.recordset[0].TotalCount : 0;
    const rows  = result.recordset.map(({ TotalCount, ...rest }) => rest);

    // ── Summary stats: count + amount per REMARK keyword ──────────────────
    // Stats apply the SAME filters as the list query (search, date, scope) so
    // the cards always match what the user sees in the table. This was 2026-05-26
    // user request — "Total Amount not coming for filter".
    const statsR = pool.request();
    const statsWhere = ['IsActive = 1', '(Company IS NULL OR Company = @co)'];
    statsR.input('co', sql.NVarChar(10), company.code);
    if (fromDate) { statsWhere.push('ChequeDate >= @from'); statsR.input('from', sql.Date, new Date(fromDate)); }
    if (toDate)   { statsWhere.push('ChequeDate <= @to');   statsR.input('to', sql.Date, new Date(toDate)); }
    if (customerCode) { statsWhere.push('CustomerCode = @cc'); statsR.input('cc', sql.NVarChar(50), customerCode); }
    if (search) {
      statsWhere.push(`(
        CustomerName LIKE @q OR ISNULL(CustomerCode,'') LIKE @q
        OR ISNULL(ChequeNo,'') LIKE @q OR ISNULL(BillNo,'') LIKE @q
        OR ISNULL(BankName,'') LIKE @q OR ISNULL(Remark,'') LIKE @q
      )`);
      statsR.input('q', sql.NVarChar(300), '%' + search + '%');
    }
    if (!scope.unrestricted) {
      // The list block above already short-circuited when customerCodes is empty,
      // so here scope.customerCodes is guaranteed non-empty.
      scope.customerCodes.forEach((c, i) => statsR.input('myccs' + i, sql.NVarChar(50), c));
      statsWhere.push(`CustomerCode IN (${scope.customerCodes.map((_, i) => '@myccs' + i).join(',')})`);
    }
    // Bucketing rules (priority order, mutually exclusive):
    //   1. CANCELLED  — UPPER(Remark) LIKE '%CANCEL%'
    //   2. BOUNCED    — UPPER(Remark) LIKE '%BOUNC%'   (catches "Cheque Bounce", "Bounced")
    //   3. CLEARED    — UPPER(Remark) LIKE '%CLEAR%'   (catches "Cleared", "CLEAR", "Clearned" typo)
    //   4. ONLINE     — UPPER(Remark) LIKE '%ONLINE%' OR '%NEFT%'   (money received but not via cheque)
    //   5. DEPOSITED  — UPPER(Remark) LIKE '%DEPOSITED%' AND NOT '%NOT DEPOSIT%' (avoid catching "Not deposited")
    //   6. PENDING    — everything else: blank, "Pending", "Not Deposited", "Hold", "Given to ...", "Spelling..."
    const statsQ = await statsR.query(`
      WITH P AS (
        SELECT
          CAST(Amount AS DECIMAL(20,2)) AS Amt,
          ChequeDate,
          ${mismatchExpr('')} AS Mismatch,
          ${bucketExprForFilter('')} AS BktName
        FROM [dbo].[BN_PDC]
        WHERE ${statsWhere.join(' AND ')}
      ), B AS (
        SELECT Amt, Mismatch,
          -- Lapsed = past-dated cheque still un-banked (Hold or Pending bucket).
          CASE WHEN ChequeDate < CAST(GETDATE() AS DATE) AND BktName IN ('hold','pending')
               THEN 1 ELSE 0 END AS Lapsed,
          CASE BktName
            WHEN 'cancelled' THEN 'CANC' WHEN 'bounced'   THEN 'BNCD'
            WHEN 'cleared'   THEN 'CLRD' WHEN 'online'    THEN 'ONLN'
            WHEN 'deposited' THEN 'DEPO' WHEN 'hold'      THEN 'HOLD'
            ELSE 'PEND'
          END AS Bkt
        FROM P
      )
      SELECT
        COUNT(*)                                                            AS Total,
        ISNULL(SUM(Amt), 0)                                                 AS TotalAmount,
        SUM(CASE WHEN Bkt = 'PEND' THEN 1   ELSE 0   END)                   AS PendingCount,
        ISNULL(SUM(CASE WHEN Bkt = 'PEND' THEN Amt ELSE 0 END), 0)          AS PendingAmount,
        SUM(CASE WHEN Bkt = 'DEPO' THEN 1   ELSE 0   END)                   AS DepositedCount,
        ISNULL(SUM(CASE WHEN Bkt = 'DEPO' THEN Amt ELSE 0 END), 0)          AS DepositedAmount,
        SUM(CASE WHEN Bkt = 'CLRD' THEN 1   ELSE 0   END)                   AS ClearedCount,
        ISNULL(SUM(CASE WHEN Bkt = 'CLRD' THEN Amt ELSE 0 END), 0)          AS ClearedAmount,
        SUM(CASE WHEN Bkt = 'ONLN' THEN 1   ELSE 0   END)                   AS OnlineCount,
        ISNULL(SUM(CASE WHEN Bkt = 'ONLN' THEN Amt ELSE 0 END), 0)          AS OnlineAmount,
        SUM(CASE WHEN Bkt = 'BNCD' THEN 1   ELSE 0   END)                   AS BouncedCount,
        ISNULL(SUM(CASE WHEN Bkt = 'BNCD' THEN Amt ELSE 0 END), 0)          AS BouncedAmount,
        SUM(CASE WHEN Bkt = 'HOLD' THEN 1   ELSE 0   END)                   AS HoldCount,
        ISNULL(SUM(CASE WHEN Bkt = 'HOLD' THEN Amt ELSE 0 END), 0)          AS HoldAmount,
        SUM(CASE WHEN Bkt = 'CANC' THEN 1   ELSE 0   END)                   AS CancelledCount,
        ISNULL(SUM(CASE WHEN Bkt = 'CANC' THEN Amt ELSE 0 END), 0)          AS CancelledAmount,
        SUM(Mismatch)                                                       AS MismatchCount,
        ISNULL(SUM(CASE WHEN Mismatch = 1 THEN Amt ELSE 0 END), 0)          AS MismatchAmount,
        SUM(Lapsed)                                                         AS LapsedCount,
        ISNULL(SUM(CASE WHEN Lapsed = 1 THEN Amt ELSE 0 END), 0)            AS LapsedAmount
      FROM B
    `);
    const summary = statsQ.recordset[0] || {};

    return res.json({ ok: true, total, page, limit, data: rows, summary });
  } catch (err) {
    console.error('[GET /api/sales/pdc] failed:', err.message);
    return res.status(500).json({ message: 'PDC list failed', detail: err.message });
  }
});

// ── GET /:id ─────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM [dbo].[BN_PDC] WHERE PDCId = @id AND IsActive = 1;');
    if (!r.recordset.length) return res.status(404).json({ message: 'PDC not found' });
    return res.json({ ok: true, pdc: r.recordset[0] });
  } catch (err) {
    return res.status(500).json({ message: 'PDC fetch failed', detail: err.message });
  }
});

// ── POST / — create ──────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const b = req.body || {};
    if (!b.customerName || !b.customerName.trim()) {
      return res.status(400).json({ message: 'customerName required' });
    }
    // Salespersons can only file cheques as "with_salesperson". Only admin/head roles
    // (accounts side) can pick any of the other 8 statuses. Enforced server-side so
    // a hand-crafted POST can't bypass the frontend lock.
    const role    = (req.user.role || '').toLowerCase();
    const isAdmin = isFullAccess(req.user);
    let status = normalizeStatus(b.status) || 'pending';
    if (!isAdmin) status = 'with_salesperson';

    // Auto-match customer code if not explicitly supplied
    let customerCode = (b.customerCode || '').trim() || null;
    if (!customerCode) {
      const navPool = await getPool();
      customerCode = await matchCustomerCode(navPool, company.prefix, b.customerName);
    }

    const pool = await getAppPool();
    const out = await pool.request()
      .input('co',  sql.NVarChar(10),  company.code)
      .input('cc',  sql.NVarChar(50),  customerCode)
      .input('cn',  sql.NVarChar(200), b.customerName.trim())
      .input('chq', sql.NVarChar(50),  (b.chequeNo || '').trim() || null)
      .input('cd',  sql.Date,          b.chequeDate ? new Date(b.chequeDate) : null)
      .input('rd',  sql.Date,          b.receivedDate ? new Date(b.receivedDate) : null)
      .input('am',  sql.Decimal(18,2), Number(b.amount) || 0)
      .input('bk',  sql.NVarChar(100), (b.bankName || '').trim() || null)
      .input('vt',  sql.NVarChar(50),  (b.vertical || '').trim() || null)
      .input('bn',  sql.NVarChar(500), (b.billNo || '').trim() || null)
      .input('rm',  sql.NVarChar(500), (b.remark || '').trim() || null)
      .input('st',  sql.NVarChar(20),  status)
      .input('cld', sql.Date,          b.clearedDate ? new Date(b.clearedDate) : null)
      .input('cb',  sql.Int,           req.user.id)
      .query(`
        INSERT INTO [dbo].[BN_PDC]
          (Company, CustomerCode, CustomerName, ChequeNo, ChequeDate, ReceivedDate,
           Amount, BankName, Vertical, BillNo, Remark, Status, ClearedDate, CreatedBy)
        OUTPUT INSERTED.PDCId
        VALUES (@co, @cc, @cn, @chq, @cd, @rd, @am, @bk, @vt, @bn, @rm, @st, @cld, @cb);
      `);
    return res.status(201).json({ ok: true, pdcId: out.recordset[0].PDCId, matchedCustomerCode: customerCode });
  } catch (err) {
    console.error('[POST /api/sales/pdc] failed:', err.message);
    return res.status(500).json({ message: 'PDC create failed', detail: err.message });
  }
});

// ── PATCH /:id ───────────────────────────────────────────────────────────────
router.patch('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const id = parseInt(req.params.id, 10);
    const b  = req.body || {};
    const pool = await getAppPool();
    const r = pool.request().input('id', sql.Int, id);

    const sets = [];
    function add(field, value, type) {
      if (value === undefined) return;
      sets.push(`${field} = @${field}`);
      r.input(field, type, value === '' ? null : value);
    }

    if (b.customerCode !== undefined) add('CustomerCode', b.customerCode || null, sql.NVarChar(50));
    if (b.customerName !== undefined) add('CustomerName', b.customerName,         sql.NVarChar(200));
    if (b.chequeNo     !== undefined) add('ChequeNo',     b.chequeNo || null,     sql.NVarChar(50));
    if (b.chequeDate   !== undefined) add('ChequeDate',   b.chequeDate ? new Date(b.chequeDate) : null, sql.Date);
    if (b.receivedDate !== undefined) add('ReceivedDate', b.receivedDate ? new Date(b.receivedDate) : null, sql.Date);
    if (b.amount       !== undefined) add('Amount',       Number(b.amount) || 0,  sql.Decimal(18, 2));
    if (b.bankName     !== undefined) add('BankName',     b.bankName || null,     sql.NVarChar(100));
    if (b.vertical     !== undefined) add('Vertical',     b.vertical || null,     sql.NVarChar(50));
    if (b.billNo       !== undefined) add('BillNo',       b.billNo || null,       sql.NVarChar(500));
    if (b.remark       !== undefined) add('Remark',       b.remark || null,       sql.NVarChar(500));
    if (b.status       !== undefined) {
      const st      = normalizeStatus(b.status);
      const role    = (req.user.role || '').toLowerCase();
      const isAdmin = isFullAccess(req.user);
      if (!st) return res.status(400).json({ message: 'invalid status' });
      // Salespersons may only set "with_salesperson". Any other value sent by them
      // is silently dropped so they can still patch BankName, Remark etc. without
      // accidentally overriding a status accounts already set.
      if (isAdmin || st === 'with_salesperson') {
        add('Status', st, sql.NVarChar(20));
      }
    }
    if (b.clearedDate  !== undefined) add('ClearedDate',  b.clearedDate ? new Date(b.clearedDate) : null, sql.Date);

    if (!sets.length) return res.status(400).json({ message: 'no fields to update' });
    sets.push('UpdatedAt = SYSDATETIME()');
    await r.query(`UPDATE [dbo].[BN_PDC] SET ${sets.join(', ')} WHERE PDCId = @id;`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /api/sales/pdc] failed:', err.message);
    return res.status(500).json({ message: 'PDC update failed', detail: err.message });
  }
});

// ── DELETE /:id (soft) ──────────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, id)
      .query('UPDATE [dbo].[BN_PDC] SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE PDCId = @id;');
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'PDC delete failed', detail: err.message });
  }
});

// ── POST /import — Excel bulk import ────────────────────────────────────────
// Form-data: file (.xlsx), mapping (optional JSON), dryRun (optional 'true')
// Returns: { matched, unmatched, inserted, preview[] }
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const company = getCompany(req);
    const dryRun  = req.query.dryRun === 'true' || req.body.dryRun === 'true';

    // Parse mapping if provided; default mapping treats column headers literally
    // but also accepts the CHEQUES IN.xlsx swapped column names
    const defaultMapping = {
      // dest field → array of possible source header names (case-insensitive, trim-tolerant).
      // Header order matches the Add PDC form so accounts team uses the same vocabulary
      // in Excel as on screen. Legacy CHEQUES IN.xlsx swapped headers still supported.
      customerName: ['Customer Name', 'CUSTOMER NAME', 'NAME LIST', 'Customer', 'Name'],
      customerCode: ['Customer Code', 'CUSTOMER CODE', 'NAV Code', 'Code'],
      chequeNo:     ['Cheque No', 'CHEQUE NO', 'CHEQUE_DT', 'ChqNo', 'Cheque Number'],
      chequeDate:   ['Cheque Date', 'CHEQUE DATE', 'CHEQUE_NO', 'ChqDate', 'Date'],
      amount:       ['Amount', 'AMOUNT', 'IN AMT', 'Cheque Amount'],
      bankName:     ['Bank Name', 'BANK NAME', 'Bank'],
      vertical:     ['Vertical', 'VERTICAL', 'Team'],
      billNo:       ['Bill No', 'BILL NO', 'Invoice No', 'Invoice Number'],
      status:       ['Status', 'STATUS'],
      receivedDate: ['Received Date', 'RECEIVED DATE', 'Recv Date'],
      clearedDate:  ['Cleared Date', 'CLEARED DATE'],
      remark:       ['Remark', 'REMARK', 'CHEQUE REMARK', 'CHEQUE_REMARK', 'Notes'],
    };
    let mapping = defaultMapping;
    if (req.body.mapping) {
      try { mapping = JSON.parse(req.body.mapping); } catch (_) { /* keep default */ }
    }

    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return res.status(400).json({ message: 'No sheet found in workbook' });

    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });

    // Build a header→destination lookup based on actual sheet columns
    const sampleKeys = Object.keys(rows[0] || {});
    function findKey(destField) {
      const candidates = mapping[destField] || [];
      for (const sample of sampleKeys) {
        const norm = sample.toUpperCase().trim();
        if (candidates.some(c => c.toUpperCase().trim() === norm)) return sample;
      }
      return null;
    }
    const keyMap = {};
    for (const f of Object.keys(mapping)) keyMap[f] = findKey(f);

    const navPool = await getPool();
    const matchCache = new Map();
    async function cachedMatch(name) {
      const key = String(name || '').toUpperCase().trim();
      if (!key) return null;
      if (matchCache.has(key)) return matchCache.get(key);
      const code = await matchCustomerCode(navPool, company.prefix, name);
      matchCache.set(key, code);
      return code;
    }
    const codeCache = new Map();
    async function cachedCodeExists(code) {
      const key = String(code || '').toUpperCase().trim();
      if (!key) return false;
      if (codeCache.has(key)) return codeCache.get(key);
      const exists = await customerCodeExists(navPool, company.prefix, code);
      codeCache.set(key, exists);
      return exists;
    }

    // Parse rows
    const parsed = [];
    for (const row of rows) {
      const customerName = (row[keyMap.customerName] || '').toString().trim();
      if (!customerName) continue;   // skip blank lines
      // Customer Name is the source of truth for the NAV match: prefer the exact
      // name match; only fall back to the Excel's Customer Code when the name
      // didn't resolve AND that code actually exists in NAV. This stops a stray /
      // wrong code column from masking a real name mismatch (which must surface in
      // the Mismatch card). A name that resolves to no NAV customer → code stays
      // NULL → flagged as a Mismatch.
      const explicitCode = (row[keyMap.customerCode] || '').toString().trim();
      let customerCode = await cachedMatch(customerName);
      if (!customerCode && explicitCode && await cachedCodeExists(explicitCode)) {
        customerCode = explicitCode;
      }
      parsed.push({
        customerCode,
        customerName,
        chequeNo:     (row[keyMap.chequeNo] || '').toString().trim() || null,
        chequeDate:   parseExcelDate(row[keyMap.chequeDate]),
        amount:       parseAmount(row[keyMap.amount]),
        bankName:     (row[keyMap.bankName] || '').toString().trim() || null,
        vertical:     (row[keyMap.vertical] || '').toString().trim() || null,
        billNo:       (row[keyMap.billNo]   || '').toString().trim() || null,
        status:       normalizeStatus(row[keyMap.status]),
        receivedDate: parseExcelDate(row[keyMap.receivedDate]),
        clearedDate:  parseExcelDate(row[keyMap.clearedDate]),
        remark:       (row[keyMap.remark]   || '').toString().trim() || null,
      });
    }

    const matched   = parsed.filter(p => p.customerCode).length;
    const unmatched = parsed.length - matched;
    // A row is a "Mismatch" (needs fixing) if it has no NAV code OR is missing any
    // key field. SAME criteria the Mismatch card uses on stored rows — surfaced here
    // so the user sees, right after the upload, how many rows they must correct.
    const isMismatchRow = (p) => !p.customerCode
      || !p.chequeDate || !p.chequeNo || !(Number(p.amount) > 0) || !p.status;
    const mismatched = parsed.filter(isMismatchRow).length;

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        sheetName, rowsScanned: rows.length, rowsParsed: parsed.length,
        matched, unmatched, mismatched,
        detectedMapping: keyMap,
        preview: parsed.slice(0, 10),
      });
    }

    // Real import — UPSERT (insert new, update existing in place).
    // Identity key: Company + ChequeNo + Amount + ChequeDate. Re-importing the same
    // Excel after editing Status / Remark / Bank etc. now SYNCS those changes onto
    // the existing rows instead of skipping them — user no longer has to bulk-delete
    // and re-upload to refresh statuses (request 2026-05-27).
    const pool = await getAppPool();
    let inserted  = 0;
    let updated   = 0;
    let failed    = 0;
    const failures = [];   // first few failed rows reported back so user can see the cause
    for (const p of parsed) {
      try {
        const dupCheck = await pool.request()
          .input('co',  sql.NVarChar(10),  company.code)
          .input('chq', sql.NVarChar(50),  p.chequeNo || '')
          .input('am',  sql.Decimal(18,2), p.amount)
          .input('cd',  sql.Date,          p.chequeDate)
          .query(`
            SELECT TOP 1 PDCId FROM [dbo].[BN_PDC]
            WHERE IsActive = 1
              AND ISNULL(Company,'')  = @co
              AND ISNULL(ChequeNo,'') = @chq
              AND ISNULL(Amount, 0)   = @am
              AND ((ChequeDate IS NULL AND @cd IS NULL) OR ChequeDate = @cd);
          `);

        if (dupCheck.recordset.length > 0) {
          // UPDATE — sync editable fields from Excel onto the existing row.
          // CustomerCode/Name use COALESCE so a blank Excel cell never wipes
          // an existing NAV match.
          await pool.request()
            .input('id',  sql.Int,          dupCheck.recordset[0].PDCId)
            .input('cc',  sql.NVarChar(50),  p.customerCode)
            .input('cn',  sql.NVarChar(200), p.customerName)
            .input('bk',  sql.NVarChar(100), p.bankName)
            .input('vt',  sql.NVarChar(50),  p.vertical)
            .input('bn',  sql.NVarChar(500), p.billNo)
            .input('st',  sql.NVarChar(20),  p.status || null)
            .input('rd',  sql.Date,          p.receivedDate || null)
            .input('cld', sql.Date,          p.clearedDate  || null)
            .input('rm',  sql.NVarChar(500), p.remark)
            .query(`
              -- Upsert rule (2026-05-27): when re-importing, ONLY refresh fields
              -- the user actually wrote in the new Excel. Blank cells preserve the
              -- existing value. The user's main use case is just toggling Status
              -- and Remark on an existing cheque ("Not Deposited" → "Deposited
              -- in bank"); we mustn't wipe out Bank/Vertical/Dates if those columns
              -- are blank in the updated Excel.
              UPDATE [dbo].[BN_PDC] SET
                CustomerCode = COALESCE(NULLIF(@cc, ''), CustomerCode),
                CustomerName = COALESCE(NULLIF(@cn, ''), CustomerName),
                BankName     = COALESCE(NULLIF(@bk, ''), BankName),
                Vertical     = COALESCE(NULLIF(@vt, ''), Vertical),
                BillNo       = COALESCE(NULLIF(@bn, ''), BillNo),
                Status       = COALESCE(NULLIF(@st, ''), Status),
                ReceivedDate = COALESCE(@rd, ReceivedDate),
                ClearedDate  = COALESCE(@cld, ClearedDate),
                Remark       = COALESCE(NULLIF(@rm, ''), Remark),
                UpdatedAt    = SYSDATETIME()
              WHERE PDCId = @id;
            `);
          updated++;
          continue;
        }

        await pool.request()
          .input('co',  sql.NVarChar(10),  company.code)
          .input('cc',  sql.NVarChar(50),  p.customerCode)
          .input('cn',  sql.NVarChar(200), p.customerName)
          .input('chq', sql.NVarChar(50),  p.chequeNo)
          .input('cd',  sql.Date,          p.chequeDate)
          .input('rd',  sql.Date,          p.receivedDate || null)
          .input('cld', sql.Date,          p.clearedDate  || null)
          .input('am',  sql.Decimal(18,2), p.amount)
          .input('bk',  sql.NVarChar(100), p.bankName)
          .input('vt',  sql.NVarChar(50),  p.vertical)
          .input('bn',  sql.NVarChar(500), p.billNo)
          // Blank/unrecognised status stored as NULL (was defaulted to 'pending')
          // so a missing Status surfaces in the Mismatch card instead of hiding as
          // Pending. It still buckets as Pending for the status cards (ELSE branch).
          .input('st',  sql.NVarChar(20),  p.status || null)
          .input('rm',  sql.NVarChar(500), p.remark)
          .input('cb',  sql.Int,           req.user.id)
          .query(`
            INSERT INTO [dbo].[BN_PDC]
              (Company, CustomerCode, CustomerName, ChequeNo, ChequeDate,
               ReceivedDate, ClearedDate, Amount, BankName, Vertical, BillNo,
               Status, Remark, CreatedBy)
            VALUES
              (@co, @cc, @cn, @chq, @cd, @rd, @cld, @am, @bk, @vt, @bn, @st, @rm, @cb);
          `);
        inserted++;
      } catch (e) {
        failed++;
        if (failures.length < 10) failures.push({
          reason: e.message,
          customerName: p.customerName, chequeNo: p.chequeNo,
          amount: p.amount, chequeDate: p.chequeDate,
        });
        console.error('[pdc/import] row failed:', e.message, p);
      }
    }

    return res.json({
      ok: true, sheetName, rowsScanned: rows.length, rowsParsed: parsed.length,
      matched, unmatched, mismatched, inserted, updated, failed, failures,
    });
  } catch (err) {
    console.error('[POST /api/sales/pdc/import] failed:', err.message);
    return res.status(500).json({ message: 'PDC import failed', detail: err.message });
  }
});

// ── POST /bulk-delete — soft-delete many at once ───────────────────────────
router.post('/bulk-delete', authenticate, async (req, res) => {
  try {
    const ids = (req.body && Array.isArray(req.body.ids)) ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
    if (!ids.length) return res.status(400).json({ message: 'No PDC ids provided' });
    const pool = await getAppPool();
    const r = pool.request();
    ids.forEach((id, i) => r.input('id' + i, sql.Int, id));
    const result = await r.query(`
      UPDATE [dbo].[BN_PDC]
         SET IsActive = 0, UpdatedAt = SYSDATETIME()
       WHERE PDCId IN (${ids.map((_, i) => '@id' + i).join(',')})
         AND IsActive = 1;
    `);
    return res.json({ ok: true, deleted: result.rowsAffected[0] || 0, requested: ids.length });
  } catch (err) {
    console.error('[POST /api/sales/pdc/bulk-delete] failed:', err.message);
    return res.status(500).json({ message: 'Bulk delete failed', detail: err.message });
  }
});

// ── GET /export — Excel download ────────────────────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const search       = (req.query.search       || '').trim();
    const status       = (req.query.status       || '').trim();
    const customerCode = (req.query.customerCode || '').trim();
    // If ?ids=1,2,3 is provided, restrict the export to those PDCs only.
    // Used by "Export Selected" button on the PDC page.
    const idsParam = (req.query.ids || '').trim();
    const ids = idsParam ? idsParam.split(',').map(n => parseInt(n, 10)).filter(Number.isFinite) : [];

    const pool = await getAppPool();
    const r = pool.request();
    const where = ['IsActive = 1', '(Company IS NULL OR Company = @co)'];
    r.input('co', sql.NVarChar(10), company.code);
    if (ids.length) {
      ids.forEach((id, i) => r.input('eid' + i, sql.Int, id));
      where.push(`PDCId IN (${ids.map((_, i) => '@eid' + i).join(',')})`);
    } else {
      if (status && STATUSES.has(status)) { where.push('Status = @status'); r.input('status', sql.NVarChar(20), status); }
      if (customerCode) { where.push('CustomerCode = @cc'); r.input('cc', sql.NVarChar(50), customerCode); }
      if (search) {
        where.push(`(CustomerName LIKE @q OR ISNULL(ChequeNo,'') LIKE @q OR ISNULL(BillNo,'') LIKE @q)`);
        r.input('q', sql.NVarChar(300), '%' + search + '%');
      }
    }

    // SECURITY (2026-06-26): apply the SAME salesperson scope as the list/stats so a
    // rep can only ever export their OWN customers' cheques. This endpoint previously
    // had NO scope and leaked the entire BN_PDC table to any logged-in user. The scope
    // also constrains ?ids= (Export Selected) so a guessed PDCId can't exfiltrate a row.
    const scope = await resolvePdcScope(req, company);
    if (!scope.unrestricted) {
      if (!scope.customerCodes.length) {
        where.push('1 = 0');   // scoped user owns no customers → export nothing (not everything)
      } else {
        scope.customerCodes.forEach((c, i) => r.input('xcc' + i, sql.NVarChar(50), c));
        where.push(`CustomerCode IN (${scope.customerCodes.map((_, i) => '@xcc' + i).join(',')})`);
      }
    }

    const result = await r.query(`
      SELECT
        ChequeDate     AS [Cheque Date],
        CustomerName   AS [Customer Name],
        CustomerCode   AS [Customer Code],
        Amount         AS [Amount],
        ChequeNo       AS [Cheque No],
        BankName       AS [Bank Name],
        Vertical       AS [Vertical],
        BillNo         AS [Bill No],
        Status         AS [Status],
        ReceivedDate   AS [Received Date],
        ClearedDate    AS [Cleared Date],
        Remark         AS [Remark],
        CreatedAt      AS [Imported At]
      FROM [dbo].[BN_PDC]
      WHERE ${where.join(' AND ')}
      -- Oldest first; NULL dates last
      ORDER BY CASE WHEN ChequeDate IS NULL THEN 1 ELSE 0 END,
               ChequeDate ASC, PDCId ASC;
    `);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(result.recordset);
    xlsx.utils.book_append_sheet(wb, ws, 'PDC');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="COMPANYA_PDC_${company.code}_${new Date().toISOString().slice(0,10)}.xlsx"`);
    return res.end(buf);
  } catch (err) {
    console.error('[GET /api/sales/pdc/export] failed:', err.message);
    return res.status(500).json({ message: 'PDC export failed', detail: err.message });
  }
});

// ── POST /run-reminder — admin: fire the PDC cheque-deposit WhatsApp reminder now ──
// Body/query: { dryRun?: bool, companies?: ['COMPANYA',...] }. dryRun=true resolves the
// recipient chain + logs SKIPPED rows but sends nothing (safe pre-approval test).
router.post('/run-reminder', authenticate, async (req, res) => {
  if (!isFullAccess(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const dryRun = String(req.query.dryRun ?? req.body?.dryRun ?? '').toLowerCase() === 'true';
    const companies = req.body?.companies || (req.query.company ? [String(req.query.company).toUpperCase()] : undefined);
    const result = await require('../../../services/pdcReminderCron')
      .runNow({ isManual: true, dryRun, companies });
    return res.json({ ok: true, dryRun, result });
  } catch (err) {
    console.error('[POST /api/sales/pdc/run-reminder] failed:', err.message);
    return res.status(500).json({ message: 'PDC reminder run failed', detail: err.message });
  }
});

module.exports = router;
