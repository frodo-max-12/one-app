// =====================================================================
// modules/hr/js/my-payroll.js — My Payroll (merged: Payslips + YTD + Form 16)
// Merged 2026-05-25: combined former my-payslips.js + ytd.js + form16.js.
// Lazy-loads YTD + Form 16 tabs on first click.
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];
let isHr = false;

// Tab data caches
let payslips      = [];
let ytdLoaded     = false;
let form16Loaded  = false;

Object.assign(window, {
  showTab, onFyChange,
  loadPayslips, downloadPayslipPdf,
  loadYtd, openYtdEmployeeDrill,
  loadForm16, downloadPart, openUpload, closeUpload, submitUpload, generateAndDownload,
});

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-my-payroll');

  isHr = HR_ROLES.includes((user.role || '').toLowerCase());

  // Build Year selector (Payslips tab) — current + last 2
  const yearSel = document.getElementById('yearSel');
  const cur = new Date().getFullYear();
  for (let y = cur; y >= cur - 2; y--) {
    yearSel.insertAdjacentHTML('beforeend', `<option value="${y}">${y}</option>`);
  }
  yearSel.value = cur;

  // Build FY selector (YTD + Form 16 tabs)
  const fySel = document.getElementById('fySel');
  const today = new Date();
  const fyNow = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  for (let f = fyNow; f >= fyNow - 2; f--) {
    fySel.insertAdjacentHTML('beforeend', `<option value="${f}">FY${f}-${String((f+1)%100).padStart(2,'0')}</option>`);
  }

  // Load default tab (Payslips)
  await loadPayslips();

  // Open specific tab via ?tab=ytd / ?tab=form16 (old bookmark redirect)
  const params = new URLSearchParams(window.location.search);
  const t = params.get('tab');
  if (t === 'ytd' || t === 'form16') showTab(t);
}

// ════════════════════════════════════════════════════════════════════════════
// TAB SWITCHER
// ════════════════════════════════════════════════════════════════════════════
function showTab(tab) {
  document.querySelectorAll('.ps-tabs .tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('paneTabPayslips').style.display = (tab === 'payslips') ? '' : 'none';
  document.getElementById('paneTabYtd').style.display      = (tab === 'ytd')      ? '' : 'none';
  document.getElementById('paneTabForm16').style.display   = (tab === 'form16')   ? '' : 'none';

  // Topbar context — different selectors per tab
  document.getElementById('yearSelWrap').style.display     = (tab === 'payslips') ? '' : 'none';
  document.getElementById('fySelWrap').style.display       = (tab !== 'payslips') ? '' : 'none';
  document.getElementById('viewModeWrap').style.display    = (tab !== 'payslips' && isHr) ? '' : 'none';

  if (tab === 'ytd' && !ytdLoaded)       { ytdLoaded = true;       loadYtd(); }
  if (tab === 'form16' && !form16Loaded) { form16Loaded = true;    loadForm16(); }
}

// FY change handler — routes to correct loader based on active tab
function onFyChange() {
  const active = document.querySelector('.ps-tabs .tab-btn.active')?.dataset.tab;
  if (active === 'ytd')    loadYtd();
  if (active === 'form16') loadForm16();
}

// ════════════════════════════════════════════════════════════════════════════
// PAYSLIPS TAB
// ════════════════════════════════════════════════════════════════════════════
async function loadPayslips() {
  const year = parseInt(document.getElementById('yearSel').value, 10);
  const wrap = document.getElementById('psGrid');
  wrap.innerHTML = '<div class="pr-empty">Loading…</div>';
  try {
    const r = await apiRequest('/hr/payroll/payslips/mine?year=' + year);
    payslips = r.payslips || [];
    renderPayslips();
  } catch (err) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(err.message || err)}</div>`;
  }
}

function renderPayslips() {
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

// ════════════════════════════════════════════════════════════════════════════
// YTD STATEMENT TAB
// ════════════════════════════════════════════════════════════════════════════
async function loadYtd() {
  const fy   = parseInt(document.getElementById('fySel').value, 10);
  const mode = isHr ? (document.getElementById('viewMode').value || 'mine') : 'mine';
  const wrap = document.getElementById('ytdContent');
  wrap.innerHTML = '<div class="pr-empty">Loading…</div>';
  try {
    if (mode === 'all') {
      const r = await apiRequest('/hr/payroll/ytd/all?fy=' + fy);
      renderYtdAll(r);
    } else {
      const r = await apiRequest('/hr/payroll/ytd/mine?fy=' + fy);
      renderYtdMine(r);
    }
  } catch (err) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(err.message || err)}</div>`;
  }
}

