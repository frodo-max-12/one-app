// =====================================================================
// modules/sales/routes/budget.js — Sales Budget vs Actual (v1.11)
// UNIFIED COMPANYA + CompanyB via getCompany(req). Budget = manual/imported annual target per
// salesperson (App DB, BN_SalesBudget); Actuals = live from NAV — Booking (sales orders),
// Billing (posted invoices), AR (collections received). Scoped self/team/all. MIS (role
// 'mis') + full-access see-all + edit. Budget amounts stored RAW in company currency.
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getPool, getAppPool } = require('../../../db');
const { authenticate, isFullAccess, isAnyHead, isMis } = require('../../../auth');
const { getCompany } = require('../../../shared/company');
require('../bookingLedger');   // registers the booking-freeze capture cron + startup backfill

const multer = require('multer');
const xlsx   = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// isMis (shared from auth.js) matches BOTH 'mis' and 'mis store' via \bmis\b.
const canSeeAll = (u) => isFullAccess(u) || isMis(u);
const canEdit   = (u) => isFullAccess(u) || isMis(u);

const SALES_ROLES = ['sales', 'international sales', 'north sales', 'south sales',
  'sales head', 'north sales head', 'south sales head', 'sales head electrical', 'electrical head'];

// ─── Fiscal helpers (Indian FY: fy=2026 → Apr-2026 .. Mar-2027) ──────────────
const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(y, m, 0).getDate();

function fmToCal(fy, fmi) {
  const month = fmi <= 9 ? fmi + 3 : fmi - 9;
  const year  = fmi <= 9 ? fy : fy + 1;
  return { year, month };
}
function currentFiscal() {
  const t = new Date(), cm = t.getMonth() + 1;
  return { fy: cm >= 4 ? t.getFullYear() : t.getFullYear() - 1, fmi: cm >= 4 ? cm - 3 : cm + 9 };
}
function fiscalRange(fy, period, fmi, weekDate) {
  period = (period || 'ytd').toLowerCase();
  fmi = Math.min(12, Math.max(1, parseInt(fmi, 10) || 1));
  const fyLabel = `FY ${fy}-${String(fy + 1).slice(2)}`;
  if (period === 'week') {
    const base = weekDate ? new Date(weekDate + 'T00:00:00') : new Date();
    const day = base.getDay();                                              // 0=Sun..6=Sat
    const mon = new Date(base); mon.setDate(base.getDate() + (day === 0 ? -6 : 1 - day));  // Monday
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const f = (x) => ymd(x.getFullYear(), x.getMonth() + 1, x.getDate());
    return { from: f(mon), to: f(sun), fraction: 1 / 60, label: `Week of ${f(mon)}` };     // Weekly budget = Annual ÷ 60
  }
  if (period === 'fy') return { from: ymd(fy, 4, 1), to: ymd(fy + 1, 3, 31), fraction: 1, label: fyLabel };
  if (period === 'quarter') {
    const q = Math.ceil(fmi / 3);
    const s = fmToCal(fy, (q - 1) * 3 + 1), e = fmToCal(fy, (q - 1) * 3 + 3);
    return { from: ymd(s.year, s.month, 1), to: ymd(e.year, e.month, lastDay(e.year, e.month)),
             fraction: 0.25, label: `Q${q} ${fyLabel}` };
  }
  if (period === 'month') {
    const c = fmToCal(fy, fmi);
    return { from: ymd(c.year, c.month, 1), to: ymd(c.year, c.month, lastDay(c.year, c.month)),
             fraction: 1 / 12, label: `${MONTHS[fmi - 1]}-${String(c.year).slice(2)}` };
  }
  const c = fmToCal(fy, fmi);
  return { from: ymd(fy, 4, 1), to: ymd(c.year, c.month, lastDay(c.year, c.month)),
           fraction: fmi / 12, label: `YTD (Apr–${MONTHS[fmi - 1]}) ${fyLabel}` };
}

// Salesperson scope for NAV actuals — fail-closed for scoped users with no codes.
function navScope(user, company, colExpr) {
  if (canSeeAll(user)) return { clause: '', codes: [] };
  const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';
  const codes = (user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);
  if (!codes.length) return { clause: ' AND 1=0 ', codes: [] };
  const ph = codes.map((_, i) => `@sc${i}`).join(',');
  return { clause: ` AND ${colExpr} IN (${ph}) `, codes };
}
const bindCodes = (r, codes) => codes.forEach((c, i) => r.input(`sc${i}`, sql.NVarChar(20), c));

// Ex-Stock inventory definition is shared with the Inventory page — see modules/sales/exStock.js.
const { EX_STOCK_VALUE, exStockSQL } = require('../exStock');
// Budgets are TYPED/imported in ₹ Lakh (COMPANYA) / $ '000 (CompanyB) — like the MIS sheet — and
// stored RAW (× factor) so they compare against raw NAV actuals.
const unitFactor = (company) => (company.code === 'COMPANYB' ? 1000 : 100000);

