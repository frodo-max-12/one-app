// ============================================================================
// ONE App Lens — Employee Directory (HR view)
// ============================================================================
const user = requireAuth();
let allEmps = [];

window.filter = filter;

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

function diag(label, msg) {
  const box = document.getElementById('lensDiag'); const list = document.getElementById('diagList');
  if (!box || !list) return console.error(label, msg);
  const li = document.createElement('li'); li.textContent = `[${new Date().toLocaleTimeString('en-IN',{hour12:false})}] ${label}: ${msg}`;
  list.appendChild(li); box.style.display = 'block';
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('employees');
  try {
    const r = await apiRequest('/hr/employees');
    allEmps = r.employees || [];
    render();
  } catch (e) {
    diag('GET /employees', e.message || e);
    document.getElementById('empBody').innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:#991b1b;">${escape(e.message)}</td></tr>`;
  }
}

function filter() { render(); }

function render() {
  const q = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  const dept = document.getElementById('deptFilter').value;
  let list = allEmps;
  if (dept) list = list.filter(e => (e.Department || '').toUpperCase() === dept);
  if (q) list = list.filter(e =>
    (e.Name || '').toLowerCase().includes(q) ||
    (e.Email || '').toLowerCase().includes(q) ||
    (e.EmpCode || '').toLowerCase().includes(q) ||
    (e.CompanyACode || '').toLowerCase().includes(q) ||
    (e.Mobile || '').toLowerCase().includes(q) ||
    (e.Designation || '').toLowerCase().includes(q)
  );
  document.getElementById('countLbl').textContent = `${list.length} of ${allEmps.length} employees`;
  const tbody = document.getElementById('empBody');
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--lens-text-3);">No matches.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(e => {
    const ini = (e.Name || 'US').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const joined = e.DateOfJoining ? new Date(e.DateOfJoining).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
    return `
      <tr onclick="location.href='/modules/hr/employee-profile.html?id=${e.UserId}'">
        <td>
          <div class="emp-name-wrap">
            <span class="emp-avatar">${escape(ini)}</span>
            <span class="emp-name-text">
              <span class="emp-name-cell">${escape(e.Name || e.Email)}</span>
              <span class="emp-name-sub">${escape(e.Email || '')}</span>
            </span>
          </div>
        </td>
        <td><span class="emp-code-pill">${escape(e.EmpCode || e.CompanyACode || '—')}</span></td>
        <td>${escape(e.Designation || '—')}</td>
        <td>${escape(e.Department || '—')}</td>
        <td>${escape(e.Location || '—')}</td>
        <td>${escape(e.OfficeName || '—')}</td>
        <td>${joined}</td>
        <td><span class="emp-role-pill">${escape(e.Role || '—')}</span></td>
      </tr>`;
  }).join('');
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
