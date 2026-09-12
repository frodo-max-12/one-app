// =====================================================================
// beatPlan.js — Electrical vertical weekly beat plan (v1.8)
//
// Reps see their own beat (read-only). Admin family + any *head* role with
// codes can switch reps, add/move/remove outlets and trigger month
// generation. Server enforces all of it (routes/beatPlan.js) — gating here
// is cosmetic only.
// =====================================================================
const bpUser = requireAuth();
if (bpUser) {
  renderSidebar('beatplan');
  setRoleTag();
}

const BP_DAYS = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday' };
const bpRole = (bpUser.role || '').toLowerCase();
const bpIsAdmin = ['admin', 'operation head', 'director'].includes(bpRole);
const bpIsHead  = /\bhead\b/.test(bpRole);
const bpCanEdit = bpIsAdmin || bpIsHead;

let bpDay = new Date().getDay() || 1;          // default to today (Sun -> Mon)
if (bpDay === 0) bpDay = 1;
let bpReps = [];
let bpRows = [];

if (bpCanEdit) {
  document.getElementById('addBtn').style.display = 'inline-block';
  document.getElementById('genBtn').style.display = 'inline-block';
  document.getElementById('importBtn').style.display = 'inline-block';
  document.getElementById('bpActionsTh').style.display = '';
}

document.getElementById('refreshBtn').addEventListener('click', () => loadBeat());
document.getElementById('repFilter').addEventListener('change', () => loadBeat());
document.getElementById('addBtn').addEventListener('click', openAddModal);
document.getElementById('genBtn').addEventListener('click', generateMonth);
document.getElementById('exportBtn').addEventListener('click', exportBeat);
document.getElementById('importBtn').addEventListener('click', openImportModal);

init();

async function init() {
  try {
    const r = await apiRequest('/sales/beatplan/reps');
    bpReps = (r && r.data) || [];
    const sel = document.getElementById('repFilter');
    if (!bpReps.length) {
      sel.style.display = 'none';
    } else if (bpReps.length === 1) {
      sel.innerHTML = `<option value="${escAttr(bpReps[0].SalespersonCode)}">${escapeHtml(bpReps[0].SalespersonName || bpReps[0].SalespersonCode)}</option>`;
      sel.disabled = true;
    } else {
      sel.innerHTML = bpReps.map(x =>
        `<option value="${escAttr(x.SalespersonCode)}">${escapeHtml(x.SalespersonName || x.SalespersonCode)} (${x.Outlets})</option>`).join('');
    }
  } catch (e) { /* reps load failure -> empty page state below */ }
  // Month picker for the Planned-vs-Completed summary (defaults to current month).
  const mp = document.getElementById('bpSumMonth');
  if (mp) {
    const now = new Date();
    mp.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    mp.addEventListener('change', loadSummary);
  }
  loadSummary();
  loadBeat();
}

// ── Planned vs Completed summary (beat-generated visits) ──
async function loadSummary() {
  const body = document.getElementById('bpSumBody');
  const stats = document.getElementById('bpSumStats');
  const sub = document.getElementById('bpSumSub');
  if (!body) return;
  const pill = (label, val, color) =>
    `<span style="display:inline-block; padding:5px 12px; margin:0 8px 8px 0; border-radius:16px; background:var(--bg3,#1c212b); border:1px solid var(--border,#2a2f3a); font-size:13px;${color ? `color:${color};` : ''}">${label} <b>${val}</b></span>`;
  try {
    const month = (document.getElementById('bpSumMonth') || {}).value || '';
    const res = await apiRequest(`/sales/beatplan/summary${month ? '?month=' + month : ''}`);
    const rows = (res && res.byRep) || [];
    const t = (res && res.totals) || { Planned: 0, Completed: 0, Pending: 0 };
    const pct = t.Planned ? Math.round((t.Completed / t.Planned) * 100) : 0;
    if (sub) sub.textContent = rows.length ? `— ${rows.length} rep(s)` : '';
    if (stats) stats.innerHTML = pill('Planned', t.Planned || 0) +
      pill('Completed', t.Completed || 0, '#22c55e') +
      pill('Pending', t.Pending || 0, '#f59e0b') +
      pill('% Done', pct + '%');
    body.innerHTML = rows.length ? rows.map(r => {
      const p = r.Planned ? Math.round((r.Completed / r.Planned) * 100) : 0;
      return `<tr>
        <td>${escapeHtml(r.SalespersonName || r.SalespersonCode)}</td>
        <td style="text-align:right;">${r.Planned}</td>
        <td style="text-align:right; color:#22c55e;">${r.Completed || 0}</td>
        <td style="text-align:right; color:#f59e0b;">${r.Pending || 0}</td>
        <td style="text-align:right;"><b>${p}%</b></td>
      </tr>`;
    }).join('') : `<tr><td colspan="5" style="text-align:center; color:var(--text3); padding:16px;">No beat visits generated for this month.</td></tr>`;
  } catch (e) {
    if (body) body.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#ef4444; padding:16px;">Could not load summary.</td></tr>`;
  }
}

