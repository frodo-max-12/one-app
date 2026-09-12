const jwt = require('jsonwebtoken');
const { sql, getAppPool } = require('./db');
require('dotenv').config();

// ─── ROLE BUCKETS ─────────────────────────────────────────────────────────────

// Full access — see ALL data, no salesperson filtering (same as admin)
const FULL_ACCESS_ROLES = [
  'admin',
  'operation head',
  'director',
];

// Head access — see own + team codes (salesperson filter applied via CompanyACode/CompanyBCode)
const HEAD_ROLES = [
  'sales head',
  'north sales head',
];

// Restricted access — see own codes only
const SALES_ROLES = [
  'sales',
  'international sales',
  'north sales',
  'south sales',
];

// HR roles — own only for sales-style routes, but full visibility for Lens (HR + Geo) +
// future HRMS routes. HR users have no CompanyACode/CompanyBCode by design — they are admin-of-people, not sales staff.
const HR_ROLES = [
  'hr',
  'hr head',
];

// Lens admin (geo/HRMS visibility) — admins, ops/directors, and HR. Used in
// Lens routes that need to scan ALL employees regardless of sales hierarchy.
const LENS_ADMIN_ROLES = [
  ...FULL_ACCESS_ROLES,
  ...HR_ROLES,
];

/**
 * Returns true if user should see ALL data (no salesperson filtering).
 * Use this in every route instead of:  req.user.role === 'admin'
 *
 *   const { isFullAccess } = require('../auth');
 *   const isAdmin = isFullAccess(req.user);
 */
const isFullAccess = (user) => {
  const role = (user?.role || '').toLowerCase().trim();
  return FULL_ACCESS_ROLES.includes(role);
};

/**
 * Returns true if user is a head-level role (sees own + team codes).
 * Use instead of:  req.user.role === 'sales head'
 */
const isSalesHead = (user) => {
  const role = (user?.role || '').toLowerCase().trim();
  return HEAD_ROLES.includes(role);
};

/**
 * Returns true if user is a regular sales role (sees own codes only).
 */
const isSales = (user) => {
  const role = (user?.role || '').toLowerCase().trim();
  return SALES_ROLES.includes(role);
};

/**
 * Returns true if user is an HR role.
 */
const isHR = (user) => {
  const role = (user?.role || '').toLowerCase().trim();
  return HR_ROLES.includes(role);
};

/**
 * Returns true if user can see ALL employees' geo / attendance data
 * (admin family + HR). Use this in Lens routes instead of isFullAccess so
 * HR users get the visibility they need WITHOUT inheriting Sales financial access.
 */
const isLensAdmin = (user) => {
  const role = (user?.role || '').toLowerCase().trim();
  return LENS_ADMIN_ROLES.includes(role);
};

// FAE (Field Application Engineer) roles. FAE staff are NAV Employees (no
// salesperson code); they get HRMS + Visit Plan only. 'fae head' supervises the
// FAE team — it can see all FAE members' visit plans + geo tracking.
const FAE_ROLES = ['fae', 'fae head'];
const isFae     = (user) => FAE_ROLES.includes((user?.role || '').toLowerCase().trim());
const isFaeHead = (user) => (user?.role || '').toLowerCase().trim() === 'fae head';

// Warehouse role — Singapore warehouse person at CompanyB. No salesperson code.
// One user, role='warehouse' → full CRUD on /api/warehouse/*. Admin family
// (isFullAccess) gets read-only oversight via the route handlers.
const WAREHOUSE_ROLES = ['warehouse'];
const isWarehouse = (user) => WAREHOUSE_ROLES.includes((user?.role || '').toLowerCase().trim());

// Store role — dedicated store user (retail store-audit scanner).
// No salesperson code. Sees ONLY Store → Retailer Store Auditing. Admin family
// + any head get oversight via the route handlers.
// Retailer auditors — the 4 field people (Raj, Ritesh, Sahil, Mayur).
// They see: Inward, Pickout, Store Audit.
// 'mis store' = a MIS/Sales-Support user (Budget vs Actual) who ALSO keeps Retailer
// Store-Auditing access from one login (Rupali). Listing it here makes isStore()
// true for her, so the store routes accept her exactly like 'store electrical'.
const STORE_ROLES = ['store electrical', 'mis store'];
const isStore = (user) => STORE_ROLES.includes((user?.role || '').toLowerCase().trim());
const RETAILER_AUDITOR_ROLES = ['retailer auditor'];
const isRetailerAuditor = (user) =>
  RETAILER_AUDITOR_ROLES.includes((user?.role || '').toLowerCase().trim());

// Retailer delivery — the delivery driver login. Sees: Shipment only.
const RETAILER_DELIVERY_ROLES = ['retailer delivery'];
const isRetailerDelivery = (user) =>
  RETAILER_DELIVERY_ROLES.includes((user?.role || '').toLowerCase().trim());

