// =====================================================================
// modules/hr/js/ytd.js — YTD Statement (Phase 5C)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];
let isHr = false;

window.loadView = loadView;
window.openEmployeeDrill = openEmployeeDrill;

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-ytd');
  isHr = HR_ROLES.includes((user.role || '').toLowerCase());
  if (isHr) document.querySelectorAll('.hr-only').forEach(el => el.style.display = '');

  const sel = document.getElementById('fySel');
  const today = new Date();
  const fyNow = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  for (let f = fyNow; f >= fyNow - 2; f--) {
    sel.insertAdjacentHTML('beforeend', `<option value="${f}">FY${f}-${String((f+1)%100).padStart(2,'0')}</option>`);
  }
  await loadView();
}

async function loadView() {
  const fy   = parseInt(document.getElementById('fySel').value, 10);
  const mode = isHr ? (document.getElementById('viewMode').value || 'mine') : 'mine';
  const wrap = document.getElementById('content');
  wrap.innerHTML = '<div class="pr-empty">Loading…</div>';
  try {
    if (mode === 'all') {
      const r = await apiRequest('/hr/payroll/ytd/all?fy=' + fy);
      renderAll(r);
    } else {
      const r = await apiRequest('/hr/payroll/ytd/mine?fy=' + fy);
      renderMine(r);
    }
  } catch (err) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(err.message || err)}</div>`;
  }
}

function renderMine(r) {
  const wrap = document.getElementById('content');
  const t = r.totals || {};
  const emp = r.employee || {};
  wrap.innerHTML = `
    <div class="pr-runhead">
      <div class="pr-runhead-left">
        <div class="pr-runhead-month">${escapeHtml(r.fyLabel)}</div>
        <h1>${escapeHtml(emp.EmpName || '—')}</h1>
        <div class="pr-meta">${escapeHtml(emp.EmpCode || '—')} · ${escapeHtml(emp.Designation || '—')} · ${escapeHtml(emp.Department || '—')}${emp.PAN ? ' · PAN ' + escapeHtml(emp.PAN) : ''}</div>
      </div>
    </div>
    <div class="pr-kpis">
      <div class="kpi-card kpi-blue"><div class="kpi-lbl">Payslips</div><div class="kpi-num">${(r.months || []).length}</div></div>
      <div class="kpi-card kpi-green"><div class="kpi-lbl">Total Gross</div><div class="kpi-num">${fmtCur(t.gross)}</div></div>
      <div class="kpi-card kpi-red"><div class="kpi-lbl">Total Deductions</div><div class="kpi-num">${fmtCur(t.deductions)}</div></div>
      <div class="kpi-card kpi-teal"><div class="kpi-lbl">Total Net</div><div class="kpi-num">${fmtCur(t.net)}</div></div>
    </div>
    <section class="pr-table-wrap">
      <h3 style="padding:12px 14px; margin:0; font-size:14px; color:var(--text2); border-bottom:1px solid var(--border);">Monthly Pay History</h3>
      <table class="pr-table">
        <thead><tr>
          <th>FY Month</th><th>Period</th><th class="r">Days</th><th class="r">LOP</th>
          <th class="r">Gross</th><th class="r">Deductions</th><th class="r">Net</th><th>Status</th>
        </tr></thead>
        <tbody>${(r.months || []).map(m => `
          <tr>
            <td class="mono">${escapeHtml(m.FYMonthCode)}</td>
            <td>${formatDate(m.PeriodStart)}</td>
            <td class="r mono">${m.DaysInMonth}</td>
            <td class="r mono">${Number(m.LopDays).toFixed(2)}</td>
            <td class="r mono">${fmtCur(m.MonthlyGross)}</td>
            <td class="r mono">${fmtCur(m.TotalDeductions)}</td>
            <td class="r mono"><b>${fmtCur(m.NetPay)}</b></td>
            <td><span class="pr-status pr-status-${m.Status}">${escapeHtml(m.Status)}</span></td>
          </tr>`).join('') || '<tr><td colspan="8" class="pr-empty">No payslips yet for this FY.</td></tr>'}
        </tbody>
      </table>
    </section>
    <section class="pr-table-wrap">
      <h3 style="padding:12px 14px; margin:0; font-size:14px; color:var(--text2); border-bottom:1px solid var(--border);">Component-wise YTD</h3>
      <table class="pr-table">
        <thead><tr>
          <th>Code</th><th>Component</th><th>Kind</th>
          <th class="r">Months Paid</th><th class="r">YTD Amount</th>
        </tr></thead>
        <tbody>${(r.components || []).map(c => `
          <tr>
            <td class="mono">${escapeHtml(c.ComponentCode)}</td>
            <td>${escapeHtml(c.ComponentName)}</td>
            <td><span class="pill pill-${c.Kind.toLowerCase()}">${escapeHtml(c.Kind)}</span></td>
            <td class="r mono">${c.MonthsPaid}</td>
            <td class="r mono"><b>${fmtCur(c.YTDAmount)}</b></td>
          </tr>`).join('') || '<tr><td colspan="5" class="pr-empty">—</td></tr>'}
        </tbody>
      </table>
    </section>`;
}

function renderAll(r) {
  const wrap = document.getElementById('content');
  const rows = r.employees || [];
  const totals = rows.reduce((a, e) => ({
    gross: a.gross + Number(e.TotalGross || 0),
    ded:   a.ded   + Number(e.TotalDeductions || 0),
    net:   a.net   + Number(e.TotalNet || 0),
  }), { gross: 0, ded: 0, net: 0 });
  wrap.innerHTML = `
    <div class="pr-runhead">
      <div class="pr-runhead-left">
        <div class="pr-runhead-month">${escapeHtml(r.fyLabel)} — All Employees</div>
        <h1>${rows.length} employees with payslips</h1>
      </div>
    </div>
    <div class="pr-kpis">
      <div class="kpi-card kpi-blue"><div class="kpi-lbl">Employees</div><div class="kpi-num">${rows.length}</div></div>
      <div class="kpi-card kpi-green"><div class="kpi-lbl">FY Gross</div><div class="kpi-num">${fmtCur(totals.gross)}</div></div>
      <div class="kpi-card kpi-red"><div class="kpi-lbl">FY Deductions</div><div class="kpi-num">${fmtCur(totals.ded)}</div></div>
      <div class="kpi-card kpi-teal"><div class="kpi-lbl">FY Net</div><div class="kpi-num">${fmtCur(totals.net)}</div></div>
    </div>
    <section class="pr-table-wrap">
      <table class="pr-table">
        <thead><tr>
          <th>Emp Code</th><th>Name</th><th>Department</th>
          <th class="r">Payslips</th><th class="r">LOP Days</th>
          <th class="r">FY Gross</th><th class="r">FY Deductions</th><th class="r">FY Net</th><th></th>
        </tr></thead>
        <tbody>${rows.map(e => `
          <tr>
            <td class="mono">${escapeHtml(e.EmpCode || '—')}</td>
            <td>${escapeHtml(e.EmpName || '—')}</td>
            <td>${escapeHtml(e.Department || '—')}</td>
            <td class="r mono">${e.PayslipCount}</td>
            <td class="r mono">${Number(e.LopDays || 0).toFixed(2)}</td>
            <td class="r mono">${fmtCur(e.TotalGross)}</td>
            <td class="r mono">${fmtCur(e.TotalDeductions)}</td>
            <td class="r mono"><b>${fmtCur(e.TotalNet)}</b></td>
            <td class="r"><button class="btn btn-sm" onclick="openEmployeeDrill(${e.UserId})">Detail</button></td>
          </tr>`).join('') || '<tr><td colspan="9" class="pr-empty">No payslips for this FY yet.</td></tr>'}
        </tbody>
      </table>
    </section>`;
}

async function openEmployeeDrill(userId) {
  const fy = parseInt(document.getElementById('fySel').value, 10);
  try {
    const r = await apiRequest('/hr/payroll/ytd/employee/' + userId + '?fy=' + fy);
    renderMine(r);   // reuses the same renderer
  } catch (e) { alert(e.message || e); }
}

function fmtCur(n) {
  if (n == null || n === '') return '—';
  return '₹ ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
