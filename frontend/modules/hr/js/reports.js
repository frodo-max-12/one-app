// =====================================================================
// modules/hr/js/reports.js — Reports landing page (Phase 4B)
//
// Fetches /api/hr/reports/list, renders the left picker grouped by category,
// renders the selected report's filters + Preview/Excel/PDF actions, then
// posts to /api/hr/reports/run to fetch JSON preview or stream a download.
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
let allReports = [];
let current    = null;   // currently selected report def

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

window.filterReports = filterReports;
window.selectReport  = selectReport;
window.runReport     = runReport;

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-reports');
  try {
    const r = await apiRequest('/hr/reports/list');
    allReports = r.reports || [];
    renderList();
  } catch (err) {
    document.getElementById('reportsList').innerHTML =
      `<div class="rep-empty rep-err">Failed to load: ${escapeHtml(err.message || err)}</div>`;
  }
}

// ── LEFT pane ────────────────────────────────────────────────────────────────
function renderList() {
  const q = (document.getElementById('repSearch').value || '').trim().toLowerCase();
  const wrap = document.getElementById('reportsList');
  const groups = {};
  allReports.forEach(r => {
    if (q && !(r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))) return;
    (groups[r.group] = groups[r.group] || []).push(r);
  });
  const keys = Object.keys(groups);
  if (!keys.length) {
    wrap.innerHTML = `<div class="rep-empty">No reports match "${escapeHtml(q)}".</div>`;
    return;
  }
  wrap.innerHTML = keys.map(g => `
    <div class="rep-group-label">${escapeHtml(g)}</div>
    ${groups[g].map(r => `
      <button class="rep-item ${current && current.key === r.key ? 'active' : ''}"
              type="button" onclick="selectReport('${escapeAttr(r.key)}')">
        <div class="rep-item-name">${escapeHtml(r.name)}</div>
        <div class="rep-item-desc">${escapeHtml(r.description || '')}</div>
      </button>
    `).join('')}
  `).join('');
}

function filterReports() { renderList(); }

// ── RIGHT pane: selection ───────────────────────────────────────────────────
function selectReport(key) {
  const rep = allReports.find(r => r.key === key);
  if (!rep) return;
  current = rep;
  renderList();   // re-render left so active state updates

  document.getElementById('repName').textContent = rep.name;
  document.getElementById('repDesc').textContent = rep.description || '';
  document.getElementById('repControls').style.display = '';
  document.getElementById('repInfo').textContent = '';
  document.getElementById('repPreview').innerHTML =
    `<div class="rep-empty">Press Preview to load rows.</div>`;
  document.getElementById('repStatus').textContent = '';

  // The "Matrix (month grid)" export is specific to the Attendance+Visits report.
  const matrixBtn = document.getElementById('repMatrixBtn');
  if (matrixBtn) matrixBtn.style.display = (rep.key === 'attendance-visits') ? '' : 'none';

  // Render filter inputs
  const filtersWrap = document.getElementById('repFilters');
  if (!rep.params || !rep.params.length) {
    filtersWrap.innerHTML = `<span class="rep-no-filters">No filters required.</span>`;
    return;
  }
  filtersWrap.innerHTML = rep.params.map(p => {
    const def = p.default == null ? '' : p.default;
    let input;
    if (p.type === 'date') {
      input = `<input type="date" id="f_${p.key}" value="${escapeAttr(def)}">`;
    } else if (p.type === 'int') {
      input = `<input type="number" id="f_${p.key}" value="${escapeAttr(def)}" min="1" max="12">`;
    } else {
      input = `<input type="text" id="f_${p.key}" value="${escapeAttr(def)}">`;
    }
    return `<label class="rep-field">
              <span>${escapeHtml(p.label)}${p.required ? ' *' : ''}</span>${input}
            </label>`;
  }).join('');
}

