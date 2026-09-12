// ============================================================================
// ONE App Lens — Office Presence (Phase 2.6)
// ============================================================================

const user = requireAuth();

window.openAssignModal = openAssignModal;
window.closeAssignModal = closeAssignModal;
window.saveAssignments = saveAssignments;

let pageData = null;
let selectedOfficeId = null;       // null = "all offices"
let liveTimer = null;
let assignDraft = {};              // userId -> officeId (during edits)

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
  if (typeof renderSidebar === 'function') renderSidebar('office-presence');
  document.getElementById('opSearch').addEventListener('input', renderEmployees);
  load();
  liveTimer = setInterval(load, 60 * 1000);
}

async function load() {
  let r;
  try { r = await apiRequest('/hr/office-presence'); }
  catch (e) { diag('GET /office-presence', e.message || e); return; }
  pageData = r;
  renderOfficeTiles();
  renderEmployees();
  renderUnassigned();
}

function renderOfficeTiles() {
  const wrap = document.getElementById('opOfficeTiles');
  const offices = (pageData && pageData.offices) || [];
  if (offices.length === 0) {
    wrap.innerHTML = `
      <div class="pt-empty" style="grid-column:1/-1;">
        <div class="ic">🏛️</div>
        <div class="t">No office geofences set up yet</div>
        <div class="s">Go to <b>Geofences</b> → + Add Geofence → pick <b>🏛️ Office</b> as kind. Then come back here.</div>
      </div>`;
    return;
  }

  // "All" tile (totals across offices)
  const totalAssigned = offices.reduce((s, o) => s + o.totals.assigned, 0);
  const totalIn       = offices.reduce((s, o) => s + o.totals.inOffice, 0);
  const totalOut      = offices.reduce((s, o) => s + o.totals.outOffice, 0);
  const totalNotIn    = offices.reduce((s, o) => s + o.totals.notIn, 0);
  const totalSignedOut= offices.reduce((s, o) => s + o.totals.signedOut, 0);

  const tiles = [];
  tiles.push(officeTileHtml({
    GeofenceId: null, Name: 'All Offices', City: 'Live overview',
    totals: { assigned: totalAssigned, inOffice: totalIn, outOffice: totalOut, notIn: totalNotIn, signedOut: totalSignedOut },
  }, '🏢', selectedOfficeId === null));

  offices.forEach(o => {
    const emoji = (o.Name || '').toLowerCase().includes('pune') ? '🏛️'
                : (o.Name || '').toLowerCase().includes('bangalore') ? '🏙️'
                : (o.Name || '').toLowerCase().includes('noida') || (o.Name || '').toLowerCase().includes('delhi') ? '🌆'
                : '🏢';
    tiles.push(officeTileHtml(o, emoji, selectedOfficeId === o.GeofenceId));
  });
  wrap.innerHTML = tiles.join('');
  // Wire tile clicks
  wrap.querySelectorAll('.op-office-tile').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.officeId;
      selectedOfficeId = id === 'null' ? null : parseInt(id);
      renderOfficeTiles();   // re-render to update .selected highlight
      renderEmployees();
    });
  });
}

function officeTileHtml(o, emoji, isSelected) {
  const t = o.totals || {};
  return `
    <article class="op-office-tile ${isSelected ? 'selected' : ''}" data-office-id="${o.GeofenceId == null ? 'null' : o.GeofenceId}">
      <div class="op-tile-head">
        <span class="op-tile-emoji">${emoji}</span>
        <div>
          <div class="op-tile-name">${escape(o.Name)}</div>
          <div class="op-tile-city">${escape(o.City || '—')}</div>
        </div>
      </div>
      <div class="op-tile-stats">
        <div class="op-stat"><span class="op-stat-dot in"></span> In <b>${t.inOffice || 0}</b></div>
        <div class="op-stat"><span class="op-stat-dot out"></span> Out <b>${t.outOffice || 0}</b></div>
        <div class="op-stat"><span class="op-stat-dot notin"></span> Not in <b>${t.notIn || 0}</b></div>
        <div class="op-stat"><span class="op-stat-dot sout"></span> Done <b>${t.signedOut || 0}</b></div>
      </div>
      <div class="op-tile-total">Assigned: <b>${t.assigned || 0}</b></div>
    </article>`;
}

function renderUnassigned() {
  const b = document.getElementById('opUnassignedBanner');
  const n = (pageData && pageData.unassignedCount) || 0;
  if (n > 0) {
    document.getElementById('opUnassignedCount').textContent = n;
    b.style.display = 'flex';
  } else {
    b.style.display = 'none';
  }
}

