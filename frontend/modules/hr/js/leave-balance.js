// ============================================================================
// ONE App Lens — Leave Balance (employee + HR/admin view of any employee)
// ============================================================================
const user = requireAuth();
let viewingUserId = null;          // null = self; numeric = other user (HR view)
let viewingUserName = null;
let allUsers = [];

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

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('leave-balance');
  await loadUserList();
  await reloadAll();
}

async function loadUserList() {
  // Reuse Journey's pickable-users endpoint — same scoping rules apply.
  try {
    const r = await apiRequest('/hr/journey/pickable-users');
    const wrap = document.getElementById('empPickerWrap');
    const picker = document.getElementById('userPicker');
    if (!r || !r.users) return;
    if (r.users.length <= 1) {
      if (wrap) wrap.style.display = 'none';
      return;
    }
    if (wrap) wrap.style.display = '';
    allUsers = r.users;

    const role = (user.role || '').toLowerCase();
    const isAdminish = ['admin','operation head','director','hr','hr head','sales head','north sales head','electrical head'].includes(role);

    const others = allUsers.filter(u => u.Id !== user.id);
    others.sort((a, b) => (a.Name || '').localeCompare(b.Name || ''));
    const self = allUsers.find(u => u.Id === user.id);
    const ordered = self ? [self, ...others] : others;

    const opts = [];
    if (isAdminish) {
      opts.push(`<option value="" selected>— My balance —</option>`);
      ordered.forEach(u => opts.push(`<option value="${u.Id}">${escape(u.Name || u.Email)}</option>`));
    } else {
      ordered.forEach(u => opts.push(`<option value="${u.Id}" ${u.Id === user.id ? 'selected' : ''}>${escape(u.Name || u.Email)}</option>`));
    }
    picker.innerHTML = opts.join('');
    picker.addEventListener('change', () => {
      const v = picker.value;
      viewingUserId = v ? parseInt(v) : null;
      const u = viewingUserId ? allUsers.find(x => x.Id === viewingUserId) : null;
      viewingUserName = u ? u.Name : null;
      reloadAll();
    });
  } catch (e) { diag('pickable-users', e.message || e); }
}

async function reloadAll() {
  // Update headings
  const isOther = !!viewingUserId && viewingUserId !== user.id;
  document.getElementById('balHeading').textContent = isOther
    ? `FY 2026-27 — ${viewingUserName || 'Employee'}'s leave balance`
    : 'FY 2026-27 — your leave balance';
  document.getElementById('appsHeading').textContent = isOther
    ? `${viewingUserName || 'Employee'}'s recent applications`
    : 'My recent applications';
  document.getElementById('grantsHeading').textContent = isOther
    ? `${viewingUserName || 'Employee'}'s grants & adjustments`
    : 'Grants & adjustments from HR';

  await Promise.all([loadBalances(), loadGrants(), loadRequests()]);
}

async function loadGrants() {
  const list = document.getElementById('grantsList');
  const path = viewingUserId ? `/hr/leave/grants?userId=${viewingUserId}` : '/hr/leave/grants';
  let r;
  try { r = await apiRequest(path); }
  catch (e) { diag('GET /leave/grants', e.message || e); list.innerHTML = ''; return; }
  const grants = (r.grants || []).slice(0, 12);
  if (grants.length === 0) {
    list.innerHTML = `<div class="req-empty"><div class="ic">📜</div><div class="t">No grants or adjustments yet</div><div class="s">HR will use this section to record any bonus leaves, comp-offs, or corrections.</div></div>`;
    return;
  }
  list.innerHTML = grants.map(renderGrantCard).join('');
}

