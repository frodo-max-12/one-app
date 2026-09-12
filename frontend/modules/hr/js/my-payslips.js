// =====================================================================
// modules/hr/js/my-payslips.js — Employee self-service payslip list (Phase 5B)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
let payslips = [];

window.loadMine = loadMine;
window.downloadPayslipPdf = downloadPayslipPdf;

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-my-payslips');
  // Populate year selector — current year + last 2
  const sel = document.getElementById('yearSel');
  const cur = new Date().getFullYear();
  for (let y = cur; y >= cur - 2; y--) {
    sel.insertAdjacentHTML('beforeend', `<option value="${y}">${y}</option>`);
  }
  sel.value = cur;
  await loadMine();
}

async function loadMine() {
  const year = parseInt(document.getElementById('yearSel').value, 10);
  const wrap = document.getElementById('psGrid');
  wrap.innerHTML = '<div class="pr-empty">Loading…</div>';
  try {
    const r = await apiRequest('/hr/payroll/payslips/mine?year=' + year);
    payslips = r.payslips || [];
    render();
  } catch (err) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(err.message || err)}</div>`;
  }
}

function render() {
  const wrap = document.getElementById('psGrid');
  if (!payslips.length) {
    wrap.innerHTML = `<div class="pr-empty">
      No payslips yet for this year.<br/>
      <span class="pr-meta">Your first payslip will appear here once HR locks the run for that month.</span>
    </div>`;
    return;
  }
  wrap.innerHTML = payslips.map(p => `
    <article class="my-ps-card">
      <header>
        <div class="my-ps-month">${escapeHtml(monthLabel(p.MonthNo, p.FYYear))}</div>
        <span class="pr-status pr-status-${p.Status}">${escapeHtml(p.Status)}</span>
      </header>
      <div class="my-ps-net">
        <div>Net Pay</div>
        <b>${fmtCur(p.NetPay)}</b>
      </div>
      <div class="my-ps-meta">
        <span>Gross <b>${fmtCur(p.MonthlyGross)}</b></span>
        <span>Deductions <b>${fmtCur(p.TotalDeductions)}</b></span>
      </div>
      <div class="my-ps-meta">
        <span>Period <b>${formatDate(p.PeriodStart)} → ${formatDate(p.PeriodEnd)}</b></span>
      </div>
      <div class="my-ps-meta">
        <span>Payable <b>${Number(p.PayableDays).toFixed(2)}/${p.DaysInMonth}</b></span>
        ${p.LopDays > 0 ? `<span>LOP <b style="color:var(--red);">${Number(p.LopDays).toFixed(2)} days</b></span>` : ''}
        ${p.PayDate ? `<span>Pay date <b>${formatDate(p.PayDate)}</b></span>` : ''}
      </div>
      <footer>
        <span class="pr-meta mono">${escapeHtml(p.PayslipNo || ('#' + p.PayslipId))}</span>
        <button class="btn btn-primary btn-sm" onclick="downloadPayslipPdf(${p.PayslipId}, ${JSON.stringify(p.PayslipNo || '').replace(/"/g,'&quot;')})">📄 Download PDF</button>
      </footer>
    </article>`).join('');
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
    const inCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    const fileName = `Payslip_${label || id}.pdf`;
    if (inCapacitor && typeof nativeSaveAndShare === 'function') {
      await nativeSaveAndShare(blob, fileName, { dialogTitle: 'Share payslip' });
    } else {
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (e) { alert(e.message || e); }
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
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
