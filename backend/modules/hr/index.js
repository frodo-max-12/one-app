// =====================================================================
// modules/hr — ONE App Lens (HRMS + Geo Tracking)
//
// Full replacement for PagarBook Geo + GreytHR HRMS.
// All routes mount under /api/hr/*. Writes to BizNAV_App via getAppPool().
// NAV DB is never touched from this module per the read-only rule.
//
// Phase 0 routes (this file):
//   GET  /api/hr                 — health / version check
//   POST /api/hr/location/ping   — record one GPS ping
//   GET  /api/hr/location/latest — get latest ping for current user (debug helper)
//
// Planned phases — added one router.use() per phase:
//   Phase 1: /attendance, /employee, /holiday
//   Phase 2: /journey, /geofence, /visit
//   Phase 3: /leave, /regularization, /workflow
//   Phase 4: /engage, /dashboard, /reports, /helpdesk, /documents
//   Phase 5: /payroll, /payslip, /ytd, /statutory
// =====================================================================

const router = require('express').Router();

// Phase 0 + 1 + 2 sub-routes
router.use('/location',   require('./routes/location'));
router.use('/attendance', require('./routes/attendance'));
router.use('/holiday',    require('./routes/holiday'));
router.use('/whois',      require('./routes/whois'));
router.use('/journey',         require('./routes/journey'));
router.use('/geofence',        require('./routes/geofence'));
router.use('/visits',          require('./routes/visits'));
router.use('/visit-punch',     require('./routes/visitPunch'));   // v1.8 — Punch-In/Out
router.use('/plan-tracker',    require('./routes/planTracker'));
router.use('/office-presence', require('./routes/officePresence'));
router.use('/anomalies',       require('./routes/anomalies'));
router.use('/leave',           require('./routes/leave'));
router.use('/regularization',  require('./routes/regularization'));
router.use('/employees',       require('./routes/employee'));
router.use('/dashboard',       require('./routes/dashboard'));
router.use('/reports',         require('./routes/reports'));
router.use('/helpdesk',        require('./routes/helpdesk'));
router.use('/engage',          require('./routes/engage'));
router.use('/documents',       require('./routes/documents'));
router.use('/payroll-structure', require('./routes/payrollStructure'));
router.use('/payroll',         require('./routes/payroll'));
router.use('/it-declaration',  require('./routes/itDeclaration'));
router.use('/form16',          require('./routes/form16'));
router.use('/workflow',        require('./routes/workflow'));
router.use('/letters',         require('./routes/letters'));

