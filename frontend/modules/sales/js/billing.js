/* ============================================================
   billing.js  –  Front-end logic for Billing Report (COMPANYA + CompanyB)
   API endpoint  :  GET /api/sales/billing
   Query params  :  fromDate, toDate, search, page, limit
   Excel export  :  SheetJS CDN
   ============================================================ */

(function () {
  'use strict';

  /* ── State ─────────────────────────────────────────────── */
  let currentPage   = 1;
  let totalRecords  = 0;
  const LIMIT       = 50;
  let searchTimer   = null;
  let currentSearch = '';
  let currentFrom   = '';
  let currentTo     = '';
  let currentUser   = null;   // set on DOMContentLoaded

  /* ── DOM refs ───────────────────────────────────────────── */
  const searchInput  = document.getElementById('bilSearchInput');
  const clearBtn     = document.getElementById('bilClearBtn');
  const refreshBtn   = document.getElementById('bilRefreshBtn');
  const exportBtn    = document.getElementById('bilExportBtn');
  const fromInput    = document.getElementById('fromDateInput');
  const toInput      = document.getElementById('toDateInput');
  const applyBtn     = document.getElementById('bilApplyDate');
  const loadingEl    = document.getElementById('bilLoading');
  const tableWrap    = document.getElementById('bilTableWrap');
  const tbody        = document.getElementById('bilBody');
  const emptyEl      = document.getElementById('bilEmpty');
  const errorEl      = document.getElementById('bilError');
  const errorText    = document.getElementById('bilErrorText');
  const pagination   = document.getElementById('bilPagination');
  const totalText    = document.getElementById('bilTotalText');
  const summaryCards = document.getElementById('summaryCards');

  /* ── Init ───────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    currentUser = requireAuth();
    if (!currentUser) return;

    renderSidebar('CompanyABilling');
    setRoleTag();

    const today        = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    const todayStr     = today.toISOString().slice(0, 10);

    fromInput.value = firstOfMonth;
    toInput.value   = todayStr;
    currentFrom     = firstOfMonth;
    currentTo       = todayStr;

    loadBilling();

    /* Search – debounced 400ms */
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        currentSearch = searchInput.value.trim();
        clearBtn.style.display = currentSearch ? 'inline-flex' : 'none';
        currentPage = 1;
        loadBilling();
      }, 400);
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      currentSearch = '';
      clearBtn.style.display = 'none';
      currentPage = 1;
      loadBilling();
    });

    applyBtn.addEventListener('click', () => {
      const f = fromInput.value;
      const t = toInput.value;
      if (f && t && t < f) { alert('To date cannot be earlier than From date.'); return; }
      currentFrom = f || currentFrom;
      currentTo   = t || currentTo;
      currentPage = 1;
      loadBilling();
    });

    refreshBtn.addEventListener('click', () => { currentPage = 1; loadBilling(); });
    exportBtn.addEventListener('click', exportToExcel);
  });

  /* ── Fetch ──────────────────────────────────────────────── */
  async function loadBilling() {
    showLoading();
    try {
      const params = new URLSearchParams({
        page    : currentPage,
        limit   : LIMIT,
        search  : currentSearch,
        fromDate: currentFrom,
        toDate  : currentTo
      });

      const data = await apiRequest(`/sales/billing?${params.toString()}`);
      totalRecords = data.total || 0;

      renderSummaryCards(data.data || [], data.totals);
      renderTable(data.data || []);
      renderPagination();
      totalText.textContent  = `${fmt(totalRecords)} records`;
      exportBtn.disabled     = totalRecords === 0;

    } catch (err) {
      showError(err.message || 'Failed to load billing data');
    }
  }

  /* ── Summary Cards ──────────────────────────────────────── */
  // Reads aggregate totals from the response (computed via SUM() OVER () in
  // the backend SQL — they reflect ALL filtered rows, not just the current
  // page). Falls back to summing the current page if `totals` isn't present
  // (older backend response shape).
  function renderSummaryCards(rows, totals) {
    if (!rows.length) { summaryCards.style.display = 'none'; return; }

    let extnResale, unitCost, chargeAmt;
    if (totals && (totals.ExtnResale !== undefined || totals.UnitCost !== undefined)) {
      extnResale = Number(totals.ExtnResale)   || 0;
      unitCost   = Number(totals.UnitCost)     || 0;
      chargeAmt  = Number(totals.ChargeAmount) || 0;
    } else {
      extnResale = 0; unitCost = 0; chargeAmt = 0;
      rows.forEach(r => {
        extnResale += Number(r['Extn Resale'])    || 0;
        unitCost   += Number(r['Unit Cost'])      || 0;
        chargeAmt  += Number(r['Charge Amount'])  || 0;
      });
    }

    document.getElementById('statTotalLines').textContent  = fmt(totalRecords);
    document.getElementById('statExtnResale').textContent  = fmtCur(extnResale);
    const isAdmin = ['admin','operation head','director'].includes((currentUser?.role||'').toLowerCase().trim());
    document.getElementById('statUnitCost').textContent    = isAdmin ? fmtCur(unitCost) : '—';
    document.getElementById('statChargeAmt').textContent   = fmtCur(chargeAmt);
    summaryCards.style.display = '';
  }

  /* ── Render Table ───────────────────────────────────────── */
  function renderTable(rows) {
    hideAll();
    if (!rows.length) { emptyEl.style.display = ''; return; }

    const isAdmin = ['admin','operation head','director'].includes((currentUser?.role||'').toLowerCase().trim());
    tbody.innerHTML = '';
    const start = (currentPage - 1) * LIMIT;

    rows.forEach((r, i) => {
      const tr = document.createElement('tr');

      const makeBadge = r['Make']
        ? `<span class="make-badge">${esc(r['Make'])}</span>` : '—';

      tr.innerHTML = `
        <td class="col-freeze">${start + i + 1}</td>
        <td class="td-date">${r['Year'] ?? '—'}</td>
        <td class="td-date">${esc(r['Quarter'] ?? '—')}</td>
        <td class="td-date">${esc(r['Month'] ?? '—')}</td>
        <td class="td-date">${fmtD(r['Invoice Date'])}</td>
        <td class="td-date">${fmtD(r['CRD (Customer Require Date)'])}</td>
        <td class="td-date">${fmtD(r['Promise Delivery Date'])}</td>
        <td class="td-date">${fmtD(r['Revised Promise Delivery Date'])}</td>
        <td class="td-date">${fmtD(r['Inword Date (DPK Purchase)'])}</td>
        <td class="${dayClass(r['Store to dispatch'])}">${r['Store to dispatch'] ?? '—'}</td>
        <td class="${dayClass(r['Total Time'])}">${r['Total Time'] ?? '—'}</td>
        <td class="${dayClass(r['Vendor Commi. Gap'])}">${r['Vendor Commi. Gap'] ?? '—'}</td>
        <td class="${dayClass(r['Purchase Response Time'])}">${r['Purchase Response Time'] ?? '—'}</td>
        <td class="inv-no">${
          r['Invoice No.']
            ? `<a href="javascript:void(0)" onclick="downloadInvoicePdf('${esc(r['Invoice No.'])}')" title="Download Tax Invoice PDF" style="color:var(--accent);text-decoration:none;">${esc(r['Invoice No.'])} <span style="opacity:.8;">📄</span></a>`
            : '—'
        }</td>
        <td class="td-truncate-sm">${esc(r['Country'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Region'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Branch'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['FSR'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Customer Name'] ?? '')}">${esc(r['Customer Name'] ?? '—')}</td>
        <td class="cust-id">${esc(r['Customer'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Vertical'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Segment'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Sub Segment'] ?? '—')}</td>
        <td>${esc(r['Currency'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Customer PO No.'] ?? '—')}</td>
        <td class="td-date">${fmtD(r['Customer PO Date'])}</td>
        <td class="so-ref">${esc(r['SO No.'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Air Waybill No./Docket no.'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Dispatch Through'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Company'] ?? '—')}</td>
        <td class="td-truncate-sm" title="${esc(r['Customer Part No.'] ?? '')}">${esc(r['Customer Part No.'] ?? '—')}</td>
        <td class="td-truncate-sm" title="${esc(r['MPN'] ?? '')}">${esc(r['MPN'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Description'] ?? '')}">${esc(r['Description'] ?? '—')}</td>
        <td>${makeBadge}</td>
        <td class="num-cell num-green">${fmtN(r['Ship Quantity'], 0)}</td>
        <td class="num-cell num-green">${fmtN(r['Unit Resale'], 4)}</td>
        <td class="num-cell num-green">${fmtN(r['Extn Resale'], 2)}</td>
        <td class="num-cell num-amber">${fmtN(r['Charge Amount'], 2)}</td>
        <td class="num-cell num-purple">${isAdmin ? fmtN(r['Unit Cost'], 4) : '—'}</td>
        <td class="td-truncate-sm">${esc(r['Basic Unit'] ?? '—')}</td>
        <td class="td-truncate" title="${esc(r['Remarks'] ?? '')}">${esc(r['Remarks'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Inventory Posting Group'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['IRN No.'] ?? '—')}</td>
        <td class="td-truncate-sm">${esc(r['Customer GSTN No.'] ?? '—')}</td>
        <td class="td-date">${fmtDT(r['Posted Invoice by CSR Date & Time'])}</td>
        <td class="td-truncate-sm">${esc(r['Posted Invoice by CSR Name'] ?? '—')}</td>
      `;
      tbody.appendChild(tr);
    });

    tableWrap.style.display = '';
  }

  /* ── Excel Export ───────────────────────────────────────── */
  async function exportToExcel() {
    exportBtn.disabled    = true;
    exportBtn.textContent = '⏳ Fetching…';

    try {
      const params = new URLSearchParams({
        page: 1, limit: 9999,
        search: currentSearch,
        fromDate: currentFrom, toDate: currentTo
      });
      const data = await apiRequest(`/sales/billing?${params.toString()}`);
      const rows = data.data || [];

      if (!rows.length) { alert('No data to export.'); return; }

      const isAdmin = ['admin','operation head','director'].includes((currentUser?.role||'').toLowerCase().trim());
      const allHeaders = [
        'Year','Quarter','Month','Invoice Date',
        'CRD (Customer Require Date)','Promise Delivery Date','Revised Promise Delivery Date',
        'Inword Date (DPK Purchase)','Store to dispatch','Total Time','Vendor Commi. Gap','Purchase Response Time',
        'Invoice No.','Country','Region','Branch','FSR','Customer Name','Customer',
        'Vertical','Segment','Sub Segment','Currency',
        'Customer PO No.','Customer PO Date','SO No.',
        'Air Waybill No./Docket no.','Dispatch Through','Company',
        'Customer Part No.','MPN','Description','Make',
        'Ship Quantity','Unit Resale','Extn Resale','Charge Amount','Unit Cost',
        'Basic Unit','Remarks','Inventory Posting Group','IRN No.',
        'Customer GSTN No.','Posted Invoice by CSR Date & Time','Posted Invoice by CSR Name'
      ];
      const headers = isAdmin ? allHeaders : allHeaders.filter(h => h !== 'Unit Cost');

      const wsData = [
        headers,
        ...rows.map(r => headers.map(h => {
          const v = r[h];
          if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
          if (typeof v === 'string' && v.includes('T') && v.endsWith('Z'))
            return v.slice(0, 19).replace('T', ' ');
          return v ?? '';
        }))
      ];

      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols']   = headers.map(h => ({
        wch: Math.min(Math.max(h.length, ...rows.slice(0,200).map(r => String(r[h]??'').length)) + 2, 40)
      }));
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Billing Report');
      // Use binary write + nativeSaveAndShare so this works inside the
      // Capacitor APK (which can't trigger <a download>).
      const filename = `COMPANYA_Billing_${currentFrom}_to_${currentTo}.xlsx`;
      const wbBin = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const blob  = new Blob([wbBin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      nativeSaveAndShare(blob, filename, { dialogTitle: 'Share Billing Report' });

    } catch (err) {
      alert('Export failed: ' + (err.message || 'Unknown error'));
    } finally {
      exportBtn.disabled    = false;
      exportBtn.textContent = '⬇ Export Excel';
    }
  }

  /* ── Pagination ─────────────────────────────────────────── */
  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(totalRecords / LIMIT));
    pagination.innerHTML = '';
    if (totalPages <= 1) return;

    pagination.appendChild(pageBtn('‹', currentPage > 1, () => { currentPage--; loadBilling(); }));

    const range = pageRange(currentPage, totalPages);
    let last = 0;
    range.forEach(p => {
      if (p - last > 1) {
        const el = document.createElement('span');
        el.className = 'page-info'; el.textContent = '…';
        pagination.appendChild(el);
      }
      const b = pageBtn(p, true, () => { currentPage = p; loadBilling(); });
      if (p === currentPage) b.classList.add('active');
      pagination.appendChild(b);
      last = p;
    });

    pagination.appendChild(pageBtn('›', currentPage < totalPages, () => { currentPage++; loadBilling(); }));

    const info = document.createElement('span');
    info.className   = 'page-info';
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
    loadingEl.style.display = '';
    tableWrap.style.display = 'none';
    emptyEl.style.display   = 'none';
    errorEl.style.display   = 'none';
    pagination.innerHTML    = '';
  }

  function hideAll() {
    loadingEl.style.display = 'none';
    tableWrap.style.display = 'none';
    emptyEl.style.display   = 'none';
    errorEl.style.display   = 'none';
  }

  function showError(msg) {
    hideAll();
    errorText.textContent = msg || 'Failed to load billing data.';
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
      minimumFractionDigits: dec, maximumFractionDigits: dec
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

  function dayClass(val) {
    if (val == null) return 'td-date';
    const n = Number(val);
    if (n > 0)  return 'days-positive num-cell';
    if (n < 0)  return 'days-negative num-cell';
    return 'days-zero num-cell';
  }

})();