// =====================================================================
// modules/hr/js/it-declaration.js — IT Declaration (merged: Declaration + Projected Tax + Approvals)
// Merged 2026-05-25: combined former it-declaration.js + it-approvals.js.
// • Declaration + Projected Tax tabs: everyone (employee's own)
// • Approvals tab: HR / admin / operation head / director only (lazy-loaded)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];

// Declaration tab state
let sections    = [];
let declaration = null;
let items       = [];

// Approvals tab state
let declarations    = [];
let approvalsLoaded = false;

Object.assign(window, {
  loadDec, switchMode, saveRegime, openItem, closeItem, saveItem,
  deleteItem, submitDec, uploadProof, onFyChange,
  loadList, openDetail, decideItem, approveAll, rejectAll, viewProof,
});

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-it-declaration');

  // Reveal Approvals tab for HR roles
  const role = (user.role || '').toLowerCase();
  if (HR_ROLES.includes(role)) {
    document.getElementById('topApprovalsTab').style.display = '';
  }

  // FY selector — defaults to current FY
  const sel = document.getElementById('fySel');
  const today = new Date();
  const fyNow = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  for (let f = fyNow; f >= fyNow - 1; f--) {
    sel.insertAdjacentHTML('beforeend', `<option value="${f}">FY${f}-${String((f+1)%100).padStart(2,'0')}</option>`);
  }
  try { const opts = await apiRequest('/hr/it-declaration/options'); sections = opts.sections || []; } catch (_) {}
  await loadDec();

  // Open Approvals tab directly via ?tab=approvals (old bookmark redirect)
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab') === 'approvals' && HR_ROLES.includes(role)) {
    switchMode('approvals');
  }
}

// FY-selector change handler — routes to right loader based on current tab
function onFyChange() {
  const m = document.querySelector('.ps-tabs .tab-btn.active')?.dataset.mode || 'dec';
  if (m === 'approvals') loadList();
  else loadDec();
}