// ─── Manual Booking-Actual upload helpers ────────────────────────────────────
// Booking ACTUAL now comes from the "<Co> Booking Billing Consolidated" sheet MIS
// uploads (BN_SalesBookingActual), NOT NAV SO-backlog (which counts schedule orders).
// The sheet identifies the rep by display name ("ISR NAME"); the page keys on the NAV
// salesperson code — so resolve name → code here.
const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Holders = every active login that holds a code for THIS company (ANY role — e.g. a
// "north sales head" like a north sales head is still a booking salesperson) + the budget name
// map. Returns [{ name(normalised), code, display }].
async function loadBookingHolders(appPool, companyCode) {
  const codeCol = companyCode === 'COMPANYA' ? 'CompanyACode' : 'CompanyBCode';
  const ul = await appPool.request().query(
    `SELECT Name, ${codeCol} AS Code FROM dbo.User_Login WHERE IsActive = 1 AND ISNULL(${codeCol},'') <> '';`);
  const bud = await appPool.request().input('c', sql.NVarChar(10), companyCode)
    .query(`SELECT SalespersonName AS Name, SalespersonCode AS Code FROM dbo.BN_SalesBudget WHERE Company = @c;`);
  const holders = [], seen = new Set();
  const add = (name, codeRaw) => {
    const code = (String(codeRaw || '').split('/')[0] || '').trim();
    const n = normName(name);
    if (!code || !n) return;
    const key = n + '|' + code; if (seen.has(key)) return; seen.add(key);
    holders.push({ name: n, code, display: name });
  };
  ul.recordset.forEach(u => add(u.Name, u.Code));
  bud.recordset.forEach(b => add(b.Name, b.Code));
  return holders;
}

// ─── Canonical salesperson-code merge map (BN_SalespersonMerge) ───────────────
// A rep who exists in NAV under TWO salesperson codes (a live one + a dead duplicate that
// still carries residual invoices/AR we can't move — NAV is read-only) must show as ONE row.
// This returns { FromCode: ToCode } for the company; callers build canon(code) = map[code]||code
// and fold every code through it BEFORE grouping, so a dead code's actuals attribute to the
// real person and totals stay complete. Heads carrying a junior's code are NOT in this table.
// Fails soft (returns {}) if the table doesn't exist yet, so the module runs pre-migration.
async function loadMergeMap(appPool, companyCode) {
  try {
    const rs = await appPool.request().input('c', sql.NVarChar(10), companyCode)
      .query(`SELECT FromCode, ToCode FROM dbo.BN_SalespersonMerge WHERE Company = @c;`);
    const m = {};
    rs.recordset.forEach(r => { const f = (r.FromCode || '').trim(), t = (r.ToCode || '').trim(); if (f && t) m[f] = t; });
    return m;
  } catch (e) { return {}; }
}

// Resolve one ISR NAME → a single code. Order: exact → prefix (either way, covers
// "A B" ⊂ "A B C") → single-token surname as a whole word ("Surname"
// → "Shekhar a colleague"). A name that resolves to >1 distinct code is AMBIGUOUS → null.
function resolveBookingCode(isr, holders) {
  const n = normName(isr);
  if (!n) return null;
  const uniq = (cands) => { const codes = [...new Set(cands.map(h => h.code))]; return codes.length === 1 ? codes[0] : null; };
  let hit = holders.filter(h => h.name === n);                                   // 1) exact
  if (hit.length) return uniq(hit);
  hit = holders.filter(h => h.name.startsWith(n) || n.startsWith(h.name));       // 2) prefix either way
  if (hit.length) return uniq(hit);
  if (n.split(' ').length === 1) {                                              // 3) single-token surname
    hit = holders.filter(h => h.name.split(' ').includes(n));
    if (hit.length) return uniq(hit);
  }
  return null;
}

// Excel date cell → 'YYYY-MM-DD', immune to the SheetJS ~10s-before-midnight bug
// ([[feedback_excel_import_date_offset]]): snap the serial to the nearest whole day and
// anchor at UTC noon. Also accepts a US "m/d/yy" string or a JS Date.
function excelDateToYMD(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const days = Math.round(v);                                                 // snap to nearest day
    const d = new Date(Math.round((days - 25569) * 86400 * 1000) + 12 * 3600 * 1000);  // + UTC noon
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (v instanceof Date) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) { const mo = +m[1], da = +m[2]; let yr = +m[3]; if (yr < 100) yr += 2000; return ymd(yr, mo, da); }
  const d = new Date(s); return isNaN(d.getTime()) ? null : ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// ─── The Budget vs Actual comparison (Booking, Billing, AR) — shared by GET / + /export ──
async function buildComparison(req) {
    const company = getCompany(req);
    const P = company.prefix;
    const user = req.user;

    const cf = currentFiscal();
    const fy = parseInt(req.query.fiscalYear, 10) || cf.fy;
    const period = (req.query.period || 'month').toLowerCase();
    const fmi = parseInt(req.query.month, 10) || cf.fmi;
    const { from, to, fraction, label } = fiscalRange(fy, period, fmi, (req.query.weekDate || '').trim());

    const navPool = await getPool();
    const appPool = await getAppPool();

    // Canonical-code fold: a duplicate NAV code's data attributes to the kept code (one row).
    const mergeMap = await loadMergeMap(appPool, company.code);
    const canon = (c) => mergeMap[(c || '').trim()] || (c || '').trim();

    // ---- Billing actual (posted invoices, Posting Date, Unit Price × Qty) ----
    const bScope = navScope(user, company, 'SIH.[Salesperson Code]');
    const bReq = navPool.request().input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to));
    bindCodes(bReq, bScope.codes);
    const billing = await bReq.query(`
      SELECT SIH.[Salesperson Code] AS Code,
             SUM(ISNULL(SIL.[Unit Price],0) * ISNULL(SIL.[Quantity],0)) AS Actual
      FROM ${P}Sales Invoice Header] SIH
      JOIN ${P}Sales Invoice Line] SIL ON SIL.[Document No_] = SIH.[No_]
      WHERE CAST(SIH.[Posting Date] AS DATE) BETWEEN @from AND @to
        AND ISNULL(SIL.[Type],0) = 2
        AND NOT EXISTS (SELECT 1 FROM ${P}Sales Cr_Memo Header] CM WHERE CM.[Applies-to Doc_ No_] = SIH.[No_])
        ${bScope.clause}
      GROUP BY SIH.[Salesperson Code];`);

    // ---- Booking actual (manual upload by Booking Date — see BN_SalesBookingActual) ----
    // MIS uploads the "<Co> Booking Billing Consolidated" sheet (POST /booking-import); we sum
    // its Amount by the resolved salesperson over the period. NAV SO-backlog is NOT used — it
    // counts schedule orders, so it's not a correct booking figure (per MIS). This is a FLOW
    // (period date range), exactly like Billing. Booking BUDGET is still annual×fraction.
    const kScope = navScope(user, company, 'SalespersonCode');
    const kReq = appPool.request().input('c', sql.NVarChar(10), company.code)
      .input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to));
    bindCodes(kReq, kScope.codes);
    const booking = await kReq.query(`
      SELECT SalespersonCode AS Code, SUM(Amount) AS Actual
      FROM dbo.BN_SalesBookingActual
      WHERE Company = @c AND SalespersonCode IS NOT NULL
        AND BookingDate BETWEEN @from AND @to ${kScope.clause}
      GROUP BY SalespersonCode;`);

    // Unattributed booking = uploaded rows whose ISR name didn't resolve to a code (e.g. ex-staff
    // who left). Kept OUT of the per-person rows but ADDED to the company total (full-access only)
    // as an "(Ex-staff / Unattributed)" bucket so Booking isn't understated — per the user: hide
    // ex-staff as people, but their numbers still count in the total.
    let unattributedBooking = 0;
    if (canSeeAll(user)) {
      const ub = await appPool.request().input('c', sql.NVarChar(10), company.code)
        .input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to))
        .query(`SELECT ISNULL(SUM(Amount),0) AS Amt FROM dbo.BN_SalesBookingActual
                WHERE Company=@c AND SalespersonCode IS NULL AND BookingDate BETWEEN @from AND @to;`);
      unattributedBooking = Number(ub.recordset[0].Amt || 0);
    }

    // ---- AR actual (collections against the rep's OWN invoices in the period) ----
    // INVOICE-LEVEL (per MIS, 2026-07-22): when a payment/credit pays down an invoice, NAV posts a
    // NEGATIVE Detailed entry ON that invoice's ledger entry, so we credit the salesperson who MADE
    // the sale (cle.[Salesperson Code]) — matching the invoice-level outstanding below. (Was
    // customer-level, which gave the customer owner every rep's collections for that account.)
    const aScope = navScope(user, company, 'cle.[Salesperson Code]');
    const aReq = navPool.request().input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to));
    bindCodes(aReq, aScope.codes);
    const ar = await aReq.query(`
      SELECT cle.[Salesperson Code] AS Code, -SUM(d.[Amount (LCY)]) AS Actual
      FROM ${P}Detailed Cust_ Ledg_ Entry] d
      JOIN ${P}Cust_ Ledger Entry] cle ON cle.[Entry No_] = d.[Cust_ Ledger Entry No_]
      WHERE cle.[Document Type] = 2
        AND CAST(d.[Posting Date] AS DATE) BETWEEN @from AND @to
        AND d.[Amount (LCY)] < 0
        ${aScope.clause}
      GROUP BY cle.[Salesperson Code];`);

    // ---- AR budget = each rep's OWN open-invoice balance as of the period-END (INVOICE-LEVEL) ----
    // Attributed to the salesperson on each ledger entry (the invoice's maker), NOT the customer
    // owner — so a customer billed by several reps splits across them (a customer's ₹99.61 L → rep A
    // ₹57 + rep B ₹28 + rep C ₹15, instead of all to the account owner). Payments post on the
    // invoice they pay, so this net = each rep's unpaid-invoice AR. So AR % = collected ÷ own AR.
    const arbScope = navScope(user, company, 'cle.[Salesperson Code]');
    const arbReq = navPool.request().input('asof', sql.Date, new Date(to));
    bindCodes(arbReq, arbScope.codes);
    const arOut = await arbReq.query(`
      SELECT cle.[Salesperson Code] AS Code, SUM(d.[Amount (LCY)]) AS Outstanding
      FROM ${P}Detailed Cust_ Ledg_ Entry] d
      JOIN ${P}Cust_ Ledger Entry] cle ON cle.[Entry No_] = d.[Cust_ Ledger Entry No_]
      WHERE CAST(d.[Posting Date] AS DATE) <= @asof ${arbScope.clause}
      GROUP BY cle.[Salesperson Code]
      HAVING SUM(d.[Amount (LCY)]) <> 0;`);

    // ---- AR overdue = open INVOICE AR past its Due Date as of period-end (invoice-level) ----
    // The ageing-discipline signal beside collection efficiency: how much of a rep's own open
    // INVOICE AR is already overdue. Overdue % = Overdue ÷ Open-invoice AR (arOpenInv below),
    // NOT ÷ net Closing — net Closing subtracts credit-memos / on-account payments that carry the
    // rep's code, so it can be smaller than the overdue numerator and push Overdue% over 100%.
    // Open-invoice AR is the SAME Document Type=2 basis with the Due-Date filter removed, so Overdue
    // is always a subset of it → Overdue% is bounded 0-100%.
    const arodScope = navScope(user, company, 'cle.[Salesperson Code]');
    const arodReq = navPool.request().input('asof', sql.Date, new Date(to));
    bindCodes(arodReq, arodScope.codes);
    const arOverdue = await arodReq.query(`
      SELECT cle.[Salesperson Code] AS Code,
             SUM(d.[Amount (LCY)]) AS OpenInv,
             SUM(CASE WHEN CAST(cle.[Due Date] AS DATE) < @asof THEN d.[Amount (LCY)] ELSE 0 END) AS Overdue
      FROM ${P}Detailed Cust_ Ledg_ Entry] d
      JOIN ${P}Cust_ Ledger Entry] cle ON cle.[Entry No_] = d.[Cust_ Ledger Entry No_]
      WHERE CAST(d.[Posting Date] AS DATE) <= @asof
        AND cle.[Document Type] = 2
        ${arodScope.clause}
      GROUP BY cle.[Salesperson Code]
      HAVING SUM(d.[Amount (LCY)]) <> 0;`);

    // ---- Inventory Ex-Stock (open Ex-Stock SO value AS OF period end — a stock, not a flow) ----
    // Same basis as the Inventory page (mode=soInventory) so the two never disagree. Previously
    // this only counted lines ORDERED inside the period, which under-reported stock badly
    // (Jul-2026 COMPANYA: ₹7.81 L counted vs ₹259.12 L actually held).
    const iScope = navScope(user, company, 'h.[Salesperson Code]');
    const iReq = navPool.request().input('asof', sql.Date, new Date(to));
    bindCodes(iReq, iScope.codes);
    const inventory = await iReq.query(exStockSQL(P, {
      select: `h.[Salesperson Code] AS Code, SUM(${EX_STOCK_VALUE}) AS Actual`,
      groupBy: 'h.[Salesperson Code]',
      scope: iScope.clause,
    }));

    // ---- Visit planned/done (App DB BN_VisitPlan, manual plan = BeatId IS NULL) ----
    // Visits are stored under Company='COMPANYA' + the COMPANYA salesperson code (a rep's visit plan is
    // the same person regardless of invoice company). We always read the COMPANYA rows here and, for
    // the CompanyB view, translate COMPANYA code → CompanyB code below (see companyaToCompanyKey). Scope by the
    // user's COMPANYA code (not the company code) so an CompanyB-viewing rep still sees their own visits.
    let visit = { recordset: [] };
    {
      const vAll = canSeeAll(user);
      const vCompanyACodes = vAll ? [] : (user.companyaCode || '').split('/').map(s => s.trim()).filter(Boolean);
      const vReq = appPool.request().input('vfrom', sql.Date, new Date(from)).input('vto', sql.Date, new Date(to));
      let vWhere = "Company='COMPANYA' AND BeatId IS NULL AND VisitDate >= @vfrom AND VisitDate <= @vto";
      if (!vAll) {
        if (!vCompanyACodes.length) vWhere += ' AND 1=0';
        else { vWhere += ` AND SalespersonCode IN (${vCompanyACodes.map((_, i) => `@vc${i}`).join(',')})`;
               vCompanyACodes.forEach((c, i) => vReq.input(`vc${i}`, sql.NVarChar(50), c)); }
      }
      visit = await vReq.query(`SELECT SalespersonCode AS Code, COUNT(*) AS Planned,
        SUM(CASE WHEN VisitDone = 1 THEN 1 ELSE 0 END) AS Done
        FROM dbo.BN_VisitPlan WHERE ${vWhere} GROUP BY SalespersonCode;`);
    }

    // ---- Salesperson name map (NAV master) ----
    const spNames = await navPool.request().query(`SELECT [Code], [Name] FROM ${P}Salesperson_Purchaser];`);
    const nameOf = {};
    spNames.recordset.forEach(r => { nameOf[(r.Code || '').trim()] = (r.Name || '').trim(); });

    // ---- Budgets (App DB) ----
    const budScopeAll = canSeeAll(user);
    const budCodes = budScopeAll ? [] : navScope(user, company, 'x').codes;
    const budReq = appPool.request().input('c', sql.NVarChar(10), company.code).input('fy', sql.Int, fy);
    let budWhere = 'Company = @c AND FiscalYear = @fy';
    if (!budScopeAll) {
      if (!budCodes.length) budWhere += ' AND 1 = 0';
      else { budWhere += ` AND SalespersonCode IN (${budCodes.map((_, i) => `@bc${i}`).join(',')})`;
             budCodes.forEach((c, i) => budReq.input(`bc${i}`, sql.NVarChar(20), c)); }
    }
    const budgets = await budReq.query(
      `SELECT SalespersonCode, SalespersonName, BookingAnnual, BillingAnnual, ARAnnual, InventoryAnnual, VisitTargetAnnual
       FROM dbo.BN_SalesBudget WHERE ${budWhere};`);

    // ---- Sales-team map (User_Login, both companies' codes) ----
    // Drives (1) the row filter (validCodes) — else AR-outstanding pulls in every code assigned
    // to a customer (CSRs, FAE, product logins); and (2) COMPANYA→CompanyB visit translation
    // (companyaToCompanyKey: a rep's COMPANYA visit code → the code used as their row key in THIS company).
    const teamRows = await appPool.request().query(`SELECT Name, CompanyACode, CompanyBCode, Role FROM dbo.User_Login WHERE IsActive = 1;`);
    const validCodes = new Set(budgets.recordset.map(b => (b.SalespersonCode || '').trim()).filter(Boolean));
    // activeUserCodes = every code held by an ACTIVE User_Login (any role) for this company. A row
    // whose code isn't here is ex-staff / no ONE App account — its data still counts in the TOTALS
    // (so Booking/Billing/AR stay correct) but the frontend hides it from per-person views.
    const activeUserCodes = new Set();
    const firstTok = (s) => normName(s).split(' ')[0] || '';
    const companyaToCompanyKey = {};
    teamRows.recordset.forEach(u => {
      const companya = (u.CompanyACode || '').split('/').map(s => s.trim()).filter(Boolean);
      const adv = (u.CompanyBCode || '').split('/').map(s => s.trim()).filter(Boolean);
      const coCodes = company.code === 'COMPANYA' ? companya : adv;
      // This login's OWN code (the person). A single-code login → that code. A multi-code (head)
      // union → the member whose NAV name matches the login name — so team-member / EX-STAFF codes
      // carried inside a head's union are NOT counted as users (e.g. Jitendra Kasar / Santosh Sharma
      // sit only in the Electrical Head's union and have no login of their own → hidden). A rep only
      // counts as a user if they hold their OWN username/password.
      if (coCodes.length === 1) { activeUserCodes.add(coCodes[0]); }
      else if (coCodes.length > 1) {
        const ln = normName(u.Name), lf = firstTok(u.Name);
        const own = coCodes.find(c => normName(nameOf[c]) === ln) || coCodes.find(c => firstTok(nameOf[c]) === lf);
        if (own) activeUserCodes.add(own);
      }
      if (SALES_ROLES.includes((u.Role || '').toLowerCase().trim()))
        coCodes.forEach(c => validCodes.add(c));
      if (companya.length) { const key = company.code === 'COMPANYA' ? companya[0] : adv[0]; if (key) companyaToCompanyKey[companya[0]] = key; }
    });
    // Anyone who appears in the uploaded Booking sheet (resolved to a code) is a booking
    // salesperson — include them in the row set even if they're an admin / have no budget row
    // (e.g. the ops head Terkhedkar, the director Jain). Booking codes come from MIS's curated upload,
    // so this can't pull in junk the way AR-outstanding would.
    booking.recordset.forEach(a => { const c = (a.Code || '').trim(); if (c) validCodes.add(c); });

    // ---- Visit TARGET (always from the COMPANYA budget — one plan per person, shown in both companies) ----
    const vtAll = canSeeAll(user);
    const vtCompanyA = vtAll ? [] : (user.companyaCode || '').split('/').map(s => s.trim()).filter(Boolean);
    const vtReq = appPool.request().input('vfy', sql.Int, fy);
    let vtWhere = "Company='COMPANYA' AND FiscalYear=@vfy";
    if (!vtAll) {
      if (!vtCompanyA.length) vtWhere += ' AND 1=0';
      else { vtWhere += ` AND SalespersonCode IN (${vtCompanyA.map((_, i) => `@vt${i}`).join(',')})`;
             vtCompanyA.forEach((c, i) => vtReq.input(`vt${i}`, sql.NVarChar(20), c)); }
    }
    const companyaVisitTargets = await vtReq.query(`SELECT SalespersonCode, VisitTargetAnnual FROM dbo.BN_SalesBudget WHERE ${vtWhere};`);

    // ---- Merge by salesperson code ----
    const rows = {};
    const touch = (rawCode) => { const code = canon(rawCode); return (rows[code] = rows[code] || {
      code, name: nameOf[code] || code,
      bookingBudget: 0, bookingActual: 0, billingBudget: 0, billingActual: 0, arBudget: 0, arActual: 0,
      arClosing: 0, arOverdue: 0, arOpenInv: 0,
      inventoryBudget: 0, inventoryActual: 0, visitTarget: 0, visitPlanned: 0, visitDone: 0 }); };
    budgets.recordset.forEach(b => {
      const code = (b.SalespersonCode || '').trim(); if (!code) return;
      const row = touch(code);
      if (b.SalespersonName) row.name = b.SalespersonName;
      row.bookingBudget   = Number(b.BookingAnnual || 0) * fraction;
      row.billingBudget   = Number(b.BillingAnnual || 0) * fraction;
      // Visit target is per-person (same plan both companies) — sourced from the COMPANYA budget below.
      // AR budget is NOT uploaded — it's the outstanding AR as of period-end (set from `arOut` below).
      // Inventory budget is NOT uploaded — it's the open Ex-Stock SO value (set from `inventory` below).
    });
    // += (not =) so two codes that fold onto the same canonical row accumulate (e.g. a dup's residual invoices).
    billing.recordset.forEach(a => { const c = (a.Code || '').trim(); if (c) touch(c).billingActual += Number(a.Actual || 0); });
    booking.recordset.forEach(a => { const c = (a.Code || '').trim(); if (c) touch(c).bookingActual += Number(a.Actual || 0); });
    ar.recordset.forEach(a => { const c = (a.Code || '').trim(); if (c) touch(c).arActual += Number(a.Actual || 0); });         // Collected in period
    arOut.recordset.forEach(a => { const c = (a.Code || '').trim(); if (c) touch(c).arClosing += Number(a.Outstanding || 0); }); // Closing AR (still owed)
    arOverdue.recordset.forEach(a => { const c = (a.Code || '').trim(); if (!c) return;
      const row = touch(c); row.arOverdue += Number(a.Overdue || 0); row.arOpenInv += Number(a.OpenInv || 0); }); // overdue slice + gross open-invoice AR
    // AR = COLLECTION EFFICIENCY (per MIS 2026-07-23): Budget = "Collectible" = Collected + Closing AR
    // (= opening AR + billing this period); % = Collected ÷ Collectible → bounded 0–100%, safe for the
    // leaderboard/Overall blend. Overdue % (ageing discipline) = Overdue ÷ Open-invoice AR, shown beside it.
    Object.values(rows).forEach(row => { row.arBudget = Number(row.arActual || 0) + Number(row.arClosing || 0); });
    // Inventory (per MIS 2026-07-23): Budget = Ex-Stock + Billing (total ex-stock exposure);
    // Actual = Billing; % = Billed ÷ (Ex-Stock + Billed) = how much of the total ex-stock has been
    // billed (a depletion/conversion rate). Was Budget = Ex-Stock only, % = Billed ÷ Ex-Stock.
    inventory.recordset.forEach(a => { const c = (a.Code || '').trim(); if (c) touch(c).inventoryBudget += Number(a.Actual || 0); });  // Ex-Stock (raw) first
    Object.values(rows).forEach(row => {
      row.inventoryActual = row.billingActual;                                                   // Billed
      row.inventoryBudget = Number(row.inventoryBudget || 0) + Number(row.billingActual || 0);   // Ex-Stock + Billed
    });
    // Visit (target + planned + done): all keyed by COMPANYA code → translate to this company's key
    // (identity for COMPANYA, COMPANYA→CompanyB code for CompanyB) so a rep's visit plan shows in BOTH companies.
    const visitKey = (companya) => companyaToCompanyKey[companya] || (company.code === 'COMPANYA' ? companya : null);
    companyaVisitTargets.recordset.forEach(b => {
      const companya = (b.SalespersonCode || '').trim(); if (!companya) return;
      const key = visitKey(companya); if (key) touch(key).visitTarget += Number(b.VisitTargetAnnual || 0) * fraction;
    });
    visit.recordset.forEach(a => {
      const companya = (a.Code || '').trim(); if (!companya) return;
      const key = visitKey(companya);
      if (key) { const row = touch(key); row.visitPlanned += Number(a.Planned || 0); row.visitDone += Number(a.Done || 0); }
    });

    const pct = (act, bud) => (bud > 0 ? Math.round((act / bud) * 10000) / 100 : null);
    // Overall = every metric counts EQUALLY, and Visit is just one of them. The 4 CURRENCY metrics
    // with budget>0 are blended Σactual÷Σbudget (rupee-weighted among themselves — a rep's big-money
    // line matters more) → ONE money score standing in for `comps` metrics; VISIT joins as an equal
    // component = its plain Done÷Target %, treated identically to the others (no cap, no special
    // rule). A metric only contributes if it has a budget/target>0 (so no visit plan → money-only).
    const CUR_PAIRS = [['bookingActual', 'bookingBudget'], ['billingActual', 'billingBudget'],
                       ['arActual', 'arBudget'], ['inventoryActual', 'inventoryBudget']];
    const blendedOverall = (o) => {
      let na = 0, nb = 0, comps = 0;
      CUR_PAIRS.forEach(([ak, bk]) => { if (Number(o[bk]) > 0) { na += Number(o[ak] || 0); nb += Number(o[bk] || 0); comps++; } });
      const curPct = nb > 0 ? (na / nb) * 100 : null;
      const visitPct = Number(o.visitTarget) > 0 ? (Number(o.visitDone || 0) / Number(o.visitTarget)) * 100 : null;
      let sum = 0, wt = 0;
      if (curPct != null) { sum += curPct * comps; wt += comps; }   // money = `comps` equal metrics
      if (visitPct != null) { sum += visitPct; wt += 1; }            // visit = 1 equal metric
      return wt > 0 ? Math.round((sum / wt) * 100) / 100 : null;
    };
    const list = Object.values(rows).filter(r => validCodes.has(r.code)).map(r => ({
      ...r,
      isUser: activeUserCodes.has(r.code),   // true = current ONE App user (has an active login)
      bookingPct: pct(r.bookingActual, r.bookingBudget),
      billingPct: pct(r.billingActual, r.billingBudget),
      arPct: pct(r.arActual, r.arBudget),                    // Collection Efficiency = Collected ÷ Collectible
      arOverduePct: pct(r.arOverdue, r.arOpenInv),           // Overdue ÷ open-invoice AR (ageing discipline, 0–100%)
      inventoryPct: pct(r.inventoryActual, r.inventoryBudget),
      visitPct: pct(r.visitDone, r.visitTarget),   // Visit % = Done ÷ Target
      overall: blendedOverall(r),
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Add the unattributed (ex-staff) booking bucket so the TOTAL is complete. isUser:false → the
    // dashboard hides it from per-person charts; it shows in the detail table + counts in totals.
    if (unattributedBooking > 0) {
      list.push({ code: '__UNATTRIBUTED__', name: '(Ex-staff / Unattributed)', isUser: false,
        bookingBudget: 0, bookingActual: unattributedBooking, bookingPct: null,
        billingBudget: 0, billingActual: 0, billingPct: null,
        arBudget: 0, arActual: 0, arPct: null, arClosing: 0, arOverdue: 0, arOpenInv: 0, arOverduePct: null,
        inventoryBudget: 0, inventoryActual: 0, inventoryPct: null,
        visitTarget: 0, visitPlanned: 0, visitDone: 0, visitPct: null, overall: null });
    }

    const totals = list.reduce((t, r) => ({
      bookingBudget: t.bookingBudget + r.bookingBudget, bookingActual: t.bookingActual + r.bookingActual,
      billingBudget: t.billingBudget + r.billingBudget, billingActual: t.billingActual + r.billingActual,
      arBudget: t.arBudget + r.arBudget, arActual: t.arActual + r.arActual,
      arClosing: t.arClosing + r.arClosing, arOverdue: t.arOverdue + r.arOverdue, arOpenInv: t.arOpenInv + r.arOpenInv,
      inventoryBudget: t.inventoryBudget + r.inventoryBudget, inventoryActual: t.inventoryActual + r.inventoryActual,
      visitTarget: t.visitTarget + r.visitTarget, visitPlanned: t.visitPlanned + r.visitPlanned, visitDone: t.visitDone + r.visitDone,
    }), { bookingBudget: 0, bookingActual: 0, billingBudget: 0, billingActual: 0, arBudget: 0, arActual: 0,
          arClosing: 0, arOverdue: 0, arOpenInv: 0,
          inventoryBudget: 0, inventoryActual: 0, visitTarget: 0, visitPlanned: 0, visitDone: 0 });
    totals.bookingPct = pct(totals.bookingActual, totals.bookingBudget);
    totals.billingPct = pct(totals.billingActual, totals.billingBudget);
    totals.arPct = pct(totals.arActual, totals.arBudget);
    totals.arOverduePct = pct(totals.arOverdue, totals.arOpenInv);
    totals.inventoryPct = pct(totals.inventoryActual, totals.inventoryBudget);
    totals.visitPct = pct(totals.visitDone, totals.visitTarget);
    totals.overall = blendedOverall(totals);

    return {
      company: company.code, currency: company.currency, symbol: company.symbol,
      fiscalYear: fy, period, month: fmi, range: { from, to, label },
      canEdit: canEdit(user), rows: list, totals,
    };
}

router.get('/', authenticate, async (req, res) => {
  try { res.json(await buildComparison(req)); }
  catch (err) {
    console.error('[GET /api/sales/budget] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Failed to load Budget vs Actual', detail: err.message });
  }
});

// ─── GET /monthly?fiscalYear=&metric= — 12-month (Apr→Mar) trend per salesperson ──
router.get('/monthly', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const P = company.prefix;
    const user = req.user;
    const fy = parseInt(req.query.fiscalYear, 10) || currentFiscal().fy;
    const metric = ['booking', 'billing', 'ar', 'inventory', 'visit'].includes((req.query.metric || '').toLowerCase())
      ? req.query.metric.toLowerCase() : 'billing';
    const from = ymd(fy, 4, 1), to = ymd(fy + 1, 3, 31);
    const FMI = (dc) => `((MONTH(${dc}) + 8) % 12) + 1`;   // calendar month → fiscal index (Apr=1..Mar=12)

    const navPool = await getPool();
    const appPool = await getAppPool();
    const mergeMap = await loadMergeMap(appPool, company.code);       // fold duplicate NAV codes onto the kept code
    const canon = (c) => mergeMap[(c || '').trim()] || (c || '').trim();
    const newReq = () => { const r = navPool.request().input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to)); return r; };

    let actualRs;
    if (metric === 'booking') {
      // Booking = manual upload by Booking Date (App DB BN_SalesBookingActual) — not NAV.
      const s = navScope(user, company, 'SalespersonCode');
      const r = appPool.request().input('c', sql.NVarChar(10), company.code)
        .input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to));
      bindCodes(r, s.codes);
      actualRs = await r.query(`
        SELECT SalespersonCode AS Code, ((MONTH(BookingDate)+8)%12)+1 AS Fmi, SUM(Amount) AS Actual
        FROM dbo.BN_SalesBookingActual
        WHERE Company=@c AND SalespersonCode IS NOT NULL AND BookingDate BETWEEN @from AND @to ${s.clause}
        GROUP BY SalespersonCode, ((MONTH(BookingDate)+8)%12)+1;`);
    } else if (metric === 'ar') {
      // Invoice-level collections (matches buildComparison) — AR reduced against the rep's own
      // invoices each fiscal month, credited to the invoice's salesperson.
      const s = navScope(user, company, 'cle.[Salesperson Code]'); const r = newReq(); bindCodes(r, s.codes);
      actualRs = await r.query(`
        SELECT cle.[Salesperson Code] AS Code, ${FMI('d.[Posting Date]')} AS Fmi, -SUM(d.[Amount (LCY)]) AS Actual
        FROM ${P}Detailed Cust_ Ledg_ Entry] d
        JOIN ${P}Cust_ Ledger Entry] cle ON cle.[Entry No_]=d.[Cust_ Ledger Entry No_]
        WHERE cle.[Document Type]=2 AND CAST(d.[Posting Date] AS DATE) BETWEEN @from AND @to
          AND d.[Amount (LCY)]<0 ${s.clause}
        GROUP BY cle.[Salesperson Code], ${FMI('d.[Posting Date]')};`);
    } else if (metric === 'inventory') {
      // Ex-Stock is a STOCK: each month shows the value HELD at that month-end, so bucket the
      // lines by the fiscal month they entered (Fmi 0 = opening, i.e. dated before this FY)
      // and cumulate in JS below. Same basis as the Inventory page — see exStockSQL().
      const s = navScope(user, company, 'h.[Salesperson Code]');
      const r = navPool.request().input('asof', sql.Date, new Date(to)).input('fystart', sql.Date, new Date(from));
      bindCodes(r, s.codes);
      const bucket = `CASE WHEN CAST(h.[Posting Date] AS DATE) < @fystart THEN 0 ELSE ${FMI('h.[Posting Date]')} END`;
      actualRs = await r.query(exStockSQL(P, {
        select: `h.[Salesperson Code] AS Code, ${bucket} AS Fmi, SUM(${EX_STOCK_VALUE}) AS Actual`,
        groupBy: `h.[Salesperson Code], ${bucket}`,
        scope: s.clause,
      }));
    } else if (metric === 'visit') {
      // Visit DONE per fiscal month (App DB). Stored under COMPANYA codes → scope by the user's COMPANYA code,
      // and for CompanyB translate COMPANYA code → CompanyB code so a rep's visits show in both companies.
      const vAll = canSeeAll(user);
      const vCompanyACodes = vAll ? [] : (user.companyaCode || '').split('/').map(s => s.trim()).filter(Boolean);
      const vr = appPool.request().input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to));
      let vWhere = "Company='COMPANYA' AND BeatId IS NULL AND VisitDone=1 AND VisitDate >= @from AND VisitDate <= @to";
      if (!vAll) { if (!vCompanyACodes.length) vWhere += ' AND 1=0';
        else { vWhere += ` AND SalespersonCode IN (${vCompanyACodes.map((_, i) => `@vc${i}`).join(',')})`; vCompanyACodes.forEach((c, i) => vr.input(`vc${i}`, sql.NVarChar(50), c)); } }
      actualRs = await vr.query(`SELECT SalespersonCode AS Code, ((MONTH(VisitDate)+8)%12)+1 AS Fmi, COUNT(*) AS Actual
        FROM dbo.BN_VisitPlan WHERE ${vWhere} GROUP BY SalespersonCode, ((MONTH(VisitDate)+8)%12)+1;`);
      if (company.code !== 'COMPANYA') {
        const tr = await appPool.request().query(`SELECT CompanyACode, CompanyBCode FROM dbo.User_Login WHERE IsActive=1;`);
        const map = {}; tr.recordset.forEach(u => { const s = (u.CompanyACode || '').split('/')[0].trim(), a = (u.CompanyBCode || '').split('/')[0].trim(); if (s && a) map[s] = a; });
        actualRs.recordset = actualRs.recordset.map(r => ({ ...r, Code: map[(r.Code || '').trim()] || null })).filter(r => r.Code);
      }
    } else {   // billing
      const s = navScope(user, company, 'SIH.[Salesperson Code]'); const r = newReq(); bindCodes(r, s.codes);
      actualRs = await r.query(`
        SELECT SIH.[Salesperson Code] AS Code, ${FMI('SIH.[Posting Date]')} AS Fmi,
               SUM(ISNULL(SIL.[Unit Price],0) * ISNULL(SIL.[Quantity],0)) AS Actual
        FROM ${P}Sales Invoice Header] SIH JOIN ${P}Sales Invoice Line] SIL ON SIL.[Document No_]=SIH.[No_]
        WHERE CAST(SIH.[Posting Date] AS DATE) BETWEEN @from AND @to AND ISNULL(SIL.[Type],0)=2
          AND NOT EXISTS (SELECT 1 FROM ${P}Sales Cr_Memo Header] CM WHERE CM.[Applies-to Doc_ No_]=SIH.[No_]) ${s.clause}
        GROUP BY SIH.[Salesperson Code], ${FMI('SIH.[Posting Date]')};`);
    }

    const spNames = await navPool.request().query(`SELECT [Code],[Name] FROM ${P}Salesperson_Purchaser];`);
    const nameOf = {}; spNames.recordset.forEach(r => { nameOf[(r.Code || '').trim()] = (r.Name || '').trim(); });

    const budCol = metric === 'booking' ? 'BookingAnnual' : metric === 'ar' ? 'ARAnnual'
      : metric === 'inventory' ? 'InventoryAnnual' : metric === 'visit' ? 'VisitTargetAnnual' : 'BillingAnnual';
    const budScopeAll = canSeeAll(user);
    const budCodes = budScopeAll ? [] : navScope(user, company, 'x').codes;
    const budReq = appPool.request().input('c', sql.NVarChar(10), company.code).input('fy', sql.Int, fy);
    let budWhere = 'Company=@c AND FiscalYear=@fy';
    if (!budScopeAll) {
      if (!budCodes.length) budWhere += ' AND 1=0';
      else { budWhere += ` AND SalespersonCode IN (${budCodes.map((_, i) => `@bc${i}`).join(',')})`;
             budCodes.forEach((c, i) => budReq.input(`bc${i}`, sql.NVarChar(20), c)); }
    }
    const budgets = await budReq.query(`SELECT SalespersonCode, SalespersonName, ${budCol} AS Annual FROM dbo.BN_SalesBudget WHERE ${budWhere};`);

    const rows = {};
    const touch = (rawCode) => { const code = canon(rawCode); return (rows[code] = rows[code] || { code, name: nameOf[code] || code, monthlyBudget: 0, months: Array(12).fill(0), totalActual: 0 }); };
    budgets.recordset.forEach(b => { const c = (b.SalespersonCode || '').trim(); if (!c) return; const row = touch(c); if (b.SalespersonName) row.name = b.SalespersonName; row.monthlyBudget = Number(b.Annual || 0) / 12; });
    if (metric === 'inventory') {
      // Stock, not flow: months[] holds the RUNNING Ex-Stock value at each month-end (Fmi 0 =
      // opening balance carried in from before this FY), and the total is the closing value —
      // not the sum of the months, which would count the same stock twelve times.
      const opening = {};
      actualRs.recordset.forEach(a => {
        const c = canon((a.Code || '').trim()); if (!c) return;   // fold dup code so opening[] keys match row.code
        const idx = Number(a.Fmi) - 1, row = touch(c), amt = Number(a.Actual || 0);
        if (idx < 0) opening[c] = (opening[c] || 0) + amt; else if (idx < 12) row.months[idx] += amt;
      });
      Object.values(rows).forEach(row => {
        let run = opening[row.code] || 0;
        row.months = row.months.map(m => (run += m));
        row.totalActual = run;
      });
    } else {
      actualRs.recordset.forEach(a => { const c = (a.Code || '').trim(); if (!c) return; const idx = Number(a.Fmi) - 1; if (idx >= 0 && idx < 12) { const row = touch(c); row.months[idx] += Number(a.Actual || 0); row.totalActual += Number(a.Actual || 0); } });
    }

    const list = Object.values(rows).map(r => ({
      ...r, annualBudget: r.monthlyBudget * 12,
      pct: r.monthlyBudget > 0 ? Math.round((r.totalActual / (r.monthlyBudget * 12)) * 10000) / 100 : null,
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.json({ company: company.code, currency: company.currency, symbol: company.symbol, fiscalYear: fy, metric, months: MONTHS, rows: list });
  } catch (err) {
    console.error('[GET /api/sales/budget/monthly] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Failed to load monthly trend', detail: err.message });
  }
});

