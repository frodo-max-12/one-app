// =====================================================================
// modules/purchase — Purchase department routes (PLACEHOLDER)
//
// Planned: 19 modules (PR, Vendor Master, RFQ, PO, GRN, Vendor Outstanding,
// Vendor Performance, Daily/Open PO Reports, Import Tracker, etc.)
// See BRD section 6.4 for full list.
// =====================================================================

const router = require('express').Router();

router.get('/', (req, res) => {
  res.json({ module: 'purchase', status: 'placeholder', message: 'Purchase module routes will be added here.' });
});

module.exports = router;
