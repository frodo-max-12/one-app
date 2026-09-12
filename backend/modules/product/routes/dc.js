// =====================================================================
// modules/product/routes/dc.js — Product team DC (Design-Conversion) file
//
// Mounted at /api/product/dc/*. App-owned data in BN_DCFile (BizNAV_App);
// NAV stays strictly read-only. Replaces the Product team's Excel DC file.
//
// Endpoints:
//   GET    /            — list (filters: search, company, projectStatus, salesPerson, dates) + stats
//   GET    /:id         — single row
//   POST   /            — create one line
//   PATCH  /:id         — update
//   DELETE /:id         — soft delete (IsActive=0) — head/admin only
//   POST   /import      — bulk Excel import (UPSERT on Company+OP No+Customer Name; team
//                         remark cols fill-empty-only on update — see upsertRows)
//   GET    /export      — Excel download (respects current filter)
//
// Access: any Product role ('product head'/'product assistant') OR admin family.
// It's a shared team sheet — NOT salesperson-scoped. Delete = head/admin only.
// =====================================================================

const express = require('express');
const multer  = require('multer');
const xlsx    = require('xlsx');
const ExcelJS = require('exceljs');   // protected "edit remarks" template (locks non-remark cells)
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isFullAccess, isProduct, isProductHead,
        isSales, isFae, isFaeHead, isAnyHead } = require('../../../auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// In-memory progress store for background imports (single-process server). jobId ->
// { total, processed, inserted, updated, failed, done, error, … }. Polled by the page
// via GET /import/progress/:jobId; each job self-evicts ~2 min after it finishes.
const importJobs = new Map();

// ── access guards ────────────────────────────────────────────────────────────
// Who may VIEW the DC sheet: Product team + admin (all rows), PLUS Sales & FAE staff
// and their heads (row-scoped to their own / team's SalesPerson / FaePerson — see
// resolveDcScope). Sales/FAE can also EDIT the rows they can see (PATCH), but NOT
// add / import / delete (those stay Product-team only via canManage / canDelete).
function canViewDc(user) {
  return isProduct(user) || isFullAccess(user) || isSales(user) || isFae(user) || isAnyHead(user);
}
function canView(req, res, next) {
  if (canViewDc(req.user)) return next();
  return res.status(403).json({ message: 'You do not have access to the DC File' });
}
// Add-a-line + bulk Import — Product team + admin only (the sheet is Product-owned).
function canManage(req, res, next) {
  if (isProduct(req.user) || isFullAccess(req.user)) return next();
  return res.status(403).json({ message: 'Only the Product team can add or import DC rows' });
}
function canDelete(req, res, next) {
  if (isProductHead(req.user) || isFullAccess(req.user)) return next();
  return res.status(403).json({ message: 'Only the Product Head or an admin can delete DC rows' });
}

// ── row-level scoping (Sales / FAE / heads) ──────────────────────────────────
// Product + admin see ALL rows. A salesperson sees rows whose SalesPerson is them;
// an FAE sees rows whose FaePerson is them; a Sales/North-Sales head sees their whole
// team (members resolved from the head's CompanyACode/CompanyBCode list); the FAE head sees
// all current FAE members. Matching is by the OWNER KEY = the first name of the login,
// with a small alias map for the DC sheet's messy free-text values (it stores "a colleague"
// for Shekhar a colleague and misspells "Santhosh" as "Santosh"). Ex-staff names in the sheet
// (Naresh/Kshitij/Rakhi/…) have no login → they map to no one and stay hidden, as intended.
const DC_NAME_ALIAS = { gurjar: 'shekhar', santosh: 'santhosh' };
const nrm      = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const firstTok = (s) => nrm(s).split(' ')[0] || '';
function dcOwnerKeyJS(name) { const n = nrm(name); return DC_NAME_ALIAS[n] || firstTok(name); }
// SQL expression mirroring dcOwnerKeyJS — computes the owner key from a name column.
function ownerKeyExpr(col) {
  const c = `LTRIM(RTRIM(ISNULL(${col},'')))`;
  return `CASE
      WHEN LOWER(${c}) = 'gurjar'  THEN 'shekhar'
      WHEN LOWER(${c}) = 'santosh' THEN 'santhosh'
      ELSE LOWER(LEFT(${c} + ' ', CHARINDEX(' ', ${c} + ' ') - 1))
    END`;
}
// The row-scope WHERE predicate for a resolved scope. An FAE sees a row if THEY are its **Line FAE**
// (the brand owner — BN_DCFile.LineFae, auto-filled from the chart's "Line FAE" column) OR the
// **FAE Person who visited** it — so a line shows to both its owner and its visitor. Everyone else
// matches a single name column. `prefix` = 'p.' or ''; `phList` = the comma-joined @sk* placeholders.
function scopePredicate(scope, prefix, phList) {
  if (scope.faeLine) {
    return `((${ownerKeyExpr(`${prefix}LineFae`)}) IN (${phList}) OR (${ownerKeyExpr(`${prefix}FaePerson`)}) IN (${phList}))`;
  }
  return `(${ownerKeyExpr(`${prefix}${scope.col}`)}) IN (${phList})`;
}
function codesOf(u) {
  return ((u.companyaCode || u.CompanyACode || '') + '/' + (u.companybCode || u.CompanyBCode || ''))
    .split('/').map(s => s.trim()).filter(Boolean);
}
// A head's team = every active login sharing at least one salesperson code with the head.
async function teamOwnerKeys(user, pool) {
  const mine = new Set(codesOf(user));
  const keys = new Set([firstTok(user.name)]);            // include the head themselves
  const r = await pool.request().query('SELECT Name, CompanyACode, CompanyBCode FROM [dbo].[User_Login] WHERE IsActive = 1');
  for (const row of r.recordset) {
    if (codesOf(row).some(c => mine.has(c))) keys.add(firstTok(row.Name));
  }
  return [...keys].filter(Boolean);
}
// Column-level edit rights: Product/admin => null (every field). A salesperson / sales-head
// may edit ONLY the Sales Team Remark (DB CurrentStatus). An FAE / FAE-head only the FAE
// Team remark (DB ActionItem). (isFae covers 'fae' + 'fae head'; checked before sales.)
function editableFieldsFor(user) {
  if (isProduct(user) || isFullAccess(user)) return null;
  if (isFae(user)) return ['actionItem'];
  return ['currentStatus'];
}
// Typed (OVERWRITE, not append-log) fields Sales / FAE may set directly on a row they can
// see — IN ADDITION to their append-only remark. FAE own the sampling/PP-date workflow
// fields; Sales own the MP date. Product/admin already edit every field (return null).
// Keys are DC body field names; each maps to a hard-coded column in FIELD_BIND (PATCH).
function overwriteFieldsFor(user) {
  if (isProduct(user) || isFullAccess(user)) return null;
  if (isFae(user)) return ['projectStatus', 'samplesStage', 'ppDateFae'];
  return ['mpDateSales'];   // sales staff + sales/north/electrical heads
}
// The Sales/FAE round-trip ("Export for editing" → "Import remarks") lets a scoped user
// OVERWRITE these workflow fields IN ADDITION to appending their remark. Each entry maps the
// DC body field (per overwriteFieldsFor) to its export-remarks column HEADER — used both to
// UNLOCK the cell on export and to READ it back on import, so keep the two in sync — plus the
// DB column, its type, and (for text) its max length. Product/admin (overwriteFieldsFor => null)
// use the full "Import Excel" path instead, so they get no extra unlocked columns here.
const OW_ROUNDTRIP = {
  projectStatus: { header: 'Project Status', dbCol: 'ProjectStatus', type: 'text', len: 100 },
  samplesStage:  { header: 'Samples stage',  dbCol: 'SamplesStage',  type: 'text', len: 120 },
  ppDateFae:     { header: 'PP date FAE',     dbCol: 'PpDateFae',     type: 'date' },
  mpDateSales:   { header: 'MP date Sales',   dbCol: 'MpDateSales',   type: 'date' },
};
// Format a stored Date as dd-mm-yyyy (matches CONVERT(VARCHAR(10),date,105)) for change-compare.
function ddmmyyyy(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCFullYear())}`;
}
// Which remark a user owns, for the bulk "export → edit → import remarks" template.
// FAE → FAE Team remark (ActionItem); everyone else (sales/heads/product) → Sales Team
// Remark (CurrentStatus). Product/admin can use the Sales template too if they wish.
function remarkCtxFor(user) {
  if (isFae(user)) return { col: 'ActionItem',    curHdr: 'FAE Team remark',   addHdr: 'Add FAE Remark' };
  return              { col: 'CurrentStatus', curHdr: 'Sales Team Remark', addHdr: 'Add Sales Remark' };
}
async function resolveDcScope(user, pool) {
  if (isProduct(user) || isFullAccess(user)) return { all: true };
  if (isFae(user)) {
    let keys;
    if (isFaeHead(user)) {
      const r = await pool.request().query("SELECT Name FROM [dbo].[User_Login] WHERE IsActive = 1 AND LOWER(Role) IN ('fae','fae head')");
      keys = r.recordset.map(x => firstTok(x.Name));
    } else {
      keys = [firstTok(user.name)];
    }
    // FAE access is by CHART-ASSIGNED LINE (Suggested Make brand + Region), NOT the joint-visit
    // FaePerson column. North→the north FAE, West→brand's West FAE, South→nobody (BN_DCLine.FaeNorth/FaeWest).
    return { faeLine: true, keys: [...new Set(keys.filter(Boolean))] };
  }
  // sales roles + sales/north-sales/electrical heads → scope on SalesPerson
  const keys = isAnyHead(user) ? await teamOwnerKeys(user, pool) : [firstTok(user.name)];
  return { col: 'SalesPerson', keys: [...new Set(keys.filter(Boolean))] };
}

// ── value parsers ────────────────────────────────────────────────────────────
// Anchor a calendar day at 12:00 UTC so neither UTC nor local (±14h) date extraction
// (mssql sql.Date, CONVERT, etc.) can ever shift it to an adjacent day.
function middayUTC(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)); }
function parseExcelDate(v) {
  if (v == null || v === '') return null;
  // PREFERRED path — the import reads the workbook with cellDates:FALSE, so a real date
  // cell arrives as its raw Excel serial number (e.g. 46165 = 2026-05-23). We convert it
  // with xlsx.SSF.parse_date_code — a pure calendar lookup with ZERO timezone/Date math —
  // so the stored date is EXACTLY what Excel shows. This sidesteps the SheetJS cellDates
  // quirk (it lands a date cell ~10s before local midnight, which shifts ±1 day depending
  // on the machine timezone). Always store dates as serials, never as JS Date objects.
  if (typeof v === 'number') {
    const o = xlsx.SSF.parse_date_code(v);
    if (!o || !o.y) return null;
    return middayUTC(o.y, o.m, o.d);
  }
  // Fallback for a JS Date (only if some caller still passes cellDates:true) — snap to the
  // nearest whole UTC day (undo the ~10s-before-midnight drift), then re-anchor at midday UTC.
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    // If it's already our midday-UTC marker (12:00:00.000 UTC), its UTC parts ARE the intended
    // day — return them directly. NEVER snap a midday value: getTime()/86400000 lands on exactly
    // .5 of a day and Math.round() bumps it to the NEXT day. That is the "re-import adds +1 day"
    // bug — a row parsed to midday-UTC on import 1 (INSERT, correct), then re-bound through here
    // on import 2 (UPDATE), came out one day late every time.
    if (v.getUTCHours() === 12 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0) {
      return middayUTC(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
    }
    const s = new Date(Math.round(v.getTime() / 86400000) * 86400000);
    return middayUTC(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return middayUTC(y, +m[2], +m[1]); }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return middayUTC(+m[1], +m[2], +m[3]);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const sn = new Date(Math.round(d.getTime() / 86400000) * 86400000);
  return middayUTC(sn.getUTCFullYear(), sn.getUTCMonth() + 1, sn.getUTCDate());
}
// '<input type=date>' string → midday-UTC Date so the stored DATE never shifts a day.
function toLocalDate(s) {
  if (!s) return null;
  // A Date object here is one WE already anchored at midday-UTC (the import UPDATE path
  // re-binds a parsed dcDate). Read its UTC parts directly — do NOT stringify-and-reparse
  // or snap, both of which shift a midday value +1 day (the "re-import adds a day" bug).
  if (s instanceof Date) {
    if (isNaN(s.getTime())) return null;
    return middayUTC(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate());
  }
  const m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) { const d = parseExcelDate(s); return d; }
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
}
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[,$₹\s]/g, ''));
  return isNaN(n) ? null : n;
}
function txt(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}
const COMPANY = (c) => { const u = String(c || '').trim().toUpperCase(); return (u === 'COMPANYA' || u === 'COMPANYB') ? u : null; };

// Brand -> PM map (BN_DCLine, seeded from the PM chart). Used to auto-fill a DC
// row's PM from its Suggested Make (brand) when no PM was supplied on import/add.
const NBSP = String.fromCharCode(160);
function normBrand(s) { return String(s == null ? '' : s).split(NBSP).join(' ').replace(/\s+/g, '').toLowerCase(); }
async function loadLineMap(pool) {
  const m = new Map();
  try {
    const r = await pool.request().query("SELECT LineKey, PM FROM [dbo].[BN_DCLine] WHERE ISNULL(PM,'') <> ''");
    r.recordset.forEach(x => { if (x.LineKey) m.set(x.LineKey, x.PM); });
  } catch (_) { /* BN_DCLine not present yet -> empty map, no auto-fill */ }
  return m;
}

// ── GET / — list + stats ─────────────────────────────────────────────────────
router.get('/', authenticate, canView, async (req, res) => {
  try {
    const search        = (req.query.search        || '').trim();
    // Cross-company sheet — scope by company ONLY when the toolbar dropdown picks one
    // (sent as filterCompany). Deliberately IGNORE the ?company= that apiRequest() auto-
    // appends to every request, so the default view shows BOTH COMPANYA + CompanyB rows.
    const company       = COMPANY(req.query.filterCompany);
    const projectStatus = (req.query.projectStatus || '').trim();
    const bucket        = (req.query.bucket         || '').trim().toUpperCase();
    const salesPerson   = (req.query.salesPerson    || '').trim();   // exact (dropdown value)
    const faePerson     = (req.query.faePerson      || '').trim();   // exact (dropdown value)
    const region        = (req.query.region         || '').trim();   // exact (Region dropdown value)
    const fromDate      = (req.query.fromDate        || '').trim();
    const toDate        = (req.query.toDate          || '').trim();
    const page  = Math.max(1, parseInt(req.query.page  || '1',    10));
    const limit = Math.max(1, parseInt(req.query.limit || '5000', 10));
    const offset = (page - 1) * limit;

    const pool = await getAppPool();
    const r = pool.request();
    // Currency + funnel-bucket CASE expressions — defined ONCE and shared by the WHERE
    // (funnel-card click), the list, AND the stats, so a clicked count always equals the
    // rows returned. Buckets match ANYWHERE (LIKE '%NBO%') so every variant collapses:
    // NBO-Quoted/Promotion/Parameter Evaluation → NBO, DIN-* → DIN, PWIN-* → PWIN,
    // DWIN-* → DWIN, MWIN-* → MWIN, Lost/Lost-… → LOSS. (No token is a substring of
    // another — DWIN/MWIN/PWIN don't contain 'DIN' — so order is safe.)
    const CUR_CASE = `CASE
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.Currency,'')))) IN ('INR','RS','RS.','INR.') THEN 'INR'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.Currency,'')))) IN ('USD','US$','USD.')       THEN 'USD'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.Currency,'')))) IN ('EUR','EURO','EUR.')       THEN 'EUR'
        ELSE 'UNSPEC' END`;
    const BUCKET_CASE = `CASE
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.ProjectStatus,'')))) LIKE '%NBO%'  THEN 'NBO'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.ProjectStatus,'')))) LIKE '%PWIN%' THEN 'PWIN'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.ProjectStatus,'')))) LIKE '%DWIN%' THEN 'DWIN'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.ProjectStatus,'')))) LIKE '%MWIN%' THEN 'MWIN'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.ProjectStatus,'')))) LIKE '%DIN%'  THEN 'DIN'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(p.ProjectStatus,'')))) LIKE '%LOSS%'
          OR UPPER(LTRIM(RTRIM(ISNULL(p.ProjectStatus,'')))) LIKE '%LOST%' THEN 'LOSS'
        ELSE 'OTHER' END`;
    const where = ['p.IsActive = 1'];
    if (company)       { where.push('p.Company = @company');             r.input('company', sql.NVarChar(10), company); }
    // "Project status…" text filter is a CONTAINS match (typing "NBO" returns NBO-Quoted /
    // NBO-Promotion / NBO-Parameter Evaluation), mirroring the source-sheet column filter.
    if (projectStatus) { where.push('p.ProjectStatus LIKE @ps');         r.input('ps', sql.NVarChar(120), '%' + projectStatus + '%'); }
    if (bucket)        { where.push(`(${BUCKET_CASE}) = @bucket`);        r.input('bucket', sql.NVarChar(10), bucket); }
    // Salesperson / FAE dropdown filters — EXACT match on the picked name (a head/Product
    // filters their team person-wise; the distinct options come from the facet below).
    if (salesPerson)   { where.push("LTRIM(RTRIM(ISNULL(p.SalesPerson,''))) = @sp"); r.input('sp', sql.NVarChar(110), salesPerson); }
    if (faePerson)     { where.push("LTRIM(RTRIM(ISNULL(p.FaePerson,'')))   = @fp"); r.input('fp', sql.NVarChar(110), faePerson); }
    if (region)        { where.push("LTRIM(RTRIM(ISNULL(p.Region,'')))      = @region"); r.input('region', sql.NVarChar(60), region); }
    if (fromDate)      { where.push('p.DcDate >= @from');                r.input('from', sql.Date, toLocalDate(fromDate)); }
    if (toDate)        { where.push('p.DcDate <= @to');                  r.input('to', sql.Date, toLocalDate(toDate)); }
    if (search) {
      // Broad "search everything" box — now includes ProjectStatus (so typing "DIN"/"NBO"
      // finds those rows too), the Make columns, Sales Person, stage & the remark/status
      // free-text fields. For EXACT status filtering use a funnel card or the Project-status box.
      where.push(`(
        ISNULL(p.OpNo,'') LIKE @q OR ISNULL(p.CustomerName,'') LIKE @q
        OR ISNULL(p.ExistingMpn,'') LIKE @q OR ISNULL(p.SuggestedMpn,'') LIKE @q
        OR ISNULL(p.ExistingMake,'') LIKE @q OR ISNULL(p.SuggestedMake,'') LIKE @q
        OR ISNULL(p.Project,'') LIKE @q OR ISNULL(p.ProjectStatus,'') LIKE @q
        OR ISNULL(p.SamplesStage,'') LIKE @q OR ISNULL(p.ProductTeamRemarks,'') LIKE @q
        OR ISNULL(p.CurrentStatus,'') LIKE @q OR ISNULL(p.Remarks,'') LIKE @q
        OR ISNULL(p.Vertical,'') LIKE @q OR ISNULL(p.Segment,'') LIKE @q
        OR ISNULL(p.Region,'') LIKE @q OR ISNULL(p.CustomerCategory,'') LIKE @q
        OR ISNULL(p.SalesPerson,'') LIKE @q OR ISNULL(p.FaePerson,'') LIKE @q
        OR ISNULL(p.PM,'') LIKE @q
      )`);
      r.input('q', sql.NVarChar(300), '%' + search + '%');
    }

    // PM segregation — a Product ASSISTANT sees ONLY their own lines (PM = their first
    // name); the Product Head + admin see all. Optional ?pm= filter for head/admin.
    const isAssistant = isProduct(req.user) && !isProductHead(req.user) && !isFullAccess(req.user);
    const myPm = (req.user.name || '').trim().split(/\s+/)[0];
    const pmFilter = (req.query.pm || '').trim();
    if (isAssistant)   { where.push("LOWER(LTRIM(RTRIM(ISNULL(p.PM,'')))) = LOWER(@mypm)"); r.input('mypm', sql.NVarChar(60), myPm); }
    else if (pmFilter) { where.push("LOWER(LTRIM(RTRIM(ISNULL(p.PM,'')))) = LOWER(@pmf)");  r.input('pmf', sql.NVarChar(60), pmFilter); }

    // Row-level scope for Sales / FAE / heads (Product + admin => all rows). Fail CLOSED:
    // a scoped user with no matching owner-keys sees nothing rather than everything.
    const scope = await resolveDcScope(req.user, pool);
    if (!scope.all) {
      if (!scope.keys.length) { where.push('1 = 0'); }
      else {
        const ph = scope.keys.map((_, i) => '@sk' + i);
        scope.keys.forEach((k, i) => r.input('sk' + i, sql.NVarChar(80), k));
        where.push(scopePredicate(scope, 'p.', ph.join(',')));
      }
    }

    const W = where.join(' AND ');
    r.input('offset', sql.Int, offset);
    r.input('limit',  sql.Int, limit);

    const result = await r.query(`
      SELECT
        p.DcId, p.Company, p.PM, p.OpNo,
        CONVERT(VARCHAR(10), p.DcDate, 23)      AS DcDate,
        p.CustomerName, p.Vertical, p.CustomerCategory, p.Region, p.SalesPerson, p.FaePerson, p.LineFae,
        p.Segment, p.Project, p.ExistingMpn, p.ExistingMake, p.SuggestedMpn, p.SuggestedMake,
        p.ProjectStatus, p.SampleQty, p.SamplesStage,
        CONVERT(VARCHAR(10), p.StatusMonth, 23) AS StatusMonth,
        p.EauQty, p.Qps, p.UnitPriceUsd, p.Currency, p.Potential,
        CONVERT(VARCHAR(10), p.PpDateFae, 23)   AS PpDateFae,
        CONVERT(VARCHAR(10), p.MpDateSales, 23) AS MpDateSales,
        p.ProductTeamRemarks, p.CurrentStatus, p.ActionItem, p.Remarks,
        CONVERT(VARCHAR(19), p.CreatedAt, 120)  AS CreatedAt,
        ISNULL(u.Name, u.Username)              AS CreatedByName,
        COUNT(*) OVER ()                        AS TotalCount
      FROM [dbo].[BN_DCFile] p
      LEFT JOIN [dbo].[User_Login] u ON u.Id = p.CreatedBy
      WHERE ${W}
      ORDER BY p.DcDate DESC, p.DcId DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);
    const total = result.recordset[0] ? result.recordset[0].TotalCount : 0;
    const rows  = result.recordset.map(({ TotalCount, ...rest }) => rest);

    // stats (same filter, minus pagination)
    const sr = pool.request();
    if (company)       { sr.input('company', sql.NVarChar(10), company); }
    if (projectStatus) { sr.input('ps', sql.NVarChar(120), '%' + projectStatus + '%'); }
    if (bucket)        { sr.input('bucket', sql.NVarChar(10), bucket); }
    if (salesPerson)   { sr.input('sp', sql.NVarChar(110), salesPerson); }
    if (faePerson)     { sr.input('fp', sql.NVarChar(110), faePerson); }
    if (region)        { sr.input('region', sql.NVarChar(60), region); }
    if (fromDate)      { sr.input('from', sql.Date, toLocalDate(fromDate)); }
    if (toDate)        { sr.input('to', sql.Date, toLocalDate(toDate)); }
    if (search)        { sr.input('q', sql.NVarChar(300), '%' + search + '%'); }
    if (isAssistant)   { sr.input('mypm', sql.NVarChar(60), myPm); }
    else if (pmFilter) { sr.input('pmf', sql.NVarChar(60), pmFilter); }
    if (!scope.all && scope.keys.length) scope.keys.forEach((k, i) => sr.input('sk' + i, sql.NVarChar(80), k));
    // CUR_CASE + BUCKET_CASE are defined once above (shared with the WHERE + list).

    const statsQ = await sr.query(`
      SELECT
        COUNT(*)                              AS TotalLines,
        COUNT(DISTINCT NULLIF(p.OpNo, ''))    AS DistinctOps,
        ISNULL(SUM(p.Potential), 0)           AS TotalPotential,
        ISNULL(SUM(p.EauQty), 0)              AS TotalEau
      FROM [dbo].[BN_DCFile] p
      WHERE ${W};

      SELECT ${CUR_CASE} AS Cur, COUNT(*) AS Lines, ISNULL(SUM(p.Potential),0) AS Potential
      FROM [dbo].[BN_DCFile] p WHERE ${W} GROUP BY ${CUR_CASE};

      SELECT ${BUCKET_CASE} AS Bucket, ${CUR_CASE} AS Cur,
             COUNT(*) AS Lines, ISNULL(SUM(p.Potential),0) AS Potential
      FROM [dbo].[BN_DCFile] p WHERE ${W} GROUP BY ${BUCKET_CASE}, ${CUR_CASE};
    `);

    // People facet — distinct SalesPerson + FaePerson WITHIN the user's scope (ignores the
    // other filters so the dropdown always lists everyone). Only for roles that get a person
    // dropdown: Product/admin (both), a sales head (their team's salespeople), the FAE head
    // (their FAEs). A regular salesperson/FAE gets none (they only see themselves).
    let salesPersons = [], faePersons = [];
    if (isFullAccess(req.user) || isProduct(req.user) || isAnyHead(req.user) || isFaeHead(req.user)) {
      const fr = pool.request();
      let sw = 'IsActive = 1';
      if (!scope.all) {
        if (!scope.keys.length) sw += ' AND 1 = 0';
        else {
          const ph = scope.keys.map((_, i) => '@fk' + i);
          scope.keys.forEach((k, i) => fr.input('fk' + i, sql.NVarChar(80), k));
          sw += ' AND ' + scopePredicate(scope, '', ph.join(','));
        }
      }
      const fq = await fr.query(`
        SELECT DISTINCT LTRIM(RTRIM(SalesPerson)) AS v FROM [dbo].[BN_DCFile]
        WHERE ${sw} AND LTRIM(RTRIM(ISNULL(SalesPerson,''))) <> '' ORDER BY v;
        SELECT DISTINCT LTRIM(RTRIM(FaePerson)) AS v FROM [dbo].[BN_DCFile]
        WHERE ${sw} AND LTRIM(RTRIM(ISNULL(FaePerson,''))) <> '' ORDER BY v;`);
      salesPersons = (fq.recordsets[0] || []).map(x => x.v);
      faePersons   = (fq.recordsets[1] || []).map(x => x.v);
    }

    // PM facet — every active product-team member (first name) UNION any PM already used in the
    // data, so a newly-created product user (e.g. an ops head) is immediately selectable and legacy
    // names (a colleague) survive. Drives the PM filter + the Add-form PM dropdown (both were hardcoded).
    let pms = [];
    try {
      const pq = await pool.request().query(`
        SELECT DISTINCT v FROM (
          SELECT LTRIM(RTRIM(LEFT(Name, CASE WHEN CHARINDEX(' ', Name) > 0 THEN CHARINDEX(' ', Name) - 1 ELSE LEN(Name) END))) AS v
          FROM [dbo].[User_Login] WHERE IsActive = 1 AND LOWER(Role) LIKE '%product%'
          UNION SELECT LTRIM(RTRIM(PM)) FROM [dbo].[BN_DCFile] WHERE ISNULL(PM,'') <> ''
        ) t WHERE v <> '' ORDER BY v;`);
      pms = pq.recordset.map(x => x.v);
    } catch (_) { /* client falls back to its hardcoded options */ }

    // Add-form person dropdowns — ALL salespeople / FAE that have a login (User_Login), by FULL
    // name so the PM picks a real, unambiguous user. Row-scoping still reduces the stored value to
    // its first token (ownerKeyExpr), so a full name like "a colleague Patole" scopes to a colleague and a
    // "Shekhar a colleague" pick even bypasses the gurjar→shekhar alias. Product/admin only (Add form).
    let salesUsers = [], faeUsers = [];
    if (isFullAccess(req.user) || isProduct(req.user)) {
      try {
        const uq = await pool.request().query(`
          SELECT DISTINCT LTRIM(RTRIM(Name)) AS v FROM dbo.User_Login
          WHERE IsActive = 1 AND LOWER(Role) LIKE '%sales%' AND ISNULL(LTRIM(RTRIM(Name)),'') <> '' ORDER BY v;
          SELECT DISTINCT LTRIM(RTRIM(Name)) AS v FROM dbo.User_Login
          WHERE IsActive = 1 AND LOWER(Role) LIKE '%fae%' AND ISNULL(LTRIM(RTRIM(Name)),'') <> '' ORDER BY v;`);
        salesUsers = (uq.recordsets[0] || []).map(x => x.v).filter(Boolean);
        faeUsers   = (uq.recordsets[1] || []).map(x => x.v).filter(Boolean);
      } catch (_) { /* fall back to free-text on the client */ }
    }

    // Region facet — distinct Region values WITHIN the user's row scope, so the Region
    // dropdown lets PM / FAE Head / admin (and any viewer) slice the sheet region-wise.
    let regions = [];
    try {
      const rr = pool.request();
      let rw = 'IsActive = 1';
      if (!scope.all) {
        if (!scope.keys.length) rw += ' AND 1 = 0';
        else {
          const ph = scope.keys.map((_, i) => '@rk' + i);
          scope.keys.forEach((k, i) => rr.input('rk' + i, sql.NVarChar(80), k));
          rw += ' AND ' + scopePredicate(scope, '', ph.join(','));
        }
      }
      const rq = await rr.query(`SELECT DISTINCT LTRIM(RTRIM(Region)) AS v FROM [dbo].[BN_DCFile]
        WHERE ${rw} AND LTRIM(RTRIM(ISNULL(Region,''))) <> '' ORDER BY v;`);
      regions = rq.recordset.map(x => x.v).filter(Boolean);
    } catch (_) { /* leave empty → client hides the dropdown */ }

    return res.json({
      ok: true, total, page, limit, data: rows,
      summary:    statsQ.recordsets[0][0] || {},
      byCurrency: statsQ.recordsets[1] || [],
      funnel:     statsQ.recordsets[2] || [],
      salesPersons, faePersons, pms, salesUsers, faeUsers, regions,
    });
  } catch (err) {
    console.error('[GET /api/product/dc] failed:', err.message);
    return res.status(500).json({ message: 'DC list failed', detail: err.message });
  }
});