function renderGrantCard(g) {
  const d = new Date(g.GrantedAt);
  const dateStr = d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) + ' · ' + d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true});
  const days = Number(g.Days);
  const daysCls = days >= 0 ? 'positive' : 'negative';
  const daysStr = (days >= 0 ? '+' : '') + days.toFixed(days % 1 === 0 ? 0 : 1) + (days === 1 || days === -1 ? ' day' : ' days');
  const kindLabel = ({
    'bonus': '🎁 Bonus Leave',
    'comp-off': '🔄 Comp-Off Grant',
    'joiner-adjust': '👋 New Joiner Adjustment',
    'correction': '✏ Correction',
    'year-end-reset': '🔁 Year-End Reset',
  })[g.Kind] || ('🏷 ' + (g.Kind || 'Grant'));
  const cardClass = g.IsRevoked ? 'status-cancelled' : (days >= 0 ? 'status-approved' : 'status-rejected');
  return `
    <article class="req-card ${cardClass}" style="opacity:${g.IsRevoked ? '0.6' : '1'};">
      <div class="req-type-ic">${g.LeaveTypeIcon || '📅'}</div>
      <div class="req-detail">
        <div class="req-head">
          <span class="req-type">${escape(kindLabel)}</span>
          <span class="days-pill ${daysCls}" style="color:${days >= 0 ? '#16a34a' : '#dc2626'}; ${g.IsRevoked ? 'text-decoration:line-through;' : ''}">${daysStr}</span>
          ${g.IsRevoked ? `<span class="req-status-pill status-cancelled">REVOKED</span>` : ''}
        </div>
        <div class="req-dates">${escape(g.LeaveTypeName || g.LeaveTypeCode)} · ${dateStr}</div>
        <div class="req-who">Granted by <b>${escape(g.GrantedByName || 'HR')}</b></div>
        ${g.Reason ? `<div class="req-reason">"${escape(g.Reason)}"</div>` : ''}
        ${g.IsRevoked && g.RevokedByName ? `<div class="req-decision">↩ Revoked by <b>${escape(g.RevokedByName)}</b>${g.RevokeReason ? ': ' + escape(g.RevokeReason) : ''}</div>` : ''}
      </div>
      <div></div>
    </article>`;
}

async function loadBalances() {
  const grid = document.getElementById('balGrid');
  const path = viewingUserId ? `/hr/leave/balance?userId=${viewingUserId}` : '/hr/leave/balance';
  let r;
  try { r = await apiRequest(path); }
  catch (e) { diag('GET /leave/balance', e.message || e); return; }
  const bals = r.balances || [];
  if (bals.length === 0) {
    grid.innerHTML = `<div class="req-empty" style="grid-column:1/-1;"><div class="ic">🗓️</div><div class="t">No leave types found</div><div class="s">Have HR run SQL Files/hr/13_leave_types.sql and 17_update_leave_policy.sql.</div></div>`;
    return;
  }
  grid.innerHTML = bals.map(b => {
    if (b.Code === 'SHORT') {
      const used = Number(b.MonthUsed || 0);
      const cap  = Number(b.MonthCap  || 2);
      const left = Math.max(0, cap - used);
      return `
        <div class="bal-card" style="--bal-color:${b.Color || '#3b82f6'};">
          <div class="bal-head">
            <span class="bal-icon">${b.Icon || '⏱'}</span>
            <span class="bal-type">${escape(b.Name)}</span>
            <span class="bal-code">${escape(b.Code)}</span>
          </div>
          <div><span class="bal-available">${left}</span><span class="bal-suffix">of ${cap} left</span></div>
          <div class="bal-detail-row"><span class="label">This month</span><span class="value">${used} used</span></div>
          <div class="bal-detail-row"><span class="label">Resets</span><span class="value">1st of next month</span></div>
        </div>`;
    }
    if (b.AllowNegative) {
      return `
        <div class="bal-card" style="--bal-color:${b.Color || '#94a3b8'};">
          <div class="bal-head">
            <span class="bal-icon">${b.Icon || '💸'}</span>
            <span class="bal-type">${escape(b.Name)}</span>
            <span class="bal-code">${escape(b.Code)}</span>
          </div>
          <div><span class="bal-available">${num(b.Consumed)}</span><span class="bal-suffix">days used</span></div>
          <div class="bal-detail-row"><span class="label">Type</span><span class="value">No limit</span></div>
          <div class="bal-detail-row"><span class="label">Impact</span><span class="value">Salary deduction</span></div>
        </div>`;
    }
    return `
      <div class="bal-card" style="--bal-color:${b.Color || '#22c55e'};">
        <div class="bal-head">
          <span class="bal-icon">${b.Icon || '📅'}</span>
          <span class="bal-type">${escape(b.Name)}</span>
          <span class="bal-code">${escape(b.Code)}</span>
        </div>
        <div><span class="bal-available">${num(b.Available)}</span><span class="bal-suffix">days</span></div>
        <div class="bal-detail-row"><span class="label">Granted YTD</span><span class="value">${num(b.Granted)}</span></div>
        <div class="bal-detail-row"><span class="label">Consumed</span><span class="value">${num(b.Consumed)}</span></div>
        <div class="bal-detail-row"><span class="label">Pending</span><span class="value">${num(b.Pending)}</span></div>
      </div>`;
  }).join('');
}