function renderEmployees() {
  const list = document.getElementById('opEmpList');
  if (!pageData) return;
  const q = (document.getElementById('opSearch').value || '').trim().toLowerCase();
  let employees = pageData.employees || [];

  if (selectedOfficeId !== null) {
    employees = employees.filter(e => e.officeId === selectedOfficeId);
    const office = (pageData.offices || []).find(o => o.GeofenceId === selectedOfficeId);
    document.getElementById('opSelectedOffice').textContent = office ? office.Name : 'Unknown';
  } else {
    employees = employees.filter(e => e.officeId);  // skip unassigned in the "all" view
    document.getElementById('opSelectedOffice').textContent = 'All Offices';
  }

  if (q) employees = employees.filter(e =>
    (e.name || '').toLowerCase().includes(q) || (e.email || '').toLowerCase().includes(q)
  );

  if (employees.length === 0) {
    list.innerHTML = '<div class="op-emp-empty">No employees to show. Try a different office or filter.</div>';
    return;
  }
  // Sort: in_office first, out_of_office, not_in, signed_in_no_ping, signed_out
  const order = ['in_office', 'out_of_office', 'signed_in_no_ping', 'not_in', 'signed_out'];
  employees.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (a.name || '').localeCompare(b.name || ''));

  list.innerHTML = employees.map(e => {
    const ini = (e.name || 'US').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const statusLabel = ({
      in_office: 'In Office',
      out_of_office: 'Out of Office',
      not_in: 'Not Yet In',
      signed_out: 'Signed Out',
      signed_in_no_ping: 'Signed In · No GPS',
      unassigned: 'Unassigned',
    })[e.status] || e.status;
    const mapLink = (e.latestLat != null && e.latestLng != null)
      ? `<a class="op-emp-map" href="https://www.google.com/maps?q=${e.latestLat},${e.latestLng}" target="_blank">📍 Map</a>`
      : '<span class="op-emp-map" style="color:var(--lens-text-3)">—</span>';
    return `
      <div class="op-emp-row">
        <div class="op-emp-avatar">${escape(ini)}</div>
        <div class="op-emp-info">
          <div class="op-emp-name">${escape(e.name || e.email)}</div>
          <div class="op-emp-sub">${escape(e.companyaCode || e.role || '—')}${e.officeName ? ' · ' + escape(e.officeName) : ''}</div>
        </div>
        <div class="op-emp-status ${e.status}"><span class="dot"></span>${statusLabel}</div>
        <div class="op-emp-detail">${escape(e.detail || '')}</div>
        ${mapLink}
      </div>`;
  }).join('');
}

// ── Assignments modal ────────────────────────────────────────────────────
async function openAssignModal() {
  document.getElementById('assignModal').hidden = false;
  document.getElementById('opAssignError').style.display = 'none';
  assignDraft = {};
  const body = document.getElementById('opAssignBody');
  body.innerHTML = '<div class="holiday-skel" style="height:300px;"></div>';
  let r;
  try { r = await apiRequest('/hr/office-presence/employees'); }
  catch (e) { body.innerHTML = `<div class="sign-error" style="display:block;">${escape(e.message)}</div>`; return; }

  const employees = r.employees || [];
  const offices   = r.offices   || [];
  const opts = ['<option value="">— No assignment —</option>'].concat(
    offices.map(o => `<option value="${o.GeofenceId}">${escape(o.Name)} (${escape(o.City || '—')})</option>`)
  ).join('');

  body.innerHTML = employees.map(e => `
    <div class="op-assign-row" data-uid="${e.UserId}">
      <div>
        <div class="name">${escape(e.UserName || e.Email)}</div>
        <div class="sub">${escape(e.CompanyACode || e.Role || '—')} · ${escape(e.Email)}</div>
      </div>
      <select onchange="window._opAssignChange(${e.UserId}, this)">
        ${opts.replace(`value="${e.OfficeId || ''}"`, `value="${e.OfficeId || ''}" selected`)}
      </select>
    </div>`).join('');
}

window._opAssignChange = function (uid, sel) {
  const val = sel.value === '' ? null : parseInt(sel.value);
  assignDraft[uid] = val;
  sel.classList.add('changed');
};

function closeAssignModal() {
  document.getElementById('assignModal').hidden = true;
  assignDraft = {};
}

async function saveAssignments() {
  const list = Object.keys(assignDraft).map(uid => ({
    userId: parseInt(uid),
    officeId: assignDraft[uid],
  }));
  if (list.length === 0) { closeAssignModal(); return; }
  try {
    await apiRequest('/hr/office-presence/assign', { method: 'POST', body: { assignments: list } });
    closeAssignModal();
    load();
  } catch (e) {
    const err = document.getElementById('opAssignError');
    err.style.display = 'block';
    err.textContent = e.message || 'Save failed';
  }
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