function renderYtdMine(r) {
  const wrap = document.getElementById('ytdContent');
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

function renderYtdAll(r) {
  const wrap = document.getElementById('ytdContent');
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
            <td class="r"><button class="btn btn-sm" onclick="openYtdEmployeeDrill(${e.UserId})">Detail</button></td>
          </tr>`).join('') || '<tr><td colspan="9" class="pr-empty">No payslips for this FY yet.</td></tr>'}
        </tbody>
      </table>
    </section>`;
}

async function openYtdEmployeeDrill(userId) {
  const fy = parseInt(document.getElementById('fySel').value, 10);
  try {
    const r = await apiRequest('/hr/payroll/ytd/employee/' + userId + '?fy=' + fy);
    renderYtdMine(r);
  } catch (e) { alert(e.message || e); }
}

// ════════════════════════════════════════════════════════════════════════════
// FORM 16 TAB
// ════════════════════════════════════════════════════════════════════════════
async function loadForm16() {
  const fy   = parseInt(document.getElementById('fySel').value, 10);
  const mode = isHr ? (document.getElementById('viewMode').value || 'mine') : 'mine';
  const wrap = document.getElementById('form16Content');
  wrap.innerHTML = '<div class="pr-empty">Loading…</div>';
  try {
    if (mode === 'all') {
      const r = await apiRequest('/hr/form16/all?fy=' + fy);
      renderForm16All(r, fy);
    } else {
      const r = await apiRequest('/hr/form16/mine?fy=' + fy);
      renderForm16Mine(r, fy);
    }
  } catch (e) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(e.message || e)}</div>`;
  }
}

function renderForm16Mine(r, fy) {
  const wrap = document.getElementById('form16Content');
  if (!r.forms || !r.forms.length) {
    wrap.innerHTML = `<div class="pr-empty">No Form 16 generated yet for FY${fy}-${String((fy+1)%100).padStart(2,'0')}.<br/>
      <span class="pr-meta">HR generates Part A from TRACES + Part B from your payslip data. Once available, you'll see download links here.</span></div>`;
    return;
  }
  wrap.innerHTML = r.forms.map(f => `
    <article class="pr-card pr-card-locked" style="cursor:default;">
      <header>
        <div class="pr-card-month">FY ${f.FYYear}-${String((f.FYYear+1)%100).padStart(2,'0')}</div>
        <span class="pr-status pr-status-locked">${escapeHtml(f.Regime || '—')}</span>
      </header>
      <div class="pr-card-kpis">
        <div><span>Gross</span><b>${fmtCur(f.GrossSalary)}</b></div>
        <div><span>Taxable</span><b>${fmtCur(f.TaxableIncome)}</b></div>
        <div><span>Tax</span><b>${fmtCur(f.TaxOnIncome)}</b></div>
        <div class="net"><span>TAN</span><b>${escapeHtml(f.TANNumber || '—')}</b></div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;">
        ${f.PartAFileName ? `<button class="btn btn-sm" onclick="downloadPart(${f.Form16Id}, 'part-a')">⇩ Part A (TRACES)</button>`
                          : `<span class="pr-meta">⏳ Part A pending HR upload</span>`}
        <button class="btn btn-sm btn-primary" onclick="downloadPart(${f.Form16Id}, 'part-b')">⇩ Part B (Local Summary)</button>
      </div>
    </article>`).join('');
}

