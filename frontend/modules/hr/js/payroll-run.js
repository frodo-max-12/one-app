// =====================================================================
// modules/hr/js/payroll-run.js — single run detail page (Phase 5B)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];
const runId = parseInt(new URLSearchParams(location.search).get('id') || '0', 10);

let run = null;
let payslips = [];

Object.assign(window, {
  processRun, openLock, closeLock, submitLock, unlockRun, markPaid, deleteRun,
  downloadPayslipPdf,
});

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-payroll');
  if (!runId) { diag('Missing run id'); return; }
  const role = (user.role || '').toLowerCase();
  if (!HR_ROLES.includes(role)) {
    document.querySelector('.pr-wrap').innerHTML = '<div class="pr-empty">HR / admin only.</div>';
    return;
  }
  await load();
}

async function load() {
  try {
    const r = await apiRequest('/hr/payroll/runs/' + runId);
    run = r.run;
    payslips = r.payslips || [];
    renderHead();
    renderActions();
    renderKpis();
    renderTable();
  } catch (e) { diag(e.message || e); }
}

function renderHead() {
  document.getElementById('topRunCode').textContent = run.FYMonthCode;
  document.getElementById('runHead').innerHTML = `
    <div class="pr-runhead-left">
      <div class="pr-runhead-month">${escapeHtml(monthLabel(run.MonthNo, run.FYYear))}</div>
      <h1>${escapeHtml(run.FYMonthCode)}</h1>
      <div class="pr-meta">${formatDate(run.PeriodStart)} → ${formatDate(run.PeriodEnd)} · ${run.DaysInMonth} days
        ${run.PayDate ? ' · Pay date ' + formatDate(run.PayDate) : ''}</div>
    </div>
    <div class="pr-runhead-right">
      <span class="pr-status pr-status-${run.Status}">${escapeHtml(run.Status)}</span>
      <div class="pr-meta" style="margin-top:6px;">
        ${run.ProcessedAt ? '✓ Processed ' + formatLocal(run.ProcessedAt) + (run.ProcessedByName ? ' by ' + escapeHtml(run.ProcessedByName) : '') : ''}
        ${run.LockedAt    ? '<br/>🔒 Locked '   + formatLocal(run.LockedAt)    + (run.LockedByName    ? ' by ' + escapeHtml(run.LockedByName)    : '') : ''}
        ${run.PaidAt      ? '<br/>💰 Paid '     + formatLocal(run.PaidAt)      + (run.PaidByName      ? ' by ' + escapeHtml(run.PaidByName)      : '') : ''}
      </div>
    </div>`;
}

function renderActions() {
  const bar = document.getElementById('actionBar');
  const buttons = [];
  if (run.Status === 'draft') {
    buttons.push(`<button class="btn btn-primary" onclick="processRun()">⚙ ${run.ProcessedAt ? 'Re-Process' : 'Process'} Payslips</button>`);
    if (run.ProcessedAt) buttons.push(`<button class="btn btn-success" onclick="openLock()">🔒 Lock Run</button>`);
    if (!payslips.length) buttons.push(`<button class="btn btn-danger" onclick="deleteRun()">🗑 Delete Draft</button>`);
  } else if (run.Status === 'locked') {
    buttons.push(`<button class="btn" onclick="unlockRun()">↺ Unlock</button>`);
    buttons.push(`<button class="btn btn-primary" onclick="markPaid()">💰 Mark as Paid</button>`);
  } else if (run.Status === 'paid') {
    buttons.push(`<span class="pr-meta">Run finalised — no further actions.</span>`);
  }
  bar.innerHTML = buttons.join(' ');
}

function renderKpis() {
  const wrap = document.getElementById('kpiStrip');
  wrap.innerHTML = `
    <div class="kpi-card kpi-blue"><div class="kpi-lbl">Employees</div><div class="kpi-num">${run.EmployeeCount || 0}</div></div>
    <div class="kpi-card kpi-green"><div class="kpi-lbl">Total Gross</div><div class="kpi-num">${fmtCur(run.TotalGross)}</div></div>
    <div class="kpi-card kpi-red"><div class="kpi-lbl">Total Deductions</div><div class="kpi-num">${fmtCur(run.TotalDeductions)}</div></div>
    <div class="kpi-card kpi-teal"><div class="kpi-lbl">Total Net Pay</div><div class="kpi-num">${fmtCur(run.TotalNet)}</div></div>`;
}