// True if a fetched row is within a scoped user's visibility (Product/admin => always).
async function rowInScope(pool, scope, row) {
  if (scope.all) return true;
  if (!scope.keys.length) return false;
  if (scope.faeLine) {
    const lk = row.LineFae   ? dcOwnerKeyJS(row.LineFae)   : null;   // brand owner
    const fk = row.FaePerson ? dcOwnerKeyJS(row.FaePerson) : null;   // who visited
    return (lk && scope.keys.includes(lk)) || (fk && scope.keys.includes(fk));
  }
  return scope.keys.includes(dcOwnerKeyJS(row[scope.col]));
}

// ── GET /:id ─────────────────────────────────────────────────────────────────
// A Product ASSISTANT is PM-scoped in the list (sees only their own PM's rows). Enforce
// that same boundary on single-row read/edit so it can't be bypassed via DcId.
function assistantPmMismatch(user, rowPm) {
  if (!(isProduct(user) && !isProductHead(user) && !isFullAccess(user))) return false;
  const myPm = (user.name || '').trim().split(/\s+/)[0].toLowerCase();
  return String(rowPm || '').trim().toLowerCase() !== myPm;
}

router.get('/:id', authenticate, canView, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, parseInt(req.params.id, 10))
      .query(`SELECT *,
        CONVERT(VARCHAR(10), DcDate, 23)      AS DcDateStr,
        CONVERT(VARCHAR(10), StatusMonth, 23) AS StatusMonthStr,
        CONVERT(VARCHAR(10), PpDateFae, 23)   AS PpDateFaeStr,
        CONVERT(VARCHAR(10), MpDateSales, 23) AS MpDateSalesStr
        FROM [dbo].[BN_DCFile] WHERE DcId = @id AND IsActive = 1;`);
    if (!r.recordset.length) return res.status(404).json({ message: 'DC row not found' });
    // Row-level scope — a Sales/FAE user can only open rows they're allowed to see;
    // a Product assistant only their own PM's rows.
    const scope = await resolveDcScope(req.user, pool);
    if (!(await rowInScope(pool, scope, r.recordset[0])) || assistantPmMismatch(req.user, r.recordset[0].PM))
      return res.status(404).json({ message: 'DC row not found' });
    return res.json({ ok: true, dc: r.recordset[0] });
  } catch (err) {
    return res.status(500).json({ message: 'DC fetch failed', detail: err.message });
  }
});

