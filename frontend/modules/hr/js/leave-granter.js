// ============================================================================
// ONE App Lens — Leave Granter (HR admin batch tool)
// ============================================================================
const user = requireAuth();
let allEmps = [];
let selectedEmps = new Set();
let allTypes = [];
let kind = 'bonus';

window.selectKind = selectKind;
window.filterEmps = filterEmps;
window.selectAll = selectAll;
window.clearSelection = clearSelection;
window.toggleEmp = toggleEmp;
window.submitGrant = submitGrant;
window.revokeGrant = revokeGrant;

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
  if (typeof renderSidebar === 'function') renderSidebar('leave-granter');
  document.getElementById('days').addEventListener('input', checkReady);
  document.getElementById('reason').addEventListener('input', checkReady);
  document.getElementById('leaveType').addEventListener('change', checkReady);
  await Promise.all([loadTypes(), loadEmployees(), loadHistory()]);
}

function selectKind(k) {
  kind = k;
  document.querySelectorAll('.lg-kind-pill').forEach(el => el.classList.toggle('selected', el.dataset.kind === k));
}

async function loadTypes() {
  try {
    const r = await apiRequest('/hr/leave/types');
    allTypes = r.types || [];
    const sel = document.getElementById('leaveType');
    sel.innerHTML = '<option value="">— Pick leave type —</option>' +
      allTypes.map(t => `<option value="${t.Code}">${t.Icon || '📅'} ${escape(t.Name)} (${t.Code})</option>`).join('');
  } catch (e) { diag('GET /leave/types', e.message || e); }
}

async function loadEmployees() {
  try {
    const r = await apiRequest('/hr/office-presence/employees');
    allEmps = (r.employees || []).filter(e => e.Role && e.Role.toLowerCase() !== 'admin');   // hide admins from the list, optional
    // Restore: include everyone — admins may also receive grants
    allEmps = r.employees || [];
    renderEmps();
  } catch (e) { diag('GET /office-presence/employees', e.message || e); }
}

function renderEmps() {
  const q = (document.getElementById('empSearch').value || '').trim().toLowerCase();
  const list = document.getElementById('empList');
  const filtered = q
    ? allEmps.filter(e => (e.UserName || '').toLowerCase().includes(q) || (e.Email || '').toLowerCase().includes(q) || (e.CompanyACode || '').toLowerCase().includes(q))
    : allEmps;
  document.getElementById('empCount').textContent = `${filtered.length} of ${allEmps.length}`;
  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:20px; text-align:center; color:var(--lens-text-3); font-size:13px;">No matches</div>';
    return;
  }
  list.innerHTML = filtered.map(e => {
    const isSel = selectedEmps.has(e.UserId);
    return `
      <div class="lg-emp-row ${isSel ? 'selected' : ''}" onclick="toggleEmp(${e.UserId})">
        <div class="lg-emp-check"></div>
        <div>
          <div class="lg-emp-name">${escape(e.UserName || e.Email)}</div>
          <div class="lg-emp-sub">${escape(e.CompanyACode || e.Role || '—')}</div>
        </div>
        <div class="lg-emp-cur">${escape(e.Email || '')}</div>
      </div>`;
  }).join('');
}

function toggleEmp(uid) {
  if (selectedEmps.has(uid)) selectedEmps.delete(uid);
  else                       selectedEmps.add(uid);
  renderEmps();
  refreshSelectedCount();
  checkReady();
}

function refreshSelectedCount() {
  const wrap = document.getElementById('selectedCount');
  if (selectedEmps.size > 0) {
    wrap.style.display = 'block';
    document.getElementById('selectedCountNum').textContent = selectedEmps.size;
  } else {
    wrap.style.display = 'none';
  }
}

function filterEmps() { renderEmps(); }

function selectAll() {
  const q = (document.getElementById('empSearch').value || '').trim().toLowerCase();
  const visible = q
    ? allEmps.filter(e => (e.UserName || '').toLowerCase().includes(q) || (e.Email || '').toLowerCase().includes(q) || (e.CompanyACode || '').toLowerCase().includes(q))
    : allEmps;
  visible.forEach(e => selectedEmps.add(e.UserId));
  renderEmps(); refreshSelectedCount(); checkReady();
}

