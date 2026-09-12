// =====================================================================
// modules/hr/js/it-approvals.js — HR IT Declaration review (Phase 5D)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];

let declarations = [];
let sections = [];

Object.assign(window, { loadList, openDetail, decideItem, approveAll, rejectAll, viewProof });

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-it-approvals');
  if (!HR_ROLES.includes((user.role || '').toLowerCase())) {
    document.querySelector('.pr-wrap').innerHTML = '<div class="pr-empty">HR / admin only.</div>';
    return;
  }
  const sel = document.getElementById('fySel');
  const today = new Date();
  const fyNow = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  for (let f = fyNow; f >= fyNow - 1; f--) {
    sel.insertAdjacentHTML('beforeend', `<option value="${f}">FY${f}-${String((f+1)%100).padStart(2,'0')}</option>`);
  }
  try { const opts = await apiRequest('/hr/it-declaration/options'); sections = opts.sections || []; } catch (_) {}
  await loadList();
}

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
    // Re-render the currently-open detail by re-fetching
    const wrap = document.getElementById('detail');
    const head = wrap.querySelector('.pr-runhead-month');
    // Find declaration ID from the list state
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

function fmtN(n) { if (n == null) return '0'; return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
function formatLocal(iso) { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleString('en-IN', { hour12:false, day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' }); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
