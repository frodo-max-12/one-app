// ============================================================================
// ONE App — PDC (Post-Dated Cheques) page
// CRUD + Excel import/export. Replaces CHEQUES IN.xlsx.
// ============================================================================
(function () {
  'use strict';
  const user = (typeof requireAuth === 'function') ? requireAuth() : null;
  let currentPage = 1, currentLimit = 100, totalRows = 0;
  let allRows = [];
  let editingId = null;
  let searchTimer = null;

  Object.assign(window, {
    loadList, clearSearch, openEdit, closeEdit, savePdc, deletePdc,
    openImport, closeImport, doImport, exportExcel, gotoPage,
    toggleSelectAll, onRowCheckChange, clearSelection, bulkDelete, exportSelectedExcel,
    filterByBucket, filterByRemark, showAll, dismissFailures,
  });

  const FAIL_LS_KEY = 'pdc_last_failures';

  let currentSummary = null;
  let currentBucket  = null;   // 'pending'|'deposited'|'cleared'|'online'|'bounced'|'cancelled' or null

  // Click a stat card — applies a bucket filter to the LIST via the backend.
  // Same logic as the stats query, so list & cards stay in sync.
  // Click the active card again to toggle it off.
  function filterByBucket(bucket) {
    currentBucket = (currentBucket === bucket) ? null : bucket;
    document.getElementById('pdcSearch').value = '';
    document.getElementById('pdcClearSearch').style.display = 'none';
    currentPage = 1;
    loadList();
  }

  // Legacy alias kept for any code path that still passes a label like "Pending".
  function filterByRemark(label) {
    const map = { pending:'pending', deposited:'deposited', cleared:'cleared',
                  online:'online', bounce:'bounced', bounced:'bounced', hold:'hold', cancelled:'cancelled' };
    filterByBucket(map[String(label || '').toLowerCase()] || null);
  }

  // Click "All" card — clear everything (search + bucket) and reload full list
  function showAll() {
    currentBucket = null;
    document.getElementById('pdcSearch').value = '';
    document.getElementById('pdcClearSearch').style.display = 'none';
    currentPage = 1;
    loadList();
  }

  function highlightActiveCard() {
    document.querySelectorAll('.pdc-stats .stat-card').forEach(c => c.classList.remove('active'));
    const cls = currentBucket ? `.stat-${currentBucket}` : '.stat-all';
    document.querySelector(`.pdc-stats ${cls}`)?.classList.add('active');
  }

  // Map a raw Status value (canonical key OR human label like "Cheque Bounce")
  // to one of our 9 internal keys. Mirrors the backend normalizeStatus().
  function normalizeStatus(raw) {
    const s = String(raw || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!s) return null;
    const known = new Set(['pending','not_deposited','with_salesperson','deposited','cleared','online','bounced','hold','cancelled']);
    if (known.has(s)) return s;
    const m = {
      'not deposited': 'not_deposited',
      'with salesperson': 'with_salesperson',
      'pdc with salesperson': 'with_salesperson',
      'online received': 'online', 'neft received': 'online', 'neft done': 'online', 'online transfer': 'online',
      'cheque bounce': 'bounced', 'bounce': 'bounced',
      'canceled': 'cancelled',
    };
    return m[s] || null;
  }

  // Row tint class — Status primary (after normalization), Remark text mining as
  // fallback for legacy rows that were imported before Status was being filled.
  function rowClassFor(r) {
    const st = normalizeStatus(r.Status);
    if (st === 'cancelled')        return 'row-cancelled';
    if (st === 'bounced')          return 'row-bounced';
    if (st === 'cleared')          return 'row-cleared';
    if (st === 'online')           return 'row-online';
    if (st === 'deposited')        return 'row-deposited';
    if (st === 'hold')             return 'row-hold';
    if (st === 'with_salesperson') return 'row-salesperson';
    // Status was 'pending' / null — peek at Remark for legacy data
    const t = (r.Remark || '').toLowerCase();
    if (t.includes('cancel'))                                return 'row-cancelled';
    if (t.includes('bounc'))                                 return 'row-bounced';
    if (t.includes('clear'))                                 return 'row-cleared';
    if (t.includes('online') || t.includes('neft'))          return 'row-online';
    if (t.includes('deposited') && !/not\s*deposit/.test(t)) return 'row-deposited';
    if (t.includes('hold'))                                  return 'row-hold';
    if (t.includes('salesperson') || t.includes('given to')) return 'row-salesperson';
    return 'row-pending';
  }

  // True when a cheque is still un-banked — its lane is Hold or Pending (which, on
  // the backend, folds not_deposited / with_salesperson / blank into 'pending').
  // Mirrors the backend bucketExprForFilter priority so the client-side Lapsed
  // fallback agrees with the server summary. Used only by computeSummaryFromRows.
  function isUnbankedLane(r) {
    const st = normalizeStatus(r.Status);
    if (st === 'cancelled' || st === 'bounced' || st === 'cleared' || st === 'online' || st === 'deposited') return false;
    if (st === 'hold' || st === 'pending' || st === 'not_deposited' || st === 'with_salesperson') return true;
    // status null/unknown → mine the Remark, same order as the backend
    const t = (r.Remark || '').toLowerCase();
    if (t.includes('cancel')) return false;
    if (t.includes('bounc'))  return false;
    if (t.includes('clear'))  return false;
    if (t.includes('online') || t.includes('neft')) return false;
    if (t.includes('deposited') && !/not\s*deposit/.test(t)) return false;
    return true;   // hold-ish or nothing → un-banked
  }

  function gotoPage(p) { currentPage = Math.max(1, p); loadList(); }

  if (user) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 0);
  }

  function init() {
    if (typeof renderSidebar === 'function') renderSidebar('pdc');
    document.getElementById('pdcSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      const v = document.getElementById('pdcSearch').value;
      document.getElementById('pdcClearSearch').style.display = v ? '' : 'none';
      searchTimer = setTimeout(loadList, 350);
    });
    ['pdcFromDate','pdcToDate'].forEach(id =>
      document.getElementById(id).addEventListener('change', loadList));
    initCustomerSuggest();
    renderFailureBanner();
    loadList();
  }

  // Show the most recent failed-import rows so the user can fix the source data
  // (e.g. shorten a Bill No, fix amount, etc.) and re-import. Persists across
  // navigation via localStorage until the user clicks "Dismiss".
  function renderFailureBanner() {
    const box = document.getElementById('pdcFailBanner');
    if (!box) return;
    let payload = null;
    try { payload = JSON.parse(localStorage.getItem(FAIL_LS_KEY) || 'null'); } catch (_) {}
    if (!payload || !Array.isArray(payload.failures) || !payload.failures.length) {
      box.hidden = true; return;
    }
    const when = payload.when ? new Date(payload.when).toLocaleString('en-IN') : '';
    box.innerHTML = `
      <div class="pdc-fail-banner-head">
        <div class="ttl">⚠ ${payload.failures.length} cheque${payload.failures.length === 1 ? '' : 's'} did not import</div>
        <div class="ts">${escapeHtml(when)}</div>
        <button class="dismiss" onclick="dismissFailures()">✕ Dismiss</button>
      </div>
      ${payload.failures.map(f => `
        <div class="pdc-fail-row">
          ${escapeHtml(f.customerName || '(no name)')} ·
          chq <b>${escapeHtml(f.chequeNo || '—')}</b> ·
          ${fmtCur(f.amount)} ·
          ${escapeHtml(f.chequeDate ? new Date(f.chequeDate).toLocaleDateString('en-IN') : '—')}
          <span class="reason">Reason: ${escapeHtml(f.reason || 'unknown')}</span>
        </div>`).join('')}
    `;
    box.hidden = false;
  }

  function dismissFailures() {
    localStorage.removeItem(FAIL_LS_KEY);
    const box = document.getElementById('pdcFailBanner');
    if (box) { box.hidden = true; box.innerHTML = ''; }
  }

  // ── Customer-name typeahead (NAV) ──────────────────────────────────────────
  // Debounced fetch as user types. Click a suggestion → fills Name + Code.
  // Clicking outside the dropdown closes it.
  let suggestTimer = null;
  function initCustomerSuggest() {
    const nameInput = document.getElementById('fCustomerName');
    const box       = document.getElementById('custSuggest');
    if (!nameInput || !box) return;

    nameInput.addEventListener('input', () => {
      clearTimeout(suggestTimer);
      const q = nameInput.value.trim();
      // User typed manually — clear any previously locked-in Code
      document.getElementById('fCustomerCode').value = '';
      if (q.length < 2) { hideSuggest(); return; }
      suggestTimer = setTimeout(() => loadSuggestions(q), 220);
    });

    nameInput.addEventListener('focus', () => {
      const q = nameInput.value.trim();
      if (q.length >= 2) loadSuggestions(q);
    });

    box.addEventListener('click', (e) => {
      const row = e.target.closest('.pdc-suggest-row');
      if (!row) return;
      document.getElementById('fCustomerName').value = row.dataset.name || '';
      document.getElementById('fCustomerCode').value = row.dataset.code || '';
      hideSuggest();
    });

    // Click outside closes
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#fCustomerName') && !e.target.closest('#custSuggest')) {
        hideSuggest();
      }
    });
  }

  async function loadSuggestions(q) {
    const box = document.getElementById('custSuggest');
    try {
      const r = await apiRequest(`/sales/customers/suggest?q=${encodeURIComponent(q)}&limit=20`);
      const rows = r.data || [];
      if (!rows.length) {
        box.innerHTML = `<div class="pdc-suggest-empty">No NAV customer matches "${escapeHtml(q)}". Type a different spelling or save name-only.</div>`;
        box.hidden = false;
        return;
      }
      box.innerHTML = rows.map(c => `
        <div class="pdc-suggest-row" data-code="${escapeAttr(c.CustomerCode)}" data-name="${escapeAttr(c.Name)}">
          <div class="name">${escapeHtml(c.Name)}</div>
          <div class="meta">${escapeHtml(c.CustomerCode)}${c.City ? ' · ' + escapeHtml(c.City) : ''}${c.Phone ? ' · ' + escapeHtml(c.Phone) : ''}</div>
        </div>`).join('');
      box.hidden = false;
    } catch (e) {
      hideSuggest();   // silent fail — user can still type the name manually
    }
  }
  function hideSuggest() { const b = document.getElementById('custSuggest'); if (b) b.hidden = true; }

  function clearSearch() {
    document.getElementById('pdcSearch').value = '';
    document.getElementById('pdcClearSearch').style.display = 'none';
    loadList();
  }

  async function loadList() {
    const params = new URLSearchParams({
      search:   document.getElementById('pdcSearch').value.trim(),
      fromDate: document.getElementById('pdcFromDate').value,
      toDate:   document.getElementById('pdcToDate').value,
      page:     currentPage,
      limit:    currentLimit,
    });
    if (currentBucket) params.set('bucket', currentBucket);
    const tbody = document.getElementById('pdcBody');
    tbody.innerHTML = '<tr><td colspan="15" class="pdc-loading">Loading…</td></tr>';
    try {
      const r = await apiRequest(`/sales/pdc?${params.toString()}`);
      allRows = r.data || [];
      totalRows = r.total || 0;
      currentSummary = r.summary || null;
      renderTable();
      renderStats();
      renderPagination();
      highlightActiveCard();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="15" class="pdc-empty">${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
    }
  }

  function renderTable() {
    const tbody = document.getElementById('pdcBody');
    if (!allRows.length) {
      tbody.innerHTML = `<tr><td colspan="15" class="pdc-empty">No PDCs match this filter. Click <b>+ Add PDC</b> or <b>⇧ Import Excel</b> to start.</td></tr>`;
      updateSelectionUI();
      return;
    }
    tbody.innerHTML = allRows.map(r => {
      const codeChip = r.CustomerCode
        ? `<div class="mono" style="opacity:0.7; font-size:10.5px;">${escapeHtml(r.CustomerCode)}</div>`
        : `<div class="mono" style="font-size:10.5px; color:#e11d48;">⚠ no NAV match</div>`;
      return `
      <tr class="${rowClassFor(r)}">
        <td style="text-align:center;"><input type="checkbox" class="pdc-row-chk" data-id="${r.PDCId}" onchange="onRowCheckChange()" /></td>
        <td style="white-space:nowrap;">${fmtDate(r.ChequeDate)}</td>
        <td>
          <div>${escapeHtml(r.CustomerName)}</div>
          ${codeChip}
        </td>
        <td class="r mono"><b>${fmtCur(r.Amount)}</b></td>
        <td class="mono">${escapeHtml(r.ChequeNo || '—')}</td>
        <td>${escapeHtml(r.BankName || '—')}</td>
        <td>${escapeHtml(r.Vertical || '—')}</td>
        <td class="mono">${escapeHtml(r.BillNo || '—')}</td>
        <td class="pdc-status-cell">${statusPill(r.Status)}</td>
        <td style="white-space:nowrap; font-size:11.5px;">${fmtDate(r.ReceivedDate)}</td>
        <td style="white-space:nowrap; font-size:11.5px;">${fmtDate(r.ClearedDate)}</td>
        <td style="max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeAttr(r.Remark || '')}">${escapeHtml(r.Remark || '—')}</td>
        <td class="mono" style="white-space:nowrap; font-size:11px; color:var(--text2);">${fmtDateTime(r.CreatedAt)}</td>
        <td style="font-size:11.5px;">${escapeHtml(r.ImportedBy || '—')}</td>
        <td class="r"><button class="pdc-row-action" onclick="openEdit(${r.PDCId})">Edit</button></td>
      </tr>`;
    }).join('');
    // Reset master-select + selection bar after re-render
    document.getElementById('pdcSelAll').checked = false;
    updateSelectionUI();
  }

  // ── Selection helpers ──────────────────────────────────────────────────────
  function getSelectedIds() {
    return Array.from(document.querySelectorAll('.pdc-row-chk:checked')).map(c => parseInt(c.dataset.id, 10));
  }
  function updateSelectionUI() {
    const ids = getSelectedIds();
    const bar = document.getElementById('pdcSelBar');
    if (ids.length === 0) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    document.getElementById('pdcSelCount').textContent = ids.length;
  }
  function onRowCheckChange() {
    // Keep master checkbox in sync (all checked? partial? none?)
    const rows = document.querySelectorAll('.pdc-row-chk');
    const checked = document.querySelectorAll('.pdc-row-chk:checked');
    const master = document.getElementById('pdcSelAll');
    master.checked = rows.length > 0 && checked.length === rows.length;
    master.indeterminate = checked.length > 0 && checked.length < rows.length;
    updateSelectionUI();
  }
  function toggleSelectAll(checked) {
    document.querySelectorAll('.pdc-row-chk').forEach(c => c.checked = checked);
    document.getElementById('pdcSelAll').indeterminate = false;
    updateSelectionUI();
  }
  function clearSelection() {
    document.querySelectorAll('.pdc-row-chk:checked').forEach(c => c.checked = false);
    const master = document.getElementById('pdcSelAll');
    master.checked = false; master.indeterminate = false;
    updateSelectionUI();
  }

  async function bulkDelete() {
    const ids = getSelectedIds();
    if (!ids.length) return;
    if (!confirm(`Soft-delete ${ids.length} PDC${ids.length === 1 ? '' : 's'}? They'll be hidden but kept in the DB for audit.`)) return;
    try {
      const r = await apiRequest('/sales/pdc/bulk-delete', { method: 'POST', body: { ids } });
      clearSelection();
      loadList();
      // brief toast — alert is functional but rough; could swap for a proper toast later
      setTimeout(() => alert(`✓ Deleted ${r.deleted} PDC${r.deleted === 1 ? '' : 's'}`), 50);
    } catch (e) {
      alert('Bulk delete failed: ' + (e.message || e));
    }
  }

  async function exportSelectedExcel() {
    const ids = getSelectedIds();
    if (!ids.length) return;
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const params  = new URLSearchParams({ ids: ids.join(','), company });
    try {
      const res = await fetch(`/api/sales/pdc/export?${params.toString()}`, {
        headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `COMPANYA_PDC_Selected_${ids.length}_${new Date().toISOString().slice(0,10)}.xlsx`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    } catch (e) { alert('Export Selected failed: ' + (e.message || e)); }
  }

  function renderStats() {
    // Null-safe: skip any card element that isn't in the DOM. This makes the page
    // resilient to a stale-cache deploy where an OLD pdc.js briefly runs against a
    // NEW pdc.html (or vice versa) — a missing id degrades one card to "—" instead
    // of throwing "Cannot set properties of null" and blanking the whole page.
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    setText('pdcCount', `${totalRows} PDC${totalRows === 1 ? '' : 's'}`);

    // Prefer backend summary (accurate across pagination). If it's missing (older
    // backend, error), fall back to computing from the visible page so cards
    // never just show zeros.
    let s = currentSummary;
    if (!s || s.TotalAmount == null) s = computeSummaryFromRows(allRows, totalRows);

    setText('statTotal',     s.Total || 0);
    setText('statAmount',    fmtCur(s.TotalAmount || 0));
    setText('statPending',   s.PendingCount   || 0);
    setText('statDeposited', s.DepositedCount || 0);
    setText('statCleared',   s.ClearedCount   || 0);
    setText('statOnline',    s.OnlineCount    || 0);
    setText('statBounced',   s.BouncedCount   || 0);
    setText('statHold',      s.HoldCount      || 0);
    setText('statMismatch',  s.MismatchCount  || 0);
    setText('statLapsed',    s.LapsedCount    || 0);
    setText('amtPending',    fmtCur(s.PendingAmount   || 0));
    setText('amtDeposited',  fmtCur(s.DepositedAmount || 0));
    setText('amtCleared',    fmtCur(s.ClearedAmount   || 0));
    setText('amtOnline',     fmtCur(s.OnlineAmount    || 0));
    setText('amtBounced',    fmtCur(s.BouncedAmount   || 0));
    setText('amtHold',       fmtCur(s.HoldAmount      || 0));
    setText('amtMismatch',   fmtCur(s.MismatchAmount  || 0));
    setText('amtLapsed',     fmtCur(s.LapsedAmount    || 0));
  }

  // Fallback: derive a summary from visible rows. Only used if the backend
  // didn't return one (e.g. old PM2 build still running). Counts here only
  // reflect the current page; the backend version is page-independent.
  // Same priority cascade as the backend & remarkRowClass.
  function computeSummaryFromRows(rows, total) {
    const o = {
      Total: total || rows.length, TotalAmount: 0,
      PendingCount: 0,   PendingAmount: 0,
      DepositedCount: 0, DepositedAmount: 0,
      ClearedCount: 0,   ClearedAmount: 0,
      OnlineCount: 0,    OnlineAmount: 0,
      BouncedCount: 0,   BouncedAmount: 0,
      HoldCount: 0,      HoldAmount: 0,
      CancelledCount: 0, CancelledAmount: 0,
      MismatchCount: 0,  MismatchAmount: 0,
      LapsedCount: 0,    LapsedAmount: 0,
    };
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    rows.forEach(r => {
      const amt = Number(r.Amount) || 0;
      o.TotalAmount += amt;
      // Lapsed (orthogonal, mirrors backend lapsedExpr): cheque date already in the
      // past AND still un-banked (Hold or Pending lane — incl. Not-Deposited /
      // With-Salesperson). Deposited/Cleared/Online/Bounced/Cancelled are excluded.
      const chq = r.ChequeDate ? new Date(r.ChequeDate) : null;
      if (chq && !isNaN(chq) && chq < startOfToday && isUnbankedLane(r)) {
        o.LapsedCount++; o.LapsedAmount += amt;
      }
      // Mismatch (orthogonal): no NAV code OR any missing key field. Mirrors the
      // backend mismatchExpr() so the fallback agrees with the server summary.
      const noCode   = !r.CustomerCode || String(r.CustomerCode).trim() === '';
      const noDate   = !r.ChequeDate;
      const noChqNo  = !r.ChequeNo || String(r.ChequeNo).trim() === '';
      const noAmount = !(amt > 0);
      const noStatus = !r.Status || String(r.Status).trim() === '';
      if (noCode || noDate || noChqNo || noAmount || noStatus) {
        o.MismatchCount++; o.MismatchAmount += amt;
      }
      const st = normalizeStatus(r.Status);
      let placed = true;
      if      (st === 'cancelled') { o.CancelledCount++; o.CancelledAmount += amt; }
      else if (st === 'bounced')   { o.BouncedCount++;   o.BouncedAmount   += amt; }
      else if (st === 'cleared')   { o.ClearedCount++;   o.ClearedAmount   += amt; }
      else if (st === 'online')    { o.OnlineCount++;    o.OnlineAmount    += amt; }
      else if (st === 'deposited') { o.DepositedCount++; o.DepositedAmount += amt; }
      else if (st === 'hold')      { o.HoldCount++;      o.HoldAmount      += amt; }
      else placed = false;
      if (placed) return;
      // Status was pending/null/unknown → check Remark for legacy data
      const t = (r.Remark || '').toLowerCase();
      if (t.includes('cancel'))                                 { o.CancelledCount++; o.CancelledAmount += amt; }
      else if (t.includes('bounc'))                             { o.BouncedCount++;   o.BouncedAmount   += amt; }
      else if (t.includes('clear'))                             { o.ClearedCount++;   o.ClearedAmount   += amt; }
      else if (t.includes('online') || t.includes('neft'))      { o.OnlineCount++;    o.OnlineAmount    += amt; }
      else if (t.includes('deposited') && !/not\s*deposit/.test(t)) { o.DepositedCount++; o.DepositedAmount += amt; }
      else if (t.includes('hold'))                              { o.HoldCount++;      o.HoldAmount      += amt; }
      else                                                      { o.PendingCount++;   o.PendingAmount   += amt; }
    });
    return o;
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(totalRows / currentLimit));
    const p = document.getElementById('pdcPagination');
    if (totalPages <= 1) { p.innerHTML = ''; return; }
    p.innerHTML = `
      <button ${currentPage <= 1 ? 'disabled' : ''} onclick="gotoPage(${currentPage - 1})">← Prev</button>
      <span class="pdc-page-info">Page ${currentPage} of ${totalPages} (${totalRows} rows)</span>
      <button ${currentPage >= totalPages ? 'disabled' : ''} onclick="gotoPage(${currentPage + 1})">Next →</button>
    `;
  }

  // True for admin / *head roles (accounts side). Salespersons get a locked status.
  function isStatusAdmin() {
    const role = (user && (user.role || '')).toLowerCase();
    return role === 'admin' || role.endsWith('head');
  }
  // Restrict the Status <select> for salespersons — only "PDC with Salesperson"
  // is allowed; backend enforces the same rule.
  function applyStatusRoleLock(currentStatus) {
    const sel = document.getElementById('fStatus');
    if (!sel) return;
    if (isStatusAdmin()) {
      sel.disabled = false;
      // restore the full option list if a previous edit narrowed it
      if (sel.options.length < 9) restoreFullStatusOptions();
      return;
    }
    // Salesperson: collapse to single option, lock the field
    sel.innerHTML = '<option value="with_salesperson">PDC with Salesperson</option>';
    sel.value = 'with_salesperson';
    sel.disabled = true;
    sel.title = 'Salesperson entries are filed as "PDC with Salesperson". Accounts will update the status once received.';
  }
  function restoreFullStatusOptions() {
    const sel = document.getElementById('fStatus');
    sel.innerHTML = `
      <option value="pending">Pending</option>
      <option value="not_deposited">Not Deposited</option>
      <option value="with_salesperson">PDC with Salesperson</option>
      <option value="deposited">Deposited</option>
      <option value="cleared">Cleared</option>
      <option value="online">Online Received</option>
      <option value="bounced">Cheque Bounce</option>
      <option value="hold">Hold</option>
      <option value="cancelled">Cancelled</option>`;
  }

  // ── Add / Edit modal ───────────────────────────────────────────────────────
  function openEdit(id) {
    editingId = id;
    const modal = document.getElementById('pdcModal');
    const title = document.getElementById('pdcModalTitle');
    document.getElementById('pdcError').style.display = 'none';
    document.getElementById('pdcDeleteBtn').style.display = id ? '' : 'none';

    if (id) {
      const row = allRows.find(r => r.PDCId === id);
      if (!row) return;
      title.textContent = 'Edit PDC';
      document.getElementById('pdcId').value           = id;
      document.getElementById('fCustomerName').value   = row.CustomerName || '';
      document.getElementById('fCustomerCode').value   = row.CustomerCode || '';
      document.getElementById('fChequeNo').value       = row.ChequeNo     || '';
      document.getElementById('fChequeDate').value     = isoDate(row.ChequeDate);
      document.getElementById('fAmount').value         = row.Amount       || '';
      document.getElementById('fBankName').value       = row.BankName     || '';
      document.getElementById('fVertical').value       = row.Vertical     || '';
      document.getElementById('fBillNo').value         = row.BillNo       || '';
      document.getElementById('fStatus').value         = row.Status       || 'pending';
      document.getElementById('fReceivedDate').value   = isoDate(row.ReceivedDate);
      document.getElementById('fClearedDate').value    = isoDate(row.ClearedDate);
      document.getElementById('fRemark').value         = row.Remark       || '';
    } else {
      title.textContent = 'Add PDC';
      ['pdcId','fCustomerName','fCustomerCode','fChequeNo','fChequeDate','fAmount',
       'fBankName','fVertical','fBillNo','fReceivedDate','fClearedDate','fRemark'
      ].forEach(f => document.getElementById(f).value = '');
      document.getElementById('fStatus').value = 'pending';
    }
    // Apply role lock LAST so it overrides whatever the branch above set
    applyStatusRoleLock(document.getElementById('fStatus').value);
    modal.hidden = false;
  }
  function closeEdit() { document.getElementById('pdcModal').hidden = true; editingId = null; }

  async function savePdc() {
    const err = document.getElementById('pdcError'); err.style.display = 'none';
    const customerName = document.getElementById('fCustomerName').value.trim();
    const chequeNo     = document.getElementById('fChequeNo').value.trim();
    const chequeDate   = document.getElementById('fChequeDate').value;
    const amount       = parseFloat(document.getElementById('fAmount').value);
    if (!customerName) { showErr(err, 'Customer Name is required'); return; }
    if (!chequeNo)     { showErr(err, 'Cheque No is required'); return; }
    if (!chequeDate)   { showErr(err, 'Cheque Date is required'); return; }
    if (!(amount > 0)) { showErr(err, 'Amount must be greater than 0'); return; }

    const payload = {
      customerName,
      customerCode: document.getElementById('fCustomerCode').value.trim() || null,
      chequeNo,
      chequeDate,
      amount,
      bankName:    document.getElementById('fBankName').value.trim() || null,
      vertical:    document.getElementById('fVertical').value.trim() || null,
      billNo:      document.getElementById('fBillNo').value.trim() || null,
      status:      document.getElementById('fStatus').value,
      receivedDate: document.getElementById('fReceivedDate').value || null,
      clearedDate:  document.getElementById('fClearedDate').value  || null,
      remark:      document.getElementById('fRemark').value.trim() || null,
    };
    try {
      if (editingId) {
        await apiRequest('/sales/pdc/' + editingId, { method: 'PATCH', body: payload });
      } else {
        await apiRequest('/sales/pdc', { method: 'POST', body: payload });
      }
      closeEdit();
      loadList();
    } catch (e) { showErr(err, e.message || 'Save failed'); }
  }

  async function deletePdc() {
    if (!editingId) return;
    if (!confirm('Soft-delete this PDC? It will be hidden from the list.')) return;
    try {
      await apiRequest('/sales/pdc/' + editingId, { method: 'DELETE' });
      closeEdit();
      loadList();
    } catch (e) { showErr(document.getElementById('pdcError'), e.message || 'Delete failed'); }
  }

  // ── Import / Export ─────────────────────────────────────────────────────────
  function openImport() {
    document.getElementById('importFile').value = '';
    document.getElementById('importError').style.display = 'none';
    document.getElementById('importResult').style.display = 'none';
    document.getElementById('importModal').hidden = false;
  }
  function closeImport() { document.getElementById('importModal').hidden = true; }

  async function doImport(dryRun) {
    const err = document.getElementById('importError');
    const result = document.getElementById('importResult');
    err.style.display = 'none'; result.style.display = 'none';
    const file = document.getElementById('importFile').files[0];
    if (!file) { showErr(err, 'Pick an Excel file first'); return; }

    const fd = new FormData();
    fd.append('file', file);
    fd.append('dryRun', dryRun ? 'true' : 'false');

    try {
      const company = (typeof getCompany === 'function') ? getCompany() : '';
      const token   = (typeof getToken   === 'function') ? getToken()   : '';
      const res = await fetch(`/api/sales/pdc/import?company=${encodeURIComponent(company)}`, {
        method: 'POST',
        headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) { showErr(err, data.message || data.detail || 'Import failed'); return; }

      let html = `
        <div style="font-size:13px; font-weight:700; color:${dryRun ? 'var(--accent)' : '#16a34a'}; margin-bottom:8px;">
          ${dryRun ? '👁 Preview (nothing saved yet)' : '✓ Import complete'}
        </div>
        <div class="pdc-import-stats">
          <div><span class="lbl">Rows in Excel</span><span class="val">${data.rowsScanned}</span></div>
          <div><span class="lbl">Rows parsed</span><span class="val">${data.rowsParsed}</span></div>
          <div><span class="lbl">Customers matched to NAV</span><span class="val" style="color:#16a34a;">${data.matched}</span></div>
          ${data.mismatched != null ? `<div><span class="lbl">⚠ Mismatch (needs fixing)</span><span class="val" style="color:#e11d48; font-weight:700;">${data.mismatched}</span></div>` : `<div><span class="lbl">Unmatched (saved by name only)</span><span class="val" style="color:#d97706;">${data.unmatched}</span></div>`}
          ${data.inserted != null ? `<div><span class="lbl">Newly inserted</span><span class="val" style="color:#16a34a; font-weight:700;">${data.inserted}</span></div>` : ''}
          ${data.updated  != null && data.updated  > 0 ? `<div><span class="lbl">Updated (existing rows synced)</span><span class="val" style="color:#0891b2; font-weight:700;">${data.updated}</span></div>` : ''}
          ${data.duplicates != null && data.duplicates > 0 ? `<div><span class="lbl">Skipped (duplicates)</span><span class="val" style="color:#d97706;">${data.duplicates}</span></div>` : ''}
          ${data.failed != null && data.failed > 0 ? `<div><span class="lbl">Failed</span><span class="val" style="color:#dc2626;">${data.failed}</span></div>` : ''}
        </div>
      `;
      if (Array.isArray(data.failures) && data.failures.length) {
        html += `<div style="margin-top:12px; font-weight:600; font-size:12px; color:#dc2626;">Failed rows (first ${data.failures.length}):</div>`;
        html += data.failures.map(f => `
          <div class="row-pre" style="color:#7f1d1d;">
            ✗ ${escapeHtml(f.customerName || '(no name)')} ·
            chq <b>${escapeHtml(f.chequeNo || '—')}</b> ·
            ${fmtCur(f.amount)} ·
            ${escapeHtml(f.chequeDate ? new Date(f.chequeDate).toLocaleDateString('en-IN') : '—')}
            <div style="margin-top:2px; font-size:10.5px;">Reason: ${escapeHtml(f.reason || 'unknown')}</div>
          </div>`).join('');
      }
      if (data.preview && data.preview.length) {
        html += `<div style="margin-top:14px; font-weight:600; font-size:12px;">First ${data.preview.length} parsed rows:</div>`;
        html += data.preview.map(p => `
          <div class="row-pre">
            ${fmtDate(p.chequeDate) || '<i>(no date)</i>'} ·
            ${escapeHtml(p.customerName)} ${p.customerCode ? `<span style="color:#16a34a;">[${p.customerCode}]</span>` : '<span style="color:#dc2626;">[unmatched]</span>'} ·
            ${fmtCur(p.amount)} · ${escapeHtml(p.chequeNo || '—')} · ${escapeHtml(p.bankName || '—')}
          </div>
        `).join('');
      }
      if (!dryRun && (data.inserted > 0 || data.updated > 0)) {
        html += `<div style="margin-top:14px; font-size:12px; color:var(--text2);">✓ Refreshing the list… you can close this window now.</div>`;
        loadList();   // refresh table in the background — don't auto-close modal
      }
      // Persist any failures so a banner stays visible on the PDC page after the
      // modal closes. Dry-run failures are also persisted (helpful for previewing).
      if (!dryRun) {
        if (Array.isArray(data.failures) && data.failures.length) {
          localStorage.setItem(FAIL_LS_KEY, JSON.stringify({ when: Date.now(), failures: data.failures }));
        } else if (data.failed === 0) {
          // Clean import — clear any stale banner from a previous attempt
          localStorage.removeItem(FAIL_LS_KEY);
        }
        renderFailureBanner();
      }
      result.innerHTML = html;
      result.style.display = '';
    } catch (e) { showErr(err, e.message || 'Import failed'); }
  }

  async function exportExcel() {
    const params = new URLSearchParams({
      search: document.getElementById('pdcSearch').value.trim(),
    });
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    params.set('company', company);
    try {
      const res = await fetch(`/api/sales/pdc/export?${params.toString()}`, {
        headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `COMPANYA_PDC_${new Date().toISOString().slice(0,10)}.xlsx`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    } catch (e) { alert('Export failed: ' + (e.message || e)); }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function showErr(el, msg) { el.textContent = msg; el.style.display = ''; }
  function fmtCur(n) { if (n == null || n === '') return '—'; return '₹ ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso); if (isNaN(d)) return '—';
    // Format: "1 April 26" (per user request 2026-05-26)
    return d.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'2-digit' });
  }
  // Renders the Status column as a small coloured pill. Empty status → em-dash.
  const STATUS_LABELS = {
    pending: 'Pending', not_deposited: 'Not Deposited', with_salesperson: 'With Salesperson',
    deposited: 'Deposited', cleared: 'Cleared', online: 'Online',
    bounced: 'Bounced', hold: 'Hold', cancelled: 'Cancelled',
  };
  function statusPill(status) {
    const norm = normalizeStatus(status);
    if (!norm) return '<span style="color:var(--text2);">—</span>';
    const label = STATUS_LABELS[norm] || norm;
    const cls = 's-' + norm.replace(/_/g, '-');
    return `<span class="pdc-status-pill ${cls}">${escapeHtml(label)}</span>`;
  }
  // "26 May 26, 4:32 PM" — used by IMPORTED AT column
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso); if (isNaN(d)) return '—';
    const date = d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'2-digit' });
    const time = d.toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit', hour12:true });
    return `${date}, ${time}`;
  }
  function isoDate(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return d.toISOString().slice(0, 10); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s) { return escapeHtml(s); }
})();
