/* ============================================================================
   backend/modules/product/index.js
   Product department module router.

   Mounted in server.js with:
       app.use('/api/product', require('./modules/product'));

   Sub-routes:
       /dc   — DC (Design-Conversion) file: the Product team's authorized-line
               inquiry tracker (replaces their Excel). CRUD + Excel import/export.
   ============================================================================ */

const express = require('express');
const router = express.Router();

router.use('/dc', require('./routes/dc'));

module.exports = router;
