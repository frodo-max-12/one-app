// ============================================================================
// ONE App Lens — Anomalies review queue (Phase 2.6)
// ============================================================================

const user = requireAuth();

window.openResolveModal  = openResolveModal;
window.closeResolveModal = closeResolveModal;
window.confirmResolve    = confirmResolve;
window.approveAnomaly    = approveAnomaly;

let anomalies = [];
let resolvingId = null;

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
  if (typeof renderSidebar === 'function') renderSidebar('anomalies');

  const today = new Date();
  const from  = new Date(); from.setDate(today.getDate() - 7);
  document.getElementById('dateFrom').value = from.toISOString().slice(0, 10);
  document.getElementById('dateTo').value   = today.toISOString().slice(0, 10);

  ['dateFrom', 'dateTo', 'kindFilter', 'onlyOpen'].forEach(id =>
    document.getElementById(id).addEventListener('change', load)
  );
  load();
}

async function load() {
  const from = document.getElementById('dateFrom').value;
  const to   = document.getElementById('dateTo').value;
  const kind = document.getElementById('kindFilter').value;
  const onlyOpen = document.getElementById('onlyOpen').checked;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to)   params.set('to',   to);
  if (kind) params.set('kind', kind);
  if (onlyOpen) params.set('onlyOpen', 'true');

  const list = document.getElementById('anomList');
  list.innerHTML = '<div class="holiday-skel" style="height:110px;margin-bottom:10px;"></div><div class="holiday-skel" style="height:110px;"></div>';
  let r;
  try { r = await apiRequest('/hr/anomalies?' + params.toString()); }
  catch (e) { diag('GET /anomalies', e.message || e); list.innerHTML = ''; return; }
  anomalies = r.anomalies || [];

  // Summary
  const total = anomalies.length;
  const open  = anomalies.filter(a => !a.IsResolved).length;
  const crit  = anomalies.filter(a => a.Severity === 'critical').length;
  document.getElementById('sumTotal').textContent = total;
  document.getElementById('sumOpen').textContent  = open;
  document.getElementById('sumCritical').textContent = crit;

  if (anomalies.length === 0) {
    list.innerHTML = `
      <div class="stops-empty">
        <div class="ic">✨</div>
        <div class="t">No anomalies in this range</div>
        <div class="s">All clear! Either nothing happened, or everything matched a known geofence + sign-in/out cleanly.</div>
      </div>`;
    return;
  }
  list.innerHTML = anomalies.map(renderAnomaly).join('');
}

function renderAnomaly(a) {
  const detectedAt = new Date(a.DetectedAt);
  const time = detectedAt.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
  const kindLabel = ({
    office_exit: 'Office Exit',
    stale_session: 'Stale Session',
    no_show: 'No Show',
    mock_gps: 'Mock GPS',
    prolonged_absence: 'Prolonged Absence',
  })[a.Kind] || a.Kind;
  const icon = ({
    office_exit: '🚪',
    stale_session: '⏰',
    no_show: '👻',
    mock_gps: '🎭',
    prolonged_absence: '🏃',
  })[a.Kind] || '⚠';
  const sev = a.Severity || 'warning';
  const mapLink = (a.LastSeenLat != null && a.LastSeenLng != null)
    ? ` <a href="https://www.google.com/maps?q=${a.LastSeenLat},${a.LastSeenLng}" target="_blank">📍 Map</a>`
    : '';
  const resolution = a.IsResolved && a.ResolutionNote
    ? `<div class="anom-resolution">✓ ${escape(a.ResolutionNote)} <span style="opacity:0.7">— ${escape(a.ResolvedByName || 'HR')}</span></div>`
    : (a.IsResolved ? `<div class="anom-resolution">✓ Resolved by ${escape(a.ResolvedByName || 'HR')}</div>` : '');
  return `
    <article class="anom-card severity-${sev} ${a.IsResolved ? 'resolved' : ''}">
      <div class="anom-icon">${icon}</div>
      <div class="anom-body">
        <div class="anom-head">
          <span class="anom-kind-pill">${kindLabel}</span>
          <span class="anom-time">${time}</span>
        </div>
        <div class="anom-title">${escape(a.Title)}</div>
        <div class="anom-who">${escape(a.UserName || 'Unknown')} <span style="opacity:0.7">(${escape(a.CompanyACode || a.UserId)})</span>${a.OfficeName ? ' · ' + escape(a.OfficeName) : ''}</div>
        ${a.Detail ? `<div class="anom-detail">${escape(a.Detail)}</div>` : ''}
        ${a.LastSeenLat != null ? `<div class="anom-coord">${(+a.LastSeenLat).toFixed(6)}, ${(+a.LastSeenLng).toFixed(6)}${mapLink}</div>` : ''}
        ${resolution}
      </div>
      <div class="anom-actions">
        <button class="anom-btn approve" onclick="approveAnomaly(${a.AnomalyId})">✓ Approve</button>
        <button class="anom-btn resolve" onclick="openResolveModal(${a.AnomalyId})">Resolve…</button>
      </div>
    </article>`;
}

function openResolveModal(id) {
  resolvingId = id;
  document.getElementById('resolveNote').value = '';
  document.getElementById('resolveError').style.display = 'none';
  document.getElementById('resolveModal').hidden = false;
}
function closeResolveModal() {
  document.getElementById('resolveModal').hidden = true;
  resolvingId = null;
}
async function confirmResolve() {
  if (!resolvingId) return;
  const note = document.getElementById('resolveNote').value.trim();
  try {
    await apiRequest('/hr/anomalies/' + resolvingId + '/resolve', { method: 'PUT', body: { note } });
    closeResolveModal();
    load();
  } catch (e) {
    const err = document.getElementById('resolveError');
    err.style.display = 'block'; err.textContent = e.message || 'Save failed';
  }
}
async function approveAnomaly(id) {
  if (!confirm('Mark this anomaly as approved (legitimate reason)?')) return;
  try {
    await apiRequest('/hr/anomalies/' + id + '/approve', { method: 'PUT' });
    load();
  } catch (e) { diag('PUT /anomalies/' + id + '/approve', e.message || e); }
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
