// ============================================================================
// ONE App Lens — Geofence Admin
// CRUD over /api/hr/geofence + NAV Customer autocomplete via /customer-suggest
// ============================================================================

const user = requireAuth();

// expose for inline onclick
window.startAddMode   = startAddMode;
window.cancelAddMode  = cancelAddMode;
window.closeGfModal   = closeGfModal;
window.saveFence      = saveFence;
window.deleteFence    = deleteFence;
window.onRadiusChange = onRadiusChange;

let map, circles = [], markers = [];
let addMode = false;
let editingId = null;          // null = new, else GeofenceId
let pendingMarker = null;       // marker shown while creating
let pendingCircle = null;
let allFences = [];
let custSearchTimer = null;
let addrSearchTimer = null;    // for Nominatim address autocomplete

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

function diag(label, msg) {
  const box = document.getElementById('lensDiag');
  const list = document.getElementById('diagList');
  if (!box || !list) return console.error(label, msg);
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('en-IN', { hour12: false })}] ${label}: ${msg}`;
  list.appendChild(li);
  box.style.display = 'block';
}

function init() {
  if (typeof renderSidebar === 'function') renderSidebar('geofence');

  document.getElementById('gfSearch').addEventListener('input', debounce(loadList, 250));
  document.getElementById('gfKindFilter').addEventListener('change', loadList);
  document.getElementById('gfCustSearch').addEventListener('input', onCustSearch);
  document.getElementById('gfAddrSearch').addEventListener('input', onAddrSearch);

  // Click-away dismisses the address suggestions list
  document.addEventListener('click', (e) => {
    const addrBox = document.getElementById('gfAddrList');
    const addrInp = document.getElementById('gfAddrSearch');
    if (addrBox && !addrBox.contains(e.target) && e.target !== addrInp) addrBox.hidden = true;
  });

  initMap();
  loadList();
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function initMap() {
  map = L.map('gfMap', { zoomControl: true }).setView([18.5204, 73.8567], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);

  map.on('click', (e) => {
    if (!addMode) return;
    placePending(e.latlng.lat, e.latlng.lng);
    openGfModal(null, e.latlng.lat, e.latlng.lng);
    cancelAddMode();   // exit place-mode after first click
  });
}

// ── List + render ──────────────────────────────────────────────────────────
async function loadList() {
  const q    = document.getElementById('gfSearch').value;
  const kind = document.getElementById('gfKindFilter').value;
  const qs = new URLSearchParams();
  if (q)    qs.set('search', q);
  if (kind) qs.set('kind',   kind);
  let r;
  try {
    r = await apiRequest('/hr/geofence' + (qs.toString() ? '?' + qs.toString() : ''));
  } catch (e) { diag('GET /geofence', e.message || e); return; }
  allFences = r.geofences || [];
  document.getElementById('gfCount').textContent = `${allFences.length} fence${allFences.length === 1 ? '' : 's'}`;
  renderGrid();
  renderMap();
}

function renderGrid() {
  const g = document.getElementById('gfGrid');
  if (allFences.length === 0) {
    g.innerHTML = `
      <div class="gf-empty">
        <div class="ic">📍</div>
        <div class="t">No geofences yet</div>
        <div class="s">Click <b>+ Add Geofence</b> to drop the first one on the map.</div>
      </div>`;
    return;
  }
  g.innerHTML = allFences.map(f => `
    <article class="gf-card" onclick="openGfModalById(${f.GeofenceId})">
      <div class="gf-card-head">
        <div class="gf-card-kind ${escape(f.Kind || 'customer')}">${kindIcon(f.Kind)}</div>
        <div>
          <div class="gf-card-name">${escape(f.Name)}</div>
          <div class="gf-card-sub">${escape(f.CustomerCode || '—')} ${f.City ? '· ' + escape(f.City) : ''}</div>
        </div>
      </div>
      <div class="gf-card-meta">
        <span class="pill">${f.RadiusM} m</span>
        <span class="pill">⏱ ${f.DwellMinForVisit || 10} min</span>
        ${f.Company ? `<span class="pill">${escape(f.Company)}</span>` : ''}
      </div>
      <div class="gf-card-coord">${(+f.CenterLat).toFixed(5)}, ${(+f.CenterLng).toFixed(5)}</div>
    </article>`).join('');
}

window.openGfModalById = (id) => {
  const f = allFences.find(x => x.GeofenceId === id);
  if (!f) return;
  openGfModal(f);
  if (map) map.flyTo([f.CenterLat, f.CenterLng], 15, { duration: 0.8 });
};

function kindIcon(k) {
  return ({ customer: '🏢', office: '🏛️', warehouse: '📦', site: '🚧' })[k] || '📍';
}

function renderMap() {
  circles.forEach(c => map.removeLayer(c)); circles = [];
  markers.forEach(m => map.removeLayer(m)); markers = [];

  allFences.forEach(f => {
    const c = L.circle([f.CenterLat, f.CenterLng], {
      radius: f.RadiusM,
      color: '#16a34a',
      fillColor: '#22c55e',
      fillOpacity: 0.18,
      weight: 2,
    }).addTo(map);
    c.bindPopup(`<b>${escape(f.Name)}</b><br>${escape(f.CustomerCode || '')}<br><span style="color:#64748b">${f.RadiusM}m radius</span>`);
    c.on('click', () => openGfModalById(f.GeofenceId));
    circles.push(c);
  });

  // ── Zoom logic ──────────────────────────────────────────────────────────
  // If the top search filter is active AND matched results → zoom to FIRST match
  //   (fitting bounds across all matches can zoom out to all-of-India when matches
  //    are in different cities, which was the 2026-05-25 user complaint).
  // If no search filter → fit bounds to all geofences as before.
  const searchActive = !!document.getElementById('gfSearch').value.trim();
  if (allFences.length === 0) return;
  if (searchActive) {
    const first = allFences[0];
    map.flyTo([first.CenterLat, first.CenterLng], allFences.length === 1 ? 16 : 14, { duration: 0.6 });
  } else {
    const bounds = L.latLngBounds(allFences.map(f => [f.CenterLat, f.CenterLng]));
    map.fitBounds(bounds.pad(0.3));
  }
}

// ── Add mode (place on map) ─────────────────────────────────────────────────
function startAddMode() {
  addMode = true;
  document.getElementById('gfHint').style.display = 'flex';
  document.getElementById('gfMap').classList.add('gf-add-cursor');
}
function cancelAddMode() {
  addMode = false;
  document.getElementById('gfHint').style.display = 'none';
  document.getElementById('gfMap').classList.remove('gf-add-cursor');
}

function placePending(lat, lng) {
  if (pendingMarker) map.removeLayer(pendingMarker);
  if (pendingCircle) map.removeLayer(pendingCircle);
  pendingMarker = L.marker([lat, lng]).addTo(map);
  pendingCircle = L.circle([lat, lng], { radius: 100, color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.2 }).addTo(map);
}
function clearPending() {
  if (pendingMarker) { map.removeLayer(pendingMarker); pendingMarker = null; }
  if (pendingCircle) { map.removeLayer(pendingCircle); pendingCircle = null; }
}

// ── Modal: open/close ──────────────────────────────────────────────────────
function openGfModal(fence, lat, lng) {
  document.getElementById('gfError').style.display = 'none';
  if (fence) {
    editingId = fence.GeofenceId;
    document.getElementById('gfModalTitle').textContent = 'Edit Geofence';
    document.getElementById('gfDeleteBtn').style.display = 'inline-block';

    document.getElementById('gfName').value         = fence.Name || '';
    document.getElementById('gfKind').value         = fence.Kind || 'customer';
    document.getElementById('gfCompany').value      = fence.Company || '';
    document.getElementById('gfCustCode').value     = fence.CustomerCode || '';
    document.getElementById('gfCity').value         = fence.City    || '';
    document.getElementById('gfAddress').value      = fence.Address || '';
    document.getElementById('gfPincode').value      = fence.Pincode || '';
    document.getElementById('gfRadius').value       = fence.RadiusM || 100;
    document.getElementById('gfDwell').value        = fence.DwellMinForVisit || 10;
    document.getElementById('gfCustSearch').value   = '';
    document.getElementById('gfCustList').hidden    = true;
    document.getElementById('gfAddrSearch').value   = '';
    document.getElementById('gfAddrList').hidden    = true;
    setCoord(fence.CenterLat, fence.CenterLng);
    placePending(fence.CenterLat, fence.CenterLng);
  } else {
    editingId = null;
    document.getElementById('gfModalTitle').textContent = 'New Geofence';
    document.getElementById('gfDeleteBtn').style.display = 'none';

    document.getElementById('gfName').value         = '';
    document.getElementById('gfKind').value         = 'customer';
    document.getElementById('gfCompany').value      = '';
    document.getElementById('gfCustCode').value     = '';
    document.getElementById('gfCity').value         = '';
    document.getElementById('gfAddress').value      = '';
    document.getElementById('gfPincode').value      = '';
    document.getElementById('gfRadius').value       = 100;
    document.getElementById('gfDwell').value        = 10;
    document.getElementById('gfCustSearch').value   = '';
    document.getElementById('gfCustList').hidden    = true;
    document.getElementById('gfAddrSearch').value   = '';
    document.getElementById('gfAddrList').hidden    = true;
    setCoord(lat, lng);
  }
  onRadiusChange();
  document.getElementById('gfModal').hidden = false;
}

function closeGfModal() {
  document.getElementById('gfModal').hidden = true;
  clearPending();
}

function setCoord(lat, lng) {
  const el = document.getElementById('gfCoord');
  if (lat == null || lng == null) { el.textContent = '—'; el.dataset.lat = ''; el.dataset.lng = ''; return; }
  el.textContent = `${(+lat).toFixed(6)}, ${(+lng).toFixed(6)}`;
  el.dataset.lat = lat;
  el.dataset.lng = lng;
}

function getCoord() {
  const el = document.getElementById('gfCoord');
  if (!el.dataset.lat || !el.dataset.lng) return { lat: null, lng: null };
  return { lat: parseFloat(el.dataset.lat), lng: parseFloat(el.dataset.lng) };
}

function onRadiusChange() {
  const r = parseInt(document.getElementById('gfRadius').value);
  document.getElementById('gfRadLabel').textContent = `(${r} m)`;
  const { lat, lng } = getCoord();
  if (pendingCircle && lat != null) pendingCircle.setRadius(r);
}

// ── Address autocomplete (OpenStreetMap Nominatim — free, no API key) ──────
// Used to drop a pin without first clicking on the map. User types an address
// or place name, picks a suggestion, and the lat/lng + city/pincode auto-fill.
function onAddrSearch() {
  clearTimeout(addrSearchTimer);
  const q = document.getElementById('gfAddrSearch').value.trim();
  const box = document.getElementById('gfAddrList');
  if (q.length < 2) { box.hidden = true; return; }
  // 350 ms feels responsive while reducing typed-letter burst calls
  addrSearchTimer = setTimeout(() => fetchAddressSuggestions(q), 350);
}

// Generate a fresh session token whenever the user starts typing — Google
// bills autocomplete + the final details call as ONE session if they share
// a token, which is the cheap path. We reset the token after pickAddress
// so the next typing burst becomes a new session.
let placesSessionToken = null;
function newSessionToken() {
  // RFC4122-ish UUID v4 (good enough for session tokens — they're opaque to Google)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function fetchAddressSuggestions(q) {
  const box = document.getElementById('gfAddrList');
  box.innerHTML = '<div class="gf-suggest-empty">Searching Google Places…</div>';
  box.hidden = false;
  if (!placesSessionToken) placesSessionToken = newSessionToken();
  try {
    const r = await apiRequest(`/hr/geofence/places-suggest?q=${encodeURIComponent(q)}&sessionToken=${encodeURIComponent(placesSessionToken)}`);
    if (r.ok === false && r.message && r.message.indexOf('not configured') !== -1) {
      box.innerHTML = '<div class="gf-suggest-empty">Address search disabled — server is missing GOOGLE_PLACES_API_KEY. Ask IT.</div>';
      box.hidden = false;
      return;
    }
    renderAddrSuggest(r.predictions || []);
  } catch (e) {
    box.innerHTML = `<div class="gf-suggest-empty">Address search failed: ${escape(e.message || e)}</div>`;
    box.hidden = false;
  }
}

function renderAddrSuggest(list) {
  const box = document.getElementById('gfAddrList');
  if (!list.length) {
    box.innerHTML = '<div class="gf-suggest-empty">No matches — try a different spelling or include city</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = list.map(p => {
    const main = (p.structured_formatting && p.structured_formatting.main_text) || p.description;
    const sec  = (p.structured_formatting && p.structured_formatting.secondary_text) || '';
    return `
      <div class="gf-suggest-row" onclick="pickPrediction('${escape(p.place_id)}')">
        <div class="gf-suggest-name">${escape(main)}</div>
        <div class="gf-suggest-meta">${escape(sec)}</div>
      </div>`;
  }).join('');
  box.hidden = false;
}

// Two-step pick flow: user clicks a prediction → we call places-detail to get
// lat/lng + address breakdown → fill the form.
window.pickPrediction = async (placeId) => {
  const box = document.getElementById('gfAddrList');
  box.innerHTML = '<div class="gf-suggest-empty">Loading place details…</div>';
  try {
    const r = await apiRequest(`/hr/geofence/places-detail?placeId=${encodeURIComponent(placeId)}&sessionToken=${encodeURIComponent(placesSessionToken || '')}`);
    if (!r.ok || r.lat == null) throw new Error(r.message || 'No coordinates returned');
    setCoord(r.lat, r.lng);
    placePending(r.lat, r.lng);
    if (!document.getElementById('gfName').value && r.name)       document.getElementById('gfName').value    = r.name;
    if (!document.getElementById('gfAddress').value && r.address) document.getElementById('gfAddress').value = r.address;
    if (!document.getElementById('gfCity').value && r.city)       document.getElementById('gfCity').value    = r.city;
    if (!document.getElementById('gfPincode').value && r.pincode) document.getElementById('gfPincode').value = r.pincode;
    document.getElementById('gfAddrList').hidden = true;
    if (map) map.flyTo([r.lat, r.lng], 17, { duration: 0.6 });
    onRadiusChange();
  } catch (e) {
    box.innerHTML = `<div class="gf-suggest-empty">Could not load details: ${escape(e.message || e)}</div>`;
    box.hidden = false;
  }
  // Session ends after the details call — next typing burst gets a fresh token
  placesSessionToken = null;
};

// ── NAV customer autocomplete ──────────────────────────────────────────────
function onCustSearch() {
  clearTimeout(custSearchTimer);
  const q = document.getElementById('gfCustSearch').value.trim();
  if (q.length < 2) {
    document.getElementById('gfCustList').hidden = true;
    return;
  }
  custSearchTimer = setTimeout(async () => {
    // Don't append &company= here — apiRequest auto-attaches the session company.
    // Manually adding it caused Express to receive duplicate keys
    // (array → "COMPANYA,COMPANYA") → "Unknown company" error. 2026-05-25 fix.
    let r;
    try {
      r = await apiRequest(`/hr/geofence/customer-suggest?q=${encodeURIComponent(q)}`);
    } catch (e) { diag('NAV customer-suggest', e.message || e); return; }
    renderSuggest(r.customers || []);
  }, 250);
}

function renderSuggest(list) {
  const box = document.getElementById('gfCustList');
  if (list.length === 0) {
    box.innerHTML = '<div class="gf-suggest-empty">No NAV customer matches</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = list.map(c => `
    <div class="gf-suggest-row" onclick='pickCustomer(${JSON.stringify(c).replace(/'/g, "&#39;")})'>
      <div class="gf-suggest-name">${escape(c.CustomerName)}</div>
      <div class="gf-suggest-meta">${escape(c.CustomerCode)} · ${escape(c.City || '—')}${c.Pincode ? ' · ' + escape(c.Pincode) : ''}</div>
    </div>`).join('');
  box.hidden = false;
}

window.pickCustomer = (c) => {
  document.getElementById('gfCustCode').value = c.CustomerCode || '';
  document.getElementById('gfCity').value     = c.City || '';
  document.getElementById('gfAddress').value  = c.Address || '';
  document.getElementById('gfPincode').value  = c.Pincode || '';
  document.getElementById('gfCustSearch').value = c.CustomerName || '';
  document.getElementById('gfCustList').hidden = true;
  // If name field is empty, auto-fill from NAV
  const nameEl = document.getElementById('gfName');
  if (!nameEl.value.trim()) nameEl.value = c.CustomerName || '';
};

// ── Save / Delete ──────────────────────────────────────────────────────────
async function saveFence() {
  const err = document.getElementById('gfError');
  err.style.display = 'none';
  const name = document.getElementById('gfName').value.trim();
  const { lat, lng } = getCoord();
  if (!name)       { err.style.display = 'block'; err.textContent = 'Name is required'; return; }
  if (lat == null) { err.style.display = 'block'; err.textContent = 'Center coordinates missing — click on the map first'; return; }

  const payload = {
    name,
    kind:             document.getElementById('gfKind').value,
    company:          document.getElementById('gfCompany').value || null,
    customerCode:     document.getElementById('gfCustCode').value || null,
    centerLat:        lat,
    centerLng:        lng,
    radiusM:          parseInt(document.getElementById('gfRadius').value) || 100,
    dwellMinForVisit: parseInt(document.getElementById('gfDwell').value)  || 10,
    address:          document.getElementById('gfAddress').value || null,
    city:             document.getElementById('gfCity').value    || null,
    pincode:          document.getElementById('gfPincode').value || null,
  };

  try {
    if (editingId) {
      await apiRequest('/hr/geofence/' + editingId, { method: 'PUT', body: payload });
    } else {
      await apiRequest('/hr/geofence', { method: 'POST', body: payload });
    }
    closeGfModal();
    loadList();
  } catch (e) {
    err.style.display = 'block';
    err.textContent = e.message || 'Save failed';
  }
}

async function deleteFence() {
  if (!editingId) return;
  if (!confirm('Soft-delete this geofence? It will be hidden from the list but the row stays in DB.')) return;
  try {
    await apiRequest('/hr/geofence/' + editingId, { method: 'DELETE' });
    closeGfModal();
    loadList();
  } catch (e) {
    const err = document.getElementById('gfError');
    err.style.display = 'block';
    err.textContent = e.message || 'Delete failed';
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