// ─── GET /salespeople — for the assign-budget dropdown (admin/MIS/heads) ──────
router.get('/salespeople', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const user = req.user;
    if (!(canSeeAll(user) || isAnyHead(user))) return res.json({ salespeople: [] });
    const codeCol = company.code === 'COMPANYA' ? 'CompanyACode' : 'CompanyBCode';
    const myCodeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';
    const pool = await getAppPool();
    const ul = await pool.request().query(`SELECT Name, Role, ${codeCol} AS Code FROM dbo.User_Login WHERE IsActive = 1;`);
    const myCodes = (user[myCodeCol] || '').split('/').map(c => c.trim()).filter(Boolean);
    const isTeamHead = isAnyHead(user) && !canSeeAll(user);
    const out = [];
    for (const u of ul.recordset) {
      const r = (u.Role || '').toLowerCase().trim();
      const codes = (u.Code || '').split('/').map(c => c.trim()).filter(Boolean);
      if (SALES_ROLES.includes(r) && codes.length) {
        if (isTeamHead && !codes.some(c => myCodes.includes(c))) continue;
        out.push({ code: codes[0], name: u.Name || codes[0] });
      }
    }
    out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ salespeople: out });
  } catch (err) {
    console.error('[GET /api/sales/budget/salespeople] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Failed to load salespeople', detail: err.message });
  }
});

