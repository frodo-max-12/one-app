// =====================================================================
// shared/select-company.js — ONE App company picker
// Both companies route to the SAME unified dashboard at /modules/sales/.
// The active company is stored in sessionStorage.nav_company and used by
// every API call via apiRequest() to scope data correctly.
// =====================================================================

document.addEventListener('DOMContentLoaded', () => {
  const user = requireAuth();
  if (!user) return;

  // Safety net — Product/FAE/HR have no Sales dashboard; if they land on
  // select-company.html (bookmark, direct link, sidebar), bounce them out.
  const role = (user.role || '').toLowerCase().trim();
  // HR, ANY FAE role, and the ENTIRE Product team → Lens Home (no Sales dashboard).
  if (role === 'hr' || role === 'hr head' || /\bfae\b/.test(role) || /\bproduct\b/.test(role)) {
    sessionStorage.setItem('nav_company', 'COMPANYA');
    window.location.href = '/modules/hr/home.html';
    return;
  }
  // Warehouse user is CompanyB-only — bounce to Warehouse Home with company locked.
  if (role === 'warehouse') {
    sessionStorage.setItem('nav_company', 'COMPANYB');
    window.location.href = '/modules/warehouse/home.html';
    return;
  }

  const greeting = document.getElementById('userGreeting');
  if (greeting) {
    greeting.textContent = `Welcome, ${user.name || user.username || 'User'}`;
  }
});

function selectCompany(company) {
  // Normalize to canonical codes
  const code = (company || '').toUpperCase() === 'COMPANYB' ? 'COMPANYB' : 'COMPANYA';
  sessionStorage.setItem('nav_company', code);

  // Product/FAE/HR → Lens Home (no Sales dashboard); everyone else → Sales Dashboard.
  const user = getUser();
  const role = (user && user.role || '').toLowerCase().trim();
  if (role === 'hr' || role === 'hr head' || /\bfae\b/.test(role) || /\bproduct\b/.test(role)) {
    window.location.href = '/modules/hr/home.html';
  } else if (role === 'warehouse') {
    sessionStorage.setItem('nav_company', 'COMPANYB');
    window.location.href = '/modules/warehouse/home.html';
  } else if (/\bmis\b/.test(role)) {
    // MIS ('mis' / 'mis store') has no Sales dashboard access — land them on their
    // one Sales page, Budget vs Actual, for the company they just picked.
    window.location.href = '/modules/sales/budget-actual.html';
  } else {
    window.location.href = '/modules/sales/dashboard.html';
  }
}

function doLogout() {
  clearAuth();
  sessionStorage.removeItem('nav_company');
  window.location.href = '/index.html';
}
