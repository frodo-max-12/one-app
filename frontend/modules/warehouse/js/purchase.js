/* warehouse/purchase.js — NAV-first Purchase list with inline-edit rows.
   Each row renders manual cells as <input>/<select>/<textarea>; click the row's
   💾 Save button to UPSERT into BN_WhPurchase. No modal. */

(function () {
  const ENDPOINT = '/warehouse/purchase';
  const PAGE_LIMIT = 50;

  // Filter state — listing is BN_WhPurchase-first (tracked rows only) since
  // the 2026-06-17 rewrite. Tracked-yes/no is no longer relevant; we keep
  // the dropdown but repurpose it as a Status filter.
  let page = 1, limit = PAGE_LIMIT;
  let search = '', statusF = 'all', days = 365, dateFrom = '', dateTo = '';
  let sortBy = '';   // '' = default MatlRecvDate DESC ; 'recent' = UpdatedAt DESC

  // Cache of last-fetched NAV rows (so saveRow has the PoNo/LineNumber + NAV preview)
  let _rowsByKey = new Map();

  // Carton-no datalist source (existing distinct CartonNos from BN_WhStock)
  // — populated once on page load; reused by the Receive-to-Stocks modal.
  let _cartonList = [];

  document.addEventListener('DOMContentLoaded', () => {
    const u = requireAuth(); if (!u) return;
    renderSidebar('wh-purchase');
    const rt = document.getElementById('roleTag');
    if (rt) rt.textContent = (u.role || '').toUpperCase();

    // Search
    document.getElementById('whSearch').addEventListener('input', debounce(() => {
      search = document.getElementById('whSearch').value.trim();
      page = 1; load();
    }, 280));

    // Status filter
    const statusSel = document.getElementById('whStatus');
    if (statusSel) {
      statusSel.innerHTML = `
        <option value="all">All statuses</option>
        <option value="Pending">Pending</option>
        <option value="In Transit">In Transit</option>
        <option value="Partially Received">Partially Received</option>
        <option value="Received">Received</option>
        <option value="Paid">Paid</option>
        <option value="Cancelled">Cancelled</option>`;
      statusSel.value = statusF;
      statusSel.addEventListener('change', () => {
        statusF = statusSel.value; page = 1; load();
      });
    }
    document.getElementById('whApply').onclick = () => {
      dateFrom = document.getElementById('whFrom').value;
      dateTo   = document.getElementById('whTo').value;
      page = 1; load();
    };

    // ── Clear Filters ──────────────────────────────────────────────────
    const clearBtn = document.getElementById('whClear');
    if (clearBtn) {
      clearBtn.onclick = () => {
        search = ''; dateFrom = ''; dateTo = ''; statusF = 'all';
        sortBy = '';
        document.getElementById('whSearch').value = '';
        document.getElementById('whFrom').value = '';
        document.getElementById('whTo').value = '';
        const ts = document.getElementById('whStatus');
        if (ts) ts.value = 'all';
        clearBtn.classList.remove('has-active');
        page = 1; load();
      };
    }

    // ── Recent edits sort ──────────────────────────────────────────────
    // Toggles a "show my most recently saved rows on top" sort. Backend
    // uses BN_WhPurchase.UpdatedAt — only tracked rows have a value, so
    // this also implicitly filters to rows Amit has touched at least once.
    const recentBtn = document.getElementById('whRecent');
    if (recentBtn) {
      recentBtn.onclick = () => {
        if (sortBy === 'recent') {
          sortBy = '';
          recentBtn.style.background = '';
        } else {
          sortBy = 'recent';
          recentBtn.style.background = '#fef3c7';
        }
        page = 1; load();
      };
    }

    if (WH.canWrite()) WH.wireImport('whImport', 'whFile', ENDPOINT, load);
    else { const imp = document.getElementById('whImport'); if (imp) imp.style.display = 'none'; }
    WH.wireExport('whExport', ENDPOINT, () => ({ search, status: statusF, dateFrom, dateTo, days }));

    // Background-fetch the carton list once so the Receive-to-Stocks modal
    // can offer typeahead suggestions without a per-open round-trip.
    apiRequest('/warehouse/stocks/carton-list')
      .then(r => { _cartonList = (r && r.data) || []; refreshCartonDatalist(); })
      .catch(() => { _cartonList = []; });

    wireReceiveModal();
    wireWizard();
    wireEditModal();
    wireInvoiceModal();
    load();
  });

  function refreshCartonDatalist() {
    const dl = document.getElementById('dl-carton-no');
    if (!dl) return;
    dl.innerHTML = _cartonList.map(c => `<option value="${WH.esc(c)}">`).join('');
  }

  async function load() {
    const tbody = document.getElementById('whTbody');
    tbody.innerHTML = `<tr><td colspan="41" class="wh-loading">Loading…</td></tr>`;
    try {
      const url = ENDPOINT + WH.qs({ search, status: statusF, dateFrom, dateTo, days, page, limit, sortBy });
      const res = await apiRequest(url);
      const rows = (res && res.data) || [];
      document.getElementById('whCount').textContent = (res?.total || 0) + ' PO lines';

      // Toggle "filters active" hint on Clear Filters button
      const isFiltered = !!(search || dateFrom || dateTo || (statusF && statusF !== 'all') || sortBy);
      const cb = document.getElementById('whClear');
      if (cb) cb.classList.toggle('has-active', isFiltered);

      _rowsByKey = new Map();
      for (const r of rows) _rowsByKey.set(keyOf(r), r);

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="41" class="wh-empty">No rows yet. Use <strong>+ New ASN / Shipment</strong> to record your first entry.</td></tr>`;
      } else {
        // Visual cell-merge: when consecutive rows repeat the same value for
        // Invoice / Carton / Dim / Weight / Supplier, blank those cells on
        // subsequent rows so the value shows once per group. Same-invoice
        // rows cluster together via backend ORDER BY (MatlRecvDate DESC,
        // InvoiceNo, PoNo, LineNumber).
        const flags = computeMergeFlags(rows);
        tbody.innerHTML = rows.map((r, i) => rowHtml(r, flags[i])).join('');
        // Wire the per-row Edit buttons (admin family only — others see a 🔒)
        tbody.querySelectorAll('button[data-action="edit"]').forEach(b => {
          b.onclick = () => openEditModal(b.dataset.id);
        });
        // Invoice No links open the Invoice Summary modal
        tbody.querySelectorAll('a.invoice-link').forEach(a => {
          a.onclick = (e) => { e.preventDefault(); openInvoiceSummary(a.dataset.inv); };
        });
      }
      WH.renderPaging('whPaging', res?.total || 0, page, limit, (p) => { page = p; load(); });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="41" class="wh-empty">Failed to load: ${WH.esc(e.message)}</td></tr>`;
    }
  }

  function keyOf(r) {
    return `${encodeURIComponent(r.PoNo || '')}|${r.LineNumber ?? ''}`;
  }

  // Compute per-row merge spans for cells that repeat across consecutive
  // rows. The first row of each run gets `span.X = N` (render cell with
  // rowspan=N); subsequent rows of the run get `skip.X = true` (omit cell
  // entirely so the rowspan above can claim the space). Scopes:
  //   GLOBAL  (Invoice/Supplier): runs of identical value across all rows.
  //   PER-INV (Carton/Dim/Weight): only when WITHIN same invoice — different
  //                                invoice with coincidentally-same carton
  //                                stays separate.
  // First-of-group rows also get isGroupStart=true so the CSS can draw a
  // thicker top border between invoice groups for visual separation.
  function computeMergeFlags(rows) {
    const flags = rows.map(() => ({ span: {}, skip: {} }));
    if (!rows.length) return flags;
    const sameStr = (a, b) =>
      a != null && b != null && String(a).trim() !== '' && String(a) === String(b);
    const sameNum = (a, b) =>
      a != null && b != null && String(a) === String(b);

    // FIELDS configures which columns merge + their scope.
    // scope='global' → merge wherever consecutive rows match.
    // scope='invoice' → merge only when run is also within same Invoice No.
    const FIELDS = [
      { key: 'InvoiceNo',    scope: 'global',  cmp: sameStr },
      { key: 'SupplierName', scope: 'global',  cmp: sameStr },
      { key: 'CartonNo',     scope: 'invoice', cmp: sameStr },
      { key: 'Dimension',    scope: 'invoice', cmp: sameStr },
      { key: 'WeightKg',     scope: 'invoice', cmp: sameNum },
    ];

    for (const f of FIELDS) {
      let runStart = 0;
      const closeRun = (endExclusive) => {
        const len = endExclusive - runStart;
        if (len > 1) {
          flags[runStart].span[f.key] = len;
          for (let k = runStart + 1; k < endExclusive; k++) flags[k].skip[f.key] = true;
        }
        runStart = endExclusive;
      };
      for (let i = 1; i < rows.length; i++) {
        const eq = f.cmp(rows[i - 1][f.key], rows[i][f.key]);
        const scopeOK = f.scope === 'global'
          ? true
          : sameStr(rows[i - 1].InvoiceNo, rows[i].InvoiceNo);
        if (!(eq && scopeOK)) closeRun(i);
      }
      closeRun(rows.length);
    }

    // Group-start = first row OR different invoice from previous.
    flags[0].isGroupStart = true;
    for (let i = 1; i < rows.length; i++) {
      if (!sameStr(rows[i - 1].InvoiceNo, rows[i].InvoiceNo)) flags[i].isGroupStart = true;
    }
    return flags;
  }

  // Helper: emit a cell with optional rowspan, OR an empty string when this
  // row should be skipped (a previous row's rowspan claims its slot).
  // Handles both `<td>` and `<td class="...">` by merging the merged-cell
  // class instead of producing a duplicate class attribute.
  function mergeCell(flags, key, html) {
    if (flags.skip && flags.skip[key]) return '';
    const span = flags.span && flags.span[key];
    if (!span || span <= 1) return html;
    if (/^<td\s+class="/i.test(html)) {
      // Merge our class into the existing class= attribute
      return html.replace(/^<td\s+class="/i, `<td rowspan="${span}" class="merged-cell `);
    }
    return html.replace(/^<td/, `<td rowspan="${span}" class="merged-cell"`);
  }

  function rowHtml(r, flags) {
    flags = flags || {};
    // 2026-06-18: warehouse user (Amit) also gets Edit + admin family for oversight.
    // Anyone else (e.g. other heads with read-only access) sees the 🔒 indicator.
    const canEdit = WH.canWrite() || WH.isAdminFamily();
    const key = keyOf(r);

    // Status → row tint (matches the warehouse lead's Apps Script colour code):
    //   Pending          → white (no tint)
    //   In Transit       → light yellow
    //   Received Material/ Partially Received → light yellow
    //   Received / Paid  → light green
    //   Cancelled        → light red + strikethrough
    const statusSlug = String(r.Status || 'pending').toLowerCase().replace(/\s+/g, '-');
    const trClass = `status-row status-${statusSlug}`;

    // Money / number formatters
    const num = (val, decs) => `<td class="num">${val == null || val === '' ? '' : WH.fmtN(val, decs)}</td>`;
    const txt = (val, extraClass = '') =>
      `<td${extraClass ? ` class="${extraClass}"` : ''}>${WH.esc(val ?? '')}</td>`;

    // Group-start gets a thicker top border so visually merged groups read
    // as a single block. Class added via trClass below.
    const groupStartClass = flags.isGroupStart ? ' group-start' : '';
    // Matrl. Recv Date display rule: only show a date when Status implies
    // physical receipt. Defensive on the frontend so legacy rows with stale
    // dates (saved before the backend gate was added) still render blank.
    const _statusLow = String(r.Status || '').toLowerCase().trim();
    const _showMatlDate = _statusLow === 'received' || _statusLow === 'received material';
    return `<tr class="${trClass}${groupStartClass}" data-row-key="${key}">
      <!-- 1: Matrl Received Date — blank unless Status=Received -->
      ${txt(_showMatlDate ? WH.fmtDate(r.MatlReceivedDate) : '')}
      <!-- 2: System No -->
      ${txt(r.SystemNo)}
      <!-- 3: Purchase Type -->
      ${txt(r.PurchaseType || 'Purchase')}
      <!-- 4: Invoice Date -->
      ${txt(WH.fmtDate(r.InvoiceDate))}
      <!-- 5: Invoice No — clickable when set, opens Invoice Summary modal -->
      ${mergeCell(flags, 'InvoiceNo',
        `<td>${r.InvoiceNo
          ? `<a href="#" class="invoice-link" data-inv="${WH.esc(r.InvoiceNo)}" title="Open invoice summary">${WH.esc(r.InvoiceNo)}</a>`
          : ''}</td>`)}
      <!-- 5a: Carton No (2026-06-24) -->
      ${mergeCell(flags, 'CartonNo', txt(r.CartonNo))}
      <!-- 6: NAV Supplier -->
      ${mergeCell(flags, 'SupplierName',
        `<td class="nav-col">${WH.esc(r.SupplierName || '')}</td>`)}
      <!-- 7: NAV CompanyB Po No -->
      <td class="nav-col"><b>${WH.esc(r.PoNo || '')}</b></td>
      <!-- 8: Po Received -->
      ${txt(r.PoReceived)}
      <!-- 9: NAV Item Name -->
      <td class="nav-col">${WH.esc(r.ItemName || '')}</td>
      <!-- 10: NAV Make -->
      <td class="nav-col">${WH.esc(r.Make || '')}</td>
      <!-- 11a: NAV Total Quantity -->
      <td class="num nav-col">${WH.fmt0(r.Quantity)}</td>
      <!-- 11b: Received Qty (manual, BN_WhPurchase.QuantityReceived) -->
      ${num(r.QuantityReceived, 0)}
      <!-- 11c: Outstanding Qty (computed) -->
      <td class="num">${WH.fmt0(r.OutstandingQuantity)}</td>
      <!-- 12: NAV Rate -->
      <td class="num nav-col">${WH.fmt2(r.Rate)}</td>
      <!-- 13: Base price -->
      <td class="num nav-col">${WH.fmt2(r.BasePriceLCY)}</td>
      <!-- 14: Base Total -->
      <td class="num nav-col">${WH.fmt2(r.BaseTotal)}</td>
      <!-- 15: Item Wise Value -->
      <td class="num nav-col">${WH.fmt2(r.ItemWiseValue)}</td>
      <!-- 16: Bank/Other Charges -->
      ${num(r.BankOtherCharges, 2)}
      <!-- 17: GST By Us (computed) -->
      ${num(r.GstPaidByUs, 2)}
      <!-- 18: GST By Supplier (computed) -->
      ${num(r.GstPaidBySupplier, 2)}
      <!-- 19: Net Invoice Value (computed) -->
      ${num(r.NetInvoiceValue, 2)}
      <!-- 19a: Status — moved 2026-06-24 (was between Payment Terms and Paid Date) -->
      <td>${WH.pill(r.Status)}</td>
      <!-- 20: Dimension -->
      ${mergeCell(flags, 'Dimension', txt(r.Dimension))}
      <!-- 21: Weight (kg) -->
      ${mergeCell(flags, 'WeightKg', num(r.WeightKg, 3))}
      <!-- 22: COO -->
      ${txt(r.COO)}
      <!-- 23: Received Through -->
      ${txt(r.ReceivedThrough)}
      <!-- 24: AWB -->
      ${txt(r.AirWaybillNo)}
      <!-- 25: NAV Currency -->
      <td class="nav-col">${WH.esc(r.Currency || '')}</td>
      <!-- 26: NAV Payment Terms -->
      <td class="nav-col">${WH.esc(r.PaymentTerms || '')}</td>
      <!-- 28: Paid Date (Status moved up — see 19a) -->
      ${txt(WH.fmtDate(r.PaidDate))}
      <!-- 29: Freight SGD -->
      ${num(r.FreightSGD, 2)}
      <!-- 30: GST Acc Freight (computed) -->
      ${num(r.GstAccFreight, 2)}
      <!-- 31: GST Freight Status -->
      ${txt(r.GSTFreightStatus)}
      <!-- 32: Freight/Kg -->
      ${num(r.FreightSGDPerKg, 4)}
      <!-- 33: Total FF Charges -->
      ${num(r.TotalFFCharges, 2)}
      <!-- 34: FF/Courier Invoice No -->
      ${txt(r.InvoiceNoFFCourier)}
      <!-- 35: Local Charges -->
      ${num(r.LocalCharges, 2)}
      <!-- 36: Permit No -->
      ${txt(r.PermitNo)}
      <!-- 37: Import Permit Type -->
      ${txt(r.ImportPermitType)}
      <!-- 38: GST Claimed Month -->
      ${txt(r.GSTClaimedMonth)}
      <!-- 39: Edit button (warehouse + admin family) -->
      <td class="actions-col">${canEdit
        ? `<button class="row-edit" data-action="edit" data-id="${r.Id || r.BnId || ''}" title="Edit this row">✎ Edit</button>`
        : '<span class="row-locked" title="View-only">🔒</span>'}</td>
    </tr>`;
  }

  // ── Outstanding = Total − Received (live in the row) ──────────────────
  // Outstanding is read-only and computed at query time on the server, but
  // we recompute in the browser as Amit types so he sees the running balance
  // before he hits 💾 Save. Server still owns the canonical value on reload.
  function wireOutstandingRecompute(tbody) {
    tbody.querySelectorAll('input[data-field="QuantityReceived"]').forEach((inp) => {
      const recompute = () => {
        const tr = inp.closest('tr');
        if (!tr) return;
        const td = tr.querySelector('[data-field-display="OutstandingQuantity"]');
        if (!td) return;
        const total = Number(td.dataset.total || 0);
        const recv  = Number(inp.value || 0);
        const out   = total - recv;
        td.textContent = WH.fmt0(out);
        // Red-tint when over-received (data entry error) so Amit notices
        td.style.color = out < 0 ? '#dc2626' : '';
      };
      inp.addEventListener('input',  recompute);
      inp.addEventListener('change', recompute);
    });
  }

  // ── Status → Matrl. Received Date auto-fill + Stocks modal trigger ────
  // Per user (2026-06-10): when Amit sets Status to "Received Material" /
  // "Received", (a) stamp today's date into Matrl. Recv Date if blank, and
  // (b) open the "Add Received Material to Stocks" modal so the cartons
  // can be created in one go. "Partially Received" does NOT trigger.
  // Re-trigger guard: each row tracks `data-stocked-at` once the modal has
  // been opened so toggling status back and forth doesn't keep re-popping.
  function wireStatusAutoFillDate(tbody) {
    tbody.querySelectorAll('input[data-field="Status"]').forEach((statusInp) => {
      statusInp.addEventListener('change', () => {
        const v = (statusInp.value || '').trim().toLowerCase();
        const isReceivedFull = v === 'received' || v === 'received material';
        if (!isReceivedFull) return;
        const tr = statusInp.closest('tr');
        if (!tr) return;
        // (a) Date auto-stamp
        const dateInp = tr.querySelector('input[data-field="MatlReceivedDate"]');
        if (dateInp && !dateInp.value) {
          const iso = new Date().toISOString().slice(0, 10);
          dateInp.value = iso;
          dateInp.style.background = '#fef9c3';
          setTimeout(() => { dateInp.style.background = ''; }, 1500);
        }
        // (b) Stocks modal — only once per row per session unless reset
        if (tr.dataset.stockedAt) return;
        const key = tr.dataset.rowKey;
        if (key) openReceiveToStocksModal(key);
      });
    });
  }

  // ── Receive-to-Stocks modal ────────────────────────────────────────────
  // Modal lifecycle: open prefills item details (read-only) + a single
  // carton row with QtyPcs = max(ManualQuantityReceived, NAVQuantity).
  // Amit can "+ Add carton" to split, click "Equal divide" to split the
  // total across N rows, then 💾 Save → POST /warehouse/stocks/from-po-receipt.
  let _activeKey = null;

  function wireReceiveModal() {
    const overlay = document.getElementById('receiveModal');
    if (!overlay) return;
    document.getElementById('rmClose').onclick  = () => closeReceiveModal(false);
    document.getElementById('rmCancel').onclick = () => closeReceiveModal(false);
    document.getElementById('rmSave').onclick   = saveReceiveModal;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeReceiveModal(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeReceiveModal(false);
    });
  }

  function openReceiveToStocksModal(key) {
    const r = _rowsByKey.get(key);
    if (!r) return;
    _activeKey = key;
    const tr = document.querySelector(`tr[data-row-key="${CSS.escape(key)}"]`);
    const recvInp = tr ? tr.querySelector('input[data-field="QuantityReceived"]') : null;
    const invInp  = tr ? tr.querySelector('input[data-field="InvoiceNo"]')        : null;
    const liveRecv = recvInp ? Number(recvInp.value || 0) : 0;
    const totalQty = Number(r.Quantity || 0);
    const defaultQty = liveRecv > 0 ? liveRecv : totalQty;
    // MPN used to look up existing cartons for this item — same key the
    // backend's by-mpn endpoint expects (the value stored in BN_WhStock.MPN).
    const mpn = (r.ItemName || r.ItemCode || '').trim();

    const body = document.getElementById('rmBody');
    body.innerHTML = `
      <div class="rm-grid">
        <label>PO No</label>           <div class="rm-readonly">${WH.esc(r.PoNo)} <span style="opacity:.6">L${r.LineNumber}</span></div>
        <label>Supplier</label>        <div class="rm-readonly">${WH.esc(r.SupplierName || '—')}</div>
        <label>MPN (Item)</label>      <div class="rm-readonly">${WH.esc(mpn || '—')}</div>
        <label>Make</label>            <div class="rm-readonly">${WH.esc(r.Make || '—')}</div>
        <label>Invoice No</label>      <div class="rm-readonly">${WH.esc((invInp && invInp.value) || '—')}</div>
        <label>Total Qty (NAV)</label> <div class="rm-readonly">${(Number(totalQty) || 0).toLocaleString()}</div>
        <label>Receiving now</label>   <div class="rm-readonly" id="rmRecvSum">${(Number(defaultQty) || 0).toLocaleString()}</div>
      </div>

      <!-- Existing cartons section — populated async on modal open. -->
      <div class="rm-existing" id="rmExisting">
        <h4>Existing cartons for this item <span style="opacity:.6;font-weight:400;" id="rmExistingCount">(checking…)</span></h4>
        <div id="rmExistingBody" class="rm-existing-body">
          <div style="opacity:.6;padding:8px 0;">Loading…</div>
        </div>
      </div>

      <div class="rm-cartons">
        <h4>Cartons to add (${(Number(defaultQty) || 0).toLocaleString()} pcs total)</h4>
        <table>
          <thead><tr>
            <th style="width:38%">Carton No</th>
            <th style="width:25%">Qty (pcs)</th>
            <th style="width:30%">New Location</th>
            <th style="width:7%"></th>
          </tr></thead>
          <tbody id="rmCartonRows"></tbody>
        </table>
        <div class="rm-actions">
          <button class="btn btn-ghost btn-sm" id="rmAddCarton">+ Add carton</button>
          <button class="btn btn-ghost btn-sm" id="rmEqualDivide" title="Split the total qty equally across all carton rows">≈ Equal divide</button>
        </div>
        <div class="rm-warn" id="rmWarn" hidden></div>
      </div>
    `;
    addCartonRow({ QtyPcs: defaultQty });
    document.getElementById('rmAddCarton').onclick = () => addCartonRow({ QtyPcs: 0 });
    document.getElementById('rmEqualDivide').onclick = equalDivide;

    if (tr) tr.dataset.stockedAt = String(Date.now());

    document.getElementById('receiveModal').hidden = false;

    // Fire off the existing-cartons + location-list lookups in parallel.
    // Both are informational; modal renders fine even if they fail.
    loadExistingCartons(mpn);
    loadLocationList();
  }

  // ── Load existing cartons for the modal's MPN ──────────────────────────
  // Backend GET /api/warehouse/stocks/by-mpn/:mpn returns up to 50 active
  // BN_WhStock rows matching MPN. Render them as a small table so Amit can
  // visually decide: "this carton already has 15000 in BIN-A2 — I'll close
  // and add to it manually" vs "create new cartons here".
  async function loadExistingCartons(mpn) {
    const countEl = document.getElementById('rmExistingCount');
    const bodyEl  = document.getElementById('rmExistingBody');
    if (!bodyEl) return;
    if (!mpn) {
      countEl.textContent = '(no MPN on this row)';
      bodyEl.innerHTML = '';
      return;
    }
    try {
      const res = await apiRequest('/warehouse/stocks/by-mpn/' + encodeURIComponent(mpn));
      const rows = (res && res.data) || [];
      countEl.textContent = `(${rows.length} found)`;
      if (!rows.length) {
        bodyEl.innerHTML = `<div style="opacity:.6;padding:8px 0;">No cartons exist yet for this item — adding new below is the only option.</div>`;
        return;
      }
      bodyEl.innerHTML = `
        <table>
          <thead><tr>
            <th>Carton No</th>
            <th>Location</th>
            <th style="text-align:right;">Qty</th>
            <th>Invoice No</th>
            <th>Status</th>
            <th>Source PO</th>
          </tr></thead>
          <tbody>
            ${rows.map(c => `
              <tr>
                <td><b>${WH.esc(c.CartonNo || '—')}</b></td>
                <td>${WH.esc(c.NewLocation || c.Location || '—')}</td>
                <td style="text-align:right;">${(Number(c.QtyPcs) || 0).toLocaleString()}</td>
                <td>${WH.esc(c.InvoiceNo || '—')}</td>
                <td>${WH.esc(c.Status || '—')}</td>
                <td>${c.SourcePoNo ? WH.esc(c.SourcePoNo) + ' L' + (c.SourcePoLine || '?') : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="margin-top:6px;font-size:.85rem;opacity:.7;">
          If you'd rather add this material into one of the cartons above,
          close this dialog and edit that carton's Qty on the Stocks page.
        </div>
      `;
    } catch (err) {
      countEl.textContent = '(lookup failed)';
      bodyEl.innerHTML = `<div style="color:#b91c1c;padding:8px 0;">${WH.esc(err.message || 'failed')}</div>`;
    }
  }

  // Location-list datalist — fetched once per session-cached on first open.
  let _locationList = null;
  async function loadLocationList() {
    const dl = document.getElementById('dl-stock-location');
    if (!dl) return;
    if (_locationList !== null) { paintLocationDatalist(); return; }
    try {
      const res = await apiRequest('/warehouse/stocks/location-list');
      _locationList = (res && res.data) || [];
      paintLocationDatalist();
    } catch (_) { _locationList = []; }
  }
  function paintLocationDatalist() {
    const dl = document.getElementById('dl-stock-location');
    if (!dl) return;
    dl.innerHTML = (_locationList || []).map(x => `<option value="${WH.esc(x)}">`).join('');
  }

  function addCartonRow({ CartonNo = '', QtyPcs = 0, NewLocation = '' } = {}) {
    const tbody = document.getElementById('rmCartonRows');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" class="rm-carton" list="dl-carton-no" value="${WH.esc(CartonNo)}" placeholder="pick existing or type new"></td>
      <td><input type="number" class="rm-qty" min="0" step="1" value="${Number(QtyPcs) || 0}"></td>
      <td><input type="text" class="rm-loc" list="dl-stock-location" value="${WH.esc(NewLocation)}" placeholder="pick existing or type new"></td>
      <td><button class="rm-remove" title="Remove this carton" type="button">✕</button></td>
    `;
    tbody.appendChild(tr);
    tr.querySelector('.rm-remove').onclick = () => { tr.remove(); recomputeSum(); };
    tr.querySelector('.rm-qty').addEventListener('input', recomputeSum);
    recomputeSum();
  }

  function equalDivide() {
    const rows = document.querySelectorAll('#rmCartonRows tr');
    if (!rows.length) return;
    const totalInp = document.getElementById('rmRecvSum');
    const total = Number((totalInp.textContent || '0').replace(/[^\d.-]/g, '')) || 0;
    if (!total) return;
    const base = Math.floor(total / rows.length);
    const remainder = total - base * rows.length;
    rows.forEach((tr, i) => {
      tr.querySelector('.rm-qty').value = base + (i === 0 ? remainder : 0);
    });
    recomputeSum();
  }

  function recomputeSum() {
    const rows = document.querySelectorAll('#rmCartonRows tr');
    let sum = 0;
    rows.forEach(tr => { sum += Number(tr.querySelector('.rm-qty').value || 0); });
    const warn = document.getElementById('rmWarn');
    const target = Number((document.getElementById('rmRecvSum').textContent || '0').replace(/[^\d.-]/g, '')) || 0;
    if (warn) {
      if (sum !== target) {
        warn.hidden = false;
        warn.textContent = `⚠ Cartons sum to ${sum.toLocaleString()}, but Receiving now is ${target.toLocaleString()}. You can still save — the remainder stays open for a future receipt.`;
      } else {
        warn.hidden = true;
      }
    }
  }

  function closeReceiveModal(saved) {
    const overlay = document.getElementById('receiveModal');
    if (overlay) overlay.hidden = true;
    if (!saved && _activeKey) {
      // User cancelled — clear the re-trigger guard so they can try again
      const tr = document.querySelector(`tr[data-row-key="${CSS.escape(_activeKey)}"]`);
      if (tr) delete tr.dataset.stockedAt;
    }
    _activeKey = null;
  }

  async function saveReceiveModal() {
    if (!_activeKey) return;
    const r = _rowsByKey.get(_activeKey);
    if (!r) { WH.toast('Row context lost — close the modal and try again', 'error'); return; }
    const cartons = [];
    document.querySelectorAll('#rmCartonRows tr').forEach(tr => {
      const CartonNo = tr.querySelector('.rm-carton').value.trim();
      const QtyPcs   = Number(tr.querySelector('.rm-qty').value || 0);
      const NewLoc   = tr.querySelector('.rm-loc').value.trim();
      if (QtyPcs > 0) cartons.push({ CartonNo, QtyPcs, NewLocation: NewLoc || null });
    });
    if (!cartons.length) { WH.toast('Add at least one carton with qty > 0', 'error'); return; }
    if (cartons.some(c => !c.CartonNo)) { WH.toast('Every carton needs a Carton No', 'error'); return; }

    const saveBtn = document.getElementById('rmSave');
    saveBtn.disabled = true; saveBtn.textContent = '⏳ Saving…';
    try {
      const res = await apiRequest('/warehouse/stocks/from-po-receipt', {
        method: 'POST',
        body: { PoNo: r.PoNo, LineNumber: r.LineNumber, cartons },
      });
      if (res && res.ok) {
        WH.toast(`✅ ${res.inserted} carton${res.inserted === 1 ? '' : 's'} added to Stocks` +
                 (res.ileLinked ? '' : ' (ILE link pending Pune Purchase Receipt)'), 'success');
        // Refresh the carton list so newly-added cartons show up in the
        // datalist suggestions on the next modal open.
        apiRequest('/warehouse/stocks/carton-list')
          .then(rr => { _cartonList = (rr && rr.data) || []; refreshCartonDatalist(); })
          .catch(() => {});
        closeReceiveModal(true);
      } else {
        WH.toast(res?.message || 'Save failed', 'error');
      }
    } catch (err) {
      WH.toast(err.message || 'Save failed', 'error');
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = '💾 Add to Stocks';
    }
  }

  async function saveRow(key) {
    const tr = document.querySelector(`tr[data-row-key="${CSS.escape(key)}"]`);
    if (!tr) { WH.toast('Row not found', 'error'); return; }
    const navRow = _rowsByKey.get(key);
    if (!navRow) { WH.toast('NAV row missing — reload page', 'error'); return; }

    // Gather all inputs/selects inside this row
    const payload = { PoNo: navRow.PoNo, LineNumber: navRow.LineNumber };
    tr.querySelectorAll(`[data-field]`).forEach(el => {
      const name = el.dataset.field;
      let v;
      if (el.tagName === 'SELECT') {
        v = el.value === '' ? null : el.value;
      } else if (el.type === 'number') {
        v = el.value === '' ? null : Number(el.value);
      } else {
        // text / date / datalist-input — store string (or null when blank)
        v = el.value === '' ? null : el.value;
      }
      payload[name] = v;
    });

    const btn = tr.querySelector('button[data-action="save"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      const r = await apiRequest(ENDPOINT, { method: 'POST', body: payload });
      if (r && r.ok) {
        if (btn) { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '💾'; btn.disabled = false; }, 1200); }
        tr.classList.remove('untracked');
        tr.classList.add('tracked');
        // Refresh page so computed/NAV totals reflect new manual values
        setTimeout(() => load(), 800);
      } else {
        WH.toast(r?.message || 'Save failed', 'error');
        if (btn) { btn.textContent = '💾'; btn.disabled = false; }
      }
    } catch (err) {
      WH.toast(err.message || 'Save failed', 'error');
      if (btn) { btn.textContent = '💾'; btn.disabled = false; }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Carton-wise ASN wizard (2026-06-24 rewrite)
  //
  // 2 steps: Vendor → Cartons & Lines. The Cartons & Lines screen lets
  // the user pick any PO of the vendor, tick lines, assign them to a
  // carton (CTN-YY-NNNN), then SWITCH to another PO and repeat. Picked
  // lines accumulate in _wiz.cart keyed by PoNo::LineNumber, each with
  // its own CartonNo + per-line values. Save iterates the whole cart.
  // ──────────────────────────────────────────────────────────────────────
  let _wiz = null;
  // _wiz shape:
  //   vendor       — picked vendor row
  //   allPos       — POs for this vendor (from /pos-by-vendor)
  //   currentPo    — currently active PO in the picker
  //   currentLines — lines for currentPo
  //   cart         — Map<`${PoNo}::${LineNumber}`, cartItem>
  //   stockHints   — Map<MPN, hintArray>  (cached so MPN lookups don't refire)
  //   nextCartonNo — last value fetched from /next-carton-no (suggestion)

  function wireWizard() {
    const addBtn = document.getElementById('whAdd');
    if (addBtn && WH.canWrite()) {
      addBtn.style.display = '';
      addBtn.textContent = '+ New ASN / Shipment';
      addBtn.onclick = openWizard;
    }
    const overlay = document.getElementById('wizModal');
    if (!overlay) return;

    document.getElementById('wizClose').onclick  = closeWizard;
    document.getElementById('wizCancel').onclick = closeWizard;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWizard(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeWizard();
    });

    document.getElementById('wizBackTo1').onclick = () => wizGo(1);

    // Step 1 — vendor search (debounced)
    document.getElementById('wizVendorSearch')
      .addEventListener('input', debounce(searchVendors, 300));

    // Step 2 — PO dropdown change + filter input
    document.getElementById('wizPoSelect').addEventListener('change', onPoSelected);
    document.getElementById('wizPoFilter').addEventListener('input', debounce(filterPoDropdown, 150));

    // Step 2 — select-all checkbox for currently loaded PO's lines
    document.getElementById('wizSelAll').onchange = (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('#wizLineBody input[type=checkbox][data-line]').forEach(cb => {
        cb.checked = checked;
        toggleLineInCart(cb);
      });
    };

    // Step 2 — Next-carton button bumps the suggestion via backend
    document.getElementById('wizNextCarton').onclick = bumpCartonSuggestion;

    document.getElementById('wizSave').onclick = saveWizard;

    // Pricing-preview recompute on charges / GST flag change
    ['wizCharges', 'wizGstByUs'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', recomputePricingPreview);
      if (el) el.addEventListener('change', recomputePricingPreview);
    });
  }

  function recomputePricingPreview() {
    if (!_wiz) return;
    let valueSum = 0;
    _wiz.cart.forEach((item) => {
      const qty = Number(item.QuantityReceived != null ? item.QuantityReceived : item.Quantity || 0);
      valueSum += qty * Number(item.Rate || 0);
    });
    const charges = Number(document.getElementById('wizCharges').value) || 0;
    const usPaysGst = document.getElementById('wizGstByUs').checked;
    const gstUs  = usPaysGst ? +(valueSum * 0.09).toFixed(2) : 0;
    const gstSup = !usPaysGst ? +((valueSum + charges) * 0.09).toFixed(2) : 0;
    const finalAmt = +(valueSum + charges + gstSup).toFixed(2);
    document.getElementById('wizGstUsPreview').value  = gstUs.toFixed(2);
    document.getElementById('wizGstSupPreview').value = gstSup.toFixed(2);
    document.getElementById('wizFinalPreview').value  = finalAmt.toFixed(2);
  }

  function openWizard() {
    _wiz = {
      vendor: null, allPos: [], currentPo: null, currentLines: [],
      cart: new Map(), stockHints: new Map(), nextCartonNo: '',
      // Per-carton details: Map<CartonNo, {Dimension, WeightKg}>. Populated
      // by the user via the 📐 Per-Carton Details section + propagation popup.
      cartonDetails: new Map(),
      dimPropagatePromptShown: false,
      wtPropagatePromptShown:  false,
    };
    document.getElementById('wizVendorSearch').value = '';
    document.getElementById('wizVendorBody').innerHTML = '';
    document.getElementById('wizVendorTable').hidden = true;
    document.getElementById('wizVendorHint').textContent = 'Start typing to search vendors that have POs.';
    document.getElementById('wizVendorChip').textContent = '—';
    document.getElementById('wizPoSelect').innerHTML = '<option value="">— select a PO —</option>';
    document.getElementById('wizPoFilter').value = '';
    document.getElementById('wizPoHint').textContent = '';
    document.getElementById('wizLineBody').innerHTML =
      '<tr><td colspan="11" class="wh-empty">Pick a PO above to load its lines.</td></tr>';
    document.getElementById('wizCartBody').innerHTML =
      '<tr><td colspan="10" class="wh-empty">No lines selected yet.</td></tr>';
    document.getElementById('wizCartCount').textContent = '0 lines · 0 cartons';
    document.getElementById('wizCartonNo').value = '';
    document.getElementById('wizDupWarn').hidden = true;
    // Invoice Info defaults
    document.getElementById('wizInvDate').value      = '';
    document.getElementById('wizInvNo').value        = '';
    document.getElementById('wizSupplier').value     = '';
    document.getElementById('wizCurrency').value     = '';
    document.getElementById('wizPayTerms').value     = '';
    document.getElementById('wizIncoterms').value    = 'FOB';
    // Material Recv Date is BLANK by default — only filled when material
    // physically arrives. New entries save as Status='Pending' so the date
    // would be ignored anyway. Amit sets it later when status flips to Received.
    document.getElementById('wizMatlDate').value     = '';
    // Pricing
    document.getElementById('wizCharges').value      = '0';
    document.getElementById('wizGstByUs').checked    = false;
    document.getElementById('wizGstUsPreview').value = '0.00';
    document.getElementById('wizGstSupPreview').value = '0.00';
    document.getElementById('wizFinalPreview').value = '0.00';
    // Carton & Logistics (per-carton Dim/Weight in their own section below)
    document.getElementById('wizNoOfCartons').value  = '0';
    document.getElementById('wizCoo').value          = '';
    document.getElementById('wizRcvThrough').value   = '';
    document.getElementById('wizAwb').value          = '';
    document.getElementById('wizCartonDetailsWrap').innerHTML =
      '<div class="carton-details-empty">Add lines to the cart above — per-carton inputs appear here automatically.</div>';
    document.getElementById('wizSelAll').checked     = false;
    wizGo(1);
    document.getElementById('wizModal').hidden = false;
    setTimeout(() => document.getElementById('wizVendorSearch').focus(), 50);
  }

  function closeWizard() {
    document.getElementById('wizModal').hidden = true;
    _wiz = null;
  }

  function wizGo(step) {
    [1, 2].forEach(n => {
      const sec = document.getElementById('wizStep' + n);
      if (sec) sec.hidden = (n !== step);
      const indicator = document.querySelector(`.wiz-step[data-step="${n}"]`);
      if (indicator) indicator.classList.toggle('is-active', n === step);
    });
    document.getElementById('wizTitle').textContent =
      `New ASN / Shipment — Step ${step} of 2`;
    const saveBtn = document.getElementById('wizSave');
    if (saveBtn) {
      saveBtn.hidden = (step !== 2);
      const n = _wiz ? _wiz.cart.size : 0;
      saveBtn.disabled = (step !== 2 || n === 0);
    }
  }

  async function searchVendors() {
    const q = document.getElementById('wizVendorSearch').value.trim();
    const tbody = document.getElementById('wizVendorBody');
    const tbl   = document.getElementById('wizVendorTable');
    const hint  = document.getElementById('wizVendorHint');
    if (q.length < 2) {
      tbody.innerHTML = '';
      tbl.hidden = true;
      hint.textContent = 'Start typing to search vendors that have POs.';
      return;
    }
    hint.textContent = 'Searching…';
    try {
      const r = await apiRequest('/warehouse/purchase/vendor-suggest?q=' + encodeURIComponent(q));
      const rows = (r && r.data) || [];
      if (!rows.length) {
        tbl.hidden = true;
        hint.textContent = 'No vendors with POs match that search.';
        return;
      }
      tbl.hidden = false;
      hint.textContent = `${rows.length} vendor${rows.length === 1 ? '' : 's'} matched.`;
      tbody.innerHTML = rows.map(v => `
        <tr data-code="${WH.esc(v.VendorCode)}">
          <td><strong>${WH.esc(v.VendorCode)}</strong></td>
          <td>${WH.esc(v.SupplierName)}</td>
          <td>${WH.esc(v.VendorCountry)}</td>
          <td>${WH.esc(v.DefaultCurrency || '')}</td>
          <td class="num">${v.PoCount}</td>
        </tr>`).join('');
      tbody.querySelectorAll('tr').forEach(tr => {
        tr.onclick = () => {
          const row = rows.find(x => String(x.VendorCode) === tr.dataset.code);
          pickVendor(row);
        };
      });
    } catch (err) {
      hint.textContent = err.message || 'Vendor lookup failed.';
      tbl.hidden = true;
    }
  }

  // Vendor picked → jump straight to Step 2, fetch carton suggestion + PO
  // list in parallel. NOTE: skips the old single-PO Step 2 entirely.
  async function pickVendor(vendor) {
    _wiz.vendor = vendor;
    _wiz.cart   = new Map();
    document.getElementById('wizVendorChip').textContent =
      `${vendor.VendorCode} · ${vendor.SupplierName}`;
    // Auto-fill Invoice Info from vendor context
    document.getElementById('wizSupplier').value = vendor.SupplierName || '';
    document.getElementById('wizCurrency').value = vendor.DefaultCurrency || '';
    document.getElementById('wizPayTerms').value = vendor.PaymentTerms || '';
    document.getElementById('wizGstByUs').checked =
      (vendor.VendorCountry || '').toUpperCase() !== 'SG';
    wizGo(2);
    document.getElementById('wizPoHint').textContent = 'Loading POs…';
    document.getElementById('wizPoSelect').innerHTML = '<option value="">Loading…</option>';
    // Parallel: PO list + next-carton-no suggestion
    const [posRes, cartonRes] = await Promise.all([
      apiRequest('/warehouse/purchase/pos-by-vendor/' + encodeURIComponent(vendor.VendorCode))
        .catch(err => ({ error: err.message })),
      apiRequest('/warehouse/purchase/next-carton-no')
        .catch(() => ({ nextCartonNo: 'CTN-' + String(new Date().getFullYear()).slice(-2) + '-0001' })),
    ]);
    if (posRes.error) {
      document.getElementById('wizPoSelect').innerHTML = '<option value="">— failed —</option>';
      document.getElementById('wizPoHint').textContent = posRes.error;
      return;
    }
    _wiz.allPos = (posRes && posRes.data) || [];
    _wiz.nextCartonNo = cartonRes.nextCartonNo;
    document.getElementById('wizCartonNo').value = _wiz.nextCartonNo;
    paintPoDropdown(_wiz.allPos);
  }

  function paintPoDropdown(pos) {
    const sel = document.getElementById('wizPoSelect');
    const hint = document.getElementById('wizPoHint');
    if (!pos.length) {
      sel.innerHTML = '<option value="">— no POs —</option>';
      hint.textContent = 'No POs for this vendor.';
      return;
    }
    // Source label: Open / Partial (some lines posted) / Posted (fully received)
    const sourceLabel = (s) =>
        s === 'PARTIAL' ? 'Partial'
      : s === 'POSTED'  ? 'Posted'
      :                   'Open';
    sel.innerHTML = '<option value="">— select a PO —</option>' + pos.map(p => `
      <option value="${WH.esc(p.PoNo)}">${WH.esc(p.PoNo)} · ${fmtDate(p.OrderDate)} · ${p.LineCount}L · ${WH.esc(p.Currency || '')} · ${sourceLabel(p.Source)}</option>
    `).join('');
    // Summarize counts in the hint so Amit knows how the dropdown breaks down
    const counts = { OPEN: 0, PARTIAL: 0, POSTED: 0 };
    pos.forEach(p => { counts[p.Source] = (counts[p.Source] || 0) + 1; });
    const parts = [];
    if (counts.OPEN)    parts.push(`${counts.OPEN} open`);
    if (counts.PARTIAL) parts.push(`${counts.PARTIAL} partial`);
    if (counts.POSTED)  parts.push(`${counts.POSTED} posted`);
    hint.textContent = `${pos.length} PO${pos.length === 1 ? '' : 's'} for this vendor (${parts.join(' · ')})`;
  }

  function filterPoDropdown() {
    if (!_wiz || !_wiz.allPos) return;
    const q = document.getElementById('wizPoFilter').value.trim().toLowerCase();
    const filtered = q
      ? _wiz.allPos.filter(p => String(p.PoNo || '').toLowerCase().includes(q))
      : _wiz.allPos;
    paintPoDropdown(filtered);
  }

  async function onPoSelected() {
    const sel = document.getElementById('wizPoSelect');
    const poNo = sel.value;
    if (!poNo) {
      _wiz.currentPo = null;
      _wiz.currentLines = [];
      document.getElementById('wizLineBody').innerHTML =
        '<tr><td colspan="11" class="wh-empty">Pick a PO above to load its lines.</td></tr>';
      return;
    }
    const po = _wiz.allPos.find(p => String(p.PoNo) === String(poNo));
    if (!po) return;
    _wiz.currentPo = po;
    const tbody = document.getElementById('wizLineBody');
    tbody.innerHTML = '<tr><td colspan="11" class="wh-loading">Loading lines…</td></tr>';
    // Also pull already-tracked rows so we can mark them in the picker
    try {
      const [linesRes, existingRes] = await Promise.all([
        apiRequest('/warehouse/purchase/po-lines/' + encodeURIComponent(po.PoNo)),
        apiRequest(ENDPOINT + WH.qs({ search: po.PoNo, limit: 200, days: 1825 }))
          .catch(() => ({ data: [] })),
      ]);
      const lines = (linesRes && linesRes.data) || [];
      const trackedRows = ((existingRes && existingRes.data) || [])
        .filter(r => String(r.PoNo) === String(po.PoNo) && r.IsTracked);
      const trackedByLine = new Map(trackedRows.map(r => [String(r.LineNumber), r]));
      _wiz.currentLines = lines;
      if (!lines.length) {
        tbody.innerHTML = '<tr><td colspan="11" class="wh-empty">No lines on this PO.</td></tr>';
        return;
      }
      // Cache tracked rows in _rowsByKey for openEditModal callers later
      for (const r of trackedRows) _rowsByKey.set(keyOf(r), r);
      renderLinePicker(lines, trackedByLine);
      // Already-tracked banner (non-blocking — no popup, just inline notice)
      if (trackedByLine.size > 0) {
        const dw = document.getElementById('wizDupWarn');
        dw.textContent = `ℹ ${trackedByLine.size} line${trackedByLine.size === 1 ? '' : 's'} on this PO already tracked — re-saving them will UPSERT (update).`;
        dw.hidden = false;
      } else {
        document.getElementById('wizDupWarn').hidden = true;
      }
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="11" class="wh-empty">${WH.esc(err.message || 'Line lookup failed')}</td></tr>`;
    }
  }

  function renderLinePicker(lines, trackedByLine) {
    const tbody = document.getElementById('wizLineBody');
    tbody.innerHTML = lines.map((l) => {
      const ln = String(l.LineNumber);
      const cartKey = cartKeyOf(_wiz.currentPo.PoNo, ln);
      const inCart = _wiz.cart.has(cartKey);
      const cartItem = _wiz.cart.get(cartKey);
      const tracked = trackedByLine.get(ln);
      const dupTag = tracked ? ' <span style="color:#dc2626;font-size:.8em">· already tracked</span>' : '';
      const vinExplicit = (l.VendorItemNo || '').trim();
      const vinDisplay = vinExplicit
        ? `<strong>${WH.esc(vinExplicit)}</strong>`
        : `<em title="Vendor Item No_ blank in NAV — showing Item No" style="opacity:.7">${WH.esc(l.ItemNo || '—')}</em>`;
      // Pre-fill: cart wins, then tracked, then defaults
      const recdQtyVal = inCart && cartItem.QuantityReceived != null ? cartItem.QuantityReceived
                       : tracked && tracked.QuantityReceived != null ? tracked.QuantityReceived : '';
      const netWtVal   = inCart && cartItem.NetWeightKg != null ? cartItem.NetWeightKg
                       : tracked && tracked.NetWeightKg != null ? tracked.NetWeightKg : '';
      const datecodeVal = inCart && cartItem.Datecode != null ? cartItem.Datecode
                        : tracked && tracked.Datecode != null ? tracked.Datecode : '';
      const lotNoVal    = inCart && cartItem.LotNo    != null ? cartItem.LotNo
                        : tracked && tracked.LotNo    != null ? tracked.LotNo    : '';
      const qtyDefault  = Number(l.Quantity || 0).toFixed(2);
      const mpn = vinExplicit || l.ItemName || l.ItemNo || '';
      return `
        <tr data-line="${WH.esc(ln)}" class="${inCart ? 'is-incart' : ''}">
          <td class="wiz-cb-col"><input type="checkbox" data-line="${WH.esc(ln)}" ${inCart ? 'checked' : ''} /></td>
          <td>${WH.esc(ln)}</td>
          <td>${vinDisplay}</td>
          <td>${WH.esc(l.ItemName || '')}${dupTag}</td>
          <td class="num">${qtyDefault}</td>
          <td class="cell-input"><input type="number" class="num" data-line-field="QuantityReceived" data-line="${WH.esc(ln)}" min="0" step="0.01" placeholder="${qtyDefault}" value="${recdQtyVal}" /></td>
          <td class="num">${Number(l.Rate || 0).toFixed(2)}</td>
          <td class="cell-input"><input type="number" class="num" data-line-field="NetWeightKg" data-line="${WH.esc(ln)}" min="0" step="0.001" value="${netWtVal}" /></td>
          <td class="cell-input"><input type="text" data-line-field="Datecode" data-line="${WH.esc(ln)}" maxlength="30" placeholder="YYWW" value="${WH.esc(datecodeVal)}" /></td>
          <td class="cell-input"><input type="text" data-line-field="LotNo" data-line="${WH.esc(ln)}" maxlength="50" value="${WH.esc(lotNoVal)}" /></td>
          <td><span class="wiz-stock-hint" data-stock-mpn="${WH.esc(mpn)}">…</span></td>
        </tr>`;
    }).join('');

    // Wire checkbox toggle → cart in/out
    tbody.querySelectorAll('input[type=checkbox][data-line]').forEach(cb => {
      cb.onchange = () => toggleLineInCart(cb);
    });
    // Wire per-line input change → keep cart item in sync if line is in cart
    tbody.querySelectorAll('input[data-line-field]').forEach(inp => {
      inp.addEventListener('input', () => syncCartFromRow(inp));
    });
    // Fire stock hints for each unique MPN on this PO
    tbody.querySelectorAll('span[data-stock-mpn]').forEach(loadStockHint);
    document.getElementById('wizSelAll').checked = false;
  }

  // Cart key. splitId is appended only for split-clones; the base entry
  // (the one that was first ticked from the line picker) has no splitId so
  // it can still be located by the toggleLineInCart checkbox handler.
  function cartKeyOf(poNo, ln, splitId) {
    return splitId ? `${poNo}::${ln}::${splitId}` : `${poNo}::${ln}`;
  }

  // Tick/untick checkbox → add or remove the line from the cart.
  // CartonNo = whatever's currently typed in the carton bar.
  function toggleLineInCart(cb) {
    if (!_wiz || !_wiz.currentPo) return;
    const ln = cb.dataset.line;
    const key = cartKeyOf(_wiz.currentPo.PoNo, ln);
    const tr = cb.closest('tr');
    if (cb.checked) {
      // Add to cart — snapshot the line + currently-typed per-line values
      const line = _wiz.currentLines.find(l => String(l.LineNumber) === ln);
      if (!line) { cb.checked = false; return; }
      const carton = document.getElementById('wizCartonNo').value.trim();
      if (!carton) {
        cb.checked = false;
        WH.toast('Enter a Carton No first — that\'s where the ticked line will be packed', 'error');
        document.getElementById('wizCartonNo').focus();
        return;
      }
      _wiz.cart.set(key, {
        PoNo: _wiz.currentPo.PoNo,
        LineNumber: Number(ln),
        VendorItemNo: line.VendorItemNo || line.ItemNo || '',
        ItemName: line.ItemName || '',
        Quantity: Number(line.Quantity || 0),
        Rate: Number(line.Rate || 0),
        Currency: line.Currency || '',
        CartonNo: carton,
        QuantityReceived: readLineInputVal(ln, 'QuantityReceived'),
        NetWeightKg:      readLineInputVal(ln, 'NetWeightKg'),
        Datecode:         readLineInputVal(ln, 'Datecode'),
        LotNo:            readLineInputVal(ln, 'LotNo'),
      });
      if (tr) tr.classList.add('is-incart');
    } else {
      _wiz.cart.delete(key);
      if (tr) tr.classList.remove('is-incart');
    }
    refreshCart();
  }

  function syncCartFromRow(inp) {
    if (!_wiz || !_wiz.currentPo) return;
    const ln  = inp.dataset.line;
    const key = cartKeyOf(_wiz.currentPo.PoNo, ln);
    const item = _wiz.cart.get(key);
    if (!item) return;
    const field = inp.dataset.lineField;
    const raw   = inp.value.trim();
    if (raw === '') item[field] = null;
    else item[field] = (inp.type === 'number') ? Number(raw) : raw;
    refreshCart();
  }

  function readLineInputVal(ln, field) {
    const el = document.querySelector(`#wizLineBody input[data-line="${CSS.escape(ln)}"][data-line-field="${field}"]`);
    if (!el) return null;
    const raw = el.value.trim();
    if (raw === '') return null;
    return (el.type === 'number') ? Number(raw) : raw;
  }

  // Re-render the cart table from _wiz.cart, grouped by CartonNo.
  function refreshCart() {
    if (!_wiz) return;
    const tbody = document.getElementById('wizCartBody');
    const items = Array.from(_wiz.cart.values());
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="wh-empty">No lines selected yet.</td></tr>';
    } else {
      // Group by CartonNo (preserve insertion order within a group)
      items.sort((a, b) => String(a.CartonNo || '').localeCompare(String(b.CartonNo || ''))
                       || String(a.PoNo).localeCompare(String(b.PoNo))
                       || a.LineNumber - b.LineNumber);
      let lastCarton = null;
      tbody.innerHTML = items.map(it => {
        const isFirst = it.CartonNo !== lastCarton;
        lastCarton = it.CartonNo;
        const vinDisplay = it.VendorItemNo
          ? `<strong>${WH.esc(it.VendorItemNo)}</strong>`
          : `<em style="opacity:.7">—</em>`;
        const key = cartKeyOf(it.PoNo, it.LineNumber, it.SplitId);
        return `
          <tr class="${isFirst ? 'cart-row-first-of-group' : ''}" data-key="${WH.esc(key)}">
            <td>${WH.esc(it.CartonNo || '—')}</td>
            <td>${WH.esc(it.PoNo)}</td>
            <td>${it.LineNumber}${it.SplitId ? ' <span style="color:#7c3aed;font-size:.78em">·split</span>' : ''}</td>
            <td>${vinDisplay}</td>
            <td>${WH.esc(it.ItemName || '')}</td>
            <td class="num">${it.QuantityReceived != null ? Number(it.QuantityReceived).toFixed(2) : Number(it.Quantity || 0).toFixed(2)}</td>
            <td class="num">${it.NetWeightKg != null ? Number(it.NetWeightKg).toFixed(3) : ''}</td>
            <td>${WH.esc(it.Datecode || '')}</td>
            <td>${WH.esc(it.LotNo || '')}</td>
            <td style="white-space:nowrap;">
              <button class="cart-split" type="button" data-key="${WH.esc(key)}" title="Split this line across another carton">↗</button>
              <button class="cart-remove" type="button" data-key="${WH.esc(key)}" title="Remove from this shipment">✕</button>
            </td>
          </tr>`;
      }).join('');
      tbody.querySelectorAll('button.cart-remove').forEach(b => {
        b.onclick = () => removeFromCart(b.dataset.key);
      });
      tbody.querySelectorAll('button.cart-split').forEach(b => {
        b.onclick = () => splitCartItem(b.dataset.key);
      });
    }
    const cartons = new Set(items.map(it => it.CartonNo || '').filter(Boolean));
    document.getElementById('wizCartCount').textContent =
      `${items.length} line${items.length === 1 ? '' : 's'} · ${cartons.size} carton${cartons.size === 1 ? '' : 's'}`;
    // Sync auto-counted No. of Cartons (read-only) and per-carton details
    syncNoOfCartons(cartons.size);
    refreshCartonDetails(items, cartons);
    const saveBtn = document.getElementById('wizSave');
    if (saveBtn) {
      saveBtn.disabled = (items.length === 0);
      saveBtn.textContent = `💾 Save ${items.length} line${items.length === 1 ? '' : 's'}`;
    }
    recomputePricingPreview();
  }

  // Split one cart item across two cartons. Prompts for the new carton
  // (defaults to the current carton bar value) + how much qty to move
  // there. Original row's qty decreases by that amount; new row carries
  // the same item line under a SplitId so the cart Map can hold both.
  function splitCartItem(key) {
    if (!_wiz) return;
    const orig = _wiz.cart.get(key);
    if (!orig) return;
    const currentQty = Number(orig.QuantityReceived != null ? orig.QuantityReceived : (orig.Quantity || 0));
    if (currentQty <= 0) {
      WH.toast('Set a Recd Qty first — nothing to split.', 'error');
      return;
    }
    const suggestedNewCarton = document.getElementById('wizCartonNo').value.trim()
                            || nextSequentialCarton(orig.CartonNo);
    const newCarton = prompt(
      `Split "${orig.VendorItemNo || orig.ItemName}" across another carton.\n\n` +
      `Current carton ${orig.CartonNo} has qty ${currentQty}.\n\n` +
      `New carton no:`,
      suggestedNewCarton);
    if (newCarton == null) return;
    const trimmed = newCarton.trim();
    if (!trimmed) { WH.toast('Carton No is required', 'error'); return; }
    if (trimmed === orig.CartonNo) { WH.toast('That\'s the same carton — pick a different one.', 'error'); return; }
    const moveStr = prompt(
      `Qty to move into "${trimmed}":\n(remaining stays in "${orig.CartonNo}")`,
      String(Math.floor(currentQty / 2)));
    if (moveStr == null) return;
    const moveQty = Number(moveStr);
    if (!Number.isFinite(moveQty) || moveQty <= 0 || moveQty >= currentQty) {
      WH.toast(`Qty must be between 1 and ${currentQty - 1}`, 'error');
      return;
    }
    // New cart row — same line, new carton, new SplitId. Inherit per-line
    // values; user can edit afterwards if needed.
    const newSplitId = `s${Date.now()}`;
    const newKey = cartKeyOf(orig.PoNo, orig.LineNumber, newSplitId);
    _wiz.cart.set(newKey, {
      ...orig,
      CartonNo: trimmed,
      QuantityReceived: moveQty,
      SplitId: newSplitId,
    });
    // Reduce original qty by moveQty
    orig.QuantityReceived = currentQty - moveQty;
    refreshCart();
  }

  // Bump just the trailing -NNNN sequence on an existing carton; used as
  // a hint default for split prompts when carton bar is blank.
  function nextSequentialCarton(carton) {
    if (!carton) return '';
    const m = /^(.*?)(\d+)$/.exec(carton);
    if (!m) return carton + '-2';
    const width = m[2].length;
    return m[1] + String(Number(m[2]) + 1).padStart(width, '0');
  }

  // No. of Cartons is auto-counted from unique CartonNos in the cart.
  // Read-only; updated whenever the cart changes.
  function syncNoOfCartons(n) {
    const el = document.getElementById('wizNoOfCartons');
    if (el) el.value = String(n);
  }

  // Render the per-carton Dim + Weight input rows. One row per unique
  // carton in the cart. Drops detail entries for cartons that no longer
  // exist (line removed / split undone). On first input change, prompts
  // "All cartons same?" — OK copies the value to every other carton.
  function refreshCartonDetails(items, cartons) {
    const wrap = document.getElementById('wizCartonDetailsWrap');
    if (!wrap) return;
    if (!cartons || cartons.size === 0) {
      wrap.innerHTML = '<div class="carton-details-empty">Add lines to the cart above — per-carton inputs appear here automatically.</div>';
      return;
    }
    // Prune detail entries for cartons that no longer exist
    for (const c of Array.from(_wiz.cartonDetails.keys())) {
      if (!cartons.has(c)) _wiz.cartonDetails.delete(c);
    }
    // Sorted list for stable render order (same as cart)
    const sorted = Array.from(cartons).sort();
    wrap.innerHTML = `
      <table class="carton-details-tbl">
        <thead>
          <tr>
            <th style="width:160px;">Carton No</th>
            <th>Dimension (LxWxH cm)</th>
            <th style="width:180px;">Gross Weight (kg)</th>
            <th style="width:120px;">Lines in carton</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(c => {
            const det = _wiz.cartonDetails.get(c) || {};
            const linesInCarton = items.filter(it => it.CartonNo === c).length;
            return `
              <tr>
                <td>${WH.esc(c)}</td>
                <td><input type="text" data-carton="${WH.esc(c)}" data-field="Dimension" maxlength="50" placeholder="30x20x15" value="${WH.esc(det.Dimension || '')}" /></td>
                <td><input type="number" data-carton="${WH.esc(c)}" data-field="WeightKg"  min="0" step="0.01" value="${det.WeightKg != null ? det.WeightKg : ''}" /></td>
                <td style="color:#64748b;">${linesInCarton} line${linesInCarton === 1 ? '' : 's'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    // Wire inputs:
    //   `input` → quietly store the value (no popup, no interruption)
    //   `change` (blur / Tab / Enter) → maybe trigger the "all same?" popup
    // Popup only fires when BOTH Dim AND Weight are filled for the carton
    // being edited, AND every OTHER carton is still blank on that field.
    wrap.querySelectorAll('input[data-carton]').forEach(inp => {
      inp.addEventListener('input',  () => storeCartonDetail(inp));
      inp.addEventListener('change', () => maybePromptPropagate(inp, sorted));
    });
  }

  // Store the typed value into _wiz.cartonDetails without firing any popup.
  // Called on every keystroke so the cart Map stays in sync.
  function storeCartonDetail(inp) {
    const carton = inp.dataset.carton;
    const field  = inp.dataset.field;
    const raw    = inp.value.trim();
    let det = _wiz.cartonDetails.get(carton);
    if (!det) { det = {}; _wiz.cartonDetails.set(carton, det); }
    det[field] = raw === '' ? null : (inp.type === 'number' ? Number(raw) : raw);
  }

  // Fired on blur / change of a per-carton input. Fires the "all cartons
  // same?" popup INDEPENDENTLY for each field (Dim / Weight) the moment
  // that field is non-blank on the edited carton AND every OTHER carton
  // is still blank on that field. Use `change` (blur/Tab) — not `input`
  // (keystroke) — so we don't interrupt mid-typing. Each popup fires at
  // most once per wizard open per field.
  //
  // Earlier version required BOTH Dim + Weight to be filled before any
  // popup fired — that caused the Dim popup to be silently missed when
  // user tabbed Dim → Weight (only the Weight popup fired). Reverted.
  function maybePromptPropagate(inp, sortedCartons) {
    if (!_wiz) return;
    storeCartonDetail(inp);
    if (sortedCartons.length < 2) return;
    const carton = inp.dataset.carton;
    const field  = inp.dataset.field;
    const det    = _wiz.cartonDetails.get(carton) || {};
    const value  = det[field];
    const filled = value != null && String(value).trim() !== '';
    if (!filled) return;
    const promptShownKey = field === 'Dimension' ? 'dimPropagatePromptShown' : 'wtPropagatePromptShown';
    if (_wiz[promptShownKey]) return;
    // Only propagate when ALL OTHER cartons have BLANK for this field
    const allOthersBlank = sortedCartons.every(c =>
      c === carton || !(_wiz.cartonDetails.get(c) || {})[field]
    );
    if (!allOthersBlank) return;
    _wiz[promptShownKey] = true;
    const label = field === 'Dimension' ? 'Dimension' : 'Gross Weight';
    const yes = confirm(
      `All ${sortedCartons.length} cartons have the same ${label} ("${value}")?\n\n` +
      `Click OK     → copy to every other carton\n` +
      `Click Cancel → fill each carton manually`
    );
    if (yes) {
      sortedCartons.forEach(c => {
        if (c === carton) return;
        let d = _wiz.cartonDetails.get(c);
        if (!d) { d = {}; _wiz.cartonDetails.set(c, d); }
        d[field] = value;
        const other = document.querySelector(`#wizCartonDetailsWrap input[data-carton="${CSS.escape(c)}"][data-field="${field}"]`);
        if (other) other.value = value;
      });
    }
  }

  function removeFromCart(key) {
    if (!_wiz) return;
    _wiz.cart.delete(key);
    // If the BASE entry (no splitId) was removed AND no split clones remain
    // for that line, untick the box in the picker. Otherwise leave it ticked
    // (the user might still have other split clones in the cart).
    const parts = key.split('::');
    const po = parts[0], lnStr = parts[1], hadSplitId = parts.length > 2;
    const baseKey  = `${po}::${lnStr}`;
    const lineStillInCart = Array.from(_wiz.cart.keys()).some(k => k === baseKey || k.startsWith(baseKey + '::'));
    if (!lineStillInCart && _wiz.currentPo && _wiz.currentPo.PoNo === po) {
      const cb = document.querySelector(`#wizLineBody input[type=checkbox][data-line="${CSS.escape(lnStr)}"]`);
      if (cb) cb.checked = false;
      const tr = cb && cb.closest('tr');
      if (tr) tr.classList.remove('is-incart');
    }
    refreshCart();
  }

  // Fetch /next-carton-no, bump the carton bar suggestion.
  async function bumpCartonSuggestion() {
    try {
      const r = await apiRequest('/warehouse/purchase/next-carton-no');
      // Account for cartons already in this open wizard so the suggestion
      // doesn't collide with a CTN-26-0042 the user already typed for an
      // earlier carton in this session.
      const usedInThisWizard = new Set(Array.from(_wiz.cart.values()).map(it => it.CartonNo));
      let candidate = r.nextCartonNo;
      // If the suggested value is already used by a cart row, bump until free.
      let seq = parseInt(candidate.split('-').pop(), 10) || 0;
      const prefix = candidate.replace(/\d+$/, '');
      while (usedInThisWizard.has(candidate)) {
        seq++;
        candidate = prefix + String(seq).padStart(4, '0');
      }
      _wiz.nextCartonNo = candidate;
      document.getElementById('wizCartonNo').value = candidate;
      document.getElementById('wizCartonNo').focus();
    } catch (err) {
      WH.toast('Failed to fetch next carton number: ' + (err.message || ''), 'error');
    }
  }

  // Stock-hint badge for a given MPN. Cached so per-PO refreshes don't refire.
  async function loadStockHint(span) {
    if (!_wiz) return;
    const mpn = span.dataset.stockMpn;
    if (!mpn) { span.textContent = ''; return; }
    span.textContent = '…'; span.className = 'wiz-stock-hint loading';
    let hints = _wiz.stockHints.get(mpn);
    if (!hints) {
      try {
        const r = await apiRequest('/warehouse/stocks/by-mpn/' + encodeURIComponent(mpn));
        hints = (r && r.data) || [];
        _wiz.stockHints.set(mpn, hints);
      } catch (_) {
        hints = [];
        _wiz.stockHints.set(mpn, hints);
      }
    }
    paintStockHint(span, hints);
  }

  function paintStockHint(span, hints) {
    if (!hints || !hints.length) {
      span.textContent = 'new MPN';
      span.className = 'wiz-stock-hint none';
      span.title = 'No existing stock for this part';
      return;
    }
    const top3 = hints.slice(0, 3);
    const more = hints.length > 3 ? ` +${hints.length - 3}` : '';
    span.textContent = `📦 ` + top3.map(h => `${h.QtyPcs || 0}p · ${h.CartonNo || '—'}`).join(', ') + more;
    span.className = 'wiz-stock-hint';
    span.title = hints.map(h =>
      `${h.CartonNo || '—'} · ${h.QtyPcs || 0}pcs · Inv ${h.InvoiceNo || '—'} · ${(h.InwordDate || '').slice(0, 10)}`
    ).join('\n');
  }

  async function saveWizard() {
    if (!_wiz || _wiz.cart.size === 0) return;
    const btn = document.getElementById('wizSave');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ Saving…';

    // Shipment-level common fields. Per-carton fields (Dim + Weight) come
    // from _wiz.cartonDetails. Per-line fields (Recd Qty, NetWt, Datecode,
    // Lot No, Carton No) come from the cart item. Status omitted → backend
    // defaults to 'Pending' (initial entry — Amit edits later via Edit modal).
    const cartonCount = new Set(Array.from(_wiz.cart.values()).map(it => it.CartonNo)).size;
    const common = {
      MatlReceivedDate : document.getElementById('wizMatlDate').value || null,
      InvoiceDate      : document.getElementById('wizInvDate').value || null,
      InvoiceNo        : document.getElementById('wizInvNo').value.trim() || null,
      Incoterms        : document.getElementById('wizIncoterms').value || null,
      BankOtherCharges : numOrNull(document.getElementById('wizCharges').value) ?? 0,
      GstPaidByUsFlag  : document.getElementById('wizGstByUs').checked ? 1 : 0,
      NoOfCartons      : cartonCount || 1,
      COO              : document.getElementById('wizCoo').value.trim() || null,
      ReceivedThrough  : document.getElementById('wizRcvThrough').value.trim() || null,
      AirWaybillNo     : document.getElementById('wizAwb').value.trim() || null,
      PurchaseType     : 'Purchase',
    };

    // Build SplitSeq per (PoNo, LineNumber) — base entry = 0, split clones = 1+.
    // This is the composite-key tail that lets BN_WhPurchase store multiple
    // rows for the same NAV PO line (one per physical carton).
    const splitSeqByLine = new Map();
    const items = Array.from(_wiz.cart.values());
    // Sort so base entries (no SplitId) come first → SplitSeq = 0
    items.sort((a, b) => {
      if (a.PoNo !== b.PoNo) return String(a.PoNo).localeCompare(String(b.PoNo));
      if (a.LineNumber !== b.LineNumber) return a.LineNumber - b.LineNumber;
      // Base entry (no SplitId) before split clones
      if (!a.SplitId && b.SplitId) return -1;
      if (a.SplitId && !b.SplitId) return 1;
      return String(a.SplitId || '').localeCompare(String(b.SplitId || ''));
    });
    items.forEach(it => {
      const lineKey = `${it.PoNo}::${it.LineNumber}`;
      const next = (splitSeqByLine.get(lineKey) ?? -1) + 1;
      splitSeqByLine.set(lineKey, next);
      it._splitSeq = next;
    });

    let ok = 0, fail = 0, stockCreated = 0;
    for (const item of items) {
      // Default Recd Qty = NAV PO Qty when blank
      const recd = item.QuantityReceived != null ? item.QuantityReceived : item.Quantity;
      // Per-carton Dim + WeightKg — every line in carton CTN-X carries the
      // SAME Dim/Weight (because Dim/Weight are CARTON properties, not
      // line properties — even though BN_WhPurchase stores them per row).
      const det = _wiz.cartonDetails.get(item.CartonNo) || {};
      const payload = {
        ...common,
        PoNo             : item.PoNo,
        LineNumber       : item.LineNumber,
        SplitSeq         : item._splitSeq,
        QuantityReceived : recd,
        NetWeightKg      : item.NetWeightKg,
        Datecode         : item.Datecode,
        LotNo            : item.LotNo,
        CartonNo         : item.CartonNo,
        Dimension        : det.Dimension || null,
        WeightKg         : det.WeightKg != null ? det.WeightKg : null,
      };
      try {
        const r = await apiRequest(ENDPOINT, { method: 'POST', body: payload });
        if (r && r.ok) {
          ok++;
          if (r.stockAutoCreated && r.stockAutoCreated.ok) stockCreated++;
        } else fail++;
      } catch (_) {
        fail++;
      }
    }

    btn.disabled = false; btn.textContent = orig;
    if (fail === 0) {
      const stockNote = stockCreated > 0 ? ` · 📦 ${stockCreated} stock carton${stockCreated === 1 ? '' : 's'} auto-created` : '';
      WH.toast(`✅ ${ok} line${ok === 1 ? '' : 's'} tracked${stockNote}.`, 'success');
      closeWizard();
      load();
    } else {
      WH.toast(`Saved ${ok} · failed ${fail}. See console for details.`, 'error');
    }
  }

  function fmtDate(d) {
    if (!d) return '';
    const s = String(d);
    // Already ISO date — keep date part
    return s.length >= 10 ? s.slice(0, 10) : s;
  }

  function numOrNull(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Edit-row modal (admin family only)
  // ──────────────────────────────────────────────────────────────────────
  let _editId = null;
  let _editRow = null;
  let _editOriginalStatus = null;
  let _editOriginalAwb    = null;

  function wireEditModal() {
    const overlay = document.getElementById('editModal');
    if (!overlay) return;
    document.getElementById('editClose').onclick  = () => closeEditModal();
    document.getElementById('editCancel').onclick = () => closeEditModal();
    overlay.addEventListener('click', e => { if (e.target === overlay) closeEditModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.hidden) closeEditModal();
    });
    document.getElementById('editSave').onclick = saveEditModal;

    // AWB → Status auto-flip. When Amit pastes the AWB the vendor sent
    // him, bump the row from Pending → In Transit automatically (he can
    // still manually override the Status dropdown). Triggers ONLY on the
    // blank→non-blank transition; ignored when AWB was already set.
    const awbInp = document.getElementById('editAwb');
    if (awbInp) {
      awbInp.addEventListener('input', () => {
        if (_editRow == null) return;
        const wasBlank = !(_editOriginalAwb || '').trim();
        const isNowSet = !!awbInp.value.trim();
        const statusSel = document.getElementById('editStatus');
        if (wasBlank && isNowSet && statusSel.value === 'Pending') {
          statusSel.value = 'In Transit';
          statusSel.style.background = '#fef9c3';
          setTimeout(() => { statusSel.style.background = ''; }, 1800);
          WH.toast('💡 Status auto-set to "In Transit" because AWB was added — change manually if not yet shipped.', 'success');
        }
      });
    }

    // Status → MatlReceivedDate auto-fill. When the user flips Status to
    // 'Received' (or 'Received Material') and the Material Recv Date field
    // is still blank, stamp today's date. Mirrors the AWB→In Transit UX.
    const statusSel = document.getElementById('editStatus');
    if (statusSel) {
      statusSel.addEventListener('change', () => {
        const v = (statusSel.value || '').toLowerCase().trim();
        if (v !== 'received' && v !== 'received material') return;
        const dateInp = document.getElementById('editMatlDate');
        if (dateInp && !dateInp.value) {
          dateInp.value = new Date().toISOString().slice(0, 10);
          dateInp.style.background = '#fef9c3';
          setTimeout(() => { dateInp.style.background = ''; }, 1800);
          WH.toast('💡 Matrl. Recv Date auto-set to today because Status flipped to Received.', 'success');
        }
      });
    }
  }

  function openEditModal(id) {
    if (!(WH.canWrite() || WH.isAdminFamily())) {
      WH.toast('You do not have permission to edit rows.', 'error');
      return;
    }
    // Find the row in the cached page data — much faster than re-querying.
    const row = Array.from(_rowsByKey.values()).find(r => String(r.Id || r.BnId) === String(id));
    if (!row) { WH.toast('Row not found — please reload.', 'error'); return; }
    _editId  = row.Id || row.BnId;
    _editRow = row;
    // Snapshot original Status + AWB so saveEditModal can detect changes
    // and offer to apply them to sibling rows on the same PO.
    _editOriginalStatus = (row.Status || '').trim();
    _editOriginalAwb    = (row.AirWaybillNo || '').trim();

    // Header chips
    document.getElementById('editPoChip').textContent     = `PO ${row.PoNo}  ·  Line ${row.LineNumber ?? '—'}`;
    document.getElementById('editSystemChip').textContent = `System: ${row.SystemNo || '—'}`;

    // Section 1 — Invoice Info
    document.getElementById('editInvDate').value    = WH.toInputDate(row.InvoiceDate) || '';
    document.getElementById('editInvNo').value      = row.InvoiceNo || '';
    document.getElementById('editSupplier').value   = row.SupplierName || '';
    document.getElementById('editCurrency').value   = row.Currency || '';
    document.getElementById('editIncoterms').value  = row.Incoterms || '';
    document.getElementById('editStatus').value     = row.Status || '';
    document.getElementById('editMatlDate').value   = WH.toInputDate(row.MatlReceivedDate) || '';
    document.getElementById('editPaidDate').value   = WH.toInputDate(row.PaidDate) || '';

    // Section 2 — Item Info
    document.getElementById('editItemNo').value       = row.ItemNo || '';
    document.getElementById('editVendorItemNo').value = row.VendorItemNo || row.ItemNo || '';
    document.getElementById('editItemName').value     = row.ItemName || '';
    document.getElementById('editPoQty').value        = (row.Quantity ?? '');
    document.getElementById('editRecdQty').value      = row.QuantityReceived ?? '';
    document.getElementById('editNetWt').value        = row.NetWeightKg ?? '';
    document.getElementById('editDatecode').value     = row.Datecode || '';
    document.getElementById('editLotNo').value        = row.LotNo || '';
    document.getElementById('editCartonNo').value     = row.CartonNo || '';

    // Section 3 — Pricing
    document.getElementById('editCharges').value = row.BankOtherCharges ?? '';
    // GstPaidByUsFlag: 1 → checked, 0 → unchecked, null → infer from VendorCountry rule
    if (row.GstPaidByUsFlag === 1 || row.GstPaidByUsFlag === true) {
      document.getElementById('editGstByUs').checked = true;
    } else if (row.GstPaidByUsFlag === 0 || row.GstPaidByUsFlag === false) {
      document.getElementById('editGstByUs').checked = false;
    } else {
      document.getElementById('editGstByUs').checked = (row.VendorCountry || '').toUpperCase() !== 'SG';
    }

    // Section 4 — Carton & Logistics
    document.getElementById('editNoOfCartons').value = row.NoOfCartons ?? '';
    document.getElementById('editGrossWt').value     = row.WeightKg ?? '';
    document.getElementById('editDim').value         = row.Dimension || '';
    document.getElementById('editCoo').value         = row.COO || '';
    document.getElementById('editRcvThrough').value  = row.ReceivedThrough || '';
    document.getElementById('editAwb').value         = row.AirWaybillNo || '';
    document.getElementById('editFreightSgd').value  = row.FreightSGD ?? '';
    document.getElementById('editPermitNo').value    = row.PermitNo || '';

    document.getElementById('editModal').hidden = false;
  }

  function closeEditModal() {
    document.getElementById('editModal').hidden = true;
    _editId = null;
    _editRow = null;
    _editOriginalStatus = null;
    _editOriginalAwb    = null;
  }

  // Count how many OTHER tracked rows on this PO are in the current page
  // cache. Returns 0 when this is the only tracked row visible. Note: this
  // is an in-cache count, so on a multi-page result it under-counts. The
  // backend bulk-status always hits ALL rows matching by Company + key.
  function siblingCountForPo(poNo, excludeId) {
    let n = 0;
    for (const r of _rowsByKey.values()) {
      if (String(r.PoNo) === String(poNo) && String(r.Id || r.BnId) !== String(excludeId)) n++;
    }
    return n;
  }
  function siblingCountForInvoice(invoiceNo, excludeId) {
    if (!invoiceNo) return 0;
    let n = 0;
    for (const r of _rowsByKey.values()) {
      if (String(r.InvoiceNo || '') === String(invoiceNo) && String(r.Id || r.BnId) !== String(excludeId)) n++;
    }
    return n;
  }

  async function saveEditModal() {
    if (!_editId || !_editRow) return;
    const btn = document.getElementById('editSave');
    const newStatus = (document.getElementById('editStatus').value || '').trim();
    const newAwb    = (document.getElementById('editAwb').value    || '').trim();

    // Sibling fan-out confirm: fires when EITHER Status OR AirWaybillNo
    // changed AND this row has > 0 siblings. Grouping preference:
    //   1. By Invoice No (more specific — single shipment, even across POs)
    //   2. Fall back to PO (when InvoiceNo isn't filled in yet)
    // OK → /bulk-status with the chosen grouping key.
    // Cancel → single-row POST (untouched siblings).
    const statusChanged = newStatus && newStatus !== _editOriginalStatus;
    const awbChanged    = newAwb !== (_editOriginalAwb || '');
    const newInv = (document.getElementById('editInvNo').value || '').trim();
    const invSiblings = siblingCountForInvoice(newInv || _editRow.InvoiceNo, _editId);
    const poSiblings  = siblingCountForPo(_editRow.PoNo, _editId);
    // Prefer Invoice grouping when the row has an Invoice No AND has siblings.
    const useInvoice  = !!(newInv || _editRow.InvoiceNo) && invSiblings > 0;
    const groupKey    = useInvoice ? 'Invoice' : 'PO';
    const groupId     = useInvoice ? (newInv || _editRow.InvoiceNo) : _editRow.PoNo;
    const siblings    = useInvoice ? invSiblings : poSiblings;
    let applyToAll = false;
    if (siblings > 0 && (statusChanged || awbChanged)) {
      const changes = [];
      if (statusChanged) changes.push(`Status: "${_editOriginalStatus || '—'}" → "${newStatus}"`);
      if (awbChanged)    changes.push(`AWB: "${_editOriginalAwb || '—'}" → "${newAwb || '—'}"`);
      applyToAll = confirm(
        `📦 ${groupKey} ${groupId} has ${siblings + 1} tracked line${siblings + 1 === 1 ? '' : 's'} on this page (they ship together).\n\n` +
        changes.join('\n') + '\n\n' +
        `Click OK   → apply to ALL ${siblings + 1} lines on this ${groupKey}\n` +
        `Click Cancel → apply only to THIS 1 line`
      );
    }

    btn.disabled = true; btn.textContent = '⏳ Saving…';

    // Bulk fast-path: skip the per-row POST and call /bulk-status.
    // Sends EITHER InvoiceNo OR PoNo as the grouping key.
    if (applyToAll) {
      try {
        const matlDate = document.getElementById('editMatlDate').value || null;
        const body = { Status: newStatus };
        if (useInvoice) body.InvoiceNo = groupId;
        else            body.PoNo      = groupId;
        if (matlDate)    body.MatlReceivedDate = matlDate;
        if (awbChanged)  body.AirWaybillNo    = newAwb;
        const r = await apiRequest('/warehouse/purchase/bulk-status', { method: 'POST', body });
        if (r && r.ok) {
          const stockNote = r.stockAutoCreated > 0
            ? ` · 📦 ${r.stockAutoCreated} stock carton${r.stockAutoCreated === 1 ? '' : 's'} auto-created`
            : '';
          WH.toast(`✅ Updated ${r.updated} line${r.updated === 1 ? '' : 's'}${stockNote}.`, 'success');
          closeEditModal();
          load();
          return;
        }
        WH.toast(r?.message || 'Bulk save failed', 'error');
      } catch (err) {
        WH.toast(err.message || 'Bulk save failed', 'error');
      } finally {
        btn.disabled = false; btn.textContent = '💾 Save changes';
      }
      return;
    }

    // POST against the existing endpoint — MERGE will UPDATE because the
    // (Company, PoNo, LineNumber) key already exists.
    const payload = {
      PoNo             : _editRow.PoNo,
      LineNumber       : _editRow.LineNumber,
      SystemNo         : _editRow.SystemNo,
      PurchaseType     : _editRow.PurchaseType || 'Purchase',
      InvoiceDate      : document.getElementById('editInvDate').value || null,
      InvoiceNo        : document.getElementById('editInvNo').value.trim() || null,
      Incoterms        : document.getElementById('editIncoterms').value || null,
      Status           : document.getElementById('editStatus').value || null,
      MatlReceivedDate : document.getElementById('editMatlDate').value || null,
      PaidDate         : document.getElementById('editPaidDate').value || null,
      QuantityReceived : numOrNull(document.getElementById('editRecdQty').value),
      NetWeightKg      : numOrNull(document.getElementById('editNetWt').value),
      Datecode         : document.getElementById('editDatecode').value.trim() || null,
      LotNo            : document.getElementById('editLotNo').value.trim() || null,
      CartonNo         : document.getElementById('editCartonNo').value.trim() || null,
      BankOtherCharges : numOrNull(document.getElementById('editCharges').value) ?? 0,
      GstPaidByUsFlag  : document.getElementById('editGstByUs').checked ? 1 : 0,
      NoOfCartons      : numOrNull(document.getElementById('editNoOfCartons').value),
      WeightKg         : numOrNull(document.getElementById('editGrossWt').value),
      Dimension        : document.getElementById('editDim').value.trim() || null,
      COO              : document.getElementById('editCoo').value.trim() || null,
      ReceivedThrough  : document.getElementById('editRcvThrough').value.trim() || null,
      AirWaybillNo     : document.getElementById('editAwb').value.trim() || null,
      FreightSGD       : numOrNull(document.getElementById('editFreightSgd').value),
      PermitNo         : document.getElementById('editPermitNo').value.trim() || null,
    };

    try {
      const r = await apiRequest(ENDPOINT, { method: 'POST', body: payload });
      if (r && r.ok) {
        const stockNote = (r.stockAutoCreated && r.stockAutoCreated.ok)
          ? ` · 📦 stock carton auto-created (CTN ${r.stockAutoCreated.cartonNo || '—'})`
          : '';
        WH.toast(`Saved${stockNote}.`, 'success');
        closeEditModal();
        load();
      } else {
        WH.toast(r?.message || 'Save failed', 'error');
      }
    } catch (err) {
      WH.toast(err.message || 'Save failed', 'error');
    } finally {
      btn.disabled = false; btn.textContent = '💾 Save changes';
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Invoice Summary modal — Amit-style breakdown of one invoice
  // ──────────────────────────────────────────────────────────────────────
  function wireInvoiceModal() {
    const overlay = document.getElementById('invoiceModal');
    if (!overlay) return;
    document.getElementById('invClose').onclick  = closeInvoiceModal;
    document.getElementById('invCancel').onclick = closeInvoiceModal;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeInvoiceModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeInvoiceModal();
    });
  }

  function closeInvoiceModal() {
    document.getElementById('invoiceModal').hidden = true;
  }

  async function openInvoiceSummary(invoiceNo) {
    const overlay = document.getElementById('invoiceModal');
    document.getElementById('invTitle').textContent = `Invoice Summary — ${invoiceNo}`;
    document.getElementById('invHdrNo').textContent        = invoiceNo;
    document.getElementById('invHdrDate').textContent      = '…';
    document.getElementById('invHdrSupplier').textContent  = '…';
    document.getElementById('invHdrCurrency').textContent  = '…';
    document.getElementById('invHdrIncoterms').textContent = '…';
    document.getElementById('invHdrStatus').textContent    = '…';
    document.getElementById('invTbody').innerHTML = `<tr><td colspan="9" class="wh-loading">Loading…</td></tr>`;
    document.getElementById('invTfoot').innerHTML = '';
    overlay.hidden = false;
    try {
      const r = await apiRequest('/warehouse/purchase/by-invoice/' + encodeURIComponent(invoiceNo));
      const rows   = (r && r.data)   || [];
      const header = (r && r.header) || null;
      const totals = (r && r.totals) || null;

      if (header) {
        document.getElementById('invHdrDate').textContent      = WH.fmtDate(header.InvoiceDate) || '—';
        document.getElementById('invHdrSupplier').textContent  = header.SupplierName || '—';
        document.getElementById('invHdrCurrency').textContent  = header.Currency || '—';
        document.getElementById('invHdrIncoterms').textContent = header.Incoterms || '—';
        const statusEl = document.getElementById('invHdrStatus');
        statusEl.textContent = header.Status || '—';
        // When invoice spans multiple statuses, surface that prominently so
        // Amit knows it's not uniform. Otherwise normal.
        statusEl.style.color = header.StatusMixed ? '#b91c1c' : '';
        statusEl.title = header.StatusMixed
          ? 'This invoice has lines in multiple statuses — open Edit Modal on any row to bulk-update.'
          : '';
      }

      if (!rows.length) {
        document.getElementById('invTbody').innerHTML =
          `<tr><td colspan="9" class="wh-empty">No tracked lines found for this invoice.</td></tr>`;
        return;
      }

      document.getElementById('invTbody').innerHTML = rows.map(r => {
        const qty  = Number(r.QuantityReceived != null ? r.QuantityReceived : (r.Quantity || 0));
        const rate = Number(r.Rate || 0);
        const val  = qty * rate;
        // Column mapping (per Amit 2026-06-24):
        //   SKU         = Vendor Item No (fallback Item No)
        //   Description = NAV Item.[Description] (the human-readable text)
        //   Make        = NAV Item.[Global Dimension 2 Code]
        // backend by-invoice hydrates Description + MakeGlobal so we don't
        // need a per-row JOIN here.
        const sku  = r.VendorItemNo || r.ItemNo || '—';
        const desc = r.Description || r.ItemName || '';
        const make = r.MakeGlobal || r.Make || '';
        return `
          <tr>
            <td><b>${WH.esc(sku)}</b></td>
            <td>${WH.esc(desc)}</td>
            <td>${WH.esc(make)}</td>
            <td>${WH.esc(r.CartonNo || '—')}</td>
            <td class="num">${qty.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td class="num">${rate.toFixed(2)}</td>
            <td class="num">${r.NetWeightKg != null ? Number(r.NetWeightKg).toFixed(3) : ''}</td>
            <td>${WH.esc(r.Dimension || '')}</td>
            <td class="num">${val.toFixed(2)}</td>
          </tr>`;
      }).join('');

      if (totals) {
        const cur = (header && header.Currency) || '';
        document.getElementById('invTfoot').innerHTML = `
          <tr>
            <td colspan="3" style="font-weight:600;color:#475569;">${totals.lineCount} part${totals.lineCount === 1 ? '' : 's'} · ${totals.cartonCount} carton${totals.cartonCount === 1 ? '' : 's'}</td>
            <td></td>
            <td class="num" style="font-weight:700;">${totals.totalQty.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            <td></td>
            <td class="num" style="font-weight:700;">${totals.totalNetWt.toFixed(3)}</td>
            <td style="text-align:right;font-weight:600;color:#475569;">SUBTOTAL</td>
            <td class="num" style="font-weight:700;">${totals.subtotal.toFixed(2)}</td>
          </tr>
          <tr>
            <td colspan="8" style="text-align:right;font-weight:600;color:#475569;">CHARGES</td>
            <td class="num">${totals.charges.toFixed(2)}</td>
          </tr>
          <tr>
            <td colspan="8" style="text-align:right;font-weight:600;color:#475569;">GST (9%)</td>
            <td class="num">${(totals.gstUs + totals.gstSupplier).toFixed(2)}</td>
          </tr>
          <tr class="inv-total">
            <td colspan="8" style="text-align:right;background:#1A5276;color:#ffffff;font-weight:700;padding:11px 14px;font-size:.98rem;">TOTAL AMOUNT</td>
            <td class="num" style="background:#1A5276;color:#ffffff;font-weight:700;padding:11px 14px;font-size:1.08rem;">${WH.esc(cur)} ${totals.totalAmount.toFixed(2)}</td>
          </tr>
        `;
      }
    } catch (err) {
      document.getElementById('invTbody').innerHTML =
        `<tr><td colspan="9" class="wh-empty">${WH.esc(err.message || 'Failed to load invoice summary')}</td></tr>`;
    }
  }
})();
