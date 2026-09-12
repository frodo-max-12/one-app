// frontend/modules/product/js/dc.js — Product DC (Design-Conversion) File
// CRUD + Excel import/export over /api/product/dc. Mirrors the PDC page patterns.

(function () {
  const API = '/product/dc';
  let allRows = [];
  let currentSummary = {};
  let currentByCurrency = [];
  let currentFunnel = [];
  let currentPms = [];      // PM facet (product-team members ∪ PMs already in the data)
  let currentSalesUsers = [];  // Add-form Sales Person options (salespeople with a login)
  let currentFaeUsers = [];    // Add-form FAE Person options (FAE with a login)
  let currentBucket = '';   // active funnel-card filter (NBO/DIN/PWIN/DWIN/MWIN/LOSS/OTHER)
  let totalRows = 0;
  let page = 1;
  const PAGE = 50;

  // ── current user (for delete-button gating; backend enforces too) ──
  function getUser() {
    try { return JSON.parse(localStorage.getItem('nav_user') || sessionStorage.getItem('nav_user') || '{}'); }
    catch (_) { return {}; }
  }
  const role = (getUser().role || '').toLowerCase().trim();
  const canDelete = ['product head', 'admin', 'operation head', 'director'].includes(role);
  // Head + admin see all PMs' lines + can assign PM; assistants are locked to their own.
  const canSeeAllPm = ['product head', 'admin', 'operation head', 'director'].includes(role);
  const myPmName = (getUser().name || '').trim().split(/\s+/)[0];
  // Product team + admin OWN the sheet (add / import / PM tools). Sales & FAE get a
  // row-scoped VIEW + EDIT of their own rows (backend enforces the scope); the
  // add / import / PM-management controls are hidden for them.
  const isProductUser = ['product head', 'product assistant', 'admin', 'operation head', 'director'].includes(role);
  const isFaeUser = ['fae', 'fae head'].includes(role);
  const isFaeHeadUser = (role === 'fae head');
  const isSalesHeadUser = ['sales head', 'north sales head', 'south sales head', 'sales head electrical', 'electrical head'].includes(role);
  // Person dropdowns (like the Product PM dropdown): a sales head filters their salespeople,
  // the FAE head filters their FAEs, Product/admin get BOTH. Options come from the API facet.
  const showSalesDropdown = isProductUser || isSalesHeadUser;
  const showFaeDropdown   = isProductUser || isFaeHeadUser;
  // Column-level edit right for non-product users: a salesperson/sales-head edits ONLY the
  // Sales Team Remark (fCurrentStatus); FAE/FAE-head edits ONLY the FAE Team remark
  // (fActionItem). Product/admin (null) edit every field. Backend enforces this too.
  const myEditField = isProductUser ? null : (isFaeUser ? 'fActionItem' : 'fCurrentStatus');
  // Typed workflow fields Sales/FAE may OVERWRITE (in addition to appending their remark):
  // FAE own Project Status / Samples stage / PP date (FAE); Sales own MP date (Sales).
  // Backend enforces the same whitelist; column names are never taken from the client.
  const myOverwriteFields = isProductUser ? [] : (isFaeUser
    ? ['fProjectStatus', 'fSamplesStage', 'fPpDateFae']
    : ['fMpDateSales']);
  const OW_BODY_KEY = { fProjectStatus: 'projectStatus', fSamplesStage: 'samplesStage', fPpDateFae: 'ppDateFae', fMpDateSales: 'mpDateSales' };
  // Region dropdown filter — shown to PM/admin, FAE head & sales heads for region-wise slicing.
  const showRegionDropdown = isProductUser || isSalesHeadUser || isFaeHeadUser;

  // ── helpers ──
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtNum(n) { if (n == null || n === '') return '—'; const v = Number(n); if (isNaN(v)) return '—'; return v.toLocaleString('en-IN'); }
  function fmtMoney(n) { if (n == null || n === '') return '—'; const v = Number(n); if (isNaN(v) || v === 0) return '—'; return v.toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  function fmtDate(iso) { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }); }
  function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function set(id, v) { const e = document.getElementById(id); if (e) e.value = (v == null ? '' : v); }
  // For <select> fields: if a saved/imported value isn't one of the preset options,
  // inject it so editing a legacy row doesn't silently blank (and lose) the value.
  function ensureOption(selId, v) {
    if (v == null || v === '') return;
    const sel = document.getElementById(selId); if (!sel || sel.tagName !== 'SELECT') return;
    if (![...sel.options].some(o => o.value === String(v))) {
      const o = document.createElement('option'); o.value = String(v); o.textContent = String(v); sel.appendChild(o);
    }
  }

  // ── load list ──
  async function loadList() {
    const params = new URLSearchParams();
    const search = val('dcSearch');
    if (search) params.set('search', search);
    // Send the company as filterCompany so it scopes the DC sheet ONLY when the dropdown
    // picks one. (apiRequest auto-appends ?company=<active> to every call; the DC list
    // ignores that and reads filterCompany, so "All companies" shows COMPANYA + CompanyB.)
    const company = document.getElementById('dcCompany').value;
    if (company) params.set('filterCompany', company);
    const pm = document.getElementById('dcPm') ? document.getElementById('dcPm').value : '';
    if (pm) params.set('pm', pm);
    const sp = document.getElementById('dcSalesPerson') ? document.getElementById('dcSalesPerson').value : '';
    if (sp) params.set('salesPerson', sp);
    const fp = document.getElementById('dcFae') ? document.getElementById('dcFae').value : '';
    if (fp) params.set('faePerson', fp);
    const rg = document.getElementById('dcRegion') ? document.getElementById('dcRegion').value : '';
    if (rg) params.set('region', rg);
    const status = val('dcStatus'); if (status) params.set('projectStatus', status);
    if (currentBucket) params.set('bucket', currentBucket);
    const from = val('dcFromDate'); if (from) params.set('fromDate', from);
    const to = val('dcToDate'); if (to) params.set('toDate', to);
    params.set('page', page); params.set('limit', PAGE);
    document.getElementById('dcClearSearch').style.display = search ? '' : 'none';
    document.getElementById('dcBody').innerHTML = `<tr><td colspan="23" class="dc-loading">Loading…</td></tr>`;
    try {
      const data = await apiRequest(`${API}?${params.toString()}`);
      allRows = data.data || [];
      totalRows = data.total || 0;
      currentSummary = data.summary || {};
      currentByCurrency = data.byCurrency || [];
      currentFunnel = data.funnel || [];
      populatePeopleDropdowns(data.salesPersons || [], data.faePersons || []);
      fillPersonSelect('dcRegion', 'All Regions', data.regions || [], showRegionDropdown);
      currentPms = data.pms || [];
      fillPmSelects(currentPms);
      currentSalesUsers = data.salesUsers || [];
      currentFaeUsers = data.faeUsers || [];
      fillFormPersonSelects();
      renderTable(); renderStats(); renderPagination();
    } catch (e) {
      document.getElementById('dcBody').innerHTML = `<tr><td colspan="23" class="dc-loading" style="color:var(--red);">Failed: ${esc(e.message || e)}</td></tr>`;
    }
  }

  // ── currency-aware money formatting (₹ uses Cr/L; $/€ grouped) ──
  function curMeta(cur) { return ({ INR: { s: '₹', l: 'en-IN' }, USD: { s: '$', l: 'en-US' }, EUR: { s: '€', l: 'en-US' } }[cur]) || { s: '', l: 'en-IN' }; }
  function fmtCurShort(cur, n) {
    const v = Number(n) || 0; const m = curMeta(cur);
    if (cur === 'INR') {
      if (v >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
      if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
      return '₹' + v.toLocaleString('en-IN');
    }
    return m.s + v.toLocaleString(m.l, { maximumFractionDigits: 0 });
  }

  // Fill the Salesperson / FAE dropdowns from the API facet (scoped to the user's team),
  // preserving the current selection. Only shown for the roles that get a person dropdown.
  function fillPersonSelect(id, allLabel, items, show) {
    const sel = document.getElementById(id); if (!sel) return;
    if (!show) { sel.style.display = 'none'; return; }
    const cur = sel.value;
    sel.innerHTML = [`<option value="">${allLabel}</option>`]
      .concat((items || []).map(v => `<option value="${esc(v)}">${esc(v)}</option>`)).join('');
    if (cur && (items || []).includes(cur)) sel.value = cur;
    sel.style.display = '';
  }
  function populatePeopleDropdowns(sales, fae) {
    fillPersonSelect('dcSalesPerson', 'All Salespersons', sales, showSalesDropdown);
    fillPersonSelect('dcFae', 'All FAE', fae, showFaeDropdown);
  }
  // Fill the PM filter (#dcPm) + the Add/Edit PM select (#fPm) from the API `pms` facet
  // (product-team members ∪ PMs already in the data), so a newly-created product user (e.g.
  // the ops head) is selectable immediately — the options used to be hardcoded to three names.
  function fillPmSelects(pms) {
    const list = pms || [];
    const filt = document.getElementById('dcPm');
    if (filt && canSeeAllPm) {
      const cur = filt.value;
      filt.innerHTML = ['<option value="">All PMs</option>']
        .concat(list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`)).join('');
      if (cur) filt.value = cur;
    }
    const form = document.getElementById('fPm');
    if (form) {
      const cur = form.value;
      // Head/admin can leave PM on "(auto from brand)" (value '') → each line's PM is derived from
      // its Suggested Make on save. Assistants are locked to their own name (handled in openEdit).
      const head = canSeeAllPm ? '<option value="">(auto from brand)</option>' : '';
      form.innerHTML = head + list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      if (cur && [...form.options].some(o => o.value === cur)) form.value = cur;
    }
  }
  // Fill the Add/Edit Sales Person + FAE Person <select>s from the login-user lists (a leading
  // blank "—" keeps them optional). ensureOption in openEdit re-injects any legacy free-text value.
  function fillFormPersonSelects() {
    // Line FAE is an FAE too → same option list; its leading option is "(auto from brand)" (value '').
    [['fSalesPerson', currentSalesUsers, '—'], ['fFaePerson', currentFaeUsers, '—'], ['fLineFae', currentFaeUsers, '(auto from brand)']].forEach(([id, items, blank]) => {
      const sel = document.getElementById(id); if (!sel || sel.tagName !== 'SELECT') return;
      const cur = sel.value;
      sel.innerHTML = [`<option value="">${blank}</option>`]
        .concat((items || []).map(v => `<option value="${esc(v)}">${esc(v)}</option>`)).join('');
      if (cur && (items || []).includes(cur)) sel.value = cur;
    });
  }

  function renderStats() {
    document.getElementById('dcCount').textContent = `${totalRows} line${totalRows === 1 ? '' : 's'}`;
    document.getElementById('statLines').textContent = fmtNum(currentSummary.TotalLines || 0);
    document.getElementById('statOps').textContent = fmtNum(currentSummary.DistinctOps || 0);
    renderPotentialCard(currentByCurrency);
    renderFunnel(currentFunnel);
  }

  // Potential card — one chip per currency; NEVER a cross-currency sum. Unspecified
  // (NA/blank currency) shown as a ⚠ count so the team knows to fill the Currency column.
  function renderPotentialCard(byCur) {
    const map = {}; (byCur || []).forEach(r => { map[r.Cur] = r; });
    const chips = [];
    ['INR', 'USD', 'EUR'].forEach(c => { if (map[c] && Number(map[c].Potential)) chips.push(`<span class="dc-pot-chip cur-${c}">${fmtCurShort(c, map[c].Potential)}</span>`); });
    const un = map['UNSPEC'];
    if (un && un.Lines) chips.push(`<span class="dc-pot-chip cur-UNSPEC" title="${un.Lines} line(s) have no Currency set — fill the Currency column so they're counted">⚠ ${un.Lines} unspec</span>`);
    document.getElementById('statPotential').innerHTML = chips.length ? chips.join('') : '<span class="stat-num">—</span>';
  }

  // Funnel — Potential by Project-Status bucket (NBO/DIN/DWIN/MWIN/LOSS/Other), each
  // currency kept separate. Buckets come from the leading token of Project Status.
  const FUNNEL_ORDER = ['NBO', 'DIN', 'PWIN', 'DWIN', 'MWIN', 'LOSS', 'OTHER'];
  const FUNNEL_LABEL = { NBO: 'NBO', DIN: 'DIN', PWIN: 'PWIN', DWIN: 'DWIN', MWIN: 'MWIN', LOSS: 'LOSS', OTHER: 'Other' };
  function renderFunnel(funnel) {
    const el = document.getElementById('dcFunnel'); if (!el) return;
    const agg = {}; FUNNEL_ORDER.forEach(b => { agg[b] = { lines: 0, cur: {} }; });
    (funnel || []).forEach(r => {
      const b = agg[r.Bucket] || agg.OTHER;
      b.lines += Number(r.Lines || 0);
      b.cur[r.Cur] = (b.cur[r.Cur] || 0) + Number(r.Potential || 0);
    });
    // Always show the 5 named buckets (so MWIN/LOSS are visible with their sum even at 0);
    // 'Other' only appears when it actually has rows.
    const present = FUNNEL_ORDER.filter(b => b !== 'OTHER' || agg[b].lines > 0);
    const hint = currentBucket ? ` <span class="dc-funnel-clear" onclick="filterBucket('${currentBucket}')">✕ clear ${FUNNEL_LABEL[currentBucket] || currentBucket} filter</span>` : '';
    el.innerHTML = `<div class="dc-funnel-title">Funnel — Potential by Project Status${hint}</div><div class="dc-funnel-row">` +
      present.map(b => {
        const a = agg[b];
        const money = ['INR', 'USD', 'EUR'].filter(c => a.cur[c]).map(c => `<div class="dc-funnel-money cur-${c}">${fmtCurShort(c, a.cur[c])}</div>`).join('');
        return `<div class="dc-funnel-card fb-${b}${currentBucket === b ? ' active' : ''}" onclick="filterBucket('${b}')" title="Click to show only ${FUNNEL_LABEL[b]} lines">
          <div class="dc-funnel-name">${FUNNEL_LABEL[b]}</div>
          <div class="dc-funnel-lines">${a.lines} line${a.lines === 1 ? '' : 's'}</div>
          ${money || '<div class="dc-funnel-money muted">—</div>'}
        </div>`;
      }).join('') + `</div>`;
  }

  // ── NAV customer typeahead (Add/Edit modal) — company-scoped to the form's Company ──
  let custSuggestTimer = null;
  function initCustomerSuggest() {
    const nameInput = document.getElementById('fCustomerName');
    const box = document.getElementById('dcCustSuggest');
    if (!nameInput || !box || nameInput._sugWired) return;
    nameInput._sugWired = true;
    nameInput.addEventListener('input', () => {
      clearTimeout(custSuggestTimer);
      const q = nameInput.value.trim();
      if (q.length < 2) { box.hidden = true; return; }
      custSuggestTimer = setTimeout(() => loadCustSuggestions(q), 220);
    });
    nameInput.addEventListener('focus', () => { const q = nameInput.value.trim(); if (q.length >= 2) loadCustSuggestions(q); });
    box.addEventListener('click', (e) => {
      const row = e.target.closest('.dc-suggest-row'); if (!row) return;
      nameInput.value = row.dataset.name || ''; box.hidden = true;
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#fCustomerName') && !e.target.closest('#dcCustSuggest')) box.hidden = true;
    });
  }
  async function loadCustSuggestions(q) {
    const box = document.getElementById('dcCustSuggest');
    const co = (document.getElementById('fCompany') || {}).value || 'COMPANYA';
    try {
      const r = await apiRequest(`/sales/customers/suggest?q=${encodeURIComponent(q)}&all=1&limit=20&company=${encodeURIComponent(co)}`);
      const rows = r.data || [];
      if (!rows.length) {
        box.innerHTML = `<div class="dc-suggest-empty">No ${esc(co)} NAV customer matches “${esc(q)}”. You can type the name manually.</div>`;
        box.hidden = false; return;
      }
      box.innerHTML = rows.map(c => `
        <div class="dc-suggest-row" data-name="${esc(c.Name)}">
          <div class="name">${esc(c.Name)}</div>
          <div class="meta">${esc(c.CustomerCode)}${c.City ? ' · ' + esc(c.City) : ''}${c.Phone ? ' · ' + esc(c.Phone) : ''}</div>
        </div>`).join('');
      box.hidden = false;
    } catch (_) { box.hidden = true; }   // silent — user can still type manually
  }

  function renderTable() {
    const b = document.getElementById('dcBody');
    if (!allRows.length) { b.innerHTML = `<tr><td colspan="23" class="dc-loading">No DC rows. Click “+ Add Line” or “Import Excel”.</td></tr>`; return; }
    b.innerHTML = allRows.map(r => `
      <tr ondblclick="openEdit(${r.DcId})">
        <td style="text-align:center;"><input type="checkbox" class="dc-chk" data-id="${r.DcId}" onchange="onRowCheck()" /></td>
        <td class="mono">${esc(r.OpNo || '—')}</td>
        <td style="white-space:nowrap;">${fmtDate(r.DcDate)}</td>
        <td>${esc(r.CustomerName || '—')}</td>
        <td>${esc(r.Vertical || '—')}</td>
        <td>${esc(r.Region || '—')}</td>
        <td>${esc(r.Company || '—')}</td>
        <td><b>${esc(r.PM || '—')}</b></td>
        <td>${esc(r.SalesPerson || '—')}</td>
        <td title="FAE who visited">${esc(r.FaePerson || '—')}</td>
        <td title="Line FAE — brand owner"><b>${esc(r.LineFae || '—')}</b></td>
        <td class="mono">${esc(r.ExistingMpn || '—')}<div class="dc-sub">${esc(r.ExistingMake || '')}</div></td>
        <td class="mono">${esc(r.SuggestedMpn || '—')}</td>
        <td>${esc(r.SuggestedMake || '—')}</td>
        <td><span class="dc-pill">${esc(r.ProjectStatus || '—')}</span></td>
        <td>${esc(r.SamplesStage || '—')}</td>
        <td class="r">${fmtNum(r.EauQty)}</td>
        <td class="r">${fmtMoney(r.UnitPriceUsd)}</td>
        <td class="r">${fmtMoney(r.Potential)}</td>
        <td class="dc-remark" title="${esc(r.ProductTeamRemarks || '')}">${esc(r.ProductTeamRemarks || '—')}</td>
        <td class="dc-remark" title="${esc(r.CurrentStatus || '')}">${esc(r.CurrentStatus || '—')}</td>
        <td class="dc-remark" title="${esc(r.ActionItem || '')}">${esc(r.ActionItem || '—')}</td>
        <td class="r"><button class="btn btn-ghost btn-sm" onclick="openEdit(${r.DcId})">✎</button></td>
      </tr>`).join('');
    const all = document.getElementById('dcSelAll'); if (all) { all.checked = false; all.indeterminate = false; }
    onRowCheck();
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(totalRows / PAGE));
    const el = document.getElementById('dcPagination');
    if (pages <= 1) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="gotoPage(${page - 1})">‹ Prev</button>
      <span style="margin:0 10px;">Page ${page} / ${pages}</span>
      <button class="btn btn-ghost btn-sm" ${page >= pages ? 'disabled' : ''} onclick="gotoPage(${page + 1})">Next ›</button>`;
  }
  window.gotoPage = function (p) { page = p; loadList(); };

  // ── selection ──
  function selectedIds() { return Array.from(document.querySelectorAll('.dc-chk:checked')).map(c => parseInt(c.dataset.id, 10)); }
  window.toggleSelectAll = function (ck) { document.querySelectorAll('.dc-chk').forEach(c => c.checked = ck); onRowCheck(); };
  window.clearSelection = function () { document.querySelectorAll('.dc-chk').forEach(c => c.checked = false); const a = document.getElementById('dcSelAll'); if (a) { a.checked = false; a.indeterminate = false; } onRowCheck(); };
  window.onRowCheck = function () {
    const ids = selectedIds();
    const bar = document.getElementById('dcSelBar');
    bar.style.display = ids.length ? 'flex' : 'none';
    document.getElementById('dcSelCount').textContent = ids.length;
    const del = document.getElementById('dcBulkDelBtn'); if (del) del.style.display = canDelete ? '' : 'none';
    const tot = document.querySelectorAll('.dc-chk').length, a = document.getElementById('dcSelAll');
    if (a) { a.checked = ids.length > 0 && ids.length === tot; a.indeterminate = ids.length > 0 && ids.length < tot; }
  };

  // ── search ──
  window.clearSearch = function () { set('dcSearch', ''); page = 1; loadList(); };
  window.clearFilters = function () {
    set('dcSearch', ''); set('dcStatus', ''); set('dcFromDate', ''); set('dcToDate', '');
    const co = document.getElementById('dcCompany'); if (co) co.value = '';
    const pm = document.getElementById('dcPm'); if (pm) pm.value = '';
    const sp = document.getElementById('dcSalesPerson'); if (sp) sp.value = '';
    const fp = document.getElementById('dcFae'); if (fp) fp.value = '';
    const rg = document.getElementById('dcRegion'); if (rg) rg.value = '';
    currentBucket = '';
    page = 1; loadList();
  };
  // Funnel-card click → filter the list to just that Project-Status bucket (server uses
  // the SAME bucket CASE, so the count on the card equals the rows shown). Click again to clear.
  window.filterBucket = function (b) {
    currentBucket = (currentBucket === b) ? '' : b;
    set('dcStatus', '');   // don't mix with the free-text status filter
    page = 1; loadList();
  };
  document.getElementById('dcSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; loadList(); } });

  window.loadList = function () { page = 1; loadList(); };

  // ── add / edit modal ──
  const FIELDS = ['Company', 'OpNo', 'DcDate', 'CustomerName', 'CustomerCategory', 'Vertical', 'Region', 'Segment',
    'SalesPerson', 'FaePerson', 'LineFae', 'Project', 'ExistingMpn', 'ExistingMake', 'SuggestedMpn', 'SuggestedMake',
    'ProjectStatus', 'SamplesStage', 'StatusMonth', 'SampleQty', 'EauQty', 'Qps', 'UnitPriceUsd', 'Currency',
    'Potential', 'PpDateFae', 'MpDateSales', 'ProductTeamRemarks', 'CurrentStatus', 'ActionItem', 'Remarks'];

  // Multi-line Add: which collected keys are the SHARED header vs the per-line detail.
  const HEADER_KEYS = ['company', 'pm', 'opNo', 'dcDate', 'customerName', 'customerCategory', 'vertical', 'region', 'segment', 'salesPerson', 'faePerson', 'lineFae', 'project'];
  const LINE_FIELDS = ['existingMpn', 'existingMake', 'suggestedMpn', 'suggestedMake', 'projectStatus', 'samplesStage', 'statusMonth', 'sampleQty', 'eauQty', 'qps', 'unitPriceUsd', 'currency', 'potential', 'ppDateFae', 'mpDateSales', 'productTeamRemarks', 'currentStatus', 'actionItem', 'remarks'];

  // Potential = EAU Qty × Unit Price — auto-fill, still editable (recomputes on either input).
  function recalcPotential(eauEl, upEl, potEl) {
    if (!eauEl || !upEl || !potEl) return;
    const e = parseFloat(eauEl.value), u = parseFloat(upEl.value);
    if (!isNaN(e) && !isNaN(u)) potEl.value = Math.round(e * u * 100) / 100;
  }
  function splitBody(full) {                        // flat body -> { header, line } for /bulk
    const header = {}, line = {};
    Object.keys(full).forEach(k => { (HEADER_KEYS.includes(k) ? header : line)[k] = full[k]; });
    return { header, line };
  }
  function collectExtraLines() {                     // read the stacked blocks, skip empty ones
    const out = [];
    document.querySelectorAll('#dcExtraLines .dc-line-block').forEach(block => {
      const ln = {};
      LINE_FIELDS.forEach(f => { const el = block.querySelector('.ln-' + f); ln[f] = el ? el.value.trim() : ''; });
      if (Object.values(ln).some(v => v !== '')) out.push(ln);
    });
    return out;
  }
  window.renumberLines = function () {
    document.querySelectorAll('#dcExtraLines .dc-line-block').forEach((b, i) => {
      const n = b.querySelector('.ln-num'); if (n) n.textContent = String(i + 2);   // Line 2, 3, …
    });
  };
  window.addLineBlock = function () {
    const tpl = document.getElementById('dcLineTpl'); if (!tpl) return;
    const node = tpl.content.firstElementChild.cloneNode(true);
    document.getElementById('dcExtraLines').appendChild(node);
    const eau = node.querySelector('.ln-eauQty'), up = node.querySelector('.ln-unitPriceUsd'), pot = node.querySelector('.ln-potential');
    const rc = () => recalcPotential(eau, up, pot);
    if (eau) eau.addEventListener('input', rc);
    if (up) up.addEventListener('input', rc);
    renumberLines();
  };

  window.openEdit = async function (id) {
    document.getElementById('dcError').style.display = 'none';
    FIELDS.forEach(f => set('f' + f, ''));
    set('fId', id || '');
    // Multi-line: clear stacked lines. Product/admin can stack extra lines in BOTH modes —
    // ADD (all new) and EDIT (the loaded row stays "Line 1"; extras become NEW lines under the
    // SAME OP/header). Sales/FAE never add (they only edit their own remark).
    const extraWrap = document.getElementById('dcExtraLines'); if (extraWrap) extraWrap.innerHTML = '';
    const canAddMulti = isProductUser;
    const alb = document.getElementById('dcAddLineBtn');
    if (alb) { alb.style.display = canAddMulti ? '' : 'none'; alb.textContent = id ? '+ Add another line to this OP' : '+ Add one more line'; }
    const l1h = document.getElementById('dcLine1Head'); if (l1h) l1h.style.display = canAddMulti ? '' : 'none';
    set('fCompany', document.getElementById('dcCompany').value || 'COMPANYA');
    set('fPm', canSeeAllPm ? '' : myPmName);   // '' = "(auto from brand)" for head/admin
    document.getElementById('dcModalTitle').textContent = id ? 'Edit DC Line' : 'Add DC Line';
    document.getElementById('dcDeleteBtn').style.display = (id && canDelete) ? '' : 'none';
    if (id) {
      try {
        const r = await apiRequest(`${API}/${id}`);
        const d = r.dc || {};
        ['Vertical', 'Region', 'Segment', 'CustomerCategory', 'SalesPerson', 'FaePerson', 'LineFae'].forEach(f => ensureOption('f' + f, d[f]));
        FIELDS.forEach(f => set('f' + f, d[f]));
        ensureOption('fPm', d.PM);
        set('fPm', d.PM || (canSeeAllPm ? '' : myPmName));
        // date fields come back via *Str (yyyy-mm-dd) for <input type=date>
        set('fDcDate', d.DcDateStr); set('fStatusMonth', d.StatusMonthStr);
        set('fPpDateFae', d.PpDateFaeStr); set('fMpDateSales', d.MpDateSalesStr);
      } catch (e) { alert('Load failed: ' + (e.message || e)); return; }
    }
    // Assistants can only file under their own name (PM locked); head/admin choose.
    const fpm = document.getElementById('fPm');
    if (!canSeeAllPm) { fpm.value = myPmName; fpm.disabled = true; } else { fpm.disabled = false; }
    applyEditPerms();
    document.getElementById('dcModal').hidden = false;
  };
  // Sales/FAE see the whole row for context but may edit ONLY their remark column —
  // everything else is locked (read-only). Product/admin edit everything.
  function applyEditPerms() {
    if (!myEditField) return;   // Product/admin edit everything (fPm handled separately above)
    const modal = document.getElementById('dcModal');
    // Lock the whole form EXCEPT this user's remark box AND the typed workflow fields their
    // role may overwrite (FAE: Project Status / Samples stage / PP date; Sales: MP date).
    modal.querySelectorAll('input, select, textarea').forEach(el => {
      if (el.id === 'fId') return;
      el.disabled = !(el.id === myEditField || myOverwriteFields.includes(el.id));
    });
    // Flag the editable typed fields so they read as "yours to change" (not just the remark).
    myOverwriteFields.forEach(fid => {
      const el = document.getElementById(fid); if (!el) return;
      const kv = el.closest('.kv'); if (kv) kv.classList.add('dc-editable-field');
    });
    // Append-log UX: show the existing entries READ-ONLY above a fresh "new entry" box.
    // On Save we send only the new text; the backend stamps it (date · name) and prepends it.
    const nm = (myEditField === 'fActionItem') ? 'FAE Team remark' : 'Sales Team Remark';
    const ta = document.getElementById(myEditField);
    const wrap = ta.closest('.dc-form-textarea');
    const existing = ta.value || '';
    let hist = wrap.querySelector('.dc-remark-log');
    if (!hist) { hist = document.createElement('pre'); hist.className = 'dc-remark-log'; wrap.insertBefore(hist, ta); }
    hist.textContent = existing.trim() ? existing : '(no remarks yet)';
    ta.value = '';
    ta.placeholder = 'Type a new remark — added on top with today’s date & your name on Save';
    ta.disabled = false;
    const label = wrap.querySelector('label'); if (label) label.textContent = nm + ' — add new entry';
    // Title reflects that this role can also change a few typed fields, not just the remark.
    document.getElementById('dcModalTitle').textContent = myOverwriteFields.length
      ? (myEditField === 'fActionItem' ? 'Update FAE fields & remark' : 'Update MP date & remark')
      : ('Add ' + nm);
  }
  window.closeEdit = function () { document.getElementById('dcModal').hidden = true; };

  function collect() {
    return {
      company: val('fCompany'), pm: val('fPm'), opNo: val('fOpNo'), dcDate: val('fDcDate'),
      customerName: val('fCustomerName'), customerCategory: val('fCustomerCategory'),
      vertical: val('fVertical'), region: val('fRegion'), segment: val('fSegment'),
      salesPerson: val('fSalesPerson'), faePerson: val('fFaePerson'), lineFae: val('fLineFae'), project: val('fProject'),
      existingMpn: val('fExistingMpn'), existingMake: val('fExistingMake'),
      suggestedMpn: val('fSuggestedMpn'), suggestedMake: val('fSuggestedMake'),
      projectStatus: val('fProjectStatus'), samplesStage: val('fSamplesStage'), statusMonth: val('fStatusMonth'),
      sampleQty: val('fSampleQty'), eauQty: val('fEauQty'), qps: val('fQps'),
      unitPriceUsd: val('fUnitPriceUsd'), currency: val('fCurrency'), potential: val('fPotential'),
      ppDateFae: val('fPpDateFae'), mpDateSales: val('fMpDateSales'),
      productTeamRemarks: val('fProductTeamRemarks'), currentStatus: val('fCurrentStatus'),
      actionItem: val('fActionItem'), remarks: val('fRemarks'),
    };
  }

  window.saveDc = async function () {
    const id = val('fId');
    // Sales/FAE may only PATCH their single remark column — as an APPENDED dated entry
    // (backend stamps + prepends). We send just the new text.
    if (myEditField) {
      if (!id) { closeEdit(); return; }   // they can't add rows anyway
      const body = {};
      const entry = val(myEditField);
      if (entry) body[myEditField === 'fActionItem' ? 'actionItem' : 'currentStatus'] = entry;
      // Send the typed workflow fields this role may overwrite (as-is; a cleared field clears it).
      myOverwriteFields.forEach(fid => { body[OW_BODY_KEY[fid]] = val(fid); });
      if (!entry && !myOverwriteFields.length) {
        const err = document.getElementById('dcError'); err.style.display = 'block'; err.textContent = 'Type a remark to add.'; return;
      }
      try { await apiRequest(`${API}/${id}`, { method: 'PATCH', body }); closeEdit(); loadList(); }
      catch (e) { const err = document.getElementById('dcError'); err.style.display = 'block'; err.textContent = e.message || 'Save failed'; }
      return;
    }
    const body = collect();
    if (!body.customerName && !body.opNo && !body.suggestedMpn) {
      const err = document.getElementById('dcError'); err.style.display = 'block'; err.textContent = 'Enter at least Customer, OP No, or Suggested MPN.'; return;
    }
    try {
      if (id) {
        // Update the edited line…
        await apiRequest(`${API}/${id}`, { method: 'PATCH', body });
        // …then insert any stacked NEW lines under the SAME OP/header. PM is blanked so each new
        // line's PM auto-derives from its own Suggested Make (brand-driven), not the edited row's.
        const extraEdit = collectExtraLines();
        if (extraEdit.length) {
          const { header } = splitBody(body);
          header.pm = '';
          await apiRequest(`${API}/bulk`, { method: 'POST', body: { header, lines: extraEdit } });
        }
      } else {
        // Multi-line Add: if extra line-blocks were added, POST them all under the shared header
        // in one /bulk call; otherwise the plain single-line POST (unchanged).
        const extra = collectExtraLines();
        if (extra.length) {
          const { header, line } = splitBody(body);
          const hasLineContent = l => LINE_FIELDS.some(f => l[f] != null && String(l[f]).trim() !== '');
          const lines = [line, ...extra].filter(hasLineContent);
          if (lines.length) {
            await apiRequest(`${API}/bulk`, { method: 'POST', body: { header, lines } });
          } else {
            await apiRequest(API, { method: 'POST', body });   // nothing line-specific → one header row
          }
        } else {
          await apiRequest(API, { method: 'POST', body });
        }
      }
      closeEdit(); loadList();
    } catch (e) {
      const err = document.getElementById('dcError'); err.style.display = 'block'; err.textContent = e.message || 'Save failed';
    }
  };

  window.deleteDc = async function () {
    const id = val('fId'); if (!id) return;
    if (!confirm('Delete this DC line?')) return;
    try { await apiRequest(`${API}/${id}`, { method: 'DELETE' }); closeEdit(); loadList(); }
    catch (e) { alert('Delete failed: ' + (e.message || e)); }
  };

  window.bulkDelete = async function () {
    const ids = selectedIds(); if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected line${ids.length === 1 ? '' : 's'}?`)) return;
    let ok = 0, fail = 0;
    for (const id of ids) { try { await apiRequest(`${API}/${id}`, { method: 'DELETE' }); ok++; } catch (_) { fail++; } }
    clearSelection(); loadList();
    setTimeout(() => alert(`Deleted ${ok}${fail ? `, ${fail} failed` : ''}.`), 50);
  };

  // ── import ──
  window.openImport = function () {
    document.getElementById('importError').style.display = 'none';
    document.getElementById('importResult').style.display = 'none';
    document.getElementById('importFile').value = '';
    document.getElementById('importModal').hidden = false;
  };
  window.closeImport = function () { document.getElementById('importModal').hidden = true; };

  function setImportBusy(busy) {
    document.querySelectorAll('#importModal .dc-actions button').forEach(b => b.disabled = busy);
  }
  function importDoneHtml(j) {
    return `<b>✓ Imported.</b> Updated ${j.updated || 0}, inserted ${j.inserted || 0}${j.failed ? `, failed ${j.failed}` : ''}.${j.pmAutoFilled ? ` PM auto-assigned on ${j.pmAutoFilled} row(s).` : ''}`;
  }
  function progressHtml(p, jobId) {
    const pct = p.pct || 0;
    return `<div class="dc-prog"><div class="dc-prog-bar" style="width:${pct}%"></div></div>
      <div class="dc-prog-txt">Importing… <b>${pct}%</b> — ${p.processed || 0} / ${p.total || 0} rows
      (updated ${p.updated || 0}, inserted ${p.inserted || 0}${p.failed ? `, failed ${p.failed}` : ''})
      <button class="btn btn-sm btn-danger" style="margin-left:8px;" onclick="cancelImport('${jobId}')">✕ Cancel</button></div>`;
  }

  window.cancelImport = async function (jobId) {
    try { await apiRequest(`${API}/import/cancel/${encodeURIComponent(jobId)}`, { method: 'POST' }); } catch (_) {}
    const out = document.getElementById('importResult');
    if (out) out.innerHTML = `⏳ Cancelling… finishing the current batch.`;
  };

  async function pollImport(jobId, out) {
    for (let i = 0; i < 2400; i++) {            // ~20 min safety cap (500ms each)
      await new Promise(r => setTimeout(r, 500));
      let p;
      try { p = await apiRequest(`${API}/import/progress/${encodeURIComponent(jobId)}`); }
      catch (e) { out.innerHTML = `Import finished (progress expired). Reloading…`; loadList(); return; }
      if (!p.done) out.innerHTML = progressHtml(p, jobId);
      if (p.done) {
        if (p.error) out.innerHTML = `<span style="color:var(--red,#ef4444);">✗ Import failed: ${esc(p.error)}</span>`;
        else if (p.cancelled) { out.innerHTML = `<b>■ Import cancelled.</b> ${p.inserted || 0} inserted, ${p.updated || 0} updated before stop.`; loadList(); }
        else { out.innerHTML = importDoneHtml(p); loadList(); }
        return;
      }
    }
  }

  window.doImport = async function (dryRun) {
    const file = document.getElementById('importFile').files[0];
    const errEl = document.getElementById('importError'); errEl.style.display = 'none';
    const out = document.getElementById('importResult');
    if (!file) { errEl.style.display = 'block'; errEl.textContent = 'Choose an Excel file first.'; return; }
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token = (typeof getToken === 'function') ? getToken() : '';
    const fd = new FormData(); fd.append('file', file);
    const importCo = document.getElementById('importCompany').value;
    const qs = new URLSearchParams({ dryRun: dryRun ? 'true' : 'false' });
    if (importCo) qs.set('company', importCo);

    setImportBusy(true);
    out.style.display = 'block';
    out.innerHTML = dryRun ? '⏳ Analysing file…' : `⏳ Uploading <b>${esc(file.name)}</b>… please wait`;
    try {
      const res = await fetch(`/api/product/dc/import?${qs.toString()}`, {
        method: 'POST', headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) }, body: fd,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.detail || 'Import failed');
      if (j.dryRun) {
        out.innerHTML = `<b>Preview:</b> ${j.rowsParsed} rows parsed of ${j.rowsScanned} scanned (sheet “${esc(j.sheetName)}”).<br/>` +
          `→ will <b>update ${j.willUpdate || 0}</b> existing line(s), <b>insert ${j.willInsert || 0}</b> new line(s)` +
          `${j.pmAutoFilled ? `; PM auto-assigned on ${j.pmAutoFilled}` : ''}.<br/>Matched by <b>Company + OP No + Customer Name</b>. Click <b>Import</b> to write.`;
      } else if (j.jobId) {
        await pollImport(j.jobId, out);          // live progress bar
      } else {
        out.innerHTML = importDoneHtml(j); loadList();   // fallback (synchronous server)
      }
    } catch (e) {
      errEl.style.display = 'block'; errEl.textContent = e.message || 'Import failed';
      out.style.display = 'none';
    } finally {
      setImportBusy(false);
    }
  };

  // ── export (blob) ──
  async function downloadExport(extraParams) {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token = (typeof getToken === 'function') ? getToken() : '';
    const params = new URLSearchParams(extraParams || {});
    const isIds = !!(extraParams && extraParams.ids);
    const co = document.getElementById('dcCompany').value; if (co) params.set('filterCompany', co);
    // Send the SAME on-screen filters the list uses so the export matches exactly what's
    // shown (date range, salesperson, FAE, PM, status, bucket, search were being dropped —
    // which exported the whole sheet). "Export selected" (ids) stays a pure row-id export.
    if (!isIds) {
      const pmf = document.getElementById('dcPm') ? document.getElementById('dcPm').value : ''; if (pmf) params.set('pm', pmf);
      const sp = document.getElementById('dcSalesPerson') ? document.getElementById('dcSalesPerson').value : ''; if (sp) params.set('salesPerson', sp);
      const fp = document.getElementById('dcFae') ? document.getElementById('dcFae').value : ''; if (fp) params.set('faePerson', fp);
      const rg = document.getElementById('dcRegion') ? document.getElementById('dcRegion').value : ''; if (rg) params.set('region', rg);
      const search = val('dcSearch'); if (search) params.set('search', search);
      const status = val('dcStatus'); if (status) params.set('projectStatus', status);
      if (currentBucket) params.set('bucket', currentBucket);
      const from = val('dcFromDate'); if (from) params.set('fromDate', from);
      const to = val('dcToDate'); if (to) params.set('toDate', to);
    }
    try {
      const res = await fetch(`/api/product/dc/export?${params.toString()}`, { headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'Export failed'); }
      const blob = await res.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `COMPANYA_DCFile_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    } catch (e) { alert('Export failed: ' + (e.message || e)); }
  }
  window.exportExcel = function () { downloadExport({}); };
  window.exportSelectedExcel = function () { const ids = selectedIds(); if (!ids.length) return; downloadExport({ ids: ids.join(',') }); };

  // ── Sales/FAE bulk-remark: export slim "edit remarks" template (respects current filters) ──
  window.exportRemarks = async function () {
    const token = (typeof getToken === 'function') ? getToken() : '';
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const params = new URLSearchParams();
    const co = document.getElementById('dcCompany').value; if (co) params.set('filterCompany', co);
    const search = val('dcSearch'); if (search) params.set('search', search);
    const status = val('dcStatus'); if (status) params.set('projectStatus', status);
    const sp = document.getElementById('dcSalesPerson') ? document.getElementById('dcSalesPerson').value : ''; if (sp) params.set('salesPerson', sp);
    const fp = document.getElementById('dcFae') ? document.getElementById('dcFae').value : ''; if (fp) params.set('faePerson', fp);
    const rg = document.getElementById('dcRegion') ? document.getElementById('dcRegion').value : ''; if (rg) params.set('region', rg);
    const from = val('dcFromDate'); if (from) params.set('fromDate', from);
    const to = val('dcToDate'); if (to) params.set('toDate', to);
    try {
      const res = await fetch(`/api/product/dc/export-remarks?${params.toString()}`, { headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'Export failed'); }
      const blob = await res.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `COMPANYA_DC_EditRemarks_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    } catch (e) { alert('Export failed: ' + (e.message || e)); }
  };
  // Upload the filled template — each non-blank "Add …Remark" is appended to that line.
  window.importRemarks = async function (input) {
    const file = input.files && input.files[0]; if (!file) return;
    input.value = '';
    const token = (typeof getToken === 'function') ? getToken() : '';
    const fd = new FormData(); fd.append('file', file);
    try {
      const res = await fetch('/api/product/dc/import-remarks', { method: 'POST', headers: { ...(token ? { Authorization: token } : {}) }, body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.detail || 'Import failed');
      let msg = `✓ ${j.updated || 0} row(s) updated`;
      if (j.fieldUpdates) msg += ` (incl. ${j.fieldUpdates} field change${j.fieldUpdates > 1 ? 's' : ''})`;
      if (j.skipped)    msg += `\n${j.skipped} row(s) skipped — line not found or nothing changed`;
      if (j.outOfScope) msg += `\n${j.outOfScope} row(s) skipped — not your rows`;
      if (!j.updated && j.message) msg = j.message;
      alert(msg);
      loadList();
    } catch (e) { alert('Import failed: ' + (e.message || e)); }
  };

  // Head/admin: backfill PM + Line FAE from the brand chart for rows with no PM / Line FAE.
  window.resolvePm = async function () {
    if (!confirm('Auto-assign PM & Line FAE from the chart for all rows that currently have no PM / Line FAE?')) return;
    try {
      const co = document.getElementById('dcCompany').value;
      const r = await apiRequest(`${API}/resolve-pm${co ? '?company=' + encodeURIComponent(co) : ''}`, { method: 'POST' });
      alert(`Auto-assigned PM & Line FAE on ${r.updated} row(s).`);
      loadList();
    } catch (e) { alert('Auto-assign failed: ' + (e.message || e)); }
  };

  // Head/admin: OVERWRITE every mapped row's PM AND Line FAE from the brand chart (moves brands
  // to their new owner). A backup is snapshotted first, so it's reversible via "Undo reassign".
  window.reassignPm = async function () {
    if (!confirm('Reassign PM & Line FAE from the chart?\n\nThis OVERWRITES every mapped row\'s PM AND Line FAE with the chart values (moves brands to their new owner). A backup is taken first — you can Undo.\n\nTip: run "⟳ Update PM & Line FAE Chart" with the latest chart first.\n\nContinue?')) return;
    try {
      const co = document.getElementById('dcCompany').value;
      const r = await apiRequest(`${API}/resolve-pm?mode=overwrite${co ? '&company=' + encodeURIComponent(co) : ''}`, { method: 'POST' });
      alert(`Reassigned PM & Line FAE on ${r.updated} row(s). A backup was saved — use "↩ Undo assign" to revert.`);
      const ub = document.getElementById('dcUndoReassignBtn'); if (ub) ub.style.display = '';
      loadList();
    } catch (e) { alert('Reassign failed: ' + (e.message || e)); }
  };
  // Head/admin: restore the PMs from the last overwrite's snapshot.
  window.undoReassign = async function () {
    if (!confirm('Undo the last chart reassignment and restore the previous PM & Line FAE?')) return;
    try {
      const r = await apiRequest(`${API}/resolve-pm?mode=revert`, { method: 'POST' });
      alert(`Reverted ${r.reverted} row(s) to their previous PM.`);
      loadList();
    } catch (e) { alert('Undo failed: ' + (e.message || e)); }
  };

  // Head/admin: refresh the brand→PM map from an updated PM/FAE chart Excel.
  window.uploadChart = async function (inp) {
    const file = inp.files[0]; if (!file) return;
    const token = (typeof getToken === 'function') ? getToken() : '';
    const fd = new FormData(); fd.append('file', file);
    try {
      const res = await fetch('/api/product/dc/chart-import', { method: 'POST', headers: { ...(token ? { Authorization: token } : {}) }, body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.detail || 'Chart update failed');
      const by = (j.byPm || []).map(x => `${x.PM}: ${x.n}`).join('  ·  ');
      alert(`✓ PM & Line FAE chart refreshed — ${j.brands} brands.\n${by}\n\nNew/edited rows auto-fill PM + Line FAE from this map.\n• "⚙ Auto-assign PM & Line FAE" fills only rows with NO PM / Line FAE.\n• "⟲ Reassign PM & Line FAE" OVERWRITES every mapped row from this chart (moves brands to their new owner) — reversible.`);
    } catch (e) { alert('Chart update failed: ' + (e.message || e)); }
    inp.value = '';
  };

  // ── init ──
  function init() {
    // requireAuth() applies the saved day/night theme + injects the theme toggle
    // into .topbar-actions; renderSidebar() builds the left rail (Lens/HRMS + DC File).
    // Without these the page was stuck dark with no sidebar.
    if (typeof requireAuth === 'function') requireAuth();
    if (typeof renderSidebar === 'function') renderSidebar('product-dc');
    initCustomerSuggest();
    const rt = document.getElementById('roleTag'); if (rt && getUser().name) rt.textContent = getUser().name;
    if (canSeeAllPm) {
      const pf = document.getElementById('dcPm'); if (pf) pf.style.display = '';
      const rb = document.getElementById('dcResolveBtn'); if (rb) rb.style.display = '';
      const cb = document.getElementById('dcChartBtn'); if (cb) cb.style.display = '';
      const xb = document.getElementById('dcReassignBtn'); if (xb) xb.style.display = '';
      const ub = document.getElementById('dcUndoReassignBtn'); if (ub) ub.style.display = '';
    }
    // Line 1 Potential auto-calc (EAU × Unit Price). Extra stacked lines wire their own on creation.
    const l1eau = document.getElementById('fEauQty'), l1up = document.getElementById('fUnitPriceUsd'), l1pot = document.getElementById('fPotential');
    const l1rc = () => recalcPotential(l1eau, l1up, l1pot);
    if (l1eau) l1eau.addEventListener('input', l1rc);
    if (l1up) l1up.addEventListener('input', l1rc);
    // Sales / FAE: view + edit their own rows only — hide the Product-owned Add & Import,
    // and show the bulk "Export for editing / Import remarks" pair instead.
    if (!isProductUser) {
      const ib = document.getElementById('dcImportBtn'); if (ib) ib.style.display = 'none';
      const ab = document.getElementById('dcAddBtn');    if (ab) ab.style.display = 'none';
      const eb = document.getElementById('dcExportRemarksBtn'); if (eb) eb.style.display = '';
      const rb = document.getElementById('dcImportRemarksBtn'); if (rb) rb.style.display = '';
    }
    loadList();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
})();
