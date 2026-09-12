/* ============================================================
   inventory.js  –  Front-end logic for Inventory (COMPANYA + CompanyB)
   API endpoint  :  GET /api/sales/inventory
   Query params  :  mode, search, asOnDate, page, limit
   ============================================================ */

(function () {
  'use strict';

  /* ── State ─────────────────────────────────────────────── */
  let currentPage   = 1;
  let totalItems    = 0;
  const LIMIT       = 50;
  let searchTimer   = null;
  let currentSearch = '';
  let currentAsOn   = '';
  let currentMode   = 'total';
  let allRows       = [];          // last fetched page (used for reference)

  /* ── DOM refs ───────────────────────────────────────────── */
  const searchInput = document.getElementById('invSearchInput');
  const clearBtn    = document.getElementById('invClearBtn');
  const refreshBtn  = document.getElementById('invRefreshBtn');
  const asOnInput   = document.getElementById('asOnDateInput');
  const loadingEl   = document.getElementById('invLoading');
  const tableWrap   = document.getElementById('invTableWrap');
  const invTable    = document.getElementById('invTable');
  const thead       = document.getElementById('invThead');
  const tbody       = document.getElementById('invBody');
  const emptyEl     = document.getElementById('invEmpty');
  const errorEl     = document.getElementById('invError');
  const errorText   = document.getElementById('invErrorText');
  const pagination  = document.getElementById('invPagination');
  const totalText   = document.getElementById('invTotalText');
  const modeTabs    = document.getElementById('invModeTabs');

  /* ── Init ───────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    var user = requireAuth();
    if (!user) return;

    renderSidebar('CompanyAInventory');
    setRoleTag();

    var today = new Date().toISOString().slice(0, 10);
    asOnInput.value = today;
    currentAsOn     = today;

    // Inject Export button next to Refresh
    var exportBtn = document.createElement('button');
    exportBtn.id        = 'invExportBtn';
    exportBtn.className = 'btn btn-ghost btn-sm';
    exportBtn.innerHTML = '↓ Excel';
    exportBtn.addEventListener('click', exportToExcel);
    refreshBtn.parentNode.insertBefore(exportBtn, refreshBtn.nextSibling);

    loadInventory();

    modeTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.filter-tab');
      if (!tab || !tab.dataset.mode) return;
      modeTabs.querySelectorAll('.filter-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      currentMode   = tab.dataset.mode;
      currentPage   = 1;
      currentSearch = '';
      searchInput.value = '';
      clearBtn.style.display = 'none';
      updateThead();
      loadInventory();
    });

    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        currentSearch = searchInput.value.trim();
        clearBtn.style.display = currentSearch ? 'inline-flex' : 'none';
        currentPage = 1;
        loadInventory();
      }, 350);
    });

    clearBtn.addEventListener('click', function () {
      searchInput.value = '';
      currentSearch     = '';
      clearBtn.style.display = 'none';
      currentPage = 1;
      loadInventory();
    });

    refreshBtn.addEventListener('click', function () {
      currentPage = 1;
      loadInventory();
    });

    asOnInput.addEventListener('change', function () {
      currentAsOn = asOnInput.value;
      currentPage = 1;
      loadInventory();
    });
  });

  /* ── Update table headers based on mode ─────────────────── */
  function updateThead() {
    if (currentMode === 'soInventory') {
      invTable.classList.add('so-table');
      thead.innerHTML = '<tr>' +
        '<th>#</th><th>Salesperson</th><th>Item No.</th><th>Vendor Item No.</th><th>Make</th>' +
        '<th>Item Description</th><th>SO No.</th>' +
        '<th style="text-align:right;">Quantity</th><th style="text-align:right;">Unit Value</th>' +
        '<th style="text-align:right;">Total Value</th><th>Remarks</th></tr>';
    } else {
      invTable.classList.remove('so-table');
      thead.innerHTML = '<tr>' +
        '<th>#</th><th>Item No.</th><th>Vendor Item No.</th><th>Make</th>' +
        '<th>Item Description</th><th style="text-align:right;">Quantity</th><th>Remarks</th></tr>';
    }
  }

  /* ── Data Fetch ─────────────────────────────────────────── */
  async function loadInventory() {
    showLoading();
    try {
      var params = new URLSearchParams({
        mode: currentMode, page: currentPage, limit: LIMIT,
        search: currentSearch, asOnDate: currentAsOn
      });
      var data = await apiRequest('/sales/inventory?' + params.toString());
      totalItems = data.total || 0;
      allRows = data.data || [];
      renderTable(allRows);
      renderPagination();
      totalText.textContent = fmt(totalItems) + ' items';
    } catch (err) {
      showError(err.message || 'Failed to load inventory');
    }
  }

  /* ── Render table rows ──────────────────────────────────── */
  function renderTable(rows) {
    hideAll();
    if (!rows.length) { emptyEl.style.display = ''; return; }
    tbody.innerHTML = '';
    var start = (currentPage - 1) * LIMIT;
    if (currentMode === 'soInventory') {
      invTable.classList.add('so-table');
      renderSORows(rows, start);
    } else {
      invTable.classList.remove('so-table');
      renderTotalRows(rows, start);
    }
    tableWrap.style.display = '';
  }

  function renderTotalRows(rows, start) {
    rows.forEach(function (row, i) {
      var tr = document.createElement('tr');
      var make = row.Make ? row.Make.trim() : '';
      var makeBadge = make
        ? '<span class="make-badge">' + escHtml(make) + '</span>'
        : '<span style="color:var(--text3)">—</span>';
      var qty = row.Quantity != null ? fmt(Number(row.Quantity), 0) : '—';
      tr.innerHTML =
        '<td class="col-row">' + (start + i + 1) + '</td>' +
        '<td class="col-item">' + escHtml(row['Item No.'] || '—') + '</td>' +
        '<td class="col-vendor">' + escHtml(row['Vendor Item No.'] || '—') + '</td>' +
        '<td>' + makeBadge + '</td>' +
        '<td class="col-desc" title="' + escHtml(row['Item Description'] || '') + '">' + escHtml(row['Item Description'] || '—') + '</td>' +
        '<td class="col-qty">' + qty + '</td>' +
        '<td class="col-remarks" title="' + escHtml(row['Remarks 1'] || '') + '">' + escHtml(row['Remarks 1'] || '—') + '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderSORows(rows, start) {
    rows.forEach(function (row, i) {
      var tr = document.createElement('tr');
      var make = row.Make ? row.Make.trim() : '';
      var makeBadge = make
        ? '<span class="make-badge">' + escHtml(make) + '</span>'
        : '<span style="color:var(--text3)">—</span>';
      var qty      = row.Quantity != null       ? fmt(Number(row.Quantity), 0) : '—';
      var unitVal  = row['Unit Value'] != null  ? fmtCur(Number(row['Unit Value'])) : '—';
      var totalVal = row['Total Value'] != null ? fmtCur(Number(row['Total Value'])) : '—';
      tr.innerHTML =
        '<td class="col-row">' + (start + i + 1) + '</td>' +
        '<td><span class="badge badge-blue">' + escHtml(row['Salesperson Code'] || '—') + '</span></td>' +
        '<td class="col-item">' + escHtml(row['Item No.'] || '—') + '</td>' +
        '<td class="col-vendor">' + escHtml(row['Vendor Item No.'] || '—') + '</td>' +
        '<td>' + makeBadge + '</td>' +
        '<td class="col-desc" title="' + escHtml(row['Item Description'] || '') + '">' + escHtml(row['Item Description'] || '—') + '</td>' +
        '<td class="col-sono">' + escHtml(row['SO No.'] || '—') + '</td>' +
        '<td class="col-qty">' + qty + '</td>' +
        '<td class="col-val">' + unitVal + '</td>' +
        '<td class="col-val" style="font-weight:600;color:var(--text);">' + totalVal + '</td>' +
        '<td class="col-remarks" title="' + escHtml(row['Remarks 1'] || '') + '">' + escHtml(row['Remarks 1'] || '—') + '</td>';
      tbody.appendChild(tr);
    });
  }

  /* ── Excel Export ───────────────────────────────────────── */
  async function exportToExcel() {
    if (typeof XLSX === 'undefined') {
      alert('Excel library not loaded. Please refresh and try again.');
      return;
    }

    var btn = document.getElementById('invExportBtn');
    btn.disabled = true;
    btn.innerHTML = '⏳ Exporting…';

    try {
      // Fetch ALL rows (no pagination) for current mode/search/date
      var params = new URLSearchParams({
        mode: currentMode, page: 1, limit: 99999,
        search: currentSearch, asOnDate: currentAsOn
      });
      var data = await apiRequest('/sales/inventory?' + params.toString());
      var rows = data.data || [];

      if (!rows.length) {
        alert('No data to export.');
        return;
      }

      var wsData = [];
      var modeLabel = currentMode === 'soInventory' ? 'Inventory As per SO'
                    : currentMode === 'openInventory' ? 'Open Inventory'
                    : 'Total Inventory';

      if (currentMode === 'soInventory') {
        wsData.push(['#', 'Salesperson Code', 'Item No.', 'Vendor Item No.', 'Make',
                      'Item Description', 'SO No.', 'Quantity', 'Unit Value (₹)', 'Total Value (₹)', 'Remarks']);
        rows.forEach(function (r, i) {
          wsData.push([
            i + 1,
            r['Salesperson Code'] || '',
            r['Item No.'] || '',
            r['Vendor Item No.'] || '',
            r.Make || '',
            r['Item Description'] || '',
            r['SO No.'] || '',
            r.Quantity != null ? Number(r.Quantity) : '',
            r['Unit Value'] != null ? Number(r['Unit Value']) : '',
            r['Total Value'] != null ? Number(r['Total Value']) : '',
            r['Remarks 1'] || ''
          ]);
        });
      } else {
        wsData.push(['#', 'Item No.', 'Vendor Item No.', 'Make',
                      'Item Description', 'Quantity', 'Remarks']);
        rows.forEach(function (r, i) {
          wsData.push([
            i + 1,
            r['Item No.'] || '',
            r['Vendor Item No.'] || '',
            r.Make || '',
            r['Item Description'] || '',
            r.Quantity != null ? Number(r.Quantity) : '',
            r['Remarks 1'] || ''
          ]);
        });
      }

      var wb = XLSX.utils.book_new();
      var ws = XLSX.utils.aoa_to_sheet(wsData);

      // Auto-width columns
      var colWidths = wsData[0].map(function (_, ci) {
        var max = 10;
        wsData.forEach(function (row) {
          var len = String(row[ci] || '').length;
          if (len > max) max = len;
        });
        return { wch: Math.min(max + 2, 40) };
      });
      ws['!cols'] = colWidths;

      XLSX.utils.book_append_sheet(wb, ws, modeLabel);

      var fileName = 'COMPANYA_' + modeLabel.replace(/\s+/g, '_') + '_' + (currentAsOn || 'today') + '.xlsx';
      var wbBin = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      var blob  = new Blob([wbBin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      nativeSaveAndShare(blob, fileName, { dialogTitle: 'Share ' + modeLabel });

    } catch (err) {
      alert('Export failed: ' + (err.message || 'Unknown error'));
    } finally {
      btn.disabled = false;
      btn.innerHTML = '↓ Excel';
    }
  }

  /* ── Pagination ─────────────────────────────────────────── */
  function renderPagination() {
    var totalPages = Math.max(1, Math.ceil(totalItems / LIMIT));
    pagination.innerHTML = '';
    if (totalPages <= 1) return;
    pagination.appendChild(pageBtn('‹', currentPage > 1, function () { currentPage--; loadInventory(); }));
    var range = pageRange(currentPage, totalPages);
    var lastPage = 0;
    range.forEach(function (p) {
      if (p - lastPage > 1) {
        var el = document.createElement('span');
        el.className = 'page-info'; el.textContent = '…';
        pagination.appendChild(el);
      }
      var btn = pageBtn(p, true, function () { currentPage = p; loadInventory(); });
      if (p === currentPage) btn.classList.add('active');
      pagination.appendChild(btn);
      lastPage = p;
    });
    pagination.appendChild(pageBtn('›', currentPage < totalPages, function () { currentPage++; loadInventory(); }));
    var info = document.createElement('span');
    info.className = 'page-info';
    var from = (currentPage - 1) * LIMIT + 1;
    var to   = Math.min(currentPage * LIMIT, totalItems);
    info.textContent = fmt(from) + '–' + fmt(to) + ' of ' + fmt(totalItems);
    pagination.appendChild(info);
  }

  function pageRange(current, total) {
    var delta = 2, pages = [];
    for (var p = Math.max(1, current - delta); p <= Math.min(total, current + delta); p++) pages.push(p);
    if (pages.indexOf(1) === -1) pages.unshift(1);
    if (pages.indexOf(total) === -1) pages.push(total);
    return pages;
  }

  function pageBtn(label, enabled, onClick) {
    var btn = document.createElement('button');
    btn.className = 'page-btn'; btn.textContent = label; btn.disabled = !enabled;
    if (enabled) btn.addEventListener('click', onClick);
    return btn;
  }

  /* ── State helpers ──────────────────────────────────────── */
  function showLoading() {
    loadingEl.style.display = ''; tableWrap.style.display = 'none';
    emptyEl.style.display = 'none'; errorEl.style.display = 'none';
    pagination.innerHTML = '';
  }
  function hideAll() {
    loadingEl.style.display = 'none'; tableWrap.style.display = 'none';
    emptyEl.style.display = 'none'; errorEl.style.display = 'none';
  }
  function showError(msg) {
    hideAll(); errorText.textContent = msg || 'Failed to load inventory.';
    errorEl.style.display = '';
  }
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();