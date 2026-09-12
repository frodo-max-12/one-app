// =====================================================================
// modules/sales/routes/payments.js — on-demand Payment Advice PDF download
//
//   GET /api/sales/payments/:docNo/pdf?company=COMPANYA|COMPANYB
//     → streams application/pdf (acknowledgement of payment received,
//        with applied-invoice list + account summary)
//
// Read-only against NAV: Cust_ Ledger Entry + Detailed Cust_ Ledg_ Entry +
// Customer + Bank Account. Writes nothing.
//
// Mirrors modules/sales/routes/invoices.js — same Express shape, same
// error handling. No whitelist gate: anyone with JWT who can see the
// customer in the Ledger can download the Payment Advice for any row
// (same RBAC model the Tax Invoice download uses).
// =====================================================================

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../../../auth');
const { getCompany }   = require('../../../shared/company');
const { fetchPaymentAdviceData, streamPaymentAdvicePdf } = require('../../../services/paymentAdvicePdf');

router.get('/:docNo/pdf', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const docNo   = req.params.docNo;   // already URL-decoded by Express

    const data = await fetchPaymentAdviceData(company.code, docNo);
    if (!data) {
      return res.status(404).json({ message: 'Payment Advice not found for ' + docNo });
    }

    // Slashes in the NAV doc no (e.g. COMPANYA/2627/02346) aren't valid in download
    // filenames on Windows — normalise to hyphens for the suggested filename.
    const safeName = docNo.replace(/[^A-Za-z0-9._-]/g, '-');
    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="PaymentAdvice_${safeName}.pdf"`);
    res.setHeader('Cache-Control',       'private, max-age=0, must-revalidate');

    streamPaymentAdvicePdf(data, res);
  } catch (err) {
    console.error('Payment Advice PDF error:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Failed to generate Payment Advice PDF', error: err.message });
    } else {
      res.end();
    }
  }
});

module.exports = router;
