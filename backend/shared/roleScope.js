// =====================================================================
// shared/roleScope.js — role-based SQL scope clause builder
//
// Used by every route that needs salesperson/team/full filtering.
// Extracted from the original routes/reminders.js so all departments
// can share the same scoping logic.
//
// Usage:
//   const { buildScopeClause } = require('../../../shared/roleScope');
//   const { clause, params } = buildScopeClause(req, 'sp', 'SalespersonCode');
//   const r = pool.request();
//   Object.entries(params).forEach(([k, v]) => r.input(k, sql.NVarChar, v));
//   const result = await r.query(`SELECT ... WHERE 1=1 ${clause}`);
// =====================================================================

// NOTE: auth.js currently lives at backend/auth.js — will move to core/auth.js in Phase 3.
const { isFullAccess, isSalesHead } = require('../auth');

/**
 * Build a SQL scope clause for the current user.
 * @param {object} req           Express request (needs req.user populated by authenticate)
 * @param {string} paramPrefix   Parameter name prefix (default 'sp')
 * @param {string} columnName    Column to filter on (default 'SalespersonCode')
 * @returns {{clause:string, params:object}}
 */
function buildScopeClause(req, paramPrefix = 'sp', columnName = 'SalespersonCode') {
  const user = req.user;

  if (isFullAccess(user)) {
    return { clause: '', params: {} };
  }

  const codes = [
    ...((user.companyaCode    || '').split('/').map(s => s.trim()).filter(Boolean)),
    ...((user.companybCode || '').split('/').map(s => s.trim()).filter(Boolean)),
  ];

  if (!codes.length) {
    return { clause: ' AND 1=0 ', params: {} };
  }

  const params = {};
  const placeholders = codes.map((c, i) => {
    const key = `${paramPrefix}${i}`;
    params[key] = c;
    return `@${key}`;
  }).join(',');

  return {
    clause: ` AND ${columnName} IN (${placeholders}) `,
    params,
  };
}

/**
 * Returns user's salesperson codes for the active company (used when SQL needs a list).
 * @param {object} user   req.user
 * @param {string} company   'COMPANYA' | 'COMPANYB'
 */
function getUserCodes(user, company) {
  const col = (company || '').toUpperCase() === 'COMPANYB' ? 'companybCode' : 'companyaCode';
  return (user[col] || '').split('/').map(s => s.trim()).filter(Boolean);
}

module.exports = { buildScopeClause, getUserCodes };
