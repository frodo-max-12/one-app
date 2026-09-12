// =====================================================================
// ONE App — main Express server entry point
// (formerly BizNAV — renamed 2026-05-04 to reflect organization-wide scope)
//
// Restructure status: ALL 6 PHASES COMPLETE ✓
//   ✓ Phase 1 — Backup
//   ✓ Phase 2 — Foundation (shared/, core/, empty module placeholders, SQL migration)
//   ✓ Phase 3 — Frontend reorganization (all sales pages under modules/sales/*)
//   ✓ Phase 4 — Collapse COMPANYA+CompanyB route duplicates (single file per route, getCompany(req))
//   ✓ Phase 5 — Branding refresh (ONE App name, logo, page titles)
//   ✓ Phase 6 — Cleanup (legacy backend/routes/* and flat frontend/*.html removed)
//
// Mounting strategy:
//   - /api/auth/login        → auth handler
//   - /api/<dept>/*          → modules/<dept>/index.js (sales live, others placeholders)
//   - /modules/<dept>/*.html → static module pages
//   - /                      → login (index.html)
//   - /select-company        → company picker
// =====================================================================

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { login } = require('./auth');
require('dotenv').config();

const app = express();

/* ── CORS ──────────────────────────────────────────────────────────────────── */
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || origin === 'null') return callback(null, true);
    if (
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.includes('example.com') ||
      /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin)
    ) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Company'],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Raised from default 100kb so HR selfie data URIs (~1.5 MB each) fit through.
app.use(express.json({ limit: '8mb' }));

/* ── No-cache for JS / CSS / HTML during transition ────────────────────────── */
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

/* ── Health ────────────────────────────────────────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    app:     'ONE App',
    time:    new Date(),
    navDb:   process.env.DB_NAME,
    appDb:   process.env.APP_DB_NAME,
    modules: {
      sales:    'live',
      csr:      'placeholder',
      hr:       'phase-1',
      purchase: 'placeholder',
      account:  'placeholder',
      store:    'placeholder',
      fae:      'placeholder',
      product:  'placeholder',
      workflow: 'placeholder',
      common:   'placeholder',
    },
  });
});

/* ── Auth ──────────────────────────────────────────────────────────────────── */
app.post('/api/auth/login', login);

/* ── Department-scoped API mounts ──────────────────────────────────────────── */
app.use('/api/sales',    require('./modules/sales'));
app.use('/api/csr',      require('./modules/csr'));
app.use('/api/hr',       require('./modules/hr'));
app.use('/api/purchase', require('./modules/purchase'));
app.use('/api/account',  require('./modules/account'));
app.use('/api/store',    require('./modules/store'));
app.use('/api/fae',      require('./modules/fae'));
app.use('/api/warehouse',require('./modules/warehouse'));
app.use('/api/product',  require('./modules/product'));
app.use('/api/workflow', require('./modules/workflow'));
app.use('/api/common',   require('./modules/common'));
app.use('/api/notifications', require('./modules/notifications'));

/* ── Static frontend ───────────────────────────────────────────────────────── */
const F = path.join(__dirname, '../frontend');
app.use(express.static(F));

/* ── Static uploads (HR selfies, etc.) ─────────────────────────────────────── */
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '1d',
  fallthrough: true,
}));

/* ── HTML page routes ──────────────────────────────────────────────────────── */
const page         = (file) => (req, res) => res.sendFile(path.join(F, file));
const moduleSales  = (file) => (req, res) => res.sendFile(path.join(F, 'modules', 'sales', file));

// Auth / shell
app.get('/',                     page('index.html'));
app.get('/index.html',           page('index.html'));
app.get('/select-company',       page('select-company.html'));
app.get('/select-company.html',  page('select-company.html'));

