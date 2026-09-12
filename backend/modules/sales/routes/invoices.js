// =====================================================================
// modules/sales/routes/invoices.js — posted Sales Invoice PDF download
//
//   GET /api/sales/invoices/:invoiceNo/pdf?company=COMPANYA|COMPANYB
//     → streams application/pdf  (Tax Invoice, branches per company)
//
// Read-only against NAV: Sales Invoice Header + Line + Customer +
// Salesperson_Purchaser + Detailed GST Ledger Entry + State.
// Writes nothing.
// =====================================================================

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../../../auth');
const { getCompany }   = require('../../../shared/company');
const { fetchInvoiceData, streamInvoicePdf } = require('../../../services/invoicePdf');

router.get('/:invoiceNo/pdf', authenticate, async (req, res) => {
  try {
    const company   = getCompany(req);
    const invoiceNo = req.params.invoiceNo;

    const data = await fetchInvoiceData(company, invoiceNo);
    if (!data) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    // Optional RBAC: sales/sales-head can only download invoices for their own customers.
    // Not enforced for v1 — most users browse Outstanding/Customers and the data they
    // already see there is the same data we'd return here. Add later if needed.

    const safeName = invoiceNo.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Invoice_${safeName}.pdf"`);
    res.setHeader('Cache-Control',       'private, max-age=0, must-revalidate');

    streamInvoicePdf(data, res);
  } catch (err) {
    console.error('Invoice PDF error:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Failed to generate invoice PDF', error: err.message });
    } else {
      res.end();
    }
  }
});

module.exports = router;