// shared field binder for POST/PATCH
function bindBody(r, b) {
  const set = [];
  const add = (col, val, type) => { set.push(col); r.input(col, type, val); };
  if (b.company       !== undefined) add('Company',            COMPANY(b.company),              sql.NVarChar(10));
  if (b.pm            !== undefined) add('PM',                 txt(b.pm, 60),                   sql.NVarChar(60));
  if (b.opNo          !== undefined) add('OpNo',               txt(b.opNo, 30),                 sql.NVarChar(30));
  if (b.dcDate        !== undefined) add('DcDate',             toLocalDate(b.dcDate),           sql.Date);
  if (b.customerName  !== undefined) add('CustomerName',       txt(b.customerName, 200),        sql.NVarChar(200));
  if (b.vertical      !== undefined) add('Vertical',           txt(b.vertical, 60),             sql.NVarChar(60));
  if (b.customerCategory !== undefined) add('CustomerCategory',txt(b.customerCategory, 60),     sql.NVarChar(60));
  if (b.region        !== undefined) add('Region',             txt(b.region, 40),               sql.NVarChar(40));
  if (b.salesPerson   !== undefined) add('SalesPerson',        txt(b.salesPerson, 100),         sql.NVarChar(100));
  if (b.faePerson     !== undefined) add('FaePerson',          txt(b.faePerson, 100),           sql.NVarChar(100));
  if (b.lineFae       !== undefined) add('LineFae',            txt(b.lineFae, 100),             sql.NVarChar(100));
  if (b.segment       !== undefined) add('Segment',            txt(b.segment, 100),             sql.NVarChar(100));
  if (b.project       !== undefined) add('Project',            txt(b.project, 200),             sql.NVarChar(200));
  if (b.existingMpn   !== undefined) add('ExistingMpn',        txt(b.existingMpn, 100),         sql.NVarChar(100));
  if (b.existingMake  !== undefined) add('ExistingMake',       txt(b.existingMake, 100),        sql.NVarChar(100));
  if (b.suggestedMpn  !== undefined) add('SuggestedMpn',       txt(b.suggestedMpn, 100),        sql.NVarChar(100));
  if (b.suggestedMake !== undefined) add('SuggestedMake',      txt(b.suggestedMake, 100),       sql.NVarChar(100));
  if (b.projectStatus !== undefined) add('ProjectStatus',      txt(b.projectStatus, 100),       sql.NVarChar(100));
  if (b.sampleQty     !== undefined) add('SampleQty',          num(b.sampleQty),                sql.Decimal(18, 2));
  if (b.samplesStage  !== undefined) add('SamplesStage',       txt(b.samplesStage, 120),        sql.NVarChar(120));
  if (b.statusMonth   !== undefined) add('StatusMonth',        toLocalDate(b.statusMonth),      sql.Date);
  if (b.eauQty        !== undefined) add('EauQty',             num(b.eauQty),                   sql.Decimal(18, 2));
  if (b.qps           !== undefined) add('Qps',                num(b.qps),                      sql.Decimal(18, 2));
  if (b.unitPriceUsd  !== undefined) add('UnitPriceUsd',       num(b.unitPriceUsd),             sql.Decimal(18, 4));
  if (b.currency      !== undefined) add('Currency',           txt(b.currency, 20),             sql.NVarChar(20));
  if (b.potential     !== undefined) add('Potential',          num(b.potential),                sql.Decimal(18, 2));
  if (b.ppDateFae     !== undefined) add('PpDateFae',          toLocalDate(b.ppDateFae),        sql.Date);
  if (b.mpDateSales   !== undefined) add('MpDateSales',        toLocalDate(b.mpDateSales),      sql.Date);
  if (b.productTeamRemarks !== undefined) add('ProductTeamRemarks', txt(b.productTeamRemarks),  sql.NVarChar(sql.MAX));
  if (b.currentStatus !== undefined) add('CurrentStatus',      txt(b.currentStatus),            sql.NVarChar(sql.MAX));
  if (b.actionItem    !== undefined) add('ActionItem',         txt(b.actionItem),               sql.NVarChar(sql.MAX));
  if (b.remarks       !== undefined) add('Remarks',            txt(b.remarks),                  sql.NVarChar(sql.MAX));
  return set;
}

