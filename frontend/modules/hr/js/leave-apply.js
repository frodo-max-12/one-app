// ============================================================================
// ONE App Lens — Apply for Leave (employee)
// ============================================================================
const user = requireAuth();
let allTypes = [];
let balances = {};        // code -> available
let selectedType = null;

window.recalc = recalc;
window.submitLeave = submitLeave;

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
  if (typeof renderSidebar === 'function') renderSidebar('leave-apply');
  // Default dates = today
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('fromDate').value = today;
  document.getElementById('toDate').value   = today;
  await Promise.all([loadTypesAndBalance(), loadReviewers()]);
  recalc();
}

async function loadTypesAndBalance() {
  try {
    const [tRes, bRes] = await Promise.all([
      apiRequest('/hr/leave/types'),
      apiRequest('/hr/leave/balance'),
    ]);
    allTypes = tRes.types || [];
    (bRes.balances || []).forEach(b => { balances[b.Code] = b; });
    renderTypeTiles();
  } catch (e) { diag('load types/balance', e.message || e); }
}

function renderTypeTiles() {
  const wrap = document.getElementById('typeTiles');
  wrap.innerHTML = allTypes.map(t => {
    const b = balances[t.Code] || {};
    let avail;
    if (t.Code === 'SHORT') {
      // Short Leave — separate monthly allowance, count-based
      const cap = Number(b.MonthCap || t.MonthlyGrant || 2);
      const used = Number(b.MonthUsed || 0);
      const left = Math.max(0, cap - used);
      avail = `${left} of ${cap} left · this month`;
    } else if (t.AllowNegative) {
      // LOP — no balance concept
      avail = 'No limit';
    } else {
      avail = num(b.Available != null ? b.Available : t.AnnualGrant) + ' days avail';
    }
    return `
      <div class="type-tile" data-code="${t.Code}" style="--tile-color:${t.Color || '#22c55e'};" onclick="selectType('${t.Code}')">
        <div class="ic">${t.Icon || '📅'}</div>
        <div class="nm">${escape(t.ShortLabel || t.Name)}</div>
        <div class="av">${avail}</div>
      </div>`;
  }).join('');
}

function isShortLeave(code) {
  return code === 'SHORT';
}


window.selectType = function (code) {
  selectedType = code;
  document.querySelectorAll('.type-tile').forEach(el => {
    el.classList.toggle('selected', el.dataset.code === code);
  });
  applyShortLeaveUI(code);
  recalc();
};

// SHORT type → constrain UI: single date, 1st-half/2nd-half radio replaces session radios
function applyShortLeaveUI(code) {
  const isShort = isShortLeave(code);
  // Hide the "To date" block — short leave is always one day
  const dateRow = document.querySelector('.date-row');
  if (!dateRow) return;
  const blocks = dateRow.querySelectorAll('.date-block');
  if (blocks.length < 2) return;

  if (isShort) {
    // Re-label the From block, hide the To block
    const label1 = blocks[0].querySelector('label'); if (label1) label1.textContent = 'Date';
    blocks[1].style.display = 'none';

    // Replace From session radios with 1st-half / 2nd-half options
    blocks[0].querySelector('.session-radio').innerHTML = `
      <label><input type="radio" name="fromSession" value="2" checked onchange="recalc()" /><span>1st Half (late arrival)</span></label>
      <label><input type="radio" name="fromSession" value="1" onchange="recalc()" /><span>2nd Half (early depart)</span></label>
    `;
    // Force ToDate = FromDate
    document.getElementById('toDate').value = document.getElementById('fromDate').value;
    // ToSession mirrors FromSession for SHORT (single half-day window)
  } else {
    // Restore normal range UI
    const label1 = blocks[0].querySelector('label'); if (label1) label1.textContent = 'From';
    blocks[1].style.display = '';
    blocks[0].querySelector('.session-radio').innerHTML = `
      <label><input type="radio" name="fromSession" value="1" checked onchange="recalc()" /><span>Full day (from AM)</span></label>
      <label><input type="radio" name="fromSession" value="2" onchange="recalc()" /><span>PM only</span></label>
    `;
  }
}