function selectedRep() {
  const sel = document.getElementById('repFilter');
  return sel && sel.style.display !== 'none' ? sel.value : '';
}

async function loadBeat() {
  const loading = document.getElementById('loadingDiv');
  const table   = document.getElementById('bpTable');
  const empty   = document.getElementById('emptyDiv');
  loading.style.display = 'flex';
  table.style.display   = 'none';
  empty.style.display   = 'none';

  try {
    const params = new URLSearchParams();
    const rep = selectedRep();
    if (rep) params.set('salespersonCode', rep);
    const res = await apiRequest(`/sales/beatplan?${params}`);
    const all = (res && res.data) || [];
    const dayCounts = (res && res.dayCounts) || {};

    renderTabs(dayCounts);
    bpRows = all.filter(r => r.Weekday === bpDay);
    document.getElementById('bpTotal').textContent =
      all.length ? `— ${all.length} outlets across the week` : '';

    if (!bpRows.length) {
      empty.style.display = 'block';
      document.querySelector('#emptyDiv .empty-text').textContent = all.length
        ? `No outlets on ${BP_DAYS[bpDay]} for this salesperson`
        : 'No beat plan assigned';
    } else {
      table.style.display = 'table';
      renderRows();
    }
  } catch (e) {
    empty.style.display = 'block';
    document.querySelector('#emptyDiv .empty-text').textContent = 'Could not load beat plan — refresh to retry';
  } finally {
    loading.style.display = 'none';
  }
}

function renderTabs(dayCounts) {
  document.getElementById('dayTabs').innerHTML = Object.entries(BP_DAYS).map(([d, label]) =>
    `<div class="bp-tab ${Number(d) === bpDay ? 'active' : ''}" onclick="switchDay(${d})">
       ${label}<span class="bp-count">${dayCounts[d] || 0}</span>
     </div>`).join('');
}

function switchDay(d) { bpDay = Number(d); loadBeat(); }

function renderRows() {
  const tbody = document.getElementById('bpBody');
  tbody.innerHTML = bpRows.map((r, i) => `
    <tr>
      <td class="td-mono">${i + 1}</td>
      <td>
        <div class="td-bold">${escapeHtml(r.OutletName)}</div>
        ${r.OutletCode ? `<div style="font-size:11px; color:var(--text3); font-family:var(--mono);">DMS ${escapeHtml(r.OutletCode)}</div>` : ''}
      </td>
      <td class="bp-route">${escapeHtml(r.RouteName || '—')}</td>
      <td class="td-mono" style="font-size:12px;">${r.Phone ? `<a href="tel:${escAttr(r.Phone)}" style="color:var(--accent); text-decoration:none;">${escapeHtml(r.Phone)}</a>` : '—'}</td>
      <td>${(r.Lat && r.Lng)
        ? `<a href="https://www.google.com/maps?q=${Number(r.Lat)},${Number(r.Lng)}" target="_blank" title="Open in Google Maps" style="text-decoration:none;">📍</a>`
        : '<span style="color:var(--text3);">—</span>'}</td>
      ${bpCanEdit ? `
      <td style="white-space:nowrap;">
        <select class="select-filter" style="padding:3px 6px; font-size:12px;" onchange="moveDay(${r.Id}, this.value)" title="Move to another day">
          <option value="">Move…</option>
          ${Object.entries(BP_DAYS).filter(([d]) => Number(d) !== bpDay)
            .map(([d, l]) => `<option value="${d}">${l}</option>`).join('')}
        </select>
        <a href="javascript:void(0)" onclick="removeOutlet(${r.Id})" title="Remove from beat" style="color:var(--red); text-decoration:none; margin-left:8px; font-size:15px;">✕</a>
      </td>` : ''}
    </tr>
  `).join('');
}

async function moveDay(id, day) {
  if (!day) return;
  try {
    await apiRequest(`/sales/beatplan/${id}`, { method: 'PATCH', body: { weekday: Number(day) } });
    loadBeat();
  } catch (e) { alert('Move failed: ' + (e.message || e)); }
}

async function removeOutlet(id) {
  const row = bpRows.find(r => r.Id === id);
  if (!confirm(`Remove "${(row && row.OutletName) || 'this outlet'}" from the beat?\n\nAlready-generated visit plans for past/future dates are NOT touched; the outlet just stops appearing in newly generated months.`)) return;
  try {
    await apiRequest(`/sales/beatplan/${id}`, { method: 'DELETE' });
    loadBeat();
  } catch (e) { alert('Remove failed: ' + (e.message || e)); }
}

