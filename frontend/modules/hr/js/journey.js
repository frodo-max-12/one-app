// ============================================================================
// ONE App Lens — Day Journey page
// Builds: Leaflet map + polyline of GPS pings + sign-in/out + visit pins +
//         time-scrub replay slider with play/pause and 1/4/16x speeds.
// ============================================================================

const user = requireAuth();

window.togglePlay = togglePlay;
window.onScrub    = onScrub;
window.setSpeed   = setSpeed;

let map, polyline, cursorMarker, startMarker, endMarker;
let visitMarkers = [];
let pingMarkers  = [];           // optional small dots, hidden by default
let dayPings     = [];           // sorted by PingTime asc
let daySessions  = [];
let dayVisits    = [];
let daySnapped   = [];           // road-snapped polyline [[lat,lng]...] from backend
let isSnapped    = false;        // true when daySnapped is a real road-snap (not raw fallback)
let scrubIdx     = 0;            // current index into dayPings (or -1 if none)
let playTimer    = null;
let speed        = 1;            // 1× / 4× / 16×

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

function diag(label, msg) {
  const box  = document.getElementById('lensDiag');
  const list = document.getElementById('diagList');
  if (!box || !list) return console.error(label, msg);
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('en-IN', { hour12: false })}] ${label}: ${msg}`;
  list.appendChild(li);
  box.style.display = 'block';
}

function init() {
  if (typeof renderSidebar === 'function') renderSidebar('journey');

  // default date = today
  const today = new Date();
  document.getElementById('dateFilter').value = today.toISOString().slice(0, 10);
  document.getElementById('dateFilter').addEventListener('change', load);

  document.getElementById('userPicker').addEventListener('change', load);

  initMap();
  loadUserList();
  load();
}

function initMap() {
  map = L.map('journeyMap', { zoomControl: true, attributionControl: true })
    .setView([18.5204, 73.8567], 12);   // Pune default

  // OSM tiles for now — free, no key needed. Swap to Ola Maps tile URL when ready.
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);
}

async function loadUserList() {
  try {
    const r = await apiRequest('/hr/journey/pickable-users');
    const wrap = document.getElementById('empPickerWrap');
    const picker = document.getElementById('userPicker');
    if (!r || !r.users) return;
    if (r.users.length <= 1) { if (wrap) wrap.style.display = 'none'; return; }
    if (wrap) wrap.style.display = '';
    const role = (user.role || '').toLowerCase();
    const isAdminish = ['admin','operation head','director','hr','hr head'].includes(role);

    const others = r.users.filter(u => u.Id !== user.id);
    others.sort((a, b) => (a.Name || '').localeCompare(b.Name || ''));
    const self = r.users.find(u => u.Id === user.id);
    const ordered = self ? [self, ...others] : others;

    const opts = [];
    if (isAdminish) {
      opts.push('<option value="" selected>— Select employee —</option>');
      ordered.forEach(u => opts.push(`<option value="${u.Id}">${escape(u.Name || u.Email)}</option>`));
    } else {
      ordered.forEach(u => opts.push(`<option value="${u.Id}" ${u.Id === user.id ? 'selected' : ''}>${escape(u.Name || u.Email)}</option>`));
    }
    picker.innerHTML = opts.join('');
  } catch (e) { diag('GET /pickable-users', e.message || e); }
}

async function load() {
  pause();
  const date        = document.getElementById('dateFilter').value;
  const pickerValue = document.getElementById('userPicker').value;
  const role        = (user.role || '').toLowerCase();
  const isAdminish  = ['admin','operation head','director','hr','hr head'].includes(role);
  if (!pickerValue && isAdminish) {
    showPickPrompt();
    return;
  }
  const userId = pickerValue || user.id;

  let r;
  try {
    r = await apiRequest(`/hr/journey/day?userId=${encodeURIComponent(userId)}&date=${encodeURIComponent(date)}`);
  } catch (e) {
    diag('GET /journey/day', e.message || e);
    return;
  }
  daySessions = r.sessions || [];
  dayPings    = r.pings    || [];
  dayVisits   = r.visits   || [];
  daySnapped  = r.snappedPath || [];
  isSnapped   = !!r.snapped;

  renderKpi(r);
  renderMap();
  renderScrub();
}

function showPickPrompt() {
  const empty = document.getElementById('journeyEmpty');
  ['kpiName','kpiFirstIn','kpiLastOut','kpiSessions','kpiPings','kpiDistance'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '—';
  });
  document.getElementById('kpiName').textContent = 'Select an employee →';
  if (polyline) { map.removeLayer(polyline); polyline = null; }
  visitMarkers.forEach(m => map.removeLayer(m)); visitMarkers = [];
  if (cursorMarker) { map.removeLayer(cursorMarker); cursorMarker = null; }
  if (empty) {
    empty.style.display = 'block';
    empty.querySelector('.t').textContent = 'Pick an employee to view their Day Journey';
    const hint = empty.querySelector('.s');
    if (hint) hint.textContent = 'Use the 👤 Employee dropdown in the top bar.';
  }
  document.getElementById('scrub').disabled = true;
}

function renderKpi(r) {
  document.getElementById('kpiName').textContent     = r.user ? (r.user.Name || r.user.Email) : '—';
  document.getElementById('kpiSessions').textContent = daySessions.length;
  document.getElementById('kpiPings').textContent    = dayPings.length;

  const firstIn  = daySessions[0]            && daySessions[0].SignInTime;
  const lastOut  = daySessions.length        && daySessions[daySessions.length - 1].SignOutTime;
  document.getElementById('kpiFirstIn').textContent = firstIn ? fmtT(firstIn) : '—';
  document.getElementById('kpiLastOut').textContent = lastOut ? fmtT(lastOut) : '—';

  // distance from pings (haversine sum)
  let km = 0;
  for (let i = 1; i < dayPings.length; i++) {
    km += haversine(dayPings[i-1].Lat, dayPings[i-1].Lng, dayPings[i].Lat, dayPings[i].Lng);
  }
  document.getElementById('kpiDistance').textContent = km.toFixed(2) + ' km';
}

function renderMap() {
  // Clear previous overlays
  if (polyline) { map.removeLayer(polyline); polyline = null; }
  if (cursorMarker) { map.removeLayer(cursorMarker); cursorMarker = null; }
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker)   { map.removeLayer(endMarker);   endMarker   = null; }
  visitMarkers.forEach(m => map.removeLayer(m)); visitMarkers = [];
  pingMarkers.forEach(m => map.removeLayer(m));  pingMarkers  = [];

  const empty = document.getElementById('journeyEmpty');
  if (dayPings.length === 0 && daySessions.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  // Prefer the backend road-snapped path (clean, follows streets). Fall back to
  // raw pings, then to sign-in/out points.
  const path = daySnapped.length >= 2
    ? daySnapped
    : dayPings.length
      ? dayPings.map(p => [p.Lat, p.Lng])
      : daySessions
          .flatMap(s => [
            s.SignInTime  && s.SignInLat  != null ? [s.SignInLat,  s.SignInLng]  : null,
            s.SignOutTime && s.SignOutLat != null ? [s.SignOutLat, s.SignOutLng] : null,
          ])
          .filter(Boolean);

  if (path.length >= 2) {
    polyline = L.polyline(path, { color: '#22c55e', weight: 4, opacity: 0.85, lineJoin: 'round' }).addTo(map);
  }

  // Sign-In / Sign-Out markers (per session)
  daySessions.forEach((s, idx) => {
    if (s.SignInTime && s.SignInLat != null) {
      const m = L.marker([s.SignInLat, s.SignInLng], { icon: makeIcon('signin', `${idx + 1}`) })
        .bindPopup(popupHtml(`Session ${s.Session} · Sign-In`, s.SignInTime, s.SignInRemarks, s.SignInSelfieUrl, s.SignInLat, s.SignInLng));
      m.addTo(map);
      visitMarkers.push(m);
      if (idx === 0) startMarker = m;
    }
    if (s.SignOutTime && s.SignOutLat != null) {
      const m = L.marker([s.SignOutLat, s.SignOutLng], { icon: makeIcon('signout', `${idx + 1}`) })
        .bindPopup(popupHtml(`Session ${s.Session} · Sign-Out`, s.SignOutTime, s.SignOutRemarks, s.SignOutSelfieUrl, s.SignOutLat, s.SignOutLng));
      m.addTo(map);
      visitMarkers.push(m);
      endMarker = m;
    }
  });

  // Visit pins (geofence-confirmed customer visits) — empty until next chunk
  dayVisits.forEach((v, i) => {
    if (v.Lat == null) return;
    const m = L.marker([v.Lat, v.Lng], { icon: makeIcon('visit', String(i + 1)) })
      .bindPopup(`<b>${escape(v.CustomerName || 'Visit')}</b><br>${fmtT(v.EntryTime)} → ${fmtT(v.ExitTime) || '…'}<br>${v.DurationMin || '—'} min`);
    m.addTo(map);
    visitMarkers.push(m);
  });

  // Cursor (replay) marker — starts at end so user sees full journey on load
  if (dayPings.length > 0) {
    scrubIdx = dayPings.length - 1;
    const last = dayPings[scrubIdx];
    cursorMarker = L.marker([last.Lat, last.Lng], { icon: makeIcon('cursor', '') }).addTo(map);
  } else {
    scrubIdx = -1;
  }

  // Fit bounds to all points
  const bounds = [];
  if (polyline) bounds.push(...polyline.getLatLngs());
  visitMarkers.forEach(m => bounds.push(m.getLatLng()));
  if (bounds.length >= 1) {
    map.fitBounds(L.latLngBounds(bounds).pad(0.15));
  }
}

function makeIcon(kind, label) {
  return L.divIcon({
    className: '',
    html: `<div class="lens-marker ${kind}">${escape(label)}</div>`,
    iconSize: kind === 'cursor' ? [22, 22] : (kind === 'visit' ? [28, 28] : [32, 32]),
    iconAnchor: kind === 'cursor' ? [11, 11] : (kind === 'visit' ? [14, 14] : [16, 16]),
  });
}

function popupHtml(title, time, remarks, selfieUrl, lat, lng) {
  const map = `https://www.google.com/maps?q=${lat},${lng}`;
  const sel = selfieUrl
    ? `<img src="${escape(selfieUrl)}" style="width:96px;height:96px;border-radius:50%;object-fit:cover;display:block;margin:6px auto;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);" />`
    : '';
  return `<div style="min-width:180px;">
    <div style="font-weight:600;margin-bottom:4px;">${escape(title)}</div>
    <div style="font-size:11px;color:#64748b;margin-bottom:6px;">${fmtT(time)}</div>
    ${sel}
    ${remarks ? `<div style="font-size:12px;font-style:italic;margin:6px 0;">"${escape(remarks)}"</div>` : ''}
    <a href="${map}" target="_blank" style="font-size:12px;">📍 View on Google Maps</a>
  </div>`;
}

