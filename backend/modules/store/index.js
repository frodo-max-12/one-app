/* ============================================================================
   backend/modules/store/index.js
   Store Electrical module router.

   Mounted in server.js with:
       app.use('/api/store', require('./modules/store'));
   ============================================================================ */

const express = require('express');
const path = require('path');
const router = express.Router();

/* Sub-routes. */
router.use('/scan', require('./routes/scan'));      // Inward / Outward / Total Audit (existing)
router.use('/retailer', require('./routes/retailer'));    // Retailer Auditing expansion (Pickout / Shipment / etc.)

module.exports = router;

/* ----------------------------------------------------------------------------
   IMPORTANT — serving the carton + delivery photos
   ----------------------------------------------------------------------------
   Scan/pickout/shipment photos are saved to the project's  uploads/store/  folder,
   and the database stores the path (e.g. "uploads/store/scan_123.jpg"). For the
   browser to display them, that folder MUST be served as static files at /uploads.

   If your app does NOT already serve the uploads folder, add this ONE line to
   server.js (near your other express.static lines):

       app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
   ---------------------------------------------------------------------------- */