// Auto-fill PM + Line FAE from the brand (Suggested Make) via the BN_DCLine chart when not supplied.
// Both are chart-driven per brand: PM = product manager, LineFae = the FAE who owns that line.
async function autoFillPm(pool, b) {
  const needPm  = !(b.pm && String(b.pm).trim());
  const needFae = !(b.lineFae && String(b.lineFae).trim());
  if ((!needPm && !needFae) || !b.suggestedMake) return;
  try {
    const hit = await pool.request().input('k', sql.NVarChar(120), normBrand(b.suggestedMake))
      .query("SELECT TOP 1 PM, LineFae FROM [dbo].[BN_DCLine] WHERE LineKey = @k");
    const row = hit.recordset[0];
    if (row) {
      if (needPm  && row.PM      && String(row.PM).trim())      b.pm      = row.PM;
      if (needFae && row.LineFae && String(row.LineFae).trim()) b.lineFae = row.LineFae;
    }
  } catch (_) { /* no map -> leave blank */ }
}

// True when a line body carries no meaningful content (used to skip empty stacked lines).
function lineHasContent(b) {
  return !!(b.customerName || b.opNo || b.suggestedMpn || b.existingMpn || b.suggestedMake ||
            b.projectStatus || b.eauQty || b.potential || b.productTeamRemarks || b.remarks);
}

// ── POST / — create one line (Product team + admin only) ─────────────────────
router.post('/', authenticate, canManage, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.customerName && !b.opNo && !b.suggestedMpn) {
      return res.status(400).json({ message: 'At least Customer / OP No / Suggested MPN is required' });
    }
    const pool = await getAppPool();
    await autoFillPm(pool, b);
    const r = pool.request();
    const set = bindBody(r, b);
    set.push('CreatedBy');
    r.input('CreatedBy', sql.Int, req.user.id);
    const out = await r.query(`
      INSERT INTO [dbo].[BN_DCFile] (${set.join(', ')})
      OUTPUT INSERTED.DcId
      VALUES (${set.map(c => '@' + c).join(', ')});
    `);
    return res.status(201).json({ ok: true, dcId: out.recordset[0].DcId });
  } catch (err) {
    console.error('[POST /api/product/dc] failed:', err.message);
    return res.status(500).json({ message: 'DC create failed', detail: err.message });
  }
});

// ── POST /bulk — create MANY lines under one shared header (multi-line Add) ────
// Body: { header:{…shared fields…}, lines:[ {…per-line fields…}, … ] }. Each line inherits the
// header, gets its own PM auto-filled from its Suggested Make, and is inserted in one transaction.
router.post('/bulk', authenticate, canManage, async (req, res) => {
  try {
    const header = (req.body && req.body.header) || {};
    const linesIn = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    const bodies = linesIn.map(ln => ({ ...header, ...ln })).filter(lineHasContent);
    if (!bodies.length) return res.status(400).json({ message: 'No lines to save (each needs Customer / OP No / Suggested MPN or part details).' });

    const pool = await getAppPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      let inserted = 0;
      for (const b of bodies) {
        await autoFillPm(pool, b);                    // per-line: each brand -> its own PM
        const r = new sql.Request(tx);
        const set = bindBody(r, b);
        set.push('CreatedBy');
        r.input('CreatedBy', sql.Int, req.user.id);
        await r.query(`INSERT INTO [dbo].[BN_DCFile] (${set.join(', ')}) VALUES (${set.map(c => '@' + c).join(', ')});`);
        inserted++;
      }
      await tx.commit();
      return res.status(201).json({ ok: true, inserted });
    } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
  } catch (err) {
    console.error('[POST /api/product/dc/bulk] failed:', err.message);
    return res.status(500).json({ message: 'Bulk DC create failed', detail: err.message });
  }
});

// dd-Mon-yy stamp for the append-log (server local time — display only, not a stored DATE).
function stampDate() {
  const d = new Date();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${String(d.getDate()).padStart(2, '0')}-${mon}-${String(d.getFullYear()).slice(2)}`;
}

// ── PATCH /:id — edit ────────────────────────────────────────────────────────
// Product/admin: full OVERWRITE of any field. Sales/FAE: APPEND a dated entry to their one
// remark column (Sales Team Remark=CurrentStatus / FAE Team remark=ActionItem) — every
// previous entry is kept, newest on top: "[02-Jul-26 · Rep] <text>".
router.patch('/:id', authenticate, canView, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const pool = await getAppPool();
    const id = parseInt(req.params.id, 10);
    const allowed = editableFieldsFor(req.user);   // null = Product/admin; else the single remark field

    // ── Sales / FAE — row-scope check, then APPEND to their one remark ──
    if (allowed) {
      const scope = await resolveDcScope(req.user, pool);
      const cur = await pool.request().input('id', sql.Int, id)
        .query('SELECT SalesPerson, FaePerson, LineFae FROM [dbo].[BN_DCFile] WHERE DcId = @id AND IsActive = 1;');
      if (!cur.recordset.length) return res.status(404).json({ message: 'DC row not found' });
      if (!scope.all && !(await rowInScope(pool, scope, cur.recordset[0]))) return res.status(403).json({ message: 'You can only edit your own DC rows' });

      const body  = req.body || {};
      const field = allowed[0];                                    // 'currentStatus' | 'actionItem'
      const col   = field === 'actionItem' ? 'ActionItem' : 'CurrentStatus';   // hard-coded, not user input
      const entry = String(body[field] || '').trim();

      // Typed workflow fields this role may OVERWRITE (FAE: Project Status / Samples stage /
      // PP date FAE; Sales: MP date Sales). Column names come from this hard-coded map — the
      // request body only chooses VALUES, never column names, so this is injection-safe.
      const FIELD_BIND = {
        projectStatus: ['ProjectStatus', v => txt(v, 100),  sql.NVarChar(100)],
        samplesStage:  ['SamplesStage',  v => txt(v, 120),  sql.NVarChar(120)],
        ppDateFae:     ['PpDateFae',     v => toLocalDate(v), sql.Date],
        mpDateSales:   ['MpDateSales',   v => toLocalDate(v), sql.Date],
      };
      const owFields = overwriteFieldsFor(req.user) || [];
      const r = pool.request().input('id', sql.Int, id).input('by', sql.Int, req.user.id);
      const sets = [];
      for (const f of owFields) {
        if (body[f] === undefined) continue;                       // only touch fields actually sent
        const [c, conv, type] = FIELD_BIND[f];
        r.input(c, type, conv(body[f]));
        sets.push(`${c} = @${c}`);
      }
      // Append the remark ATOMICALLY (newest on top) in the SAME UPDATE — no read-modify-write,
      // so a concurrent append can't be lost. col is hard-coded. Remark is optional now that a
      // Sales/FAE edit can also be just a typed-field change.
      if (entry) {
        const who   = (req.user.name || req.user.username || '').trim().split(/\s+/)[0] || 'User';
        const stamp = `[${stampDate()} · ${who}] ${entry}`;
        r.input('stamp', sql.NVarChar(sql.MAX), stamp);
        sets.push(`${col} = @stamp + CASE WHEN LEN(LTRIM(RTRIM(ISNULL(${col}, '')))) > 0
                                          THEN CHAR(10) + ${col} ELSE '' END`);
      }
      if (!sets.length) return res.status(400).json({ message: 'Nothing to save — add a remark or change an allowed field.' });
      await r.query(`UPDATE [dbo].[BN_DCFile]
                     SET ${sets.join(', ')}, UpdatedBy = @by, UpdatedAt = SYSDATETIME()
                     WHERE DcId = @id;`);
      return res.json({ ok: true, appended: !!entry, updated: sets.length });
    }

    // ── Product / admin — full overwrite edit ──
    // A Product ASSISTANT may only edit rows under their own PM (same boundary as the list).
    if (isProduct(req.user) && !isProductHead(req.user) && !isFullAccess(req.user)) {
      const cur = await pool.request().input('id', sql.Int, id)
        .query('SELECT PM FROM [dbo].[BN_DCFile] WHERE DcId = @id AND IsActive = 1;');
      if (!cur.recordset.length) return res.status(404).json({ message: 'DC row not found' });
      if (assistantPmMismatch(req.user, cur.recordset[0].PM)) return res.status(403).json({ message: 'You can only edit rows under your own PM.' });
    }
    const r = pool.request().input('id', sql.Int, id);
    const set = bindBody(r, req.body || {});
    if (!set.length) return res.status(400).json({ message: 'no fields to update' });
    r.input('UpdatedBy', sql.Int, req.user.id);
    await r.query(`
      UPDATE [dbo].[BN_DCFile]
      SET ${set.map(c => `${c} = @${c}`).join(', ')}, UpdatedBy = @UpdatedBy, UpdatedAt = SYSDATETIME()
      WHERE DcId = @id;
    `);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /api/product/dc] failed:', err.message);
    return res.status(500).json({ message: 'DC update failed', detail: err.message });
  }
});

// ── DELETE /:id (soft) — head/admin only ────────────────────────────────────
router.delete('/:id', authenticate, canDelete, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, parseInt(req.params.id, 10))
      .query('UPDATE [dbo].[BN_DCFile] SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE DcId = @id;');
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'DC delete failed', detail: err.message });
  }
});

// Column order for the BULK-insert staging table — must match BN_DCFile and the
// addDcBulkRow() value order below exactly.
const DC_BULK_COLS = [
  ['Company', sql.NVarChar(10)], ['PM', sql.NVarChar(60)], ['OpNo', sql.NVarChar(30)], ['DcDate', sql.Date],
  ['CustomerName', sql.NVarChar(200)], ['Vertical', sql.NVarChar(60)], ['CustomerCategory', sql.NVarChar(60)],
  ['Region', sql.NVarChar(40)], ['SalesPerson', sql.NVarChar(100)], ['FaePerson', sql.NVarChar(100)],
  ['LineFae', sql.NVarChar(100)],
  ['Segment', sql.NVarChar(100)], ['Project', sql.NVarChar(200)], ['ExistingMpn', sql.NVarChar(100)],
  ['ExistingMake', sql.NVarChar(100)], ['SuggestedMpn', sql.NVarChar(100)], ['SuggestedMake', sql.NVarChar(100)],
  ['ProjectStatus', sql.NVarChar(100)], ['SampleQty', sql.Decimal(18, 2)], ['SamplesStage', sql.NVarChar(120)],
  ['StatusMonth', sql.Date], ['EauQty', sql.Decimal(18, 2)], ['Qps', sql.Decimal(18, 2)],
  ['UnitPriceUsd', sql.Decimal(18, 4)], ['Currency', sql.NVarChar(20)], ['Potential', sql.Decimal(18, 2)],
  ['PpDateFae', sql.Date], ['MpDateSales', sql.Date], ['ProductTeamRemarks', sql.NVarChar(sql.MAX)],
  ['CurrentStatus', sql.NVarChar(sql.MAX)], ['ActionItem', sql.NVarChar(sql.MAX)], ['Remarks', sql.NVarChar(sql.MAX)],
];
function newDcBulkTable() {
  const t = new sql.Table('dbo.BN_DCFile');
  t.create = false;
  for (const [name, type] of DC_BULK_COLS) t.columns.add(name, type, { nullable: true });
  t.columns.add('IsActive',  sql.Bit,      { nullable: false });
  t.columns.add('CreatedBy', sql.Int,      { nullable: true });
  t.columns.add('CreatedAt', sql.DateTime, { nullable: false });
  return t;
}
function addDcBulkRow(t, p, userId, now) {
  t.rows.add(
    p.company ?? null, p.pm ?? null, p.opNo ?? null, p.dcDate ?? null, p.customerName ?? null,
    p.vertical ?? null, p.customerCategory ?? null, p.region ?? null, p.salesPerson ?? null, p.faePerson ?? null,
    p.lineFae ?? null,
    p.segment ?? null, p.project ?? null, p.existingMpn ?? null, p.existingMake ?? null, p.suggestedMpn ?? null,
    p.suggestedMake ?? null, p.projectStatus ?? null, p.sampleQty ?? null, p.samplesStage ?? null, p.statusMonth ?? null,
    p.eauQty ?? null, p.qps ?? null, p.unitPriceUsd ?? null, p.currency ?? null, p.potential ?? null,
    p.ppDateFae ?? null, p.mpDateSales ?? null, p.productTeamRemarks ?? null, p.currentStatus ?? null,
    p.actionItem ?? null, p.remarks ?? null,
    1, userId ?? null, now);
}

// ── UPSERT (fast) — match by Company + OP No + Customer Name, MPNs NOT in the key ──
// Existing active keys are loaded ONCE into memory (no per-row SELECT — that was the
// slow part). Rows are classified into UPDATES (positional pairing of multi-line OPs:
// the 2nd Excel line maps to the 2nd existing line) and INSERTS. Inserts go via TDS
// BULK insert in chunks (thousands/sec); updates run with limited concurrency. Blank
// cells preserved (COALESCE). Honours job.cancel between chunks and updates job.processed
// for the progress bar. dryRun returns the update/insert split without writing.
async function upsertRows(pool, parsed, userId, dryRun, job) {
  const norm = s => String(s == null ? '' : s).trim().toLowerCase();

  // 1) load existing active keys once → map key -> [DcId,...] in id order
  const map = new Map();
  const ex = await pool.request().query(
    `SELECT DcId, ISNULL(Company,'') Company, ISNULL(OpNo,'') OpNo, ISNULL(CustomerName,'') CustomerName
     FROM [dbo].[BN_DCFile] WHERE IsActive = 1 ORDER BY DcId`);
  for (const r of ex.recordset) {
    const k = `${norm(r.Company)}||${norm(r.OpNo)}||${norm(r.CustomerName)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r.DcId);
  }

  // 2) classify in memory (positional pairing for repeated keys)
  const nextIdx = new Map();
  const updates = [], inserts = [];
  for (const p of parsed) {
    let targetId = null;
    if (norm(p.opNo) || norm(p.customerName)) {
      const k = `${norm(p.company)}||${norm(p.opNo)}||${norm(p.customerName)}`;
      const arr = map.get(k);
      if (arr) { const i = nextIdx.get(k) || 0; if (i < arr.length) { targetId = arr[i]; nextIdx.set(k, i + 1); } }
    }
    if (targetId != null) updates.push({ p, targetId }); else inserts.push(p);
  }

  if (dryRun) return { inserted: inserts.length, updated: updates.length, failed: 0, failures: [] };

  let inserted = 0, updated = 0, failed = 0; const failures = [];

  // 3a) UPDATES — limited concurrency (app pool max = 10)
  let ui = 0;
  await Promise.all(Array.from({ length: Math.min(8, updates.length) }, async () => {
    while (ui < updates.length) {
      if (job && job.cancel) return;
      const { p, targetId } = updates[ui++];
      try {
        const r = pool.request(); const set = bindBody(r, p);
        r.input('id', sql.Int, targetId).input('UpdatedBy', sql.Int, userId);
        // Team-owned remark columns (Sales Team Remark = CurrentStatus, FAE Team remark =
        // ActionItem) get FILL-EMPTY-ONLY semantics on bulk update (fix 2026-08-10). The
        // team maintains these IN their master sheet and re-imports expecting them to load,
        // so a BLANK DB cell IS filled from the sheet — but a cell that ALREADY holds a
        // remark is never overwritten (protects anything Sales/FAE appended in-app via the
        // /import-remarks flow after Product last exported). Before this fix these two
        // columns were skipped on every update, so master-sheet remarks never loaded onto
        // existing rows (FAE/Sales remarks went missing on ~2,000 rows). Everything else is
        // incoming-wins-if-present, COALESCE(@col, col), so blank cells still preserve.
        const OWN = new Set(['CurrentStatus', 'ActionItem']);
        const assigns = [
          ...set.filter(c => !OWN.has(c)).map(c => `${c} = COALESCE(@${c}, ${c})`),
          ...set.filter(c =>  OWN.has(c)).map(c => `${c} = COALESCE(NULLIF(${c}, ''), @${c}, ${c})`),
        ];
        await r.query(`UPDATE [dbo].[BN_DCFile] SET
          ${assigns.join(', ')}, UpdatedBy = @UpdatedBy, UpdatedAt = SYSDATETIME()
          WHERE DcId = @id;`);
        updated++;
      } catch (e) { failed++; if (failures.length < 10) failures.push({ reason: e.message, opNo: p.opNo, customerName: p.customerName, suggestedMpn: p.suggestedMpn }); }
      if (job) { job.processed++; job.updated = updated; job.failed = failed; }
    }
  }));

  // 3b) INSERTS — TDS bulk insert, 500-row chunks (fast); cancel-aware between chunks
  const CHUNK = 500;
  for (let i = 0; i < inserts.length && !(job && job.cancel); i += CHUNK) {
    const slice = inserts.slice(i, i + CHUNK);
    const now = new Date();
    const tbl = newDcBulkTable();
    for (const p of slice) addDcBulkRow(tbl, p, userId, now);
    try { await pool.request().bulk(tbl); inserted += slice.length; }
    catch (e) {
      failed += slice.length;
      if (failures.length < 10) failures.push({ reason: 'bulk chunk failed: ' + e.message });
      console.error('[dc/import] bulk chunk failed:', e.message);
    }
    if (job) { job.processed += slice.length; job.inserted = inserted; job.failed = failed; }
  }

  return { inserted, updated, failed, failures, cancelled: !!(job && job.cancel) };
}