async function loadReviewers() {
  try {
    const r = await apiRequest('/hr/leave/reviewers');
    const sel = document.getElementById('appliedTo');
    if (!r.reviewers || r.reviewers.length === 0) {
      sel.innerHTML = '<option value="">No reviewers configured</option>';
      return;
    }
    // Filter self out
    const list = r.reviewers.filter(rv => rv.Id !== user.id);
    sel.innerHTML = '<option value="">— Pick reviewer —</option>' +
      list.map(rv => `<option value="${rv.Id}">${escape(rv.Name || rv.Email)} (${escape(rv.Role)})</option>`).join('');
  } catch (e) { diag('reviewers', e.message || e); }
}

function recalc() {
  const fd = document.getElementById('fromDate').value;
  let td = document.getElementById('toDate').value;
  const fsEl = document.querySelector('input[name=fromSession]:checked');
  const tsEl = document.querySelector('input[name=toSession]:checked');
  const fs = fsEl ? parseInt(fsEl.value) : 1;
  let ts = tsEl ? parseInt(tsEl.value) : 2;

  let days = 0;
  let label = '';
  if (selectedType && isShortLeave(selectedType)) {
    days = 1;                    // count of short leaves (1 event)
    td = fd;
    ts = fs;
    document.getElementById('toDate').value = fd;
    // Show "1 short leave" instead of "1 day"
    const variant = fs === 2 ? '1st half · arrive 11:15 AM' : '2nd half · leave 4:30 PM';
    label = `<span class="days-pill" style="margin-left:6px;">1 short leave</span> · ${variant}`;
  } else if (fd && td) {
    days = computeDays(fd, fs, td, ts);
    label = days > 0 ? `<span class="days-pill" style="margin-left:6px;">${num(days)} day${days==1?'':'s'}</span> · Sundays excluded` : '— · Sundays excluded';
  } else {
    label = '— · Sundays excluded';
  }
  document.getElementById('daysCalc').innerHTML = label;

  const ready = selectedType && days > 0 && !!fd;
  document.getElementById('submitBtn').disabled = !ready;
}

function computeDays(fd, fs, td, ts) {
  const s = new Date(fd), e = new Date(td);
  if (e < s) return 0;
  let d = 0; const cur = new Date(s);
  while (cur <= e) { if (cur.getDay() !== 0) d += 1; cur.setDate(cur.getDate()+1); }
  if (fs === 2) d -= 0.5;
  if (ts === 1) d -= 0.5;
  return Math.max(0, d);
}

async function submitLeave() {
  const err = document.getElementById('applyError'); err.style.display = 'none';
  const success = document.getElementById('applySuccess'); success.style.display = 'none';
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';

  const payload = {
    leaveTypeCode:    selectedType,
    fromDate:         document.getElementById('fromDate').value,
    fromSession:      parseInt(document.querySelector('input[name=fromSession]:checked').value),
    toDate:           document.getElementById('toDate').value,
    toSession:        parseInt(document.querySelector('input[name=toSession]:checked').value),
    reason:           document.getElementById('reason').value.trim(),
    appliedToUserId:  document.getElementById('appliedTo').value || null,
    contactDetails:   document.getElementById('contactDetails').value.trim(),
  };

  try {
    const r = await apiRequest('/hr/leave/apply', { method: 'POST', body: payload });
    if (r && r.ok) {
      success.style.display = 'block';
      btn.style.display = 'none';
    } else {
      err.style.display = 'block'; err.textContent = (r && r.message) || 'Submit failed';
      btn.disabled = false; btn.textContent = 'Submit Application';
    }
  } catch (e) {
    err.style.display = 'block'; err.textContent = e.message || 'Submit failed';
    btn.disabled = false; btn.textContent = 'Submit Application';
  }
}

function num(n) { const v = Number(n) || 0; return v.toFixed(v % 1 === 0 ? 0 : 1); }
function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
