// =====================================================================
// modules/sales/routes/creditMemos.js — posted Sales Credit Memo PDF
//
//   GET /api/sales/credit-memos/:memoNo/pdf?company=COMPANYA|COMPANYB
//     → streams application/pdf (Sales - Credit Memo, NAV Report 207 layout)
//
// Read-only against NAV: Sales Cr_Memo Header + Line + Customer +
// Salesperson_Purchaser + Detailed GST Ledger Entry. Writes nothing.
// =====================================================================

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../../../auth');
const { getCompany }   = require('../../../shared/company');
const { fetchCreditMemoData, streamCreditMemoPdf } = require('../../../services/creditMemoPdf');

router.get('/:memoNo/pdf', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const memoNo  = req.params.memoNo;

    const data = await fetchCreditMemoData(company, memoNo);
    if (!data) {
      return res.status(404).json({ message: 'Credit memo not found' });
    }

    const safeName = memoNo.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="CreditMemo_${safeName}.pdf"`);
    res.setHeader('Cache-Control',       'private, max-age=0, must-revalidate');

    streamCreditMemoPdf(data, res);
  } catch (err) {
    console.error('Credit Memo PDF error:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Failed to generate credit memo PDF', error: err.message });
    } else {
      res.end();
    }
  }
});

module.exports = router;