// ── POST /import — Excel bulk UPSERT ─────────────────────────────────────────
// Matches the "DC file" sheet headers. A row is matched to an existing line by
// Company + OP No + Customer Name (NOT the MPNs) — see upsertRows above.
router.post('/import', authenticate, canManage, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const dryRun = req.query.dryRun === 'true' || req.body.dryRun === 'true';

    const MAP = {
      company:           ['Company'],
      pm:                ['PM', 'PM Name', 'Product Manager', 'PM Person'],
      opNo:              ['OP N0.', 'OP No', 'OP No.', 'Opportunity #', 'Opportunity No', 'OPNO'],
      dcDate:            ['Date'],
      customerName:      ['Customer Name', 'Company Name', 'Customer'],
      vertical:          ['Vertical'],
      customerCategory:  ['Customer Category'],
      region:            ['Region'],
      salesPerson:       ['Sales Person', 'Salesperson', 'FSR'],
      faePerson:         ['FAE Person', 'FAE'],
      lineFae:           ['Line FAE', 'LineFAE', 'Line FAE Person'],
      segment:           ['Segment'],
      project:           ['Project'],
      existingMpn:       ['Existing MPN', 'Existing Part', 'Inquiry Part No'],
      existingMake:      ['Existing Make', 'Inquiry Part Make'],
      suggestedMpn:      ['Suggested MPN', 'Suggested Part'],
      suggestedMake:     ['Suggested Make', 'Suggested Part Make'],
      projectStatus:     ['Project Status'],
      sampleQty:         ['Sample Qty'],
      samplesStage:      ['Samples stage', 'Samples Stage', 'Sample Stage'],
      statusMonth:       ['Status Month'],
      eauQty:            ['EAU Qty', 'EAU', 'Annual Quantity', 'Annual Qty'],
      qps:               ['QPS'],
      unitPriceUsd:      ['Unit Price in USD', 'Unit Price', 'Unit Price USD'],
      currency:          ['Currency'],
      potential:         ['Potential'],
      ppDateFae:         ['PP date FAE', 'PP Date FAE'],
      mpDateSales:       ['MP date Sales', 'MP Date Sales'],
      productTeamRemarks:['Product team remarks', 'Product Team Remarks'],
      // CurrentStatus DB column now holds the "Sales Team Remark" (salesperson-editable);
      // ActionItem DB column holds the "FAE Team remark" (FAE-editable). Old header names
      // kept as aliases so older sheets still import.
      currentStatus:     ['Sales Team Remark', 'Sales Team Remarks', 'Current status -FAE/Sales', 'Current status', 'Current Status'],
      actionItem:        ['FAE Team remark', 'FAE Team Remark', 'Action Item-Sales/FAE/PM', 'Action Item', 'Action Items'],
      remarks:           ['Remarks', 'Remark'],
    };

    // cellDates:FALSE on purpose — date cells arrive as raw Excel serials, which
    // parseExcelDate() converts via xlsx.SSF (no timezone math → date stored exactly as
    // shown in Excel). Reading them as JS Dates (cellDates:true) drifts ±1 day by TZ.
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
    // Prefer a sheet literally named "DC file"; else the first non-empty.
    const sheetName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'dc file') || wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return res.status(400).json({ message: 'No sheet found in workbook' });
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: true });
    const sampleKeys = Object.keys(rows[0] || {});
    const keyMap = {};
    for (const f of Object.keys(MAP)) {
      keyMap[f] = sampleKeys.find(s => MAP[f].some(c => c.toUpperCase().trim() === s.toUpperCase().trim())) || null;
    }

    const parsed = rows.map(row => ({
      company:           COMPANY(row[keyMap.company]) || COMPANY(req.query.company) || null,
      pm:                txt(row[keyMap.pm], 60),
      opNo:              txt(row[keyMap.opNo], 30),
      dcDate:            parseExcelDate(row[keyMap.dcDate]),
      customerName:      txt(row[keyMap.customerName], 200),
      vertical:          txt(row[keyMap.vertical], 60),
      customerCategory:  txt(row[keyMap.customerCategory], 60),
      region:            txt(row[keyMap.region], 40),
      salesPerson:       txt(row[keyMap.salesPerson], 100),
      faePerson:         txt(row[keyMap.faePerson], 100),
      lineFae:           txt(row[keyMap.lineFae], 100),
      segment:           txt(row[keyMap.segment], 100),
      project:           txt(row[keyMap.project], 200),
      existingMpn:       txt(row[keyMap.existingMpn], 100),
      existingMake:      txt(row[keyMap.existingMake], 100),
      suggestedMpn:      txt(row[keyMap.suggestedMpn], 100),
      suggestedMake:     txt(row[keyMap.suggestedMake], 100),
      projectStatus:     txt(row[keyMap.projectStatus], 100),
      sampleQty:         num(row[keyMap.sampleQty]),
      samplesStage:      txt(row[keyMap.samplesStage], 120),
      statusMonth:       parseExcelDate(row[keyMap.statusMonth]),
      eauQty:            num(row[keyMap.eauQty]),
      qps:               num(row[keyMap.qps]),
      unitPriceUsd:      num(row[keyMap.unitPriceUsd]),
      currency:          txt(row[keyMap.currency], 20),
      potential:         num(row[keyMap.potential]),
      ppDateFae:         parseExcelDate(row[keyMap.ppDateFae]),
      mpDateSales:       parseExcelDate(row[keyMap.mpDateSales]),
      productTeamRemarks:txt(row[keyMap.productTeamRemarks]),
      currentStatus:     txt(row[keyMap.currentStatus]),
      actionItem:        txt(row[keyMap.actionItem]),
      remarks:           txt(row[keyMap.remarks]),
    })).filter(p => p.customerName || p.opNo || p.suggestedMpn || p.existingMpn);

    // Auto-fill PM from the brand (Suggested Make) for any row that has no PM.
    const lineMap = await loadLineMap(await getAppPool());
    let autoFilled = 0;
    parsed.forEach(p => { if (!p.pm && p.suggestedMake) { const hit = lineMap.get(normBrand(p.suggestedMake)); if (hit) { p.pm = hit; autoFilled++; } } });

    const pool = await getAppPool();

    // Preview stays synchronous (quick, read-only) — returns the update/insert split.
    if (dryRun) {
      const stats = await upsertRows(pool, parsed, req.user.id, true, null);
      return res.json({ ok: true, dryRun: true, sheetName, rowsScanned: rows.length, rowsParsed: parsed.length,
        pmAutoFilled: autoFilled, willUpdate: stats.updated, willInsert: stats.inserted, detectedMapping: keyMap, preview: parsed.slice(0, 8) });
    }

    // Guard against CONCURRENT imports (repeated clicks / multiple tabs). Overlapping
    // imports each run the UPSERT existence-check before the others commit, so they all
    // "see nothing" and INSERT — multiplying rows. Allow only one at a time.
    for (const j of importJobs.values()) {
      if (!j.done) return res.status(409).json({ message: 'An import is already running — please wait for it to finish before starting another.' });
    }

    // Real import → run in the BACKGROUND and return a jobId immediately so the page can
    // poll progress (GET /import/progress/:jobId). Avoids the "frozen, no feedback" wait.
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      jobId, total: parsed.length, processed: 0, inserted: 0, updated: 0, failed: 0,
      done: false, error: null, failures: [], cancel: false, cancelled: false,
      sheetName, rowsScanned: rows.length, rowsParsed: parsed.length, pmAutoFilled: autoFilled,
    };
    importJobs.set(jobId, job);
    (async () => {
      try {
        const stats = await upsertRows(pool, parsed, req.user.id, false, job);
        job.failures = stats.failures;
        job.cancelled = !!stats.cancelled;
      } catch (e) {
        job.error = e.message || 'Import failed';
        console.error('[dc/import bg] failed:', e.message);
      } finally {
        job.done = true;
        setTimeout(() => importJobs.delete(jobId), 120000);   // evict 2 min after finish
      }
    })();
    return res.status(202).json({ ok: true, jobId, total: parsed.length, sheetName,
      rowsParsed: parsed.length, pmAutoFilled: autoFilled });
  } catch (err) {
    console.error('[POST /api/product/dc/import] failed:', err.message);
    return res.status(500).json({ message: 'DC import failed', detail: err.message });
  }
});

