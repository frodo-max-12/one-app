// frontend/js/customers.js  —  COMPANYA Customers with full modal ledger + pdf export
(function () {
'use strict';

const user = requireAuth();
if (!user) return;
renderSidebar('customers');
setRoleTag();

let currentPage   = 1;
let currentSearch = '';
const LIMIT       = 15;
let totalCount    = 0;
let searchTimer;

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadCustomers();

  document.getElementById('customerSearchInput').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = e.target.value.trim();
      currentPage = 1;
      loadCustomers();
    }, 400);
  });

  document.getElementById('customerRefreshBtn').addEventListener('click', () => {
    currentPage = 1;
    loadCustomers();
  });

  // Close modal on backdrop click
  document.getElementById('custModalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('custModalOverlay')) closeModal();
  });

  document.getElementById('custModalClose').addEventListener('click', closeModal);
  document.getElementById('custExportBtn').addEventListener('click', exportLedgerExcel);
  document.getElementById('custExportPdfBtn').addEventListener('click', exportLedgerPDF);

  // Bulk "Import CN" on the Customer List page — only for CN roles (admin /
  // electrical head / sales head electrical). Imports the whole sheet at once and
  // assigns each CN to its customer by name (no need to open customers one by one).
  const importCnBtn = document.getElementById('customerImportCnBtn');
  if (importCnBtn && isCnUser()) importCnBtn.style.display = '';
});

// ── Load List ─────────────────────────────────────────────────────────────────
async function loadCustomers() {
  const loading = document.getElementById('customersLoading');
  const table   = document.getElementById('customersTable');
  const empty   = document.getElementById('customersEmpty');

  loading.style.display = 'flex';
  table.style.display   = 'none';
  empty.style.display   = 'none';

  try {
    const res = await apiRequest('/sales/customers?' + new URLSearchParams({
      search: currentSearch, page: currentPage, limit: LIMIT
    }));
    totalCount = res.total || 0;
    document.getElementById('customerTotalText').textContent = fmt(totalCount) + ' total';
    renderTable(res.data || []);
    renderPagination();
  } catch (err) {
    empty.style.display = 'block';
    console.error('Customers error:', err);
  } finally {
    loading.style.display = 'none';
  }
}

// ── Render Table ──────────────────────────────────────────────────────────────
function renderTable(rows) {
  const tbody = document.getElementById('customersBody');
  const table = document.getElementById('customersTable');
  const empty = document.getElementById('customersEmpty');

  if (!rows.length) {
    table.style.display = 'none';
    empty.style.display = 'block';
    tbody.innerHTML = '';
    return;
  }

  table.style.display = 'table';
  empty.style.display = 'none';

  tbody.innerHTML = rows.map(c => `
    <tr onclick="openCustomerModal('${escAttr(c.CustomerNo)}')" style="cursor:pointer;">
      <td class="td-mono" style="color:var(--accent);">${esc(c.CustomerNo)}</td>
      <td>
        <div class="td-bold">${esc(c.Name || '')}</div>
        <div style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap;align-items:center;">
          ${c.Phone ? `<span style="font-size:11px;color:var(--text3);">${esc(c.Phone)}</span>` : ''}
          ${c.Salesperson ? `<span style="font-size:10px;background:var(--badge-blue-bg);color:var(--badge-blue-text);padding:1px 6px;border-radius:4px;">${esc(c.Salesperson)}</span>` : ''}
        </div>
      </td>
      <td>${esc(c.City || '—')}${c.State ? ` <span style="color:var(--text3);font-size:11px;">· ${esc(c.State)}</span>` : ''}</td>
      <td style="text-align:right;font-family:var(--mono);color:${(c.BalanceDue||0)>0?'var(--red)':'var(--green)'};">${fmtCur(c.BalanceDue)}</td>
      <td style="text-align:right;" class="td-mono">${fmtCur(c.TotalAR)}</td>
      <td class="td-mono">${esc(c.PaymentTerms || '—')}</td>
    </tr>
  `).join('');
}

// ── Open Modal ────────────────────────────────────────────────────────────────
let modalLedgerRows     = []; // full ledger from API
let modalCustomer       = null;
let modalCustomerPdcs   = []; // this customer's PDCs (for netting + the PDC tab)
let modalCustomerCNs    = []; // this customer's imported "Yet to Approve" credit notes (BN_CreditNote)
let currentLedgerFilter = 'open'; // 'open' | 'all' | 'pdc' | 'cn' — applies to on-screen + exports

// CN access — mirrors backend CN_ROLES: Admin + Electrical Head (a colleague Porwal) +
// Sales Head Electrical (the retail account). ONLY these roles see the CN tab, the
// netting, and the Import/Export/Delete controls. Everyone else has no CN at all.
function isCnUser() {
  const role = (user.role || '').toLowerCase().trim();
  return role === 'admin' || role === 'electrical head' || role === 'sales head electrical';
}
// Σ of this customer's imported CN (Yet to Approve) — nets down Remaining Outstanding.
function cnYetToApproveTotal() {
  return (modalCustomerCNs || []).reduce((s, x) => s + (Number(x.Amount) || 0), 0);
}
// Σ of NAV-posted credit memos already in the ledger ("Approved CN"). SalesLCY is
// negative for a credit memo; shown as a positive figure. Already inside NAV outstanding.
function approvedCnTotal(ledger) {
  return (ledger || [])
    .filter(r => String(r.DocType || '').toLowerCase() === 'credit memo')
    .reduce((s, r) => s + Math.abs(Number(r.SalesLCY) || 0), 0);
}

// Returns the rows currently shown by the active tab (Open or All).
// "All" also includes held-PDC pseudo-rows (undeposited cheques in hand).
function getFilteredLedgerRows() {
  if (currentLedgerFilter === 'open') return modalLedgerRows.filter(r => r.IsOpen);
  if (currentLedgerFilter === 'all') {
    return modalLedgerRows.concat(pdcAsLedgerRows())
      .sort((a, b) => new Date(a.PostingDate || 0) - new Date(b.PostingDate || 0));
  }
  return modalLedgerRows;
}

// ── PDC netting — "cheque in hand" reduces the customer's effective outstanding ──
// Only Status = Not Deposited counts (user decision 2026-07-28): Cleared/Deposited are already
// posted in NAV; Bounced/Cancelled are dead. These cheques net down Total Outstanding AND appear
// as PDC rows in the All ledger.
function getHeldPdcs() {
  return (modalCustomerPdcs || []).filter(p => normalizePdcStatus(p.Status) === 'not_deposited');
}
function heldPdcTotal() {
  return getHeldPdcs().reduce((s, p) => s + (Number(p.Amount) || 0), 0);
}
// Map each held PDC to the ledger-row shape (negative amount, like a payment-in-hand).
// Bill No → Ext Doc No links the cheque to its invoice; blank Bill No still nets the total.
function pdcAsLedgerRows() {
  return getHeldPdcs().map(p => ({
    EntryNo:     'PDC-' + p.PDCId,
    DocType:     'PDC',
    DocNo:       p.ChequeNo || '—',
    ExtDocNo:    p.BillNo || '',
    Description: 'PDC cheque in hand (Not Deposited)' + (p.BankName ? ' · ' + p.BankName : ''),
    PostingDate: p.ChequeDate,
    DueDate:     null,
    SalesLCY:    -(Number(p.Amount) || 0),
    Outstanding: 0,
    IsOpen:      false,
    _isPdc:      true,
    _pdcStatus:  p.Status,
  }));
}