// ─── GET /targets?fiscalYear= — current annual targets for the entry grid ─────
router.get('/targets', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    if (!canEdit(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const fy = parseInt(req.query.fiscalYear, 10) || currentFiscal().fy;
    const pool = await getAppPool();
    const rs = await pool.request()
      .input('c', sql.NVarChar(10), company.code).input('fy', sql.Int, fy)
      .query(`SELECT SalespersonCode, SalespersonName, BookingAnnual, BillingAnnual, ARAnnual, InventoryAnnual, VisitTargetAnnual
              FROM dbo.BN_SalesBudget WHERE Company = @c AND FiscalYear = @fy;`);
    res.json({ fiscalYear: fy, targets: rs.recordset });
  } catch (err) {
    console.error('[GET /api/sales/budget/targets] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Failed to load targets', detail: err.message });
  }
});

// Shared upsert of one annual budget row.
async function upsertBudget(pool, company, fy, code, name, booking, billing, arv, inv, visit, by) {
  await pool.request()
    .input('c', sql.NVarChar(10), company).input('fy', sql.Int, fy)
    .input('code', sql.NVarChar(20), code).input('name', sql.NVarChar(100), name)
    .input('booking', sql.Decimal(18, 2), booking).input('billing', sql.Decimal(18, 2), billing)
    .input('ar', sql.Decimal(18, 2), arv).input('inv', sql.Decimal(18, 2), inv).input('visit', sql.Decimal(18, 2), visit).input('by', sql.Int, by)
    .query(`
      MERGE dbo.BN_SalesBudget AS t
      USING (SELECT @c AS Company, @fy AS FiscalYear, @code AS SalespersonCode) AS s
        ON (t.Company = s.Company AND t.FiscalYear = s.FiscalYear AND t.SalespersonCode = s.SalespersonCode)
      WHEN MATCHED THEN
        UPDATE SET BookingAnnual = @booking, BillingAnnual = @billing, ARAnnual = @ar,
                   InventoryAnnual = @inv, VisitTargetAnnual = @visit,
                   SalespersonName = ISNULL(@name, t.SalespersonName), UpdatedBy = @by, UpdatedAt = SYSDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (Company, FiscalYear, SalespersonCode, SalespersonName, BookingAnnual, BillingAnnual, ARAnnual, InventoryAnnual, VisitTargetAnnual, CreatedBy, UpdatedBy)
        VALUES (@c, @fy, @code, @name, @booking, @billing, @ar, @inv, @visit, @by, @by);`);
}

