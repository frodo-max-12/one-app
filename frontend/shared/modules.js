// =====================================================================
// shared/modules.js — sidebar registry
//
// Single source of truth for what departments + items appear in the sidebar.
// Used by common.js → renderSidebar(activePage).
//
// To add a new department: add an object to MODULES.
// To add a new page within a department: add to its `items` array.
// To restrict who sees a department: edit `roles`.
//
// `roles` / `hideForRoles` semantics:
//   - roles: []                      = visible to ALL logged-in users
//   - roles: ['admin','sales head']  = only those roles see the section
//   - hideForRoles: ['hr','hr head'] = visible to everyone EXCEPT these roles
//   - both can be combined: roles narrows the set, hideForRoles trims from it
//
// `electricalTeamOnly: true` (per-item) — visible only to the electrical head's
// electrical vertical team + admin family. Uses companyaCode intersection with
// ELECTRICAL_TEAM_CODES below so it self-updates when new electrical reps
// are added (only a colleague's User_Login.CompanyACode union needs to be kept fresh).
//
// HR users do NOT see Sales — their accounts have no CompanyACode by design and
// they don't need access to financial data. They see ONE App Lens (and the
// future HR module once Phase 3 ships).
// =====================================================================

// 28 CompanyACodes that make up a colleague Porwal's (Electrical Head) team — the union
// of his sub-team leads + reps as of 2026-06-17. Anyone whose User_Login.CompanyACode
// contains ANY of these codes is treated as electrical-vertical for sidebar
// visibility. Refresh by running:
//   SELECT CompanyACode FROM dbo.User_Login WHERE LOWER(Role)='electrical head';
const ELECTRICAL_TEAM_CODES = [
  'EMP0032','EMP0092','EMP0113','EMP0114','EMP0115','EMP0119','EMP0120','EMP0121',
  'EMP0122','EMP0123','EMP0124','EMP0126','EMP0127','EMP0128','EMP0129','EMP0130',
  'EMP0131','EMP0132','EMP0133','EMP0135','EMP0136','EMP0138','EMP0139','EMP0140',
  'EMP0141','EMP0142','EMP0143','EMP0147'
];

// True if user is admin family, a vertical head/sales-head, OR has any CompanyACode
// overlap with the electrical team. Drives `electricalTeamOnly` sidebar gating.
function isElectricalTeam(user) {
  const role = (user && user.role || '').toLowerCase().trim();
  if (['admin', 'operation head', 'director', 'sales head electrical', 'electrical head'].includes(role)) return true;
  const codes = (user && user.companyaCode || '').split('/').map(s => s.trim()).filter(Boolean);
  return codes.some(c => ELECTRICAL_TEAM_CODES.includes(c));
}

// Sales-financial items hidden from FAE/HR (they only get Visit Plan) AND from
// the MIS roles ('mis' = Rajashree, 'mis store' = Rupali) — MIS gets ONLY HRMS +
// Budget vs Actual, so every other Sales page is hidden. Budget vs Actual keeps
// the plain ['fae','fae head','hr','hr head'] list (NOT this one) so MIS sees it.
const HIDE_FROM_MIS = ['fae', 'fae head', 'hr', 'hr head', 'mis', 'mis store'];