// Health / version — useful from the mobile app to verify the HR module is up
router.get('/', (_req, res) => {
  res.json({
    module: 'hr',
    name: 'ONE App Lens',
    phase: 1,
    status: 'live',
    routes: [
      'POST /api/hr/location/ping',
      'POST /api/hr/location/batch',
      'GET  /api/hr/location/latest',
      'POST /api/hr/attendance/sign-in',
      'POST /api/hr/attendance/sign-out',
      'GET  /api/hr/attendance/today',
      'GET  /api/hr/attendance/summary',
      'GET  /api/hr/holiday',
      'GET  /api/hr/holiday/upcoming',
      'GET  /api/hr/whois/today',
      'GET  /api/hr/journey/day?userId=X&date=YYYY-MM-DD',
      'GET  /api/hr/journey/pickable-users',
      'GET  /api/hr/geofence',
      'POST /api/hr/geofence',
      'PUT  /api/hr/geofence/:id',
      'DEL  /api/hr/geofence/:id',
      'GET  /api/hr/geofence/customer-suggest?q=',
      'GET  /api/hr/visits',
      'GET  /api/hr/visits/unknown/list',
      'PUT  /api/hr/visits/:id/label',
      'POST /api/hr/visits/:id/promote',
      'GET  /api/hr/plan-tracker/day?userId=X&date=YYYY-MM-DD',
      'POST /api/hr/visit-punch/in',
      'POST /api/hr/visit-punch/out/:visitId',
      'GET  /api/hr/visit-punch/today?date=YYYY-MM-DD',
      'GET  /api/hr/visit-punch/open',
      'GET  /api/hr/visit-punch/planned?date=YYYY-MM-DD',
      'PUT  /api/hr/visit-punch/:visitId       — admin/HR correction',
      'DEL  /api/hr/visit-punch/:visitId       — admin/HR delete',
      'GET  /api/hr/office-presence',
      'GET  /api/hr/office-presence/employees',
      'POST /api/hr/office-presence/assign',
      'GET  /api/hr/anomalies',
      'PUT  /api/hr/anomalies/:id/resolve',
      'PUT  /api/hr/anomalies/:id/approve',
      'GET  /api/hr/leave/types',
      'GET  /api/hr/leave/balance?userId=X&fy=FY2026-27',
      'GET  /api/hr/leave/reviewers',
      'POST /api/hr/leave/apply',
      'GET  /api/hr/leave/requests?scope=mine|team|all|pending-mine&status=',
      'PUT  /api/hr/leave/:id/approve',
      'PUT  /api/hr/leave/:id/reject',
      'PUT  /api/hr/leave/:id/cancel',
      'POST /api/hr/regularization/apply',
      'GET  /api/hr/regularization/requests?scope=mine|pending-mine|team|all',
      'PUT  /api/hr/regularization/:id/approve',
      'PUT  /api/hr/regularization/:id/reject',
      'PUT  /api/hr/regularization/:id/cancel',
      'POST /api/hr/leave/grant',
      'GET  /api/hr/leave/grants',
      'PUT  /api/hr/leave/grants/:id/revoke',
      'GET  /api/hr/dashboard/summary',
      'GET  /api/hr/reports/list',
      'POST /api/hr/reports/run',
      'GET  /api/hr/helpdesk/options',
      'GET  /api/hr/helpdesk/assignees',
      'GET  /api/hr/helpdesk/tickets?scope=mine|assigned|all',
      'POST /api/hr/helpdesk/tickets',
      'GET  /api/hr/helpdesk/tickets/:id',
      'PATCH /api/hr/helpdesk/tickets/:id',
      'POST /api/hr/helpdesk/tickets/:id/comments',
      'POST /api/hr/helpdesk/tickets/:id/attachments',
      'GET  /api/hr/helpdesk/tickets/:id/attachments/:attId',
      'GET  /api/hr/engage/options',
      'GET  /api/hr/engage/suggest',
      'GET  /api/hr/engage/feed?kind=&limit=&before=',
      'POST /api/hr/engage/posts',
      'GET  /api/hr/engage/posts/:id',
      'PATCH /api/hr/engage/posts/:id',
      'DELETE /api/hr/engage/posts/:id',
      'POST /api/hr/engage/posts/:id/react',
      'DELETE /api/hr/engage/posts/:id/react',
      'POST /api/hr/engage/posts/:id/comments',
      'DELETE /api/hr/engage/comments/:id',
      'POST /api/hr/engage/posts/:id/vote',
      'GET  /api/hr/documents/options',
      'GET  /api/hr/documents?category=&q=',
      'POST /api/hr/documents',
      'GET  /api/hr/documents/:id/download',
      'PATCH /api/hr/documents/:id',
      'DELETE /api/hr/documents/:id',
      'GET  /api/hr/payroll-structure/options',
      'GET  /api/hr/payroll-structure/components',
      'POST /api/hr/payroll-structure/components',
      'PATCH /api/hr/payroll-structure/components/:id',
      'DELETE /api/hr/payroll-structure/components/:id',
      'GET  /api/hr/payroll-structure/structures',
      'POST /api/hr/payroll-structure/structures',
      'GET  /api/hr/payroll-structure/structures/:id',
      'PATCH /api/hr/payroll-structure/structures/:id',
      'DELETE /api/hr/payroll-structure/structures/:id',
      'GET  /api/hr/payroll-structure/preview?structureId=&ctc=',
      'GET  /api/hr/payroll-structure/employees',
      'GET  /api/hr/payroll-structure/employees/:userId/salary',
      'POST /api/hr/payroll-structure/employees/:userId/salary',
      'POST /api/hr/payroll-structure/employees/:userId/salary/:id/cancel',
      'GET  /api/hr/payroll/options',
      'GET  /api/hr/payroll/runs?year=',
      'POST /api/hr/payroll/runs',
      'GET  /api/hr/payroll/runs/:id',
      'POST /api/hr/payroll/runs/:id/process',
      'POST /api/hr/payroll/runs/:id/lock',
      'POST /api/hr/payroll/runs/:id/unlock',
      'POST /api/hr/payroll/runs/:id/mark-paid',
      'DELETE /api/hr/payroll/runs/:id',
      'GET  /api/hr/payroll/payslips/mine?year=',
      'GET  /api/hr/payroll/payslips/:id',
      'GET  /api/hr/payroll/payslips/:id/pdf',
      'GET  /api/hr/payroll/ytd/mine?fy=',
      'GET  /api/hr/payroll/ytd/all?fy=',
      'GET  /api/hr/payroll/ytd/employee/:userId?fy=',
      'GET  /api/hr/it-declaration/options',
      'GET  /api/hr/it-declaration/mine?fy=',
      'POST /api/hr/it-declaration/mine',
      'POST /api/hr/it-declaration/mine/submit',
      'POST /api/hr/it-declaration/mine/items',
      'PATCH /api/hr/it-declaration/mine/items/:id',
      'DELETE /api/hr/it-declaration/mine/items/:id',
      'POST /api/hr/it-declaration/items/:id/proof',
      'GET  /api/hr/it-declaration/items/:id/proof',
      'GET  /api/hr/it-declaration/statement?fy=',
      'GET  /api/hr/it-declaration/all?fy=&status=',
      'GET  /api/hr/it-declaration/:id',
      'PATCH /api/hr/it-declaration/items/:id/decision',
      'POST /api/hr/it-declaration/:id/approve',
      'POST /api/hr/it-declaration/:id/reject',
      'GET  /api/hr/form16/mine?fy=',
      'GET  /api/hr/form16/all?fy=',
      'POST /api/hr/form16/:userId/upload-part-a',
      'POST /api/hr/form16/:userId/generate-part-b',
      'GET  /api/hr/form16/:id/part-a',
      'GET  /api/hr/form16/:id/part-b',
    ],
  });
});

module.exports = router;