// ─── POST / — upsert an annual budget (MIS / full-access only) ────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    if (!canEdit(req.user)) return res.status(403).json({ message: 'You are not allowed to set budgets.' });
    const fy = parseInt(req.body.fiscalYear, 10);
    const code = (req.body.salespersonCode || '').trim();
    const name = (req.body.salespersonName || '').trim() || null;
    if (!fy || !code) return res.status(400).json({ message: 'fiscalYear and salespersonCode are required' });
    await upsertBudget(await getAppPool(), company.code, fy, code, name,
      Number(req.body.bookingAnnual) || 0, Number(req.body.billingAnnual) || 0, Number(req.body.arAnnual) || 0,
      Number(req.body.inventoryAnnual) || 0, Number(req.body.visitTargetAnnual) || 0,
      req.user.id || null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/sales/budget] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Failed to save budget', detail: err.message });
  }
});

// ─── POST /import — bulk-load annual budgets from Excel (MIS / full-access) ────
// Sheet columns (case/suffix-insensitive): Salesperson (name or NAV code) · Booking · Billing · Visit.
// Booking/Billing entered in ₹ Lakh (COMPANYA) / $ '000 (CompanyB) → ×factor; Visit = raw count.
// AR & Inventory are auto-computed (outstanding / open Ex-Stock) — ignored if present.
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  try {
    const company = getCompany(req);
    if (!canEdit(req.user)) return res.status(403).json({ message: 'You are not allowed to import budgets.' });
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const fy = parseInt(req.body.fiscalYear || req.query.fiscalYear, 10) || currentFiscal().fy;
    const factor = unitFactor(company);

    const appPool = await getAppPool();
    const codeCol = company.code === 'COMPANYA' ? 'CompanyACode' : 'CompanyBCode';
    const ul = await appPool.request().query(`SELECT Name, Role, ${codeCol} AS Code FROM dbo.User_Login WHERE IsActive = 1;`);
    const byName = {}, byCode = {};
    ul.recordset.forEach(u => {
      const r = (u.Role || '').toLowerCase().trim();
      const codes = (u.Code || '').split('/').map(c => c.trim()).filter(Boolean);
      if (SALES_ROLES.includes(r) && codes.length) {
        byName[(u.Name || '').toLowerCase().trim()] = { code: codes[0], name: u.Name };
        codes.forEach(c => { byCode[c.toLowerCase()] = { code: codes[0], name: u.Name }; });
      }
    });

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    const keys = Object.keys(rows[0] || {});
    const norm = (k) => String(k).trim().toLowerCase();
    // Match a header by exact name OR by prefix, so unit-suffixed headers like
    // "Booking (₹ Lakh)" / "Billing ($ '000)" / "Visit (count)" still map correctly.
    const col = (exact, prefixes) => keys.find(k => { const n = norm(k); return exact.includes(n) || (prefixes || []).some(p => n.startsWith(p)); });
    const kSp = col(['salesperson', 'sales person', 'name', 'fsr', 'salesperson name'], ['salesperson', 'sales person']);
    const kBk = col(['booking', 'annual booking', 'booking annual'], ['booking']);
    const kBl = col(['billing', 'annual billing', 'billing annual'], ['billing']);
    const kAr = col(['ar', 'annual ar', 'ar annual', 'collection', 'collections'], ['collection']);
    const kInv = col(['inventory', 'annual inventory', 'ex-stock', 'ex stock', 'stock'], ['inventory', 'ex-stock', 'ex stock']);
    const kVisit = col(['visit', 'visit target', 'annual visit', 'visits'], ['visit']);
    if (!kSp || (!kBk && !kBl && !kVisit))   // AR & Inventory are auto-computed, not uploaded
      return res.status(400).json({ message: 'Sheet needs a "Salesperson" column and at least one of Booking / Billing / Visit.' });

    const num = (v) => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;
    const blank = (v) => String(v == null ? '' : v).trim() === '';
    let saved = 0, skipped = 0; const unmatched = [];
    for (const row of rows) {
      const spRaw = String(row[kSp] || '').trim();
      if (!spRaw) continue;
      // Skip rows with NO Booking/Billing/Visit filled in — don't zero out an existing budget.
      if (blank(kBk && row[kBk]) && blank(kBl && row[kBl]) && blank(kVisit && row[kVisit])) { skipped++; continue; }
      const hit = byCode[spRaw.toLowerCase()] || byName[spRaw.toLowerCase()];
      if (!hit) { unmatched.push(spRaw); continue; }
      await upsertBudget(appPool, company.code, fy, hit.code, hit.name,
        num(kBk && row[kBk]) * factor, num(kBl && row[kBl]) * factor, 0 /* AR computed */,
        0 /* Inventory computed */, num(kVisit && row[kVisit]),   // Booking/Billing ×unit; Visit = raw count
        req.user.id || null);
      saved++;
    }
    res.json({ ok: true, saved, skipped, unmatched, fiscalYear: fy });
  } catch (err) {
    console.error('[POST /api/sales/budget/import] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Budget import failed', detail: err.message });
  }
});

