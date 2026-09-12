// ============================================================================
// ONE App Lens — Regularization (merged: Apply + Approvals tabs)
// Sidebar merge 2026-05-25 — combines former regularization-apply.js +
// regularization-approvals.js. Apply tab visible to everyone; Approvals tab
// only for reviewer roles (head roles + HR). Approvals data is lazy-loaded
// on first tab visit to avoid wasted call for non-reviewers.
// ============================================================================

const user = requireAuth();

// ── State ────────────────────────────────────────────────────────────────────
let approvalsLoaded   = false;      // lazy-load flag for the Approvals tab
let selectedKind      = null;       // apply tab — sign-in / sign-out / both
let activeSubTab      = 'pending-mine'; // approvals tab — pending-mine / all
let pendingActionId   = null;       // approvals — currently-acting RegId
let pendingActionType = null;       // approvals — 'approve' | 'reject'

const REVIEWER_ROLES   = ['admin','operation head','director','hr','hr head','sales head','north sales head','electrical head'];
const FULL_ADMIN_ROLES = ['admin','operation head','director','hr','hr head'];

// Expose to inline onclick handlers
Object.assign(window, {
  showTab, selectKind, loadCurrent, submitReg,
  setTab, openAction, closeActionModal, confirmAction,
});

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

function init() {
  if (typeof renderSidebar === 'function') renderSidebar('regularization');

  // Reveal Approvals tab only for reviewer roles
  const role = (user.role || '').toLowerCase();
  if (REVIEWER_ROLES.includes(role)) {
    document.getElementById('topApprovalsTab').style.display = '';
    if (FULL_ADMIN_ROLES.includes(role)) {
      document.getElementById('tabAll').style.display = '';
    }
  }

  initApply();

  // Open Approvals tab directly if URL says so (e.g. old bookmark
  // /regularization-approvals.html redirects with ?tab=approvals)
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab') === 'approvals' && REVIEWER_ROLES.includes(role)) {
    showTab('approvals');
  }
}

