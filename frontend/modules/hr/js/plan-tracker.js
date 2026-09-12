// ============================================================================
// ONE App Lens — Visit Tracker (Plan vs Reality)
// Joins BN_VisitPlan (planned) with HRM_Visit (actual) for a chosen day.
// ============================================================================

const user = requireAuth();

let map, polyline, markers = [], geofenceCircles = [];
let pageData = null;

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
  if (typeof renderSidebar === 'function') renderSidebar('plan-tracker');

  const today = new Date();
  document.getElementById('dateFilter').value = today.toISOString().slice(0, 10);
  document.getElementById('dateFilter').addEventListener('change', load);
  document.getElementById('userPicker').addEventListener('change', load);

  initMap();
  loadUserList();
  load();
}

function initMap() {
  map = L.map('ptMap', { zoomControl: true }).setView([18.5204, 73.8567], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
}

async function loadUserList() {
  try {
    const r = await apiRequest('/hr/journey/pickable-users');
    const wrap = document.getElementById('empPickerWrap');
    const picker = document.getElementById('userPicker');
    if (!r || !r.users) return;
    if (r.users.length <= 1) {
      if (wrap) wrap.style.display = 'none';
      return;
    }
    if (wrap) wrap.style.display = '';
    const role = (user.role || '').toLowerCase();
    const isAdminish = ['admin','operation head','director','hr','hr head'].includes(role);

    // Sort users: keep self first if salesperson; otherwise alphabetical.
    const others = r.users.filter(u => u.Id !== user.id);
    others.sort((a, b) => (a.Name || '').localeCompare(b.Name || ''));
    const self = r.users.find(u => u.Id === user.id);
    const ordered = self ? [self, ...others] : others;

    const opts = [];
    if (isAdminish) {
      opts.push('<option value="" selected>— Select employee —</option>');
      ordered.forEach(u => {
        opts.push(`<option value="${u.Id}">${escape(u.Name || u.Email)}</option>`);
      });
    } else {
      ordered.forEach(u => {
        opts.push(`<option value="${u.Id}" ${u.Id === user.id ? 'selected' : ''}>${escape(u.Name || u.Email)}</option>`);
      });
    }
    picker.innerHTML = opts.join('');
  } catch (e) { diag('pickable-users', e.message || e); }
}

async function load() {
  const date         = document.getElementById('dateFilter').value;
  const pickerValue  = document.getElementById('userPicker').value;
  const role         = (user.role || '').toLowerCase();
  const isAdminish   = ['admin','operation head','director','hr','hr head'].includes(role);

  // For admin/HR with no selection: show a clear "pick someone" prompt.
  if (!pickerValue && isAdminish) {
    showPickPrompt();
    return;
  }
  const userId = pickerValue || user.id;
  let r;
  try {
    r = await apiRequest(`/hr/plan-tracker/day?userId=${encodeURIComponent(userId)}&date=${encodeURIComponent(date)}`);
  } catch (e) { diag('GET /plan-tracker/day', e.message || e); return; }
  pageData = r;

  renderBanner(r);
  renderKpis(r.kpis);
  renderVisitList(r);
  renderMap(r);
}

function showPickPrompt() {
  document.getElementById('ptName').textContent = 'Select an employee →';
  document.getElementById('ptDate').textContent = 'Open the Employee dropdown in the top bar';
  document.getElementById('ptCompletionPct').textContent = '—';
  ['kpiPlanned','kpiDone','kpiMissed','kpiAdHoc'].forEach(id => document.getElementById(id).textContent = '0');
  document.getElementById('kpiTime').textContent = '0h';
  document.getElementById('ptVisitList').innerHTML = `
    <div class="pt-empty">
      <div class="ic">👤</div>
      <div class="t">Pick an employee to view their Visit Tracker</div>
      <div class="s">Use the <b>👤 Employee</b> dropdown at the top of the page.</div>
    </div>`;
  document.getElementById('ptListCount').textContent = '—';
  // Clear map
  if (polyline) { map.removeLayer(polyline); polyline = null; }
  markers.forEach(m => map.removeLayer(m)); markers = [];
}

function renderBanner(r) {
  document.getElementById('ptName').textContent = r.user ? (r.user.Name || r.user.Email) : '—';
  const d = new Date(r.date);
  document.getElementById('ptDate').textContent = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const k = r.kpis || {};
  const pct = k.plannedCount > 0 ? Math.round((k.completed / k.plannedCount) * 100) : (k.adHoc > 0 ? 100 : 0);
  document.getElementById('ptCompletionPct').textContent = pct + '%';
}

function renderKpis(k) {
  document.getElementById('kpiPlanned').textContent = k.plannedCount;
  document.getElementById('kpiDone').textContent    = k.completed;
  document.getElementById('kpiMissed').textContent  = k.missed;
  document.getElementById('kpiAdHoc').textContent   = k.adHoc;
  const hrs = (k.totalCustomerMin / 60).toFixed(1);
  document.getElementById('kpiTime').textContent    = hrs + 'h';
}

function renderVisitList(r) {
  const list = document.getElementById('ptVisitList');
  const planned = r.planned || [];
  if (planned.length === 0) {
    list.innerHTML = `
      <div class="pt-empty">
        <div class="ic">📋</div>
        <div class="t">No visits planned for this day</div>
        <div class="s">Set up the Visit Plan in <b>Sales → Visit Plan</b>, or visits will appear automatically as Ad-hoc when geofences trigger.</div>
      </div>`;
    document.getElementById('ptListCount').textContent = '0';
    return;
  }
  document.getElementById('ptListCount').textContent = `${planned.length} visit${planned.length === 1 ? '' : 's'}`;

  // Pre-build a lookup of actual visits keyed by VisitPlanId so each planned
  // card can pull its matching punch evidence (selfie + premise photos + GPS
  // map links + punch times) in O(1). v1.8 adds the punch columns to actual.
  const actualByPlanId = new Map();
  (r.actual || []).forEach(a => {
    if (a.VisitPlanId != null) actualByPlanId.set(Number(a.VisitPlanId), a);
  });

  list.innerHTML = planned.map((p, i) => {
    const status = visitStatus(p);
    const auto = p.AutoConfirmedAt ? new Date(p.AutoConfirmedAt) : null;
    const actualMatch = actualByPlanId.get(Number(p.Id));

    // Time pill — only show when meaningful, never on a green "Completed" card:
    //   - geofence auto-confirmed:      ✓ {time}
    //   - completed but no auto-confirm: ✓ Done   (manual mark / no geofence yet)
    //   - missed                       : Not yet visited
    //   - pending (future-dated)       : Pending
    let timeLine = '';
    if (auto) {
      timeLine = `<span class="pill">✓ ${fmtT(auto)}</span>`;
    } else if (status === 'done' || status === 'adhoc') {
      timeLine = `<span class="pill">✓ Done</span>`;
    } else if (status === 'missed') {
      timeLine = `<span class="pill">Not yet visited</span>`;
    } else if (status === 'pending') {
      timeLine = `<span class="pill">Pending</span>`;
    }
    // Manual override — only offered when the auto-detector has NOT confirmed
    // the visit. Covers brief on-site stops (< 5 min), tracking gaps, off-site
    // meetings, and customers with no geofence yet. Server logs who marked it
    // (ManualConfirmedByUserId) and when, so audit can flag reps who lean on
    // manual marks too heavily.
    // Mark Done is a WRITE to the visit plan. The backend blocks the view-only
    // monitor roles (HR / HR-head / MIS) with 403 (visitPlan.js blockHR), and
    // apiRequest turns ANY 403 into a logout+redirect. So only offer it to roles
    // that can actually mark done — else an HR/MIS user reviewing a rep's tracker
    // clicks "Mark Done" and gets silently booted to the login screen.
    const _viewerRole = ((typeof currentUser !== 'undefined' && currentUser && currentUser.role) ||
                         (typeof user !== 'undefined' && user && user.role) || '').toLowerCase().trim();
    const _canMarkDone = !(/\bhr\b/.test(_viewerRole) || /\bmis\b/.test(_viewerRole));
    const showMarkDone = (status === 'missed') && _canMarkDone;
    const actionRow = showMarkDone
      ? `<div class="pt-visit-actions">
           <button class="pt-mark-done-btn" onclick="markVisitDone(${p.Id})" title="Mark this planned visit as done">✓ Mark Done</button>
         </div>`
      : '';

    // Punch-evidence block (v1.8) — only when there's a matching actual visit
    // with explicit PunchIn data. Shows selfie + premise photos as thumbnails
    // (click for lightbox) + clickable Google Maps links for the GPS coords.
    // Auto-detected visits (geofence dwell, no explicit punch) skip this block.
    let punchBlock = '';
    if (actualMatch && actualMatch.PunchInTime) {
      const inMapHtml = (actualMatch.PunchInLat != null && actualMatch.PunchInLng != null)
        ? `<a class="pt-punch-map" href="https://www.google.com/maps?q=${actualMatch.PunchInLat},${actualMatch.PunchInLng}" target="_blank" rel="noopener" title="${Number(actualMatch.PunchInLat).toFixed(6)}, ${Number(actualMatch.PunchInLng).toFixed(6)}">📍 In</a>`
        : '';
      const outMapHtml = (actualMatch.PunchOutLat != null && actualMatch.PunchOutLng != null)
        ? `<a class="pt-punch-map" href="https://www.google.com/maps?q=${actualMatch.PunchOutLat},${actualMatch.PunchOutLng}" target="_blank" rel="noopener" title="${Number(actualMatch.PunchOutLat).toFixed(6)}, ${Number(actualMatch.PunchOutLng).toFixed(6)}">📍 Out</a>`
        : '';
      const thumb = (url, label) => url
        ? `<img class="pt-punch-photo" src="${escape(url)}" alt="${label}" title="${label} — click to enlarge" onclick="ptLightbox('${escape(url)}', '${label}')">`
        : '';
      const durLbl = actualMatch.DurationMin != null
        ? `<span class="pill pt-punch-dur">⏱ ${actualMatch.DurationMin} min</span>`
        : (actualMatch.PunchOutTime
            ? ''
            : '<span class="pill pt-punch-open">⏳ Still on site</span>');
      // Admin/HR correction buttons — visible only to roles that can rewrite
      // the punch (admin, director, operation head, HR, HR head). Sales heads
      // are deliberately excluded — they can REVIEW but not REWRITE their team's
      // punches; that preserves audit integrity.
      const role = ((typeof currentUser !== 'undefined' && currentUser && currentUser.role) || (user && user.role) || '').toLowerCase().trim();
      const isAdminLike = ['admin','operation head','director','hr','hr head'].includes(role);
      const adminActions = isAdminLike
        ? `<div class="pt-punch-admin">
             <button class="pt-punch-edit"   onclick="ptEditPunch(${actualMatch.VisitId})"   title="Fix wrong customer / re-link to a different plan">✎ Edit</button>
             <button class="pt-punch-delete" onclick="ptDeletePunch(${actualMatch.VisitId})" title="Delete this punch (rep can re-punch correctly)">✕ Delete</button>
           </div>`
        : '';
      punchBlock = `
        <div class="pt-punch-block" data-visit-id="${actualMatch.VisitId}">
          <div class="pt-punch-times">
            <span class="pill pt-punch-in">▶ In ${fmtT(actualMatch.PunchInTime)}</span>
            ${actualMatch.PunchOutTime ? `<span class="pill pt-punch-out">⏹ Out ${fmtT(actualMatch.PunchOutTime)}</span>` : ''}
            ${durLbl}
            ${inMapHtml}
            ${outMapHtml}
          </div>
          <div class="pt-punch-photos">
            ${thumb(actualMatch.PunchInSelfieUrl,         'Selfie')}
            ${thumb(actualMatch.PunchInPremisePhotoUrl,   'Premise — In')}
            ${thumb(actualMatch.PunchOutPremisePhotoUrl,  'Premise — Out')}
          </div>
          ${adminActions}
        </div>
      `;
    }

    // Meeting-with line — shows planned ContactPerson + ContactDetails so the
    // head can verify who the rep was supposed to meet. Phone (if any) is
    // wrapped in a tel: link so the reviewer can quick-call to confirm.
    let contactLine = '';
    if (p.ContactPerson || p.ContactDetails) {
      const name = p.ContactPerson ? escape(p.ContactPerson) : '—';
      const phone = p.ContactDetails ? escape(p.ContactDetails) : '';
      const phoneDigits = phone ? phone.replace(/[^0-9+]/g, '') : '';
      contactLine = `
        <div class="pt-visit-contact" title="Planned meeting contact from Visit Plan">
          👤 Meeting: <strong>${name}</strong>
          ${phone ? ` · <a class="pt-contact-phone" href="tel:${phoneDigits}">📞 ${phone}</a>` : ''}
        </div>`;
    }

    return `
      <article class="pt-visit-card ${status}${actualMatch && actualMatch.PunchInTime ? ' has-punch' : ''}">
        <div class="pt-visit-head">
          <div class="pt-visit-num">${i + 1}</div>
          <div class="pt-visit-name">${escape(p.CustomerName || '—')}</div>
          <div class="pt-visit-status">${statusLabel(status)}</div>
        </div>
        <div class="pt-visit-meta">
          ${p.CustomerCode ? `<span class="pill">${escape(p.CustomerCode)}</span>` : ''}
          ${timeLine}
          ${p.Company ? `<span class="pill">${escape(p.Company)}</span>` : ''}
          ${p.ManualConfirmedAt ? `<span class="pill pill-manual" title="Marked done manually">✓ manual</span>` : ''}
          ${actualMatch && actualMatch.PunchInTime ? '<span class="pill pill-punch" title="Closed via Punch-In/Out with photos">📸 punched</span>' : ''}
        </div>
        ${p.VisitAgenda ? `<div class="pt-visit-agenda">${escape(p.VisitAgenda)}</div>` : ''}
        ${contactLine}
        ${punchBlock}
        ${actionRow}
      </article>`;
  }).join('');
}

// ─── Admin/HR punch corrections (v1.8) ──────────────────────────────────────
// Two ops:
//   ✎ Edit   — fix wrong customer link without losing photos / GPS / timestamps
//   ✕ Delete — drop a wholly-wrong punch (linked plan goes back to "Missed")
// Both endpoints are gated server-side to isLensAdmin (admin/director/op-head/HR).

window.ptEditPunch = async function (visitId) {
  if (!pageData || !pageData.actual) return;
  const actual = pageData.actual.find(a => Number(a.VisitId) === Number(visitId));
  if (!actual) { alert('Visit not found in current view.'); return; }
  const newName = window.prompt(
    'Edit customer name for this punch:\n\n(GPS coords, photos, and times stay unchanged. Only the customer link is updated. The linked plan, if any, will be reset.)',
    actual.CustomerName || ''
  );
  if (newName === null) return;            // user cancelled
  const trimmed = String(newName).trim();
  if (!trimmed) { alert('Customer name cannot be empty.'); return; }
  const newCode = window.prompt(
    'Customer code (leave blank if a prospect / unknown):',
    actual.CustomerCode || ''
  );
  if (newCode === null) return;
  try {
    const r = await apiRequest('/hr/visit-punch/' + visitId, {
      method: 'PUT',
      body: {
        customerName: trimmed,
        customerCode: String(newCode || '').trim() || null,
        // visitPlanId left null — clearing the old link is the safe default. If
        // the user wants to re-link to a different plan, they edit the plan
        // directly via Visit Plan and re-punch.
        visitPlanId:  null,
      },
    });
    if (r && r.ok) { alert('Punch updated.'); load(); }
    else           { alert((r && r.message) || 'Update failed.'); }
  } catch (e) { alert('Update failed: ' + (e.message || e)); }
};

window.ptDeletePunch = async function (visitId) {
  if (!confirm(
    'Delete this punch?\n\n' +
    '• The selfie + premise photos will be removed.\n' +
    '• The linked Visit Plan (if any) will go back to "Missed".\n' +
    '• The punch-in / punch-out GPS pings will be removed from the day map.\n' +
    '• Other location pings (the regular GPS trail) stay intact.\n\n' +
    'This cannot be undone.'
  )) return;
  try {
    const r = await apiRequest('/hr/visit-punch/' + visitId, { method: 'DELETE' });
    if (r && r.ok) { alert('Punch deleted.'); load(); }
    else           { alert((r && r.message) || 'Delete failed.'); }
  } catch (e) { alert('Delete failed: ' + (e.message || e)); }
};

// Photo lightbox — used by both planned-card punch thumbnails and any future
// image preview. Click anywhere on the overlay (or press Escape) to close.
window.ptLightbox = function (url, caption) {
  let lb = document.getElementById('ptLightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'ptLightbox';
    lb.className = 'pt-lightbox';
    lb.addEventListener('click', () => { lb.hidden = true; });
    lb.innerHTML = `
      <div class="pt-lightbox-inner">
        <img id="ptLightboxImg" alt="" />
        <div class="pt-lightbox-caption" id="ptLightboxCap"></div>
      </div>
    `;
    document.body.appendChild(lb);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !lb.hidden) lb.hidden = true;
    });
  }
  document.getElementById('ptLightboxImg').src = url;
  document.getElementById('ptLightboxCap').textContent = caption || '';
  lb.hidden = false;
};

// Manual visit confirmation — POSTs to /sales/visitplan/:id/mark-done.
// One-tap: confirm → flip → reload. MOM can be edited later from Visit Plan.
window.markVisitDone = async function (id) {
  const plan = (pageData && pageData.planned || []).find(p => p.Id === id);
  if (!plan) return;
  const customer = plan.CustomerName || 'this customer';
  if (!confirm(`Mark visit to "${customer}" as done?\n\nUse this only when the auto-detector missed a genuine visit (brief stop, tracking gap, off-site meeting). The mark is logged with your name + timestamp.`)) return;
  try {
    const r = await apiRequest(`/sales/visitplan/${id}/mark-done`, { method: 'POST', body: {} });
    if (r && r.ok) {
      load();
    } else {
      alert((r && r.message) || 'Failed to mark visit done.');
    }
  } catch (e) {
    alert('Failed to mark visit done: ' + (e.message || e));
  }
};

function visitStatus(p) {
  const done = (p.VisitDone === true || p.VisitDone === 1);
  const adhoc = (p.IsAdHoc === true || p.IsAdHoc === 1);
  if (done && adhoc) return 'adhoc';
  if (done) return 'done';
  return 'missed';
}
function statusLabel(s) {
  return { done: 'Completed', missed: 'Missed', adhoc: 'Ad-hoc', pending: 'Pending' }[s] || s;
}

function renderMap(r) {
  // Clear
  if (polyline) { map.removeLayer(polyline); polyline = null; }
  markers.forEach(m => map.removeLayer(m)); markers = [];
  geofenceCircles.forEach(c => map.removeLayer(c)); geofenceCircles = [];

  const bounds = [];

  // Draw the GPS track — prefer the backend road-snapped path (clean, follows
  // streets). Fall back to raw pings if snapping was unavailable.
  const pings = (r.pings || []);
  const track = (Array.isArray(r.snappedPath) && r.snappedPath.length >= 2)
    ? r.snappedPath
    : pings.map(p => [p.Lat, p.Lng]);
  if (track.length >= 2) {
    polyline = L.polyline(track, { color: '#2563eb', weight: 3, opacity: 0.75, lineJoin: 'round' }).addTo(map);
    track.forEach(pt => bounds.push(pt));
  }

  // Plot planned visits with status colors
  (r.planned || []).forEach((p, i) => {
    if (p.EntryPingId) {
      // we know where it actually happened — use the actual ping's lat/lng
      const matchedActual = (r.actual || []).find(a => a.VisitPlanId === p.Id);
      if (matchedActual && matchedActual.Lat != null) {
        const status = visitStatus(p);
        const m = L.marker([matchedActual.Lat, matchedActual.Lng], { icon: makeIcon(status, String(i + 1)) })
          .bindPopup(planPopup(p, matchedActual));
        m.addTo(map);
        markers.push(m);
        bounds.push([matchedActual.Lat, matchedActual.Lng]);
      }
    }
  });

  // Ad-hoc actual visits not linked to a plan row
  (r.actual || []).forEach((a, i) => {
    const linked = (r.planned || []).find(p => p.Id === a.VisitPlanId);
    if (linked || a.Lat == null) return;
    const m = L.marker([a.Lat, a.Lng], { icon: makeIcon('adhoc', '+') })
      .bindPopup(`<b>${escape(a.CustomerName || 'Ad-hoc visit')}</b><br>${fmtT(a.EntryTime)} → ${fmtT(a.ExitTime) || '…'}<br>${durLabel(a)}`);
    m.addTo(map);
    markers.push(m);
    bounds.push([a.Lat, a.Lng]);
  });

  if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds).pad(0.18));
}

function makeIcon(status, label) {
  return L.divIcon({
    className: '',
    html: `<div class="pt-marker ${status}">${escape(label)}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function planPopup(p, a) {
  return `<div style="min-width:200px;">
    <div style="font-weight:600;margin-bottom:4px;">${escape(p.CustomerName)}</div>
    ${p.CustomerCode ? `<div style="font-size:11px;color:#64748b;font-family:monospace;">${escape(p.CustomerCode)}</div>` : ''}
    <div style="font-size:12px;margin-top:6px;">
      Entered: <b>${fmtT(a.EntryTime)}</b><br>
      Exited: <b>${fmtT(a.ExitTime) || (a.EffectiveDurationMin != null ? 'still here' : '—')}</b><br>
      Duration: <b>${durLabel(a)}</b>
    </div>
    ${p.VisitAgenda ? `<div style="font-size:12px;color:#475569;margin-top:6px;font-style:italic;">"${escape(p.VisitAgenda)}"</div>` : ''}
    <a href="https://www.google.com/maps?q=${a.Lat},${a.Lng}" target="_blank" style="display:inline-block;margin-top:8px;font-size:11px;">📍 Open in Google Maps</a>
  </div>`;
}

function fmtT(t)  { return t ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : ''; }
// Prefer backend EffectiveDurationMin (handles open/never-closed visits); fall
// back to raw DurationMin; append "(ongoing)" when the visit hasn't closed yet.
function durLabel(a) {
  const mins = (a.EffectiveDurationMin != null) ? a.EffectiveDurationMin : a.DurationMin;
  if (mins == null) return '— min';
  const ongoing = !a.ExitTime && a.DurationMin == null;
  return `${mins} min${ongoing ? ' (ongoing)' : ''}`;
}
function escape(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
