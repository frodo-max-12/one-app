// ============================================================================
// ONE App Lens — Home page logic (v3)
//
// Hardening notes:
//   - All click handlers ALSO wired via inline onclick="" in home.html, so
//     even if this script throws before binding, the buttons still work.
//   - Every API call is wrapped in a diag(...) helper that surfaces the
//     actual error to the on-screen Diagnostics block — no more silent
//     "Loading…" forever.
// ============================================================================

const user = requireAuth();

// Expose functions globally so the inline onclick handlers in home.html resolve.
window.openSignModal = openSignModal;
window.closeSignModal = closeSignModal;
window.openHolidayModal = openHolidayModal;
window.closeHolidayModal = closeHolidayModal;
window.fetchLocation = fetchLocation;
window.startCamera   = startCamera;
window.captureSelfie = captureSelfie;
window.retakeSelfie  = retakeSelfie;
window.submitSign    = submitSign;
window.closeConfirm  = closeConfirm;
window.openTrackingSettings = openTrackingSettings;
window.dismissTrackingSetup = dismissTrackingSetup;

let currentMode    = 'in';
let currentLat     = null;
let currentLng     = null;
let currentAcc     = null;
let currentBattery = null;
let selfieDataUri  = null;
let videoStream    = null;
let bigClockTimer  = null;

if (user) {
  // Init may need DOM — run on next tick to be safe.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHome);
  } else {
    setTimeout(initHome, 0);
  }
}

function initHome() {
  try {
    const first = (user.name || user.username || '').split(' ')[0] || 'there';
    setText('userFirstName', first);

    const now = new Date();
    setText('todayLine', now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    setText('shiftDay',  now.toLocaleDateString('en-IN', { weekday: 'long' }));
    setText('shiftDate', now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }));
    setText('whoisDate', now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }));

    startBigClock();

    if (typeof renderSidebar === 'function') renderSidebar('home');

    refreshDay();
    refreshWhoIsIn();
    refreshHolidays();
    refreshSummary();
    refreshVisitPunchCard();
    maybeShowTrackingSetup();
  } catch (err) {
    diag('init failed', err.message || err);
  }
}

// ─── One-time tracking-setup guide (Android app only) ───────────────────────
// Shows once per device. Asks for "Allow all the time" location + battery
// optimization exemption so the background tracker isn't killed when idle.
const TRACKING_SETUP_KEY = 'lens_tracking_setup_done_v1';
function isNativeAndroid() {
  try {
    const cap = window.Capacitor;
    return !!(cap && (cap.getPlatform ? cap.getPlatform() === 'android' : cap.platform === 'android'));
  } catch (_) { return false; }
}
function maybeShowTrackingSetup() {
  if (!isNativeAndroid()) return;                          // web users don't need this
  if (localStorage.getItem(TRACKING_SETUP_KEY)) return;    // already shown
  const m = document.getElementById('trackingSetupModal');
  if (m) m.hidden = false;
}
function openTrackingSettings() {
  // Opens the app's settings page where both Location + Battery options live.
  try {
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation;
    if (plugin && typeof plugin.openSettings === 'function') {
      plugin.openSettings();
    }
  } catch (e) {
    diag('openSettings failed', e.message || e);
  }
  // Leave the modal up so they can read the steps while in Settings; they tap
  // "I've done this" when they return.
}
function dismissTrackingSetup() {
  localStorage.setItem(TRACKING_SETUP_KEY, '1');
  const m = document.getElementById('trackingSetupModal');
  if (m) m.hidden = true;
}

