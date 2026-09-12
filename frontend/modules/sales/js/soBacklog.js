/* ============================================================
   soBacklog.js  –  Front-end logic for SO Backlog (COMPANYA + CompanyB)
   API endpoint  :  GET /api/sales/sobacklog
   Query params  :  startDate, endDate, search, page, limit
   Excel export  :  Uses SheetJS (xlsx) loaded via CDN
   ============================================================ */

(function () {
  'use strict';

  /* ── State ─────────────────────────────────────────────── */
  let currentPage    = 1;
  let totalRecords   = 0;
  const LIMIT        = 50;
  let searchTimer    = null;
  let currentSearch  = '';
  let currentStart   = '';
  let currentEnd     = '';
  let allExportData  = [];   // holds all rows for Excel export

  /* ── DOM refs ───────────────────────────────────────────── */
  const searchInput   = document.getElementById('soSearchInput');
  const clearBtn      = document.getElementById('soClearBtn');
  const refreshBtn    = document.getElementById('soRefreshBtn');
  const exportBtn     = document.getElementById('soExportBtn');
  const startInput    = document.getElementById('startDateInput');
  const endInput      = document.getElementById('endDateInput');
  const applyDateBtn  = document.getElementById('soApplyDate');
  const loadingEl     = document.getElementById('soLoading');
  const tableWrap     = document.getElementById('soTableWrap');
  const tbody         = document.getElementById('soBody');
  const emptyEl       = document.getElementById('soEmpty');
  const errorEl       = document.getElementById('soError');
  const errorText     = document.getElementById('soErrorText');
  const pagination    = document.getElementById('soPagination');
  const totalText     = document.getElementById('soTotalText');
  const summaryCards  = document.getElementById('summaryCards');

  /* ── Init ───────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    const user = requireAuth();
    if (!user) return;

    renderSidebar('CompanyASOBacklog');
    setRoleTag();

    // Date filter is OPTIONAL — by default show ALL open orders (matches
    // Dashboard's SO Backlog KPI count). Orders placed months/years ago that
    // are still pending delivery would otherwise be hidden by a default month-range.
    // User can apply a date range explicitly if they need to narrow down.
    startInput.value = '';
    endInput.value   = '';
    currentStart     = '';
    currentEnd       = '';

    loadBacklog();

    /* Search – debounced 400 ms */
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        currentSearch = searchInput.value.trim();
        clearBtn.style.display = currentSearch ? 'inline-flex' : 'none';
        currentPage = 1;
        loadBacklog();
      }, 400);
    });

    /* Clear search */
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      currentSearch = '';
      clearBtn.style.display = 'none';
      currentPage = 1;
      loadBacklog();
    });

    /* Apply date range */
    applyDateBtn.addEventListener('click', () => {
      const s = startInput.value;
      const e = endInput.value;
      if (s && e && e < s) {
        alert('End date cannot be earlier than Start date.');
        return;
      }
      // Empty inputs => no date filter (show all open orders)
      currentStart = s;
      currentEnd   = e;
      currentPage  = 1;
      loadBacklog();
    });

    /* Refresh */
    refreshBtn.addEventListener('click', () => {
      currentPage = 1;
      loadBacklog();
    });

    /* Export Excel */
    exportBtn.addEventListener('click', exportToExcel);
  });

  /* ── Data Fetch ─────────────────────────────────────────── */
  async function loadBacklog() {
    showLoading();

    try {
      const params = new URLSearchParams({
        page      : currentPage,
        limit     : LIMIT,
        search    : currentSearch,
        startDate : currentStart,
        endDate   : currentEnd
      });

      const data = await apiRequest(`/sales/sobacklog?${params.toString()}`);

      totalRecords = data.total || 0;
      allExportData = data.data || [];

      renderSummaryCards(data.data || []);
      renderTable(data.data || []);
      renderPagination();
      totalText.textContent = `${fmt(totalRecords)} records`;
      exportBtn.disabled = totalRecords === 0;

    } catch (err) {
      showError(err.message || 'Failed to load SO Backlog');
    }
  }

  /* ── Summary Cards ──────────────────────────────────────── */
  function renderSummaryCards(rows) {
    if (!rows.length) {
      summaryCards.style.display = 'none';
      return;
    }
    let totalLines = totalRecords;
    let balValue = 0, poValue = 0, reserveValue = 0;
    rows.forEach(r => {
      balValue     += Number(r['Bal. Value'])         || 0;
      poValue      += Number(r['PO Value'])           || 0;
      reserveValue += Number(r['Reserve Qty. Value']) || 0;
    });

    document.getElementById('statTotalLines').textContent  = fmt(totalLines);
    document.getElementById('statBalValue').textContent    = fmtCur(balValue);
    document.getElementById('statPoValue').textContent     = fmtCur(poValue);
    document.getElementById('statReserveValue').textContent = fmtCur(reserveValue);
    summaryCards.style.display = '';
  }

  /* ── Render Table ───────────────────────────────────────── */
  function renderTable(rows) {
    hideAll();

    if (!rows.length) {
      emptyEl.style.display = '';
      return;
    }

    tbody.innerHTML = '';
    const start = (currentPage - 1) * LIMIT;

    rows.forEach((r, i) => {
      const tr = document.createElement('tr');

      const makeBadge = r['Make']
        ? `<span class="make-badge">${esc(r['Make'])}</span>`
        : '—';

      tr.innerHTML = `
        <td class="col-freeze">${start + i + 1}</td>
        <td class="td-date">${r['Year'] ?? '—'}</td>
        <td class="td-date">Q${r['Quarter'] ?? '—'}</td>
        <td class="td-date">${esc(r['Month'] ?? '—')}</td>
        <td class="cust-id">${esc(r['Customer ID'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Customer'] ?? '')}">${esc(r['Customer'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Customer PO No.'] ?? '—')}</td>
        <td class="td-date">${fmtD(r['Customer PO Rec. Date'])}</td>
        <td class="td-date">${fmtD(r['Customer PO Date'])}</td>
        <td class="td-date">${fmtD(r['CRD (Customer Require Date)'])}</td>
        <td class="num-cell">${r['CRD Week'] ?? '—'}</td>
        <td class="td-date">${fmtD(r['Promise Delivery Date'])}</td>
        <td class="td-date">${fmtD(r['Revised Promise Delivery Date'])}</td>
        <td class="num-cell">${r['VPD Week'] ?? '—'}</td>
        <td class="td-truncate-sm" title="${esc(r['CPN'] ?? '')}">${esc(r['CPN'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Item Name'] ?? '')}">${esc(r['Item Name'] ?? '—')}</td>
        <td class="td-truncate-sm" title="${esc(r['MPN'] ?? '')}">${esc(r['MPN'] ?? '—')}</td>
        <td>${makeBadge}</td>
        <td class="num-cell num-green">${fmtN(r['Unit Price'], 4)}</td>
        <td class="num-cell">${fmtN(r['PO Qty.'])}</td>
        <td class="num-cell num-green">${fmtN(r['PO Value'], 2)}</td>
        <td class="num-cell num-amber">${fmtN(r['Bal. Qty.'])}</td>
        <td class="num-cell num-amber">${fmtN(r['Bal. Value'], 2)}</td>
       <!-- Purchase Cost column hidden -->
        <td class="num-cell num-purple">${fmtN(r['Reserve Qty.'])}</td>
        <td class="num-cell num-purple">${fmtN(r['Reserve Qty. Value'], 2)}</td>
        <td class="num-cell num-green">${fmtN(r['Item Current Qty On Hand'])}</td>
        <td class="td-truncate-sm">${esc(r['Sales Person'] ?? '—')}</td>
        <td class="so-no">${esc(r['SO No.'] ?? '—')}</td>
        <td class="td-date">${fmtD(r['SO Date'])}</td>
        <td class="td-truncate" title="${esc(r['Remarks'] ?? '')}">${esc(r['Remarks'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Remarks 2'] ?? '')}">${esc(r['Remarks 2'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Remarks 3'] ?? '')}">${esc(r['Remarks 3'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Remarks 4'] ?? '')}">${esc(r['Remarks 4'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Remarks 5'] ?? '')}">${esc(r['Remarks 5'] ?? '—')}</td>
        <td class="td-truncate">${esc(r['Customer Address1'] ?? '—')}</td>
        <td class="td-truncate">${esc(r['Customer Address2'] ?? '—')}</td>
        <td class="td-truncate">${esc(r['Customer Address3'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Customer City'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Customer Phone No.'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Customer Email'] ?? '')}">${esc(r['Customer Email'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Customer Website'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Customer Contact'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Vertical'] ?? '—')}</td>
        <td class="num-cell">${fmtN(r['Qty On PO'])}</td>
        <td>${esc(r['Currency Code'] ?? '—')}</td>
        <td class="td-truncate">${esc(r['Vendor Name'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['User ID'] ?? '—')}</td>
        <td class="td-date">${fmtDT(r['Created Date Time'])}</td>
        <td class="td-truncate-sm">${esc(r['Modified Header User ID'] ?? '—')}</td>
        <td class="td-date">${fmtDT(r['Modified Header Date Time'])}</td>
        <td class="td-truncate-sm">${esc(r['Modified Line User ID'] ?? '—')}</td>
        <td class="td-date">${fmtDT(r['Modified Line Date Time'])}</td>
      `;
      tbody.appendChild(tr);
    });

    tableWrap.style.display = '';
  }

  /* ── Excel Export ───────────────────────────────────────── */
  async function exportToExcel() {
    exportBtn.disabled   = true;
    exportBtn.textContent = '⏳ Fetching…';

    try {
      // Fetch ALL rows (no pagination) for the current filter
      const params = new URLSearchParams({
        page      : 1,
        limit     : 9999,
        search    : currentSearch,
        startDate : currentStart,
        endDate   : currentEnd
      });

      const data = await apiRequest(`/sales/sobacklog?${params.toString()}`);
      const rows = data.data || [];

      if (!rows.length) {
        alert('No data to export.');
        return;
      }

      // Define ordered column headers matching the SP output
      const headers = [
        'Year','Quarter','Month',
        'Customer ID','Customer',
        'Customer PO No.','Customer PO Rec. Date','Customer PO Date',
        'CRD (Customer Require Date)','CRD Week',
        'Promise Delivery Date','Revised Promise Delivery Date','VPD Week',
        'CPN','Item Name','MPN','Make',
        'Unit Price','PO Qty.','PO Value',
        'Bal. Qty.','Bal. Value',
       // 'Purchase Cost',
        'Reserve Qty.','Reserve Qty. Value',
        'Item Current Qty On Hand',
        'Sales Person','SO No.','SO Date',
        'Remarks','Remarks 2','Remarks 3','Remarks 4','Remarks 5',
        'Customer Address1','Customer Address2','Customer Address3','Customer City',
        'Customer Phone No.','Customer Email','Customer Website','Customer Contact',
        'Vertical',
        'Qty On PO','Currency Code','Vendor Name',
        'User ID','Created Date Time',
        'Modified Header User ID','Modified Header Date Time',
        'Modified Line User ID','Modified Line Date Time'
      ];

      // Build worksheet data: header row + data rows
      const wsData = [
        headers,
        ...rows.map(r => headers.map(h => {
          const v = r[h];
          // Keep dates as strings for readability
          if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
          if (typeof v === 'string' && v.includes('T') && v.endsWith('Z')) {
            return v.slice(0, 19).replace('T', ' ');
          }
          return v ?? '';
        }))
      ];

      const ws = XLSX.utils.aoa_to_sheet(wsData);

      // Auto column widths
      const colWidths = headers.map((h, ci) => {
        const maxLen = Math.max(
          h.length,
          ...rows.slice(0, 200).map(r => String(r[h] ?? '').length)
        );
        return { wch: Math.min(maxLen + 2, 40) };
      });
      ws['!cols'] = colWidths;

      // Style header row (bold) — SheetJS Community doesn't support styles,
      // but we freeze the top row for usability
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'SO Backlog');

      const fileName = `COMPANYA_SO_Backlog_${currentStart}_to_${currentEnd}.xlsx`;
      const wbBin = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const blob  = new Blob([wbBin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      nativeSaveAndShare(blob, fileName, { dialogTitle: 'Share SO Backlog' });

    } catch (err) {
      alert('Export failed: ' + (err.message || 'Unknown error'));
    } finally {
      exportBtn.disabled   = false;
      exportBtn.textContent = '⬇ Export Excel';
    }
  }

  /* ── Pagination ─────────────────────────────────────────── */
  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(totalRecords / LIMIT));
    pagination.innerHTML = '';
    if (totalPages <= 1) return;

    pagination.appendChild(pageBtn('‹', currentPage > 1, () => { currentPage--; loadBacklog(); }));

    const range = pageRange(currentPage, totalPages);
    let last = 0;
    range.forEach(p => {
      if (p - last > 1) {
        const el = document.createElement('span');
        el.className = 'page-info'; el.textContent = '…';
        pagination.appendChild(el);
      }
      const btn = pageBtn(p, true, () => { currentPage = p; loadBacklog(); });
      if (p === currentPage) btn.classList.add('active');
      pagination.appendChild(btn);
      last = p;
    });

    pagination.appendChild(pageBtn('›', currentPage < totalPages, () => { currentPage++; loadBacklog(); }));

    const info = document.createElement('span');
    info.className = 'page-info';
    const from = (currentPage - 1) * LIMIT + 1;
    const to   = Math.min(currentPage * LIMIT, totalRecords);
    info.textContent = `${fmt(from)}–${fmt(to)} of ${fmt(totalRecords)}`;
    pagination.appendChild(info);
  }

  function pageRange(cur, total) {
    const d = 2, pages = [];
    for (let p = Math.max(1, cur - d); p <= Math.min(total, cur + d); p++) pages.push(p);
    if (!pages.includes(1))     pages.unshift(1);
    if (!pages.includes(total)) pages.push(total);
    return pages;
  }

  function pageBtn(label, enabled, onClick) {
    const b = document.createElement('button');
    b.className = 'page-btn'; b.textContent = label; b.disabled = !enabled;
    if (enabled) b.addEventListener('click', onClick);
    return b;
  }

  /* ── State helpers ──────────────────────────────────────── */
  function showLoading() {
    loadingEl.style.display  = '';
    tableWrap.style.display  = 'none';
    emptyEl.style.display    = 'none';
    errorEl.style.display    = 'none';
    pagination.innerHTML     = '';
  }

  function hideAll() {
    loadingEl.style.display = 'none';
    tableWrap.style.display = 'none';
    emptyEl.style.display   = 'none';
    errorEl.style.display   = 'none';
  }

  function showError(msg) {
    hideAll();
    errorText.textContent = msg || 'Failed to load SO Backlog.';
    errorEl.style.display = '';
  }

  /* ── Formatters ─────────────────────────────────────────── */
  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtN(val, dec = 0) {
    if (val == null || val === '') return '—';
    const n = Number(val);
    if (isNaN(n)) return '—';
    return new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec
    }).format(n);
  }

  function fmtD(val) {
    if (!val) return '—';
    try {
      const d = new Date(val);
      if (isNaN(d)) return String(val).slice(0, 10);
      return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    } catch { return '—'; }
  }

  function fmtDT(val) {
    if (!val) return '—';
    try {
      const d = new Date(val);
      if (isNaN(d)) return String(val).slice(0, 16);
      return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
        + ' ' + d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
    } catch { return '—'; }
  }

})();