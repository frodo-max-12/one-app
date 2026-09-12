// =====================================================================
// modules/hr/js/payroll-structure.js — Salary Structure foundation (Phase 5A)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];

let allComponents = [];
let allStructures = [];
let allEmployees  = [];
let activeTab     = 'components';

Object.assign(window, {
  switchTab,
  openCompEdit, closeCompEdit, submitCompEdit, updateCmDefaultHint,
  openStructEdit, closeStructEdit, submitStructEdit,
  openAssign, closeAssign, submitAssign, debouncePreview, livePreview,
  archiveComponent, archiveStructure, openHistory, renderEmployees,
});

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-payroll-structure');
  const role = (user.role || '').toLowerCase();
  if (!HR_ROLES.includes(role)) {
    document.querySelector('.ps-wrap').innerHTML =
      '<div class="ps-loading">HR / admin only — contact HR if you need this.</div>';
    return;
  }
  await Promise.all([loadComponents(), loadStructures()]);
  // Don't auto-load employees; lazy-load when tab opens
}

function switchTab(t) {
  activeTab = t;
  document.querySelectorAll('.ps-tabs .tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === t));
  document.getElementById('paneComponents').style.display = (t === 'components') ? '' : 'none';
  document.getElementById('paneStructures').style.display = (t === 'structures') ? '' : 'none';
  document.getElementById('paneEmployees').style.display  = (t === 'employees')  ? '' : 'none';
  if (t === 'employees' && !allEmployees.length) loadEmployees();
}

// ════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ════════════════════════════════════════════════════════════════════════════
async function loadComponents() {
  try {
    const r = await apiRequest('/hr/payroll-structure/components');
    allComponents = r.components || [];
    renderComponents();
  } catch (e) { showLoadErr('compTbody', 10, e); }
}

function renderComponents() {
  const tbody = document.getElementById('compTbody');
  if (!allComponents.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="ps-empty">No components.</td></tr>';
    return;
  }
  tbody.innerHTML = allComponents.map(c => `
    <tr>
      <td class="mono">${escapeHtml(c.Code)}</td>
      <td>${escapeHtml(c.Name)}</td>
      <td><span class="pill pill-${c.Kind.toLowerCase()}">${escapeHtml(c.Kind)}</span></td>
      <td>${escapeHtml(c.Taxability)}</td>
      <td class="mono">${escapeHtml(c.FormulaType)}</td>
      <td class="r mono">${c.DefaultValue == null ? '—' : fmtNum(c.DefaultValue)}</td>
      <td>${c.IsStatutoryPF  ? '✓' : '—'}</td>
      <td>${c.IsStatutoryESI ? '✓' : '—'}</td>
      <td>${c.IsStatutoryPT  ? '✓' : '—'}</td>
      <td class="r">
        <button class="iconbtn" title="Edit" onclick="openCompEdit(${c.ComponentId})">✎</button>
        <button class="iconbtn iconbtn-danger" title="Archive" onclick="archiveComponent(${c.ComponentId})">🗑</button>
      </td>
    </tr>`).join('');
}

function openCompEdit(id) {
  const c = id ? allComponents.find(x => x.ComponentId === id) : null;
  document.getElementById('compModalTitle').textContent = c ? 'Edit Component' : 'New Component';
  document.getElementById('cmId').value    = c?.ComponentId || '';
  document.getElementById('cmCode').value  = c?.Code || '';
  document.getElementById('cmCode').disabled = !!c;   // can't change Code after create
  document.getElementById('cmName').value  = c?.Name || '';
  document.getElementById('cmKind').value  = c?.Kind || 'Earning';
  document.getElementById('cmTax').value   = c?.Taxability || 'Taxable';
  document.getElementById('cmFt').value    = c?.FormulaType || 'Fixed';
  document.getElementById('cmDef').value   = c?.DefaultValue ?? '';
  document.getElementById('cmPF').checked  = !!c?.IsStatutoryPF;
  document.getElementById('cmESI').checked = !!c?.IsStatutoryESI;
  document.getElementById('cmPT').checked  = !!c?.IsStatutoryPT;
  document.getElementById('cmOrder').value = c?.DisplayOrder || 50;
  document.getElementById('cmErr').style.display = 'none';
  updateCmDefaultHint();
  document.getElementById('compModal').hidden = false;
}
function closeCompEdit() { document.getElementById('compModal').hidden = true; }
function updateCmDefaultHint() {
  const t = document.getElementById('cmFt').value;
  const hint = document.getElementById('cmDefHint');
  const inp  = document.getElementById('cmDef');
  if (t === 'Fixed')         { hint.textContent = 'Default value (₹ per month)'; inp.disabled = false; }
  else if (t.startsWith('PctOf')) { hint.textContent = `Default value (% — e.g. ${t === 'PctOfBasic' ? '40' : '50'})`; inp.disabled = false; }
  else if (t === 'Slab' || t === 'Balancer' || t === 'Manual') { hint.textContent = 'Not used for this formula'; inp.value = ''; inp.disabled = true; }
}
async function submitCompEdit() {
  const id = document.getElementById('cmId').value;
  const err = document.getElementById('cmErr');
  err.style.display = 'none';
  const body = {
    code:         document.getElementById('cmCode').value.trim().toUpperCase(),
    name:         document.getElementById('cmName').value.trim(),
    kind:         document.getElementById('cmKind').value,
    taxability:   document.getElementById('cmTax').value,
    formulaType:  document.getElementById('cmFt').value,
    defaultValue: document.getElementById('cmDef').value === '' ? null : Number(document.getElementById('cmDef').value),
    isStatutoryPF:  document.getElementById('cmPF').checked,
    isStatutoryESI: document.getElementById('cmESI').checked,
    isStatutoryPT:  document.getElementById('cmPT').checked,
    displayOrder: parseInt(document.getElementById('cmOrder').value, 10) || 50,
  };
  if (!body.name) return showErr(err, 'Name is required');
  try {
    if (id) await apiRequest('/hr/payroll-structure/components/' + id, { method:'PATCH', body });
    else    await apiRequest('/hr/payroll-structure/components',       { method:'POST',  body });
    closeCompEdit();
    await loadComponents();
  } catch (e) { showErr(err, e.message || e); }
}
async function archiveComponent(id) {
  if (!confirm('Archive this component? Structures using it stay intact.')) return;
  try {
    await apiRequest('/hr/payroll-structure/components/' + id, { method:'DELETE' });
    await loadComponents();
  } catch (e) { alert(e.message || e); }
}

// ════════════════════════════════════════════════════════════════════════════
// STRUCTURES
// ════════════════════════════════════════════════════════════════════════════
async function loadStructures() {
  try {
    const r = await apiRequest('/hr/payroll-structure/structures');
    allStructures = r.structures || [];
    renderStructures();
  } catch (e) { document.getElementById('structCards').innerHTML = `<div class="ps-loading ps-err">${escapeHtml(e.message)}</div>`; }
}

function renderStructures() {
  const wrap = document.getElementById('structCards');
  if (!allStructures.length) { wrap.innerHTML = '<div class="ps-empty">No structures yet.</div>'; return; }
  wrap.innerHTML = allStructures.map(s => `
    <article class="ps-card">
      <header>
        <div class="mono ps-card-code">${escapeHtml(s.Code)}</div>
        <div class="ps-card-actions">
          <button class="iconbtn" title="Edit" onclick="openStructEdit(${s.StructureId})">✎</button>
          <button class="iconbtn iconbtn-danger" title="Archive" onclick="archiveStructure(${s.StructureId})">🗑</button>
        </div>
      </header>
      <h3>${escapeHtml(s.Name)}</h3>
      ${s.Description ? `<p class="ps-card-desc">${escapeHtml(s.Description)}</p>` : ''}
      <div class="ps-card-meta">
        <span><b>${s.CompCount || 0}</b> components</span>
        <span><b>${s.InUseCount || 0}</b> in use</span>
      </div>
    </article>`).join('');
}

async function openStructEdit(id) {
  const isNew = !id;
  document.getElementById('structModalTitle').textContent = isNew ? 'New Structure' : 'Edit Structure';
  document.getElementById('smId').value   = id || '';
  document.getElementById('smErr').style.display = 'none';
  const listEl = document.getElementById('smCompList');
  listEl.innerHTML = '<div class="ps-empty-sm">Loading components…</div>';

  if (!allComponents.length) await loadComponents();
  let selected = new Set();
  if (!isNew) {
    try {
      const r = await apiRequest('/hr/payroll-structure/structures/' + id);
      document.getElementById('smCode').value = r.structure.Code || '';
      document.getElementById('smCode').disabled = true;
      document.getElementById('smName').value = r.structure.Name || '';
      document.getElementById('smDesc').value = r.structure.Description || '';
      selected = new Set((r.components || []).map(c => c.ComponentId));
    } catch (e) { showErr(document.getElementById('smErr'), e.message || e); }
  } else {
    document.getElementById('smCode').value = '';
    document.getElementById('smCode').disabled = false;
    document.getElementById('smName').value = '';
    document.getElementById('smDesc').value = '';
  }
  listEl.innerHTML = allComponents.map(c => `
    <label class="ps-chk-row">
      <input type="checkbox" value="${c.ComponentId}" ${selected.has(c.ComponentId) ? 'checked' : ''} />
      <span class="mono">${escapeHtml(c.Code)}</span>
      <span>${escapeHtml(c.Name)}</span>
      <span class="ps-meta">${escapeHtml(c.Kind)} · ${escapeHtml(c.FormulaType)}${c.DefaultValue != null ? ' · ' + fmtNum(c.DefaultValue) : ''}</span>
    </label>`).join('');
  document.getElementById('structModal').hidden = false;
}
function closeStructEdit() { document.getElementById('structModal').hidden = true; }
async function submitStructEdit() {
  const id = document.getElementById('smId').value;
  const err = document.getElementById('smErr');
  err.style.display = 'none';
  const checked = Array.from(document.querySelectorAll('#smCompList input[type="checkbox"]:checked'))
    .map(i => parseInt(i.value, 10));
  if (!checked.length) return showErr(err, 'Pick at least one component.');
  const body = {
    name:         document.getElementById('smName').value.trim(),
    description:  document.getElementById('smDesc').value.trim(),
    componentIds: checked,
  };
  if (!id) body.code = document.getElementById('smCode').value.trim().toUpperCase();
  if (!body.name) return showErr(err, 'Name is required.');
  if (!id && !body.code) return showErr(err, 'Code is required.');
  try {
    if (id) await apiRequest('/hr/payroll-structure/structures/' + id, { method:'PATCH', body });
    else    await apiRequest('/hr/payroll-structure/structures',       { method:'POST',  body });
    closeStructEdit();
    await loadStructures();
  } catch (e) { showErr(err, e.message || e); }
}
async function archiveStructure(id) {
  if (!confirm('Archive this structure? Will be refused if any active employee salary uses it.')) return;
  try {
    await apiRequest('/hr/payroll-structure/structures/' + id, { method:'DELETE' });
    await loadStructures();
  } catch (e) { alert(e.message || e); }
}

// ════════════════════════════════════════════════════════════════════════════
// EMPLOYEE SALARIES
// ════════════════════════════════════════════════════════════════════════════
async function loadEmployees() {
  try {
    const r = await apiRequest('/hr/payroll-structure/employees');
    allEmployees = r.employees || [];
    renderEmployees();
  } catch (e) { showLoadErr('empTbody', 9, e); }
}

function renderEmployees() {
  const q = (document.getElementById('empSearch').value || '').trim().toLowerCase();
  const tbody = document.getElementById('empTbody');
  let rows = allEmployees;
  if (q) rows = rows.filter(e =>
    (e.Name || '').toLowerCase().includes(q) ||
    (e.EmpCode || '').toLowerCase().includes(q) ||
    (e.Department || '').toLowerCase().includes(q) ||
    (e.Designation || '').toLowerCase().includes(q));
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="ps-empty">No employees.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(e => `
    <tr>
      <td class="mono">${escapeHtml(e.EmpCode || '—')}</td>
      <td>${escapeHtml(e.Name || '—')}</td>
      <td>${escapeHtml(e.Department || '—')}</td>
      <td>${escapeHtml(e.Designation || '—')}</td>
      <td>${e.StructureCode ? `<span class="mono">${escapeHtml(e.StructureCode)}</span><div class="ps-meta">${escapeHtml(e.StructureName || '')}</div>` : '<span class="ps-meta">—</span>'}</td>
      <td class="r mono">${e.CurrentCTC ? fmtCur(e.CurrentCTC) : '—'}</td>
      <td class="r mono">${e.CurrentMonthly ? fmtCur(e.CurrentMonthly) : '—'}</td>
      <td>${e.EffectiveFrom ? fmtDate(e.EffectiveFrom) : '—'}</td>
      <td class="r"><button class="btn btn-sm" onclick="openAssign(${e.UserId})">${e.SalaryId ? 'Update' : 'Assign'}</button></td>
    </tr>`).join('');
}

let previewTimer = null;
function debouncePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(livePreview, 400); }