// ─── Visit Punch quick-access card (v1.8) ───────────────────────────────────
// Shown only for field-going roles (sales, sales heads, FAE). Toggles between
// "Punch In at Customer" CTA and "Active visit at X — Punch Out" state with
// the customer name pulled from /api/hr/visit-punch/open.
async function refreshVisitPunchCard() {
  const card = document.getElementById('vpHomeCard');
  if (!card) return;
  const role = (user && user.role || '').toLowerCase().trim();
  const isField = role === 'sales' || /\bhead\b/.test(role) || role === 'fae' || role === 'fae head';
  // HR + admin oversee but don't punch; hide the tile for them.
  if (!isField) { card.style.display = 'none'; return; }
  card.style.display = '';

  try {
    const r = await apiRequest('/hr/visit-punch/open');
    const open = r && r.open;
    if (open && open.VisitId) {
      card.classList.add('vp-home-active');
      document.getElementById('vpHomeIcon').textContent = '▶';
      document.getElementById('vpHomeTitle').textContent = 'Active visit: ' + (open.CustomerName || 'Customer');
      document.getElementById('vpHomeSub').textContent =
        'Punched in at ' + new Date(open.PunchInTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) +
        ' · Tap to Punch Out';
      document.getElementById('vpHomeCta').textContent = '⏹ Punch Out';
    } else {
      card.classList.remove('vp-home-active');
      document.getElementById('vpHomeIcon').textContent = '📍';
      document.getElementById('vpHomeTitle').textContent = 'Punch In at Customer';
      document.getElementById('vpHomeSub').textContent   = 'Selfie + premise photo. GPS captured automatically.';
      document.getElementById('vpHomeCta').textContent   = '▶ Punch In';
    }
  } catch (e) {
    // Offline or API error — leave default copy. Card still links to the page.
    diag && diag('visit-punch open check failed (non-fatal)', e.message || e);
  }
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function startBigClock() {
  function tick() {
    const d = new Date();
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    setText('clockHour', String(h).padStart(2, '0'));
    setText('clockMin',  String(d.getMinutes()).padStart(2, '0'));
    setText('clockAmpm', ampm);
  }
  tick();
  if (bigClockTimer) clearInterval(bigClockTimer);
  bigClockTimer = setInterval(tick, 15 * 1000);
}

// ─── Diagnostics helper ─────────────────────────────────────────────────────
function diag(label, msg) {
  const box  = document.getElementById('lensDiag');
  const list = document.getElementById('diagList');
  if (!box || !list) return console.error(label, msg);
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('en-IN', { hour12: false })}] ${label}: ${msg}`;
  list.appendChild(li);
  box.style.display = 'block';
  console.warn('[lens]', label, msg);
}

async function safeApi(path, opts) {
  try {
    const r = await apiRequest(path, opts);
    return { ok: true, data: r };
  } catch (e) {
    diag(`API ${opts && opts.method || 'GET'} ${path}`, e.message || String(e));
    return { ok: false, err: e.message || String(e) };
  }
}

// ─── Today state ────────────────────────────────────────────────────────────
async function refreshDay() {
  const res = await safeApi('/hr/attendance/today');
  if (!res.ok) return;
  const today    = res.data && res.data.today;       // latest session for today
  const sessions = (res.data && res.data.sessions) || [];
  const btn      = document.getElementById('signInBtn');
  const label    = document.getElementById('signBtnLabel');
  const sigState = document.getElementById('signedState');
  const sigAt    = document.getElementById('signedAtLabel');
  if (!btn) return;

  if (!today) {
    btn.classList.remove('signedIn'); btn.disabled = false;
    if (label) label.textContent = 'Sign In';
    if (sigState) sigState.style.display = 'none';
    renderCompliance(null);
    currentMode = 'in';
    return;
  }
  renderCompliance(today);
  if (today.SignInTime && !today.SignOutTime) {
    // Latest session is OPEN → must sign out
    btn.classList.add('signedIn'); btn.disabled = false;
    if (label) label.textContent = 'Sign Out';
    if (sigAt) sigAt.textContent = `${fmtTime(today.SignInTime)} (Session ${today.Session})`;
    if (sigState) sigState.style.display = 'inline-flex';
    currentMode = 'out';
  } else if (today.SignOutTime) {
    // Latest session is CLOSED → user can sign in again (split-shift / lunch break)
    btn.classList.remove('signedIn'); btn.disabled = false;
    if (label) label.textContent = 'Sign In Again';
    const summary = sessions.map(s =>
      s.SignOutTime ? `${fmtTime(s.SignInTime)}–${fmtTime(s.SignOutTime)}` : `${fmtTime(s.SignInTime)}–…`
    ).join(' · ');
    if (sigAt) sigAt.textContent = summary;
    if (sigState) sigState.style.display = 'inline-flex';
    currentMode = 'in';   // next click starts a new session
  }
}
function fmtTime(t) { return new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }); }

// ─── Compliance card: 4 time-points + countdown + flags ────────────────────
// Driven by the row returned from /attendance/today (extended in Phase A to
// include ExpectedSignOutTime / LunchOutTime / LunchInTime / flags).
let _countdownTimer = null;
let _countdownCache = null;   // {expected: Date, isOpen: bool} so the ticker doesn't need DOM lookups every second
function renderCompliance(today) {
  const box = document.getElementById('attCompliance');
  if (!box) return;
  if (!today) {
    box.style.display = 'none';
    _countdownCache = null;
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    return;
  }
  box.style.display = '';

  // 4 time points
  const isOpen = !!today.SignInTime && !today.SignOutTime;
  setPoint('ptSignIn',  today.SignInTime,  today.LateSignIn      ? 'is-late' : (today.SignInTime ? 'is-done' : ''));
  setPoint('ptLunchOut', today.LunchOutTime, today.LunchOutTime  ? 'is-done' : (isOpen ? 'is-due' : ''));
  setPoint('ptLunchIn',  today.LunchInTime,  today.LateLunchReturn ? 'is-late' : (today.LunchInTime ? 'is-done' : (today.LunchOutTime ? 'is-due' : '')));
  const signOutCls = today.AutoSignOut ? 'is-auto'
                   : today.ShortDay     ? 'is-late'
                   : today.SignOutTime  ? 'is-done'
                   : (isOpen ? 'is-due' : '');
  setPoint('ptSignOut', today.SignOutTime, signOutCls);

  // Flag pills
  const strip = document.getElementById('attFlagStrip');
  if (strip) {
    const flags = (today.ComplianceFlags || '').split(',').map(s => s.trim()).filter(Boolean);
    const FLAG_LABELS = {
      late_signin:    '⚠ Late sign-in',
      late_lunch:     '⚠ Late from lunch',
      short_day:      '⚠ Short day',
      no_lunch:       '⚠ No lunch detected',
      auto_signout:   '⓪ Auto sign-out (geofence)',
      lunch_pending:  '⏳ Lunch break in progress',
    };
    strip.innerHTML = flags.map(f =>
      `<span class="att-flag f-${f}">${FLAG_LABELS[f] || f}</span>`
    ).join('');
  }

  // Countdown to expected sign-out
  _countdownCache = today.ExpectedSignOutTime
    ? { expected: new Date(today.ExpectedSignOutTime), isOpen }
    : null;
  tickCountdown();
  if (_countdownTimer) clearInterval(_countdownTimer);
  if (_countdownCache && isOpen) _countdownTimer = setInterval(tickCountdown, 30_000);
}

function setPoint(id, iso, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = iso ? fmtTime(iso) : '—';
  const pt = el.closest('.att-pt');
  if (pt) pt.className = 'att-pt' + (cls ? ' ' + cls : '');
}

function tickCountdown() {
  const el = document.getElementById('attCountdown');
  if (!el) return;
  if (!_countdownCache) { el.textContent = ''; el.className = 'att-countdown'; return; }
  const { expected, isOpen } = _countdownCache;
  if (!isOpen) {
    el.textContent = `Expected out: ${fmtTime(expected)}`;
    el.className   = 'att-countdown';
    return;
  }
  const diffMs = expected - new Date();
  const absMin = Math.abs(Math.round(diffMs / 60_000));
  const h = Math.floor(absMin / 60);
  const m = absMin % 60;
  const hhmm = (h ? h + 'h ' : '') + m + 'm';
  if (diffMs >= 0) {
    el.textContent = `${hhmm} left → ${fmtTime(expected)}`;
    el.className   = 'att-countdown' + (diffMs < 30 * 60_000 ? ' soon' : '');
  } else {
    el.textContent = `Overdue by ${hhmm} (expected ${fmtTime(expected)})`;
    el.className   = 'att-countdown overdue';
  }
}

// ─── Who Is In ──────────────────────────────────────────────────────────────
async function refreshWhoIsIn() {
  const res = await safeApi('/hr/whois/today');
  const c = (res.ok && res.data && res.data.counts) || { onTime: 0, lateIn: 0, notYetIn: 0, outOfOffice: 0 };
  setText('cOnTime', c.onTime);
  setText('cLateIn', c.lateIn);
  setText('cNotYet', c.notYetIn);
  setText('cOOO',    c.outOfOffice);
  const total = c.onTime + c.lateIn + c.notYetIn + c.outOfOffice;
  setText('whoTeamCount', total);
  const CIRC = 251;
  let off = 0;
  function arc(id, count) {
    const el = document.getElementById(id); if (!el) return;
    const len = total ? (count / total) * CIRC : 0;
    el.setAttribute('stroke-dasharray',  `${Math.max(0, len - 2)} ${CIRC - Math.max(0, len - 2)}`);
    el.setAttribute('stroke-dashoffset', -off);
    off += len;
  }
  arc('whoArcOnTime', c.onTime); arc('whoArcLate', c.lateIn); arc('whoArcNotYet', c.notYetIn);
}

// ─── Holidays ───────────────────────────────────────────────────────────────
async function refreshHolidays() {
  const grid = document.getElementById('holidayGrid'); if (!grid) return;
  const res = await safeApi('/hr/holiday/upcoming?n=4');
  if (!res.ok) {
    grid.innerHTML = `<div class="holiday-empty">Couldn't load holidays — see Diagnostics below.</div>`;
    return;
  }
  const list = res.data && res.data.upcoming;
  if (!list || list.length === 0) {
    grid.innerHTML = '<div class="holiday-empty">No upcoming holidays</div>';
    return;
  }
  grid.innerHTML = '';
  list.forEach((h, i) => {
    const d = new Date(h.HolidayDate);
    const div = document.createElement('div');
    div.className = `holiday-item var-${(i % 4) + 1}`;
    div.innerHTML = `
      <div class="hol-date">
        <div class="hol-day-num">${d.getDate()}</div>
        <div class="hol-day-name">${d.toLocaleDateString('en-IN', { month: 'short' })}</div>
      </div>
      <div>
        <div class="hol-name">${escapeHtml(h.Occasion)}</div>
        <div class="hol-weekday">${d.toLocaleDateString('en-IN', { weekday: 'long' })}</div>
      </div>`;
    grid.appendChild(div);
  });
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// ─── All-holidays modal ("View calendar →") ──────────────────────────────────
async function openHolidayModal() {
  const m = document.getElementById('holidayModal'); if (!m) return;
  m.hidden = false;
  const box = document.getElementById('holidayAllList');
  const year = new Date().getFullYear();
  const titleEl = document.getElementById('holidayModalTitle');
  if (titleEl) titleEl.textContent = `Holiday Calendar ${year}`;
  if (box) box.innerHTML = '<div class="holiday-empty">Loading…</div>';
  const res = await safeApi('/hr/holiday/?year=' + year);
  if (!res.ok) { if (box) box.innerHTML = '<div class="holiday-empty">Couldn\'t load holidays.</div>'; return; }
  const list = (res.data && res.data.holidays) || [];
  if (!list.length) { if (box) box.innerHTML = `<div class="holiday-empty">No holidays found for ${year}.</div>`; return; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  box.innerHTML = list.map(h => {
    const d = new Date(h.HolidayDate);
    const past = d < today;
    return `<div class="holiday-row${past ? ' past' : ''}">
      <div class="hr-date">
        <span class="hr-day">${d.getDate()}</span>
        <span class="hr-mon">${d.toLocaleDateString('en-IN', { month: 'short' })}</span>
      </div>
      <div class="hr-info">
        <div class="hr-occ">${escapeHtml(h.Occasion)}</div>
        <div class="hr-sub">${d.toLocaleDateString('en-IN', { weekday: 'long' })}${h.HolidayType ? ' · ' + escapeHtml(h.HolidayType) : ''}</div>
      </div>
    </div>`;
  }).join('');
}
function closeHolidayModal() {
  const m = document.getElementById('holidayModal'); if (m) m.hidden = true;
}

// ─── Summary ────────────────────────────────────────────────────────────────
async function refreshSummary() {
  const res = await safeApi('/hr/attendance/summary');
  const s = (res.ok && res.data && res.data.summary) || {};
  const cells = [
    { num: s.Present   || 0, lbl: 'Present' },
    { num: s.Absent    || 0, lbl: 'Absent' },
    { num: s.OnLeave   || 0, lbl: 'Leave' },
    { num: s.Holiday   || 0, lbl: 'Holiday' },
    { num: s.HalfDay   || 0, lbl: 'Half-Day' },
    { num: s.WeeklyOff || 0, lbl: 'Weekly Off' },
  ];
  const grid = document.getElementById('summaryGrid'); if (!grid) return;
  grid.innerHTML = cells.map(c => `<div class="summary-cell"><div class="num">${c.num}</div><div class="lbl">${c.lbl}</div></div>`).join('');
  const hrs = Math.round(((s.TotalWorkMin || 0) / 60) * 10) / 10;
  setText('summaryHours', `${hrs} hrs worked`);
  setText('exceptionDays', (res.ok && res.data && res.data.exceptionDays) || 0);
  const ex = document.getElementById('exceptionBanner');
  if (ex) ex.style.display = ((res.ok && res.data && res.data.exceptionDays) || 0) > 0 ? 'flex' : 'none';
}

// ─── Sign-In / Sign-Out modal ───────────────────────────────────────────────
function openSignModal() {
  console.log('[lens] openSignModal mode=', currentMode);
  if (currentMode === 'done') { diag('sign-in', 'already signed out for today'); return; }
  const isIn = currentMode === 'in';
  setText('signModalTitle', isIn ? 'Sign-In Details' : 'Sign-Out Details');
  const submit = document.getElementById('signSubmit');
  if (submit) { submit.textContent = 'Fetching location…'; submit.disabled = true; }

  const modal = document.getElementById('signModal'); if (!modal) return;
  modal.hidden = false;

  // Reset state
  selfieDataUri = null;
  const v = document.getElementById('selfieVideo'); if (v) v.style.display = '';
  const p = document.getElementById('selfiePreview'); if (p) p.style.display = 'none';
  const t = document.getElementById('signRemarks'); if (t) t.value = '';
  setText('remarksCount', '0');
  const err = document.getElementById('signError'); if (err) err.style.display = 'none';
  document.getElementById('selfieCapture').disabled = true;
  document.getElementById('selfieRetake').disabled  = true;
  document.getElementById('selfieStart').disabled   = false;

  const now = new Date();
  setText('signDate', now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));
  setText('signTime', now.toLocaleTimeString('en-IN', { hour12: false }));

  fetchLocation();
  readBattery();
}