// PDF-safe number formatter (no ₹ symbol — jsPDF default font lacks the glyph)
function fmtNumPDF(n) {
  if (n == null) return '0.00';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n);
}

// Company legal name + currency code for exports (PDF header + column labels).
// Mirrors fmtCur's mapping: getCompany()==='COMPANYB' → CompanyB / USD, else COMPANYA / INR.
function exportCoInfo() {
  const isCompanyB = (typeof getCompany === 'function') && getCompany() === 'COMPANYB';
  return {
    name: isCompanyB ? 'Company B International Pte Ltd' : 'Company A Pvt. Ltd.',
    cur:  isCompanyB ? 'USD' : 'INR',
  };
}

window.openCustomerModal = async function(customerNo) {
  const overlay = document.getElementById('custModalOverlay');
  const body    = document.getElementById('custModalBody');

  overlay.style.display = 'flex';
  body.innerHTML = `
    <div class="cust-modal-split">
      <div class="cust-detail-col">
        <div class="loading-center" style="padding:60px;"><div class="spinner"></div></div>
      </div>
      <div class="cust-ledger-col">
        <div class="loading-center" style="padding:60px;"><div class="spinner"></div></div>
      </div>
    </div>`;

  try {
    const data = await apiRequest('/sales/customers/' + encodeURIComponent(customerNo));
    modalCustomer   = data.customer;
    modalLedgerRows = data.ledger || [];
    // Also pull the customer's PDCs so the ledger + Total Outstanding can net undeposited cheques
    // in hand. Pass code AND name so name-only PDCs (added before NAV match) still resolve.
    try {
      const cc = encodeURIComponent(customerNo);
      const cn = encodeURIComponent((data.customer && data.customer.Name) || '');
      const pr = await apiRequest(`/sales/pdc?customerCode=${cc}&customerName=${cn}&limit=500`);
      modalCustomerPdcs = pr.data || [];
    } catch (_) { modalCustomerPdcs = []; }
    // Imported "Yet to Approve" credit notes for this customer (for CN tab + netting).
    try {
      const cc = encodeURIComponent(customerNo);
      const cn = encodeURIComponent((data.customer && data.customer.Name) || '');
      const cr = await apiRequest(`/sales/cn?customerCode=${cc}&customerName=${cn}`);
      modalCustomerCNs = cr.data || [];
    } catch (_) { modalCustomerCNs = []; }
    renderModalContent(data.customer, data.ledger || []);
  } catch (err) {
    body.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><div class="empty-text">Failed to load customer detail.</div></div>`;
  }
};

function closeModal() {
  document.getElementById('custModalOverlay').style.display = 'none';
  modalLedgerRows     = [];
  modalCustomer       = null;
  modalCustomerPdcs   = [];
  modalCustomerCNs    = [];
  currentLedgerFilter = 'open'; // reset to default for next open
}

// ── Render Modal Content ──────────────────────────────────────────────────────
function renderModalContent(c, ledger) {
  if (!c) return;

  const totalOutstanding = ledger
    .filter(r => r.IsOpen)
    .reduce((s, r) => s + (r.Outstanding || 0), 0);

  const openCount = ledger.filter(r => r.IsOpen).length;

  // Netting — undeposited PDC cheques in hand AND imported "Yet to Approve" credit
  // notes both reduce the effective outstanding. "Approved CN" (NAV-posted credit
  // memos) is already inside NAV outstanding, so it is shown for info but NOT
  // subtracted again. Remaining = Total Outstanding − PDC in hand − CN yet to Approve.
  const pdcHeld       = heldPdcTotal();
  const approvedCN    = approvedCnTotal(ledger);
  const cnYetToApprove = cnYetToApproveTotal();
  const remaining     = totalOutstanding - pdcHeld - cnYetToApprove;

  const body = document.getElementById('custModalBody');
  body.innerHTML = `
    <div class="cust-modal-split">

      <!-- LEFT: Customer Info -->
      <div class="cust-detail-col">
        <div class="cust-detail-header">
          <div class="cust-avatar">${(c.Name||'?').slice(0,2).toUpperCase()}</div>
          <div>
            <div class="cust-name">${esc(c.Name||'—')}</div>
            <div class="cust-code">${esc(c.CustomerNo)}</div>
          </div>
        </div>

        <div class="cust-info-grid">
          <div class="cust-info-row">
            <span class="cust-info-label">Total Outstanding</span>
            <span class="cust-info-val" style="font-family:var(--mono);color:var(--red);">${fmtCur(totalOutstanding)}</span>
          </div>
          <div class="cust-info-row">
            <span class="cust-info-label">Balance Due</span>
            <span class="cust-info-val" style="color:${(c.BalanceDue||0)>0?'var(--red)':'var(--green)'};font-family:var(--mono);">${fmtCur(c.BalanceDue)}</span>
          </div>
          <div class="cust-info-row">
            <span class="cust-info-label">Open Invoices</span>
            <span class="cust-info-val" style="color:var(--amber);">${openCount}</span>
          </div>
          ${(isCnUser() && approvedCN > 0) ? `
          <div class="cust-info-row" title="Credit notes already posted in NAV — already reflected in Total Outstanding (shown for info, not subtracted again)">
            <span class="cust-info-label">Approved CN</span>
            <span class="cust-info-val" style="font-family:var(--mono);color:var(--green);">${fmtCur(approvedCN)}</span>
          </div>` : ''}
          ${cnYetToApprove > 0 ? `
          <div class="cust-info-row" title="Credit notes imported from Excel, not yet posted in NAV">
            <span class="cust-info-label">CN yet to Approve</span>
            <span class="cust-info-val" style="font-family:var(--mono);color:var(--amber);">- ${fmtCur(cnYetToApprove)}</span>
          </div>` : ''}
          ${pdcHeld > 0 ? `
          <div class="cust-info-row" title="Undeposited PDC cheques in hand (Status = Not Deposited)">
            <span class="cust-info-label">Less: PDC in hand</span>
            <span class="cust-info-val" style="font-family:var(--mono);color:var(--amber);">- ${fmtCur(pdcHeld)}</span>
          </div>` : ''}
          ${(pdcHeld > 0 || cnYetToApprove > 0) ? `
          <div class="cust-info-row" style="border-top:1px dashed var(--border);padding-top:6px;margin-top:2px;" title="Total Outstanding − PDC in hand − CN yet to Approve">
            <span class="cust-info-label" style="font-weight:600;">Remaining Outstanding</span>
            <span class="cust-info-val" style="font-family:var(--mono);font-weight:700;color:${remaining > 0 ? 'var(--red)' : 'var(--green)'};">${fmtCur(remaining)}</span>
          </div>` : ''}
          <div class="cust-info-row">
            <span class="cust-info-label">Credit Limit</span>
            <span class="cust-info-val" style="font-family:var(--mono);">${(c.CreditLimit||0)===0?'Unlimited':fmtCur(c.CreditLimit)}</span>
          </div>
          <div class="cust-info-row">
            <span class="cust-info-label">Payment Terms</span>
            <span class="cust-info-val">${esc(c.PaymentTerms||'—')}</span>
          </div>
          <div class="cust-info-row">
            <span class="cust-info-label">Salesperson</span>
            <span class="cust-info-val" style="color:var(--accent);">${esc(c.Salesperson||'—')}</span>
          </div>
        </div>

        <div class="cust-divider"></div>

        ${c.GSTNo ? `
        <div class="cust-info-row">
          <span class="cust-info-label">GST Reg. No.</span>
          <span class="cust-info-val" style="font-family:var(--mono);color:var(--teal);">${esc(c.GSTNo)}</span>
        </div>` : ''}

        <div class="cust-divider"></div>

        ${c.Address ? `<div class="cust-contact-row">📍 ${esc([c.Address,c.Address2,c.City,c.State,c.PinCode].filter(Boolean).join(', '))}</div>` : ''}
        ${c.Phone   ? `<div class="cust-contact-row">📞 ${esc(c.Phone)}</div>` : ''}
        ${c.Email   ? `<div class="cust-contact-row">✉ <a href="mailto:${esc(c.Email)}" style="color:var(--accent);">${esc(c.Email)}</a></div>` : ''}
      </div>

      <!-- RIGHT: Full Ledger -->
      <div class="cust-ledger-col">
        <div class="cust-ledger-head">
          <span style="font-size:14px;font-weight:600;">Ledger History</span>
          <div style="display:flex;gap:6px;align-items:center;">
            <div class="cust-ledger-tabs">
              <button class="cust-tab active" data-filter="open" onclick="filterLedger('open',this)">Open</button>
              <button class="cust-tab" data-filter="all"  onclick="filterLedger('all',this)">All</button>
              <button class="cust-tab" data-filter="pdc"  onclick="filterLedger('pdc',this)">🏦 PDC</button>
              ${isCnUser() ? `<button class="cust-tab" data-filter="cn"   onclick="filterLedger('cn',this)">🧾 CN</button>` : ''}
            </div>
          </div>
        </div>

        <div class="table-wrap cust-ledger-table-wrap" id="ledgerTableWrap">
          ${renderLedgerTable(ledger.filter(r => r.IsOpen))}
        </div>
      </div>

    </div>
  `;
}

// ── Ledger Table ──────────────────────────────────────────────────────────────
function renderLedgerTable(rows) {
  if (!rows.length) return `<div class="empty" style="padding:40px;"><div class="empty-text">No entries found</div></div>`;

  return `
    <div id="ledgerSelBar" style="display:none; padding:6px 12px; background:rgba(79,142,247,0.10); border-bottom:1px solid var(--accent); font-size:12px; justify-content:space-between; align-items:center;">
      <span title="Export Excel / PDF will use only the selected rows"><b id="ledgerSelCount">0</b> selected &nbsp;&middot;&nbsp; Amount (LCY): <b id="ledgerSelSum">&mdash;</b> &nbsp;&middot;&nbsp; Outstanding: <b id="ledgerSelOut" style="color:var(--red);">&mdash;</b></span>
      <button type="button" onclick="clearLedgerSelection()" style="background:none;border:1px solid var(--border);color:var(--text2);padding:3px 10px;border-radius:6px;cursor:pointer;font-size:11px;">Clear selection</button>
    </div>
    <table class="cust-ledger-tbl">
      <thead><tr>
        <th style="width:32px; text-align:center;"><input type="checkbox" id="ledgerSelAll" onchange="toggleAllLedgerChecks(this.checked)" title="Select all" /></th>
        <th>Doc Type</th>
        <th>Doc No.</th>
        <th>Ext Doc No.</th>
        <th>Posting Date</th>
        <th>Due Date</th>
        <th style="text-align:right;">Amount (LCY)</th>
        <th style="text-align:right;">Outstanding</th>
        <th style="text-align:center;">Status</th>
        <th style="text-align:center;">Print</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          // PDC pseudo-row — an undeposited cheque in hand (netted against outstanding).
          if (r._isPdc) {
            return `<tr class="ledger-pdc-row">
              <td></td>
              <td><span class="badge" style="background:rgba(245,158,11,.16);color:#b45309;">PDC</span></td>
              <td style="font-family:var(--mono);font-size:12px;color:var(--accent);">${esc(r.DocNo||'—')}</td>
              <td style="font-family:var(--mono);font-size:11px;color:var(--text3);">${esc(r.ExtDocNo||'—')}</td>
              <td style="font-size:12px;white-space:nowrap;">${fmtDate(r.PostingDate)}</td>
              <td style="font-size:12px;">—</td>
              <td style="text-align:right;font-family:var(--mono);font-size:12px;color:var(--amber);">${fmtCur(r.SalesLCY)}</td>
              <td style="text-align:right;font-family:var(--mono);font-size:12px;color:var(--text3);">—</td>
              <td style="text-align:center;">${pdcStatusPill(r._pdcStatus)}</td>
              <td style="text-align:center;color:var(--text3);">—</td>
            </tr>`;
          }
          const isOverdue = r.IsOpen && r.DueDate && new Date(r.DueDate) < new Date();
          const statusBadge = r.IsOpen
            ? (isOverdue ? `<span class="badge badge-red">Overdue</span>` : `<span class="badge badge-amber">Open</span>`)
            : `<span class="badge badge-green">Closed</span>`;
          const docType   = (r.DocType || '').toLowerCase();
          const isInvoice = docType === 'invoice';
          const isCrMemo  = docType === 'credit memo';
          const isPayment = docType === 'payment';
          let pdfBtn;
          if (isInvoice) {
            pdfBtn = `<a href="javascript:void(0)" onclick="downloadInvoicePdf('${esc(r.DocNo)}')" title="Download Tax Invoice PDF" style="text-decoration:none;color:var(--red);font-size:18px;">📄</a>`;
          } else if (isCrMemo) {
            pdfBtn = `<a href="javascript:void(0)" onclick="downloadCreditMemoPdf('${esc(r.DocNo)}')" title="Download Credit Memo PDF" style="text-decoration:none;color:var(--amber,#e0a800);font-size:18px;">📄</a>`;
          } else if (isPayment) {
            // v1.8 — Payment Advice PDF (acknowledgement of money received +
            // applied-invoices list + account summary).
            pdfBtn = `<a href="javascript:void(0)" onclick="downloadPaymentAdvicePdf('${esc(r.DocNo)}')" title="Download Payment Advice PDF" style="text-decoration:none;color:#16a34a;font-size:18px;">📄</a>`;
          } else {
            pdfBtn = `<span style="color:var(--text3);">—</span>`;
          }
          return `<tr>
            <td style="text-align:center;"><input type="checkbox" class="ledger-row-chk" data-entry="${esc(r.EntryNo)}" onchange="onLedgerChkChange()" /></td>
            <td style="font-size:12px;">${esc(r.DocType||'—')}</td>
            <td style="font-family:var(--mono);font-size:12px;color:var(--accent);">${esc(r.DocNo||'—')}</td>
            <td style="font-family:var(--mono);font-size:11px;color:var(--text3);">${esc(r.ExtDocNo||'—')}</td>
            <td style="font-size:12px;white-space:nowrap;">${fmtDate(r.PostingDate)}</td>
            <td style="font-size:12px;white-space:nowrap;${isOverdue?'color:var(--red);':''}">${fmtDate(r.DueDate)}</td>
            <td style="text-align:right;font-family:var(--mono);font-size:12px;">${fmtCur(r.SalesLCY)}</td>
            <td style="text-align:right;font-family:var(--mono);font-size:12px;${r.Outstanding>0?'color:var(--red);':''}">${fmtCur(r.Outstanding)}</td>
            <td style="text-align:center;">${statusBadge}</td>
            <td style="text-align:center;">${pdfBtn}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ── Selection helpers (new — used by export functions below) ──────────────────
// If user has any rows checked, exports use ONLY those. Otherwise exports fall
// back to the existing "current filter" (Open / All) behaviour.
window.getSelectedLedgerRows = function () {
  const checked = Array.from(document.querySelectorAll('.ledger-row-chk:checked'));
  if (!checked.length) return null;
  const entryNos = new Set(checked.map(c => String(c.dataset.entry)));
  return modalLedgerRows.filter(r => entryNos.has(String(r.EntryNo)));
};
window.getRowsForExport = function () {
  const sel = window.getSelectedLedgerRows();
  return sel && sel.length ? sel : getFilteredLedgerRows();
};
window.toggleAllLedgerChecks = function (checked) {
  document.querySelectorAll('.ledger-row-chk').forEach(c => { c.checked = checked; });
  onLedgerChkChange();
};
window.clearLedgerSelection = function () {
  const all = document.getElementById('ledgerSelAll');
  if (all) { all.checked = false; all.indeterminate = false; }
  document.querySelectorAll('.ledger-row-chk').forEach(c => { c.checked = false; });
  onLedgerChkChange();
};
window.onLedgerChkChange = function () {
  const checked = document.querySelectorAll('.ledger-row-chk:checked').length;
  const total   = document.querySelectorAll('.ledger-row-chk').length;
  const bar     = document.getElementById('ledgerSelBar');
  const cnt     = document.getElementById('ledgerSelCount');
  const all     = document.getElementById('ledgerSelAll');
  if (bar) bar.style.display = checked > 0 ? 'flex' : 'none';
  if (cnt) cnt.textContent = checked;
  // Sum of the ticked rows — Amount (LCY) and Outstanding — so the user can total
  // a few selected invoices on the fly (request 2026-06-26).
  const selRows = (window.getSelectedLedgerRows && window.getSelectedLedgerRows()) || [];
  const sumAmt = selRows.reduce((s, r) => s + (Number(r.SalesLCY)    || 0), 0);
  const sumOut = selRows.reduce((s, r) => s + (Number(r.Outstanding) || 0), 0);
  const sumEl = document.getElementById('ledgerSelSum');
  const outEl = document.getElementById('ledgerSelOut');
  if (sumEl) sumEl.textContent = fmtCur(sumAmt);
  if (outEl) outEl.textContent = fmtCur(sumOut);
  if (all) {
    all.checked       = checked > 0 && checked === total;
    all.indeterminate = checked > 0 && checked  <  total;
  }
};

// downloadInvoicePdf is defined globally in shared/common.js

// ── Filter Ledger ─────────────────────────────────────────────────────────────
window.filterLedger = function(filter, btn) {
  currentLedgerFilter = filter;
  document.querySelectorAll('.cust-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (filter === 'pdc') {
    renderPdcTabForCustomer();
  } else if (filter === 'cn') {
    renderCnTabForCustomer();
  } else {
    document.getElementById('ledgerTableWrap').innerHTML = renderLedgerTable(getFilteredLedgerRows());
  }
};

// ── CN tab inside Customer Detail ────────────────────────────────────────────
// Approved CN = NAV-posted credit memos (already in the ledger). Yet to Approve =
// imported from Excel (BN_CreditNote), fetched when the modal opened.
function renderCnTabForCustomer() {
  if (!modalCustomer) return;
  document.getElementById('ledgerTableWrap').innerHTML = renderCnTable();
}

function cnStatusBadge(kind) {
  return kind === 'approved'
    ? `<span class="badge cn-approved">Approved</span>`
    : `<span class="badge cn-pending">Yet to Approve</span>`;
}

// Unified CN row list for the CN tab + exports: Approved (NAV credit memos) then
// Yet-to-Approve (imported). Each row carries a stable `key` for checkbox selection.
function getCnRows() {
  const approved = (modalLedgerRows || [])
    .filter(r => String(r.DocType || '').toLowerCase() === 'credit memo')
    .map(r => ({
      key: 'A-' + r.EntryNo, kind: 'approved', status: 'Approved',
      dateRaw: r.PostingDate || '', billNo: r.DocNo || '', type: '',
      reason: r.Description || '', amount: Math.abs(Number(r.SalesLCY) || 0), cnId: null,
    }));
  const pending = (modalCustomerCNs || []).map(cn => ({
    key: 'P-' + cn.CnId, kind: 'pending', status: 'Yet to Approve',
    dateRaw: cn.BillDate || '', billNo: cn.BillNo || '', type: cn.CnType || '',
    reason: cn.Reason || '', amount: Number(cn.Amount) || 0, cnId: cn.CnId,
  }));
  return approved.concat(pending);
}

// ── CN checkbox selection (mirrors the ledger tab) ───────────────────────────
window.getSelectedCnRows = function () {
  const checked = Array.from(document.querySelectorAll('.cn-row-chk:checked'));
  const all = getCnRows();
  if (!checked.length) return all;   // nothing ticked → export everything
  const keys = new Set(checked.map(c => c.dataset.key));
  return all.filter(r => keys.has(r.key));
};
window.toggleAllCnChecks = function (checked) {
  document.querySelectorAll('.cn-row-chk').forEach(c => { c.checked = checked; });
  window.onCnCheck();
};
window.clearCnSelection = function () {
  document.querySelectorAll('.cn-row-chk:checked').forEach(c => { c.checked = false; });
  const all = document.getElementById('cnSelAll'); if (all) { all.checked = false; all.indeterminate = false; }
  window.onCnCheck();
};
window.onCnCheck = function () {
  const rows = document.querySelectorAll('.cn-row-chk');
  const checked = document.querySelectorAll('.cn-row-chk:checked');
  const all = document.getElementById('cnSelAll');
  if (all) { all.checked = rows.length > 0 && checked.length === rows.length; all.indeterminate = checked.length > 0 && checked.length < rows.length; }
  const bar = document.getElementById('cnSelBar');
  if (!bar) return;
  if (!checked.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const keys = new Set(Array.from(checked).map(c => c.dataset.key));
  const sum = getCnRows().filter(r => keys.has(r.key)).reduce((s, r) => s + r.amount, 0);
  document.getElementById('cnSelCount').textContent = checked.length;
  document.getElementById('cnSelSum').textContent = fmtCur(sum);
};

function renderCnTable() {
  const all = getCnRows();
  const approved = all.filter(r => r.kind === 'approved');
  const pending  = all.filter(r => r.kind === 'pending');
  const approvedTotal = approved.reduce((s, r) => s + r.amount, 0);
  const pendingTotal  = pending.reduce((s, r) => s + r.amount, 0);
  const controls = isCnUser() ? `
      <button class="btn btn-sm" onclick="exportCnExcel()" title="Export CN list to Excel" style="white-space:nowrap;">⬇ Excel</button>
      <button class="btn btn-sm" onclick="exportCnPdf()" title="Export CN list to PDF" style="white-space:nowrap;">⬇ PDF</button>
      <button class="btn btn-sm btn-primary" onclick="openCnImport()" style="white-space:nowrap;">⇧ Import CN</button>` : '';

  const head = `
    <div style="display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border);align-items:center;flex-wrap:wrap;">
      <span style="flex:1;min-width:170px;font-size:12px;color:var(--text2);">
        Approved: <b style="color:var(--green);">${fmtCur(approvedTotal)}</b> (${approved.length})
        &nbsp;·&nbsp; Yet to Approve: <b style="color:var(--amber);">${fmtCur(pendingTotal)}</b> (${pending.length})
      </span>
      ${controls}
    </div>
    <div id="cnSelBar" style="display:none;padding:6px 12px;background:rgba(79,142,247,0.10);border-bottom:1px solid var(--accent);font-size:12px;justify-content:space-between;align-items:center;">
      <span><b id="cnSelCount">0</b> selected &nbsp;·&nbsp; Amount: <b id="cnSelSum">—</b></span>
      <button type="button" onclick="clearCnSelection()" style="background:none;border:1px solid var(--border);color:var(--text2);padding:3px 10px;border-radius:6px;cursor:pointer;font-size:11px;">Clear selection</button>
    </div>`;

  if (!all.length) {
    return head + `<div class="empty" style="padding:40px;"><div class="empty-text">No credit notes for this customer.${isCnUser() ? '<br/><span style="font-size:11px;color:var(--text3);">Use ⇧ Import CN to upload the CN Excel.</span>' : ''}</div></div>`;
  }

  const rowsHtml = all.map(r => `
    <tr class="${r.kind === 'pending' ? 'ledger-pdc-row' : ''}">
      <td style="text-align:center;"><input type="checkbox" class="cn-row-chk" data-key="${esc(r.key)}" onchange="onCnCheck()" /></td>
      <td style="text-align:center;">${cnStatusBadge(r.kind)}</td>
      <td style="font-size:12px;white-space:nowrap;">${fmtDate(r.dateRaw)}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--accent);">${esc(r.billNo || '—')}</td>
      <td style="text-align:center;">${r.type ? `<span class="badge" style="background:rgba(99,102,241,.14);color:#4338ca;">${esc(r.type)}</span>` : '—'}</td>
      <td style="font-size:12px;" title="${esc(r.reason)}">${esc(r.reason || '—')}</td>
      <td style="text-align:right;font-family:var(--mono);font-size:12px;color:${r.kind === 'pending' ? 'var(--amber)' : 'var(--green)'};">${r.kind === 'pending' ? '- ' : ''}${fmtCur(r.amount)}</td>
      <td style="text-align:center;">${(r.kind === 'pending' && isCnUser()) ? `<a href="javascript:void(0)" onclick="deleteCn(${r.cnId})" title="Remove once NAV has posted this credit memo" style="color:var(--red);text-decoration:none;font-size:15px;">🗑</a>` : '—'}</td>
    </tr>`).join('');

  return head + `
    <table class="cust-ledger-tbl">
      <thead><tr>
        <th style="width:32px;text-align:center;"><input type="checkbox" id="cnSelAll" onchange="toggleAllCnChecks(this.checked)" title="Select all" /></th>
        <th style="text-align:center;">Status</th>
        <th>Date</th>
        <th>Bill / Doc No.</th>
        <th style="text-align:center;">Type</th>
        <th>Reason / Description</th>
        <th style="text-align:right;">Amount</th>
        <th style="text-align:center;">Action</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

// ── CN export (Excel + PDF) — selected rows, or all if none ticked ───────────
window.exportCnExcel = function () {
  if (!modalCustomer) return;
  const rows = window.getSelectedCnRows();
  if (!rows.length) { alert('No credit notes to export.'); return; }
  const c = modalCustomer;
  const info = exportCoInfo();
  const approvedTotal = rows.filter(r => r.kind === 'approved').reduce((s, r) => s + r.amount, 0);
  const pendingTotal  = rows.filter(r => r.kind === 'pending').reduce((s, r) => s + r.amount, 0);
  const data = [
    { Status: info.name },
    { Status: 'Customer:',           Date: c.Name },
    { Status: 'Code:',               Date: c.CustomerNo },
    { Status: 'Approved CN:',        Date: approvedTotal },
    { Status: 'CN Yet to Approve:',  Date: pendingTotal },
    { Status: 'Exported:',           Date: new Date().toLocaleDateString('en-IN') },
    {},
    ...rows.map(r => ({
      Status: r.status,
      Date: r.dateRaw ? String(r.dateRaw).split('T')[0] : '',
      'Bill / Doc No.': r.billNo,
      Type: r.type,
      'Reason / Description': r.reason,
      ['Amount (' + info.cur + ')']: r.amount,
    })),
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Credit Notes');
  const bin = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([bin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  nativeSaveAndShare(blob, `CN_${c.CustomerNo}_${new Date().toISOString().slice(0,10)}.xlsx`, { dialogTitle: 'Share CN Excel' });
};

window.exportCnPdf = function () {
  if (!modalCustomer) return;
  if (!window.jspdf || !window.jspdf.jsPDF) { alert('PDF library failed to load. Please check your internet connection.'); return; }
  const rows = window.getSelectedCnRows();
  if (!rows.length) { alert('No credit notes to export.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth  = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const c = modalCustomer;
  const info = exportCoInfo();
  const approvedTotal = rows.filter(r => r.kind === 'approved').reduce((s, r) => s + r.amount, 0);
  const pendingTotal  = rows.filter(r => r.kind === 'pending').reduce((s, r) => s + r.amount, 0);

  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text(info.name, pageWidth / 2, 35, { align: 'center' });
  doc.setFontSize(12);
  doc.text('Customer Credit Notes', pageWidth / 2, 53, { align: 'center' });
  doc.setFontSize(9); doc.setFont('helvetica', 'normal');
  let y = 78;
  doc.setFont('helvetica', 'bold'); doc.text('Customer:', 40, y);
  doc.setFont('helvetica', 'normal'); doc.text(String(c.Name || '—'), 110, y);
  doc.setFont('helvetica', 'bold'); doc.text('Code:', pageWidth / 2 + 20, y);
  doc.setFont('helvetica', 'normal'); doc.text(String(c.CustomerNo || '—'), pageWidth / 2 + 90, y); y += 14;
  doc.setFont('helvetica', 'bold'); doc.text('Approved CN:', 40, y);
  doc.setFont('helvetica', 'normal'); doc.text(info.cur + ' ' + fmtNumPDF(approvedTotal), 110, y);
  doc.setFont('helvetica', 'bold'); doc.text('CN Yet to Approve:', pageWidth / 2 + 20, y);
  doc.setFont('helvetica', 'normal'); doc.text(info.cur + ' ' + fmtNumPDF(pendingTotal), pageWidth / 2 + 120, y); y += 18;

  const head = [['Status', 'Date', 'Bill / Doc No.', 'Type', 'Reason / Description', 'Amount (' + info.cur + ')']];
  const body = rows.map(r => [
    r.status,
    r.dateRaw ? new Date(r.dateRaw).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '',
    r.billNo || '',
    r.type || '',
    r.reason || '',
    (r.kind === 'pending' ? '- ' : '') + fmtNumPDF(r.amount),
  ]);
  doc.autoTable({
    startY: y, head, body,
    foot: [['', '', '', '', 'Total CN:', fmtNumPDF(approvedTotal + pendingTotal)]],
    styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak', font: 'helvetica' },
    headStyles: { fillColor: [79, 142, 247], textColor: 255, fontStyle: 'bold', halign: 'center' },
    footStyles: { fillColor: [240, 240, 240], textColor: 20, fontStyle: 'bold', halign: 'right' },
    columnStyles: { 0: { cellWidth: 90, halign: 'center' }, 1: { cellWidth: 80 }, 2: { cellWidth: 110 }, 3: { cellWidth: 55, halign: 'center' }, 5: { cellWidth: 90, halign: 'right' } },
    didDrawPage: (data) => {
      doc.setFontSize(8); doc.setFont('helvetica', 'normal');
      doc.text(`Page ${data.pageNumber} of ${doc.internal.getNumberOfPages()}`, pageWidth - 40, pageHeight - 20, { align: 'right' });
      doc.text(`${c.Name || ''} (${c.CustomerNo || ''})`, 40, pageHeight - 20, { align: 'left' });
    },
    margin: { top: y, left: 40, right: 40, bottom: 30 },
  });
  const blob = doc.output('blob');
  nativeSaveAndShare(blob, `CN_${c.CustomerNo}_${new Date().toISOString().slice(0,10)}.pdf`, { dialogTitle: 'Share CN PDF' });
};

// Refetch this customer's imported CN, then re-render the modal (so left-panel totals
// update) and re-activate the CN tab.
async function refreshCnAndModal() {
  if (!modalCustomer) return;
  try {
    const cc = encodeURIComponent(modalCustomer.CustomerNo || '');
    const cn = encodeURIComponent(modalCustomer.Name || '');
    const r  = await apiRequest(`/sales/cn?customerCode=${cc}&customerName=${cn}`);
    modalCustomerCNs = r.data || [];
  } catch (_) { /* keep stale on error */ }
  renderModalContent(modalCustomer, modalLedgerRows);
  const tab = document.querySelector('.cust-tab[data-filter="cn"]');
  if (tab) filterLedger('cn', tab);
}

window.deleteCn = async function (id) {
  if (!isCnUser()) return;
  if (!confirm('Remove this Credit Note?\nDo this once NAV has posted the credit memo — it will stop netting the outstanding.')) return;
  try {
    await apiRequest('/sales/cn/' + id, { method: 'DELETE' });
    await refreshCnAndModal();
  } catch (e) { alert('Delete failed: ' + (e.message || e)); }
};

// ── Import CN modal ──────────────────────────────────────────────────────────
window.openCnImport = function () {
  if (!isCnUser()) return;
  document.getElementById('cnImportFile').value = '';
  document.getElementById('cnImportResult').innerHTML = '';
  document.getElementById('cnImportModal').style.display = 'flex';
};
window.closeCnImport = function () { document.getElementById('cnImportModal').style.display = 'none'; };

window.doCnImport = async function (dryRun) {
  const file = document.getElementById('cnImportFile').files[0];
  const res  = document.getElementById('cnImportResult');
  if (!file) { res.innerHTML = '<span style="color:var(--red);">Pick an Excel file first.</span>'; return; }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('dryRun', dryRun ? 'true' : 'false');
  const company = getCompany();
  const token   = getToken();
  res.innerHTML = 'Working…';
  try {
    const r = await fetch(`/api/sales/cn/import?company=${encodeURIComponent(company)}`, {
      method: 'POST',
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
      body: fd,
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) { res.innerHTML = `<span style="color:var(--red);">${esc(d.message || d.detail || 'Import failed')}</span>`; return; }
    res.innerHTML = `
      <div style="font-weight:700;color:${dryRun ? 'var(--accent)' : 'var(--green)'};margin-bottom:6px;">${dryRun ? '👁 Preview (nothing saved yet)' : '✓ Import complete'}</div>
      <div style="font-size:12px;">Rows parsed: <b>${d.rowsParsed}</b> &middot; Matched to NAV: <b style="color:var(--green);">${d.matched}</b> &middot; Unmatched: <b style="color:${d.unmatched ? 'var(--red)' : 'var(--text2)'};">${d.unmatched}</b>${d.inserted != null ? ` &middot; Inserted: <b style="color:var(--green);">${d.inserted}</b> &middot; Updated: <b style="color:var(--teal);">${d.updated}</b>` : ''}${d.failed ? ` &middot; Failed: <b style="color:var(--red);">${d.failed}</b>` : ''}</div>`;
    if (!dryRun && modalCustomer) await refreshCnAndModal();
  } catch (e) { res.innerHTML = `<span style="color:var(--red);">${esc(e.message || e)}</span>`; }
};

// ── PDC tab inside Customer Detail ───────────────────────────────────────────
// PDCs are already fetched when the modal opens (for ledger netting), so render from cache.
function renderPdcTabForCustomer() {
  if (!modalCustomer) return;
  const wrap = document.getElementById('ledgerTableWrap');
  wrap.innerHTML = renderPdcTable(modalCustomerPdcs || []);
}

function renderPdcTable(rows) {
  const head = `
    <div style="display:flex; gap:8px; padding:8px 12px; border-bottom:1px solid var(--border); align-items:center;">
      <span style="flex:1; font-size:12px; color:var(--text2);">Showing ${rows.length} cheque${rows.length === 1 ? '' : 's'} held against this customer</span>
      <a href="/modules/sales/pdc.html" class="btn btn-ghost btn-sm" style="text-decoration:none;">↗ Open PDC page</a>
    </div>
    <div id="custPdcSelBar" style="display:none; padding:6px 12px; background:rgba(59,130,246,0.10); border-bottom:1px solid var(--accent); font-size:12px; justify-content:space-between; align-items:center;">
      <span><b id="custPdcSelCount">0</b> selected &nbsp;&middot;&nbsp; Amount: <b id="custPdcSelSum">&mdash;</b></span>
      <div style="display:flex; gap:6px;">
        <button class="btn btn-sm" onclick="exportSelectedCustomerPdcs()">⇩ Export Selected</button>
        <button class="btn btn-sm btn-ghost" onclick="clearCustomerPdcSelection()">Clear</button>
      </div>
    </div>`;
  if (!rows.length) {
    return head + `<div class="empty" style="padding:40px;"><div class="empty-text">No PDCs recorded for this customer yet.<br/><span style="font-size:11px; color:var(--text3);">Add one via the <a href="/modules/sales/pdc.html" style="color:var(--accent);">PDC page</a> or import from Excel.</span></div></div>`;
  }
  return head + `
    <table class="cust-ledger-tbl">
      <thead><tr>
        <th style="width:32px; text-align:center;"><input type="checkbox" id="custPdcSelAll" onchange="toggleAllCustomerPdcChecks(this.checked)" title="Select all" /></th>
        <th>Cheque Date</th>
        <th>Cheque No.</th>
        <th style="text-align:right;">Amount</th>
        <th>Bank</th>
        <th>Vertical</th>
        <th>Bill No.</th>
        <th>Status</th>
        <th>Remark</th>
      </tr></thead>
      <tbody>
        ${rows.map(p => `
          <tr>
            <td style="text-align:center;"><input type="checkbox" class="cust-pdc-chk" data-id="${p.PDCId}" onchange="onCustomerPdcCheck()" /></td>
            <td style="font-size:12px;white-space:nowrap;">${fmtPdcDate(p.ChequeDate)}</td>
            <td style="font-family:var(--mono);font-size:12px;color:var(--accent);">${esc(p.ChequeNo || '—')}</td>
            <td style="text-align:right;font-family:var(--mono);font-size:12px;"><b>${fmtCur(p.Amount)}</b></td>
            <td style="font-size:12px;">${esc(p.BankName || '—')}</td>
            <td style="font-size:12px;">${esc(p.Vertical || '—')}</td>
            <td style="font-family:var(--mono);font-size:11px;color:var(--text3);">${esc(p.BillNo || '—')}</td>
            <td style="font-size:11px;white-space:nowrap;">${pdcStatusPill(p.Status)}</td>
            <td style="font-size:11px;color:var(--text3); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(p.Remark || '')}">${esc(p.Remark || '—')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// Date formatter for PDC tab — "1 April 26" style per user request 2026-05-26
function fmtPdcDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'2-digit' });
}

// Status pill used in the PDC tab. Matches the palette in pdc.css so the pill
// looks identical on the main PDC page and inside the Customer Ledger drawer.
const PDC_STATUS_LABELS = {
  pending: 'Pending', not_deposited: 'Not Deposited', with_salesperson: 'With Salesperson',
  deposited: 'Deposited', cleared: 'Cleared', online: 'Online',
  bounced: 'Bounced', hold: 'Hold', cancelled: 'Cancelled',
};
function normalizePdcStatus(raw) {
  const s = String(raw || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (PDC_STATUS_LABELS[s]) return s;   // canonical key
  const m = {
    'not deposited': 'not_deposited',
    'with salesperson': 'with_salesperson', 'pdc with salesperson': 'with_salesperson',
    'online received': 'online', 'neft received': 'online', 'neft done': 'online', 'online transfer': 'online',
    'cheque bounce': 'bounced', 'bounce': 'bounced',
    'canceled': 'cancelled',
  };
  return m[s] || null;
}
function pdcStatusPill(status) {
  const norm = normalizePdcStatus(status);
  if (!norm) return '<span style="color:var(--text3);">—</span>';
  const label = PDC_STATUS_LABELS[norm] || norm;
  const cls   = 's-' + norm.replace(/_/g, '-');
  return `<span class="pdc-status-pill ${cls}">${esc(label)}</span>`;
}

// ── Customer PDC tab — selection + export ──
window.toggleAllCustomerPdcChecks = function (checked) {
  document.querySelectorAll('.cust-pdc-chk').forEach(c => c.checked = checked);
  onCustomerPdcCheck();
};
window.onCustomerPdcCheck = function () {
  const ids = Array.from(document.querySelectorAll('.cust-pdc-chk:checked')).map(c => parseInt(c.dataset.id, 10));
  const bar = document.getElementById('custPdcSelBar');
  if (!bar) return;
  if (ids.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('custPdcSelCount').textContent = ids.length;
  // Sum of the ticked cheques' Amount (request 2026-06-26).
  const idSet  = new Set(ids);
  const sumAmt = (modalCustomerPdcs || []).reduce(
    (s, p) => idSet.has(parseInt(p.PDCId, 10)) ? s + (Number(p.Amount) || 0) : s, 0);
  const sumEl  = document.getElementById('custPdcSelSum');
  if (sumEl) sumEl.textContent = fmtCur(sumAmt);
  // Master checkbox state
  const all = document.querySelectorAll('.cust-pdc-chk');
  const master = document.getElementById('custPdcSelAll');
  if (master) {
    master.checked = ids.length === all.length;
    master.indeterminate = ids.length > 0 && ids.length < all.length;
  }
};
window.clearCustomerPdcSelection = function () {
  document.querySelectorAll('.cust-pdc-chk:checked').forEach(c => c.checked = false);
  const master = document.getElementById('custPdcSelAll');
  if (master) { master.checked = false; master.indeterminate = false; }
  onCustomerPdcCheck();
};
window.exportSelectedCustomerPdcs = async function () {
  const ids = Array.from(document.querySelectorAll('.cust-pdc-chk:checked')).map(c => parseInt(c.dataset.id, 10));
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
    const custName = (modalCustomer && (modalCustomer.Name || '')).replace(/[^\w]/g, '_').slice(0, 30) || 'customer';
    a.href = url; a.download = `COMPANYA_PDC_${custName}_Selected${ids.length}_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  } catch (e) { alert('Export Selected failed: ' + (e.message || e)); }
};

// ── Excel Export ──────────────────────────────────────────────────────────────
function exportLedgerExcel() {
  if (!modalCustomer || !modalLedgerRows.length) { alert('No data to export.'); return; }

  // Prefer the user's checkbox selection; fall back to the current Open/All filter.
  const exportRows = (typeof getRowsForExport === 'function') ? getRowsForExport() : getFilteredLedgerRows();
  if (!exportRows.length) { alert('No entries selected / in current filter to export.'); return; }
  const usedSelection = !!(window.getSelectedLedgerRows && window.getSelectedLedgerRows());
  const info = exportCoInfo();

  const rows = exportRows.map(r => ({
    'Doc Type':      r.DocType     || '',
    'Doc No.':       r.DocNo       || '',
    'Ext Doc No.':   r.ExtDocNo    || '',
    'Posting Date':  r.PostingDate ? r.PostingDate.split('T')[0] : '',
    'Due Date':      r.DueDate     ? r.DueDate.split('T')[0]     : '',
    ['Amount (' + info.cur + ')']:      r.SalesLCY    || 0,
    ['Outstanding (' + info.cur + ')']: r.Outstanding || 0,
    'Status':        r._isPdc ? 'PDC (Not Deposited)' : (r.IsOpen ? 'Open' : 'Closed'),
    'Description':   r.Description || '',
    'Salesperson':   r.Salesperson || '',
  }));

  // Summary header rows
  const pdcHeld = heldPdcTotal();
  const summaryRows = [
    { 'Doc Type': info.name },
    { 'Doc Type': 'Customer:',    'Doc No.': modalCustomer.Name },
    { 'Doc Type': 'Code:',        'Doc No.': modalCustomer.CustomerNo },
    { 'Doc Type': 'Balance Due:', 'Doc No.': modalCustomer.BalanceDue },
    ...(pdcHeld > 0 ? [
      { 'Doc Type': 'PDC in hand (Not Deposited):', 'Doc No.': -pdcHeld },
      { 'Doc Type': 'Remaining Outstanding:',       'Doc No.': (modalCustomer.BalanceDue || 0) - pdcHeld },
    ] : []),
    { 'Doc Type': 'Filter:',      'Doc No.': usedSelection
                                                ? `Selected rows only (${exportRows.length})`
                                                : (currentLedgerFilter === 'open' ? 'Open invoices only' : 'All entries') },
    { 'Doc Type': 'Exported:',    'Doc No.': new Date().toLocaleDateString('en-IN') },
    {},
    ...rows,
    {},
    { 'Doc Type': `Confirmation - We confirm the balance as mentioned above as per our books of accounts as on ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}` },
  ];

  const ws = XLSX.utils.json_to_sheet(summaryRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  const suffix = usedSelection ? `Selected${exportRows.length}` : (currentLedgerFilter === 'open' ? 'Open' : 'All');
  const filename = `Ledger_${modalCustomer.CustomerNo}_${suffix}_${new Date().toISOString().slice(0,10)}.xlsx`;
  // Use binary write + helper so the Capacitor APK can pop the native Share Sheet.
  // In a browser this is equivalent to XLSX.writeFile (which uses <a download>).
  const wbBin  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob   = new Blob([wbBin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  nativeSaveAndShare(blob, filename, { dialogTitle: 'Share ledger Excel' });
}

// ── PDF Export ────────────────────────────────────────────────────────────────
function exportLedgerPDF() {
  if (!modalCustomer || !modalLedgerRows.length) { alert('No data to export.'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { alert('PDF library failed to load. Please check your internet connection.'); return; }

  // Prefer the user's checkbox selection; fall back to the current Open/All filter.
  const exportRows = (typeof getRowsForExport === 'function') ? getRowsForExport() : getFilteredLedgerRows();
  if (!exportRows.length) { alert('No entries selected / in current filter to export.'); return; }
  const usedSelection = !!(window.getSelectedLedgerRows && window.getSelectedLedgerRows());

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth  = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const c = modalCustomer;
  const info = exportCoInfo();
  const filterLabel = usedSelection
    ? `Selected Rows Only (${exportRows.length})`
    : (currentLedgerFilter === 'open' ? 'Open Invoices Only' : 'All Entries');

  // ── Title ──
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(info.name, pageWidth / 2, 35, { align: 'center' });
  doc.setFontSize(12);
  doc.text(`Customer Ledger Statement — ${filterLabel}`, pageWidth / 2, 53, { align: 'center' });

  // ── Customer info block ──
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  let y = 78;
  const leftLabel = 40,  leftVal = 110;
  const rightLabel = pageWidth / 2 + 20, rightVal = pageWidth / 2 + 110;

  const drawRow = (label1, val1, label2, val2) => {
    doc.setFont('helvetica', 'bold'); doc.text(label1, leftLabel, y);
    doc.setFont('helvetica', 'normal'); doc.text(String(val1 || '—'), leftVal, y);
    if (label2) {
      doc.setFont('helvetica', 'bold'); doc.text(label2, rightLabel, y);
      doc.setFont('helvetica', 'normal'); doc.text(String(val2 || '—'), rightVal, y);
    }
    y += 14;
  };

  drawRow('Customer:',    c.Name,                          'Code:',          c.CustomerNo);
  drawRow('Balance Due:', info.cur + ' ' + fmtNumPDF(c.BalanceDue || 0), 'Payment Terms:', c.PaymentTerms);
  drawRow('Salesperson:', c.Salesperson,                   'Generated:',     new Date().toLocaleString('en-IN'));
  const pdcHeldPdf = heldPdcTotal();
  if (pdcHeldPdf > 0) drawRow('PDC in hand:', info.cur + ' ' + fmtNumPDF(pdcHeldPdf), 'Remaining O/S:', info.cur + ' ' + fmtNumPDF((c.BalanceDue || 0) - pdcHeldPdf));
  if (c.GSTNo)   drawRow('GST Reg. No.:', c.GSTNo, '', '');
  if (c.Address) drawRow('Address:', [c.Address, c.Address2, c.City, c.State, c.PinCode].filter(Boolean).join(', '), '', '');

  y += 6;

  // ── Ledger table ──
  // NOTE: amounts are plain numbers (no ₹/$ symbol) because jsPDF's default
  // Helvetica font lacks those glyphs. Currency shown in the column header + info block.
  const head = [['Doc Type', 'Doc No.', 'Ext Doc No.', 'Posting Date', 'Due Date', 'Amount (' + info.cur + ')', 'Outstanding (' + info.cur + ')', 'Status']];
  const body = exportRows.map(r => [
    r.DocType || '',
    r.DocNo || '',
    r.ExtDocNo || '',
    r.PostingDate ? new Date(r.PostingDate).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '',
    r.DueDate     ? new Date(r.DueDate).toLocaleDateString('en-IN',     { day:'2-digit', month:'short', year:'numeric' }) : '',
    fmtNumPDF(r.SalesLCY    || 0),
    fmtNumPDF(r.Outstanding || 0),
    r._isPdc ? 'PDC' : (r.IsOpen ? 'Open' : 'Closed')
  ]);

  // Totals row (over the EXPORTED rows only)
  const totalSales       = exportRows.reduce((s, r) => s + (r.SalesLCY    || 0), 0);
  const totalOutstanding = exportRows.reduce((s, r) => s + (r.Outstanding || 0), 0);

  doc.autoTable({
    startY: y,
    head: head,
    body: body,
    foot: [['', '', '', '', 'Total:', fmtNumPDF(totalSales), fmtNumPDF(totalOutstanding), '']],
    styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak', font: 'helvetica' },
    headStyles: { fillColor: [79, 142, 247], textColor: 255, fontStyle: 'bold', halign: 'center' },
    footStyles: { fillColor: [240, 240, 240], textColor: 20, fontStyle: 'bold', halign: 'right' },
    columnStyles: {
      0: { cellWidth: 70 },
      1: { cellWidth: 95 },
      2: { cellWidth: 95 },
      3: { cellWidth: 75, halign: 'center' },
      4: { cellWidth: 75, halign: 'center' },
      5: { cellWidth: 90, halign: 'right' },
      6: { cellWidth: 90, halign: 'right' },
      7: { cellWidth: 55, halign: 'center' }
    },
    didDrawPage: (data) => {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(
        `Page ${data.pageNumber} of ${doc.internal.getNumberOfPages()}`,
        pageWidth - 40,
        pageHeight - 20,
        { align: 'right' }
      );
      doc.text(
        `${c.Name || ''} (${c.CustomerNo || ''})`,
        40,
        pageHeight - 20,
        { align: 'left' }
      );
    },
    margin: { top: y, left: 40, right: 40, bottom: 30 }
  });

  // ── Balance-confirmation footer line (below the table; new page if it won't fit) ──
  const confDate = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  let confY = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : y) + 26;
  if (confY > pageHeight - 40) { doc.addPage(); confY = 50; }
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(`Confirmation - We confirm the balance as mentioned above as per our books of accounts as on ${confDate}`, 40, confY);

  const suffix = currentLedgerFilter === 'open' ? 'Open' : 'All';
  const filename = `Ledger_${c.CustomerNo}_${suffix}_${new Date().toISOString().slice(0,10)}.pdf`;
  // doc.save() uses <a download> and doesn't work in the Capacitor WebView.
  // doc.output('blob') gives us the raw PDF blob to pass through our helper,
  // which routes to native Share Sheet on phone and to browser download elsewhere.
  const blob = doc.output('blob');
  nativeSaveAndShare(blob, filename, { dialogTitle: 'Share ledger PDF' });
}

// ── Pagination ────────────────────────────────────────────────────────────────
function renderPagination() {
  const pag = document.getElementById('customersPagination');
  const totalPages = Math.ceil(totalCount / LIMIT);
  if (totalPages <= 1) { pag.innerHTML = ''; return; }

  let html = '';
  if (currentPage > 1) html += `<button class="page-btn" onclick="changePage(${currentPage-1})">‹</button>`;
  for (let p = Math.max(1,currentPage-2); p <= Math.min(totalPages,currentPage+2); p++) {
    html += `<button class="page-btn ${p===currentPage?'active':''}" onclick="changePage(${p})">${p}</button>`;
  }
  if (currentPage < totalPages) html += `<button class="page-btn" onclick="changePage(${currentPage+1})">›</button>`;
  html += `<span class="page-info">${fmt(totalCount)} customers</span>`;
  pag.innerHTML = html;
}

window.changePage = p => { currentPage = p; loadCustomers(); };

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return esc(str).replace(/'/g,'&#39;');
}
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); }
  catch { return '—'; }
}

})();