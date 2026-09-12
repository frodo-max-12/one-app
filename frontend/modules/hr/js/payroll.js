// =====================================================================
// modules/hr/js/payroll.js — HR payroll runs list (Phase 5B)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];

let options = { months: [], currentFY: null };

Object.assign(window, { loadRuns, openCreateRun, closeCreateRun, submitCreateRun });

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-payroll');
  const role = (user.role || '').toLowerCase();
  if (!HR_ROLES.includes(role)) {
    document.querySelector('.pr-wrap').innerHTML = '<div class="pr-empty">HR / admin only.</div>';
    return;
  }
  try {
    options = await apiRequest('/hr/payroll/options');
  } catch (_) { options = { months: [], currentFY: new Date().getFullYear() }; }
  populateYearSel();
  await loadRuns();
}

function populateYearSel() {
  const sel = document.getElementById('yearSel');
  const years = new Set();
  options.months.forEach(m => years.add(m.fy));
  years.add(options.currentFY);
  const sorted = Array.from(years).sort((a,b) => b - a);
  sel.innerHTML = sorted.map(y => `<option value="${y}">${y}-${String((y+1)%100).padStart(2,'0')}</option>`).join('');
  sel.value = options.currentFY;
}

async function loadRuns() {
  const year = parseInt(document.getElementById('yearSel').value, 10);
  const wrap = document.getElementById('runsList');
  wrap.innerHTML = '<div class="pr-empty">Loading…</div>';
  try {
    const r = await apiRequest('/hr/payroll/runs?year=' + year);
    renderRuns(r.runs || []);
  } catch (err) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(err.message || err)}</div>`;
  }
}

function renderRuns(rows) {
  const wrap = document.getElementById('runsList');
  if (!rows.length) {
    wrap.innerHTML = '<div class="pr-empty">No runs yet for this FY. Click <b>+ New Payroll Run</b> to start.</div>';
    return;
  }
  wrap.innerHTML = rows.map(r => `
    <article class="pr-card pr-card-${r.Status}" onclick="location.href='/modules/hr/payroll-run.html?id=${r.RunId}'">
      <header>
        <div class="pr-card-month">${escapeHtml(monthLabel(r.MonthNo, r.FYYear))}</div>
        <span class="pr-status pr-status-${r.Status}">${escapeHtml(r.Status)}</span>
      </header>
      <div class="pr-card-code">${escapeHtml(r.FYMonthCode)}</div>
      <div class="pr-card-period">${formatDate(r.PeriodStart)} → ${formatDate(r.PeriodEnd)}${r.PayDate ? ' · Pay date ' + formatDate(r.PayDate) : ''}</div>
      <div class="pr-card-kpis">
        <div><span>Employees</span><b>${r.EmployeeCount || 0}</b></div>
        <div><span>Gross</span><b>${fmtCur(r.TotalGross)}</b></div>
        <div><span>Deductions</span><b>${fmtCur(r.TotalDeductions)}</b></div>
        <div class="net"><span>Net Pay</span><b>${fmtCur(r.TotalNet)}</b></div>
      </div>
      <footer class="pr-meta">
        Created ${formatLocal(r.CreatedAt)}${r.CreatedByName ? ' by ' + escapeHtml(r.CreatedByName) : ''}
        ${r.LockedAt ? ' · Locked ' + formatLocal(r.LockedAt) : ''}
        ${r.PaidAt   ? ' · Paid '   + formatLocal(r.PaidAt)   : ''}
      </footer>
    </article>`).join('');
}

// ── Create run modal ───────────────────────────────────────────────────────
function openCreateRun() {
  const sel = document.getElementById('nrMonth');
  sel.innerHTML = options.months.map(m =>
    `<option value="${m.year}-${m.monthNo}">${escapeHtml(m.monthLabel)} · ${escapeHtml(m.fyMonthCode)}</option>`
  ).join('');
  document.getElementById('nrErr').style.display = 'none';
  document.getElementById('newRunModal').hidden = false;
}
function closeCreateRun() { document.getElementById('newRunModal').hidden = true; }
async function submitCreateRun() {
  const val = document.getElementById('nrMonth').value;
  const [yearStr, monthStr] = val.split('-');
  const err = document.getElementById('nrErr');
  err.style.display = 'none';
  try {
    const r = await apiRequest('/hr/payroll/runs', {
      method: 'POST',
      body: { year: parseInt(yearStr, 10), monthNo: parseInt(monthStr, 10) },
    });
    closeCreateRun();
    location.href = '/modules/hr/payroll-run.html?id=' + r.runId;
  } catch (e) {
    err.style.display = '';
    err.textContent = e.message || String(e);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
function monthLabel(monthNo, year) {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[(monthNo - 1) | 0]} ${year + (monthNo >= 4 ? 0 : 1)}`;   // Apr 2026, May 2026, … Mar 2027
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
function formatLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleString('en-IN', { hour12:false, day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
