// ============================================================================
// ONE App Lens — Unknown Stops admin
// ============================================================================

const user = requireAuth();

window.closePromote   = closePromote;
window.savePromote    = savePromote;
window.openPromote    = openPromote;
window.setLabel       = setLabel;

let stops = [];
let promoteVisitId = null;
let custTimer = null;

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
  if (typeof renderSidebar === 'function') renderSidebar('stops');
  const today = new Date();
  const from  = new Date(); from.setDate(today.getDate() - 7);
  document.getElementById('dateFrom').value = from.toISOString().slice(0, 10);
  document.getElementById('dateTo').value   = today.toISOString().slice(0, 10);
  document.getElementById('dateFrom').addEventListener('change', load);
  document.getElementById('dateTo').addEventListener('change',   load);
  document.getElementById('pmCustSearch').addEventListener('input', onCustSearch);
  load();
}

async function load() {
  const from = document.getElementById('dateFrom').value;
  const to   = document.getElementById('dateTo').value;
  const ul = document.getElementById('stopsList');
  ul.innerHTML = '<div class="holiday-skel" style="height:110px;margin-bottom:10px;"></div><div class="holiday-skel" style="height:110px;"></div>';
  let r;
  try {
    r = await apiRequest(`/hr/visits/unknown/list?from=${from}&to=${to}`);
  } catch (e) { diag('GET /unknown/list', e.message || e); return; }
  stops = r.stops || [];
  if (stops.length === 0) {
    ul.innerHTML = `
      <div class="stops-empty">
        <div class="ic">✨</div>
        <div class="t">No unknown stops in this range</div>
        <div class="s">Either every stop matched a known geofence, or your team didn't sit still for 15+ minutes off-fence.</div>
      </div>`;
    return;
  }
  ul.innerHTML = stops.map(renderStop).join('');
}

function renderStop(s) {
  const t = new Date(s.EntryTime);
  const day = t.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dur  = s.DurationMin != null ? s.DurationMin + ' min' : 'still open';
  const mapUrl = `https://www.google.com/maps?q=${s.Lat},${s.Lng}`;
  return `
    <article class="stop-card">
      <div class="stop-time-block">
        <div class="stop-time">${time}</div>
        <div class="stop-duration"><b>${dur}</b></div>
      </div>
      <div class="stop-detail">
        <div class="who">${escape(s.UserName || '—')} <span class="lens-sub">(${escape(s.CompanyACode || s.UserId)})</span></div>
        <div class="when">${day} · ${escape(s.Department || 'SALES')}</div>
        <div class="coord">${(+s.Lat).toFixed(6)}, ${(+s.Lng).toFixed(6)} <a href="${mapUrl}" target="_blank">📍 Open in Google Maps</a></div>
      </div>
      <div class="stop-actions">
        <button class="stop-btn primary" onclick='openPromote(${s.VisitId})'>+ Add as Geofence</button>
        <button class="stop-btn label-personal" onclick="setLabel(${s.VisitId}, 'personal')">Personal</button>
        <button class="stop-btn label-lunch"    onclick="setLabel(${s.VisitId}, 'lunch')">Lunch</button>
        <button class="stop-btn label-skip"     onclick="setLabel(${s.VisitId}, 'skip')">Skip</button>
      </div>
    </article>`;
}

async function setLabel(visitId, label) {
  try {
    await apiRequest(`/hr/visits/${visitId}/label`, { method: 'PUT', body: { label } });
    load();
  } catch (e) { diag('PUT /visits/' + visitId + '/label', e.message || e); }
}

function openPromote(visitId) {
  const s = stops.find(x => x.VisitId === visitId);
  if (!s) return;
  promoteVisitId = visitId;
  document.getElementById('pmName').value       = '';
  document.getElementById('pmKind').value       = 'customer';
  document.getElementById('pmCompany').value    = s.Company || '';
  document.getElementById('pmCustSearch').value = '';
  document.getElementById('pmCustCode').value   = '';
  document.getElementById('pmCity').value       = '';
  document.getElementById('pmAddress').value    = '';
  document.getElementById('pmRadius').value     = 100;
  document.getElementById('pmCoord').textContent = `${(+s.Lat).toFixed(6)}, ${(+s.Lng).toFixed(6)}`;
  document.getElementById('pmCoord').dataset.lat = s.Lat;
  document.getElementById('pmCoord').dataset.lng = s.Lng;
  document.getElementById('pmError').style.display = 'none';
  document.getElementById('pmCustList').hidden = true;
  document.getElementById('promoteModal').hidden = false;
}

function closePromote() {
  document.getElementById('promoteModal').hidden = true;
  promoteVisitId = null;
}

function onCustSearch() {
  clearTimeout(custTimer);
  const q = document.getElementById('pmCustSearch').value.trim();
  if (q.length < 2) { document.getElementById('pmCustList').hidden = true; return; }
  custTimer = setTimeout(async () => {
    const company = document.getElementById('pmCompany').value || 'COMPANYA';
    try {
      const r = await apiRequest(`/hr/geofence/customer-suggest?q=${encodeURIComponent(q)}&company=${company}`);
      renderSuggest(r.customers || []);
    } catch (e) { diag('customer-suggest', e.message || e); }
  }, 250);
}

function renderSuggest(list) {
  const box = document.getElementById('pmCustList');
  if (list.length === 0) {
    box.innerHTML = '<div class="gf-suggest-empty">No NAV customer matches</div>';
    box.hidden = false; return;
  }
  box.innerHTML = list.map(c => `
    <div class="gf-suggest-row" onclick='pickCust(${JSON.stringify(c).replace(/'/g, "&#39;")})'>
      <div class="gf-suggest-name">${escape(c.CustomerName)}</div>
      <div class="gf-suggest-meta">${escape(c.CustomerCode)} · ${escape(c.City || '—')}</div>
    </div>`).join('');
  box.hidden = false;
}
window.pickCust = (c) => {
  document.getElementById('pmCustCode').value   = c.CustomerCode || '';
  document.getElementById('pmCity').value       = c.City || '';
  document.getElementById('pmAddress').value    = c.Address || '';
  document.getElementById('pmCustSearch').value = c.CustomerName || '';
  if (!document.getElementById('pmName').value.trim()) document.getElementById('pmName').value = c.CustomerName || '';
  document.getElementById('pmCustList').hidden = true;
};

async function savePromote() {
  const err = document.getElementById('pmError');
  err.style.display = 'none';
  const name = document.getElementById('pmName').value.trim();
  if (!name) { err.style.display = 'block'; err.textContent = 'Name is required'; return; }
  if (!promoteVisitId) return;
  try {
    await apiRequest(`/hr/visits/${promoteVisitId}/promote`, {
      method: 'POST',
      body: {
        name,
        kind:             document.getElementById('pmKind').value,
        company:          document.getElementById('pmCompany').value || null,
        customerCode:     document.getElementById('pmCustCode').value || null,
        city:             document.getElementById('pmCity').value || null,
        address:          document.getElementById('pmAddress').value || null,
        radiusM:          parseInt(document.getElementById('pmRadius').value) || 100,
        dwellMinForVisit: 10,
      },
    });
    closePromote();
    load();
  } catch (e) {
    err.style.display = 'block'; err.textContent = e.message || 'Promote failed';
  }
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