function openAddModal() {
  const am = document.getElementById('amRep');
  am.innerHTML = bpReps.map(x =>
    `<option value="${escAttr(x.SalespersonCode)}" data-name="${escAttr(x.SalespersonName || '')}">${escapeHtml(x.SalespersonName || x.SalespersonCode)}</option>`).join('');
  const cur = selectedRep();
  if (cur) am.value = cur;
  document.getElementById('amDay').value = String(bpDay);
  document.getElementById('amName').value = '';
  document.getElementById('amPhone').value = '';
  document.getElementById('amRoute').value = '';
  document.getElementById('addModal').style.display = 'flex';
}
function closeAddModal() { document.getElementById('addModal').style.display = 'none'; }

async function saveOutlet() {
  const rep = document.getElementById('amRep');
  const name = document.getElementById('amName').value.trim();
  if (!name) { alert('Outlet name is required'); return; }
  const btn = document.getElementById('amSave');
  btn.disabled = true;
  try {
    await apiRequest('/sales/beatplan', { method: 'POST', body: {
      salespersonCode: rep.value,
      salespersonName: rep.selectedOptions[0] ? rep.selectedOptions[0].dataset.name : '',
      weekday: Number(document.getElementById('amDay').value),
      outletName: name,
      phone: document.getElementById('amPhone').value.trim() || null,
      routeName: document.getElementById('amRoute').value.trim() || null,
    }});
    closeAddModal();
    loadBeat();
  } catch (e) {
    alert('Add failed: ' + (e.message || e));
  } finally { btn.disabled = false; }
}

async function generateMonth() {
  const now = new Date();
  const label = now.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  if (!confirm(`Generate visit plans for ${label}?\n\nEvery active beat outlet becomes a Visit Plan entry on its weekday for the REMAINING days of the month (from tomorrow). Already-generated days are skipped automatically — safe to run again.`)) return;
  const btn = document.getElementById('genBtn');
  btn.disabled = true; btn.textContent = '⏳ Generating…';
  try {
    const r = await apiRequest('/sales/beatplan/generate', { method: 'POST', body: {} });
    alert(r.message || 'Done');
  } catch (e) {
    alert('Generation failed: ' + (e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = '⟳ Generate This Month';
  }
}

// ── Export / Import (Excel) ────────────────────────────────────────────────
async function exportBeat() {
  const company = getCompany();
  const token   = getToken();
  const rep = selectedRep();
  const qs = new URLSearchParams({ company });
  if (rep) qs.set('salespersonCode', rep);
  try {
    const res = await fetch('/api/sales/beatplan/export?' + qs.toString(),
      { headers: { Authorization: token, 'X-Company': company } });
    if (!res.ok) { alert('Export failed (HTTP ' + res.status + ')'); return; }
    const blob = await res.blob();
    const fname = 'BeatPlan_' + new Date().toISOString().slice(0,10) + '.xlsx';
    const inCap = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if (inCap && window.nativeSaveAndShare) {
      await nativeSaveAndShare(blob, fname, { dialogTitle: 'Beat Plan export' });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (e) { alert('Export error: ' + (e.message || e)); }
}

function openImportModal() {
  document.getElementById('impFile').value = '';
  document.getElementById('impDryRun').checked = true;
  const r = document.getElementById('impResult'); r.style.display = 'none'; r.innerHTML = '';
  document.getElementById('importModal').style.display = 'flex';
}
function closeImportModal() { document.getElementById('importModal').style.display = 'none'; }

async function runImport() {
  const fileInput = document.getElementById('impFile');
  if (!fileInput.files || !fileInput.files[0]) { alert('Choose an Excel file first'); return; }
  const dryRun = document.getElementById('impDryRun').checked;
  const company = getCompany();
  const token   = getToken();
  const btn = document.getElementById('impRun');
  btn.disabled = true; btn.textContent = dryRun ? 'Checking…' : 'Uploading…';
  try {
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    const res = await fetch('/api/sales/beatplan/import?company=' + encodeURIComponent(company) + '&dryRun=' + dryRun,
      { method: 'POST', headers: { Authorization: token, 'X-Company': company }, body: fd });
    const j = await res.json();
    const box = document.getElementById('impResult');
    box.style.display = 'block';
    if (!res.ok) { box.innerHTML = '<span class="bp-import-err">' + escapeHtml(j.message || 'Import failed') + '</span>'; return; }
    let html = '<strong>' + escapeHtml(j.message || '') + '</strong>';
    if (j.errors && j.errors.length) {
      html += '<br><span class="bp-import-err">' + j.errors.map(escapeHtml).join('<br>') + '</span>';
    }
    box.innerHTML = html;
    if (!dryRun) { loadBeat(); }   // refresh table after a real import
  } catch (e) {
    const box = document.getElementById('impResult');
    box.style.display = 'block';
    box.innerHTML = '<span class="bp-import-err">Import error: ' + escapeHtml(e.message || String(e)) + '</span>';
  } finally {
    btn.disabled = false; btn.textContent = 'Upload';
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escAttr(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

Object.assign(window, { switchDay, moveDay, removeOutlet, closeAddModal, saveOutlet, closeImportModal, runImport });
