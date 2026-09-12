/* warehouse/sales.js — NAV-first Sales list with inline-edit rows.

   DEFAULT MODE: "Upcoming / PFP" — backend pulls SO Backlog rows with
   Remarks='PFP' and uses the Sales Header's [Posting No_] (the pre-assigned
   future invoice number) as the Invoice No. Lets Amit see the invoices that
   are about to be posted before Pune actually posts them.

   ?showPosted=1 reverts to the old "all posted Sales Invoices" view (kept
   for admin / oversight). The frontend renderer is unchanged either way —
   output schema from both backend modes matches exactly.

   Save = UPSERT MERGE on (InvoiceNo, LineNumber) — still works in PFP mode
   because the Posting No becomes the actual Invoice No once NAV posts it. */

(function () {
  const ENDPOINT = '/warehouse/sales';
  const PAGE_LIMIT = 50;

  let page = 1, limit = PAGE_LIMIT;
  let search = '', tracked = 'all', days = 90, dateFrom = '', dateTo = '';
  let _rowsByKey = new Map();
  // PFP variant filter: '' = all PFP-prefix, or one of PFP / PFP-WAITING-FF /
  // PFP-DROP / PFP-PICK-PACK. Persist in sessionStorage so the user's choice
  // survives reloads.
  let pfpVariant = sessionStorage.getItem('whSalesPfpVariant') || '';

  document.addEventListener('DOMContentLoaded', () => {
    const u = requireAuth(); if (!u) return;
    renderSidebar('wh-sales');
    const rt = document.getElementById('roleTag');
    if (rt) rt.textContent = (u.role || '').toUpperCase();

    document.getElementById('whSearch').addEventListener('input', debounce(() => {
      search = document.getElementById('whSearch').value.trim();
      page = 1; load();
    }, 280));

    const trackedSel = document.getElementById('whStatus');
    if (trackedSel) {
      trackedSel.innerHTML = `
        <option value="all">All invoice lines</option>
        <option value="no">Not yet tracked</option>
        <option value="yes">Already tracked</option>`;
      trackedSel.value = tracked;
      trackedSel.addEventListener('change', () => {
        tracked = trackedSel.value; page = 1; load();
      });
    }
    document.getElementById('whApply').onclick = () => {
      dateFrom = document.getElementById('whFrom').value;
      dateTo   = document.getElementById('whTo').value;
      page = 1; load();
    };

    // Clear Filters — resets every input AND the variant filter back to 'all'.
    const clearBtn = document.getElementById('whClear');
    if (clearBtn) {
      clearBtn.onclick = () => {
        search = ''; dateFrom = ''; dateTo = ''; tracked = 'all';
        pfpVariant = '';
        sessionStorage.removeItem('whSalesPfpVariant');
        document.getElementById('whSearch').value = '';
        document.getElementById('whFrom').value = '';
        document.getElementById('whTo').value = '';
        const ts = document.getElementById('whStatus');
        if (ts) ts.value = 'all';
        page = 1;
        clearBtn.classList.remove('has-active');
        load();
      };
    }

    // PFP-variant cards — clicking switches the table filter.
    document.querySelectorAll('.wh-stat-card.clickable').forEach(card => {
      card.addEventListener('click', () => {
        const v = card.dataset.variant || '';
        if (pfpVariant === v) return;       // already active
        pfpVariant = v;
        if (v) sessionStorage.setItem('whSalesPfpVariant', v);
        else sessionStorage.removeItem('whSalesPfpVariant');
        page = 1;
        load();
      });
    });

    if (WH.canWrite()) WH.wireImport('whImport', 'whFile', ENDPOINT, load);
    else { const imp = document.getElementById('whImport'); if (imp) imp.style.display = 'none'; }
    WH.wireExport('whExport', ENDPOINT, () => ({ search, tracked, dateFrom, dateTo, days }));

    load();
  });

  function keyOf(r) {
    return `${encodeURIComponent(r.InvoiceNo || '')}|${r.LineNumber ?? ''}`;
  }

  // Populate the 5 variant cards from backend stats.variants array.
  // Card → variant mapping is fixed: card-IDs below match the data-variant attrs.
  function paintVariantCards(stats) {
    const fmtN   = (n) => Number(n || 0).toLocaleString('en-US');
    const fmtCur = (n) => '$ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const byVariant = {};
    (stats.variants || []).forEach(v => { byVariant[v.Remarks] = v; });

    // All-PFP card uses the precomputed sum
    const all = stats.all || {};
    document.getElementById('statAllInvoices').textContent = fmtCur(all.TotalValue);
    document.getElementById('statAllSub').textContent      = fmtN(all.Lines) + ' lines · ' + fmtN(all.Invoices) + ' invoice rows';

    const map = [
      { id: 'cardPfp',      var: 'PFP',            invId: 'statPfpInvoices',  subId: 'statPfpSub'  },
      { id: 'cardWff',      var: 'PFP-WAITING-FF', invId: 'statWffInvoices',  subId: 'statWffSub'  },
      { id: 'cardDrop',     var: 'PFP-DROP',       invId: 'statDropInvoices', subId: 'statDropSub' },
      { id: 'cardPickPack', var: 'PFP-PICK-PACK',  invId: 'statPpInvoices',   subId: 'statPpSub'   },
    ];
    map.forEach(m => {
      const v = byVariant[m.var];
      if (v) {
        document.getElementById(m.invId).textContent = fmtCur(v.TotalValue);
        document.getElementById(m.subId).textContent = fmtN(v.Lines) + ' lines · ' + fmtN(v.Invoices) + ' invoices';
      } else {
        document.getElementById(m.invId).textContent = fmtCur(0);
        document.getElementById(m.subId).textContent = '0 lines';
      }
    });

    // Highlight the active card
    document.querySelectorAll('.wh-stat-card.clickable').forEach(card => {
      const isActive = (card.dataset.variant || '') === pfpVariant;
      card.classList.toggle('active', isActive);
    });
  }

  async function load() {
    const tbody = document.getElementById('whTbody');
    tbody.innerHTML = `<tr><td colspan="29" class="wh-loading">Loading…</td></tr>`;
    try {
      const qsObj = { search, tracked, dateFrom, dateTo, days, page, limit };
      if (pfpVariant) qsObj.remarks = pfpVariant;
      const url = ENDPOINT + WH.qs(qsObj);
      const res = await apiRequest(url);
      const rows = (res && res.data) || [];
      document.getElementById('whCount').textContent = (res?.total || 0) + ' lines';

      // Stat cards (PFP mode only — backend skips stats when ?showPosted=1)
      // Cards are always visible; values fill in when stats arrive. Handles
      // both NEW format (stats.variants[] + stats.all) AND OLD format (flat
      // TotalLines/TotalInvoices/TotalValue/DispatchedLines/PendingLines)
      // so a stale node process doesn't leave the cards blank.
      if (res && res.stats) {
        if (res.stats.variants) {
          paintVariantCards(res.stats);
        } else {
          // Old-format fallback — fill only the All card with what we have
          const fmtCur = (n) => '$ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const fmtN   = (n) => Number(n || 0).toLocaleString('en-US');
          const allInv = document.getElementById('statAllInvoices');
          const allSub = document.getElementById('statAllSub');
          if (allInv) allInv.textContent = fmtCur(res.stats.TotalValue);
          if (allSub) allSub.textContent = fmtN(res.stats.TotalLines) + ' lines · old-format stats (restart node for breakdown)';
        }
      }

      // Visual hint when filters are active
      const isFiltered = !!(search || dateFrom || dateTo || (tracked && tracked !== 'all'));
      const cb = document.getElementById('whClear');
      if (cb) cb.classList.toggle('has-active', isFiltered);
      _rowsByKey = new Map();
      for (const r of rows) _rowsByKey.set(keyOf(r), r);

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="29" class="wh-empty">No upcoming (PFP) invoices right now. When Pune marks an SO line with Remarks='PFP', it will appear here.</td></tr>`;
      } else {
        tbody.innerHTML = rows.map(rowHtml).join('');
        tbody.querySelectorAll('button[data-action="save"]').forEach(b => {
          b.onclick = () => saveRow(b.dataset.key);
        });
      }
      WH.renderPaging('whPaging', res?.total || 0, page, limit, (p) => { page = p; load(); });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="29" class="wh-empty">Failed to load: ${WH.esc(e.message)}</td></tr>`;
    }
  }

  function rowHtml(r) {
    const canWrite = WH.canWrite();
    const key = keyOf(r);
    const trk = r.IsTracked;
    const k = (name) => `data-key="${key}" data-field="${name}"`;
    const trClass = trk ? 'tracked' : 'untracked';

    const ip = (name, type, val, extra = '') => canWrite
      ? `<td><input ${k(name)} type="${type}" value="${val == null ? '' : WH.esc(val)}" ${extra}></td>`
      : `<td>${WH.esc(val ?? '')}</td>`;
    const ipNum = (name, val, step) => canWrite
      ? `<td class="num"><input ${k(name)} type="number" step="${step}" value="${val == null ? '' : val}"></td>`
      : `<td class="num">${WH.esc(val ?? '')}</td>`;
    const cb = (name, val, datalistId) => canWrite
      ? `<td><input ${k(name)} type="text" list="${datalistId}" value="${val == null ? '' : WH.esc(val)}"></td>`
      : `<td>${WH.esc(val ?? '')}</td>`;

    return `<tr class="${trClass}" data-row-key="${key}">
      <!-- 1 NAV Date -->
      <td class="nav-col">${WH.fmtDate(r.InvoiceDate)}</td>
      <!-- 2 NAV Invoice No -->
      <td class="nav-col"><b>${WH.esc(r.InvoiceNo)}</b></td>
      <!-- 3 NAV Customer Name (Bill-to Name) -->
      <td class="nav-col">${WH.esc(r.CustomerName || '')}</td>
      <!-- 4 NAV Customer Address (Bill-to Address) -->
      <td class="nav-col">${WH.esc(r.CustomerAddress || '')}</td>
      <!-- 5 NAV Po No (External Document No_) -->
      <td class="nav-col">${WH.esc(r.CustomerPo || '')}</td>
      <!-- 6 NAV Item Name (Vendor Item No_) -->
      <td class="nav-col">${WH.esc(r.ItemName || '')}</td>
      <!-- 7 NAV Make (Shortcut Dimension 2 Code) -->
      <td class="nav-col">${WH.esc(r.Make || '')}</td>
      <!-- 8 NAV Qty -->
      <td class="num nav-col">${WH.fmt0(r.Quantity)}</td>
      <!-- 9 NAV Rate (Unit Price) -->
      <td class="num nav-col">${WH.fmt2(r.UnitPrice)}</td>
      <!-- 10 NAV Value (Amount) -->
      <td class="num nav-col">${WH.fmt2(r.LineAmount)}</td>
      <!-- 11 NAV Bank Charge (GL 4112904 sum). NULL in PFP mode (pre-posting). -->
      <td class="num nav-col">${r.BankCharge == null ? '—' : WH.fmt2(r.BankCharge)}</td>
      <!-- 12 NAV GST (Charges To Customer) -->
      <td class="num nav-col">${WH.fmt2(r.GstAmount)}</td>
      <!-- 13 NAV Total Amt (Amount To Customer) -->
      <td class="num nav-col"><b>${WH.fmt2(r.AmountInclVAT)}</b></td>
      <!-- 14 Manual Cartoons -->
      ${ipNum('Cartons', r.Cartons, '1')}
      <!-- 15 Manual Diamension -->
      ${ip('Dimension', 'text', r.Dimension)}
      <!-- 16 Manual Weight -->
      ${ipNum('WeightKg', r.WeightKg, '0.001')}
      <!-- 17 Manual Dispatch Through (combobox) -->
      ${cb('DispatchThrough', r.DispatchThrough, 'dl-sales-dispatch-through')}
      <!-- 18 Manual AWB -->
      ${ip('AirWaybillNo', 'text', r.AirWaybillNo)}
      <!-- 19 NAV Shipment Terms (Transport Method) -->
      <td class="nav-col">${WH.esc(r.ShipmentTerms || '')}</td>
      <!-- 20 NAV Freight Charges (GL 3112021 sum). NULL in PFP mode (pre-posting). -->
      <td class="num nav-col">${r.FreightCharges == null ? '—' : WH.fmt2(r.FreightCharges)}</td>
      <!-- 21 Manual Local Charges -->
      ${ipNum('LocalCharges', r.LocalCharges, '0.01')}
      <!-- 22 Manual Dispatch Date -->
      ${ip('DispatchDate', 'date', WH.toInputDate(r.DispatchDate))}
      <!-- 23 NAV Currency -->
      <td class="nav-col">${WH.esc(r.Currency || '')}</td>
      <!-- 24 Manual Status (combobox) -->
      ${cb('Status', r.Status, 'dl-sales-status')}
      <!-- 25 Manual Fright Invoice -->
      ${ip('FrightInvoice', 'text', r.FrightInvoice)}
      <!-- 26 Manual Permit No -->
      ${ip('PermitNo', 'text', r.PermitNo)}
      <!-- 27 Manual Export Permit Type (combobox) -->
      ${cb('ExportPermitType', r.ExportPermitType, 'dl-export-permit')}
      <!-- 28 Manual GST Claimed Month -->
      ${ip('GSTClaimedMonth', 'text', r.GSTClaimedMonth, 'placeholder="2026-Q2"')}
      <!-- 29 Save -->
      <td class="actions-col">${canWrite
        ? `<button class="row-save" data-action="save" data-key="${key}" title="Save manual fields">💾</button>`
        : ''}</td>
    </tr>`;
  }

  async function saveRow(key) {
    const tr = document.querySelector(`tr[data-row-key="${CSS.escape(key)}"]`);
    if (!tr) { WH.toast('Row not found', 'error'); return; }
    const navRow = _rowsByKey.get(key);
    if (!navRow) { WH.toast('NAV row missing — reload page', 'error'); return; }

    const payload = { InvoiceNo: navRow.InvoiceNo, LineNumber: navRow.LineNumber };
    tr.querySelectorAll('[data-field]').forEach(el => {
      const name = el.dataset.field;
      let v;
      if (el.tagName === 'SELECT') {
        v = el.value === '' ? null : el.value;
      } else if (el.type === 'number') {
        v = el.value === '' ? null : Number(el.value);
      } else {
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
})();