// ─── POST /booking-import — manual Booking ACTUAL upload (MIS / full-access) ──
// The "<Co> Booking Billing Consolidated" sheet: one row per order line —
//   Sr.No · Week · Date · Company Name · Part NO · Make · QTY · Rate · Amount · ISR NAME · CRM UPDATE · PO Number · Vertical
// We sum Amount per resolved salesperson (ISR NAME → code). REPLACE-BY-MONTH: every
// month present in the file is wiped for this company then re-inserted, so re-uploading
// a growing "consolidated <month>" file never double-counts. Booking ACTUAL on the page
// then reads this table (BN_SalesBookingActual); the annual Booking BUDGET is untouched.
router.post('/booking-import', authenticate, upload.single('file'), async (req, res) => {
  try {
    const company = getCompany(req);
    if (!canEdit(req.user)) return res.status(403).json({ message: 'You are not allowed to upload booking.' });
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const appPool = await getAppPool();

    // Parse RAW (no cellDates) so date cells arrive as Excel serials → excelDateToYMD() (avoids −1-day bug).
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    // The monthly file carries BOTH companies as separate sheets ("COMPANYA Booking" / "CompanyB Booking");
    // pick the one matching the active company. Fall back to a single "Booking" sheet (old format).
    const wantSheet = company.code === 'COMPANYA' ? 'companya booking' : 'companyb booking';
    const sheet = wb.SheetNames.find(n => normName(n) === wantSheet)
               || wb.SheetNames.find(n => normName(n).includes(company.code === 'COMPANYA' ? 'companya' : 'companyb'))
               || wb.SheetNames.find(n => normName(n) === 'booking')
               || wb.SheetNames[0];
    const aoa = xlsx.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: '' });
    if (!aoa.length) return res.status(400).json({ message: 'The sheet is empty.' });
    const hdr = aoa[0].map(h => normName(h));
    const ci = (...names) => { for (const nm of names) { const i = hdr.indexOf(normName(nm)); if (i >= 0) return i; } return -1; };
    const iDate = ci('date'), iWeek = ci('week'), iCust = ci('company name', 'customer', 'customer name'),
          iPart = ci('part no', 'part', 'part number', 'partno'), iMake = ci('make'),
          iQty = ci('qty', 'quantity'), iRate = ci('rate'), iAmt = ci('amount'),
          iIsr = ci('isr name', 'isr', 'salesperson', 'salesperson name'),
          iPo = ci('po number', 'po no', 'po'), iVert = ci('vertical');
    if (iIsr < 0 || iAmt < 0 || iDate < 0)
      return res.status(400).json({ message: 'Sheet must have Date, Amount and ISR NAME columns.' });

    const holders = await loadBookingHolders(appPool, company.code);
    const mergeMap = await loadMergeMap(appPool, company.code);       // fold a duplicate code onto the kept code
    const canon = (c) => (c ? (mergeMap[c] || c) : c);
    const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
    const str = (v, len) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, len) : null; };

    const parsed = [], monthsSet = new Set(), unmatched = {};
    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r]; if (!row || !row.length) continue;
      const isr = String(row[iIsr] || '').trim();
      const qty = iQty >= 0 ? num(row[iQty]) : 0, rate = iRate >= 0 ? num(row[iRate]) : 0;
      const amount = num(row[iAmt]) !== 0 ? num(row[iAmt]) : qty * rate;
      const dateStr = excelDateToYMD(row[iDate]);
      if (!isr && amount === 0) continue;                 // blank line
      if (!dateStr || amount === 0) continue;             // need a date + a value to count it
      const code = canon(resolveBookingCode(isr, holders));
      if (!code) unmatched[isr] = (unmatched[isr] || 0) + amount;
      monthsSet.add(dateStr.slice(0, 7));                 // 'YYYY-MM'
      parsed.push({ date: dateStr, week: str(row[iWeek], 20), cust: str(iCust >= 0 ? row[iCust] : '', 200),
        part: str(iPart >= 0 ? row[iPart] : '', 150), make: str(iMake >= 0 ? row[iMake] : '', 100),
        qty: qty || null, rate: rate || null, amount, isr: str(isr, 150), code,
        po: str(iPo >= 0 ? row[iPo] : '', 120), vert: str(iVert >= 0 ? row[iVert] : '', 60) });
    }
    if (!parsed.length) return res.status(400).json({ message: 'No valid booking rows found (need Date + Amount + ISR NAME).' });

    const months = [...monthsSet].sort();
    const tx = new sql.Transaction(appPool);
    await tx.begin();
    try {
      let deleted = 0;
      for (const m of months) {
        const [yy, mm] = m.split('-').map(Number);
        const dr = await new sql.Request(tx)
          .input('c', sql.NVarChar(10), company.code).input('y', sql.Int, yy).input('mo', sql.Int, mm)
          .query(`DELETE FROM dbo.BN_SalesBookingActual WHERE Company=@c AND YEAR(BookingDate)=@y AND MONTH(BookingDate)=@mo;`);
        deleted += (dr.rowsAffected && dr.rowsAffected[0]) || 0;
      }
      const srcFile = str(req.file.originalname, 260);
      const by = str(req.user.username || req.user.name || req.user.id, 150);
      for (const p of parsed) {
        await new sql.Request(tx)
          .input('c', sql.NVarChar(10), company.code).input('d', sql.Date, new Date(p.date + 'T00:00:00Z'))
          .input('wk', sql.NVarChar(20), p.week).input('cust', sql.NVarChar(200), p.cust)
          .input('part', sql.NVarChar(150), p.part).input('make', sql.NVarChar(100), p.make)
          .input('qty', sql.Decimal(18, 4), p.qty).input('rate', sql.Decimal(18, 6), p.rate)
          .input('amt', sql.Decimal(18, 4), p.amount).input('isr', sql.NVarChar(150), p.isr)
          .input('code', sql.NVarChar(20), p.code).input('po', sql.NVarChar(120), p.po)
          .input('vert', sql.NVarChar(60), p.vert).input('src', sql.NVarChar(260), srcFile).input('by', sql.NVarChar(150), by)
          .query(`INSERT INTO dbo.BN_SalesBookingActual
            (Company,BookingDate,WeekLabel,CustomerName,PartNo,Make,Qty,Rate,Amount,IsrName,SalespersonCode,PoNumber,Vertical,SourceFile,UploadedBy)
            VALUES (@c,@d,@wk,@cust,@part,@make,@qty,@rate,@amt,@isr,@code,@po,@vert,@src,@by);`);
      }
      await tx.commit();
      const unmatchedList = Object.entries(unmatched).map(([name, amt]) => ({ name, amount: Math.round(amt) }))
        .sort((a, b) => b.amount - a.amount);
      const matchedAmount = Math.round(parsed.filter(p => p.code).reduce((s, p) => s + p.amount, 0));
      const unmatchedAmount = Math.round(parsed.filter(p => !p.code).reduce((s, p) => s + p.amount, 0));
      res.json({ ok: true, company: company.code, months, inserted: parsed.length, replaced: deleted,
        matchedAmount, unmatchedAmount, unmatched: unmatchedList });
    } catch (e) { await tx.rollback(); throw e; }
  } catch (err) {
    console.error('[POST /api/sales/budget/booking-import] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Booking upload failed', detail: err.message });
  }
});