function closeSignModal() {
  stopCamera();
  const m = document.getElementById('signModal'); if (m) m.hidden = true;
}
function closeConfirm() {
  const m = document.getElementById('confirmModal'); if (m) m.hidden = true;
  refreshDay(); refreshWhoIsIn();
}

function setErr(msg) { const e = document.getElementById('signError'); if (!e) return; e.style.display = 'block'; e.textContent = msg; }
function clearErr()  { const e = document.getElementById('signError'); if (e) e.style.display = 'none'; }

function checkReady() {
  const btn = document.getElementById('signSubmit'); if (!btn) return;
  const ready = currentLat != null && currentLng != null;
  btn.disabled = !ready;
  if (ready) {
    btn.textContent = currentMode === 'in' ? 'Sign In' : 'Sign Out';
    btn.style.background = '';
  }
}

function fetchLocation() {
  const row = document.getElementById('locRow');
  if (row) row.classList.remove('error');
  setText('locAcc', 'Fetching location…');
  setText('locCoord', 'Long, Lat: —, —');
  if (!navigator.geolocation) {
    if (row) row.classList.add('error');
    setText('locAcc', 'Geolocation not supported by this browser');
    handleLocFailure(new Error('Geolocation API unavailable'));
    return;
  }
  // Pass 1: high accuracy, 30s timeout, accept 60s cached
  navigator.geolocation.getCurrentPosition(
    onLocOk,
    (err) => {
      diag('geolocation pass-1', err.message + ' (code ' + err.code + ')');
      // On TIMEOUT (code 3) or POSITION_UNAVAILABLE (code 2), try again with
      // looser settings — useful indoors / on weak GPS.
      if (err.code === 3 || err.code === 2) {
        navigator.geolocation.getCurrentPosition(
          onLocOk,
          (err2) => handleLocFailure(err2),
          { enableHighAccuracy: false, timeout: 20000, maximumAge: 5 * 60 * 1000 }
        );
      } else {
        handleLocFailure(err);
      }
    },
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 60 * 1000 }
  );
}

