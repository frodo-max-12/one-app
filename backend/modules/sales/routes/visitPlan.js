// =====================================================================
// modules/sales/routes/visitPlan.js — Visit Plan (COMPANYA-only)
//
// Mounted under /api/sales/visitplan by modules/sales/index.js.
// Visit Plan is intentionally COMPANYA-only; no CompanyB variant.
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const multer  = require('multer');
const XLSX    = require('xlsx');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { authenticate, isFullAccess, isAnyHead, isHR, isMis } = require('../../../auth');
const { resolveGeofence: _resolveGeofence } = require('../../../shared/visitGeofence');

// Thin wrapper to preserve the previous v1.7 return shape (a bare GeofenceId).
// New code should call the shared `resolveGeofence` directly and use the
// { geofenceId, created } object.
async function resolveGeofence(pool, opts) {
  const r = await _resolveGeofence(pool, opts);
  return r.geofenceId;
}

// ── build salesperson IN() filter ────────────────────────────────────────────
function buildSpFilter(companyaCode, reqObj) {
  const codes = (companyaCode || '').split('/').map(c => c.trim()).filter(Boolean);
  if (codes.length === 0) return '';
  codes.forEach((c, i) => reqObj.input('sp' + i, sql.NVarChar, c));
  return ' AND SalespersonCode IN (' + codes.map((_, i) => '@sp' + i).join(',') + ')';
}

// ── visit-plan row scope by role (returns ' AND …', binds params on reqObj) ──
//   fae head → all FAE-team visits (any fae/fae-head username)
//   fae      → own visits only (SalespersonCode = own username)
//   anyone with CompanyACode codes assigned → filter to those codes. This single
//     rule covers sales, sales head, 'Sales Head Electrical', north sales head,
//     electrical head, etc. — any role that has a team-codes list.
//   admin / operation head / director / HR / MIS → no filter (see ALL), even if
//     they happen to have a CompanyACode assigned (e.g. the director Jain admin = EMP0003).
//     Relying on "admins have no code" was WRONG and hid every visit from them.
// FAE visits are stored with SalespersonCode = the FAE's username (they have no
// salesperson code), which is why FAE scoping keys on username.
function visitScopeAnd(user, reqObj) {
  const role = (user.role || '').toLowerCase().trim();
  // Full-access roles + HR + MIS see everything regardless of any CompanyACode.
  if (isFullAccess(user) || isHR(user) || isMis(user)) return '';
  if (role === 'fae head') {
    return " AND SalespersonCode IN (SELECT Username FROM dbo.User_Login WHERE LOWER(Role) IN ('fae','fae head'))";
  }
  if (role === 'fae') {
    reqObj.input('faeUser', sql.NVarChar, user.username || '');
    return ' AND SalespersonCode = @faeUser';
  }
  const codes = (user.companyaCode || '').split('/').map(c => c.trim()).filter(Boolean);
  if (codes.length > 0) return buildSpFilter(user.companyaCode, reqObj);
  return '';
}

// ── FAE flow? FAE / FAE head enter their name in the FAE field (no FSR); every
//    other role (sales, heads, admin) uses the FSR field. Drives which name is
//    mandatory on create / edit / import. ──
function isFaeFlow(role) {
  const r = (role || '').toLowerCase().trim();
  return r === 'fae' || r === 'fae head';
}

// ── HR + MIS are VIEW-ONLY on Visit Plan (check visits for evaluation / expense
//    approval; can't mutate). CRITICAL for MIS: they are codeless, so visitScopeAnd
//    returns '' (see-all) → the per-row ownership check on edit/delete would match
//    ANY row. This guard is what keeps MIS read-only. ──
function blockHR(req, res, next) {
  if (isHR(req.user) || isMis(req.user)) {
    return res.status(403).json({ message: 'HR / MIS have view-only access to Visit Plan' });
  }
  next();
}

// ── safe date parse ───────────────────────────────────────────────────────────
function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