function renderForm16All(r, fy) {
  const wrap = document.getElementById('form16Content');
  const rows = r.employees || [];
  wrap.innerHTML = `
    <section class="pr-table-wrap">
      <table class="pr-table">
        <thead><tr>
          <th>Emp Code</th><th>Name</th><th>Dept</th><th>PAN</th>
          <th class="r">Months Paid</th><th class="r">Gross</th><th class="r">Tax</th>
          <th>Part A</th><th>Part B</th><th></th>
        </tr></thead>
        <tbody>${rows.map(e => `
          <tr>
            <td class="mono">${escapeHtml(e.EmpCode || '—')}</td>
            <td>${escapeHtml(e.EmpName || '—')}</td>
            <td>${escapeHtml(e.Department || '—')}</td>
            <td class="mono">${escapeHtml(e.PAN || '—')}</td>
            <td class="r mono">${e.MonthsPaid || 0}</td>
            <td class="r mono">${fmtCur(e.GrossSalary)}</td>
            <td class="r mono">${fmtCur(e.TaxOnIncome)}</td>
            <td>${e.PartAFileName ? '✓ ' + formatDate(e.PartAUploadedAt) : '—'}</td>
            <td>${e.PartBGeneratedAt ? '✓ ' + formatDate(e.PartBGeneratedAt) : '—'}</td>
            <td class="r" style="white-space:nowrap;">
              <button class="btn btn-sm" onclick="openUpload(${e.UserId}, ${fy}, ${JSON.stringify(e.EmpName).replace(/"/g,'&quot;')})">↑ Part A</button>
              <button class="btn btn-sm btn-primary" onclick="generateAndDownload(${e.UserId}, ${fy})">⚙ Part B</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="10" class="pr-empty">No employees.</td></tr>'}
        </tbody>
      </table>
    </section>`;
}

function openUpload(userId, fy, name) {
  document.getElementById('upUserId').value = userId;
  document.getElementById('upFy').value     = fy;
  document.getElementById('upEmpName').textContent = name;
  document.getElementById('upTan').value    = '';
  document.getElementById('upAck').value    = '';
  document.getElementById('upFile').value   = '';
  document.getElementById('upErr').style.display = 'none';
  document.getElementById('uploadModal').hidden = false;
}
function closeUpload() { document.getElementById('uploadModal').hidden = true; }

async function submitUpload() {
  const userId = document.getElementById('upUserId').value;
  const fy     = document.getElementById('upFy').value;
  const file   = document.getElementById('upFile').files[0];
  const err    = document.getElementById('upErr');
  err.style.display = 'none';
  if (!file) { err.textContent = 'Pick a PDF file.'; err.style.display = ''; return; }
  if (file.size > 5 * 1024 * 1024) { err.textContent = 'Too large (5 MB cap).'; err.style.display = ''; return; }
  const fd = new FormData();
  fd.append('fy', fy);
  fd.append('tan', document.getElementById('upTan').value.trim());
  fd.append('form24QAckNo', document.getElementById('upAck').value.trim());
  fd.append('file', file);
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/form16/${userId}/upload-part-a?company=${encodeURIComponent(company)}`, {
      method:'POST',
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
      body: fd,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'HTTP ' + res.status); }
    closeUpload();
    await loadForm16();
  } catch (e) { err.textContent = e.message || e; err.style.display = ''; }
}

async function generateAndDownload(userId, fy) {
  try {
    await apiRequest(`/hr/form16/${userId}/generate-part-b`, { method:'POST', body: { fy }});
    const m = await apiRequest('/hr/form16/all?fy=' + fy);
    const emp = (m.employees || []).find(e => e.UserId === userId);
    if (!emp || !emp.Form16Id) { alert('Generated but row missing; reload page.'); return; }
    await downloadPart(emp.Form16Id, 'part-b');
    await loadForm16();
  } catch (e) { alert(e.message || e); }
}

async function downloadPart(form16Id, part) {
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/form16/${form16Id}/${part}?company=${encodeURIComponent(company)}`, {
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'HTTP ' + res.status); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert(e.message || e); }
}

// Show HR controls if applicable (auto-show View Mode selector if HR + on YTD/Form16 tab)
// — handled in showTab(); no separate code here.

// ── Helpers ──────────────────────────────────────────────────────────────────
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