function renderTable() {
  const tbody = document.getElementById('psTbody');
  if (!payslips.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="pr-empty">No payslips yet — click <b>Process</b> to compute.</td></tr>`;
    return;
  }
  tbody.innerHTML = payslips.map(p => `
    <tr>
      <td class="mono">${escapeHtml(p.EmpCode || '—')}</td>
      <td>${escapeHtml(p.EmpName || '—')}</td>
      <td>${escapeHtml(p.Department || '—')}</td>
      <td class="r mono">${p.DaysInMonth}</td>
      <td class="r mono">${Number(p.LopDays).toFixed(2)}</td>
      <td class="r mono">${Number(p.PayableDays).toFixed(2)}</td>
      <td class="r mono">${fmtCur(p.MonthlyGross)}</td>
      <td class="r mono">${fmtCur(p.TotalDeductions)}</td>
      <td class="r mono"><b>${fmtCur(p.NetPay)}</b></td>
      <td><span class="pr-status pr-status-${p.Status}">${escapeHtml(p.Status)}</span></td>
      <td class="r"><button class="btn btn-sm" onclick="downloadPayslipPdf(${p.PayslipId}, ${JSON.stringify(p.PayslipNo || '').replace(/"/g,'&quot;')})">📄 PDF</button></td>
    </tr>`).join('');
}

// ── Actions ────────────────────────────────────────────────────────────────
async function processRun() {
  if (!confirm('Process payslips for this run? Existing draft payslips will be replaced.')) return;
  try {
    const r = await apiRequest(`/hr/payroll/runs/${runId}/process`, { method:'POST' });
    let msg = `Processed ${r.employeesProcessed} employees. Gross ₹${fmtCur(r.totalGross)}, Net ₹${fmtCur(r.totalNet)}.`;
    if (r.errors && r.errors.length) msg += `\n\n⚠ ${r.errors.length} error(s): ` + r.errors.map(e => e.name + ': ' + e.message).join('; ');
    alert(msg);
    await load();
  } catch (e) { alert(e.message || e); }
}

function openLock() {
  document.getElementById('lkPayDate').value = new Date(new Date(run.PeriodEnd).getTime() + 86400000 * 0).toISOString().slice(0,10);
  document.getElementById('lkErr').style.display = 'none';
  document.getElementById('lockModal').hidden = false;
}
function closeLock() { document.getElementById('lockModal').hidden = true; }
async function submitLock() {
  const payDate = document.getElementById('lkPayDate').value;
  try {
    await apiRequest(`/hr/payroll/runs/${runId}/lock`, { method:'POST', body: { payDate }});
    closeLock();
    await load();
  } catch (e) {
    document.getElementById('lkErr').style.display = '';
    document.getElementById('lkErr').textContent = e.message || e;
  }
}
async function unlockRun() {
  if (!confirm('Unlock this run? Payslips will revert to draft and disappear from employee view.')) return;
  try { await apiRequest(`/hr/payroll/runs/${runId}/unlock`, { method:'POST' }); await load(); }
  catch (e) { alert(e.message || e); }
}
async function markPaid() {
  if (!confirm('Mark this run as PAID? This is terminal — you cannot unlock after this.')) return;
  try { await apiRequest(`/hr/payroll/runs/${runId}/mark-paid`, { method:'POST' }); await load(); }
  catch (e) { alert(e.message || e); }
}
async function deleteRun() {
  if (!confirm('Delete this draft run? Allowed only if no payslips are processed.')) return;
  try {
    await apiRequest(`/hr/payroll/runs/${runId}`, { method:'DELETE' });
    location.href = '/modules/hr/payroll.html';
  } catch (e) { alert(e.message || e); }
}

async function downloadPayslipPdf(id, label) {
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/payroll/payslips/${id}/pdf?company=${encodeURIComponent(company)}`, {
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).message || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `Payslip_${label || id}.pdf`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  } catch (e) { alert(e.message || e); }
}

// ── helpers ────────────────────────────────────────────────────────────────
function diag(msg) {
  const el = document.getElementById('diagBox');
  if (!el) return;
  el.style.display = ''; el.textContent = '⚠ ' + msg;
}
function monthLabel(monthNo, year) {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[(monthNo - 1) | 0]} ${year + (monthNo >= 4 ? 0 : 1)}`;
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
