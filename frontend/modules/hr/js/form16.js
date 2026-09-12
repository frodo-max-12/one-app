// =====================================================================
// modules/hr/js/form16.js — Form 16 page (Phase 5E)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];
let isHr = false;

Object.assign(window, { loadView, downloadPart, openUpload, closeUpload, submitUpload, generateAndDownload });

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-form16');
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
      const r = await apiRequest('/hr/form16/all?fy=' + fy);
      renderAll(r, fy);
    } else {
      const r = await apiRequest('/hr/form16/mine?fy=' + fy);
      renderMine(r, fy);
    }
  } catch (e) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(e.message || e)}</div>`;
  }
}

function renderMine(r, fy) {
  const wrap = document.getElementById('content');
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

function renderAll(r, fy) {
  const wrap = document.getElementById('content');
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

// HR upload Part A
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
    await loadView();
  } catch (e) { err.textContent = e.message || e; err.style.display = ''; }
}

// HR: trigger Part B aggregation then download
async function generateAndDownload(userId, fy) {
  try {
    // Generate (creates HRM_Form16 row if absent)
    const r = await apiRequest(`/hr/form16/${userId}/generate-part-b`, { method:'POST', body: { fy }});
    // Refetch list to get Form16Id
    const m = await apiRequest('/hr/form16/all?fy=' + fy);
    const emp = (m.employees || []).find(e => e.UserId === userId);
    if (!emp || !emp.Form16Id) {
      alert('Generated but row missing; reload page.');
      return;
    }
    await downloadPart(emp.Form16Id, 'part-b');
    await loadView();
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

function fmtCur(n) { if (n == null || n === '') return '—'; return '₹ ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function formatDate(iso) { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' }); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