function onLocOk(pos) {
  const row = document.getElementById('locRow');
  if (row) row.classList.remove('error');
  currentLat = pos.coords.latitude;
  currentLng = pos.coords.longitude;
  currentAcc = pos.coords.accuracy;
  setText('locAcc',   `Your Current Location Accuracy: ${Math.round(currentAcc)}m`);
  setText('locCoord', `Long, Lat: ${currentLng.toFixed(7)}, ${currentLat.toFixed(7)}`);
  checkReady();
  clearErr();
}

function handleLocFailure(err) {
  const row = document.getElementById('locRow');
  if (row) row.classList.add('error');
  const msg = (err && err.message) || 'Unknown error';
  setText('locAcc', 'Location: ' + msg);
  if (currentMode === 'out') {
    // Sign-out without GPS is allowed — let the user proceed.
    setText('locCoord', 'No location captured (you can still sign out)');
    setErr('Couldn\'t fetch location. You may sign out without it — your in-office time is computed from the sign-in location.');
    enableSignOutAnyway();
  } else {
    setErr('We need your location to sign in. Allow location in the browser settings and tap ↻ to retry.');
  }
  diag('geolocation', msg);
}

// When sign-out and geolocation fails, allow user to proceed without GPS.
function enableSignOutAnyway() {
  const btn = document.getElementById('signSubmit');
  if (!btn || currentMode !== 'out') return;
  btn.disabled = false;
  btn.textContent = 'Sign Out (no location)';
  btn.style.background = '#94a3b8';
}