// ── Matrix month-grid download (Attendance + Visits only) ────────────────────
// Streams GET /hr/reports/attendance-matrix?month=YYYY-MM as a per-employee grid.
// The month is taken from the report's "From" date filter (defaults to this month).
async function downloadMatrix() {
  const status = document.getElementById('repStatus');
  const fromEl = document.getElementById('f_from');
  let month = '';
  if (fromEl && /^\d{4}-\d{2}/.test(fromEl.value)) month = fromEl.value.slice(0, 7);
  else { const d = new Date(); month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  status.textContent = 'Generating matrix…';
  try {
    const token = (typeof getToken === 'function') ? getToken() : '';
    const res = await fetch(`/api/hr/reports/attendance-matrix?month=${encodeURIComponent(month)}`, {
      headers: { ...(token ? { Authorization: token } : {}) },
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).message || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^"]+)"?/.exec(cd);
    const fileName = m ? m[1] : `attendance-matrix_${month}.xlsx`;
    const a = document.createElement('a');
    a.href = objUrl; a.download = fileName;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(objUrl); }, 0);
    status.textContent = 'Downloaded ' + fileName;
  } catch (err) {
    renderError(err.message || String(err));
    status.textContent = '';
  }
}

// ── Action handler ──────────────────────────────────────────────────────────
async function runReport(format) {
  if (!current) return;
  const filters = {};
  for (const p of (current.params || [])) {
    const el = document.getElementById('f_' + p.key);
    if (el) filters[p.key] = el.value;
  }
  const status = document.getElementById('repStatus');
  status.textContent = format === 'json' ? 'Loading preview…' : 'Generating…';

  if (format === 'json') {
    try {
      const data = await apiRequest('/hr/reports/run', {
        method: 'POST',
        body: { key: current.key, filters, format: 'json' },
      });
      renderPreview(data);
      status.textContent = `${data.rows.length} row(s)`;
    } catch (err) {
      renderError(err.message || String(err));
      status.textContent = '';
    }
    return;
  }

  // xlsx | pdf — raw fetch so we receive a binary blob
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const url     = `/api/hr/reports/run?company=${encodeURIComponent(company)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Company':    company,
        ...(token ? { Authorization: token } : {}),
      },
      body: JSON.stringify({ key: current.key, filters, format }),
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).message || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^"]+)"?/.exec(cd);
    const fileName = m ? m[1] : `${current.key}.${format}`;
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(objUrl); }, 0);
    status.textContent = 'Downloaded ' + fileName;
  } catch (err) {
    renderError(err.message || String(err));
    status.textContent = '';
  }
}

// ── Preview rendering ───────────────────────────────────────────────────────
function renderPreview(data) {
  const wrap = document.getElementById('repPreview');
  const info = document.getElementById('repInfo');
  const cols = data.columns || [];
  const rows = data.rows || [];

  info.innerHTML = `
    <span class="info-pill">Rows: <b>${rows.length}</b></span>
    <span class="info-pill">Run: ${formatLocal(data.runAt)}</span>
    ${data.runBy ? `<span class="info-pill">By: ${escapeHtml(data.runBy)}</span>` : ''}
  `;

  if (!rows.length) {
    wrap.innerHTML = `<div class="rep-empty">No rows matched the filters.</div>`;
    return;
  }

  const head = '<tr>' + cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('') + '</tr>';
  const body = rows.map(r => '<tr>' + cols.map(c => {
    const v = r[c.key];
    return `<td>${escapeHtml(formatCell(v, c.type))}</td>`;
  }).join('') + '</tr>').join('');

  wrap.innerHTML = `<div class="rep-table-scroll"><table class="rep-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function renderError(msg) {
  document.getElementById('repPreview').innerHTML =
    `<div class="rep-empty rep-err">${escapeHtml(msg)}</div>`;
}

// ── Formatting helpers ──────────────────────────────────────────────────────
function formatCell(v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'date') {
    const d = new Date(v); return isNaN(d) ? String(v) :
      [d.getDate(), d.getMonth() + 1, d.getFullYear()].map(n => String(n).padStart(2,'0')).join('-');
  }
  if (type === 'datetime') {
    const d = new Date(v); return isNaN(d) ? String(v) :
      [d.getDate(), d.getMonth() + 1, d.getFullYear()].map(n => String(n).padStart(2,'0')).join('-') + ' ' +
      [d.getHours(), d.getMinutes()].map(n => String(n).padStart(2,'0')).join(':');
  }
  if (type === 'bool') return v ? 'Yes' : 'No';
  if (type === 'number') { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) : String(v); }
  return String(v);
}

function formatLocal(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN', { hour12: false }); } catch (_) { return String(iso); }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