// ── GET /import/progress/:jobId — poll a running/finished background import ───
router.get('/import/progress/:jobId', authenticate, canManage, (req, res) => {
  const job = importJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ message: 'Import job not found (it may have finished and expired).' });
  const pct = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 100;
  return res.json({ ok: true, pct, ...job });
});

// ── POST /import/cancel/:jobId — stop a running background import ─────────────
router.post('/import/cancel/:jobId', authenticate, canManage, (req, res) => {
  const job = importJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ message: 'Import job not found.' });
  job.cancel = true;
  return res.json({ ok: true });
});

// ── GET /export — Excel download (respects filter / ?ids=) ───────────────────
router.get('/export', authenticate, canView, async (req, res) => {
  try {
    // Export mirrors the list: company scoped ONLY by the dropdown (filterCompany),
    // never by the auto-injected ?company=, so "export all" gives both companies.
    const company       = COMPANY(req.query.filterCompany);
    const projectStatus = (req.query.projectStatus || '').trim();
    const bucket        = (req.query.bucket         || '').trim().toUpperCase();
    const salesPerson   = (req.query.salesPerson    || '').trim();
    const faePerson     = (req.query.faePerson      || '').trim();
    const region        = (req.query.region         || '').trim();
    const search        = (req.query.search          || '').trim();
    const fromDate      = (req.query.fromDate        || '').trim();
    const toDate        = (req.query.toDate          || '').trim();
    const pmFilter      = (req.query.pm              || '').trim();
    const idsParam      = (req.query.ids || '').trim();
    const ids = idsParam ? idsParam.split(',').map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
    // Same bucket CASE as the list (unqualified — export has no table alias) so
    // "export what I clicked" matches the on-screen funnel card exactly.
    const EXPORT_BUCKET_CASE = `CASE
        WHEN UPPER(LTRIM(RTRIM(ISNULL(ProjectStatus,'')))) LIKE '%NBO%'  THEN 'NBO'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(ProjectStatus,'')))) LIKE '%PWIN%' THEN 'PWIN'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(ProjectStatus,'')))) LIKE '%DWIN%' THEN 'DWIN'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(ProjectStatus,'')))) LIKE '%MWIN%' THEN 'MWIN'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(ProjectStatus,'')))) LIKE '%DIN%'  THEN 'DIN'
        WHEN UPPER(LTRIM(RTRIM(ISNULL(ProjectStatus,'')))) LIKE '%LOSS%'
          OR UPPER(LTRIM(RTRIM(ISNULL(ProjectStatus,'')))) LIKE '%LOST%' THEN 'LOSS'
        ELSE 'OTHER' END`;

    const pool = await getAppPool();
    const r = pool.request();
    const where = ['IsActive = 1'];
    if (ids.length) {
      ids.forEach((id, i) => r.input('eid' + i, sql.Int, id));
      where.push(`DcId IN (${ids.map((_, i) => '@eid' + i).join(',')})`);
    } else {
      if (company)       { where.push('Company = @company');   r.input('company', sql.NVarChar(10), company); }
      if (projectStatus) { where.push('ProjectStatus LIKE @ps'); r.input('ps', sql.NVarChar(120), '%' + projectStatus + '%'); }
      if (bucket)        { where.push(`(${EXPORT_BUCKET_CASE}) = @bucket`); r.input('bucket', sql.NVarChar(10), bucket); }
      if (salesPerson)   { where.push("LTRIM(RTRIM(ISNULL(SalesPerson,''))) = @sp"); r.input('sp', sql.NVarChar(110), salesPerson); }
      if (faePerson)     { where.push("LTRIM(RTRIM(ISNULL(FaePerson,'')))   = @fp"); r.input('fp', sql.NVarChar(110), faePerson); }
      if (region)        { where.push("LTRIM(RTRIM(ISNULL(Region,'')))      = @region"); r.input('region', sql.NVarChar(60), region); }
      // Date-range filter — must mirror the list (DcDate BETWEEN from..to) so a dated
      // export returns only that window, not the whole sheet.
      if (fromDate)      { where.push('DcDate >= @from'); r.input('from', sql.Date, toLocalDate(fromDate)); }
      if (toDate)        { where.push('DcDate <= @to');   r.input('to',   sql.Date, toLocalDate(toDate)); }
      if (search) {
        where.push(`(
          ISNULL(OpNo,'') LIKE @q OR ISNULL(CustomerName,'') LIKE @q
          OR ISNULL(ExistingMpn,'') LIKE @q OR ISNULL(SuggestedMpn,'') LIKE @q
          OR ISNULL(ExistingMake,'') LIKE @q OR ISNULL(SuggestedMake,'') LIKE @q
          OR ISNULL(Project,'') LIKE @q OR ISNULL(ProjectStatus,'') LIKE @q
          OR ISNULL(SamplesStage,'') LIKE @q OR ISNULL(ProductTeamRemarks,'') LIKE @q
          OR ISNULL(CurrentStatus,'') LIKE @q OR ISNULL(Remarks,'') LIKE @q
          OR ISNULL(Vertical,'') LIKE @q OR ISNULL(Segment,'') LIKE @q
          OR ISNULL(Region,'') LIKE @q OR ISNULL(CustomerCategory,'') LIKE @q
          OR ISNULL(SalesPerson,'') LIKE @q OR ISNULL(FaePerson,'') LIKE @q
          OR ISNULL(PM,'') LIKE @q
        )`);
        r.input('q', sql.NVarChar(300), '%' + search + '%');
      }
    }
    // PM segregation applies to export too — assistants only export their own lines
    // (enforced even for ?ids= exports). A head/admin's explicit ?pm= dropdown filter is
    // honoured too (list parity), but only for a filter export, not an ?ids= selection.
    if (isProduct(req.user) && !isProductHead(req.user) && !isFullAccess(req.user)) {
      where.push("LOWER(LTRIM(RTRIM(ISNULL(PM,'')))) = LOWER(@mypm)");
      r.input('mypm', sql.NVarChar(60), (req.user.name || '').trim().split(/\s+/)[0]);
    } else if (pmFilter && !ids.length) {
      where.push("LOWER(LTRIM(RTRIM(ISNULL(PM,'')))) = LOWER(@pmf)");
      r.input('pmf', sql.NVarChar(60), pmFilter);
    }
    // Row-level scope — a Sales/FAE export must enforce the SAME visibility as their list
    // (also for ?ids= exports, so they can't export rows outside their scope). Fail closed.
    const scope = await resolveDcScope(req.user, pool);
    if (!scope.all) {
      if (!scope.keys.length) { where.push('1 = 0'); }
      else {
        const ph = scope.keys.map((_, i) => '@sk' + i);
        scope.keys.forEach((k, i) => r.input('sk' + i, sql.NVarChar(80), k));
        where.push(scopePredicate(scope, '', ph.join(',')));
      }
    }
    const result = await r.query(`
      SELECT
        OpNo AS [OP N0.], PM AS [PM], CONVERT(VARCHAR(10), DcDate, 105) AS [Date], CustomerName AS [Customer Name],
        Vertical AS [Vertical], CustomerCategory AS [Customer Category], Region AS [Region], Company AS [Company],
        SalesPerson AS [Sales Person], FaePerson AS [FAE Person], LineFae AS [Line FAE], Segment AS [Segment], Project AS [Project],
        ExistingMpn AS [Existing MPN], ExistingMake AS [Existing Make], SuggestedMpn AS [Suggested MPN], SuggestedMake AS [Suggested Make],
        ProjectStatus AS [Project Status], SampleQty AS [Sample Qty], SamplesStage AS [Samples stage],
        CONVERT(VARCHAR(10), StatusMonth, 105) AS [Status Month], EauQty AS [EAU Qty], Qps AS [QPS],
        UnitPriceUsd AS [Unit Price in USD], Currency AS [Currency], Potential AS [Potential],
        CONVERT(VARCHAR(10), PpDateFae, 105) AS [PP date FAE], CONVERT(VARCHAR(10), MpDateSales, 105) AS [MP date Sales],
        ProductTeamRemarks AS [Product team remarks], CurrentStatus AS [Sales Team Remark],
        ActionItem AS [FAE Team remark], Remarks AS [Remarks]
      FROM [dbo].[BN_DCFile]
      WHERE ${where.join(' AND ')}
      ORDER BY DcDate DESC, DcId DESC;
    `);
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(result.recordset);
    xlsx.utils.book_append_sheet(wb, ws, 'DC file');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="COMPANYA_DCFile_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return res.end(buf);
  } catch (err) {
    console.error('[GET /api/product/dc/export] failed:', err.message);
    return res.status(500).json({ message: 'DC export failed', detail: err.message });
  }
});

