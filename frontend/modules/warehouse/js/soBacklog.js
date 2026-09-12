// =====================================================================
// modules/warehouse/js/soBacklog.js — Warehouse-focused SO Backlog grid
//
// Why a separate file instead of reusing the Sales SO Backlog JS:
//   • Amit only needs 16 columns (vs ~50 in Sales) — clean, readable grid.
//   • Two hard-coded categories (PFP / In-Transit) drive the page; no
//     "show all" mode, no salesperson filter, no qty-on-hand etc.
//   • Avoids the fetch-wrapper hack we previously used to inject the
//     category query param into Sales JS.
//
// Endpoint: /api/sales/sobacklog (shared, returns all 50+ columns; we
// only render 16). Backend already supports ?remarks= and ?remarksLike=.
// =====================================================================
(function () {
  const IN_TRANSIT_TOKENS = 'PWV-T,PWPR-INT,PWPR-VPD INT';

  // Categories — 5 distinct + 'all' meaning no category filter (show all
  // PFP-prefix + In-Transit combined). 2026-06-15 update: 4 PFP variants
  // surfaced separately.
  //   'all'            → no category filter (Clear All Filters lands here)
  //   'pfp'            → Remarks = 'PFP' exact
  //   'pfp-waiting-ff' → Remarks = 'PFP-WAITING-FF' exact
  //   'pfp-drop'       → Remarks = 'PFP-DROP' exact
  //   'pfp-pick-pack'  → Remarks = 'PFP-PICK-PACK' exact
  //   'intransit'      → Remarks LIKE %PWV-T%/%PWPR-INT%/%PWPR-VPD INT%
  const CAT_TO_REMARKS = {
    'pfp':            { remarks: 'PFP' },
    'pfp-waiting-ff': { remarks: 'PFP-WAITING-FF' },
    'pfp-drop':       { remarks: 'PFP-DROP' },
    'pfp-pick-pack':  { remarks: 'PFP-PICK-PACK' },
    'intransit':      { remarksLike: IN_TRANSIT_TOKENS },
    'all':            { remarksLike: 'PFP,' + IN_TRANSIT_TOKENS },
  };
  let category = sessionStorage.getItem('whSoCategory') || 'pfp';
  // Migrate any pre-2026-06-15 saved value
  if (!CAT_TO_REMARKS[category]) category = 'pfp';
  let page     = 1;
  const limit  = 50;
  let totalRecords = 0;
  let currentRows  = [];
  let currentSymbol = '$';

  // ── DOM helpers ────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const fmtN = (n) => Number(n || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQty = (n) => Number(n || 0).toLocaleString('en-US',
    { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  const fmtDate = (s) => {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  // ── Default date range (last 2 years) ──────────────────────────────────
  function setDefaultDateRange() {
    const today = new Date();
    const past  = new Date(); past.setFullYear(past.getFullYear() - 2);
    const fmt = (d) => d.toISOString().slice(0, 10);
    if (!$('startDateInput').value) $('startDateInput').value = fmt(past);
    if (!$('endDateInput').value)   $('endDateInput').value   = fmt(today);
  }

  // ── Build the API URL with all current filters ─────────────────────────
  function buildUrl(extraParams = {}) {
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    const sd = $('startDateInput').value;
    const ed = $('endDateInput').value;
    if (sd) qs.set('startDate', sd);
    if (ed) qs.set('endDate',   ed);
    const search = $('soSearchInput').value.trim();
    if (search) qs.set('search', search);

    // Category → query-param mapping (lookup table)
    const cat = extraParams.category || category;
    const filter = CAT_TO_REMARKS[cat] || {};
    if (filter.remarks)     qs.set('remarks',     filter.remarks);
    if (filter.remarksLike) qs.set('remarksLike', filter.remarksLike);
    // Allow override for category-total side-fetches
    Object.keys(extraParams).forEach(k => {
      if (k !== 'category') qs.set(k, extraParams[k]);
    });
    return '/sales/sobacklog?' + qs.toString();
  }

  // ── Render the 16-column grid ──────────────────────────────────────────
  function renderRows(rows, symbol) {
    currentRows  = rows;
    currentSymbol = symbol || '$';
    const tbody = $('soBody');
    if (!rows.length) {
      tbody.innerHTML = '';
      $('soTableWrap').style.display = 'none';
      $('soEmpty').style.display = '';
      return;
    }
    $('soEmpty').style.display = 'none';
    $('soTableWrap').style.display = '';
    const offset = (page - 1) * limit;
    tbody.innerHTML = rows.map((r, i) => {
      const idx = offset + i + 1;
      return `<tr>
        <td class="col-freeze">${idx}</td>
        <td>${esc(r['SO No.'])}</td>
        <td>${fmtDate(r['SO Date'])}</td>
        <td>${esc(r['Customer'])}</td>
        <td>${esc(r['Customer PO No.'])}</td>
        <td>${fmtDate(r['Promise Delivery Date'])}</td>
        <td>${fmtDate(r['Revised Promise Delivery Date'])}</td>
        <td>${esc(r['MPN'])}</td>
        <td>${esc(r['Make'])}</td>
        <td style="text-align:right;">${fmtN(r['Unit Price'])}</td>
        <td style="text-align:right;">${fmtQty(r['PO Qty.'])}</td>
        <td>${esc(r['UOM'])}</td>
        <td style="text-align:right;">${fmtN(r['PO Value'])}</td>
        <td style="text-align:right;">${fmtQty(r['Bal. Qty.'])}</td>
        <td style="text-align:right;">${fmtN(r['Bal. Value'])}</td>
        <td>${esc(r['Remarks'])}</td>
        <td>${esc(r['Posting No'])}</td>
      </tr>`;
    }).join('');
  }

  // ── Pagination ─────────────────────────────────────────────────────────
  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(totalRecords / limit));
    const wrap = $('soPagination');
    if (totalRecords <= limit) { wrap.innerHTML = ''; return; }
    const btns = [];
    btns.push(`<button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} data-pg="${page - 1}">← Prev</button>`);
    btns.push(`<span style="margin:0 12px;">Page ${page} of ${totalPages} · ${totalRecords.toLocaleString()} records</span>`);
    btns.push(`<button class="btn btn-ghost btn-sm" ${page >= totalPages ? 'disabled' : ''} data-pg="${page + 1}">Next →</button>`);
    wrap.innerHTML = btns.join('');
    wrap.querySelectorAll('button[data-pg]').forEach(b => {
      b.addEventListener('click', () => {
        page = Number(b.dataset.pg);
        load();
      });
    });
  }

  // ── Main grid load ─────────────────────────────────────────────────────
  async function load() {
    $('soLoading').style.display = '';
    $('soError').style.display   = 'none';
    $('soTableWrap').style.display = 'none';
    $('soEmpty').style.display = 'none';
    try {
      const data = await window.apiRequest(buildUrl());
      totalRecords = data.total || 0;
      currentSymbol = data.symbol || '$';
      $('soTotalText').textContent = `${totalRecords.toLocaleString()} records`;
      $('statTotalLines').textContent = totalRecords.toLocaleString();
      // Current-filter Bal. Value total (sum across all pages = we sum what
      // we got + label it "(this page)" if not all rows present).
      // For an accurate total across all pages, we use the side-fetches below.
      renderRows(data.data || [], data.symbol);
      renderPagination();
      // Refresh both category totals (PFP + In-Transit) every time
      refreshBothTotals();
    } catch (err) {
      console.error('[Warehouse SO Backlog] load failed', err);
      $('soError').style.display = '';
      $('soErrorText').textContent = 'Failed to load SO Backlog. ' + (err.message || '');
    } finally {
      $('soLoading').style.display = 'none';
    }
  }

  // ── Fetch a category's full total (separately from the grid load) ─────
  async function fetchCategoryTotal(cat) {
    const url = buildUrl({ category: cat, page: '1', limit: '5000' });
    const data = await window.apiRequest(url);
    const rows = (data && data.data) || [];
    let sumBal = 0;
    rows.forEach(r => { sumBal += Number(r['Bal. Value']) || 0; });
    return { rows, sumBal, symbol: (data && data.symbol) || '$' };
  }

  // Map of category → DOM ids for its card + value/sub elements
  const CARD_MAP = {
    'pfp':            { card: 'pfpCard',     value: 'statPfpValue',     sub: 'statPfpSub',     badge: 'pfpActiveBadge',     label: 'PFP' },
    'pfp-waiting-ff': { card: 'wffCard',     value: 'statWffValue',     sub: 'statWffSub',     badge: 'wffActiveBadge',     label: 'Waiting for Freight Forwarder' },
    'pfp-drop':       { card: 'dropCard',    value: 'statDropValue',    sub: 'statDropSub',    badge: 'dropActiveBadge',    label: 'Drop shipment' },
    'pfp-pick-pack':  { card: 'pickPackCard',value: 'statPpValue',      sub: 'statPpSub',      badge: 'ppActiveBadge',      label: 'Pick & Pack' },
    'intransit':      { card: 'transitCard', value: 'statTransitValue', sub: 'statTransitSub', badge: 'transitActiveBadge', label: 'PWV-T · PWPR-INT · PWPR-VPD INT' },
  };

  let refreshing = false;
  async function refreshAllTotals() {
    if (refreshing) return;
    refreshing = true;
    try {
      // Fire all 5 category totals in parallel
      const cats = Object.keys(CARD_MAP);
      const results = await Promise.all(cats.map(c => fetchCategoryTotal(c).catch(() => null)));
      let combinedSum = 0;
      let combinedLines = 0;
      let lastSymbol = '$';
      results.forEach((res, i) => {
        if (!res) return;
        const cat = cats[i];
        const m = CARD_MAP[cat];
        const vEl = $(m.value);
        const sEl = $(m.sub);
        if (vEl) vEl.textContent = res.symbol + ' ' + fmtN(res.sumBal);
        if (sEl) sEl.textContent = `${m.label} · ${res.rows.length} lines`;
        combinedSum   += Number(res.sumBal) || 0;
        combinedLines += res.rows.length || 0;
        lastSymbol = res.symbol || lastSymbol;
      });
      // Total Bal. Value card:
      //  - In a specific category (PFP / variant / In-Transit): mirror that card's sum
      //  - In 'all' (Clear All Filters): SUM across all 5 categories
      const active = CARD_MAP[category];
      if (active) {
        const v = $(active.value);
        if (v) $('statBalValue').textContent = v.textContent;
      } else {
        // 'all' mode → combined sum of all categories
        $('statBalValue').textContent = lastSymbol + ' ' + fmtN(combinedSum);
        const tl = $('statTotalLines');
        if (tl) tl.textContent = combinedLines;
      }
    } finally { refreshing = false; }
  }

  // Back-compat alias used elsewhere
  const refreshBothTotals = refreshAllTotals;

  // ── Category switching ─────────────────────────────────────────────────
  function paintActive() {
    Object.keys(CARD_MAP).forEach(cat => {
      const m = CARD_MAP[cat];
      const isActive = cat === category;
      const card = $(m.card);
      const badge = $(m.badge);
      if (card) card.classList.toggle('active', isActive);
      if (badge) badge.style.display = isActive ? '' : 'none';
    });
  }

  function switchCategory(cat) {
    if (category === cat) return;
    category = cat;
    sessionStorage.setItem('whSoCategory', cat);
    page = 1;
    paintActive();
    load();
  }

  // ── Excel export of the 16 visible columns ─────────────────────────────
  async function exportExcel() {
    try {
      const data = await window.apiRequest(buildUrl({ page: '1', limit: '5000' }));
      const rows = (data && data.data) || [];
      if (!rows.length) { alert('Nothing to export.'); return; }
      const out = rows.map(r => ({
        'SO No.': r['SO No.'] || '',
        'SO Date': r['SO Date'] ? new Date(r['SO Date']).toISOString().slice(0, 10) : '',
        'Customer': r['Customer'] || '',
        'Customer PO No.': r['Customer PO No.'] || '',
        'Promise Delivery Date': r['Promise Delivery Date'] ? new Date(r['Promise Delivery Date']).toISOString().slice(0, 10) : '',
        'Revised Promise Delivery Date': r['Revised Promise Delivery Date'] ? new Date(r['Revised Promise Delivery Date']).toISOString().slice(0, 10) : '',
        'MPN': r['MPN'] || '',
        'Make': r['Make'] || '',
        'Unit Price': Number(r['Unit Price'] || 0),
        'PO Qty.': Number(r['PO Qty.'] || 0),
        'UOM': r['UOM'] || '',
        'PO Value': Number(r['PO Value'] || 0),
        'Bal. Qty.': Number(r['Bal. Qty.'] || 0),
        'Bal. Value': Number(r['Bal. Value'] || 0),
        'Remarks': r['Remarks'] || '',
        'Posting No': r['Posting No'] || '',
      }));
      const ws = XLSX.utils.json_to_sheet(out);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'SO Backlog');
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `SO_Backlog_${category}_${stamp}.xlsx`);
    } catch (err) {
      console.error('Export failed', err);
      alert('Export failed: ' + (err.message || err));
    }
  }

  // ── Wire up controls ───────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    // requireAuth() does THREE things we need: (1) gates the page on a logged-in
    // user, (2) calls initTheme() so the day-theme class is applied from
    // localStorage, (3) injects the Day/Night toggle into .topbar-actions.
    // Without this call, the page is stuck in night mode and the toggle is
    // missing — that was the "only Black theme" bug on 2026-06-10.
    const u = (typeof requireAuth === 'function') ? requireAuth() : null;
    if (typeof requireAuth === 'function' && !u) return;
    const rt = document.getElementById('roleTag');
    if (rt && u) rt.textContent = (u.role || '').toUpperCase();

    setDefaultDateRange();
    paintActive();
    $('summaryCards').style.display = '';
    const catCards = $('categoryCards');
    if (catCards) catCards.style.display = '';

    $('soApplyDate').addEventListener('click', () => { page = 1; load(); });
    $('soRefreshBtn').addEventListener('click', () => { load(); });
    $('soExportBtn').addEventListener('click', exportExcel);

    let searchTimer = null;
    $('soSearchInput').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { page = 1; load(); }, 350);
      $('soClearBtn').style.display = $('soSearchInput').value ? '' : 'none';
    });
    $('soClearBtn').addEventListener('click', () => {
      $('soSearchInput').value = '';
      $('soClearBtn').style.display = 'none';
      page = 1; load();
    });

    // Wire all 5 clickable category cards using the data-cat attr
    document.querySelectorAll('.cat-card[data-cat]').forEach(card => {
      card.addEventListener('click', () => switchCategory(card.dataset.cat));
    });

    // Clear All Filters → truly deselects category (lands on 'all' = no filter
    // = show PFP-prefix + In-Transit combined) and resets search/dates.
    const resetAll = $('soResetAllBtn');
    if (resetAll) {
      resetAll.onclick = () => {
        category = 'all';
        sessionStorage.removeItem('whSoCategory');
        $('soSearchInput').value = '';
        $('soClearBtn').style.display = 'none';
        setDefaultDateRange();
        page = 1;
        paintActive();   // no card highlighted in 'all' mode
        load();
      };
    }

    setTimeout(() => {
      if (typeof renderSidebar === 'function') renderSidebar('wh-sobacklog');
    }, 100);

    load();
  });
})();