// HR pages (modules/hr/*.html) — ONE App Lens
const moduleHr = (file) => (req, res) => res.sendFile(path.join(F, 'modules', 'hr', file));
app.get('/modules/hr',                       moduleHr('home.html'));
app.get('/modules/hr/',                      moduleHr('home.html'));
app.get('/modules/hr/home',                  moduleHr('home.html'));
app.get('/modules/hr/home.html',             moduleHr('home.html'));
app.get('/modules/hr/attendance',            moduleHr('attendance.html'));
app.get('/modules/hr/attendance.html',       moduleHr('attendance.html'));
app.get('/modules/hr/journey',               moduleHr('journey.html'));
app.get('/modules/hr/journey.html',          moduleHr('journey.html'));
app.get('/modules/hr/geofence',              moduleHr('geofence.html'));
app.get('/modules/hr/geofence.html',         moduleHr('geofence.html'));
app.get('/modules/hr/stops',                 moduleHr('stops.html'));
app.get('/modules/hr/stops.html',            moduleHr('stops.html'));
app.get('/modules/hr/plan-tracker',          moduleHr('plan-tracker.html'));
app.get('/modules/hr/plan-tracker.html',     moduleHr('plan-tracker.html'));
app.get('/modules/hr/visit-punch',           moduleHr('visit-punch.html'));
app.get('/modules/hr/visit-punch.html',      moduleHr('visit-punch.html'));
app.get('/modules/hr/office-presence',       moduleHr('office-presence.html'));
app.get('/modules/hr/office-presence.html',  moduleHr('office-presence.html'));
app.get('/modules/hr/anomalies',             moduleHr('anomalies.html'));
app.get('/modules/hr/anomalies.html',        moduleHr('anomalies.html'));
app.get('/modules/hr/leave-apply',           moduleHr('leave-apply.html'));
app.get('/modules/hr/leave-apply.html',      moduleHr('leave-apply.html'));
app.get('/modules/hr/leave-balance',         moduleHr('leave-balance.html'));
app.get('/modules/hr/leave-balance.html',    moduleHr('leave-balance.html'));
app.get('/modules/hr/leave-approvals',       moduleHr('leave-approvals.html'));
app.get('/modules/hr/leave-approvals.html',  moduleHr('leave-approvals.html'));
app.get('/modules/hr/regularization-apply',  moduleHr('regularization-apply.html'));
app.get('/modules/hr/regularization-apply.html',     moduleHr('regularization-apply.html'));
app.get('/modules/hr/regularization-approvals',      moduleHr('regularization-approvals.html'));
app.get('/modules/hr/regularization-approvals.html', moduleHr('regularization-approvals.html'));
app.get('/modules/hr/leave-granter',                 moduleHr('leave-granter.html'));
app.get('/modules/hr/leave-granter.html',            moduleHr('leave-granter.html'));
app.get('/modules/hr/employees',                     moduleHr('employees.html'));
app.get('/modules/hr/employees.html',                moduleHr('employees.html'));
app.get('/modules/hr/employee-add',                  moduleHr('employee-add.html'));
app.get('/modules/hr/employee-add.html',             moduleHr('employee-add.html'));
app.get('/modules/hr/employee-profile',              moduleHr('employee-profile.html'));
app.get('/modules/hr/employee-profile.html',         moduleHr('employee-profile.html'));
app.get('/modules/hr/user-admin',                    moduleHr('user-admin.html'));
app.get('/modules/hr/user-admin.html',               moduleHr('user-admin.html'));

// Sales pages (modules/sales/*.html)
app.get('/modules/sales/dashboard',          moduleSales('dashboard.html'));
app.get('/modules/sales/dashboard.html',     moduleSales('dashboard.html'));
app.get('/modules/sales/outstanding',        moduleSales('outstanding.html'));
app.get('/modules/sales/outstanding.html',   moduleSales('outstanding.html'));
app.get('/modules/sales/customers',          moduleSales('customers.html'));
app.get('/modules/sales/customers.html',     moduleSales('customers.html'));
app.get('/modules/sales/billing',            moduleSales('billing.html'));
app.get('/modules/sales/billing.html',       moduleSales('billing.html'));
app.get('/modules/sales/budget-actual',      moduleSales('budget-actual.html'));
app.get('/modules/sales/budget-actual.html', moduleSales('budget-actual.html'));
app.get('/modules/sales/inventory',          moduleSales('inventory.html'));
app.get('/modules/sales/inventory.html',     moduleSales('inventory.html'));
app.get('/modules/sales/soBacklog',          moduleSales('soBacklog.html'));
app.get('/modules/sales/soBacklog.html',     moduleSales('soBacklog.html'));
app.get('/modules/sales/visitPlan',          moduleSales('visitPlan.html'));
app.get('/modules/sales/visitPlan.html',     moduleSales('visitPlan.html'));
app.get('/modules/sales/reminders',          moduleSales('reminders.html'));
app.get('/modules/sales/reminders.html',     moduleSales('reminders.html'));

