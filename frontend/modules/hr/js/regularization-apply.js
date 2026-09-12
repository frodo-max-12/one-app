// ============================================================================
// ONE App Lens — Apply Regularization (employee)
// ============================================================================
const user = requireAuth();
let selectedKind = null;

window.selectKind = selectKind;
window.loadCurrent = loadCurrent;
window.submitReg = submitReg;

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
  if (typeof renderSidebar === 'function') renderSidebar('regularization-apply');
  // Default to yesterday (typical use case)
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
  const cur = document.getElementById('regCurrent');
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
  document.getElementById('submitBtn').disabled = !(date && selectedKind && reason.length > 0);
}
document.addEventListener('input', () => checkReady());

async function submitReg() {
  const err = document.getElementById('applyError'); err.style.display = 'none';
  const success = document.getElementById('applySuccess'); success.style.display = 'none';
  const btn = document.getElementById('submitBtn');
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

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