async function openAssign(userId) {
  const emp = allEmployees.find(x => x.UserId === userId);
  if (!emp) return;
  document.getElementById('asEmpName').textContent = `${emp.Name} (${emp.EmpCode || '—'})`;
  document.getElementById('asUserId').value = userId;
  document.getElementById('asCtc').value = emp.CurrentCTC || '';
  document.getElementById('asEff').value = new Date().toISOString().slice(0, 10);
  document.getElementById('asRem').value = '';
  document.getElementById('asErr').style.display = 'none';

  // Populate structure dropdown
  const sel = document.getElementById('asStructure');
  sel.innerHTML = (allStructures || []).map(s => `<option value="${s.StructureId}">${escapeHtml(s.Code)} — ${escapeHtml(s.Name)}</option>`).join('');
  if (emp.StructureCode) {
    const match = allStructures.find(s => s.Code === emp.StructureCode);
    if (match) sel.value = match.StructureId;
  }

  document.getElementById('asPreview').innerHTML = '<div class="ps-preview-empty">Enter CTC to see breakdown…</div>';

  // Load history
  try {
    const r = await apiRequest('/hr/payroll-structure/employees/' + userId + '/salary');
    const list = document.getElementById('asHistoryList');
    if (!r.salaries || !r.salaries.length) {
      list.innerHTML = '<div class="ps-empty-sm">No prior assignments.</div>';
    } else {
      list.innerHTML = r.salaries.map(s => `
        <div class="ps-history-row">
          <span class="status-${(s.Status||'').toLowerCase()}">${escapeHtml(s.Status)}</span>
          <span>${escapeHtml(s.StructureName || s.StructureCode || '')}</span>
          <span class="mono">${fmtCur(s.CTC)}/yr · ${fmtCur(s.MonthlyGross)}/mo</span>
          <span class="ps-meta">${fmtDate(s.EffectiveFrom)} → ${s.EffectiveTo ? fmtDate(s.EffectiveTo) : 'now'}</span>
          ${s.Remarks ? `<div class="ps-meta">${escapeHtml(s.Remarks)}</div>` : ''}
        </div>`).join('');
    }
  } catch (_) {}

  document.getElementById('assignModal').hidden = false;
  livePreview();
}
function closeAssign() { document.getElementById('assignModal').hidden = true; }