function switchMode(m) {
  document.querySelectorAll('.ps-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  document.getElementById('paneDec').style.display       = (m === 'dec')       ? '' : 'none';
  document.getElementById('paneStmt').style.display      = (m === 'stmt')      ? '' : 'none';
  document.getElementById('paneApprovals').style.display = (m === 'approvals') ? '' : 'none';

  // Topbar context — Status selector only on Approvals tab
  document.getElementById('stSelWrap').style.display = (m === 'approvals') ? '' : 'none';

  if (m === 'stmt') loadStatement();
  if (m === 'approvals' && !approvalsLoaded) {
    approvalsLoaded = true;
    loadList();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MY DECLARATION TAB (employee's own)
// ════════════════════════════════════════════════════════════════════════════
async function loadDec() {
  const fy = parseInt(document.getElementById('fySel').value, 10);
  try {
    const r = await apiRequest('/hr/it-declaration/mine?fy=' + fy);
    declaration = r.declaration;
    items = r.items || [];
    renderHead();
    renderSections();
  } catch (e) {
    document.getElementById('head').innerHTML = `<div class="pr-err">${escapeHtml(e.message || e)}</div>`;
  }
}

function renderHead() {
  const d = declaration;
  document.getElementById('head').innerHTML = `
    <div class="pr-runhead-left">
      <div class="pr-runhead-month">FY ${d.FYYear}-${String((d.FYYear+1)%100).padStart(2,'0')}</div>
      <h1>My IT Declaration</h1>
      <div class="pr-meta">Regime: <b>${escapeHtml(d.Regime)}</b> · Total declared: ₹ ${fmtN(d.TotalDeclared)}</div>
    </div>
    <div class="pr-runhead-right">
      <span class="pr-status pr-status-${d.Status}">${escapeHtml(d.Status)}</span>
      ${d.SubmittedAt ? `<div class="pr-meta" style="margin-top:6px;">Submitted ${formatLocal(d.SubmittedAt)}</div>` : ''}
      ${d.RejectionReason ? `<div class="pr-meta" style="margin-top:6px;color:var(--red);">Rejected: ${escapeHtml(d.RejectionReason)}</div>` : ''}
    </div>`;
  document.querySelectorAll('input[name="regime"]').forEach(r => r.checked = (r.value === d.Regime));
  const canEdit = ['draft','rejected'].includes(d.Status);
  document.getElementById('submitBtn').disabled = !canEdit || !items.length;
  document.getElementById('submitBtn').textContent = (d.Status === 'rejected') ? 'Resubmit for HR Review' : 'Submit for HR Review';
  document.getElementById('itStatus').textContent = canEdit
    ? `${items.length} item(s) declared`
    : (d.Status === 'submitted' ? 'Awaiting HR review — items locked' : 'Approved — items locked');
}

function renderSections() {
  const wrap = document.getElementById('itSections');
  const canEdit = ['draft','rejected'].includes(declaration.Status);
  wrap.innerHTML = sections.map(sec => {
    const secItems = items.filter(i => i.SectionCode === sec.code);
    const declared = secItems.reduce((a, i) => a + Number(i.DeclaredAmount), 0);
    const capLine = sec.cap != null ? `<span class="it-cap">${declared > sec.cap ? '⚠ ' : ''}Cap ₹${fmtN(sec.cap)}</span>` : '';
    return `
      <section class="it-sec">
        <header class="it-sec-head">
          <h3>${escapeHtml(sec.label)}</h3>
          <div class="it-sec-totals">
            <span>Declared ₹ <b>${fmtN(declared)}</b></span>
            ${capLine}
          </div>
          ${canEdit ? `<button class="btn btn-sm" onclick="openItem('${sec.code}', null)">+ Add</button>` : ''}
        </header>
        ${secItems.length ? `
          <ul class="it-items">
            ${secItems.map(i => `
              <li class="it-item it-item-${i.Status}">
                <div class="it-item-main">
                  <div><b>${escapeHtml(i.SubCategory || sec.code)}</b> <span class="pr-meta">₹ ${fmtN(i.DeclaredAmount)}</span></div>
                  ${i.Notes ? `<div class="pr-meta">${escapeHtml(i.Notes)}</div>` : ''}
                  ${i.Status === 'approved' ? `<div class="pr-meta" style="color:var(--green);">✓ Approved ₹ ${fmtN(i.ApprovedAmount ?? i.DeclaredAmount)}</div>` :
                    i.Status === 'rejected' ? `<div class="pr-meta" style="color:var(--red);">✗ Rejected${i.RejectionReason ? ': ' + escapeHtml(i.RejectionReason) : ''}</div>` : ''}
                  ${i.ProofFileName ? `<div class="pr-meta">📎 <a href="javascript:void(0)" onclick="downloadProof(${i.ItemId})">${escapeHtml(i.ProofFileName)}</a></div>` : `<div class="pr-meta" style="color:var(--amber);">⚠ No proof uploaded</div>`}
                </div>
                <div class="it-item-actions">
                  ${canEdit ? `
                    <button class="iconbtn" onclick="openItem('${sec.code}', ${i.ItemId})">✎</button>
                    <button class="iconbtn iconbtn-danger" onclick="deleteItem(${i.ItemId})">🗑</button>
                    <label class="iconbtn" title="Upload proof">📎<input type="file" style="display:none;" onchange="uploadProof(${i.ItemId}, this)" /></label>
                  ` : (i.ProofFileName ? '' : `<label class="iconbtn" title="Upload proof">📎<input type="file" style="display:none;" onchange="uploadProof(${i.ItemId}, this)" /></label>`)}
                </div>
              </li>`).join('')}
          </ul>` : '<div class="pr-meta it-empty-sec">No items declared.</div>'}
      </section>`;
  }).join('');
}

window.downloadProof = async function (itemId) {
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/it-declaration/items/${itemId}/proof?company=${encodeURIComponent(company)}`, {
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert(e.message || e); }
};

async function saveRegime(r) {
  try {
    await apiRequest('/hr/it-declaration/mine', { method:'POST', body: { fy: declaration.FYYear, regime: r }});
    declaration.Regime = r;
    renderHead();
  } catch (e) { alert(e.message || e); }
}

function openItem(secCode, itemId) {
  const sec = sections.find(s => s.code === secCode);
  if (!sec) return;
  const it = itemId ? items.find(x => x.ItemId === itemId) : null;
  document.getElementById('itModalTitle').textContent = it ? `Edit ${sec.label}` : `Add to ${sec.label}`;
  document.getElementById('itId').value     = itemId || '';
  document.getElementById('itSec').value    = secCode;
  document.getElementById('itSecLbl').value = sec.label;
  const sub = document.getElementById('itSub');
  sub.innerHTML = sec.subCategories.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
  sub.value     = it?.SubCategory || sec.subCategories[0];
  document.getElementById('itAmt').value    = it?.DeclaredAmount || '';
  document.getElementById('itNotes').value  = it?.Notes || '';
  document.getElementById('itErr').style.display = 'none';
  document.getElementById('itemModal').hidden = false;
}
function closeItem() { document.getElementById('itemModal').hidden = true; }

async function saveItem() {
  const id     = document.getElementById('itId').value;
  const sec    = document.getElementById('itSec').value;
  const sub    = document.getElementById('itSub').value;
  const amount = Number(document.getElementById('itAmt').value);
  const notes  = document.getElementById('itNotes').value.trim();
  const err    = document.getElementById('itErr');
  err.style.display = 'none';
  if (!Number.isFinite(amount) || amount < 0) { err.textContent = 'Invalid amount'; err.style.display = ''; return; }
  try {
    if (id) await apiRequest('/hr/it-declaration/mine/items/' + id, { method:'PATCH', body: { subCategory: sub, declaredAmount: amount, notes }});
    else    await apiRequest('/hr/it-declaration/mine/items',       { method:'POST',  body: { fy: declaration.FYYear, sectionCode: sec, subCategory: sub, declaredAmount: amount, notes }});
    closeItem();
    await loadDec();
  } catch (e) { err.textContent = e.message || e; err.style.display = ''; }
}

async function deleteItem(id) {
  if (!confirm('Delete this item?')) return;
  try { await apiRequest('/hr/it-declaration/mine/items/' + id, { method:'DELETE' }); await loadDec(); }
  catch (e) { alert(e.message || e); }
}

async function uploadProof(itemId, inputEl) {
  if (!inputEl.files || !inputEl.files[0]) return;
  if (inputEl.files[0].size > 5 * 1024 * 1024) return alert('File too large (max 5 MB).');
  const fd = new FormData(); fd.append('file', inputEl.files[0]);
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/it-declaration/items/${itemId}/proof?company=${encodeURIComponent(company)}`, {
      method: 'POST',
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
      body: fd,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'HTTP ' + res.status); }
    inputEl.value = '';
    await loadDec();
  } catch (e) { alert(e.message || e); }
}

async function submitDec() {
  if (!confirm('Submit for HR review? You cannot edit items after this until HR responds.')) return;
  try {
    await apiRequest('/hr/it-declaration/mine/submit', { method:'POST', body: { fy: declaration.FYYear }});
    await loadDec();
  } catch (e) { alert(e.message || e); }
}

// ════════════════════════════════════════════════════════════════════════════
// PROJECTED TAX TAB (employee's own)
// ════════════════════════════════════════════════════════════════════════════
async function loadStatement() {
  const fy = parseInt(document.getElementById('fySel').value, 10);
  const wrap = document.getElementById('paneStmt');
  wrap.innerHTML = '<div class="pr-loading">Loading…</div>';
  try {
    const r = await apiRequest('/hr/it-declaration/statement?fy=' + fy);
    const tax  = r.tax || {};
    const reco = r.regimeRecommendation || {};
    const recoOther = (r.declaration.Regime === reco.recommendedRegime) ? null : reco.recommendedRegime;
    const recoBanner = reco.annualSaving > 0 ? `
      <div class="it-reco" style="margin-bottom:14px; padding:12px 16px; border-radius:10px; border:1px solid ${recoOther ? 'rgba(240,162,46,0.4)' : 'rgba(52,199,123,0.4)'}; background: ${recoOther ? 'rgba(240,162,46,0.08)' : 'rgba(52,199,123,0.08)'};">
        ${recoOther
          ? `💡 <b>${escapeHtml(reco.recommendedRegime)} regime</b> would save you about <b>${fmtCur(reco.monthlySaving)}/month</b> (₹${fmtN(reco.annualSaving)}/yr) compared to your current <b>${escapeHtml(r.declaration.Regime)}</b> selection. You can switch on the Declaration tab.`
          : `✓ Your selected <b>${escapeHtml(r.declaration.Regime)} regime</b> is the better choice for you — saves ₹${fmtN(reco.annualSaving)}/yr vs the ${escapeHtml(r.declaration.Regime === 'Old' ? 'New' : 'Old')} regime.`}
      </div>` : '';

    const hraBox = r.hraExemption?.exempt > 0 ? `
      <section class="pr-table-wrap">
        <h3 style="padding:12px 14px; margin:0; font-size:14px; color:var(--text2);">HRA Exemption u/s 10(13A)${r.isMetro ? ' (metro 50%)' : ' (non-metro 40%)'}</h3>
        <table class="pr-table">
          <thead><tr><th>Component</th><th class="r">Annual</th></tr></thead>
          <tbody>
            <tr><td>Actual HRA component (from payslip)</td><td class="r mono">${fmtCur(r.hraExemption.formula.actualHra)}</td></tr>
            <tr><td>Rent paid - 10% of Basic</td><td class="r mono">${fmtCur(r.hraExemption.formula.rentExcess)}</td></tr>
            <tr><td>${r.hraExemption.formula.pctRate}% of Basic salary cap</td><td class="r mono">${fmtCur(r.hraExemption.formula.pctCap)}</td></tr>
            <tr style="background:var(--bg3);"><td><b>Exemption (min of above)</b></td><td class="r mono"><b>${fmtCur(r.hraExemption.exempt)}</b></td></tr>
          </tbody>
        </table>
      </section>` : '';

    wrap.innerHTML = `
      ${recoBanner}
      <div class="pr-kpis">
        <div class="kpi-card kpi-blue"><div class="kpi-lbl">YTD Gross</div><div class="kpi-num">${fmtCur(r.ytd.gross)}</div></div>
        <div class="kpi-card kpi-green"><div class="kpi-lbl">Projected FY Gross</div><div class="kpi-num">${fmtCur(r.projectedAnnualGross)}</div></div>
        <div class="kpi-card kpi-teal"><div class="kpi-lbl">Taxable Income</div><div class="kpi-num">${fmtCur(r.taxableIncome)}</div></div>
        <div class="kpi-card kpi-red"><div class="kpi-lbl">Total Tax (FY)</div><div class="kpi-num">${fmtCur(tax.totalTax)}</div></div>
      </div>

      <section class="pr-table-wrap">
        <h3 style="padding:12px 14px; margin:0; font-size:14px; color:var(--text2);">Tax Computation (${escapeHtml(r.declaration.Regime)} regime)</h3>
        <table class="pr-table">
          <tbody>
            <tr><td>Projected FY Gross Salary</td><td class="r mono">${fmtCur(r.projectedAnnualGross)}</td></tr>
            <tr><td>Less: Standard Deduction u/s 16(ia)</td><td class="r mono">- ${fmtCur(r.standardDeduction)}</td></tr>
            <tr><td>Less: Professional Tax u/s 16(iii)</td><td class="r mono">- ${fmtCur(r.annualPT)}</td></tr>
            ${r.declaration.Regime === 'Old' ? `
              <tr><td>Less: HRA Exemption u/s 10(13A)</td><td class="r mono">- ${fmtCur(r.hraExemption.exempt)}</td></tr>
              <tr><td>Less: Chapter VI-A deductions (80C/80D/etc.)</td><td class="r mono">- ${fmtCur(r.chapterVIA)}</td></tr>
            ` : `
              <tr><td><span class="pr-meta">HRA + Chapter VI-A not available under New regime</span></td><td class="r mono">0.00</td></tr>
            `}
            <tr style="background:var(--bg3); font-weight:600;"><td>Taxable Income</td><td class="r mono"><b>${fmtCur(r.taxableIncome)}</b></td></tr>
            <tr><td>Base Tax (slab-wise)</td><td class="r mono">${fmtCur(tax.baseTax)}</td></tr>
            ${tax.rebate87A > 0 ? `<tr><td>Less: Section 87A Rebate</td><td class="r mono" style="color:var(--green);">- ${fmtCur(tax.rebate87A)}</td></tr>` : ''}
            ${tax.surcharge > 0 ? `<tr><td>Add: Surcharge</td><td class="r mono" style="color:var(--amber);">+ ${fmtCur(tax.surcharge)}</td></tr>` : ''}
            <tr><td>Add: Health & Education Cess (4%)</td><td class="r mono">+ ${fmtCur(tax.cess)}</td></tr>
            <tr style="background:rgba(242,87,87,0.07); font-weight:700;"><td><b>Total Tax Payable</b></td><td class="r mono"><b style="color:var(--red);">${fmtCur(tax.totalTax)}</b></td></tr>
          </tbody>
        </table>
      </section>

      ${hraBox}

      <section class="pr-table-wrap">
        <h3 style="padding:12px 14px; margin:0; font-size:14px; color:var(--text2);">Declared Deductions by Section</h3>
        <table class="pr-table">
          <thead><tr><th>Section</th><th class="r">Declared</th><th class="r">Effective (after caps)</th><th class="r">Section Cap</th></tr></thead>
          <tbody>${(r.sections || []).map(s => `
            <tr>
              <td>${escapeHtml(s.sectionLabel || s.sectionCode)}</td>
              <td class="r mono">${fmtCur(s.declared)}</td>
              <td class="r mono"><b>${fmtCur(s.effectiveDeduction)}</b></td>
              <td class="r mono">${s.cap != null ? fmtCur(s.cap) : '—'}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="pr-empty">No items declared.</td></tr>'}
          </tbody>
        </table>
      </section>

      <div class="pr-meta" style="padding:12px 14px;">
        Metro for HRA: <b>${r.isMetro ? 'Yes' : 'No'}</b> (set per-employee in HR profile) ·
        Months remaining in FY: <b>${r.monthsRemaining}</b>
      </div>
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(e.message || e)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// APPROVALS TAB (HR only)
// ════════════════════════════════════════════════════════════════════════════
async function loadList() {
  const fy = document.getElementById('fySel').value;
  const st = document.getElementById('stSel').value;
  const tbody = document.getElementById('listTbody');
  tbody.innerHTML = '<tr><td colspan="10" class="pr-loading">Loading…</td></tr>';
  try {
    const r = await apiRequest(`/hr/it-declaration/all?fy=${fy}${st ? '&status=' + st : ''}`);
    declarations = r.declarations || [];
    if (!declarations.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="pr-empty">No declarations match this filter.</td></tr>';
      document.getElementById('detail').style.display = 'none';
      return;
    }
    tbody.innerHTML = declarations.map(d => `
      <tr>
        <td class="mono">${escapeHtml(d.EmpCode || '—')}</td>
        <td>${escapeHtml(d.EmpName || '—')}</td>
        <td>${escapeHtml(d.Department || '—')}</td>
        <td>${escapeHtml(d.Regime)}</td>
        <td class="r mono">${d.ItemCount}</td>
        <td class="r mono"${d.PendingCount > 0 ? ' style="color:var(--amber);"' : ''}>${d.PendingCount}</td>
        <td class="r mono">₹ ${fmtN(d.TotalDeclared)}</td>
        <td><span class="pr-status pr-status-${d.Status}">${escapeHtml(d.Status)}</span>${d.WfCode ? ` <span class="wf-badge" title="${escapeHtml(d.WfName || d.WfCode)}">L${d.WfCurrentLevel}/${d.WfTotalLevels}</span>` : ''}</td>
        <td>${d.SubmittedAt ? formatLocal(d.SubmittedAt) : '—'}</td>
        <td class="r"><button class="btn btn-sm" onclick="openDetail(${d.DeclarationId})">Review</button></td>
      </tr>`).join('');
  } catch (e) { tbody.innerHTML = `<tr><td colspan="10" class="pr-empty pr-err">${escapeHtml(e.message || e)}</td></tr>`; }
}

async function openDetail(id) {
  const wrap = document.getElementById('detail');
  wrap.style.display = '';
  wrap.innerHTML = '<div class="pr-loading">Loading…</div>';
  try {
    const r = await apiRequest('/hr/it-declaration/' + id);
    renderDetail(r.declaration, r.items);
  } catch (e) { wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(e.message || e)}</div>`; }
}

function renderDetail(d, items) {
  const wrap = document.getElementById('detail');
  const grouped = {};
  items.forEach(i => { (grouped[i.SectionCode] = grouped[i.SectionCode] || []).push(i); });
  const isLocked = ['approved'].includes(d.Status);
  const headerActions = !isLocked && d.Status !== 'draft' ? `
    <button class="btn btn-success" onclick="approveAll(${d.DeclarationId})">✓ Approve Declaration</button>
    <button class="btn btn-danger"  onclick="rejectAll(${d.DeclarationId})">✗ Reject Declaration</button>` : '';

  wrap.innerHTML = `
    <div class="pr-runhead">
      <div class="pr-runhead-left">
        <div class="pr-runhead-month">${escapeHtml(d.EmpName)} · ${escapeHtml(d.EmpCode || '—')}</div>
        <h1>FY ${d.FYYear}-${String((d.FYYear+1)%100).padStart(2,'0')} — ${escapeHtml(d.Regime)} regime</h1>
        <div class="pr-meta">${escapeHtml(d.Designation || '')} · ${escapeHtml(d.Department || '')} · PAN ${escapeHtml(d.PAN || '—')}</div>
      </div>
      <div class="pr-runhead-right">
        <span class="pr-status pr-status-${d.Status}">${escapeHtml(d.Status)}</span>
        <div class="pr-meta" style="margin-top:6px;">Submitted ${d.SubmittedAt ? formatLocal(d.SubmittedAt) : '—'}</div>
        <div style="margin-top:10px; display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">${headerActions}</div>
      </div>
    </div>
    ${sections.filter(s => grouped[s.code]).map(sec => `
      <section class="it-sec">
        <header class="it-sec-head">
          <h3>${escapeHtml(sec.label)}</h3>
          <div class="it-sec-totals">
            ${sec.cap != null ? `<span class="it-cap">Cap ₹${fmtN(sec.cap)}</span>` : ''}
          </div>
        </header>
        <ul class="it-items">
          ${grouped[sec.code].map(i => `
            <li class="it-item it-item-${i.Status}">
              <div class="it-item-main">
                <div><b>${escapeHtml(i.SubCategory || sec.code)}</b> <span class="pr-meta">declared ₹ ${fmtN(i.DeclaredAmount)}</span></div>
                ${i.Notes ? `<div class="pr-meta">${escapeHtml(i.Notes)}</div>` : ''}
                ${i.ProofFileName ? `<div class="pr-meta">📎 <a href="javascript:void(0)" onclick="viewProof(${i.ItemId})">${escapeHtml(i.ProofFileName)}</a></div>` : `<div class="pr-meta" style="color:var(--red);">⚠ No proof</div>`}
                ${i.Status === 'approved' ? `<div class="pr-meta" style="color:var(--green);">✓ Approved ₹ ${fmtN(i.ApprovedAmount ?? i.DeclaredAmount)}</div>` :
                  i.Status === 'rejected' ? `<div class="pr-meta" style="color:var(--red);">✗ ${escapeHtml(i.RejectionReason || 'Rejected')}</div>` : ''}
              </div>
              <div class="it-item-actions" style="flex-direction:column; gap:4px;">
                ${i.Status !== 'approved' ? `
                  <button class="btn btn-sm btn-success" onclick="decideItem(${i.ItemId}, 'approved', ${i.DeclaredAmount})">✓ Approve full</button>
                  <button class="btn btn-sm" onclick="decideItem(${i.ItemId}, 'approved-partial', ${i.DeclaredAmount})">¼ Partial</button>
                ` : ''}
                ${i.Status !== 'rejected' ? `<button class="btn btn-sm btn-danger" onclick="decideItem(${i.ItemId}, 'rejected')">✗ Reject</button>` : ''}
              </div>
            </li>`).join('')}
        </ul>
      </section>`).join('')}
  `;
}

async function decideItem(itemId, kind, declaredAmount) {
  let body = {};
  if (kind === 'approved') body = { decision: 'approved' };
  else if (kind === 'approved-partial') {
    const a = prompt(`Approved amount (declared was ₹${declaredAmount}):`, declaredAmount);
    if (a == null) return;
    const num = Number(a);
    if (!Number.isFinite(num) || num < 0) return alert('Invalid amount');
    body = { decision: 'approved', approvedAmount: num };
  } else if (kind === 'rejected') {
    const r = prompt('Rejection reason:');
    if (!r) return;
    body = { decision: 'rejected', rejectionReason: r };
  }
  try {
    await apiRequest('/hr/it-declaration/items/' + itemId + '/decision', { method:'PATCH', body });
    const wrap = document.getElementById('detail');
    const head = wrap.querySelector('.pr-runhead-month');
    const open = declarations.find(d => head && head.textContent.includes(d.EmpName));
    if (open) openDetail(open.DeclarationId);
    await loadList();
  } catch (e) { alert(e.message || e); }
}

async function approveAll(decId) {
  if (!confirm('Approve this declaration? All items must already be decided.')) return;
  try { await apiRequest('/hr/it-declaration/' + decId + '/approve', { method:'POST' }); await loadList(); document.getElementById('detail').style.display = 'none'; }
  catch (e) { alert(e.message || e); }
}
async function rejectAll(decId) {
  const r = prompt('Rejection reason (the employee will see this):');
  if (!r) return;
  try { await apiRequest('/hr/it-declaration/' + decId + '/reject', { method:'POST', body: { reason: r }}); await loadList(); document.getElementById('detail').style.display = 'none'; }
  catch (e) { alert(e.message || e); }
}

async function viewProof(itemId) {
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/it-declaration/items/${itemId}/proof?company=${encodeURIComponent(company)}`, {
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert(e.message || e); }
}

// ── Helpers (shared across all 3 tabs) ──
function fmtN(n)   { if (n == null) return '0'; return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
function fmtCur(n) { if (n == null || isNaN(n)) return '₹ 0'; return '₹ ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
function formatLocal(iso) { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleString('en-IN', { hour12:false, day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' }); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }
