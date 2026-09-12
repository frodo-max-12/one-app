// ============================================================================
// ONE App Lens — My Attendance log page
// ============================================================================

const user = requireAuth();

window.closeLightbox = closeLightbox;
window.showLightbox  = showLightbox;

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

function init() {
  if (typeof renderSidebar === 'function') renderSidebar('attendance');
  document.getElementById('daysFilter').addEventListener('change', load);
  load();
}

function diag(label, msg) {
  const box = document.getElementById('lensDiag');
  const list = document.getElementById('diagList');
  if (!box || !list) return;
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('en-IN', { hour12: false })}] ${label}: ${msg}`;
  list.appendChild(li);
  box.style.display = 'block';
}

async function load() {
  const days = document.getElementById('daysFilter').value;
  const list = document.getElementById('attList');
  list.innerHTML = '<div class="holiday-skel" style="height:140px;margin-bottom:10px;"></div><div class="holiday-skel" style="height:140px;"></div>';

  let r;
  try {
    r = await apiRequest(`/hr/attendance/log?days=${days}`);
  } catch (e) {
    diag('GET /attendance/log', e.message || e);
    list.innerHTML = `<div class="att-empty"><div class="ic">⚠</div><div class="t">Couldn't load attendance</div><div class="s">${escape(e.message || '')}</div></div>`;
    return;
  }
  const rows = (r && r.rows) || [];
  if (rows.length === 0) {
    list.innerHTML = `<div class="att-empty"><div class="ic">📍</div><div class="t">No attendance records</div><div class="s">Sign in from the Home page to start tracking.</div></div>`;
    renderSummary([]);
    return;
  }

  renderSummary(rows);

  // Group by AttDate
  const byDate = new Map();
  rows.forEach(row => {
    const key = row.AttDate.slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(row);
  });

  const html = [];
  for (const [date, sessions] of byDate) {
    sessions.sort((a, b) => a.Session - b.Session);
    const d = new Date(date);
    const totalMin = sessions.reduce((s, x) => s + (x.TotalWorkMin || 0), 0);
    const hrs = (totalMin / 60).toFixed(1);
    html.push(`
      <article class="att-day-card">
        <div class="att-day-head">
          <div>
            <div class="att-day-name">${d.toLocaleDateString('en-IN', { weekday: 'long' })}</div>
            <div class="att-day-date">${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
          </div>
          <div class="att-day-summary">
            <span class="badge">${sessions.length} session${sessions.length > 1 ? 's' : ''}</span>
            <span>${hrs} hrs</span>
          </div>
        </div>
        ${sessions.map(renderSession).join('')}
      </article>`);
  }
  list.innerHTML = html.join('');
}

function renderSession(s) {
  return `
    <div class="att-session">
      <div class="sess-badge">${s.Session}</div>
      ${renderEvent('Sign In',  s.SignInTime,  s.SignInLat,  s.SignInLng,  s.SignInRemarks,  s.SignInSelfieUrl,  'signin')}
      ${renderEvent('Sign Out', s.SignOutTime, s.SignOutLat, s.SignOutLng, s.SignOutRemarks, s.SignOutSelfieUrl, 'signout')}
    </div>`;
}

function renderEvent(kind, time, lat, lng, remarks, selfieUrl, cls) {
  if (!time) {
    return `
      <div class="event-box pending">
        <div class="event-selfie empty">⏳</div>
        <div class="event-detail">
          <div class="event-kind">${kind}</div>
          <div class="event-time">— still open —</div>
        </div>
      </div>`;
  }
  const t = new Date(time);
  const timeFmt = t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const coord = (lat != null && lng != null) ? `${(+lat).toFixed(6)}, ${(+lng).toFixed(6)}` : '—';
  const mapUrl = (lat != null && lng != null) ? `https://www.google.com/maps?q=${lat},${lng}` : null;
  const selfieHtml = selfieUrl
    ? `<div class="event-selfie" onclick="showLightbox('${escape(selfieUrl)}')"><img src="${escape(selfieUrl)}" alt="selfie"/></div>`
    : `<div class="event-selfie empty">${cls === 'signin' ? '🌅' : '🌙'}</div>`;
  return `
    <div class="event-box ${cls}">
      ${selfieHtml}
      <div class="event-detail">
        <div class="event-kind">${kind}</div>
        <div class="event-time">${timeFmt}</div>
        <div class="event-coord">${coord}</div>
        ${remarks ? `<div class="event-remarks">"${escape(remarks)}"</div>` : ''}
        ${mapUrl ? `<a class="event-map-link" href="${mapUrl}" target="_blank" rel="noopener">📍 View on map</a>` : ''}
      </div>
    </div>`;
}

function renderSummary(rows) {
  const sessions = rows.length;
  const totalMin = rows.reduce((s, x) => s + (x.TotalWorkMin || 0), 0);
  const dates = new Set(rows.map(r => r.AttDate.slice(0, 10)));
  const days = dates.size || 1;
  document.getElementById('sumSessions').textContent = sessions;
  document.getElementById('sumHours').textContent    = (totalMin / 60).toFixed(1) + ' hrs';
  document.getElementById('sumAvg').textContent      = (totalMin / 60 / days).toFixed(1) + ' hrs';
}

function escape(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function showLightbox(url) {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('selfieLightbox').hidden = false;
}
function closeLightbox() {
  document.getElementById('selfieLightbox').hidden = true;
}