async function loadRequests() {
  const list = document.getElementById('reqList');
  // When HR views another user, fetch ALL requests for that user via scope=all + filter client-side
  // (scope=mine on backend always means caller — there's no userId filter on requests; we filter client-side from the all-scope list)
  const isOther = !!viewingUserId && viewingUserId !== user.id;
  const path = isOther ? '/hr/leave/requests?scope=all' : '/hr/leave/requests?scope=mine';
  let r;
  try { r = await apiRequest(path); }
  catch (e) { diag('GET /leave/requests', e.message || e); list.innerHTML = ''; return; }
  let reqs = r.requests || [];
  if (isOther) reqs = reqs.filter(x => x.UserId === viewingUserId);
  reqs = reqs.slice(0, 20);
  if (reqs.length === 0) {
    list.innerHTML = `<div class="req-empty"><div class="ic">📭</div><div class="t">No leave applications ${isOther ? 'for this employee' : 'yet'}</div></div>`;
    return;
  }
  list.innerHTML = reqs.map(renderReqCard).join('');
}

function renderReqCard(r) {
  const status = (r.Status || 'pending').toLowerCase();
  const from = new Date(r.FromDate), to = new Date(r.ToDate);
  const sameDay = r.FromDate === r.ToDate;
  const dates = sameDay
    ? from.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) + (r.FromSession === 2 ? ' (PM)' : (r.ToSession === 1 ? ' (AM)' : ''))
    : from.toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) + ' → ' + to.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  const unit = r.LeaveTypeCode === 'SHORT' ? 'short leave' + (r.DaysApplied == 1 ? '' : 's') : 'day' + (r.DaysApplied == 1 ? '' : 's');
  const ownPendingByMe = (status === 'pending' && r.UserId === user.id);
  return `
    <article class="req-card status-${status}">
      <div class="req-type-ic">${r.LeaveTypeIcon || '📅'}</div>
      <div class="req-detail">
        <div class="req-head">
          <span class="req-type">${escape(r.LeaveTypeName || r.LeaveTypeCode)}</span>
          <span class="req-status-pill status-${status}">${status}</span>
          <span class="days-pill">${num(r.DaysApplied)} ${unit}</span>
        </div>
        <div class="req-dates">${dates}</div>
        ${r.AppliedToName ? `<div class="req-who">Applied to: <b>${escape(r.AppliedToName)}</b></div>` : ''}
        ${r.Reason ? `<div class="req-reason">"${escape(r.Reason)}"</div>` : ''}
        ${r.ApprovedByName ? `<div class="req-decision">✓ Approved by <b>${escape(r.ApprovedByName)}</b>${r.ApprovalNote ? ': ' + escape(r.ApprovalNote) : ''}</div>` : ''}
        ${r.RejectedByName ? `<div class="req-decision">✗ Rejected by <b>${escape(r.RejectedByName)}</b>${r.RejectionReason ? ': ' + escape(r.RejectionReason) : ''}</div>` : ''}
      </div>
      <div class="req-actions">
        ${ownPendingByMe ? `<button class="req-btn cancel" onclick="cancelLeave(${r.LeaveId})">Cancel</button>` : ''}
      </div>
    </article>`;
}

window.cancelLeave = async function (id) {
  if (!confirm('Cancel this leave application?')) return;
  try {
    await apiRequest('/hr/leave/' + id + '/cancel', { method: 'PUT' });
    reloadAll();
  } catch (e) { diag('cancel', e.message || e); }
};

function num(n) { const v = Number(n) || 0; return v.toFixed(v % 1 === 0 ? 0 : 1); }
function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
