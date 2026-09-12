/* warehouse/stocks.js — NAV-first Inventory list with inline-edit rows.
   Source: NAV Item Ledger Entry (Entry Type=Purchase, Open, Remaining Qty > 0)
   joined to Item + Value Entry (for unit cost) + LEFT JOIN BN_WhStock.
   Save = UPSERT MERGE on (Company, IleEntryNo). */

(function () {
  const ENDPOINT = '/warehouse/stocks';
  const PAGE_LIMIT = 50;

  let page = 1, limit = PAGE_LIMIT;
  let search = '', tracked = 'all', location = '', days = 1095, dateFrom = '', dateTo = '';
  let _rowsByKey = new Map();

  document.addEventListener('DOMContentLoaded', () => {
    const u = requireAuth(); if (!u) return;
    renderSidebar('wh-stocks');
    const rt = document.getElementById('roleTag');
    if (rt) rt.textContent = (u.role || '').toUpperCase();

    document.getElementById('whSearch').addEventListener('input', debounce(() => {
      search = document.getElementById('whSearch').value.trim();
      page = 1; load();
    }, 280));

    const trackedSel = document.getElementById('whStatus');
    if (trackedSel) {
      trackedSel.innerHTML = `
        <option value="all">All on-hand items</option>
        <option value="no">Not yet tracked</option>
        <option value="yes">Already tracked</option>`;
      trackedSel.value = tracked;
      trackedSel.addEventListener('change', () => {
        tracked = trackedSel.value; page = 1; load();
      });
    }
    document.getElementById('whApply').onclick = () => {
      location = document.getElementById('whLoc').value.trim();
      dateFrom = document.getElementById('whFrom').value;
      dateTo   = document.getElementById('whTo').value;
      page = 1; load();
    };

    // Clear Filters
    const clearBtn = document.getElementById('whClear');
    if (clearBtn) {
      clearBtn.onclick = () => {
        search = ''; location = ''; dateFrom = ''; dateTo = ''; tracked = 'all';
        document.getElementById('whSearch').value = '';
        document.getElementById('whLoc').value = '';
        document.getElementById('whFrom').value = '';
        document.getElementById('whTo').value = '';
        const ts = document.getElementById('whStatus');
        if (ts) ts.value = 'all';
        clearBtn.classList.remove('has-active');
        page = 1; load();
      };
    }

    if (WH.canWrite()) WH.wireImport('whImport', 'whFile', ENDPOINT, load);
    else { const imp = document.getElementById('whImport'); if (imp) imp.style.display = 'none'; }
    WH.wireExport('whExport', ENDPOINT, () => ({ search, tracked, location, dateFrom, dateTo, days }));

    // Populate the Carton No <datalist> from all existing carton numbers
    // so Amit gets autocomplete suggestions while still being able to type
    // a brand-new number.
    refreshCartonList();
    refreshLocationList();

    load();
  });

  function keyOf(r) {
    return String(r.IleEntryNo);
  }

  async function load() {
    const tbody = document.getElementById('whTbody');
    tbody.innerHTML = `<tr><td colspan="28" class="wh-loading">Loading…</td></tr>`;
    try {
      const url = ENDPOINT + WH.qs({ search, tracked, location, dateFrom, dateTo, days, page, limit });
      const res = await apiRequest(url);
      const rows = (res && res.data) || [];
      const totalQty = res?.totalQtyRemaining || 0;
      document.getElementById('whCount').textContent =
        (res?.total || 0) + ' items · ' + WH.fmt0(totalQty) + ' pcs';

      // Highlight Clear Filters button if any filter is active
      const isFiltered = !!(search || location || dateFrom || dateTo || (tracked && tracked !== 'all'));
      const cb = document.getElementById('whClear');
      if (cb) cb.classList.toggle('has-active', isFiltered);
      _rowsByKey = new Map();
      for (const r of rows) _rowsByKey.set(keyOf(r), r);

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="28" class="wh-empty">No on-hand items in this date range. Widen the date filter on the toolbar.</td></tr>`;
      } else {
        tbody.innerHTML = rows.map(rowHtml).join('');
        tbody.querySelectorAll('button[data-action="save"]').forEach(b => {
          b.onclick = () => saveRow(b.dataset.key);
        });
        tbody.querySelectorAll('button[data-action="split"]').forEach(b => {
          b.onclick = () => splitRow(Number(b.dataset.id), b);
        });
        tbody.querySelectorAll('button[data-action="delete"]').forEach(b => {
          b.onclick = () => deleteRow(Number(b.dataset.id), b.dataset.carton, Number(b.dataset.qty), b);
        });
      }
      WH.renderPaging('whPaging', res?.total || 0, page, limit, (p) => { page = p; load(); });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="28" class="wh-empty">Failed to load: ${WH.esc(e.message)}</td></tr>`;
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
    const sel = (name, val, opts) => {
      if (!canWrite) return `<td>${WH.esc(val ?? '')}</td>`;
      const optHtml = opts.map(o =>
        `<option value="${WH.esc(o)}" ${val === o ? 'selected' : ''}>${WH.esc(o || '—')}</option>`
      ).join('');
      return `<td><select ${k(name)}>${optHtml}</select></td>`;
    };

    // Lineage badge — shows "↳ split from C-XXXX" when this row was derived
    // from a Split action so Amit can see at a glance which physical carton
    // it came out of.
    const lineage = r.SplitFromCarton
      ? `<div class="split-lineage" title="This row was created by splitting carton ${WH.esc(r.SplitFromCarton)}">↳ from ${WH.esc(r.SplitFromCarton)}</div>`
      : '';

    return `<tr class="${trClass}" data-row-key="${key}" data-id="${r.Id ?? ''}">
      <!-- Manual SN -->
      ${ipNum('SN', r.SN, '1')}
      <!-- Manual Cartoon No (combobox: dropdown of existing cartons + free text) -->
      ${canWrite
        ? `<td><input ${k('CartonNo')} type="text" list="dl-carton-no" value="${r.CartonNo == null ? '' : WH.esc(r.CartonNo)}" placeholder="C-12944">${lineage}</td>`
        : `<td>${WH.esc(r.CartonNo ?? '')}${lineage}</td>`}
      <!-- NAV Invoice No (= Document No / Receipt No) -->
      <td class="nav-col">${WH.esc(r.InvoiceNo || '')}</td>
      <!-- Manual NEW Location (combobox: pick existing or type new) -->
      ${canWrite
        ? `<td><input ${k('NewLocation')} type="text" list="dl-stock-location" value="${r.NewLocation == null ? '' : WH.esc(r.NewLocation)}" placeholder="pick or type"></td>`
        : `<td>${WH.esc(r.NewLocation ?? '')}</td>`}
      <!-- NAV Location -->
      <td class="nav-col">${WH.esc(r.Location || '')}</td>
      <!-- NAV MPN (item no = Vendor Item No_) — Description column removed per spec -->
      <td class="nav-col"><b>${WH.esc(r.ItemNo || '')}</b></td>
      <!-- NAV Make = Item.[Global Dimension 2 Code] -->
      <td class="nav-col">${WH.esc(r.Make || '')}</td>
      <!-- Qty cell:
           • Tracked rows → editable QtyPcs input (the warehouse lead's per-carton count),
             with the NAV total shown as a tooltip + tiny "/ NAV total" suffix
           • Untracked rows → read-only NAV Qty Remaining -->
      ${trk
        ? `<td class="num"><input ${k('QtyPcs')} type="number" value="${r.QtyPcs == null ? '' : r.QtyPcs}"
              title="NAV total on hand for this item: ${WH.fmt0(r.QtyRemaining)}">
              ${r.QtyRemaining != null ? `<div class="qty-of-nav">of ${WH.fmt0(r.QtyRemaining)}</div>` : ''}
           </td>`
        : `<td class="num nav-col"><b>${WH.fmt0(r.QtyRemaining)}</b></td>`}
      <!-- Manual Dimension -->
      ${ip('Dimension', 'text', r.Dimension)}
      <!-- Manual Weight -->
      ${ipNum('WeightKg', r.WeightKg, '0.001')}
      <!-- NAV Origin (Country/Region Code) -->
      <td class="nav-col">${WH.esc(r.Origin || '')}</td>
      <!-- Manual Date Code -->
      ${ip('DateCode', 'text', r.DateCode)}
      <!-- NAV Inword Date (Posting Date) -->
      <td class="nav-col">${WH.fmtDate(r.InwordDate)}</td>
      <!-- Computed Aging -->
      <td class="num nav-col">${r.AgingDays != null ? r.AgingDays : ''}</td>
      <!-- NAV Purchase Price (UnitCost from Value Entry) -->
      <td class="num nav-col">${WH.fmtN(r.UnitCost, 4)}</td>
      <!-- Manual Purchase Amount -->
      ${ipNum('PurchaseAmount', r.PurchaseAmount, '0.01')}
      <!-- Manual Cust Resale -->
      ${ipNum('CustResale', r.CustResale, '0.0001')}
      <!-- Manual Cust Resale Amount -->
      ${ipNum('CustResaleAmount', r.CustResaleAmount, '0.01')}
      <!-- Manual Customer Name -->
      ${ip('CustomerName', 'text', r.CustomerName)}
      <!-- Manual Franchise -->
      ${sel('FranchiseType', r.FranchiseType || '', ['', 'F', 'NF'])}
      <!-- Manual Status (combobox = dropdown + free text) -->
      ${canWrite
        ? `<td><input ${k('Status')} type="text" list="dl-stock-status" value="${r.Status == null ? '' : WH.esc(r.Status)}"></td>`
        : `<td>${WH.esc(r.Status ?? '')}</td>`}
      <!-- Manual Dispatched Date -->
      ${ip('DispatchedDate', 'date', WH.toInputDate(r.DispatchedDate))}
      <!-- Manual Remark -->
      ${ip('Remark', 'text', r.Remark)}
      <!-- Manual Package -->
      ${ip('Package', 'text', r.Package)}
      <!-- Manual Type -->
      ${ip('ItemType', 'text', r.ItemType)}
      <!-- Manual Legend -->
      ${ip('Legend', 'text', r.Legend)}
      <!-- Manual Meaning -->
      ${ip('Meaning', 'text', r.Meaning)}
      <!-- Save + Split + Delete actions -->
      <td class="actions-col">${canWrite ? `
        <button class="row-save" data-action="save" data-key="${key}" title="Save this carton's tracking">💾</button>
        ${trk ? `<button class="row-split" data-action="split" data-id="${r.Id}" title="Split this carton into smaller pieces">✂</button>` : ''}
        ${trk ? `<button class="row-delete" data-action="delete" data-id="${r.Id}" data-carton="${WH.esc(r.CartonNo || '')}" data-qty="${r.QtyPcs || 0}" title="Delete this carton (mistakenly added)">✕</button>` : ''}
      ` : ''}</td>
    </tr>`;
  }

  async function saveRow(key) {
    const tr = document.querySelector(`tr[data-row-key="${CSS.escape(key)}"]`);
    if (!tr) { WH.toast('Row not found', 'error'); return; }
    const navRow = _rowsByKey.get(key);
    if (!navRow) { WH.toast('NAV row missing — reload page', 'error'); return; }

    // IleEntryNo from NAV is the link key
    const payload = {
      IleEntryNo: navRow.IleEntryNo,
      InvoiceNo:  navRow.InvoiceNo,    // helpful for fallback search
      MPN:        navRow.ItemNo,       // mirror NAV Item No into MPN field
      Make:       navRow.Make,
      Origin:     navRow.Origin,
      Location:   navRow.Location,
      InwordDate: navRow.InwordDate,
      QtyPcs:     navRow.QtyRemaining,
      PurchasePrice: navRow.UnitCost,
    };
    tr.querySelectorAll('[data-field]').forEach(el => {
      const name = el.dataset.field;
      let v;
      if (el.tagName === 'SELECT') v = el.value === '' ? null : el.value;
      else if (el.type === 'number') v = el.value === '' ? null : Number(el.value);
      else v = el.value === '' ? null : el.value;
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

  // Fetch all existing carton numbers and populate the <datalist>
  // (autocomplete source for every Cartoon No input on the page).
  async function refreshCartonList() {
    try {
      const r = await apiRequest('/warehouse/stocks/carton-list');
      const dl = document.getElementById('dl-carton-no');
      if (dl && r && Array.isArray(r.data)) {
        dl.innerHTML = r.data.map(c => `<option value="${WH.esc(c)}">`).join('');
      }
    } catch (_) { /* silent — no list is OK */ }
  }

  // Same idea for NEW Location — feeds the Location combobox so Amit can
  // pick an existing bin or type a new one.
  async function refreshLocationList() {
    try {
      const r = await apiRequest('/warehouse/stocks/location-list');
      const dl = document.getElementById('dl-stock-location');
      if (dl && r && Array.isArray(r.data)) {
        dl.innerHTML = r.data.map(x => `<option value="${WH.esc(x)}">`).join('');
      }
    } catch (_) { /* silent */ }
  }

  // ── Split a carton with MANUAL per-piece qtys ───────────────────────
  // The prompt accepts either:
  //   • A single number (e.g. "3") → equal divide (backend computes parts)
  //   • A comma-separated list (e.g. "5000,3000,2000") → exact qtys
  // The sum must equal the source carton's qty (backend rejects mismatch
  // with a clear delta so Amit knows what to adjust).
  async function splitRow(id, btn) {
    const navRow = Array.from(_rowsByKey.values()).find(r => r.Id === id);
    if (!navRow) { WH.toast('Row not in cache; reload page', 'error'); return; }
    const sourceQty = Number(navRow.QtyPcs || 0);
    if (sourceQty <= 0) { WH.toast('Cannot split — qty is zero', 'error'); return; }

    const label = `${navRow.CartonNo || navRow.ItemNo || ''} · ${WH.fmt0(sourceQty)} pcs`;
    const raw = prompt(
      `Split carton (${label}) — choose ONE option:\n\n` +
      `• Enter a number (2–50) → equal divide\n` +
      `    e.g. "3" splits ${WH.fmt0(sourceQty)} into 3 equal parts\n\n` +
      `• Enter comma-separated qtys → exact per-carton amounts\n` +
      `    e.g. "5000,3000,2000" (sum MUST equal ${WH.fmt0(sourceQty)})\n` +
      `    or "10000,10000,10000,10000,10000,10000,10000,10000,10000,10000"\n` +
      `      for 10 cartons of 10K each`,
      '2'
    );
    if (raw == null) return;
    const trimmed = String(raw).trim();
    if (!trimmed) return;

    // Decide manual vs equal-divide based on whether the entry has commas
    let body;
    if (trimmed.includes(',')) {
      const qtys = trimmed.split(',').map(s => Math.floor(Number(s.trim()) || 0));
      if (qtys.length < 2 || qtys.length > 50 || qtys.some(q => q <= 0)) {
        WH.toast('Each qty must be a positive integer; 2–50 cartons total', 'error');
        return;
      }
      const sum = qtys.reduce((a, b) => a + b, 0);
      if (sum !== sourceQty) {
        WH.toast(`Sum is ${sum.toLocaleString()} — must equal ${sourceQty.toLocaleString()} (diff ${(sum - sourceQty).toLocaleString()})`, 'error');
        return;
      }
      body = { qtys };
    } else {
      const parts = parseInt(trimmed, 10);
      if (!Number.isFinite(parts) || parts < 2 || parts > 50) {
        WH.toast('Enter 2–50, or comma-separated qtys summing to ' + sourceQty, 'error');
        return;
      }
      body = { parts };
    }

    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      const r = await apiRequest('/warehouse/stocks/' + id + '/split', { method: 'POST', body });
      if (r && r.ok) {
        const breakdown = [r.originalQty].concat(r.childQtys || []).map(q => WH.fmt0(q)).join(' · ');
        WH.toast(`Split into ${r.total} cartons: ${breakdown}`, 'success');
        setTimeout(() => { load(); refreshCartonList(); }, 600);
      } else {
        WH.toast(r?.message || 'Split failed', 'error');
        if (btn) { btn.textContent = '✂'; btn.disabled = false; }
      }
    } catch (err) {
      WH.toast(err.message || 'Split failed', 'error');
      if (btn) { btn.textContent = '✂'; btn.disabled = false; }
    }
  }

  // ── Delete a mistakenly-inserted carton row ───────────────────────────
  // Calls DELETE /api/warehouse/stocks/:id which is a soft-delete (IsActive=0)
  // in BN_WhStock — the row is hidden from the UI but kept in the DB so we
  // can audit accidental deletes if needed.
  async function deleteRow(id, cartonNo, qty, btn) {
    if (!Number.isFinite(id) || id <= 0) { WH.toast('Bad row id', 'error'); return; }
    const label = cartonNo ? `Carton ${cartonNo}` : `Stock row #${id}`;
    const qtyText = qty ? ` (${qty.toLocaleString()} pcs)` : '';
    if (!confirm(`Delete ${label}${qtyText}?\n\nThis hides the row from Stocks. It can be restored from the DB if needed, but Amit won't see it anymore.`)) return;

    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      const r = await apiRequest('/warehouse/stocks/' + id, { method: 'DELETE' });
      if (r && r.ok) {
        WH.toast('Carton deleted', 'success');
        load();
      } else {
        WH.toast(r?.message || 'Delete failed', 'error');
        if (btn) { btn.textContent = '✕'; btn.disabled = false; }
      }
    } catch (err) {
      WH.toast(err.message || 'Delete failed', 'error');
      if (btn) { btn.textContent = '✕'; btn.disabled = false; }
    }
  }
})();
