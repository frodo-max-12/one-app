// =====================================================================
// modules/sales — Sales department routes
//
// All Sales routes mount under /api/sales/*
// Each route is parameterized for COMPANYA + CompanyB via getCompany(req).
//
// Routes:
//   GET  /api/sales/dashboard              — Sales Dashboard (collapsed)
//   GET  /api/sales/outstanding            — Outstanding/AR (collapsed)
//   GET  /api/sales/customers              — Customer list (collapsed)
//   GET  /api/sales/customers/:id          — Customer detail + ledger (collapsed)
//   GET  /api/sales/billing                — Billing report (collapsed)
//   GET  /api/sales/inventory              — Inventory (collapsed)
//   GET  /api/sales/sobacklog              — SO Backlog (collapsed)
//   GET  /api/sales/visitplan              — Visit Plan (COMPANYA only currently)
//   GET  /api/sales/reminders/log          — Reminder log
//   POST /api/sales/reminders/send-manual  — Manual reminder send
//   POST /api/sales/reminders/run-now      — Trigger cron now
//   GET  /api/sales/reminders/run-status   — Check cron status
//   GET  /api/sales/reminders/templates    — List templates
//   PUT  /api/sales/reminders/templates/:stage — Edit template
//   GET  /api/sales/invoices/:invoiceNo/pdf — Download Tax Invoice PDF
//   GET  /api/sales/credit-memos/:memoNo/pdf — Download Sales Credit Memo PDF
//   GET  /api/sales/payments/:docNo/pdf      — Download Payment Advice PDF (v1.8)
// =====================================================================

const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { isMis } = require('../../auth');

// MIS roles ('mis' = Rajashree, 'mis store' = Rupali) get ONLY Budget vs Actual
// AND Visit Plan (view-only — to evaluate salesperson/FAE visit completion for
// valuation + expense approval) from the Sales department. The sidebar already
// hides the other Sales pages, but their /api/sales/* endpoints don't scope to a
// codeless MIS user (they'd leak all billing/outstanding/customers). This guard
// closes the direct-API / direct-URL path: /budget and /visitplan are allowed;
// every other Sales route is 403 for MIS. Non-MIS tokens (and missing/expired
// tokens) fall through untouched so each subroute's own `authenticate` still
// handles them exactly as before. (Visit Plan MUTATIONS are separately blocked for
// MIS by `blockHR` in visitPlan.js, so MIS is read-only there.)
const misAllowed = (p) => p === '/budget' || p.startsWith('/budget/') ||
                          p === '/visitplan' || p.startsWith('/visitplan/');
// MIS Store (sc@ — 'mis store') ADDITIONALLY gets MOM + Action Points (read-only)
// so they can evaluate whether salespeople / FAE actually did their visits. Plain
// 'mis' (Rajashree) stays limited to Budget vs Actual + Visit Plan.
const momEval = (u, p) => u.role === 'mis store' &&
  (p === '/mom' || p.startsWith('/mom/') || p === '/action-points' || p.startsWith('/action-points/'));
router.use((req, res, next) => {
  if (misAllowed(req.path)) return next();
  const auth = req.headers.authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (tok) {
    try {
      const u = jwt.verify(tok, process.env.JWT_SECRET);
      if (isMis(u)) {
        if (momEval(u, req.path)) return next();
        return res.status(403).json({ message: 'MIS access is limited to Budget vs Actual.' });
      }
    } catch (_) { /* bad/expired token — let the subroute's authenticate answer */ }
  }
  next();
});

router.use('/dashboard',     require('./routes/dashboard'));
router.use('/outstanding',   require('./routes/outstanding'));
router.use('/customers',     require('./routes/customers'));
router.use('/billing',       require('./routes/billing'));
router.use('/inventory',     require('./routes/inventory'));
router.use('/sobacklog',     require('./routes/soBacklog'));
router.use('/visitplan',     require('./routes/visitPlan'));
router.use('/reminders',     require('./routes/reminders'));
router.use('/invoices',      require('./routes/invoices'));
router.use('/credit-memos',  require('./routes/creditMemos'));
router.use('/payments',      require('./routes/payments'));      // v1.8 — Payment Advice PDF
router.use('/pdc',           require('./routes/pdc'));
router.use('/cn',            require('./routes/creditnotes'));  // v1.12 — Credit Notes "Yet to Approve" import + tab
router.use('/beatplan',      require('./routes/beatPlan'));      // v1.8 — Electrical weekly beat plan
router.use('/budget',        require('./routes/budget'));        // v1.11 — Sales Budget vs Actual
router.use('/mom',           require('./routes/mom'));           // v1.12 — MOM (SmartSys DB): view + create/edit
router.use('/action-points', require('./routes/actionPoints'));  // v1.12 — MOM Action Points tracker (SmartSys DB)

module.exports = router;
