// ============================================================================
// ONE App Lens — Leave Approval queue (HR / reviewers)
// ============================================================================
const user = requireAuth();
let activeTab = 'pending-mine';   // pending-mine | all
let pendingActionId = null;
let pendingActionType = null;     // 'approve' | 'reject'

window.setTab = setTab;
window.openAction = openAction;
window.closeActionModal = closeActionModal;
window.confirmAction = confirmAction;

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

function diag(label, msg) {
  const box = document.getElementById('lensDiag'); const list = document.getElementById('diagList');
  if (!box || !list) return console.error(label, msg);
  const li = document.createElement('li'); li.textContent = `[${new Date().toLocaleTimeString('en-IN',{hour12:false})}] ${label}: ${msg}`;
  list.appendChild(li); box.style.display = 'block';
}

function init() {
  if (typeof renderSidebar === 'function') renderSidebar('leave-approvals');
  // Show "All" tab only for lens admins
  const role = (user.role || '').toLowerCase();
  if (['admin','operation head','director','hr','hr head'].includes(role)) {
    document.getElementById('tabAll').style.display = '';
  }
  load();
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.req-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  load();
}

async function load() {
  const list = document.getElementById('reqList');
  list.innerHTML = '<div class="holiday-skel" style="height:90px; margin-bottom:10px;"></div><div class="holiday-skel" style="height:90px;"></div>';
  let r;
  try {
    const scopeQ = activeTab === 'all' ? 'scope=all' : 'scope=pending-mine&status=pending';
    r = await apiRequest('/hr/leave/requests?' + scopeQ);
  } catch (e) { diag('GET requests', e.message || e); list.innerHTML = ''; return; }
  const reqs = r.requests || [];
  if (reqs.length === 0) {
    list.innerHTML = `<div class="req-empty"><div class="ic">✨</div><div class="t">${activeTab === 'all' ? 'No applications in the system yet' : 'Inbox zero! No leave requests pending your approval.'}</div></div>`;
    return;
  }
  list.innerHTML = reqs.map(renderCard).join('');
}

function renderCard(r) {
  const status = (r.Status || 'pending').toLowerCase();
  const from = new Date(r.FromDate), to = new Date(r.ToDate);
  const sameDay = r.FromDate === r.ToDate;
  const dates = sameDay
    ? from.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) + (r.FromSession === 2 ? ' (PM)' : (r.ToSession === 1 ? ' (AM)' : ''))
    : from.toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) + ' → ' + to.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  const showActions = status === 'pending';
  return `
    <article class="req-card status-${status}">
      <div class="req-type-ic">${r.LeaveTypeIcon || '📅'}</div>
      <div class="req-detail">
        <div class="req-head">
          <span class="req-type">${escape(r.LeaveTypeName || r.LeaveTypeCode)}</span>
          <span class="req-status-pill status-${status}">${status}</span>
          ${r.WfCode ? `<span class="wf-badge" title="${escape(r.WfName || r.WfCode)}">L${r.WfCurrentLevel}/${r.WfTotalLevels}</span>` : ''}
          <span class="days-pill">${num(r.DaysApplied)} day${r.DaysApplied == 1 ? '' : 's'}</span>
        </div>
        <div class="req-who"><b>${escape(r.UserName || 'Unknown')}</b> <span style="opacity:0.7;font-size:11px;font-family:monospace;">${escape(r.CompanyACode || r.UserId)}</span></div>
        <div class="req-dates">${dates} · applied ${new Date(r.AppliedAt).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
        ${r.Reason ? `<div class="req-reason">"${escape(r.Reason)}"</div>` : ''}
        ${r.ContactDetails ? `<div class="req-decision">📞 ${escape(r.ContactDetails)}</div>` : ''}
        ${r.ApprovedByName ? `<div class="req-decision">✓ Approved by <b>${escape(r.ApprovedByName)}</b>${r.ApprovalNote ? ': ' + escape(r.ApprovalNote) : ''}</div>` : ''}
        ${r.RejectedByName ? `<div class="req-decision">✗ Rejected by <b>${escape(r.RejectedByName)}</b>${r.RejectionReason ? ': ' + escape(r.RejectionReason) : ''}</div>` : ''}
      </div>
      <div class="req-actions">
        ${showActions ? `
          <button class="req-btn approve" onclick="openAction(${r.LeaveId}, 'approve')">✓ Approve</button>
          <button class="req-btn reject"  onclick="openAction(${r.LeaveId}, 'reject')">✗ Reject</button>
        ` : ''}
      </div>
    </article>`;
}

function openAction(id, type) {
  pendingActionId = id;
  pendingActionType = type;
  document.getElementById('actionTitle').textContent = type === 'approve' ? 'Approve Leave' : 'Reject Leave';
  document.getElementById('noteLabel').textContent  = type === 'approve' ? 'Approval note (optional)' : 'Reason for rejection (required)';
  document.getElementById('actionNote').value = '';
  document.getElementById('actionNote').placeholder = type === 'approve' ? 'e.g. Approved — enjoy your break!' : 'e.g. Please reschedule, team has critical delivery this week';
  const btn = document.getElementById('actionConfirm');
  btn.textContent = type === 'approve' ? 'Approve' : 'Reject';
  btn.style.background = type === 'approve' ? '' : '#ef4444';
  document.getElementById('actionError').style.display = 'none';
  document.getElementById('actionModal').hidden = false;
}

function closeActionModal() {
  document.getElementById('actionModal').hidden = true;
  pendingActionId = null; pendingActionType = null;
}

async function confirmAction() {
  if (!pendingActionId) return;
  const note = document.getElementById('actionNote').value.trim();
  const err = document.getElementById('actionError');
  err.style.display = 'none';
  if (pendingActionType === 'reject' && !note) {
    err.style.display = 'block'; err.textContent = 'Please provide a reason for rejection.';
    return;
  }
  try {
    const path = pendingActionType === 'approve'
      ? '/hr/leave/' + pendingActionId + '/approve'
      : '/hr/leave/' + pendingActionId + '/reject';
    const body = pendingActionType === 'approve' ? { note } : { reason: note };
    await apiRequest(path, { method: 'PUT', body });
    closeActionModal();
    load();
  } catch (e) {
    err.style.display = 'block'; err.textContent = e.message || 'Action failed';
  }
}

function num(n) { const v = Number(n) || 0; return v.toFixed(v % 1 === 0 ? 0 : 1); }
function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