async function readBattery() {
  try { if (navigator.getBattery) { const b = await navigator.getBattery(); currentBattery = Math.round((b.level || 0) * 100); } } catch (_) {}
}

async function startCamera() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } }, audio: false });
    const v = document.getElementById('selfieVideo'); if (v) v.srcObject = videoStream;
    document.getElementById('selfieCapture').disabled = false;
    document.getElementById('selfieStart').disabled   = true;
  } catch (err) {
    setErr('Camera unavailable: ' + err.message + ' — you can still sign in without a selfie.');
  }
}

function captureSelfie() {
  const video  = document.getElementById('selfieVideo');
  const canvas = document.getElementById('selfieCanvas');
  if (!video || !canvas) return;
  const size = Math.min(video.videoWidth || 480, video.videoHeight || 480, 600);
  canvas.width  = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.translate(size, 0); ctx.scale(-1, 1);
  const sx = (video.videoWidth - size) / 2; const sy = (video.videoHeight - size) / 2;
  ctx.drawImage(video, sx, sy, size, size, 0, 0, size, size);
  selfieDataUri = canvas.toDataURL('image/jpeg', 0.78);
  const img = document.getElementById('selfiePreview'); if (img) { img.src = selfieDataUri; img.style.display = ''; }
  video.style.display = 'none';
  document.getElementById('selfieCapture').disabled = true;
  document.getElementById('selfieRetake').disabled  = false;
  stopCamera();
}