// Store pages (modules/store/*.html) — Retailer Auditing
const moduleStore = (file) => (req, res) => res.sendFile(path.join(F, 'modules', 'store', file));
app.get('/modules/store',           moduleStore('home.html'));
app.get('/modules/store/',          moduleStore('home.html'));
app.get('/modules/store/home',      moduleStore('home.html'));
app.get('/modules/store/home.html', moduleStore('home.html'));

// Warehouse pages (modules/warehouse/*.html) — Company B Singapore
const moduleWh = (file) => (req, res) => res.sendFile(path.join(F, 'modules', 'warehouse', file));
app.get('/modules/warehouse',           moduleWh('home.html'));
app.get('/modules/warehouse/',          moduleWh('home.html'));
app.get('/modules/warehouse/home',      moduleWh('home.html'));
app.get('/modules/warehouse/home.html', moduleWh('home.html'));
app.get('/modules/warehouse/purchase',       moduleWh('purchase.html'));
app.get('/modules/warehouse/purchase.html',  moduleWh('purchase.html'));
app.get('/modules/warehouse/stocks',         moduleWh('stocks.html'));
app.get('/modules/warehouse/stocks.html',    moduleWh('stocks.html'));
app.get('/modules/warehouse/sales',          moduleWh('sales.html'));
app.get('/modules/warehouse/sales.html',     moduleWh('sales.html'));
app.get('/modules/warehouse/soBacklog',      moduleWh('soBacklog.html'));
app.get('/modules/warehouse/soBacklog.html', moduleWh('soBacklog.html'));
app.get('/modules/warehouse/cheques',        moduleWh('cheques.html'));
app.get('/modules/warehouse/cheques.html',   moduleWh('cheques.html'));
app.get('/modules/warehouse/expenses',       moduleWh('expenses.html'));
app.get('/modules/warehouse/expenses.html',  moduleWh('expenses.html'));

// Product pages (modules/product/*.html) — DC (Design-Conversion) File tracker
const moduleProduct = (file) => (req, res) => res.sendFile(path.join(F, 'modules', 'product', file));
app.get('/modules/product',          moduleProduct('dc.html'));
app.get('/modules/product/',         moduleProduct('dc.html'));
app.get('/modules/product/dc',       moduleProduct('dc.html'));
app.get('/modules/product/dc.html',  moduleProduct('dc.html'));

/* ── Error handler ─────────────────────────────────────────────────────────── */
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ message: 'Internal server error', detail: err.message });
});

/* ── Start ─────────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 ONE App running');
  console.log(`   Port   : ${PORT}`);
  console.log(`   Local  : http://localhost:${PORT}`);
  console.log(`   NAV DB : ${process.env.DB_SERVER}/${process.env.DB_NAME}`);
  console.log(`   App DB : ${process.env.DB_SERVER}/${process.env.APP_DB_NAME}\n`);

  // Start the payment reminder cron scheduler
  try { require('./services/reminderCron').start(); }
  catch (e) { console.error('Reminder cron failed to start:', e.message); }

  // Start the notification generator (daily scan + NAV poll). Disabled unless
  // NOTIF_CRON_ENABLED=true; use POST /api/notifications/run-scan to test first.
  try { require('./services/notificationCron').start(); }
  catch (e) { console.error('Notification cron failed to start:', e.message); }

  // Start the PDC cheque-deposit reminder cron. Disabled unless
  // PDC_REMINDER_ENABLED=true; reuses the payment-reminder WhatsApp chain.
  try { require('./services/pdcReminderCron').start(); }
  catch (e) { console.error('PDC reminder cron failed to start:', e.message); }
});