async function livePreview() {
  const structureId = document.getElementById('asStructure').value;
  const ctc         = Number(document.getElementById('asCtc').value);
  const wrap        = document.getElementById('asPreview');
  if (!structureId) { wrap.innerHTML = '<div class="ps-preview-empty">Pick a structure.</div>'; return; }
  if (!ctc || ctc < 0) { wrap.innerHTML = '<div class="ps-preview-empty">Enter a valid CTC.</div>'; return; }
  try {
    const r = await apiRequest(`/hr/payroll-structure/preview?structureId=${structureId}&ctc=${ctc}`);
    renderPreview(wrap, r);
  } catch (e) {
    wrap.innerHTML = `<div class="ps-preview-empty ps-err">${escapeHtml(e.message || e)}</div>`;
  }
}

function renderPreview(wrap, r) {
  const lines = r.lines || [];
  if (!lines.length) { wrap.innerHTML = '<div class="ps-preview-empty">Structure has no components.</div>'; return; }
  const earnings   = lines.filter(l => l.kind === 'Earning');
  const deductions = lines.filter(l => l.kind === 'Deduction');
  const reimbs     = lines.filter(l => l.kind === 'Reimbursement');
  const sumE = earnings  .reduce((s, l) => s + l.monthly, 0);
  const sumD = deductions.reduce((s, l) => s + l.monthly, 0);
  const netMonthly = sumE - sumD;
  function rows(group) {
    return group.map(l => `
      <tr>
        <td class="mono">${escapeHtml(l.code)}</td>
        <td>${escapeHtml(l.name)}</td>
        <td class="ps-meta">${escapeHtml(l.formulaSummary || '')}</td>
        <td class="r mono">${fmtCur(l.monthly)}</td>
        <td class="r mono">${fmtCur(l.annual)}</td>
      </tr>`).join('');
  }
  wrap.innerHTML = `
    <table class="ps-table ps-preview-table">
      <thead><tr><th>Code</th><th>Component</th><th>Formula</th><th class="r">Monthly</th><th class="r">Annual</th></tr></thead>
      <tbody>
        ${earnings.length   ? `<tr class="ps-grouphdr"><td colspan="5">Earnings</td></tr>${rows(earnings)}`   : ''}
        ${reimbs.length     ? `<tr class="ps-grouphdr"><td colspan="5">Reimbursements</td></tr>${rows(reimbs)}` : ''}
        ${deductions.length ? `<tr class="ps-grouphdr"><td colspan="5">Deductions</td></tr>${rows(deductions)}` : ''}
        <tr class="ps-total">
          <td colspan="3"><b>Monthly Gross</b></td>
          <td class="r mono"><b>${fmtCur(r.monthlyGross)}</b></td>
          <td class="r mono"><b>${fmtCur(r.monthlyGross * 12)}</b></td>
        </tr>
        <tr class="ps-total">
          <td colspan="3"><b>Net Take-Home</b> (gross − deductions)</td>
          <td class="r mono"><b>${fmtCur(netMonthly)}</b></td>
          <td class="r mono"><b>${fmtCur(netMonthly * 12)}</b></td>
        </tr>
      </tbody>
    </table>`;
}

