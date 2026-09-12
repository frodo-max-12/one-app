// =====================================================================
// modules/account — Account department routes (PLACEHOLDER)
//
// Planned: 12 modules (Receivables/Payables Dashboard, Payment Voucher,
// Bank Reconciliation, Expense Approval Queue, Petty Cash, Salary Disbursement,
// TDS/GST Tracker, Cheque Register, Day Book, Aging Reports, Cash Flow Forecast)
// See BRD section 6.5 for full list.
// =====================================================================

const router = require('express').Router();

router.get('/', (req, res) => {
  res.json({ module: 'account', status: 'placeholder', message: 'Account module routes will be added here.' });
});

module.exports = router;