const MODULES = [
  {
    dept:   'sales',
    label:  'Sales',
    roles:  [],
    // HR / Warehouse / Store have no CompanyACode + shouldn't see financials.
    // Store user added 2026-06-18 — sales pages return 403 + the dashboard
    // throws "Failed to load" on login redirect; the sidebar hide + the new
    // store-electrical login redirect in index.html together stop that.
    // HR/HR-head are allowed into the Sales SECTION so they can reach Visit Plan (for
    // visit-completion evaluation) — every financial item below is individually hidden
    // from them, so they see ONLY Visit Plan here.
    hideForRoles: ['warehouse', 'store electrical', 'product head', 'product assistant'],
    items: [
      // FAE roles ('fae' / 'fae head') get HRMS + Visit Plan only — every other
      // Sales (financial) item is hidden for them.
      { key: 'dashboard',   href: '/modules/sales/dashboard.html',   label: 'Dashboard',          hideForRoles: HIDE_FROM_MIS },
      { key: 'outstanding', href: '/modules/sales/outstanding.html', label: 'Outstanding',        hideForRoles: HIDE_FROM_MIS },
      { key: 'customers',   href: '/modules/sales/customers.html',   label: 'Customers',          hideForRoles: HIDE_FROM_MIS },
      { key: 'inventory',   href: '/modules/sales/inventory.html',   label: 'Inventory',          hideForRoles: HIDE_FROM_MIS },
      { key: 'sobacklog',   href: '/modules/sales/soBacklog.html',   label: 'SO Backlog',         hideForRoles: HIDE_FROM_MIS },
      { key: 'billing',     href: '/modules/sales/billing.html',     label: 'Billing',            hideForRoles: HIDE_FROM_MIS },
      // Budget vs Actual — the ONE Sales page MIS keeps. Plain FAE/HR hide list
      // (NOT HIDE_FROM_MIS) so 'mis' / 'mis store' can see it.
      { key: 'budget-actual', href: '/modules/sales/budget-actual.html', label: 'Budget vs Actual', hideForRoles: ['fae','fae head','hr','hr head'] },
      // Visit Plan — MIS ('mis'/'mis store') CAN see it (view-only) to evaluate how
      // many visits each salesperson/FAE completed (for budget valuation + expense
      // approval). COMPANYA-company data (companyOnly:'COMPANYA') — visits for both COMPANYA & CompanyB
      // reps live under Company='COMPANYA'.
      { key: 'visitplan',   href: '/modules/sales/visitPlan.html',   label: 'Visit Plan',         companyOnly: 'COMPANYA' },
      // DC File — the Product team's Design-Conversion sheet, now shared with Sales & FAE.
      // Row-scoped in the backend (a salesperson/FAE sees only their own rows; a sales/FAE
      // head sees their team). Admin/Product reach it via the Product section, so this item
      // is gated to the field roles only to avoid a duplicate entry for them.
      { key: 'product-dc',  href: '/modules/product/dc.html',        label: 'DC File',
        roles: ['sales','international sales','north sales','south sales','sales head','north sales head','fae','fae head'] },
      // MOM (Minutes of Meeting) — read-only view of the SmartSys ERP's MOM data,
      // scoped by SmartSys's own reporting hierarchy: salesperson/FAE see own, a
      // head sees their team, FAE head sees the FAE team, admin sees all. 'mis store'
      // (sc@) is included so MIS can evaluate whether reps actually visited (they see
      // all, read-only). Field roles + admin family + MIS Store only; HR / plain MIS /
      // warehouse / store / product don't get it.
      // MOM & Action Points — one module, two tabs (Minutes of Meeting + Action
      // Points tracker). Read from SmartSys; MOM create/edit via its save procs.
      { key: 'mom',         href: '/modules/sales/mom.html',         label: 'MOM & Actions',
        roles: ['sales','international sales','north sales','south sales',
                'sales head','north sales head','sales head electrical','electrical head',
                'fae','fae head','mis store','admin','operation head','director'] },
      { key: 'reminders',   href: '/modules/sales/reminders.html',   label: 'Payment Reminders',  hideForRoles: HIDE_FROM_MIS },
      { key: 'pdc',         href: '/modules/sales/pdc.html',         label: 'PDC (Cheques In)',   hideForRoles: HIDE_FROM_MIS },
      // Electrical vertical weekly beat plan (IvyDMS model). Visibility rule
      // (2026-06-17): the electrical head's electrical-vertical team + admin family.
      // `electricalTeamOnly: true` checks role AND companyaCode overlap, so new
      // electrical reps auto-appear without a sidebar edit. Regular sales
      // (other reps), FAE, HR, warehouse, store users excluded.
      { key: 'beatplan',    href: '/modules/sales/beatPlan.html',    label: 'Beat Plan (Electrical)', companyOnly: 'COMPANYA', electricalTeamOnly: true },
    ],
  },

  // ── ONE App Lens (HR + Geo) — Phase 1 ───────────────────────────────────
  {
    dept:  'lens',
    label: 'ONE App Lens',
    roles: [],   // visible to everyone — every employee punches in/out
    hideForRoles: ['warehouse'],   // SG warehouse user is CompanyB-only + outside HR/payroll scope
    items: [
      { key: 'home',             href: '/modules/hr/home.html',             label: 'Home' },
      // v1.8 — Punch-In/Out at customer premises. Field-rep facing only;
      // HR don't do field visits, admins see it for visibility but rarely use it.
      // Field-tracking item — only field staff (sales/FAE) who do customer visits.
      // Office roles (HR, Product) get HRMS but NOT live tracking / field visits.
      { key: 'visit-punch',      href: '/modules/hr/visit-punch.html',      label: 'Visit Punch',
        hideForRoles: ['hr','hr head','product head','product assistant','mis','mis store'] },
      { key: 'my-profile',       href: '/modules/hr/employee-profile.html?id={userId}', label: 'My Profile' },
      { key: 'hr-dashboard',     href: '/modules/hr/dashboard.html',        label: 'HR Dashboard',
        roles: ['admin','operation head','director','hr','hr head'] },
      { key: 'hr-reports',       href: '/modules/hr/reports.html',          label: 'Reports',
        roles: ['admin','operation head','director','hr','hr head'] },
      { key: 'hr-helpdesk',      href: '/modules/hr/helpdesk.html',         label: 'Helpdesk' },
      { key: 'hr-engage',        href: '/modules/hr/engage.html',           label: 'Engage' },
      { key: 'hr-documents',     href: '/modules/hr/documents.html',        label: 'Documents' },
      { key: 'hr-payroll-structure', href: '/modules/hr/payroll-structure.html', label: 'Salary Structure',
        roles: ['admin','operation head','director','hr','hr head'] },
      { key: 'hr-payroll',       href: '/modules/hr/payroll.html',          label: 'Payroll',
        roles: ['admin','operation head','director','hr','hr head'] },
      // Merged 2026-05-25: was 3 entries (My Payslips + YTD Statement + Form 16). Now one "My Payroll" page with 3 tabs.
      { key: 'hr-my-payroll',    href: '/modules/hr/my-payroll.html',       label: 'My Payroll' },
      // Merged 2026-05-25: was 2 entries (IT Declaration + IT Approvals).
      // Single page with My Declaration + Projected Tax (everyone) + Approvals tab (HR-only, gated in it-declaration.js)
      { key: 'hr-it-declaration', href: '/modules/hr/it-declaration.html',  label: 'IT Declaration' },
      // hr-form16 entry merged into hr-my-payroll above (Form 16 tab).
      { key: 'hr-workflow-config', href: '/modules/hr/workflow-config.html', label: 'Workflow Config',
        roles: ['admin','operation head','director','hr','hr head'] },
      { key: 'hr-letters',       href: '/modules/hr/letters.html',          label: 'Letters',
        roles: ['admin','operation head','director','hr','hr head'] },
      // Merged 2026-05-25 into "Geo Admin" landing tile (office-presence + geofence + stops + anomalies).
      // (Old office-presence entry removed; HR-only gating preserved on the merged tile.)
      // Merged 2026-05-25 into single "My Activity" landing tile that links to all 3:
      //   Visit Tracker (plan-tracker.html) · Day Journey (journey.html) · My Attendance (attendance.html)
      // My Activity = Visit Tracker + Day Journey (GPS) + My Attendance. Field-tracking
      // centric → hidden from office roles (Product) who aren't GPS-tracked.
      { key: 'my-activity',      href: '/modules/hr/my-activity.html',      label: 'My Activity',
        hideForRoles: ['product head','product assistant'] },
      // Merged 2026-05-25: was 4 entries (Apply for Leave + Leave Balance + Leave Approvals + Leave Granter).
      // Single "Leave" landing tile that exposes role-aware quick-links to all 4 existing sub-pages.
      { key: 'leave',                      href: '/modules/hr/leave.html',                      label: 'Leave' },
      { key: 'employees',                  href: '/modules/hr/employees.html',                  label: 'Employees',
        roles: ['admin','operation head','director','hr','hr head'] },
      // User Management — create/manage app logins for any role (admin + HR only).
      { key: 'user-admin',                 href: '/modules/hr/user-admin.html',                 label: 'User Management',
        roles: ['admin','operation head','director','hr','hr head'] },
      // "+ Add Employee" removed from sidebar 2026-05-25 — redundant.
      // Employees page (employees.html line 23) has a prominent "+ Add Employee"
      // button that links to /modules/hr/employee-add.html (still works as direct URL).
      // Merged 2026-05-25: was 2 entries (Apply Regularization + Regularization Approvals).
      // Single page with Apply tab (everyone) + Approvals tab (gated to reviewer roles internally in regularization.js)
      { key: 'regularization',             href: '/modules/hr/regularization.html',             label: 'Regularization' },
      // Geo Admin — one landing tile gives quick-links to all 4 geo pages
      { key: 'geo-admin',        href: '/modules/hr/geo-admin.html',        label: 'Geo Admin',
        roles: ['admin','operation head','director','hr','hr head','sales head','north sales head'] },
      // v1.8 — real-time field-staff map. Electrical heads included by their exact
      // role strings (sidebar matches roles literally; backend uses isAnyHead).
      { key: 'live-map',         href: '/modules/hr/live-map.html',         label: 'Live Map',
        roles: ['admin','operation head','director','hr','hr head','sales head','north sales head','sales head electrical','electrical head'] },
      // Where each employee signed in / out on a given day (incl. WFH / outside-office) —
      // HR/heads monitor view. Backed by HRM_Attendance SignIn/Out lat-lng + office geofences.
      { key: 'sign-locations',   href: '/modules/hr/sign-locations.html',   label: 'Sign-In/Out Locations',
        roles: ['admin','operation head','director','hr','hr head','sales head','north sales head','sales head electrical','electrical head'] },
      // Phase 2+ items planned: Apply Leave, Holiday Calendar, etc.
    ],
  },

  // ── Warehouse (Company B Singapore, one user) ────────────────────────────
  // Visible to the warehouse user (full CRUD via backend) + admin family for
  // read-only oversight. companyOnly:'COMPANYB' keeps it out of the COMPANYA sidebar.
  {
    dept:  'warehouse',
    label: 'Warehouse',
    roles: ['warehouse', 'admin', 'operation head', 'director'],
    items: [
      { key: 'wh-home',      href: '/modules/warehouse/home.html',      label: 'Home',           companyOnly: 'COMPANYB' },
      { key: 'wh-purchase',  href: '/modules/warehouse/purchase.html',  label: 'Purchase Order', companyOnly: 'COMPANYB' },
      { key: 'wh-sobacklog', href: '/modules/warehouse/soBacklog.html', label: 'SO Backlog',     companyOnly: 'COMPANYB' },
      { key: 'wh-stocks',    href: '/modules/warehouse/stocks.html',    label: 'Stocks',         companyOnly: 'COMPANYB' },
      { key: 'wh-sales',     href: '/modules/warehouse/sales.html',     label: 'Sales Invoice',  companyOnly: 'COMPANYB' },
      { key: 'wh-cheques',   href: '/modules/warehouse/cheques.html',   label: 'Cheques',        companyOnly: 'COMPANYB' },
      { key: 'wh-expenses',  href: '/modules/warehouse/expenses.html',  label: 'Expenses',       companyOnly: 'COMPANYB' },
    ],
  },

  // ── Store (retail store-audit scanner) ──────────────────────
  // Access NARROWED 2026-06-16 per user direction: ONLY the dedicated
  // 'store electrical' user + the admin family. Heads / sales / FAE / warehouse
  // explicitly excluded — Store does not show in their sidebar.
  {
    dept:  'store',
    label: 'Store',
    // 'mis store' (Rupali) keeps Retailer Store Auditing alongside her Budget/HRMS
    // access. 'mis' (Rajashree) is NOT here — she gets no Store section.
    roles: ['store electrical', 'mis store', 'admin', 'operation head', 'director'],
    items: [
      { key: 'store-retailer-audit', href: '/modules/store/home.html', label: 'Retailer — Store Auditing' },
    ],
  },

  // ── Product (the product team — DC / Design-Conversion tracker) ──────────
  // Visible to the Product team (head + assistants) + admin family. Product
  // staff don't see Sales financials (hidden in the Sales section above).
  {
    dept:  'product',
    label: 'Product',
    roles: ['product head', 'product assistant', 'admin', 'operation head', 'director'],
    items: [
      { key: 'product-dc', href: '/modules/product/dc.html', label: 'DC File' },
    ],
  },

  // ── Future departments (uncomment as each goes live) ──────────────────
  // {
  //   dept:  'csr',
  //   label: 'CSR',
  //   roles: ['admin','operation head','director','csr','csr head'],
  //   items: [
  //     { key: 'so-pending',   href: '/modules/csr/so-pending.html',   label: 'SO Pending Queue' },
  //     { key: 'cn-requests',  href: '/modules/csr/cn-requests.html',  label: 'CN Requests' },
  //   ],
  // },
  // ... purchase / account / store / fae / product / common follow same pattern
];