// Product department — DC (Design-Conversion) File module. Kept alongside the
// Retailer helpers so this merged auth.js is a superset (DC + Store both work).
const PRODUCT_ROLES = ['product head', 'product assistant'];
const isProduct     = (user) => PRODUCT_ROLES.includes((user?.role || '').toLowerCase().trim());
const isProductHead = (user) => (user?.role || '').toLowerCase().trim() === 'product head';

// MIS / Sales-Support roles — the Budget vs Actual evaluation (see-all + edit).
// No salesperson code. 'mis' = MIS Executive (Rajashree); 'mis store' = a MIS
// user who ALSO keeps Retailer Store-Auditing (Rupali — also in STORE_ROLES above).
// Matched by the WORD 'mis' so both variants resolve the same, and so budget.js +
// authenticate agree on who is MIS. Codeless — legitimate to have no companyaCode.
const MIS_ROLES = ['mis', 'mis store'];
const isMis = (user) => /\bmis\b/.test((user?.role || '').toLowerCase().trim());

// Anyone in the Retailer Auditing world (auditor OR store OR delivery OR admin).
const isRetailerAny = (user) =>
  isRetailerAuditor(user) || isStore(user) || isRetailerDelivery(user) ||
  isFullAccess(user) || isAnyHead(user);

// True for ANY *head* variant whose team is identified by salesperson codes —
// "sales head", "north sales head", "Sales Head Electrical", "Electrical Head",
// etc. Excludes 'fae head' (different team semantics — identified by role
// membership, not by codes). Use this in team-visibility logic instead of
// the narrow isSalesHead, which only matches HEAD_ROLES literally and silently
// drops valid variants (see [[scope-by-attribute-not-role-string]]).
const isAnyHead = (user) => {
  const role = (user?.role || '').toLowerCase().trim();
  if (!role || role === 'fae head') return false;
  if (!/\bhead\b/.test(role)) return false;
  const codes = ((user.companyaCode || '') + '/' + (user.companybCode || ''))
    .split('/').map(s => s.trim()).filter(Boolean);
  return codes.length > 0;
};

// ─── LOGIN ────────────────────────────────────────────────────────────────────
const login = async (req, res) => {
  const { username, password, rememberMe } = req.body;

  try {
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const pool = await getAppPool();

    const result = await pool.request()
      .input('username', sql.NVarChar, username)
      .input('password', sql.NVarChar, password)
      .query(`
        SELECT TOP 1
            Id,
            Username,
            Role,
            Name,
            CompanyACode,
            CompanyBCode,
            Email
        FROM [dbo].[User_Login]
        WHERE Username = @username
          AND Password = @password
          AND IsActive = 1
      `);

    if (result.recordset.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const user = result.recordset[0];

    // Normalise role to lowercase so all route checks are consistent
    const role = (user.Role || '').toLowerCase().trim();

    const expiresIn = rememberMe
      ? (process.env.JWT_REMEMBER_EXPIRES_IN || '30d')
      : (process.env.JWT_EXPIRES_IN          || '8h');

    const token = jwt.sign(
      {
        id:          user.Id,
        username:    user.Username,
        role:        role,
        name:        user.Name        || user.Username,
        companyaCode:     user.CompanyACode     || '',
        companybCode:  user.CompanyBCode  || '',
        email:       user.Email       || ''
      },
      process.env.JWT_SECRET,
      { expiresIn }
    );

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id:         user.Id,
        username:   user.Username,
        name:       user.Name || user.Username,
        role:       role,
        companyaCode:    user.CompanyACode    || '',
        companybCode: user.CompanyBCode || '',
        email:      user.Email      || ''
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ message: 'Internal server error', detail: err.message });
  }
};

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization || '';

  if (!authHeader) {
    return res.status(401).json({ message: 'Token missing' });
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Token-format sanity check: every active session must either have a companyaCode
    // (sales-hierarchy users) OR be a privileged role (admin/director/HR) that
    // legitimately has no companyaCode. Anything else is a stale/malformed token.
if (decoded.companyaCode === undefined && !isFullAccess(decoded) && !isHR(decoded) && !isFae(decoded) && !isWarehouse(decoded) && !isStore(decoded) && !isRetailerAuditor(decoded) && !isRetailerDelivery(decoded) && !isProduct(decoded) && !isMis(decoded)) {
      return res.status(401).json({ message: 'Session expired — please log in again' });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

module.exports = {
  login,
  authenticate,
  isFullAccess,
  isSalesHead,
  isSales,
  isHR,
  isLensAdmin,
  isFae,
  isFaeHead,
  isAnyHead,
  isWarehouse,
  isStore,
  isRetailerAuditor,
  isRetailerDelivery,
  isRetailerAny,
  isProduct,
  isProductHead,
  isMis,
  MIS_ROLES,
  PRODUCT_ROLES,
  FULL_ACCESS_ROLES,
  HEAD_ROLES,
  SALES_ROLES,
  HR_ROLES,
  LENS_ADMIN_ROLES,
  FAE_ROLES,
  WAREHOUSE_ROLES,
  STORE_ROLES,
  RETAILER_AUDITOR_ROLES,
  RETAILER_DELIVERY_ROLES,
};