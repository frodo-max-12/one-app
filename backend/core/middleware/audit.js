// =====================================================================
// core/middleware/audit.js — auto-fill audit columns
//
// Helper for write operations — adds CreatedBy / UpdatedBy / timestamps
// to any row payload before INSERT / UPDATE.
//
// Usage:
//   const { stampCreate, stampUpdate } = require('../core/middleware/audit');
//   const data = stampCreate(req, { Name: 'Foo', Status: 'Active' });
//   // data now includes CreatedBy, CreatedAt, UpdatedBy, UpdatedAt
// =====================================================================

function _userTag(req) {
  const u = (req && req.user) || {};
  return u.name || u.username || (u.id ? `user#${u.id}` : 'SYSTEM');
}

function stampCreate(req, payload = {}) {
  const now  = new Date();
  const user = _userTag(req);
  return {
    ...payload,
    CreatedBy: user,
    CreatedAt: now,
    UpdatedBy: user,
    UpdatedAt: now,
  };
}

function stampUpdate(req, payload = {}) {
  return {
    ...payload,
    UpdatedBy: _userTag(req),
    UpdatedAt: new Date(),
  };
}

module.exports = { stampCreate, stampUpdate };
