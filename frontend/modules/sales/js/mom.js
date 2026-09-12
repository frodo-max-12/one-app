// ============================================================================
// ONE App — MOM & Action Points  [v1.12]
// One module, two tabs:
//   • Minutes of Meeting — list + read-only detail + create/edit (SmartSys save procs)
//   • Action Points      — follow-up tracker (Mine/Team/All, pending/overdue)
// Both read the SmartSys ERP; an action-point row opens its MOM detail in place.
// ============================================================================
(function () {
  'use strict';
  const user = (typeof requireAuth === 'function') ? requireAuth() : null;

  // ── MOM tab state ──
  let currentPage = 1; const PAGE_SIZE = 50; let totalRows = 0; let currentType = ''; let searchTimer = null;
  let canWrite = false; let currentDetailId = null;
  let meta = null; let formMode = 'create'; let editingId = null; let fParts = [];

  // ── Action Points tab state ──
  let apPage = 1; let apView = ''; let apStatusFilter = ''; let apOverdue = false; let apSearchTimer = null; let apLoaded = false; let apTotal = 0; let apCanWrite = false;
  const AP_VIEW_LABELS = { mine: 'Mine', team: 'My Team', all: 'All' };
  const PENDING_WITH = ['Customer', 'Sales', 'Supplier/Vendor', 'FAE', 'Purchase', 'Product', 'Accounts', 'Logistics', 'Management'];

  Object.assign(window, {
    // tabs
    showTab,
    // MOM
    loadList, clearSearch, applyFilters, filterByType, exportExcel, gotoPage,
    openDetail, closeDetail, openCreate, openEditFromDetail, closeForm, emailParticipants,
    onProjectChange, toggleAddParticipant, onPartTypeChange, confirmAddParticipant,
    removeParticipant, addActionPoint, removeActionPoint, removeApChip, saveMom,
    // Action Points
    apClearSearch, apSetFilter, apSetView, apGotoPage, apExport, apChangeStatus, apChangePending,
  });

  if (user) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 0);
  }

  function init() {
    if (typeof renderSidebar === 'function') renderSidebar('mom');
    // MOM listeners
    document.getElementById('momSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      document.getElementById('momClearSearch').style.display = document.getElementById('momSearch').value ? '' : 'none';
      searchTimer = setTimeout(() => { currentPage = 1; loadList(); }, 350);
    });
    ['momFrom', 'momTo'].forEach(id => document.getElementById(id).addEventListener('change', () => { currentPage = 1; loadList(); }));
    document.getElementById('momType').addEventListener('change', () => { currentType = document.getElementById('momType').value; currentPage = 1; loadList(); });
    const t = document.getElementById('fTitle');
    if (t) t.addEventListener('input', () => { document.getElementById('fTitleCount').textContent = `${t.value.length}/50`; });
    attachTypeahead('fCustomer', 'fCustomerId', 'fCustomerSug', 'customer');
    attachTypeahead('fVendor', 'fVendorId', 'fVendorSug', 'vendor');
    attachTypeahead('pSearch', 'pId', 'pSug', 'employee');
    // Action Points listeners
    document.getElementById('apSearch').addEventListener('input', () => {
      clearTimeout(apSearchTimer);
      document.getElementById('apClearSearch').style.display = document.getElementById('apSearch').value ? '' : 'none';
      apSearchTimer = setTimeout(() => { apPage = 1; apLoad(); }, 350);
    });
    document.getElementById('apStatus').addEventListener('change', () => { apStatusFilter = document.getElementById('apStatus').value; apOverdue = false; apPage = 1; apLoad(); });
    ['apfCustomer', 'apfVendor', 'apfMomId', 'apfAssignedBy', 'apfResource'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => { clearTimeout(apSearchTimer); apSearchTimer = setTimeout(() => { apPage = 1; apLoad(); }, 350); });
    });
    document.getElementById('apfPendingWith')?.addEventListener('change', () => { apPage = 1; apLoad(); });

    loadList();
    const deep = parseInt(new URLSearchParams(location.search).get('mom'), 10);
    if (deep > 0) openDetail(deep);
    if ((new URLSearchParams(location.search).get('tab') || '') === 'ap') showTab('ap');
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────
  function showTab(which) {
    const isAp = which === 'ap';
    document.getElementById('tabMom').hidden = isAp;
    document.getElementById('tabAp').hidden = !isAp;
    document.getElementById('tabBtnMom').classList.toggle('active', !isAp);
    document.getElementById('tabBtnAp').classList.toggle('active', isAp);
    if (isAp && !apLoaded) { apLoaded = true; apLoad(); }
  }

  // ══════════════════════════ MOM TAB ══════════════════════════════════════════
  function clearSearch() { document.getElementById('momSearch').value = ''; document.getElementById('momClearSearch').style.display = 'none'; currentPage = 1; loadList(); }
  function applyFilters() { currentPage = 1; loadList(); }
  function filterByType(type) { currentType = (currentType === type) ? '' : type; document.getElementById('momType').value = currentType; currentPage = 1; loadList(); }
  function gotoPage(p) { currentPage = Math.max(1, p); loadList(); }

  async function loadList() {
    const params = new URLSearchParams({ page: currentPage, limit: PAGE_SIZE, search: document.getElementById('momSearch').value.trim(), type: currentType, from: document.getElementById('momFrom').value, to: document.getElementById('momTo').value });
    const tbody = document.getElementById('momBody');
    tbody.innerHTML = `<tr><td colspan="11" class="mom-loading">Loading…</td></tr>`;
    try {
      const r = await apiRequest(`/sales/mom?${params.toString()}`);
      const rows = r.data || []; totalRows = r.total || 0; canWrite = !!r.canWrite;
      document.getElementById('momNewBtn').style.display = canWrite ? '' : 'none';
      renderStats(r.summary || {});
      document.getElementById('momCount').textContent = `${totalRows} MOM${totalRows === 1 ? '' : 's'}` + (r.scope === 'all' ? ' · all' : (r.scope === 'team' || r.scope === 'fae-team') ? ' · your team' : '');
      highlightActiveCard();
      if (!rows.length) { tbody.innerHTML = `<tr><td colspan="11" class="mom-empty">${r.scope === 'none' ? 'No SmartSys account is linked to your login, so there are no MOMs to show. Ask IT to map your account.' : 'No MOMs match the current filters.'}</td></tr>`; renderPagination(); return; }
      tbody.innerHTML = rows.map(rowHtml).join(''); renderPagination();
    } catch (e) { tbody.innerHTML = `<tr><td colspan="11" class="mom-empty">${escapeHtml(e.message || 'Failed to load')}</td></tr>`; }
  }
  function rowHtml(r) {
    return `<tr onclick="openDetail(${r.MOMId})">
      <td class="mono">${r.MOMId}</td>
      <td class="mono" style="white-space:nowrap;">${fmtDate(r.MOMDate)}</td>
      <td>${typePill(r.MOMType)}</td>
      <td class="mom-strong">${escapeHtml(r.Title || '—')}</td>
      <td>${escapeHtml(r.Employee || '—')}</td>
      <td class="mom-dim" title="${escapeAttr(r.ProjectName || '')}">${escapeHtml(clip(r.ProjectName, 34))}</td>
      <td class="mom-dim" title="${escapeAttr(r.TaskName || '')}">${escapeHtml(clip(r.TaskName, 34))}</td>
      <td class="mom-dim">${escapeHtml(r.CustomerName || '—')}</td>
      <td class="mom-dim" style="font-size:11.5px;">${escapeHtml(r.ModifiedBy || '—')}</td>
      <td class="mono" style="white-space:nowrap; font-size:11.5px;">${fmtDate(r.ModifiedDate)}</td>
      <td class="r"><button class="mom-row-action" onclick="event.stopPropagation(); openDetail(${r.MOMId})">View</button></td>
    </tr>`;
  }
  function renderStats(s) { setText('statTotal', s.Total); setText('statMonth', s.ThisMonth); setText('statInPerson', s.InPerson); setText('statConference', s.Conference); setText('statTelephonic', s.Telephonic); }
  function highlightActiveCard() {
    document.querySelectorAll('#momStats .stat-card').forEach(c => c.classList.remove('active'));
    const map = { '': '.stat-all', 'In-Person': '.stat-inperson', 'Conference': '.stat-conference', 'Telephonic': '.stat-telephonic' };
    document.querySelector(`#momStats ${map[currentType] || '.stat-all'}`)?.classList.add('active');
  }
  function renderPagination() { pager('momPagination', totalRows, currentPage, 'gotoPage', 'MOMs'); }

  // ── Detail modal ──
  async function openDetail(id) {
    currentDetailId = id;
    document.getElementById('momModalTitle').textContent = `MOM #${id}`;
    document.getElementById('momEditBtn').style.display = 'none';
    document.getElementById('momMailBtn').style.display = 'none';
    document.getElementById('momDetailBody').innerHTML = `<div class="mom-loading">Loading…</div>`;
    document.getElementById('momModal').hidden = false;
    try {
      const d = await apiRequest(`/sales/mom/${id}`);
      document.getElementById('momDetailBody').innerHTML = detailHtml(d);
      document.getElementById('momEditBtn').style.display = d.canEdit ? '' : 'none';
      // "Email Participants" — only when it's actionable (can edit + has participants)
      document.getElementById('momMailBtn').style.display = (d.canEdit && (d.participants || []).length) ? '' : 'none';
    } catch (e) { document.getElementById('momDetailBody').innerHTML = `<div class="mom-empty">${escapeHtml(e.message || 'Failed to load MOM')}</div>`; }
  }
  function closeDetail() { document.getElementById('momModal').hidden = true; }
  function openEditFromDetail() { if (currentDetailId) { closeDetail(); openEdit(currentDetailId); } }
  async function emailParticipants() {
    if (!currentDetailId) return;
    const btn = document.getElementById('momMailBtn');
    try {
      // Preview first — show To / Cc split, then confirm the actual send.
      const p = await apiRequest(`/sales/mom/${currentDetailId}/send-mail?preview=true`, { method: 'POST' });
      const toLine = (p.to || []).map(r => `• ${r.name} (${r.email})`).join('\n') || '—';
      const ccLine = (p.cc || []).map(r => `• ${r.name} (${r.email})`).join('\n');
      const total = (p.to || []).length + (p.cc || []).length;
      let msg = `Send this MOM email to ${total} participant(s)?\n\nSUBJECT: ${p.subject}\n\nTO:\n${toLine}`;
      if (ccLine) msg += `\n\nCC (FYI):\n${ccLine}`;
      if (p.bodyText) msg += `\n\n──── DRAFT ────\n${p.bodyText}`;
      if (!confirm(msg)) return;
      btn.disabled = true; const old = btn.textContent; btn.textContent = 'Sending…';
      const r = await apiRequest(`/sales/mom/${currentDetailId}/send-mail`, { method: 'POST' });
      btn.disabled = false; btn.textContent = old;
      const all = [...(r.to || []), ...(r.cc || [])];
      alert(`✓ Emailed to ${all.length} participant(s):\n${all.join(', ')}`);
    } catch (e) {
      btn.disabled = false; btn.textContent = '📧 Email Participants';
      alert(e.message || 'Email failed');
    }
  }
  function detailHtml(d) {
    const h = d.header || {};
    const kv = (l, v) => `<div class="mom-kv"><div class="mom-kv-l">${l}</div><div class="mom-kv-v">${escapeHtml(v || '—')}</div></div>`;
    const parts = d.participants || [], actions = d.actionPoints || [], files = d.attachments || [];
    const partsHtml = parts.length ? parts.map(p => `<span class="mom-tag ${p.ParticipantType === 'Customer' ? 'mom-tag-cust' : ''}">${escapeHtml(p.Name || '—')}${p.FYI ? ' · FYI' : ''}</span>`).join('') : `<span class="mom-dim">No participants recorded.</span>`;
    const actionsHtml = actions.length ? `<table class="mom-sub-table"><thead><tr><th>#</th><th>Action</th><th>Assigned To</th><th>Assigned By</th><th>Due</th><th>Status</th><th>Pending With</th></tr></thead><tbody>${actions.map((a, i) => `<tr><td class="mono">${i + 1}</td><td>${escapeHtml(a.ActionDescription || '—')}</td><td class="mom-dim">${escapeHtml(a.Resource || '—')}</td><td class="mom-dim">${escapeHtml(a.AssignedBy || '—')}</td><td class="mono" style="white-space:nowrap;">${fmtDate(a.DueDate)}</td><td>${statusPill(a.StatusShortCode, a.StatusName)}</td><td class="mom-dim">${escapeHtml(a.PendingWith || '—')}</td></tr>`).join('')}</tbody></table>` : `<div class="mom-dim">No action points.</div>`;
    const filesHtml = files.length ? files.map(f => `<div class="mom-file">📎 ${escapeHtml(f.FileName || 'file')}${f.Description ? ` — <span class="mom-dim">${escapeHtml(f.Description)}</span>` : ''}</div>`).join('') + `<div class="mom-dim" style="margin-top:6px; font-size:11px;">Files live in the SmartSys app; open SmartSys to download them.</div>` : `<div class="mom-dim">No attachments.</div>`;
    return `<div class="mom-detail-head"><div class="mom-detail-title">${escapeHtml(h.Title || 'Untitled MOM')}</div><div class="mom-detail-badges">${typePill(h.MOMType)}<span class="mom-badge">${fmtDate(h.MOMDate)}</span></div></div>
      <div class="mom-kv-grid">${kv('Employee', h.Employee)}${kv('Project', h.ProjectName)}${kv('Task', h.TaskName)}${kv('Customer', h.CustomerName)}${kv('Vendor', h.VendorName)}${kv('Modified By', h.ModifiedBy)}</div>
      ${sectionBlock('Description', h.Description)}${sectionBlock('Internal Description', h.LocalDescription)}${sectionBlock('Management View', h.ManagementView)}
      <div class="mom-section"><div class="mom-section-h">Participants (${parts.length})</div><div class="mom-tags">${partsHtml}</div></div>
      <div class="mom-section"><div class="mom-section-h">Action Points (${actions.length})</div>${actionsHtml}</div>
      <div class="mom-section"><div class="mom-section-h">Attachments (${files.length})</div>${filesHtml}</div>
      <div class="mom-detail-foot">Created by ${escapeHtml(h.CreatedBy || '—')} on ${fmtDate(h.CreatedDate)} · Last modified ${escapeHtml(h.ModifiedBy || '—')} on ${fmtDate(h.ModifiedDate)}</div>`;
  }
  function sectionBlock(title, text) { const t = stripHtml(text); if (!t) return ''; return `<div class="mom-section"><div class="mom-section-h">${title}</div><div class="mom-prose">${escapeHtml(t).replace(/\n/g, '<br>')}</div></div>`; }

  // ── Create / Edit form ──
  async function ensureMeta() {
    if (meta) return meta;
    meta = await apiRequest('/sales/mom/meta');
    document.getElementById('fProject').innerHTML = `<option value="">— select project —</option>` + (meta.projects || []).map(p => `<option value="${p.ProjectId}">${escapeHtml(p.ProjectName)}</option>`).join('');
    document.getElementById('fType').innerHTML = (meta.momTypes || []).map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('');
    return meta;
  }
  function statusOptions(sel) { return (meta.actionStatuses || []).map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join(''); }
  function pendingWithOptions(sel) { return `<option value="">— pending with —</option>` + PENDING_WITH.map(v => `<option value="${escapeAttr(v)}" ${v === sel ? 'selected' : ''}>${escapeHtml(v)}</option>`).join(''); }
  async function openCreate() {
    formMode = 'create'; editingId = null; fParts = [];
    document.getElementById('momFormTitle').textContent = 'New MOM';
    await ensureMeta();
    document.getElementById('fProject').value = '';
    document.getElementById('fTask').innerHTML = `<option value="">— select project first —</option>`;
    document.getElementById('fDate').value = new Date().toISOString().slice(0, 10);
    document.getElementById('fType').value = 'In-Person';
    ['fTitle', 'fDesc', 'fLocal', 'fMgmt', 'fCustomer', 'fCustomerId', 'fVendor', 'fVendorId'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('fTitleCount').textContent = '0/50';
    document.getElementById('apFormList').innerHTML = '';
    document.getElementById('attachSection').hidden = true;
    document.getElementById('addPartRow').hidden = true;
    renderParticipants(); hideFormErr();
    document.getElementById('momFormModal').hidden = false;
  }
  async function openEdit(id) {
    formMode = 'edit'; editingId = id; fParts = [];
    document.getElementById('momFormTitle').textContent = `Edit MOM #${id}`;
    document.getElementById('momFormModal').hidden = false;
    document.getElementById('momFormBody').style.opacity = '0.5';
    try {
      await ensureMeta();
      const d = await apiRequest(`/sales/mom/${id}`); const h = d.header;
      document.getElementById('fProject').value = h.ProjectId || '';
      await onProjectChange(h.TaskId);
      document.getElementById('fDate').value = (h.MOMDate ? new Date(h.MOMDate).toISOString().slice(0, 10) : '');
      document.getElementById('fType').value = h.MOMType || 'In-Person';
      document.getElementById('fTitle').value = h.Title || '';
      document.getElementById('fTitleCount').textContent = `${(h.Title || '').length}/50`;
      document.getElementById('fDesc').value = stripHtml(h.Description);
      document.getElementById('fLocal').value = stripHtml(h.LocalDescription);
      document.getElementById('fMgmt').value = stripHtml(h.ManagementView);
      document.getElementById('fCustomer').value = h.CustomerName || ''; document.getElementById('fCustomerId').value = h.CustomerId || '';
      document.getElementById('fVendor').value = h.VendorName || ''; document.getElementById('fVendorId').value = h.VendorId || '';
      fParts = (d.participants || []).map(p => ({ type: p.ParticipantType, id: p.ParticipantId, name: p.Name, fyi: !!p.FYI }));
      renderParticipants();
      document.getElementById('apFormList').innerHTML = '';
      (d.actionPoints || []).forEach(a => addActionPoint({ actionPointId: a.ActionPointId, description: a.ActionDescription, status: a.Status, dueDate: a.DueDate ? new Date(a.DueDate).toISOString().slice(0, 10) : '', assignees: a.assignees || [], pendingWith: a.PendingWith || '', assignedBy: a.AssignedBy || '' }));
      const at = d.attachments || [];
      document.getElementById('attachSection').hidden = false;
      document.getElementById('attachList').innerHTML = at.length ? at.map(f => `<div class="mom-file">📎 ${escapeHtml(f.FileName || 'file')}${f.Description ? ` — <span class="mom-dim">${escapeHtml(f.Description)}</span>` : ''}</div>`).join('') : `<div class="mom-dim">No attachments.</div>`;
      hideFormErr();
    } catch (e) { showFormErr(e.message || 'Failed to load MOM for editing'); }
    finally { document.getElementById('momFormBody').style.opacity = '1'; }
  }
  function closeForm() { document.getElementById('momFormModal').hidden = true; }
  async function onProjectChange(preselectTaskId) {
    const pid = document.getElementById('fProject').value; const sel = document.getElementById('fTask');
    if (!pid) { sel.innerHTML = `<option value="">— select project first —</option>`; return; }
    sel.innerHTML = `<option value="">Loading…</option>`;
    try { const r = await apiRequest(`/sales/mom/meta/tasks?projectId=${encodeURIComponent(pid)}`); sel.innerHTML = `<option value="">— select task —</option>` + (r.data || []).map(t => `<option value="${t.TaskId}">${escapeHtml(t.TaskName)}</option>`).join(''); if (preselectTaskId) sel.value = preselectTaskId; }
    catch (e) { sel.innerHTML = `<option value="">failed to load tasks</option>`; }
  }
  function toggleAddParticipant() { const r = document.getElementById('addPartRow'); r.hidden = !r.hidden; if (!r.hidden) { document.getElementById('pSearch').value = ''; document.getElementById('pId').value = ''; } }
  function onPartTypeChange() { document.getElementById('pSearch').value = ''; document.getElementById('pId').value = ''; document.getElementById('pSug').hidden = true; }
  function confirmAddParticipant() {
    const type = document.getElementById('pType').value; const id = parseInt(document.getElementById('pId').value, 10);
    const name = document.getElementById('pSearch').value.trim(); const fyi = document.getElementById('pFyi').checked;
    if (!id || !name) return;
    if (fParts.some(p => p.type === type && p.id === id)) { document.getElementById('addPartRow').hidden = true; return; }
    fParts.push({ type, id, name, fyi });
    document.getElementById('pSearch').value = ''; document.getElementById('pId').value = ''; document.getElementById('pFyi').checked = false;
    document.getElementById('addPartRow').hidden = true; renderParticipants();
  }
  function removeParticipant(idx) { fParts.splice(idx, 1); renderParticipants(); }
  function renderParticipants() {
    document.getElementById('partList').innerHTML = fParts.length ? fParts.map((p, i) => `<span class="mom-chip ${p.type === 'Customer' ? 'mom-chip-cust' : p.type === 'Vendor' ? 'mom-chip-vend' : ''}">${escapeHtml(p.name)}<span class="mom-chip-t">${p.type}${p.fyi ? '·FYI' : ''}</span><button type="button" onclick="removeParticipant(${i})">✕</button></span>`).join('') : `<span class="mom-dim">No participants added.</span>`;
  }
  function addActionPoint(a) {
    a = a || {};
    const item = document.createElement('div');
    item.className = 'mom-ap-item'; item.dataset.apid = a.actionPointId || 0;
    item.innerHTML = `
      <div class="mom-ap-line1">
        <input type="text" class="ap-desc" maxlength="1000" placeholder="Action to be done…" value="${escapeAttr(a.description || '')}" />
        <span class="ap-assignedby" title="Assigned By — set automatically to the creator">Assigned by: ${escapeHtml(a.assignedBy || (user && (user.username || user.name)) || '—')}</span>
        <button type="button" class="mom-mini-btn danger" onclick="removeActionPoint(this)" title="Remove action point">✕</button>
      </div>
      <div class="mom-ap-line2">
        <div class="ap-assignees">
          <span class="ap-assign-label">Assigned to</span>
          <div class="ap-chips"></div>
          <div class="mom-typeahead ap-assign-wrap">
            <input type="text" class="ap-assign-input" autocomplete="off" placeholder="+ add person…" />
            <div class="mom-suggest ap-assign-sug" hidden></div>
          </div>
        </div>
        <select class="ap-status" title="Status">${statusOptions(a.status || 26)}</select>
        <input type="date" class="ap-due" title="Due date" value="${a.dueDate || ''}" />
        <select class="ap-pending" title="Pending with">${pendingWithOptions(a.pendingWith || '')}</select>
      </div>`;
    document.getElementById('apFormList').appendChild(item);
    const chips = item.querySelector('.ap-chips');
    (a.assignees || []).forEach(x => addApChip(chips, x.id, x.name));
    wireApAssignee(item);
  }
  function removeActionPoint(btn) { btn.closest('.mom-ap-item').remove(); }
  function removeApChip(btn) { btn.closest('.ap-chip').remove(); }
  function addApChip(chipsEl, id, name) {
    id = parseInt(id, 10); if (!id) return;
    if ([...chipsEl.querySelectorAll('.ap-chip')].some(c => parseInt(c.dataset.uid, 10) === id)) return;
    const chip = document.createElement('span');
    chip.className = 'ap-chip'; chip.dataset.uid = id;
    chip.innerHTML = `${escapeHtml(name)}<button type="button" onclick="removeApChip(this)">✕</button>`;
    chipsEl.appendChild(chip);
  }
  // Per-row "assigned to" type-ahead (employees, keyed by SysUserId via type=resource).
  function wireApAssignee(item) {
    const input = item.querySelector('.ap-assign-input');
    const sug = item.querySelector('.ap-assign-sug');
    const chips = item.querySelector('.ap-chips');
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { sug.hidden = true; return; }
      timer = setTimeout(async () => {
        try {
          const r = await apiRequest(`/sales/mom/meta/search?type=resource&q=${encodeURIComponent(q)}`);
          const rows = r.data || [];
          sug.innerHTML = rows.length ? rows.map(x => `<div class="mom-sug-item" data-id="${x.id}" data-name="${escapeAttr(x.name)}">${escapeHtml(x.name)}</div>`).join('') : `<div class="mom-sug-empty">No match</div>`;
          sug.hidden = false;
          sug.querySelectorAll('.mom-sug-item').forEach(it => it.addEventListener('mousedown', (e) => {
            e.preventDefault(); addApChip(chips, it.dataset.id, it.dataset.name); input.value = ''; sug.hidden = true;
          }));
        } catch (_) { sug.hidden = true; }
      }, 250);
    });
    input.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 150));
  }
  function collectActionPoints() {
    return Array.from(document.querySelectorAll('#apFormList .mom-ap-item')).map(item => ({
      actionPointId: parseInt(item.dataset.apid, 10) || 0,
      description: item.querySelector('.ap-desc').value.trim(),
      status: parseInt(item.querySelector('.ap-status').value, 10) || 26,
      dueDate: item.querySelector('.ap-due').value || null,
      pendingWith: item.querySelector('.ap-pending')?.value || '',
      assignees: [...item.querySelectorAll('.ap-chip')].map(c => parseInt(c.dataset.uid, 10)).filter(Boolean),
    })).filter(a => a.description);
  }
  async function saveMom() {
    hideFormErr();
    const body = {
      projectId: document.getElementById('fProject').value, taskId: document.getElementById('fTask').value,
      momDate: document.getElementById('fDate').value, momType: document.getElementById('fType').value,
      title: document.getElementById('fTitle').value.trim(), description: document.getElementById('fDesc').value,
      localDescription: document.getElementById('fLocal').value, managementView: document.getElementById('fMgmt').value,
      customerId: document.getElementById('fCustomerId').value || null, vendorId: document.getElementById('fVendorId').value || null,
      participants: fParts.map(p => ({ type: p.type, id: p.id, fyi: p.fyi })), actionPoints: collectActionPoints(),
    };
    if (!body.projectId) return showFormErr('Please select a Project');
    if (!body.taskId) return showFormErr('Please select a Task');
    if (!body.title) return showFormErr('Please enter a Title');
    if (!body.momDate) return showFormErr('Please pick a MOM date');
    const btn = document.getElementById('momSaveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = formMode === 'edit' ? await apiRequest(`/sales/mom/${editingId}`, { method: 'PUT', body }) : await apiRequest('/sales/mom', { method: 'POST', body });
      closeForm();
      if (formMode === 'create' && r.momId) { currentPage = 1; await loadList(); openDetail(r.momId); }
      else { await loadList(); if (editingId) openDetail(editingId); }
    } catch (e) { showFormErr(e.message || 'Save failed'); }
    finally { btn.disabled = false; btn.textContent = 'Save MOM'; }
  }
  function showFormErr(m) { const e = document.getElementById('momFormErr'); e.textContent = m; e.style.display = ''; }
  function hideFormErr() { document.getElementById('momFormErr').style.display = 'none'; }
  function attachTypeahead(inputId, hiddenId, sugId, type) {
    const input = document.getElementById(inputId); if (!input) return;
    let timer = null;
    input.addEventListener('input', () => {
      document.getElementById(hiddenId).value = '';
      clearTimeout(timer);
      const q = input.value.trim(); const sug = document.getElementById(sugId);
      if (q.length < 2) { sug.hidden = true; return; }
      const searchType = (inputId === 'pSearch') ? document.getElementById('pType').value.toLowerCase() : type;
      timer = setTimeout(async () => {
        try {
          const r = await apiRequest(`/sales/mom/meta/search?type=${searchType}&q=${encodeURIComponent(q)}`);
          const rows = r.data || [];
          sug.innerHTML = rows.length ? rows.map(x => `<div class="mom-sug-item" data-id="${x.id}" data-name="${escapeAttr(x.name)}">${escapeHtml(x.name)}</div>`).join('') : `<div class="mom-sug-empty">No match</div>`;
          sug.hidden = false;
          sug.querySelectorAll('.mom-sug-item').forEach(it => it.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = it.dataset.name; document.getElementById(hiddenId).value = it.dataset.id; sug.hidden = true; }));
        } catch (_) { sug.hidden = true; }
      }, 250);
    });
    input.addEventListener('blur', () => setTimeout(() => { document.getElementById(sugId).hidden = true; }, 150));
  }
  async function exportExcel() {
    const params = new URLSearchParams({ search: document.getElementById('momSearch').value.trim(), type: currentType, from: document.getElementById('momFrom').value, to: document.getElementById('momTo').value });
    await downloadXlsx('/api/sales/mom/export', params, `MOM_${new Date().toISOString().slice(0, 10)}.xlsx`, 'Share MOM export');
  }

  // ══════════════════════════ ACTION POINTS TAB ════════════════════════════════
  function apClearSearch() { document.getElementById('apSearch').value = ''; document.getElementById('apClearSearch').style.display = 'none'; apPage = 1; apLoad(); }
  function apGotoPage(p) { apPage = Math.max(1, p); apLoad(); }
  function apSetView(v) { apView = v; apPage = 1; apLoad(); }
  function apSetFilter(f) {
    if (f === 'overdue') { apOverdue = true; apStatusFilter = ''; }
    else if (f === 'all') { apOverdue = false; apStatusFilter = ''; }
    else { apOverdue = false; apStatusFilter = f; }
    document.getElementById('apStatus').value = (f === 'overdue' || f === 'all') ? '' : f;
    apPage = 1; apLoad();
    document.querySelectorAll('#apStats .stat-card').forEach(c => c.classList.remove('active'));
    const map = { all: '.stat-all', pending: '.stat-pending', overdue: '.stat-overdue', complete: '.stat-done' };
    document.querySelector(`#apStats ${map[f] || '.stat-all'}`)?.classList.add('active');
  }
  // Collect all AP filters (view/status/overdue/search + per-column) into params.
  function apReadFilters(params) {
    if (apView) params.set('view', apView);
    if (apStatusFilter) params.set('status', apStatusFilter);
    if (apOverdue) params.set('overdue', 'true');
    const fv = (id) => (document.getElementById(id)?.value || '').trim();
    const search = document.getElementById('apSearch').value.trim();
    if (search) params.set('search', search);
    if (fv('apfCustomer'))   params.set('customer', fv('apfCustomer'));
    if (fv('apfVendor'))     params.set('vendor', fv('apfVendor'));
    if (fv('apfMomId'))      params.set('momId', fv('apfMomId'));
    if (fv('apfAssignedBy')) params.set('assignedBy', fv('apfAssignedBy'));
    if (fv('apfResource'))   params.set('resource', fv('apfResource'));
    if (fv('apfPendingWith')) params.set('pendingWith', fv('apfPendingWith'));
    return params;
  }
  async function apLoad() {
    const params = apReadFilters(new URLSearchParams({ page: apPage, limit: PAGE_SIZE }));
    const tbody = document.getElementById('apBody'); tbody.innerHTML = `<tr><td colspan="13" class="mom-loading">Loading…</td></tr>`;
    try {
      const r = await apiRequest(`/sales/action-points?${params.toString()}`);
      apView = r.view; apCanWrite = !!r.canWrite; apRenderViewToggle(r.allowedViews || []);
      setText('apTotal', (r.summary || {}).Total); setText('apPending', (r.summary || {}).Pending); setText('apOverdue', (r.summary || {}).Overdue); setText('apCompleted', (r.summary || {}).Completed);
      apTotal = r.total || 0;
      const rows = r.data || [];
      if (!rows.length) { tbody.innerHTML = `<tr><td colspan="13" class="mom-empty">No action points match these filters.</td></tr>`; pager('apPagination', apTotal, apPage, 'apGotoPage', ''); return; }
      tbody.innerHTML = rows.map(apRowHtml).join('');
      pager('apPagination', apTotal, apPage, 'apGotoPage', '');
    } catch (e) { tbody.innerHTML = `<tr><td colspan="13" class="mom-empty">${escapeHtml(e.message || 'Failed to load')}</td></tr>`; }
  }
  function apRenderViewToggle(allowed) {
    const el = document.getElementById('apViewToggle');
    el.innerHTML = (allowed.length <= 1) ? '' : allowed.map(v => `<button class="${v === apView ? 'active' : ''}" onclick="apSetView('${v}')">${AP_VIEW_LABELS[v] || v}</button>`).join('');
  }
  function apRowHtml(r) {
    const due = r.DueDate ? fmtDate(r.DueDate) : '—';
    const over = (r.OverDueDays == null) ? '—' : r.OverDueDays;
    const statusCell = apCanWrite ? apStatusSelectHtml(r.Status, r.ActionPointId) : statusPill(r.StatusShortCode, r.StatusName);
    return `<tr class="${r.Overdue ? 'ap-overdue' : ''}">
      <td class="mono"><a class="ap-momlink" href="#" onclick="event.preventDefault();openDetail(${r.MOMId})" title="Open MOM #${r.MOMId}">${r.ActionPointId}</a></td>
      <td class="mom-dim">${escapeHtml(r.Customer || '—')}</td>
      <td class="mom-dim">${escapeHtml(r.Vendor || '—')}</td>
      <td class="mom-strong" title="${escapeAttr(r.ActionDescription || '')}">${escapeHtml(clip(r.ActionDescription, 90))}</td>
      <td>${statusCell}</td>
      <td><a class="ap-momlink" href="#" onclick="event.preventDefault();openDetail(${r.MOMId})">#${r.MOMId}</a></td>
      <td class="mono ${r.Overdue ? 'ap-due-over' : ''}" style="white-space:nowrap;">${due}</td>
      <td class="mono ${r.Overdue ? 'ap-due-over' : ''}">${over}</td>
      <td class="mom-dim" style="font-size:11px;">${escapeHtml(r.AssignedBy || '—')}</td>
      <td class="mom-dim">${escapeHtml(r.Resource || '—')}</td>
      <td class="mom-dim" style="font-size:11px;">${escapeHtml(r.ModifiedBy || '—')}</td>
      <td class="mono" style="white-space:nowrap; font-size:11px;">${fmtDate(r.ModifiedDate)}</td>
      <td>${apCanWrite ? apPendingSelectHtml(r.PendingWith, r.ActionPointId) : (r.PendingWith ? `<span class="mom-status-pill mom-st-hold">${escapeHtml(r.PendingWith)}</span>` : '—')}</td>
    </tr>`;
  }
  function apStatusSelectHtml(status, apId) {
    const opts = [[26, 'New'], [29, 'Inprogress'], [30, 'Complete'], [32, 'Cancelled'], [33, 'OnHold']];
    return `<select class="ap-status-inline" onchange="apChangeStatus(this, ${apId})">${opts.map(([v, l]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }
  function apPendingSelectHtml(current, apId) {
    const opts = [''].concat(PENDING_WITH);
    return `<select class="ap-status-inline ap-pending-inline" onchange="apChangePending(this, ${apId})">${opts.map(v => `<option value="${escapeAttr(v)}" ${v === (current || '') ? 'selected' : ''}>${v === '' ? 'None' : escapeHtml(v)}</option>`).join('')}</select>`;
  }
  // Inline status change → PATCH (SmartSys's save proc records the change date). Reloads to reflect ModifiedBy/Date.
  async function apChangeStatus(sel, apId) {
    sel.disabled = true;
    try { await apiRequest(`/sales/action-points/${apId}`, { method: 'PATCH', body: { status: parseInt(sel.value, 10) } }); }
    catch (e) { alert(e.message || 'Status change failed'); }
    apLoad();
  }
  // Inline "Pending With" change → PATCH (writes the ONE App overlay table).
  async function apChangePending(sel, apId) {
    sel.disabled = true;
    try { await apiRequest(`/sales/action-points/${apId}`, { method: 'PATCH', body: { pendingWith: sel.value } }); }
    catch (e) { alert(e.message || 'Update failed'); }
    apLoad();
  }
  async function apExport() {
    const params = apReadFilters(new URLSearchParams());
    await downloadXlsx('/api/sales/action-points/export', params, `MOMPendingActionPointList_${new Date().toISOString().slice(0, 10)}.xlsx`, 'Share action points');
  }

  // ══════════════════════════ SHARED HELPERS ═══════════════════════════════════
  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = (v == null ? '—' : v); }
  function pager(elId, total, page, fnName, noun) {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE)); const p = document.getElementById(elId);
    if (totalPages <= 1) { p.innerHTML = ''; return; }
    const btn = (label, pg, dis, act) => `<button class="mom-page-btn${act ? ' active' : ''}" ${dis ? 'disabled' : ''} onclick="${fnName}(${pg})">${label}</button>`;
    let html = btn('‹ Prev', page - 1, page <= 1, false);
    const from = Math.max(1, page - 2), to = Math.min(totalPages, page + 2);
    if (from > 1) html += `<span class="mom-page-gap">1 …</span>`;
    for (let i = from; i <= to; i++) html += btn(i, i, false, i === page);
    if (to < totalPages) html += `<span class="mom-page-gap">… ${totalPages}</span>`;
    html += btn('Next ›', page + 1, page >= totalPages, false);
    p.innerHTML = `<div class="mom-page-row">${html}<span class="mom-page-info">${total}${noun ? ' ' + noun : ''} · page ${page}/${totalPages}</span></div>`;
  }
  async function downloadXlsx(url, params, fileName, shareTitle) {
    try {
      const token = (typeof getToken === 'function') ? getToken() : ''; const company = (typeof getCompany === 'function') ? getCompany() : '';
      params.set('company', company);
      const res = await fetch(`${url}?${params.toString()}`, { headers: { Authorization: token, 'X-Company': company } });
      if (!res.ok) { let m = 'Export failed (' + res.status + ')'; try { const j = await res.json(); m = j.message || m; } catch {} throw new Error(m); }
      const blob = await res.blob();
      const inCap = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      if (inCap && typeof nativeSaveAndShare === 'function') { await nativeSaveAndShare(blob, fileName, { dialogTitle: shareTitle }); }
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    } catch (e) { alert(e.message || 'Export failed'); }
  }
  function typePill(t) { const s = String(t || '').trim(); const cls = s === 'Conference' ? 'mom-type-conf' : s === 'Telephonic' ? 'mom-type-tel' : 'mom-type-inperson'; return s ? `<span class="mom-type-pill ${cls}">${escapeHtml(s)}</span>` : '—'; }
  function statusPill(shortCode, name) {
    const s = String(shortCode || name || '').toLowerCase(); let cls = 'mom-st-new';
    if (s.includes('complete')) cls = 'mom-st-done'; else if (s.includes('progress')) cls = 'mom-st-prog'; else if (s.includes('cancel')) cls = 'mom-st-cancel'; else if (s.includes('hold')) cls = 'mom-st-hold';
    return `<span class="mom-status-pill ${cls}">${escapeHtml(name || shortCode || '—')}</span>`;
  }
  function fmtDate(d) { if (!d) return '—'; const dt = new Date(d); return isNaN(dt) ? '—' : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }); }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : (s || '—'); }
  // MOM notes are stored as HTML (SmartSys rich-text editor). Convert to clean,
  // readable text: block tags → line breaks, strip remaining tags, then safely
  // decode entities (&nbsp; &amp; …) via a <textarea> (no script runs; tags gone).
  function stripHtml(s) {
    if (!s) return '';
    let t = String(s).replace(/&nbsp;/gi, ' ').replace(/<\s*(br|\/div|\/p|\/li|\/tr|\/h[1-6])\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '');
    const ta = document.createElement('textarea'); ta.innerHTML = t;
    return (ta.value || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }
})();