function retakeSelfie() {
  selfieDataUri = null;
  const p = document.getElementById('selfiePreview'); if (p) p.style.display = 'none';
  const v = document.getElementById('selfieVideo');   if (v) v.style.display = '';
  document.getElementById('selfieRetake').disabled = true;
  document.getElementById('selfieStart').disabled  = false;
}

function stopCamera() {
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
  const s = document.getElementById('selfieStart'); if (s) s.disabled = false;
}

async function submitSign() {
  const btn = document.getElementById('signSubmit'); if (!btn) return;
  btn.disabled = true; btn.textContent = 'Saving…';
  clearErr();
  const payload = {
    lat: currentLat, lng: currentLng, accuracy: currentAcc, batteryPct: currentBattery,
    remarks: (document.getElementById('signRemarks') || {}).value || '',
    selfieData: selfieDataUri, isMocked: false, shiftCode: '09:45-18:15',
  };
  const path = currentMode === 'in' ? '/hr/attendance/sign-in' : '/hr/attendance/sign-out';
  const res = await safeApi(path, { method: 'POST', body: payload });
  if (res.ok && res.data && res.data.ok) {
    closeSignModal();
    // Phase 2.1: start/stop continuous tracker on sign-in/out
    if (window.LensTracker) {
      if (currentMode === 'in')  window.LensTracker.start();
      if (currentMode === 'out') window.LensTracker.stop();
    }
    showConfirm(currentMode, res.data);
  } else {
    setErr((res.data && res.data.message) || res.err || 'Submit failed');
  }
  btn.disabled = false;
  btn.textContent = currentMode === 'in' ? 'Sign In' : 'Sign Out';
}

function showConfirm(mode, r) {
  setText('confirmTitle', mode === 'in' ? 'Hurrah 🎉' : 'All done 😊');
  setText('confirmSub',   mode === 'in' ? "You've signed in. Let's get going." : "You've signed out. See you later!");
  const t = mode === 'in' ? r.signInTime : r.signOutTime;
  const d = new Date(t);
  setText('confirmDate', d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));
  setText('confirmTime', d.toLocaleTimeString('en-IN', { hour12: false }));
  const m = document.getElementById('confirmModal'); if (m) m.hidden = false;
}