// ─── GET /export — the current scoped comparison as an Excel file ─────────────
router.get('/export', authenticate, async (req, res) => {
  try {
    const data = await buildComparison(req);
    const hdr = ['Salesperson',
      'Booking Budget', 'Booking Actual', 'Booking %',
      'Billing Budget', 'Billing Actual', 'Billing %',
      'AR Collectible', 'AR Collected', 'AR Coll %', 'AR Overdue %',
      'Inventory Budget', 'Inventory Actual', 'Inventory %',
      'Visit Target', 'Visit Planned', 'Visit Done', 'Visit %',
      'Overall %'];
    const body = data.rows.map(r => [r.name,
      r.bookingBudget, r.bookingActual, r.bookingPct,
      r.billingBudget, r.billingActual, r.billingPct,
      r.arBudget, r.arActual, r.arPct, r.arOverduePct,
      r.inventoryBudget, r.inventoryActual, r.inventoryPct,
      r.visitTarget, r.visitPlanned, r.visitDone, r.visitPct,
      r.overall]);
    const t = data.totals;
    body.push(['TOTAL', t.bookingBudget, t.bookingActual, t.bookingPct,
      t.billingBudget, t.billingActual, t.billingPct, t.arBudget, t.arActual, t.arPct, t.arOverduePct,
      t.inventoryBudget, t.inventoryActual, t.inventoryPct,
      t.visitTarget, t.visitPlanned, t.visitDone, t.visitPct, t.overall]);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([hdr, ...body]), 'Budget vs Actual');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = `${data.company}_BudgetVsActual_${String(data.range.label || '').replace(/[^\w-]+/g, '_')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.end(buf);
  } catch (err) {
    console.error('[GET /api/sales/budget/export] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Export failed', detail: err.message });
  }
});

// ─── GET /detail?metric=&code=&fiscalYear=&period=&month= — drill-down to docs ─
router.get('/detail', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const P = company.prefix;
    const user = req.user;
    const metric = (req.query.metric || 'billing').toLowerCase();
    const code = (req.query.code || '').trim();
    if (!code) return res.status(400).json({ message: 'salesperson code required' });
    // Authorize: a scoped user may only drill into their own code(s).
    if (!canSeeAll(user)) {
      const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';
      const mine = (user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);
      if (!mine.includes(code)) return res.status(403).json({ message: 'Not allowed for this salesperson' });
    }
    const fy = parseInt(req.query.fiscalYear, 10) || currentFiscal().fy;
    const { from, to } = fiscalRange(fy, req.query.period || 'month', req.query.month, (req.query.weekDate || '').trim());
    // Expand the drilled (canonical) code to include any duplicate NAV codes that fold into it,
    // so the document list matches the folded summary cell. codeIn = '(@code0,@code1,...)'.
    const mergeMap = await loadMergeMap(await getAppPool(), company.code);
    const drillCodes = [code, ...Object.keys(mergeMap).filter(f => mergeMap[f] === code)];
    const codeIn = '(' + drillCodes.map((_, i) => `@code${i}`).join(',') + ')';
    const r = (await getPool()).request()
      .input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to)).input('code', sql.NVarChar(20), code);
    drillCodes.forEach((c, i) => r.input(`code${i}`, sql.NVarChar(20), c));

    let rs, columns;
    if (metric === 'booking') {
      // Booking drill-down = the uploaded order lines (App DB BN_SalesBookingActual).
      const dr = (await getAppPool()).request()
        .input('c', sql.NVarChar(10), company.code)
        .input('from', sql.Date, new Date(from)).input('to', sql.Date, new Date(to));
      drillCodes.forEach((c, i) => dr.input(`code${i}`, sql.NVarChar(20), c));
      rs = await dr.query(`
        SELECT ISNULL(NULLIF(LTRIM(RTRIM(PoNumber)),''), ISNULL(PartNo,'')) AS DocNo,
               CONVERT(VARCHAR(10), BookingDate, 23) AS DocDate,
               ISNULL(CustomerName,'') AS Customer, Amount
        FROM dbo.BN_SalesBookingActual
        WHERE Company=@c AND SalespersonCode IN ${codeIn} AND BookingDate BETWEEN @from AND @to
        ORDER BY BookingDate DESC, Amount DESC;`);
      columns = ['PO / Part', 'Date', 'Customer', 'Amount'];
    } else if (metric === 'ar') {
      // Invoice-level: reductions (payments/credits) posted against THIS rep's own invoices in the period.
      rs = await r.query(`
        SELECT cle.[Document No_] AS DocNo, CONVERT(VARCHAR(10), d.[Posting Date], 23) AS DocDate,
               MAX(cu.[Name]) AS Customer, -SUM(d.[Amount (LCY)]) AS Amount
        FROM ${P}Detailed Cust_ Ledg_ Entry] d
        JOIN ${P}Cust_ Ledger Entry] cle ON cle.[Entry No_] = d.[Cust_ Ledger Entry No_]
        JOIN ${P}Customer] cu ON cu.[No_] = cle.[Customer No_]
        WHERE cle.[Document Type] = 2 AND cle.[Salesperson Code] IN ${codeIn}
          AND CAST(d.[Posting Date] AS DATE) BETWEEN @from AND @to AND d.[Amount (LCY)] < 0
        GROUP BY cle.[Document No_], d.[Posting Date]
        ORDER BY d.[Posting Date] DESC;`);
      columns = ['Invoice No', 'Date', 'Customer', 'Collected'];
    } else if (metric === 'ar-collectible') {
      // Collectible drill = the rep's OWN still-owed OPEN documents as of period-end (the concrete
      // "left to collect" worklist). ALL doc types the rep's code carries (invoices positive, any
      // credit memos negative), net open balance per document — so the list sums to the SAME net
      // Closing AR the summary uses (Collectible = Collected + this). The modal note pairs it with
      // the Collected figure so the salesperson sees the exact arithmetic.
      r.input('asof', sql.Date, new Date(to));
      rs = await r.query(`
        SELECT cle.[Document No_] AS DocNo, CONVERT(VARCHAR(10), MAX(cle.[Posting Date]), 23) AS DocDate,
               MAX(cu.[Name]) AS Customer, SUM(d.[Amount (LCY)]) AS Amount
        FROM ${P}Detailed Cust_ Ledg_ Entry] d
        JOIN ${P}Cust_ Ledger Entry] cle ON cle.[Entry No_] = d.[Cust_ Ledger Entry No_]
        JOIN ${P}Customer] cu ON cu.[No_] = cle.[Customer No_]
        WHERE cle.[Salesperson Code] IN ${codeIn}
          AND CAST(d.[Posting Date] AS DATE) <= @asof
        GROUP BY cle.[Document No_]
        HAVING SUM(d.[Amount (LCY)]) <> 0
        ORDER BY SUM(d.[Amount (LCY)]) DESC;`);
      columns = ['Document No', 'Date', 'Customer', 'Still Owed'];
    } else if (metric === 'ar-overdue') {
      // Overdue drill = the still-owed open invoices whose Due Date has already passed (the subset
      // of the collectible list that is past due). Shows the Due Date so ageing is obvious.
      r.input('asof', sql.Date, new Date(to));
      rs = await r.query(`
        SELECT cle.[Document No_] AS DocNo, CONVERT(VARCHAR(10), MAX(cle.[Due Date]), 23) AS DocDate,
               MAX(cu.[Name]) AS Customer, SUM(d.[Amount (LCY)]) AS Amount
        FROM ${P}Detailed Cust_ Ledg_ Entry] d
        JOIN ${P}Cust_ Ledger Entry] cle ON cle.[Entry No_] = d.[Cust_ Ledger Entry No_]
        JOIN ${P}Customer] cu ON cu.[No_] = cle.[Customer No_]
        WHERE cle.[Document Type] = 2 AND cle.[Salesperson Code] IN ${codeIn}
          AND CAST(d.[Posting Date] AS DATE) <= @asof
          AND CAST(cle.[Due Date] AS DATE) < @asof
        GROUP BY cle.[Document No_]
        HAVING SUM(d.[Amount (LCY)]) <> 0
        ORDER BY MAX(cle.[Due Date]) ASC;`);
      columns = ['Invoice No', 'Due Date', 'Customer', 'Overdue'];
    } else if (metric === 'inventory') {
      // Ex-Stock held as of period end (cumulative) — matches the summary cell and the
      // Inventory page, so this lists ALL open Ex-Stock SOs, not only this period's orders.
      r.input('asof', sql.Date, new Date(to));
      rs = await r.query(exStockSQL(P, {
        select: `h.[No_] AS DocNo, CONVERT(VARCHAR(10), MAX(h.[Posting Date]), 23) AS DocDate,
                 MAX(h.[Sell-to Customer Name]) AS Customer, SUM(${EX_STOCK_VALUE}) AS Amount`,
        groupBy: 'h.[No_]',
        orderBy: 'MAX(h.[Posting Date]) DESC',
        scope: ` AND h.[Salesperson Code] IN ${codeIn} `,
      }));
      columns = ['SO No', 'Date', 'Customer', 'Ex-Stock Value'];
    } else if (metric === 'visit') {
      // Visits are stored under COMPANYA codes — for CompanyB, map this row's CompanyB code → COMPANYA code.
      const appP = await getAppPool();
      let companyaCode = code;
      if (company.code !== 'COMPANYA') {
        // Map CompanyB code → COMPANYA code. Prefer the INDIVIDUAL (CompanyBCode is exactly this one code)
        // over a sales head whose CompanyBCode is a union of the whole team (avoids the head hijacking
        // a member's drill-down when they share a first code).
        const tr = await appP.request().query(`SELECT CompanyACode, CompanyBCode FROM dbo.User_Login WHERE IsActive=1;`);
        const cand = tr.recordset.filter(u => (u.CompanyBCode || '').split('/')[0].trim() === code);
        const hit = cand.find(u => (u.CompanyBCode || '').trim() === code) || cand[0];
        if (hit) companyaCode = (hit.CompanyACode || '').split('/')[0].trim() || code;
      }
      const vr = appP.request()
        .input('vfrom', sql.Date, new Date(from)).input('vto', sql.Date, new Date(to)).input('vcode', sql.NVarChar(50), companyaCode);
      const vrs = await vr.query(`
        SELECT CONVERT(VARCHAR(10), VisitDate, 23) AS VisitDate, ISNULL(CustomerName,'') AS Customer,
               CASE WHEN VisitDone = 1 THEN 'Done' ELSE 'Pending' END AS Status
        FROM dbo.BN_VisitPlan
        WHERE Company='COMPANYA' AND BeatId IS NULL AND SalespersonCode=@vcode AND VisitDate >= @vfrom AND VisitDate <= @vto
        ORDER BY VisitDate DESC;`);
      return res.json({ metric, code, columns: ['Visit Date', 'Customer', 'Status'],
        rows: vrs.recordset.map(x => [x.VisitDate, x.Customer, x.Status]), isCurrency: false });
    } else {
      rs = await r.query(`
        SELECT SIH.[No_] AS DocNo, CONVERT(VARCHAR(10), SIH.[Posting Date], 23) AS DocDate,
               SIH.[Sell-to Customer Name] AS Customer,
               SUM(ISNULL(SIL.[Unit Price],0)*ISNULL(SIL.[Quantity],0)) AS Amount
        FROM ${P}Sales Invoice Header] SIH JOIN ${P}Sales Invoice Line] SIL ON SIL.[Document No_]=SIH.[No_]
        WHERE SIH.[Salesperson Code] IN ${codeIn} AND CAST(SIH.[Posting Date] AS DATE) BETWEEN @from AND @to AND ISNULL(SIL.[Type],0)=2
          AND NOT EXISTS (SELECT 1 FROM ${P}Sales Cr_Memo Header] CM WHERE CM.[Applies-to Doc_ No_]=SIH.[No_])
        GROUP BY SIH.[No_], SIH.[Posting Date], SIH.[Sell-to Customer Name] ORDER BY SIH.[Posting Date] DESC;`);
      columns = ['Invoice No', 'Date', 'Customer', 'Amount'];
    }
    res.json({ metric, code, columns, isCurrency: true,
      rows: rs.recordset.map(x => [x.DocNo, x.DocDate, x.Customer, Number(x.Amount || 0)]),
      currency: company.currency, symbol: company.symbol });
  } catch (err) {
    console.error('[GET /api/sales/budget/detail] failed:', err.message);
    res.status(err.status || 500).json({ message: 'Failed to load detail', detail: err.message });
  }
});

module.exports = router;
