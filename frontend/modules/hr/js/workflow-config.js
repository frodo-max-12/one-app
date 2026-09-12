// =====================================================================
// modules/hr/js/workflow-config.js — HR workflow admin (Phase 6B)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];
let allDefs = [];
let options = { reviewerKinds: [], entityKinds: [], conditionsHelp: {} };
let editLevels = [];

Object.assign(window, {
  loadList, openEdit, closeEdit, submitEdit,
  addLevel, removeLevel, updateLevelKind,
  archiveDef,
});

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-workflow-config');
  if (!HR_ROLES.includes((user.role || '').toLowerCase())) {
    document.querySelector('.pr-wrap').innerHTML = '<div class="pr-empty">HR / admin only.</div>';
    return;
  }
  try { options = await apiRequest('/hr/workflow/options'); } catch (_) {}
  await loadList();
}

async function loadList() {
  const ek       = document.getElementById('entitySel').value;
  const archived = document.getElementById('archivedChk').checked;
  const tbody = document.getElementById('listTbody');
  tbody.innerHTML = '<tr><td colspan="8" class="pr-loading">Loading…</td></tr>';
  try {
    const qs = [];
    if (ek)       qs.push('entityKind=' + ek);
    if (archived) qs.push('archived=true');
    const r = await apiRequest('/hr/workflow/definitions' + (qs.length ? '?' + qs.join('&') : ''));
    allDefs = r.definitions || [];
    if (!allDefs.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="pr-empty">No workflows ${archived ? 'archived' : 'defined'} yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = allDefs.map(d => `
      <tr>
        <td class="mono">${escapeHtml(d.Code)}</td>
        <td>${escapeHtml(d.Name)}<div class="pr-meta">${escapeHtml(d.Description || '')}</div></td>
        <td><span class="pill">${escapeHtml(d.EntityKind)}</span></td>
        <td class="r mono">${d.Priority}</td>
        <td class="r mono">${d.LevelCount}</td>
        <td class="r mono">${d.ActiveCount > 0 ? `<b style="color:var(--amber);">${d.ActiveCount}</b>` : '0'}</td>
        <td class="mono" style="font-size:11px;">${d.Conditions ? escapeHtml(d.Conditions) : '<span class="pr-meta">— always —</span>'}</td>
        <td class="r" style="white-space:nowrap;">
          <button class="btn btn-sm" onclick="openEdit(${d.WorkflowId})">✎ Edit</button>
          <button class="btn btn-sm btn-danger" onclick="archiveDef(${d.WorkflowId})">🗑</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="pr-empty pr-err">${escapeHtml(err.message || err)}</td></tr>`;
  }
}

// ── Edit modal ─────────────────────────────────────────────────────────────
async function openEdit(id) {
  const isNew = !id;
  document.getElementById('editTitle').textContent = isNew ? 'New Workflow' : 'Edit Workflow';
  document.getElementById('wfId').value         = id || '';
  document.getElementById('wfErr')?.style?.display && (document.getElementById('wfErr').style.display = 'none');
  document.getElementById('editErr').style.display = 'none';
  if (isNew) {
    document.getElementById('wfCode').value       = '';
    document.getElementById('wfCode').disabled    = false;
    document.getElementById('wfName').value       = '';
    document.getElementById('wfEntity').value     = 'Leave';
    document.getElementById('wfPriority').value   = 100;
    document.getElementById('wfDesc').value       = '';
    document.getElementById('wfConditions').value = '';
    editLevels = [];
    addLevel();
  } else {
    try {
      const r = await apiRequest('/hr/workflow/definitions/' + id);
      const d = r.definition;
      document.getElementById('wfCode').value       = d.Code;
      document.getElementById('wfCode').disabled    = true;
      document.getElementById('wfName').value       = d.Name;
      document.getElementById('wfEntity').value     = d.EntityKind;
      document.getElementById('wfPriority').value   = d.Priority;
      document.getElementById('wfDesc').value       = d.Description || '';
      document.getElementById('wfConditions').value = d.Conditions || '';
      editLevels = (r.levels || []).map(l => ({
        levelNo:      l.LevelNo,
        name:         l.Name,
        reviewerKind: l.ReviewerKind,
        reviewerValue:l.ReviewerValue || '',
        canReject:    !!l.CanReject,
        canDelegate:  !!l.CanDelegate,
      }));
    } catch (e) {
      document.getElementById('editErr').textContent = e.message || e;
      document.getElementById('editErr').style.display = '';
      return;
    }
  }
  renderLevels();
  document.getElementById('editModal').hidden = false;
}
function closeEdit() { document.getElementById('editModal').hidden = true; }

function addLevel() {
  if (editLevels.length >= 6) return alert('Max 6 levels per workflow.');
  editLevels.push({
    name:         'Level ' + (editLevels.length + 1),
    reviewerKind: 'ReportingManager',
    reviewerValue:'',
    canReject:    true,
    canDelegate:  true,
  });
  renderLevels();
}
function removeLevel(idx) {
  editLevels.splice(idx, 1);
  renderLevels();
}
function updateLevelKind(idx, kind) {
  editLevels[idx].reviewerKind  = kind;
  editLevels[idx].reviewerValue = '';
  renderLevels();
}

function renderLevels() {
  const wrap = document.getElementById('levelsList');
  if (!editLevels.length) {
    wrap.innerHTML = '<div class="pr-meta" style="padding:10px;">No levels yet. Add at least one.</div>';
    return;
  }
  wrap.innerHTML = editLevels.map((lv, i) => {
    const needsValue = lv.reviewerKind === 'NamedUser' || lv.reviewerKind === 'AnyRole';
    return `
      <div class="wf-level-row">
        <div class="wf-level-no">${i + 1}</div>
        <div class="wf-level-body">
          <div class="ps-row">
            <label class="ps-field">
              <span>Name</span>
              <input type="text" oninput="editLevels[${i}].name=this.value" value="${escapeAttr(lv.name)}" maxlength="100" />
            </label>
            <label class="ps-field">
              <span>Reviewer Kind</span>
              <select onchange="updateLevelKind(${i}, this.value)">
                ${(options.reviewerKinds || []).map(k => `<option value="${k}" ${k === lv.reviewerKind ? 'selected' : ''}>${k}</option>`).join('')}
              </select>
            </label>
            ${needsValue ? `
              <label class="ps-field">
                <span>${lv.reviewerKind === 'NamedUser' ? 'UserId' : 'Role string (e.g. "sales head")'}</span>
                <input type="text" oninput="editLevels[${i}].reviewerValue=this.value" value="${escapeAttr(lv.reviewerValue || '')}" />
              </label>
            ` : ''}
          </div>
          <div class="wf-level-flags">
            <label><input type="checkbox" ${lv.canReject ? 'checked' : ''} onchange="editLevels[${i}].canReject=this.checked" /> Can reject</label>
            <label><input type="checkbox" ${lv.canDelegate ? 'checked' : ''} onchange="editLevels[${i}].canDelegate=this.checked" /> Use delegate when on leave</label>
          </div>
        </div>
        <button class="iconbtn iconbtn-danger" type="button" onclick="removeLevel(${i})" title="Remove level">×</button>
      </div>`;
  }).join('');
}

async function submitEdit() {
  const id = document.getElementById('wfId').value;
  const err = document.getElementById('editErr');
  err.style.display = 'none';

  let condJson = null;
  const condRaw = document.getElementById('wfConditions').value.trim();
  if (condRaw) {
    try { condJson = JSON.parse(condRaw); }
    catch (e) { err.textContent = 'Conditions must be valid JSON: ' + e.message; err.style.display = ''; return; }
  }
  if (!editLevels.length) { err.textContent = 'At least one level required.'; err.style.display = ''; return; }

  const body = {
    name:        document.getElementById('wfName').value.trim(),
    description: document.getElementById('wfDesc').value.trim(),
    entityKind:  document.getElementById('wfEntity').value,
    conditions:  condJson,
    priority:    parseInt(document.getElementById('wfPriority').value, 10) || 100,
    levels:      editLevels.map(l => ({
      name:          l.name,
      reviewerKind:  l.reviewerKind,
      reviewerValue: l.reviewerValue || null,
      canReject:     !!l.canReject,
      canDelegate:   !!l.canDelegate,
    })),
  };
  if (!id) body.code = document.getElementById('wfCode').value.trim().toUpperCase();
  if (!body.name)              { err.textContent = 'Name required.'; err.style.display = ''; return; }
  if (!id && !body.code)        { err.textContent = 'Code required.'; err.style.display = ''; return; }

  try {
    if (id) await apiRequest('/hr/workflow/definitions/' + id, { method:'PATCH', body });
    else    await apiRequest('/hr/workflow/definitions',       { method:'POST',  body });
    closeEdit();
    await loadList();
  } catch (e) {
    err.textContent = e.message || e;
    err.style.display = '';
  }
}

async function archiveDef(id) {
  if (!confirm('Archive this workflow? In-progress requests must finish first.')) return;
  try { await apiRequest('/hr/workflow/definitions/' + id, { method:'DELETE' }); await loadList(); }
  catch (e) { alert(e.message || e); }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