async function submitAssign() {
  const userId      = parseInt(document.getElementById('asUserId').value, 10);
  const structureId = parseInt(document.getElementById('asStructure').value, 10);
  const ctc         = Number(document.getElementById('asCtc').value);
  const effectiveFrom = document.getElementById('asEff').value;
  const remarks     = document.getElementById('asRem').value.trim();
  const err = document.getElementById('asErr');
  err.style.display = 'none';
  if (!structureId)              return showErr(err, 'Pick a structure.');
  if (!ctc || ctc < 0)            return showErr(err, 'Enter a valid CTC.');
  if (!effectiveFrom)             return showErr(err, 'Pick effective date.');
  try {
    await apiRequest('/hr/payroll-structure/employees/' + userId + '/salary', {
      method:'POST',
      body: { structureId, ctc, effectiveFrom, remarks },
    });
    closeAssign();
    await loadEmployees();
  } catch (e) { showErr(err, e.message || e); }
}

// ════════════════════════════════════════════════════════════════════════════
// helpers
// ════════════════════════════════════════════════════════════════════════════
function showLoadErr(tbodyId, cols, e) {
  document.getElementById(tbodyId).innerHTML =
    `<tr><td colspan="${cols}" class="ps-loading ps-err">${escapeHtml(e.message || e)}</td></tr>`;
}
function showErr(el, msg) { el.style.display = ''; el.textContent = msg; }
function fmtNum(n) {
  if (n == null || n === '') return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function fmtCur(n) {
  if (n == null || n === '') return '—';
  return '₹ ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// openHistory is referenced from a future modal; stub for now
function openHistory() {}