function diag(label, msg) {
  const box  = document.getElementById('lensDiag');
  const list = document.getElementById('diagList');
  if (!box || !list) return console.error(label, msg);
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('en-IN',{hour12:false})}] ${label}: ${msg}`;
  list.appendChild(li);
  box.style.display = 'block';
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ════════════════════════════════════════════════════════════════════════════
// TOP-LEVEL PAGE TABS (Apply / Approvals)
// ════════════════════════════════════════════════════════════════════════════
function showTab(tab) {
  document.querySelectorAll('.ps-tabs .tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('paneApply').style.display     = (tab === 'apply')     ? '' : 'none';
  document.getElementById('paneApprovals').style.display = (tab === 'approvals') ? '' : 'none';

  // Topbar context — different actions for each tab
  document.getElementById('approvalsSubtabs').style.display = (tab === 'approvals') ? '' : 'none';
  document.getElementById('applyBackLink').style.display    = (tab === 'apply')     ? '' : 'none';

  // Lazy-load Approvals data on first visit
  if (tab === 'approvals' && !approvalsLoaded) {
    approvalsLoaded = true;
    loadApprovals();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// APPLY TAB
// ════════════════════════════════════════════════════════════════════════════
function initApply() {
  // Default the date to yesterday (typical use case)
  const d = new Date(); d.setDate(d.getDate() - 1);
  document.getElementById('regDate').value = d.toISOString().slice(0, 10);
  loadReviewers();
  loadCurrent();
}

async function loadReviewers() {
  try {
    const r = await apiRequest('/hr/leave/reviewers');
    const sel = document.getElementById('appliedTo');
    if (!r.reviewers || r.reviewers.length === 0) {
      sel.innerHTML = '<option value="">No reviewers configured</option>';
      return;
    }
    const list = r.reviewers.filter(rv => rv.Id !== user.id);
    sel.innerHTML = '<option value="">— Pick reviewer —</option>' +
      list.map(rv => `<option value="${rv.Id}">${escape(rv.Name || rv.Email)} (${escape(rv.Role)})</option>`).join('');
  } catch (e) { diag('reviewers', e.message || e); }
}

async function loadCurrent() {
  const date = document.getElementById('regDate').value;
  const cur  = document.getElementById('regCurrent');
  if (!date) { cur.textContent = 'Pick a date to see current attendance'; cur.className = 'reg-current-row empty'; return; }
  try {
    const r = await apiRequest('/hr/attendance/log?days=30');
    const rows = (r.rows || []).filter(x => String(x.AttDate).slice(0, 10) === date);
    if (rows.length === 0) {
      cur.innerHTML = '⚠ <b>No attendance row</b> for this date — your request will create one if approved.';
      cur.className = 'reg-current-row';
      return;
    }
    const s = rows[0];
    const sin  = s.SignInTime  ? new Date(s.SignInTime).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true})  : '— missing —';
    const sout = s.SignOutTime ? new Date(s.SignOutTime).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}) : '— missing —';
    cur.innerHTML = `Current record: Sign-In <b>${sin}</b> · Sign-Out <b>${sout}</b>${s.IsRegularized ? ' <span style="background:#dcfce7;color:#166534;padding:2px 6px;border-radius:8px;font-size:10px;">already regularized</span>' : ''}`;
    cur.className = 'reg-current-row';
  } catch (e) { diag('attendance log', e.message || e); }
}

function selectKind(kind) {
  selectedKind = kind;
  document.querySelectorAll('.reg-kind-tile').forEach(el => {
    el.classList.toggle('selected', el.dataset.kind === kind);
  });
  const ts = document.getElementById('timeSection');
  ts.style.display = '';
  document.getElementById('signInBlock').style.display  = (kind === 'sign-in'  || kind === 'both') ? '' : 'none';
  document.getElementById('signOutBlock').style.display = (kind === 'sign-out' || kind === 'both') ? '' : 'none';
  checkReady();
}

function checkReady() {
  const date   = document.getElementById('regDate').value;
  const reason = document.getElementById('reason').value.trim();
  const btn    = document.getElementById('submitBtn');
  if (!btn) return;
  btn.disabled = !(date && selectedKind && reason.length > 0);
}
document.addEventListener('input', () => checkReady());

async function submitReg() {
  const err     = document.getElementById('applyError');     err.style.display = 'none';
  const success = document.getElementById('applySuccess');   success.style.display = 'none';
  const btn     = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';

  const payload = {
    attDate:               document.getElementById('regDate').value,
    kind:                  selectedKind,
    requestedSignInTime:   selectedKind === 'sign-out' ? null : document.getElementById('signInTime').value,
    requestedSignOutTime:  selectedKind === 'sign-in'  ? null : document.getElementById('signOutTime').value,
    reason:                document.getElementById('reason').value.trim(),
    appliedToUserId:       document.getElementById('appliedTo').value || null,
  };

  try {
    const r = await apiRequest('/hr/regularization/apply', { method: 'POST', body: payload });
    if (r && r.ok) {
      success.style.display = 'block';
      btn.style.display = 'none';
    } else {
      err.style.display = 'block'; err.textContent = (r && r.message) || 'Submit failed';
      btn.disabled = false; btn.textContent = 'Submit Regularization';
    }
  } catch (e) {
    err.style.display = 'block'; err.textContent = e.message || 'Submit failed';
    btn.disabled = false; btn.textContent = 'Submit Regularization';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// APPROVALS TAB
// ════════════════════════════════════════════════════════════════════════════
function setTab(tab) {
  activeSubTab = tab;
  document.querySelectorAll('.req-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  loadApprovals();
}

async function loadApprovals() {
  const list = document.getElementById('reqList');
  list.innerHTML = '<div class="holiday-skel" style="height:90px; margin-bottom:10px;"></div><div class="holiday-skel" style="height:90px;"></div>';
  let r;
  try {
    const scopeQ = activeSubTab === 'all' ? 'scope=all' : 'scope=pending-mine&status=pending';
    r = await apiRequest('/hr/regularization/requests?' + scopeQ);
  } catch (e) { diag('GET requests', e.message || e); list.innerHTML = ''; return; }
  const reqs = r.requests || [];
  if (reqs.length === 0) {
    list.innerHTML = `<div class="req-empty"><div class="ic">✨</div><div class="t">${activeSubTab === 'all' ? 'No regularization requests yet' : 'Inbox zero! No regularization requests pending your approval.'}</div></div>`;
    return;
  }
  list.innerHTML = reqs.map(renderCard).join('');
}

function renderCard(r) {
  const status = (r.Status || 'pending').toLowerCase();
  const day = new Date(r.AttDate).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric',weekday:'long'});
  const kindIcon  = { 'sign-in': '🌅', 'sign-out': '🌙', 'both': '📝' }[r.Kind] || '📝';
  const kindLabel = { 'sign-in': 'Sign-In missed', 'sign-out': 'Sign-Out missed', 'both': 'Both missed' }[r.Kind] || r.Kind;
  const showActions = status === 'pending';
  const inT  = r.RequestedSignInTime  ? fmtTime(r.RequestedSignInTime)  : '—';
  const outT = r.RequestedSignOutTime ? fmtTime(r.RequestedSignOutTime) : '—';
  return `
    <article class="req-card status-${status}">
      <div class="req-type-ic">${kindIcon}</div>
      <div class="req-detail">
        <div class="req-head">
          <span class="req-type">${escape(kindLabel)}</span>
          <span class="req-status-pill status-${status}">${status}</span>
          ${r.WfCode ? `<span class="wf-badge" title="${escape(r.WfName || r.WfCode)}">L${r.WfCurrentLevel}/${r.WfTotalLevels}</span>` : ''}
        </div>
        <div class="req-who"><b>${escape(r.UserName || 'Unknown')}</b> <span style="opacity:0.7;font-size:11px;font-family:monospace;">${escape(r.CompanyACode || r.UserId)}</span></div>
        <div class="req-dates">${day} · Sign-In <b>${inT}</b> · Sign-Out <b>${outT}</b></div>
        <div class="req-reason">"${escape(r.Reason)}"</div>
        ${r.ApprovedByName ? `<div class="req-decision">✓ Approved by <b>${escape(r.ApprovedByName)}</b>${r.ApprovalNote ? ': ' + escape(r.ApprovalNote) : ''}</div>` : ''}
        ${r.RejectedByName ? `<div class="req-decision">✗ Rejected by <b>${escape(r.RejectedByName)}</b>${r.RejectionReason ? ': ' + escape(r.RejectionReason) : ''}</div>` : ''}
      </div>
      <div class="req-actions">
        ${showActions ? `
          <button class="req-btn approve" onclick="openAction(${r.RegId}, 'approve')">✓ Approve</button>
          <button class="req-btn reject"  onclick="openAction(${r.RegId}, 'reject')">✗ Reject</button>
        ` : ''}
      </div>
    </article>`;
}

function fmtTime(t) {
  if (!t) return '—';
  const s = String(t);
  const [h, m] = s.split(':');
  if (h == null) return s;
  const hh   = parseInt(h);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const hh12 = hh % 12 || 12;
  return `${String(hh12).padStart(2,'0')}:${m} ${ampm}`;
}

function openAction(id, type) {
  pendingActionId   = id;
  pendingActionType = type;
  document.getElementById('actionTitle').textContent = type === 'approve' ? 'Approve Regularization' : 'Reject Regularization';
  document.getElementById('noteLabel').textContent   = type === 'approve' ? 'Approval note (optional)' : 'Reason for rejection (required)';
  document.getElementById('actionNote').value        = '';
  document.getElementById('actionNote').placeholder  = type === 'approve' ? 'e.g. Confirmed with manager — was at customer site' : 'e.g. Please attach proof of customer meeting';
  const btn = document.getElementById('actionConfirm');
  btn.textContent       = type === 'approve' ? 'Approve' : 'Reject';
  btn.style.background  = type === 'approve' ? '' : '#ef4444';
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
  const err  = document.getElementById('actionError');
  err.style.display = 'none';
  if (pendingActionType === 'reject' && !note) {
    err.style.display = 'block'; err.textContent = 'Please provide a reason for rejection.';
    return;
  }
  try {
    const path = pendingActionType === 'approve'
      ? '/hr/regularization/' + pendingActionId + '/approve'
      : '/hr/regularization/' + pendingActionId + '/reject';
    const body = pendingActionType === 'approve' ? { note } : { reason: note };
    await apiRequest(path, { method: 'PUT', body });
    closeActionModal();
    loadApprovals();
  } catch (e) {
    err.style.display = 'block'; err.textContent = e.message || 'Action failed';
  }
}
