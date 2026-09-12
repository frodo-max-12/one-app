// =====================================================================
// live-map.js — real-time field-staff locations (ONE App Lens, v1.8)
//
// Polls GET /api/hr/location/live every REFRESH_S seconds and plots each
// supervised employee's latest ping on a Leaflet map (delivery-app style).
// Liveness colour is derived from MinsAgo: <=15 live, <=45 idle, else stale.
// Permissions are enforced server-side (lens-admin / head / self).
// =====================================================================
const lmUser = requireAuth();
if (lmUser) { renderSidebar('live-map'); setRoleTag(); }

const REFRESH_S = 25;
const PUNE = [18.5204, 73.8567];

let lmMap, lmTiles;
let lmMarkers = {};         // userId -> L.marker
let lmData = [];            // last feed
let lmCountdown = REFRESH_S;
let lmTimer = null, lmTick = null;
let lmFollowId = null;      // userId we're keeping centred (after a click)

function lmInitMap() {
  lmMap = L.map('lmMap', { zoomControl: true }).setView(PUNE, 12);
  lmTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(lmMap);
}

function liveness(minsAgo, hasPing) {
  if (!hasPing || minsAgo == null) return { cls: 'lm-off',   color: '#c0392b', label: 'not tracking today' };
  if (minsAgo <= 15)               return { cls: 'lm-live',  color: '#16a34a', label: minsAgo + ' min ago' };
  if (minsAgo <= 45)               return { cls: 'lm-idle',  color: '#f0a22e', label: minsAgo + ' min ago' };
  return                                  { cls: 'lm-stale', color: '#888',    label: minsAgo + ' min ago' };
}

function lmMarkerIcon(color, initials) {
  return L.divIcon({
    className: '', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
    html: `<div class="lm-marker" style="background:${color}"><span>${escapeHtml(initials)}</span></div>`,
  });
}
function initialsOf(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0] || '')[0] || '?').toUpperCase() + ((p[1] || '')[0] || '').toUpperCase();
}

async function lmRefresh() {
  try {
    const res = await apiRequest('/hr/location/live');
    if (!res || !res.users) return;
    lmData = res.users;
    document.getElementById('lmSummary').textContent =
      `${res.live} live · ${res.tracking} tracking · ${res.total} total`;
    drawMarkers();
    renderList();
  } catch (e) { /* keep last view on a transient failure */ }
  finally { lmCountdown = REFRESH_S; }
}

function drawMarkers() {
  const seen = {};
  lmData.forEach(u => {
    if (u.Lat == null || u.Lng == null) return;
    seen[u.UserId] = true;
    const lv = liveness(u.MinsAgo, true);
    const pos = [Number(u.Lat), Number(u.Lng)];
    const popup = `<b>${escapeHtml(u.Name)}</b><br>${escapeHtml((u.Role || '').toUpperCase())}<br>`
      + `Last seen: ${lv.label}<br>`
      + (u.BatteryPct != null ? `Battery: ${u.BatteryPct}%<br>` : '')
      + (u.Accuracy != null ? `Accuracy: ±${Math.round(u.Accuracy)} m<br>` : '')
      + (u.LastVisitName ? `Last visit: ${escapeHtml(u.LastVisitName)}<br>` : '')
      + `<a href="/modules/hr/journey.html?userId=${u.UserId}" target="_blank">View day journey →</a>`;
    if (lmMarkers[u.UserId]) {
      lmMarkers[u.UserId].setLatLng(pos).setIcon(lmMarkerIcon(lv.color, initialsOf(u.Name)));
      lmMarkers[u.UserId].getPopup() && lmMarkers[u.UserId].setPopupContent(popup);
    } else {
      lmMarkers[u.UserId] = L.marker(pos, { icon: lmMarkerIcon(lv.color, initialsOf(u.Name)) })
        .addTo(lmMap).bindPopup(popup);
    }
    if (lmFollowId === u.UserId) lmMap.panTo(pos);
  });
  // remove markers for users who dropped out of the feed
  Object.keys(lmMarkers).forEach(id => {
    if (!seen[id]) { lmMap.removeLayer(lmMarkers[id]); delete lmMarkers[id]; }
  });
}

function renderList() {
  const q = (document.getElementById('lmSearch').value || '').toLowerCase();
  const rows = lmData.filter(u => !q || (u.Name || '').toLowerCase().includes(q));
  document.getElementById('lmList').innerHTML = rows.map(u => {
    const lv = liveness(u.MinsAgo, u.Lat != null);
    return `<div class="lm-item" onclick="lmFocus(${u.UserId})">
      <div class="lm-status" style="background:${lv.color}"></div>
      <div style="flex:1; min-width:0;">
        <div class="lm-name">${escapeHtml(u.Name)}</div>
        <div class="lm-role">${escapeHtml(u.Role || '')}</div>
        <div class="lm-meta">
          ${lv.label}${u.BatteryPct != null ? ' · 🔋 ' + u.BatteryPct + '%' : ''}
          ${u.LastVisitName ? '<br>📍 ' + escapeHtml(u.LastVisitName) : ''}
        </div>
      </div>
    </div>`;
  }).join('') || '<div style="padding:16px; color:var(--text3); font-size:13px;">No employees in your scope.</div>';
}

function lmFocus(userId) {
  const u = lmData.find(x => x.UserId === userId);
  if (!u || u.Lat == null) { alert('No location for this employee today.'); return; }
  lmFollowId = userId;
  lmMap.setView([Number(u.Lat), Number(u.Lng)], 16);
  if (lmMarkers[userId]) lmMarkers[userId].openPopup();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function startTimers() {
  stopTimers();
  lmTick = setInterval(() => {
    lmCountdown--;
    const el = document.getElementById('lmCountdown');
    if (el) el.textContent = Math.max(0, lmCountdown);
    if (lmCountdown <= 0) lmRefresh();
  }, 1000);
}
function stopTimers() { if (lmTick) clearInterval(lmTick); lmTick = null; }

document.getElementById('lmSearch').addEventListener('input', renderList);
// Pause polling when the tab is hidden; resume + refresh when visible.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTimers();
  else { lmRefresh(); startTimers(); }
});

lmInitMap();
lmRefresh();
startTimers();

Object.assign(window, { lmFocus, lmRefresh });