// ── Replay slider ───────────────────────────────────────────────────────────
function renderScrub() {
  const sl = document.getElementById('scrub');
  if (dayPings.length === 0) {
    sl.disabled = true; sl.max = 0; sl.value = 0;
    document.getElementById('scrubTime').textContent = '--:--:--';
    sl.style.setProperty('--p', '0%');
    return;
  }
  sl.disabled = false;
  sl.max = String(dayPings.length - 1);
  sl.value = sl.max;
  updateScrubUI(parseInt(sl.value));
}

function onScrub() {
  pause();
  updateScrubUI(parseInt(document.getElementById('scrub').value));
}

function updateScrubUI(idx) {
  if (idx < 0 || idx >= dayPings.length) return;
  scrubIdx = idx;
  const p = dayPings[idx];
  document.getElementById('scrubTime').textContent = fmtTfull(p.PingTime);
  document.getElementById('scrub').style.setProperty('--p', ((idx / (dayPings.length - 1)) * 100) + '%');
  if (cursorMarker) cursorMarker.setLatLng([p.Lat, p.Lng]);
  // Cinematic shrink only when the polyline is built from raw pings (indices
  // line up with dayPings). When the track is road-snapped, its points don't
  // map 1:1 to pings, so we leave the full clean track visible and just move
  // the cursor marker along it.
  if (polyline && !isSnapped) {
    const shown = dayPings.slice(0, idx + 1).map(x => [x.Lat, x.Lng]);
    polyline.setLatLngs(shown);
  }
}

function togglePlay() {
  if (playTimer) pause();
  else play();
}

function play() {
  if (dayPings.length === 0) return;
  // If we're at the end, restart from beginning
  if (scrubIdx >= dayPings.length - 1) {
    scrubIdx = 0;
    document.getElementById('scrub').value = '0';
    updateScrubUI(0);
  }
  document.getElementById('playBtn').textContent = '❚❚';
  document.getElementById('playBtn').classList.add('playing');
  const baseMs = 200;   // 5 fps at 1×
  const intervalMs = Math.max(20, Math.round(baseMs / speed));
  playTimer = setInterval(() => {
    if (scrubIdx >= dayPings.length - 1) { pause(); return; }
    scrubIdx++;
    document.getElementById('scrub').value = String(scrubIdx);
    updateScrubUI(scrubIdx);
  }, intervalMs);
}

function pause() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  const btn = document.getElementById('playBtn');
  if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
}

function setSpeed(s) {
  speed = s;
  document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.speed) === s));
  if (playTimer) { pause(); play(); }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function fmtT(t)     { return t ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : ''; }
function fmtTfull(t) { return t ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--'; }
function escape(s)   { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function haversine(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lat2 == null) return 0;
  const R = 6371; // km
  const toRad = (x) => (Number(x) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