function clearSelection() {
  selectedEmps.clear();
  renderEmps(); refreshSelectedCount(); checkReady();
}

function checkReady() {
  const days   = Number(document.getElementById('days').value);
  const type   = document.getElementById('leaveType').value;
  const reason = document.getElementById('reason').value.trim();
  const ready = selectedEmps.size > 0 && type && Number.isFinite(days) && days !== 0 && reason.length > 0;
  document.getElementById('grantBtn').disabled = !ready;
}

async function submitGrant() {
  const err = document.getElementById('grantError'); err.style.display = 'none';
  const success = document.getElementById('grantSuccess'); success.style.display = 'none';
  const btn = document.getElementById('grantBtn');
  btn.disabled = true; btn.textContent = 'Granting…';

  const days   = Number(document.getElementById('days').value);
  const type   = document.getElementById('leaveType').value;
  const reason = document.getElementById('reason').value.trim();

  const assignments = [...selectedEmps].map(uid => ({ userId: uid, leaveTypeCode: type, days, reason, kind }));

  try {
    const r = await apiRequest('/hr/leave/grant', { method: 'POST', body: { assignments } });
    if (r && r.ok) {
      document.getElementById('successMsg').textContent =
        `Grant issued — ${r.inserted} employee(s) updated${r.skipped > 0 ? `, ${r.skipped} skipped` : ''}.`;
      success.style.display = 'block';
      // Reset form
      selectedEmps.clear();
      document.getElementById('days').value = '';
      document.getElementById('reason').value = '';
      refreshSelectedCount(); renderEmps(); checkReady();
      loadHistory();
    } else {
      err.style.display = 'block'; err.textContent = (r && r.message) || 'Grant failed';
    }
  } catch (e) {
    err.style.display = 'block'; err.textContent = e.message || 'Grant failed';
  } finally {
    btn.disabled = false; btn.textContent = 'Issue Grant';
    checkReady();
  }
}

async function loadHistory() {
  let r;
  try { r = await apiRequest('/hr/leave/grants'); }
  catch (e) { diag('GET /leave/grants', e.message || e); return; }
  const tbody = document.getElementById('historyBody');
  const grants = r.grants || [];
  if (grants.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--lens-text-3);">No grants issued yet.</td></tr>';
    return;
  }
  tbody.innerHTML = grants.map(g => {
    const d = new Date(g.GrantedAt);
    const dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' · ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    const days = Number(g.Days);
    const daysCls = days >= 0 ? 'positive' : 'negative';
    const daysStr = (days >= 0 ? '+' : '') + days.toFixed(days % 1 === 0 ? 0 : 1);
    return `
      <tr class="${g.IsRevoked ? 'revoked' : ''}">
        <td>${dateStr}</td>
        <td><b style="color:var(--lens-text);">${escape(g.UserName || g.UserId)}</b><br><span style="font-size:11px;color:var(--lens-text-3);font-family:monospace;">${escape(g.CompanyACode || '')}</span></td>
        <td>${g.LeaveTypeIcon || '📅'} ${escape(g.LeaveTypeName || g.LeaveTypeCode)}</td>
        <td class="days-cell ${daysCls}">${daysStr}</td>
        <td style="max-width:240px;">${escape((g.Kind || '').replace(/-/g, ' '))}<br><span style="font-size:11px;color:var(--lens-text-3);">${escape(g.Reason || '')}</span></td>
        <td>${escape(g.GrantedByName || '')}</td>
        <td>${g.IsRevoked
          ? `<span style="font-size:11px; color:var(--lens-text-3);">↩ ${escape(g.RevokedByName || '')}</span>`
          : `<button class="lg-revoke-btn" onclick="revokeGrant(${g.GrantId})">Revoke</button>`}</td>
      </tr>`;
  }).join('');
}

async function revokeGrant(id) {
  const reason = prompt('Why revoke this grant? (will be logged)');
  if (!reason) return;
  try {
    await apiRequest('/hr/leave/grants/' + id + '/revoke', { method: 'PUT', body: { reason } });
    loadHistory();
  } catch (e) { diag('revoke', e.message || e); }
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