// ── GET /export-remarks — slim, PROTECTED "edit my remarks" template ─────────
// Sales/FAE bulk workflow: download only THEIR scoped rows with OP/Customer/Part/Status
// context (locked) + ONE blank editable column ("Add Sales/FAE Remark"). Fill it offline,
// re-import via POST /import-remarks → each filled entry is APPENDED (stamped). Respects the
// current search / company / status / date filters so they can export just one OP's parts.
router.get('/export-remarks', authenticate, canView, async (req, res) => {
  try {
    const pool = await getAppPool();
    const ctx = remarkCtxFor(req.user);
    const scope = await resolveDcScope(req.user, pool);

    const r = pool.request();
    const where = ['IsActive = 1'];
    const company = COMPANY(req.query.filterCompany);
    if (company) { where.push('Company = @company'); r.input('company', sql.NVarChar(10), company); }
    const projectStatus = (req.query.projectStatus || '').trim();
    if (projectStatus) { where.push('ProjectStatus LIKE @ps'); r.input('ps', sql.NVarChar(120), '%' + projectStatus + '%'); }
    const fromDate = (req.query.fromDate || '').trim();
    if (fromDate) { where.push('DcDate >= @from'); r.input('from', sql.Date, toLocalDate(fromDate)); }
    const toDate = (req.query.toDate || '').trim();
    if (toDate) { where.push('DcDate <= @to'); r.input('to', sql.Date, toLocalDate(toDate)); }
    const search = (req.query.search || '').trim();
    if (search) {
      where.push(`(ISNULL(OpNo,'') LIKE @q OR ISNULL(CustomerName,'') LIKE @q OR ISNULL(SuggestedMpn,'') LIKE @q
        OR ISNULL(SuggestedMake,'') LIKE @q OR ISNULL(ProjectStatus,'') LIKE @q OR ISNULL(Project,'') LIKE @q)`);
      r.input('q', sql.NVarChar(300), '%' + search + '%');
    }
    // Person dropdown filters — a head can export ONE salesperson's / FAE's parts.
    const salesPerson = (req.query.salesPerson || '').trim();
    if (salesPerson) { where.push("LTRIM(RTRIM(ISNULL(SalesPerson,''))) = @sp"); r.input('sp', sql.NVarChar(110), salesPerson); }
    const faePerson = (req.query.faePerson || '').trim();
    if (faePerson) { where.push("LTRIM(RTRIM(ISNULL(FaePerson,''))) = @fp"); r.input('fp', sql.NVarChar(110), faePerson); }
    const region = (req.query.region || '').trim();
    if (region) { where.push("LTRIM(RTRIM(ISNULL(Region,''))) = @region"); r.input('region', sql.NVarChar(60), region); }
    // Row scope — a scoped user gets ONLY their own rows (fail closed).
    if (!scope.all) {
      if (!scope.keys.length) { where.push('1 = 0'); }
      else {
        const ph = scope.keys.map((_, i) => '@sk' + i);
        scope.keys.forEach((k, i) => r.input('sk' + i, sql.NVarChar(80), k));
        where.push(scopePredicate(scope, '', ph.join(',')));
      }
    }
    const rs = await r.query(`
      SELECT DcId,
        ISNULL(OpNo,'') OpNo, ISNULL(PM,'') PM, CONVERT(VARCHAR(10),DcDate,105) DcDate,
        ISNULL(CustomerName,'') CustomerName, ISNULL(Vertical,'') Vertical, ISNULL(CustomerCategory,'') CustomerCategory,
        ISNULL(Region,'') Region, ISNULL(Company,'') Company, ISNULL(SalesPerson,'') SalesPerson, ISNULL(FaePerson,'') FaePerson,
        ISNULL(Segment,'') Segment, ISNULL(Project,'') Project, ISNULL(ExistingMpn,'') ExistingMpn, ISNULL(ExistingMake,'') ExistingMake,
        ISNULL(SuggestedMpn,'') SuggestedMpn, ISNULL(SuggestedMake,'') SuggestedMake, ISNULL(ProjectStatus,'') ProjectStatus,
        SampleQty, ISNULL(SamplesStage,'') SamplesStage, CONVERT(VARCHAR(10),StatusMonth,105) StatusMonth, EauQty, Qps,
        UnitPriceUsd, ISNULL(Currency,'') Currency, Potential,
        CONVERT(VARCHAR(10),PpDateFae,105) PpDateFae, CONVERT(VARCHAR(10),MpDateSales,105) MpDateSales,
        ISNULL(ProductTeamRemarks,'') ProductTeamRemarks, ISNULL(CurrentStatus,'') CurrentStatus,
        ISNULL(ActionItem,'') ActionItem, ISNULL(Remarks,'') Remarks
      FROM [dbo].[BN_DCFile] WHERE ${where.join(' AND ')} ORDER BY SalesPerson, FaePerson, OpNo, DcId;`);

    // Full-visibility, PROTECTED "edit remarks" workbook: every DC column is shown read-only
    // (incl. all three teams' remarks, so each team has full context), and ONLY the trailing
    // "Add <Sales/FAE> Remark" column is editable. /import-remarks reads just DcId + that Add
    // column, so the read-only columns (even blank/stale in an offline sheet) never affect a re-import.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Edit Remarks');
    ws.columns = [
      { header: 'DcId',                 key: 'DcId',              width: 8  },
      { header: 'OP N0.',               key: 'OpNo',              width: 12 },
      { header: 'PM',                   key: 'PM',                width: 12 },
      { header: 'Date',                 key: 'DcDate',            width: 12 },
      { header: 'Customer Name',        key: 'CustomerName',      width: 28 },
      { header: 'Vertical',             key: 'Vertical',          width: 12 },
      { header: 'Customer Category',    key: 'CustomerCategory',  width: 16 },
      { header: 'Region',               key: 'Region',            width: 10 },
      { header: 'Company',              key: 'Company',           width: 10 },
      { header: 'Sales Person',         key: 'SalesPerson',       width: 16 },
      { header: 'FAE Person',           key: 'FaePerson',         width: 16 },
      { header: 'Segment',              key: 'Segment',           width: 14 },
      { header: 'Project',              key: 'Project',           width: 22 },
      { header: 'Existing MPN',         key: 'ExistingMpn',       width: 20 },
      { header: 'Existing Make',        key: 'ExistingMake',      width: 14 },
      { header: 'Suggested MPN',        key: 'SuggestedMpn',      width: 22 },
      { header: 'Suggested Make',       key: 'SuggestedMake',     width: 16 },
      { header: 'Project Status',       key: 'ProjectStatus',     width: 20 },
      { header: 'Sample Qty',           key: 'SampleQty',         width: 10 },
      { header: 'Samples stage',        key: 'SamplesStage',      width: 16 },
      { header: 'Status Month',         key: 'StatusMonth',       width: 12 },
      { header: 'EAU Qty',              key: 'EauQty',            width: 10 },
      { header: 'QPS',                  key: 'Qps',               width: 8  },
      { header: 'Unit Price in USD',    key: 'UnitPriceUsd',      width: 14 },
      { header: 'Currency',             key: 'Currency',          width: 10 },
      { header: 'Potential',            key: 'Potential',         width: 12 },
      { header: 'PP date FAE',          key: 'PpDateFae',         width: 12 },
      { header: 'MP date Sales',        key: 'MpDateSales',       width: 12 },
      { header: 'Product team remarks', key: 'ProductTeamRemarks',width: 30 },
      { header: ctx.col === 'CurrentStatus' ? 'Sales Team Remark (current — read only)' : 'Sales Team Remark', key: 'CurrentStatus', width: 34 },
      { header: ctx.col === 'ActionItem'    ? 'FAE Team remark (current — read only)'   : 'FAE Team remark',   key: 'ActionItem',    width: 34 },
      { header: 'Remarks',              key: 'Remarks',           width: 24 },
      { header: ctx.addHdr,             key: 'AddRemark',         width: 40 },
    ];
    rs.recordset.forEach(row => ws.addRow({ ...row, AddRemark: '' }));
    // Besides the "Add …Remark" column, the current user may also OVERWRITE their workflow
    // fields via this round-trip (FAE → Project Status / Samples stage / PP date FAE; Sales →
    // MP date Sales). Product/admin (overwriteFieldsFor => null) use the full "Import Excel"
    // path instead, so they get no extra unlocked columns here. Unlock those cells (green
    // border) so /import-remarks can read them back; blanks left there are ignored on import.
    const owFields = overwriteFieldsFor(req.user) || [];
    const owColNums = owFields.map(f => OW_ROUNDTRIP[f]).filter(Boolean)
      .map(o => ws.getColumn(o.dbCol).number);

    // Lock everything, then UNLOCK only the "Add …Remark" data cells (the LAST column) plus
    // the editable workflow columns for this user.
    const ADD_COL = ws.columns.length;
    ws.eachRow((row) => row.eachCell({ includeEmpty: true }, (c) => { c.protection = { locked: true }; }));
    for (let rn = 2; rn <= rs.recordset.length + 1; rn++) {
      ws.getCell(rn, ADD_COL).protection = { locked: false };
      ws.getCell(rn, ADD_COL).border = { outline: { style: 'thin', color: { argb: 'FF4F8EF7' } } };
      for (const cn of owColNums) {
        ws.getCell(rn, cn).protection = { locked: false };
        ws.getCell(rn, cn).border = { outline: { style: 'thin', color: { argb: 'FF22A06B' } } };  // green = editable field
      }
    }
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3FB' } };
    // Tint the editable workflow-column headers green so the user sees which columns to fill.
    owColNums.forEach(cn => { ws.getCell(1, cn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F6EE' } }; });
    ws.getColumn(1).hidden = true;                                    // DcId is the match key — keep but hide
    // Wrap the long remark columns (Product / Sales / FAE / Remarks / Add).
    [29, 30, 31, 32, ADD_COL].forEach(ci => { ws.getColumn(ci).alignment = { wrapText: true, vertical: 'top' }; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    // Protect the sheet so ONLY the unlocked "Add …Remark" cells can be edited.
    ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatCells: false, insertRows: false, deleteRows: false });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="COMPANYA_DC_EditRemarks_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return res.end(Buffer.from(buf));
  } catch (err) {
    console.error('[GET /api/product/dc/export-remarks] failed:', err.message);
    return res.status(500).json({ message: 'Remark template export failed', detail: err.message });
  }
});

// ── POST /import-remarks — apply the filled "Add …Remark" column ──────────────
// Matches each row by DcId, verifies it's in the user's scope, and APPENDS the stamped
// entry to their remark column only. Blank cells skipped; other columns ignored; never
// inserts. Works for Sales/FAE (their one column) and Product/admin (Sales column).
router.post('/import-remarks', authenticate, canView, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const pool = await getAppPool();
    const ctx = remarkCtxFor(req.user);
    const scope = await resolveDcScope(req.user, pool);
    const who = (req.user.name || req.user.username || '').trim().split(/\s+/)[0] || 'User';

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames.find(n => /edit remarks/i.test(n)) || wb.SheetNames[0]];
    if (!sheet) return res.status(400).json({ message: 'No sheet found in workbook' });
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
    const keys = Object.keys(rows[0] || {});
    const idKey  = keys.find(k => k.trim().toLowerCase() === 'dcid');
    // Require the CURRENT user's own column exactly — never fall back to the other role's
    // "Add …Remark" (that would read e.g. Sales text but write it into the FAE column).
    const addKey = keys.find(k => k.trim().toLowerCase() === ctx.addHdr.toLowerCase());
    if (!idKey || !addKey) return res.status(400).json({ message: `This isn't your DC "edit remarks" template — it needs a DcId column and an "${ctx.addHdr}" column. Use your own "Export for editing" button.` });

    // Workflow fields this user may ALSO overwrite via the round-trip (FAE: Project Status /
    // Samples stage / PP date; Sales: MP date). Match each to its sheet column by the exact
    // header used on export (case-insensitive). Product/admin get none (they use Import Excel).
    const owFields = overwriteFieldsFor(req.user) || [];
    const owCols = owFields.map(f => ({ field: f, ...OW_ROUNDTRIP[f] })).filter(o => o.dbCol)
      .map(o => ({ ...o, key: keys.find(k => k.trim().toLowerCase() === o.header.toLowerCase()) }))
      .filter(o => o.key);

    const parsed = rows.map(row => {
      const id = parseInt(row[idKey], 10);
      const text = String(row[addKey] || '').trim();
      const ow = [];
      for (const o of owCols) {
        const raw = row[o.key];
        if (raw === '' || raw === null || raw === undefined) continue;   // blank => leave that field unchanged
        ow.push({ ...o, raw });
      }
      return { id, text, ow };
    }).filter(u => Number.isFinite(u.id) && (u.text || u.ow.length));
    if (!parsed.length) return res.json({ ok: true, updated: 0, skipped: 0, outOfScope: 0, fieldUpdates: 0, message: 'Nothing to update (no remark text and no field changes in the sheet).' });

    let updated = 0, skipped = 0, outOfScope = 0, fieldUpdates = 0;
    for (const u of parsed) {
      // Fetch scope columns + the current workflow values (as dd-mm-yyyy for dates) so we only
      // write fields that actually changed.
      const cur = await pool.request().input('id', sql.Int, u.id).query(`
        SELECT SalesPerson, FaePerson, LineFae,
          ISNULL(ProjectStatus,'') ProjectStatus, ISNULL(SamplesStage,'') SamplesStage,
          CONVERT(VARCHAR(10),PpDateFae,105) PpDateFae, CONVERT(VARCHAR(10),MpDateSales,105) MpDateSales
        FROM [dbo].[BN_DCFile] WHERE DcId = @id AND IsActive = 1;`);
      if (!cur.recordset.length) { skipped++; continue; }
      if (!scope.all && !(await rowInScope(pool, scope, cur.recordset[0]))) { outOfScope++; continue; }
      const row0 = cur.recordset[0];

      // Build ONE atomic UPDATE = the append-remark (if any) + each changed workflow field.
      const setParts = [];
      const rq = pool.request().input('id', sql.Int, u.id).input('by', sql.Int, req.user.id);
      if (u.text) {
        // Prepend the new stamped entry to the current remark (newest on top) — concurrent
        // appends can't lose each other. ctx.col is hard-coded (CurrentStatus/ActionItem).
        rq.input('stamp', sql.NVarChar(sql.MAX), `[${stampDate()} · ${who}] ${u.text}`);
        setParts.push(`${ctx.col} = @stamp + CASE WHEN LEN(LTRIM(RTRIM(ISNULL(${ctx.col}, '')))) > 0
                                                  THEN CHAR(10) + ${ctx.col} ELSE '' END`);
      }
      let rowFields = 0;
      for (const o of u.ow) {
        const pname = 'ow_' + o.field;   // o.dbCol is hard-coded from OW_ROUNDTRIP (not user input)
        if (o.type === 'date') {
          const d = parseExcelDate(o.raw);
          if (!d) continue;                                   // unparseable date => skip
          if (ddmmyyyy(d) === (row0[o.dbCol] || '')) continue; // unchanged
          rq.input(pname, sql.Date, d);
        } else {
          const val = String(o.raw).trim().slice(0, o.len || 4000);
          if (val === String(row0[o.dbCol] || '').trim()) continue; // unchanged
          rq.input(pname, sql.NVarChar(o.len || sql.MAX), val);
        }
        setParts.push(`${o.dbCol} = @${pname}`);
        rowFields++;
      }
      if (!setParts.length) { skipped++; continue; }           // nothing new for this row
      setParts.push('UpdatedBy = @by', 'UpdatedAt = SYSDATETIME()');
      await rq.query(`UPDATE [dbo].[BN_DCFile] SET ${setParts.join(', ')} WHERE DcId = @id AND IsActive = 1;`);
      updated++;
      fieldUpdates += rowFields;
    }
    return res.json({ ok: true, updated, skipped, outOfScope, fieldUpdates, column: ctx.curHdr,
      fields: owCols.map(o => o.header) });
  } catch (err) {
    console.error('[POST /api/product/dc/import-remarks] failed:', err.message);
    return res.status(500).json({ message: 'Remark import failed', detail: err.message });
  }
});