// ── duplicate check: same CustomerName + VisitDate + Company + SalespersonCode ──
async function isDuplicate(pool, company, salespersonCode, customerName, visitDateStr) {
  const result = await pool.request()
    .input('company',         sql.NVarChar, company)
    .input('salespersonCode', sql.NVarChar, salespersonCode)
    .input('customerName',    sql.NVarChar, customerName.trim())
    .input('visitDate',       sql.VarChar,  visitDateStr)
    .query(`
      SELECT COUNT(*) AS Cnt
      FROM [dbo].[BN_VisitPlan]
      WHERE Company = @company
        AND BeatId IS NULL
        AND SalespersonCode = @salespersonCode
        AND LTRIM(RTRIM(CustomerName)) = LTRIM(RTRIM(@customerName)) COLLATE SQL_Latin1_General_CP1_CI_AS
        AND CONVERT(VARCHAR(10), VisitDate, 23) = @visitDate
    `);
  return (result.recordset[0]?.Cnt || 0) > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/sales/visitplan/dashboard
// ════════════════════════════════════════════════════════════════════════════
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const user       = req.user;
    const role       = (user.role || '').toLowerCase();
    const isFiltered = (role === 'sales' || role === 'sales head');
    const pool       = await getAppPool();

    // month param: YYYY-MM or empty (defaults to current month)
    const monthParam = req.query.month || '';
    let filterYear  = null;
    let filterMonth = null;
    if (monthParam && monthParam.includes('-')) {
      [filterYear, filterMonth] = monthParam.split('-').map(Number);
    }
    const monthAnd = filterYear && filterMonth
      ? ` AND YEAR(VisitDate) = ${filterYear} AND MONTH(VisitDate) = ${filterMonth}`
      : ` AND MONTH(VisitDate) = MONTH(GETDATE()) AND YEAR(VisitDate) = YEAR(GETDATE())`;

    const monthReq   = pool.request();
    const monthSpAnd = visitScopeAnd(user, monthReq);
    const monthRes   = await monthReq.query(`
      SELECT
        COUNT(*)                                        AS TotalPlanned,
        SUM(CASE WHEN VisitDone = 1 THEN 1 ELSE 0 END) AS VisitDone,
        SUM(CASE WHEN VisitDone = 0 THEN 1 ELSE 0 END) AS Pending
      FROM [dbo].[BN_VisitPlan]
      WHERE Company = 'COMPANYA' AND BeatId IS NULL
      ` + monthAnd + monthSpAnd
    );

    const chartReq   = pool.request();
    const chartSpAnd = visitScopeAnd(user, chartReq);
    const chartRes   = await chartReq.query(`
      SELECT
        YEAR(VisitDate)  AS Yr,
        MONTH(VisitDate) AS Mo,
        COUNT(*)                                        AS TotalPlanned,
        SUM(CASE WHEN VisitDone = 1 THEN 1 ELSE 0 END) AS VisitDone,
        SUM(CASE WHEN VisitDone = 0 THEN 1 ELSE 0 END) AS Pending
      FROM [dbo].[BN_VisitPlan]
      WHERE Company = 'COMPANYA' AND BeatId IS NULL
        AND VisitDate >= DATEADD(MONTH, -5, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
      ` + chartSpAnd + `
      GROUP BY YEAR(VisitDate), MONTH(VisitDate)
      ORDER BY Yr ASC, Mo ASC
    `);

    let bySp = [];
    // Show the by-salesperson breakdown to admin + any *head* role (sales head,
    // sales head electrical, north sales head, electrical head, …). Exclude
    // 'fae head' because FAE-team SalespersonCodes are usernames, not codes —
    // the breakdown wouldn't be meaningful for that view.
    const isAnyHead = /\bhead\b/.test(role) && role !== 'fae head';
    if (role === 'admin' || isAnyHead || isHR(user) || isMis(user)) {
      const spReq    = pool.request();
      const spAndStr = isAnyHead ? buildSpFilter(user.companyaCode, spReq) : '';
      const spRes    = await spReq.query(`
        SELECT
          SalespersonCode, SalespersonName,
          COUNT(*)                                        AS TotalPlanned,
          SUM(CASE WHEN VisitDone = 1 THEN 1 ELSE 0 END) AS VisitDone,
          SUM(CASE WHEN VisitDone = 0 THEN 1 ELSE 0 END) AS Pending
        FROM [dbo].[BN_VisitPlan]
        WHERE Company = 'COMPANYA' AND BeatId IS NULL
        ` + monthAnd + spAndStr + `
        GROUP BY SalespersonCode, SalespersonName
        ORDER BY TotalPlanned DESC
      `);
      bySp = spRes.recordset || [];
    }

    res.json({
      month: monthRes.recordset[0] || { TotalPlanned: 0, VisitDone: 0, Pending: 0 },
      chart: chartRes.recordset    || [],
      bySp
    });

  } catch (err) {
    console.error('VisitPlan dashboard error:', err.message);
    res.status(500).json({ message: 'Failed to load dashboard', error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/sales/visitplan  — list
// ════════════════════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res) => {
  try {
    const user       = req.user;
    const role       = (user.role || '').toLowerCase();
    const isFiltered = (role === 'sales' || role === 'sales head');
    const search     = (req.query.search || '').trim();
    const status     = req.query.status || 'all';
    const month      = req.query.month  || '';
    const date       = (req.query.date  || '').trim();  // NEW 2026-06-16: single-date filter
    const page       = parseInt(req.query.page  || '1',  10);
    const limit      = parseInt(req.query.limit || '15', 10);
    const offset     = (page - 1) * limit;
    const pool       = await getAppPool();

    let statusAnd = '';
    if (status === 'pending') statusAnd = ' AND VisitDone = 0';
    if (status === 'done')    statusAnd = ' AND VisitDone = 1';

    // Date filter takes priority over month — if both passed, single date wins
    let monthAnd = '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      monthAnd = ` AND CONVERT(VARCHAR(10), VisitDate, 23) = '${date}'`;
    } else if (month && month.includes('-')) {
      const [yr, mo] = month.split('-').map(Number);
      monthAnd = ` AND YEAR(VisitDate) = ${yr} AND MONTH(VisitDate) = ${mo}`;
    }

    // Person dropdown filter (admin/HR/heads pick a specific Sales/FAE person).
    // Exact match on SalespersonCode; still ANDed with the role scope below, so a
    // head can never pick someone outside their team.
    const spCode = (req.query.salespersonCode || '').trim();
    const spCodeAnd = spCode ? ' AND SalespersonCode = @spCode' : '';

    const searchVal = '%' + search + '%';

    // count
    const cntReq   = pool.request();
    cntReq.input('search', sql.NVarChar, searchVal);
    if (spCode) cntReq.input('spCode', sql.NVarChar, spCode);
    const cntSpAnd = visitScopeAnd(user, cntReq);
    const cntRes   = await cntReq.query(`
      SELECT COUNT(*) AS Total
      FROM [dbo].[BN_VisitPlan]
      WHERE Company = 'COMPANYA' AND BeatId IS NULL
      ` + cntSpAnd + statusAnd + monthAnd + spCodeAnd + `
      AND (
        @search = '%%'
        OR CustomerName             LIKE @search
        OR ISNULL(FSR,'')           LIKE @search
        OR ISNULL(FAE,'')           LIKE @search
        OR ISNULL(Location,'')      LIKE @search
        OR ISNULL(ContactPerson,'') LIKE @search
      )
    `);

    // data
    const dataReq   = pool.request();
    dataReq.input('search', sql.NVarChar, searchVal);
    dataReq.input('offset', sql.Int, offset);
    dataReq.input('limit',  sql.Int, limit);
    if (spCode) dataReq.input('spCode', sql.NVarChar, spCode);
    const dataSpAnd = visitScopeAnd(user, dataReq);
    const dataRes   = await dataReq.query(`
      SELECT
        Id, Week, FSR, FAE,
        SalespersonCode, SalespersonName,
        CONVERT(VARCHAR(10), VisitDate, 23) AS VisitDate,
        CustomerName, Application, CustomerType,
        VisitAgenda, Location, ContactPerson, ContactDetails,
        VisitDone, MOM, CreatedAt, Source, BeatId
      FROM [dbo].[BN_VisitPlan]
      WHERE Company = 'COMPANYA' AND BeatId IS NULL
      ` + dataSpAnd + statusAnd + monthAnd + spCodeAnd + `
      AND (
        @search = '%%'
        OR CustomerName             LIKE @search
        OR ISNULL(FSR,'')           LIKE @search
        OR ISNULL(FAE,'')           LIKE @search
        OR ISNULL(Location,'')      LIKE @search
        OR ISNULL(ContactPerson,'') LIKE @search
      )
      ORDER BY VisitDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    // People for the Sales/FAE dropdowns — built from the LOGIN list (not from visit
    // data), so a person shows even if they have 0 visits yet (important for HR
    // evaluation) and junk admin-import codes never appear. Sales dropdown → admin/HR/
    // sales-heads; FAE dropdown → admin/HR/FAE-head. A sales head is scoped to their team
    // (any shared CompanyACode). Dropdown value = the code visits actually use: first CompanyACode
    // for sales, username for FAE.
    let salesPeople = [], faePeople = [];
    const showSales = (role === 'admin' || isHR(user) || isAnyHead(user) || isMis(user));
    const showFae   = (role === 'admin' || isHR(user) || role === 'fae head' || isMis(user));
    if (showSales || showFae) {
      const ul = await pool.request().query('SELECT Username, Name, Role, CompanyACode FROM dbo.User_Login WHERE IsActive = 1');
      const SALES_ROLES = ['sales', 'international sales', 'north sales', 'south sales', 'sales head', 'north sales head', 'south sales head', 'sales head electrical', 'electrical head'];
      const myCodes = (user.companyaCode || '').split('/').map(c => c.trim()).filter(Boolean);
      const isTeamHead = isAnyHead(user) && role !== 'admin' && !isHR(user);   // sales-side head → scope to team
      for (const u of ul.recordset) {
        const r = (u.Role || '').toLowerCase().trim();
        const codes = (u.CompanyACode || '').split('/').map(c => c.trim()).filter(Boolean);
        if (r === 'fae' || r === 'fae head') {
          if (showFae && u.Username) faePeople.push({ code: u.Username, name: u.Name || u.Username });
        } else if (showSales && SALES_ROLES.includes(r) && codes.length) {
          if (isTeamHead && !codes.some(c => myCodes.includes(c))) continue;    // not on this head's team
          salesPeople.push({ code: codes[0], name: u.Name || codes[0] });
        }
      }
      const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
      salesPeople.sort(byName); faePeople.sort(byName);
    }

    res.json({
      total: cntRes.recordset[0]?.Total || 0,
      data:  dataRes.recordset || [],
      salesPeople, faePeople
    });

  } catch (err) {
    console.error('VisitPlan list error:', err.message);
    res.status(500).json({ message: 'Failed to load visit plan', error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/sales/visitplan/:id
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id', authenticate, async (req, res) => {
  try {
    const pool   = await getAppPool();
    // Scope by role (prevents IDOR — reading another rep/team's visit by iterating ids).
    const reqObj = pool.request().input('id', sql.Int, parseInt(req.params.id));
    const scope  = visitScopeAnd(req.user, reqObj);
    const result = await reqObj
      .query(`
        SELECT
          Id, Week, FSR, FAE,
          SalespersonCode, SalespersonName,
          CONVERT(VARCHAR(10), VisitDate, 23) AS VisitDate,
          CustomerName, Application, CustomerType,
          VisitAgenda, Location, ContactPerson, ContactDetails,
          VisitDone, MOM, CreatedAt, Source, BeatId
        FROM [dbo].[BN_VisitPlan]
        WHERE Id = @id AND Company = 'COMPANYA' ${scope}
      `);
    if (!result.recordset.length) return res.status(404).json({ message: 'Not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('VisitPlan get error:', err.message);
    res.status(500).json({ message: 'Failed to load record', error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/sales/visitplan  — CREATE
// ════════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, blockHR, async (req, res) => {
  try {
    const user = req.user;
    const role = (user.role || '').toLowerCase();
    const b    = req.body;

    if (!b.customerName || !String(b.customerName).trim())
      return res.status(400).json({ message: 'Customer Name is required' });
    if (!b.visitDate)
      return res.status(400).json({ message: 'Visit Date is required' });
    // Mandatory — Contact Person (so the head knows who the rep will meet).
    // Contact Details is OPTIONAL (2026-07-03, per user).
    if (!b.contactPerson || !String(b.contactPerson).trim())
      return res.status(400).json({ message: 'Contact Person is required — record who the salesperson will meet.' });
    // Mandatory — Visit Agenda (purpose of visit). (2026-07-06, per user.)
    if (!b.visitAgenda || !String(b.visitAgenda).trim())
      return res.status(400).json({ message: 'Visit Agenda is required — describe the purpose of the visit.' });
    // Mandatory — the rep's own name in the matching field. FAE flow (fae / fae head)
    // requires FAE; every other flow (sales, heads, admin) requires FSR. (2026-07-06.)
    if (isFaeFlow(role)) {
      if (!b.fae || !String(b.fae).trim())
        return res.status(400).json({ message: 'FAE name is required.' });
    } else {
      if (!b.fsr || !String(b.fsr).trim())
        return res.status(400).json({ message: 'FSR name is required.' });
    }

    // validate date format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.visitDate)) {
      return res.status(400).json({ message: 'Invalid Visit Date format. Received: ' + b.visitDate });
    }

    // handle old JWT tokens (no companyaCode field) and admin users
    const spCode = (role === 'admin')
      ? (b.salespersonCode || b.fsr || 'ADMIN')
      : (user.companyaCode ? user.companyaCode.split('/')[0] : (user.username || 'UNKNOWN'));

    const pool   = await getAppPool();

    // ── duplicate check ───────────────────────────────────────
    const dup = await isDuplicate(pool, 'COMPANYA', spCode, b.customerName.trim(), b.visitDate);
    if (dup) {
      return res.status(409).json({
        message: `Duplicate entry: "${b.customerName.trim()}" already has a visit planned on ${b.visitDate} for this salesperson.`
      });
    }

    // ── Geofence: reuse if one exists for this customer, else auto-create from
    // the Places-picked coordinates. Non-fatal — a null GeofenceId is fine.
    const visitLat = (b.visitLat != null && b.visitLat !== '') ? Number(b.visitLat) : null;
    const visitLng = (b.visitLng != null && b.visitLng !== '') ? Number(b.visitLng) : null;
    const custCode = (b.customerCode || '').trim() || null;
    const geofenceId = await resolveGeofence(pool, {
      customerCode: custCode,
      customerName: b.customerName.trim(),
      lat: visitLat, lng: visitLng,
      address: b.address, city: b.city, state: b.state, pincode: b.pincode,
      company: 'COMPANYA', userId: user.id,
    });

    const result = await pool.request()
      .input('company',         sql.NVarChar, 'COMPANYA')
      .input('week',            sql.NVarChar, b.week           || null)
      .input('fsr',             sql.NVarChar, b.fsr            || null)
      .input('fae',             sql.NVarChar, b.fae            || null)
      .input('salespersonCode', sql.NVarChar, spCode)
      .input('salespersonName', sql.NVarChar, user.name        || '')
      .input('visitDate',       sql.VarChar,  b.visitDate)  // pass as YYYY-MM-DD string, SQL Server converts
      .input('customerName',    sql.NVarChar, b.customerName.trim())
      .input('customerCode',    sql.NVarChar, custCode)
      .input('application',     sql.NVarChar, b.application    || null)
      .input('customerType',    sql.NVarChar, b.customerType   || null)
      .input('visitAgenda',     sql.NVarChar, b.visitAgenda    || null)
      .input('location',        sql.NVarChar, b.location       || null)
      .input('contactPerson',   sql.NVarChar, b.contactPerson  || null)
      .input('contactDetails',  sql.NVarChar, b.contactDetails || null)
      .input('visitDone',       sql.Bit,      b.visitDone ? 1 : 0)
      .input('mom',             sql.NVarChar, b.mom            || null)
      .input('visitLat',        sql.Decimal(9, 6), visitLat)
      .input('visitLng',        sql.Decimal(9, 6), visitLng)
      .input('placeId',         sql.NVarChar(300), (b.placeId || '').trim() || null)
      .input('geofenceId',      sql.Int,      geofenceId)
      .query(`
        INSERT INTO [dbo].[BN_VisitPlan]
          (Company, Week, FSR, FAE, SalespersonCode, SalespersonName,
           VisitDate, CustomerName, CustomerCode, Application, CustomerType,
           VisitAgenda, Location, ContactPerson, ContactDetails, VisitDone, MOM,
           VisitLat, VisitLng, PlaceId, GeofenceId)
        VALUES
          (@company, @week, @fsr, @fae, @salespersonCode, @salespersonName,
           @visitDate, @customerName, @customerCode, @application, @customerType,
           @visitAgenda, @location, @contactPerson, @contactDetails, @visitDone, @mom,
           @visitLat, @visitLng, @placeId, @geofenceId);
        SELECT SCOPE_IDENTITY() AS Id;
      `);

    res.json({ message: 'Visit plan created', id: result.recordset[0]?.Id, geofenceId });

  } catch (err) {
    console.error('VisitPlan create error:', err.message);
    res.status(500).json({ message: 'Failed to create record', error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PUT /api/sales/visitplan/:id  — UPDATE
// ════════════════════════════════════════════════════════════════════════════
router.put('/:id', authenticate, blockHR, async (req, res) => {
  try {
    const user = req.user;
    const role = (user.role || '').toLowerCase();
    const b    = req.body;
    const id   = parseInt(req.params.id);

    if (!b.customerName || !b.customerName.trim())
      return res.status(400).json({ message: 'Customer Name is required' });
    if (!b.visitDate)
      return res.status(400).json({ message: 'Visit Date is required' });
    // Mandatory — Contact Person only. Contact Details is OPTIONAL (2026-07-03, per user).
    if (!b.contactPerson || !String(b.contactPerson).trim())
      return res.status(400).json({ message: 'Contact Person is required — record who the salesperson will meet.' });
    // Mandatory — Visit Agenda + role-based FSR/FAE name (2026-07-06, per user).
    if (!b.visitAgenda || !String(b.visitAgenda).trim())
      return res.status(400).json({ message: 'Visit Agenda is required — describe the purpose of the visit.' });
    if (isFaeFlow(role)) {
      if (!b.fae || !String(b.fae).trim())
        return res.status(400).json({ message: 'FAE name is required.' });
    } else {
      if (!b.fsr || !String(b.fsr).trim())
        return res.status(400).json({ message: 'FSR name is required.' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.visitDate)) {
      return res.status(400).json({ message: 'Invalid Visit Date format. Received: ' + b.visitDate });
    }

    const pool = await getAppPool();

    // Ownership scope for EVERY non-admin role (was previously only role==='sales',
    // letting north/south/international/fae reps + heads edit any row by id).
    // visitScopeAnd returns '' for admin/no-code users, a code/username filter otherwise.
    const chk = pool.request().input('id', sql.Int, id);
    const scope = visitScopeAnd(user, chk);
    const found = await chk.query(`SELECT Id FROM [dbo].[BN_VisitPlan] WHERE Id = @id AND Company = 'COMPANYA' ${scope}`);
    if (!found.recordset.length) return res.status(404).json({ message: 'Not found (or outside your scope)' });

    await pool.request()
      .input('id',             sql.Int,      id)
      .input('week',           sql.NVarChar, b.week           || null)
      .input('fsr',            sql.NVarChar, b.fsr            || null)
      .input('fae',            sql.NVarChar, b.fae            || null)
      .input('visitDate',      sql.VarChar,  b.visitDate)
      .input('customerName',   sql.NVarChar, b.customerName.trim())
      .input('application',    sql.NVarChar, b.application    || null)
      .input('customerType',   sql.NVarChar, b.customerType   || null)
      .input('visitAgenda',    sql.NVarChar, b.visitAgenda    || null)
      .input('location',       sql.NVarChar, b.location       || null)
      .input('contactPerson',  sql.NVarChar, b.contactPerson  || null)
      .input('contactDetails', sql.NVarChar, b.contactDetails || null)
      .input('visitDone',      sql.Bit,      b.visitDone ? 1 : 0)
      .input('mom',            sql.NVarChar, b.mom            || null)
      .query(`
        UPDATE [dbo].[BN_VisitPlan] SET
          Week = @week, FSR = @fsr, FAE = @fae,
          VisitDate = @visitDate, CustomerName = @customerName,
          Application = @application, CustomerType = @customerType,
          VisitAgenda = @visitAgenda, Location = @location,
          ContactPerson = @contactPerson, ContactDetails = @contactDetails,
          VisitDone = @visitDone, MOM = @mom, UpdatedAt = GETDATE()
        WHERE Id = @id AND Company = 'COMPANYA'
      `);

    res.json({ message: 'Visit plan updated' });

  } catch (err) {
    console.error('VisitPlan update error:', err.message);
    res.status(500).json({ message: 'Failed to update record', error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/sales/visitplan/:id/mark-done — manual visit confirm
//
// Override for the geofence auto-detector when it misses a genuine visit
// (tracking gap, brief on-site stop, customer with no geofence yet, off-site
// meeting). Sets VisitDone=1 and stamps ManualConfirmedAt + the user who
// marked it for the audit trail.
//
// Scoping: sales can only mark visits whose SalespersonCode is in their
// codes list. Other roles (heads, admin, HR) can mark any visit they can see
// — the list itself is already scoped server-side.
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/mark-done', authenticate, blockHR, async (req, res) => {
  try {
    const user = req.user;
    const role = (user.role || '').toLowerCase();
    const id   = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });

    const pool = await getAppPool();

    // Ownership scope for EVERY non-admin role (was only role==='sales', letting other
    // reps/heads mark any visit done by id). Admin/no-code → all; rep/head → own/team.
    const chk = pool.request().input('id', sql.Int, id);
    const scope = visitScopeAnd(user, chk);
    const found = await chk.query(`SELECT Id FROM [dbo].[BN_VisitPlan] WHERE Id = @id AND Company = 'COMPANYA' ${scope}`);
    if (!found.recordset.length) return res.status(404).json({ message: 'Not found (or outside your scope)' });

    const mom = (req.body && typeof req.body.mom === 'string') ? req.body.mom.trim() : null;

    const r = await pool.request()
      .input('id',  sql.Int, id)
      .input('uid', sql.Int, user.id)
      .input('mom', sql.NVarChar(sql.MAX), mom)
      .query(`
        UPDATE [dbo].[BN_VisitPlan]
        SET VisitDone               = 1,
            ManualConfirmedAt       = SYSDATETIME(),
            ManualConfirmedByUserId = @uid,
            MOM                     = COALESCE(NULLIF(@mom, ''), MOM),
            UpdatedAt               = GETDATE()
        WHERE Id = @id AND Company = 'COMPANYA';
        SELECT @@ROWCOUNT AS Updated;
      `);

    const updated = (r.recordset[0] && r.recordset[0].Updated) || 0;
    if (!updated) return res.status(404).json({ message: 'Visit plan not found' });

    res.json({ ok: true, message: 'Visit marked done' });
  } catch (err) {
    console.error('VisitPlan mark-done error:', err.message);
    res.status(500).json({ message: 'Failed to mark visit done', error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/sales/visitplan/:id
// ════════════════════════════════════════════════════════════════════════════
router.delete('/:id', authenticate, blockHR, async (req, res) => {
  try {
    const user = req.user;
    const id   = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid id' });
    const pool = await getAppPool();

    // Ownership scope for EVERY non-admin role (was previously only enforced for
    // role==='sales', letting north/south/international/fae reps delete any row).
    // visitScopeAnd returns '' for admin/no-code users, a code filter otherwise.
    const chk = pool.request().input('id', sql.Int, id);
    const scope = visitScopeAnd(user, chk);
    const found = await chk.query(`
      SELECT Id, SalespersonCode, Source FROM [dbo].[BN_VisitPlan]
      WHERE Id = @id AND Company = 'COMPANYA' ${scope}`);
    if (!found.recordset.length) {
      return res.status(404).json({ message: 'Not found (or outside your scope)' });
    }

    // Beat-generated rows are template-owned: a plain rep deleting one would see
    // it resurrected on the next monthly generate and would drop their own
    // compliance count. Only admin / heads may remove them (or edit the Beat Plan).
    if (found.recordset[0].Source === 'beat' && !isFullAccess(user) && !isAnyHead(user)) {
      return res.status(403).json({ message: 'Beat-plan visits can only be removed by a head/admin. Edit the Beat Plan to drop the outlet instead.' });
    }

    await pool.request()
      .input('id', sql.Int, id)
      .query(`DELETE FROM [dbo].[BN_VisitPlan] WHERE Id = @id AND Company = 'COMPANYA'`);

    res.json({ message: 'Visit plan deleted' });

  } catch (err) {
    console.error('VisitPlan delete error:', err.message);
    res.status(500).json({ message: 'Failed to delete record', error: err.message });
  }
});


// ════════════════════════════════════════════════════════════════════════════
// POST /api/sales/visitplan/import  — BULK IMPORT from Excel
// ════════════════════════════════════════════════════════════════════════════
router.post('/import', authenticate, blockHR, upload.single('file'), async (req, res) => {
  try {
    const user = req.user;
    const role = (user.role || '').toLowerCase();

    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    // parse workbook from buffer
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

    if (!rows.length) return res.status(400).json({ message: 'Excel file is empty' });

    // ISO week helper
    function getISOWeek(date) {
      const d = new Date(date);
      if (isNaN(d.getTime())) return null;
      const jan4 = new Date(d.getFullYear(), 0, 4);
      const startW1 = new Date(jan4);
      startW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
      const weekNo = Math.floor((d - startW1) / (7 * 86400000)) + 1;
      return 'Week ' + String(weekNo).padStart(2, '0');
    }

    // column name map — flexible matching
    function getCol(row, names) {
      for (const n of names) {
        const key = Object.keys(row).find(k => k.trim().toLowerCase() === n.toLowerCase());
        if (key !== undefined) return row[key];
      }
      return null;
    }

    // Excel date → 'YYYY-MM-DD', timezone-proof. FIXES the "-1 day" import bug:
    // SheetJS anchors Excel dates near UTC midnight, but a serial-rounding quirk
    // lands the Date ~10 s BEFORE midnight (e.g. 2026-07-21 → 2026-07-20T18:29:50Z),
    // so reading it with local OR UTC getters drops it to the previous day. Fix:
    //   • numeric serial  → XLSX.SSF.parse_date_code (pure calendar, no timezone)
    //   • Date object     → SNAP to the nearest whole UTC day, then read UTC parts
    //   • text            → parse DD-MM-YYYY / DD/MM/YYYY / YYYY-MM-DD explicitly
    function excelDateToYMD(raw) {
      if (raw == null || raw === '') return null;
      const pad = n => String(n).padStart(2, '0');
      if (typeof raw === 'number') {
        const dc = XLSX.SSF.parse_date_code(raw);
        return (dc && dc.y) ? `${dc.y}-${pad(dc.m)}-${pad(dc.d)}` : null;
      }
      if (raw instanceof Date) {
        if (isNaN(raw.getTime())) return null;
        const s = new Date(Math.round(raw.getTime() / 86400000) * 86400000);   // snap to nearest UTC midnight
        return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
      }
      const str = String(raw).trim();
      let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
      m = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);                 // DD-MM-YYYY
      if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
      const d = new Date(str);
      if (isNaN(d.getTime())) return null;
      const s = new Date(Math.round(d.getTime() / 86400000) * 86400000);
      return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
    }

    const pool = await getAppPool();
    let inserted = 0, skipped = 0, errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        // parse date — timezone-proof (see excelDateToYMD; fixes the -1 day bug)
        const rawDate = getCol(r, ['Visit plan Date', 'VisitDate', 'Visit Date', 'Date']);
        const visitDateStr = excelDateToYMD(rawDate);

        const customerName = (getCol(r, ['Customer name', 'CustomerName', 'Customer Name']) || '').toString().trim();
        if (!customerName || !visitDateStr) { skipped++; continue; }

        // Mandatory — Contact Person, Visit Agenda, and a role-based FSR/FAE name.
        // Skip rows missing any, with a row-level error so the user can fix the
        // Excel and re-upload. Existing historical rows in the DB are not
        // retroactively validated (PUT route catches them on edit instead).
        // (Contact Person: 2026-06-04. Visit Agenda + FSR/FAE: 2026-07-06.)
        const contactPersonStr  = (getCol(r, ['Contact person','ContactPerson','Contact Person']) || '').toString().trim();
        const contactDetailsStr = (getCol(r, ['Contact details','ContactDetails','Contact Details']) || '').toString().trim();
        const visitAgendaStr    = (getCol(r, ['Customer visit agenda','VisitAgenda','Visit Agenda']) || '').toString().trim();
        const fsrStr            = (getCol(r, ['FSR','Fsr']) || '').toString().trim();
        const faeStr            = (getCol(r, ['FAE','Fae']) || '').toString().trim();
        if (!contactPersonStr) {
          skipped++;
          errors.push({ row: i + 2, error: `"${customerName}": Contact Person is required` });
          continue;
        }
        if (!visitAgendaStr) {
          skipped++;
          errors.push({ row: i + 2, error: `"${customerName}": Visit Agenda is required` });
          continue;
        }
        if (isFaeFlow(role)) {
          if (!faeStr) {
            skipped++;
            errors.push({ row: i + 2, error: `"${customerName}": FAE name is required` });
            continue;
          }
        } else if (!fsrStr) {
          skipped++;
          errors.push({ row: i + 2, error: `"${customerName}": FSR name is required` });
          continue;
        }

        // auto week from date
        const week = getCol(r, ['WEEK','Week']) || getISOWeek(visitDateStr);

        // visit done — Yes/No/1/0
        const visitRaw = (getCol(r, ['Visit Y/N','VisitDone','Visit Done','Visited']) || '').toString().toLowerCase();
        const visitDone = (visitRaw === 'yes' || visitRaw === '1' || visitRaw === 'true') ? 1 : 0;

        // salesperson code from JWT (same as single insert)
        const spCode = (role === 'admin')
          ? (getCol(r, ['FSR']) || 'ADMIN')
          : (user.companyaCode ? user.companyaCode.split('/')[0] : (user.username || 'UNKNOWN'));

        // ── duplicate check ───────────────────────────────────
        const dup = await isDuplicate(pool, 'COMPANYA', spCode, customerName, visitDateStr);
        if (dup) {
          skipped++;
          errors.push({ row: i + 2, error: `Duplicate: "${customerName}" on ${visitDateStr} already exists` });
          continue;
        }

        await pool.request()
          .input('company',         sql.NVarChar, 'COMPANYA')
          .input('week',            sql.NVarChar, week           || null)
          .input('fsr',             sql.NVarChar, fsrStr || null)
          .input('fae',             sql.NVarChar, faeStr || null)
          .input('salespersonCode', sql.NVarChar, spCode)
          .input('salespersonName', sql.NVarChar, user.name || '')
          .input('visitDate',       sql.VarChar,  visitDateStr)
          .input('customerName',    sql.NVarChar, customerName)
          .input('application',     sql.NVarChar, (getCol(r, ['Application']) || '').toString().trim() || null)
          .input('customerType',    sql.NVarChar, (getCol(r, ['Customer Type','CustomerType']) || '').toString().trim() || null)
          .input('visitAgenda',     sql.NVarChar, visitAgendaStr || null)
          .input('location',        sql.NVarChar, (getCol(r, ['Location']) || '').toString().trim() || null)
          .input('contactPerson',   sql.NVarChar, contactPersonStr || null)
          .input('contactDetails',  sql.NVarChar, contactDetailsStr || null)
          .input('visitDone',       sql.Bit,      visitDone)
          .input('mom',             sql.NVarChar, (getCol(r, ['MOM', 'Remark', 'Remarks']) || '').toString().trim() || null)
          .query(`
            INSERT INTO [dbo].[BN_VisitPlan]
              (Company, Week, FSR, FAE, SalespersonCode, SalespersonName,
               VisitDate, CustomerName, Application, CustomerType,
               VisitAgenda, Location, ContactPerson, ContactDetails, VisitDone, MOM)
            VALUES
              (@company, @week, @fsr, @fae, @salespersonCode, @salespersonName,
               @visitDate, @customerName, @application, @customerType,
               @visitAgenda, @location, @contactPerson, @contactDetails, @visitDone, @mom)
          `);
        inserted++;
      } catch (rowErr) {
        errors.push({ row: i + 2, error: rowErr.message });
      }
    }

    res.json({
      message: `Import complete: ${inserted} inserted, ${skipped} skipped (${skipped > 0 ? "missing data or duplicate entries" : "none"})`,
      inserted, skipped, errors
    });

  } catch (err) {
    console.error('VisitPlan import error:', err.message);
    res.status(500).json({ message: 'Import failed', error: err.message });
  }
});

module.exports = router;
