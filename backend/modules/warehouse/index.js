// =====================================================================
// modules/warehouse — Warehouse module (Company B, Singapore)
//
// All routes mount under /api/warehouse/*. CompanyB-only — no COMPANYA.
//
// Auth model (enforced inside each route file):
//   • role='warehouse'  → full CRUD
//   • isFullAccess()    → admin / director / op-head → READ-only oversight
//   • everyone else     → 403
//
// Sub-modules (Excel-sheet mapping):
//   GET  /api/warehouse/                     — health/version
//   /cheques/*    — BN_WhCheque  (pure-manual cheque issue ledger)
//   /expenses/*   — BN_WhExpense (pure-manual petty expenses)
//   /purchase/*   — BN_WhPurchase JOINed to NAV [Purchase Header/Line] + Vendor
//   /stocks/*     — BN_WhStock (carton-level inventory)
//   /sales/*      — BN_WhSales JOINed to NAV [Sales Invoice Header/Line] + Customer
// =====================================================================

const router = require('express').Router();

router.use('/cheques',  require('./routes/cheques'));
router.use('/expenses', require('./routes/expenses'));
router.use('/purchase', require('./routes/purchase'));
router.use('/stocks',   require('./routes/stocks'));
router.use('/sales',    require('./routes/sales'));

// Health / version — useful for the frontend to detect module presence
router.get('/', (_req, res) => {
  res.json({
    module:   'warehouse',
    company:  'COMPANYB',
    location: 'Singapore',
    routes:   [
      'GET    /api/warehouse/cheques',
      'POST   /api/warehouse/cheques',
      'PUT    /api/warehouse/cheques/:id',
      'DELETE /api/warehouse/cheques/:id',
      'GET    /api/warehouse/expenses',
      'POST   /api/warehouse/expenses',
      'PUT    /api/warehouse/expenses/:id',
      'DELETE /api/warehouse/expenses/:id',
      'GET    /api/warehouse/purchase',
      'POST   /api/warehouse/purchase',
      'PUT    /api/warehouse/purchase/:id',
      'DELETE /api/warehouse/purchase/:id',
      'GET    /api/warehouse/stocks',
      'POST   /api/warehouse/stocks',
      'PUT    /api/warehouse/stocks/:id',
      'DELETE /api/warehouse/stocks/:id',
      'GET    /api/warehouse/sales',
      'POST   /api/warehouse/sales',
      'PUT    /api/warehouse/sales/:id',
      'DELETE /api/warehouse/sales/:id',
    ],
  });
});

module.exports = router;