// ── POST /chart-import — rebuild the brand->PM map (BN_DCLine) from the PM/FAE chart ──
// Head/admin only. Reads Sheet1 (Product line / PM / Vertical / Main products / FAE West/North)
// and fully refreshes BN_DCLine (transactional DELETE + INSERT — pure reference data).
// Lets the Product Head self-serve when new vendors are added or a line's PM changes.
router.post('/chart-import', authenticate, canDelete, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sn = wb.SheetNames.find(n => n.trim().toLowerCase() === 'sheet1') || wb.SheetNames[0];
    const objs = xlsx.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
    const keys = Object.keys(objs[0] || {});
    const find = (re) => keys.find(k => re.test(k.trim()));
    const lineK = find(/product\s*line|^line/i) || find(/line|brand/i);
    const pmK   = keys.find(k => k.trim().toLowerCase() === 'pm') || find(/\bpm\b/i);
    const vK = find(/vertical/i), mpK = find(/main\s*product/i), lfK = find(/line\s*fae/i);
    if (!lineK || !pmK) return res.status(400).json({ message: 'Sheet must have "Product line" and "PM" columns' });

    const cl = s => String(s == null ? '' : s).split(NBSP).join(' ').replace(/\s+/g, ' ').trim();
    const seen = new Set(), rows = [];
    for (const o of objs) {
      const line = cl(o[lineK]); if (!line) continue;
      const key = normBrand(line); if (!key || seen.has(key)) continue; seen.add(key);
      rows.push({ key, line, pm: cl(o[pmK]), v: cl(o[vK]), mp: cl(o[mpK]), lf: cl(o[lfK]) });
    }
    if (!rows.length) return res.status(400).json({ message: 'No brand rows found in the sheet' });

    const pool = await getAppPool();
    await pool.request().query(`IF OBJECT_ID('dbo.BN_DCLine','U') IS NULL CREATE TABLE dbo.BN_DCLine (LineKey NVARCHAR(120) NOT NULL PRIMARY KEY, ProductLine NVARCHAR(120) NULL, PM NVARCHAR(60) NULL, Vertical NVARCHAR(60) NULL, MainProducts NVARCHAR(200) NULL, FaeWest NVARCHAR(60) NULL, FaeNorth NVARCHAR(60) NULL, LineFae NVARCHAR(60) NULL);
      IF COL_LENGTH('dbo.BN_DCLine','LineFae') IS NULL ALTER TABLE dbo.BN_DCLine ADD LineFae NVARCHAR(60) NULL;`);
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx).query('DELETE FROM dbo.BN_DCLine;');
      for (const r of rows) {
        await new sql.Request(tx)
          .input('k', sql.NVarChar(120), r.key).input('l', sql.NVarChar(120), r.line)
          .input('pm', sql.NVarChar(60), r.pm).input('v', sql.NVarChar(60), r.v)
          .input('mp', sql.NVarChar(200), r.mp).input('lf', sql.NVarChar(60), r.lf)
          .query('INSERT INTO dbo.BN_DCLine (LineKey, ProductLine, PM, Vertical, MainProducts, LineFae) VALUES (@k,@l,@pm,@v,@mp,@lf);');
      }
      await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }

    const cnt = await pool.request().query("SELECT PM, COUNT(*) n FROM [dbo].[BN_DCLine] WHERE ISNULL(PM,'') <> '' GROUP BY PM ORDER BY n DESC");
    return res.json({ ok: true, sheetName: sn, brands: rows.length, byPm: cnt.recordset });
  } catch (err) {
    console.error('[POST /api/product/dc/chart-import] failed:', err.message);
    return res.status(500).json({ message: 'PM chart import failed', detail: err.message });
  }
});

// ── POST /resolve-pm — assign PM + Line FAE from the brand (Suggested Make) via BN_DCLine chart ──
// Head/admin only. Modes (?mode=): both PM and Line FAE are chart-driven per brand.
//   (default) blanks   — fill only rows whose PM / Line FAE is empty (never touches a set value).
//   overwrite          — snapshot current PM+LineFae to BN_DCFile_PMbak, then reassign EVERY mapped
//                        row from the chart (moves a brand to its new PM / Line FAE). Reversible.
//   revert             — restore PM + Line FAE from the last overwrite's snapshot.
router.post('/resolve-pm', authenticate, canDelete, async (req, res) => {
  try {
    const mode = String(req.query.mode || 'blanks').toLowerCase();
    const company = COMPANY(req.query.company);
    const pool = await getAppPool();
    // ensure the backup table (older deploys only had DcId+PM) also carries LineFae
    await pool.request().query(`IF OBJECT_ID('dbo.BN_DCFile_PMbak','U') IS NOT NULL AND COL_LENGTH('dbo.BN_DCFile_PMbak','LineFae') IS NULL ALTER TABLE dbo.BN_DCFile_PMbak ADD LineFae NVARCHAR(100) NULL;`);

    if (mode === 'revert') {
      const rv = await pool.request().query(`
        IF OBJECT_ID('dbo.BN_DCFile_PMbak','U') IS NULL
          SELECT 0 AS reverted;
        ELSE BEGIN
          UPDATE d SET d.PM = b.PM, d.LineFae = b.LineFae, d.UpdatedAt = SYSDATETIME()
          FROM [dbo].[BN_DCFile] d JOIN [dbo].[BN_DCFile_PMbak] b ON b.DcId = d.DcId
          WHERE d.IsActive = 1 AND (ISNULL(d.PM,'') <> ISNULL(b.PM,'') OR ISNULL(d.LineFae,'') <> ISNULL(b.LineFae,''));
          SELECT @@ROWCOUNT AS reverted;
        END`);
      return res.json({ ok: true, reverted: (rv.recordset[0] || {}).reverted || 0 });
    }

    const r = pool.request();
    let coClause = '';
    if (company) { coClause = ' AND d.Company = @co'; r.input('co', sql.NVarChar(10), company); }
    // normalized SuggestedMake -> BN_DCLine.LineKey join (matches normBrand / loadLineMap)
    const joinKey = "LOWER(REPLACE(REPLACE(REPLACE(ISNULL(d.SuggestedMake, ''), NCHAR(160), ''), ' ', ''), CHAR(9), ''))";

    if (mode === 'overwrite') {
      // Snapshot BEFORE overwriting so the whole reassign is one-click reversible.
      await pool.request().query(`
        IF OBJECT_ID('dbo.BN_DCFile_PMbak','U') IS NOT NULL DROP TABLE dbo.BN_DCFile_PMbak;
        SELECT DcId, PM, LineFae INTO dbo.BN_DCFile_PMbak FROM [dbo].[BN_DCFile] WHERE IsActive = 1;`);
      const result = await r.query(`
        UPDATE d SET d.PM      = COALESCE(NULLIF(LTRIM(RTRIM(l.PM)),''), d.PM),
                     d.LineFae = COALESCE(NULLIF(LTRIM(RTRIM(l.LineFae)),''), d.LineFae),
                     d.UpdatedAt = SYSDATETIME()
        FROM [dbo].[BN_DCFile] d
        JOIN [dbo].[BN_DCLine] l ON l.LineKey = ${joinKey}
        WHERE d.IsActive = 1
          AND ISNULL(d.SuggestedMake, '') <> ''
          AND (ISNULL(l.PM,'') <> '' OR ISNULL(l.LineFae,'') <> '')
          AND (ISNULL(d.PM,'') <> ISNULL(NULLIF(LTRIM(RTRIM(l.PM)),''), ISNULL(d.PM,''))
            OR ISNULL(d.LineFae,'') <> ISNULL(NULLIF(LTRIM(RTRIM(l.LineFae)),''), ISNULL(d.LineFae,'')))${coClause};`);
      return res.json({ ok: true, mode: 'overwrite', backedUp: true, updated: result.rowsAffected[0] || 0 });
    }

    // default: blanks-only (never overwrites a set value) — fill blank PM and/or blank Line FAE
    const result = await r.query(`
      UPDATE d SET
        d.PM      = CASE WHEN (d.PM IS NULL OR LTRIM(RTRIM(d.PM))='') AND ISNULL(l.PM,'')<>''      THEN l.PM      ELSE d.PM      END,
        d.LineFae = CASE WHEN (d.LineFae IS NULL OR LTRIM(RTRIM(d.LineFae))='') AND ISNULL(l.LineFae,'')<>'' THEN l.LineFae ELSE d.LineFae END,
        d.UpdatedAt = SYSDATETIME()
      FROM [dbo].[BN_DCFile] d
      JOIN [dbo].[BN_DCLine] l ON l.LineKey = ${joinKey}
      WHERE d.IsActive = 1 AND ISNULL(d.SuggestedMake, '') <> ''
        AND ( ((d.PM IS NULL OR LTRIM(RTRIM(d.PM))='') AND ISNULL(l.PM,'')<>'')
           OR ((d.LineFae IS NULL OR LTRIM(RTRIM(d.LineFae))='') AND ISNULL(l.LineFae,'')<>'') )${coClause};`);
    return res.json({ ok: true, mode: 'blanks', updated: result.rowsAffected[0] || 0 });
  } catch (err) {
    console.error('[POST /api/product/dc/resolve-pm] failed:', err.message);
    return res.status(500).json({ message: 'Resolve PM/Line FAE failed', detail: err.message });
  }
});

module.exports = router;