// Items in the "Account" sub-section of every sidebar (always visible)
const ACCOUNT_ITEMS = [
  { key: 'notifications', href: '/modules/notifications/notifications.html', label: '🔔 Notifications' },
  { key: 'switch-company', href: '/select-company.html', label: 'Switch Company' },
  // future: my-profile, approval-inbox, my-leave, my-expenses, etc.
];

// Returns the list of dept entries the given user/company can see
function getVisibleModules(user, company) {
  const role = (user && user.role || '').toLowerCase();
  return MODULES
    .filter(m => !m.roles.length || m.roles.includes(role))
    .filter(m => !m.hideForRoles || !m.hideForRoles.includes(role))
    .map(m => ({
      ...m,
      items: m.items
        .filter(i => !i.companyOnly || i.companyOnly === company)
        .filter(i => !i.roles || i.roles.length === 0 || i.roles.includes(role))
        .filter(i => !i.hideForRoles || !i.hideForRoles.includes(role))
        .filter(i => !i.electricalTeamOnly || isElectricalTeam(user)),
    }))
    .filter(m => m.items.length > 0);
}

// Expose globally for common.js
if (typeof window !== 'undefined') {
  window.ONEAPP_MODULES        = MODULES;
  window.ONEAPP_ACCOUNT_ITEMS  = ACCOUNT_ITEMS;
  window.ONEAPP_getVisibleModules = getVisibleModules;
}
