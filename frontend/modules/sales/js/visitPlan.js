// ── CompanyAVisitPlan.js (frontend) ───────────────────────────────────────────────
(function () {
  'use strict';

  const API = '/sales/visitplan';
  let currentPage   = 1;
  const PAGE_LIMIT  = 15;
  let totalRecords  = 0;
  let currentSearch = '';
  let currentStatus = 'all';
  let currentMonth  = '';
  let currentDate   = '';   // single-day filter; takes priority over month (2026-06-16)
  let currentPerson = '';   // Sales/FAE dropdown filter — a SalespersonCode (admin/HR/heads)
  let editingId     = null;
  let allRows       = [];
  let currentUser   = null;

  // ── ISO week number helper ───────────────────────────────────────────────
  // Returns "Week XX" where XX is the ISO week number (01–53)
  function getISOWeek(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    // ISO week: Thursday determines the week year
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const startOfWeek1 = new Date(jan4);
    startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
    const diff = d - startOfWeek1;
    const weekNo = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1;
    return 'Week ' + String(weekNo).padStart(2, '0');
  }

  // ── init ─────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    currentUser = requireAuth();
    if (!currentUser) return;

    renderSidebar('CompanyAVisitPlan');
    setRoleTag();

    // set default month filter to current month
    const now = new Date();
    const defaultMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    document.getElementById('monthFilter').value = defaultMonth;
    currentMonth = defaultMonth;

    loadDashboard();
    loadList();
    bindEvents();
    initPickers();
  });

  // ── Modal autocomplete: NAV customer (code mapping) + Google Places (geofence location) ──
  let vpCustTimer = null, vpPlaceTimer = null, vpPlacesToken = null;
  function vpUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function vpEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function clearVisitCoords() {
    ['fVisitLat','fVisitLng','fPlaceId','fAddr','fCity','fState','fPincode'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const set = document.getElementById('vpPlaceSet'); if (set) set.hidden = true;
  }

  function initPickers() {
    const nameEl = document.getElementById('fCustomerName');
    const locEl  = document.getElementById('fLocation');
    if (!nameEl || !locEl) return;

    // NAV customer autocomplete → fills name + hidden CustomerCode
    nameEl.addEventListener('input', () => {
      document.getElementById('fCustomerCode').value = '';   // manual typing clears the locked NAV code
      clearTimeout(vpCustTimer);
      const q = nameEl.value.trim();
      const box = document.getElementById('vpCustList');
      if (q.length < 2) { box.hidden = true; return; }
      vpCustTimer = setTimeout(async () => {
        try {
          const r = await apiRequest(`/hr/geofence/customer-suggest?q=${encodeURIComponent(q)}`);
          const list = r.customers || [];
          if (!list.length) {
            box.innerHTML = '<div class="vp-suggest-empty">No NAV match — will be saved as a new (non-NAV) customer</div>';
            box.hidden = false; return;
          }
          box.innerHTML = list.map(c =>
            `<div class="vp-suggest-row" onclick='vpPickCustomer(${JSON.stringify(c).replace(/'/g, "&#39;")})'>
               <div class="vp-suggest-name">${vpEsc(c.CustomerName)}</div>
               <div class="vp-suggest-meta">${vpEsc(c.CustomerCode)}${c.City ? ' · ' + vpEsc(c.City) : ''}${c.Pincode ? ' · ' + vpEsc(c.Pincode) : ''}</div>
             </div>`).join('');
          box.hidden = false;
        } catch (e) { box.hidden = true; }
      }, 250);
    });

    // Google Places autocomplete on Location → fills hidden lat/lng + address
    locEl.addEventListener('input', () => {
      clearVisitCoords();   // editing the text invalidates a previously picked pin
      clearTimeout(vpPlaceTimer);
      const q = locEl.value.trim();
      const box = document.getElementById('vpPlaceList');
      if (q.length < 2) { box.hidden = true; return; }
      vpPlaceTimer = setTimeout(async () => {
        box.innerHTML = '<div class="vp-suggest-empty">Searching Google Places…</div>'; box.hidden = false;
        if (!vpPlacesToken) vpPlacesToken = vpUuid();
        try {
          const r = await apiRequest(`/hr/geofence/places-suggest?q=${encodeURIComponent(q)}&sessionToken=${encodeURIComponent(vpPlacesToken)}`);
          const list = r.predictions || [];
          if (!list.length) { box.innerHTML = '<div class="vp-suggest-empty">No matches — try including the city</div>'; box.hidden = false; return; }
          box.innerHTML = list.map(p => {
            const main = (p.structured_formatting && p.structured_formatting.main_text) || p.description;
            const sec  = (p.structured_formatting && p.structured_formatting.secondary_text) || '';
            return `<div class="vp-suggest-row" onclick="vpPickPlace('${vpEsc(p.place_id)}')">
                      <div class="vp-suggest-name">${vpEsc(main)}</div>
                      <div class="vp-suggest-meta">${vpEsc(sec)}</div>
                    </div>`;
          }).join('');
          box.hidden = false;
        } catch (e) { box.innerHTML = '<div class="vp-suggest-empty">Place search failed</div>'; box.hidden = false; }
      }, 350);
    });

    // click outside → close both dropdowns
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#fCustomerName') && !e.target.closest('#vpCustList')) document.getElementById('vpCustList').hidden = true;
      if (!e.target.closest('#fLocation')     && !e.target.closest('#vpPlaceList')) document.getElementById('vpPlaceList').hidden = true;
    });
  }

  window.vpPickCustomer = function (c) {
    document.getElementById('fCustomerName').value = c.CustomerName || '';
    document.getElementById('fCustomerCode').value = c.CustomerCode || '';
    document.getElementById('vpCustList').hidden = true;
    // prefill the location text from the NAV address if empty — salesperson still picks the exact place
    const loc = document.getElementById('fLocation');
    if (!loc.value && (c.City || c.Address)) loc.value = [c.Address, c.City].filter(Boolean).join(', ');
  };

  window.vpPickPlace = async function (placeId) {
    const box = document.getElementById('vpPlaceList');
    box.innerHTML = '<div class="vp-suggest-empty">Loading place…</div>';
    try {
      const r = await apiRequest(`/hr/geofence/places-detail?placeId=${encodeURIComponent(placeId)}&sessionToken=${encodeURIComponent(vpPlacesToken || '')}`);
      if (!r.ok || r.lat == null) throw new Error(r.message || 'No coordinates');
      document.getElementById('fVisitLat').value = r.lat;
      document.getElementById('fVisitLng').value = r.lng;
      document.getElementById('fPlaceId').value  = placeId;
      document.getElementById('fAddr').value     = r.address || '';
      document.getElementById('fCity').value     = r.city || '';
      document.getElementById('fState').value    = r.state || '';
      document.getElementById('fPincode').value  = r.pincode || '';
      document.getElementById('fLocation').value = r.address || document.getElementById('fLocation').value;
      box.hidden = true;
      document.getElementById('vpPlaceSet').hidden = false;
    } catch (e) {
      box.innerHTML = '<div class="vp-suggest-empty">Could not load place details</div>'; box.hidden = false;
    }
    vpPlacesToken = null;   // session ends after details call
  };

  // ── events ───────────────────────────────────────────────────────────────
  function bindEvents() {
    // search debounce
    let debounce;
    document.getElementById('searchInput').addEventListener('input', e => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        currentSearch = e.target.value.trim();
        currentPage = 1;
        loadList();
      }, 350);
    });

    // status filter tabs
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentStatus = tab.dataset.status;
        currentPage = 1;
        loadList();
      });
    });

    // month filter — clearing this also clears the date filter
    document.getElementById('monthFilter').addEventListener('change', e => {
      currentMonth = e.target.value;
      currentDate  = '';                              // month chosen → drop single-date
      document.getElementById('dateFilter').value = '';
      currentPage = 1;
      loadDashboard();
      loadList();
    });

    // NEW 2026-06-16: single-date filter takes priority over month
    document.getElementById('dateFilter').addEventListener('change', e => {
      currentDate = e.target.value;
      currentPage = 1;
      loadList();   // dashboard stays month-scoped; only the list zooms in
    });

    // NEW 2026-06-16: Clear Filter button — resets month to current, date empty,
    // search empty, status All
    document.getElementById('clearFiltersBtn').addEventListener('click', () => {
      const now = new Date();
      const defaultMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      currentMonth = defaultMonth;
      currentDate  = '';
      currentSearch = '';
      currentStatus = 'all';
      currentPerson = '';
      document.getElementById('monthFilter').value = defaultMonth;
      document.getElementById('dateFilter').value  = '';
      const spf = document.getElementById('salesPersonFilter'); if (spf) spf.value = '';
      const faf = document.getElementById('faePersonFilter');   if (faf) faf.value = '';
      const si = document.getElementById('searchInput');
      if (si) si.value = '';
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.status === 'all'));
      currentPage = 1;
      loadDashboard();
      loadList();
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
      loadDashboard();
      loadList();
    });

    document.getElementById('newVisitBtn').addEventListener('click', () => openModal(null));
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
    document.getElementById('modalSaveBtn').addEventListener('click', saveRecord);
    document.getElementById('momClose').addEventListener('click', () => {
      document.getElementById('momOverlay').style.display = 'none';
    });
    document.getElementById('exportBtn').addEventListener('click', exportExcel);
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFileInput').click());
    document.getElementById('importFileInput').addEventListener('change', importExcel);

    // Sales / FAE person filters (admin/HR/heads). Only one active at a time.
    document.getElementById('salesPersonFilter').addEventListener('change', function () {
      currentPerson = this.value;
      const f = document.getElementById('faePersonFilter'); if (f) f.value = '';
      currentPage = 1; loadList();
    });
    document.getElementById('faePersonFilter').addEventListener('change', function () {
      currentPerson = this.value;
      const s = document.getElementById('salesPersonFilter'); if (s) s.value = '';
      currentPage = 1; loadList();
    });

    // HR is VIEW-ONLY — hide create + import (backend also blocks the writes).
    const _rl = (currentUser && currentUser.role || '').toLowerCase();
    if (_rl === 'hr' || _rl === 'hr head') {
      const nb = document.getElementById('newVisitBtn'); if (nb) nb.style.display = 'none';
      const ib = document.getElementById('importBtn');   if (ib) ib.style.display = 'none';
    }

    // close modal on backdrop click
    document.getElementById('modalOverlay').addEventListener('click', e => {
      if (e.target === document.getElementById('modalOverlay')) closeModal();
    });
    document.getElementById('momOverlay').addEventListener('click', e => {
      if (e.target === document.getElementById('momOverlay'))
        document.getElementById('momOverlay').style.display = 'none';
    });

    // ── Auto-fill ISO week when visit date changes ──────────────────────
    document.getElementById('fVisitDate').addEventListener('change', e => {
      const weekVal = getISOWeek(e.target.value);
      document.getElementById('fWeek').value = weekVal;
    });
  }

  // ── dashboard ────────────────────────────────────────────────────────────
  async function loadDashboard() {
    try {
      const params = currentMonth ? '?month=' + currentMonth : '';
      const data = await apiRequest(API + '/dashboard' + params);
      renderDashCards(data.month || {});
      renderChart(data.chart    || []);
      renderSpBreak(data.bySp   || []);
    } catch (err) {
      console.error('Dashboard load error:', err.message);
    }
  }

  function renderDashCards(m) {
    const planned = m.TotalPlanned || 0;
    const done    = m.VisitDone    || 0;
    const pending = m.Pending      || 0;
    const pct     = planned > 0 ? Math.round((done / planned) * 100) : 0;

    // Label shows selected month or "This Month"
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let monthLabel = 'This Month';
    if (currentMonth && currentMonth.includes('-')) {
      const [yr, mo] = currentMonth.split('-').map(Number);
      monthLabel = MONTHS[mo - 1] + ' ' + yr;
    }

    document.getElementById('dashCards').innerHTML = `
      <div class="card">
        <div class="card-title">${monthLabel} — Planned</div>
        <div class="card-value">${planned}</div>
        <div class="card-sub">Total visits planned</div>
      </div>
      <div class="card">
        <div class="card-title">Visits Done</div>
        <div class="card-value" style="color:var(--green);">${done}</div>
        <div class="card-sub">${pct}% completion</div>
      </div>
      <div class="card">
        <div class="card-title">Pending Visits</div>
        <div class="card-value" style="color:var(--amber);">${pending}</div>
        <div class="card-sub">Yet to be visited</div>
      </div>
      <div class="card">
        <div class="card-title">Completion Rate</div>
        <div class="card-value" style="color:var(--accent);">${pct}%</div>
        <div class="card-sub">
          <div class="mini-bar-track">
            <div class="mini-bar-fill" style="width:${pct}%;background:var(--accent);"></div>
          </div>
        </div>
      </div>
    `;
  }

  function renderChart(rows) {
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const wrap   = document.getElementById('chartWrap');
    if (!rows.length) {
      wrap.innerHTML = '<p style="color:var(--text3);padding:20px 0;">No data for chart</p>';
      return;
    }

    const barW = 22, gap = 8, groupW = barW * 3 + gap * 2 + 28;
    const maxVal = Math.max(...rows.map(r => r.TotalPlanned), 1);
    const chartH = 130;
    const svgW   = Math.max(rows.length * groupW + 60, 400);

    let bars = '';
    rows.forEach((r, i) => {
      const x  = 44 + i * groupW;
      const hP = Math.round((r.TotalPlanned / maxVal) * chartH);
      const hD = Math.round((r.VisitDone    / maxVal) * chartH);
      const hN = Math.round((r.Pending      / maxVal) * chartH);
      const yBase = chartH + 20;
      const lbl = MONTHS[r.Mo - 1] + " '" + String(r.Yr).slice(2);

      bars += `
        <rect x="${x}"                   y="${yBase - hP}" width="${barW}" height="${hP || 2}" fill="#4f8ef740" rx="3"/>
        <rect x="${x + barW + gap}"      y="${yBase - hD}" width="${barW}" height="${hD || 2}" fill="#34c77b"   rx="3"/>
        <rect x="${x + barW*2 + gap*2}"  y="${yBase - hN}" width="${barW}" height="${hN || 2}" fill="#f0a22e"   rx="3"/>
        <text x="${x + barW * 1.5 + gap}" y="${yBase + 16}" text-anchor="middle"
              fill="#555d78" font-size="10" font-family="DM Mono,monospace">${lbl}</text>
        ${r.TotalPlanned ? `<text x="${x + barW/2}"               y="${yBase - hP - 4}" text-anchor="middle" fill="#8b91a8"  font-size="10">${r.TotalPlanned}</text>` : ''}
        ${r.VisitDone    ? `<text x="${x + barW + gap + barW/2}"   y="${yBase - hD - 4}" text-anchor="middle" fill="#34c77b"  font-size="10">${r.VisitDone}</text>` : ''}
        ${r.Pending      ? `<text x="${x + barW*2 + gap*2 + barW/2}" y="${yBase - hN - 4}" text-anchor="middle" fill="#f0a22e" font-size="10">${r.Pending}</text>` : ''}
      `;
    });

    wrap.innerHTML = `
      <div style="display:flex;gap:20px;margin-bottom:10px;font-size:12px;font-family:'DM Mono',monospace;">
        <span style="color:#4f8ef7;">■ Planned</span>
        <span style="color:#34c77b;">■ Done</span>
        <span style="color:#f0a22e;">■ Pending</span>
      </div>
      <div style="overflow-x:auto;">
        <svg width="${svgW}" height="${chartH + 42}" style="display:block;">
          <line x1="38" y1="18" x2="38" y2="${chartH + 20}" stroke="#2a2f40" stroke-width="1"/>
          <line x1="38" y1="${chartH + 20}" x2="${svgW - 8}" y2="${chartH + 20}" stroke="#2a2f40" stroke-width="1"/>
          ${bars}
        </svg>
      </div>
    `;
  }

  function renderSpBreak(rows) {
    const card = document.getElementById('spBreakCard');
    if (!rows.length) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    document.getElementById('spBreakBody').innerHTML = rows.map(r => `
      <tr>
        <td class="td-mono">${r.SalespersonCode || '—'}</td>
        <td class="td-bold">${r.SalespersonName || '—'}</td>
        <td style="text-align:right;">${r.TotalPlanned}</td>
        <td style="text-align:right;color:var(--green);">${r.VisitDone}</td>
        <td style="text-align:right;color:var(--amber);">${r.Pending}</td>
      </tr>
    `).join('');
  }

  // ── list ─────────────────────────────────────────────────────────────────
  // ── Sales / FAE person dropdowns (admin/HR/heads) — populated from the list facet ──
  function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fillPersonSel(id, allLabel, items) {
    const sel = document.getElementById(id); if (!sel) return;
    items = items || [];
    if (!items.length) { sel.style.display = 'none'; return; }
    const cur = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      items.map(p => `<option value="${escAttr(p.code)}">${escAttr(p.name || p.code)}</option>`).join('');
    if (cur && items.some(p => String(p.code) === cur)) sel.value = cur;
    sel.style.display = '';
  }
  function populatePersonDropdowns(sales, fae) {
    fillPersonSel('salesPersonFilter', 'All Salespersons', sales);
    fillPersonSel('faePersonFilter', 'All FAE', fae);
  }

  async function loadList() {
    showLoading(true);
    try {
      const params = new URLSearchParams({
        search: currentSearch,
        status: currentStatus,
        month:  currentMonth,
        page:   currentPage,
        limit:  PAGE_LIMIT
      });
      if (currentDate) params.set('date', currentDate);  // single-date takes priority over month
      if (currentPerson) params.set('salespersonCode', currentPerson);
      const data   = await apiRequest(API + '?' + params.toString());
      totalRecords = data.total || 0;
      allRows      = data.data  || [];
      populatePersonDropdowns(data.salesPeople, data.faePeople);
      renderTable(allRows);
      renderPagination();
    } catch (err) {
      console.error('List error:', err.message);
      showLoading(false);
    }
  }

  function renderTable(rows) {
    const tbody   = document.getElementById('visitBody');
    const table   = document.getElementById('visitTable');
    const empty   = document.getElementById('visitEmpty');
    // Everyone with access to the Visit Plan page can hit Edit/Delete on the rows
    // they can see. The list is already scoped by visitScopeAnd() server-side
    // (salesperson → own, head → team, admin → all), so the rows on screen are
    // implicitly within edit scope. The backend PUT/DELETE still enforces the
    // own-code ownership check for `role === 'sales'` as a defence in depth.
    const role    = (currentUser?.role || '').toLowerCase();
    const canEdit = role !== 'hr' && role !== 'hr head';   // HR is view-only
    // Punch-In button shown only for roles that physically visit customers
    // (sales / heads / FAE). HR + admin oversee — they don't punch.
    const canPunch = role === 'sales' || /\bhead\b/.test(role) || role === 'fae' || role === 'fae head';

    showLoading(false);

    if (!rows.length) {
      table.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    table.style.display = 'table';

    tbody.innerHTML = rows.map(r => {
      const badge   = r.VisitDone
        ? `<span class="badge badge-green">Yes</span>`
        : `<span class="badge badge-amber">No</span>`;
      const momBtn  = r.MOM
        ? `<button class="btn-link" onclick="showMOM(${r.Id})">View</button>`
        : `<span style="color:var(--text3)">—</span>`;
      // Punch-In quick action — pre-fills the Visit Punch page with this
      // plan row's customer + plan id, so the rep can take photos and tap
      // PUNCH IN in 2 steps instead of re-picking the customer. Hidden once
      // the visit is done (VisitDone=1).
      const punchBtn = (canPunch && !r.VisitDone)
        ? `<a class="btn-icon vp-punch-link" title="Punch In at customer" href="/modules/hr/visit-punch?planId=${r.Id}&customer=${encodeURIComponent(r.CustomerName || '')}&code=${encodeURIComponent(r.CustomerCode || '')}">▶</a>`
        : '';
      const actions = canEdit
        ? `${punchBtn}<button class="btn-icon" title="Edit"   onclick="editRecord(${r.Id})">✎</button>
           <button class="btn-icon btn-icon-red" title="Delete" onclick="deleteRecord(${r.Id})">✕</button>`
        : '—';
      return `<tr>
        <td class="td-mono">${r.Week || '—'}</td>
        <td>${r.FSR || '—'}</td>
        <td>${r.FAE || '—'}</td>
        <td class="td-mono">${fmtDate(r.VisitDate)}</td>
        <td class="td-bold">${r.CustomerName || '—'}${r.Source === 'beat' ? ' <span class="badge badge-purple" title="Auto-generated from the Electrical Beat Plan">Beat</span>' : ''}</td>
        <td>${r.Application || '—'}</td>
        <td>${r.CustomerType || '—'}</td>
        <td class="td-agenda" title="${(r.VisitAgenda || '').replace(/"/g,'&quot;')}">${r.VisitAgenda || '—'}</td>
        <td>${r.Location || '—'}</td>
        <td>${r.ContactPerson || '—'}</td>
        <td>${r.ContactDetails || '—'}</td>
        <td>${badge}</td>
        <td>${momBtn}</td>
        <td class="td-actions">${actions}</td>
      </tr>`;
    }).join('');
  }

  // ── modal ────────────────────────────────────────────────────────────────
  function openModal(record) {
    editingId = record ? record.Id : null;
    document.getElementById('modalTitle').textContent = record ? 'Edit Visit Plan' : 'New Visit Plan';

    const visitDateVal = record?.VisitDate ? record.VisitDate.split('T')[0] : '';

    document.getElementById('fWeek').value          = record?.Week          || (visitDateVal ? getISOWeek(visitDateVal) : '');
    document.getElementById('fVisitDate').value     = visitDateVal;
    document.getElementById('fFSR').value           = record?.FSR           || '';
    document.getElementById('fFAE').value           = record?.FAE           || '';

    // Auto-fill the logged-in user's name into the matching role's field on NEW
    // visit plans only. FAE / FAE Head → FAE field; everyone else (sales, FSR,
    // heads) → FSR field. The other field stays empty for manual entry. Edits
    // keep whatever was already saved.
    if (!record && currentUser) {
      const role = (currentUser.role || '').toLowerCase().trim();
      const name = currentUser.name || currentUser.username || '';
      if (role === 'fae' || role === 'fae head') {
        document.getElementById('fFAE').value = name;
      } else {
        document.getElementById('fFSR').value = name;
      }
    }

    // Show the mandatory-name asterisk on the field the current role must fill:
    // FAE flow → FAE required, everyone else → FSR required (matches the backend).
    const _r = (currentUser?.role || '').toLowerCase().trim();
    const _isFae = (_r === 'fae' || _r === 'fae head');
    const fsrReq = document.getElementById('fsrReq');
    const faeReq = document.getElementById('faeReq');
    if (fsrReq) fsrReq.style.display = _isFae ? 'none' : '';
    if (faeReq) faeReq.style.display = _isFae ? ''     : 'none';
    document.getElementById('fCustomerName').value  = record?.CustomerName  || '';
    document.getElementById('fApplication').value   = record?.Application   || '';
    document.getElementById('fCustomerType').value  = record?.CustomerType  || '';
    document.getElementById('fVisitAgenda').value   = record?.VisitAgenda   || '';
    document.getElementById('fLocation').value      = record?.Location      || '';
    document.getElementById('fContactPerson').value = record?.ContactPerson || '';
    document.getElementById('fContactDetails').value= record?.ContactDetails|| '';
    document.getElementById('fVisitDone').checked   = !!record?.VisitDone;
    document.getElementById('fMOM').value           = record?.MOM           || '';

    // geofence/location hidden fields + dropdown state
    document.getElementById('fCustomerCode').value = record?.CustomerCode || '';
    document.getElementById('fVisitLat').value     = record?.VisitLat     || '';
    document.getElementById('fVisitLng').value     = record?.VisitLng     || '';
    document.getElementById('fPlaceId').value      = record?.PlaceId      || '';
    ['fAddr','fCity','fState','fPincode'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('vpCustList').hidden  = true;
    document.getElementById('vpPlaceList').hidden = true;
    document.getElementById('vpPlaceSet').hidden  = !record?.VisitLat;

    document.getElementById('modalOverlay').style.display = 'flex';
    // focus first field
    setTimeout(() => document.getElementById('fVisitDate').focus(), 100);
  }

  function closeModal() {
    document.getElementById('modalOverlay').style.display = 'none';
    editingId = null;
  }

  async function saveRecord() {
    const customerName   = document.getElementById('fCustomerName').value.trim();
    const visitDate      = document.getElementById('fVisitDate').value;
    const contactPerson  = document.getElementById('fContactPerson').value.trim();
    const contactDetails = document.getElementById('fContactDetails').value.trim();
    const visitAgenda    = document.getElementById('fVisitAgenda').value.trim();
    const fsr            = document.getElementById('fFSR').value.trim();
    const fae            = document.getElementById('fFAE').value.trim();
    const _r             = (currentUser?.role || '').toLowerCase().trim();
    const isFae          = (_r === 'fae' || _r === 'fae head');

    if (!customerName) { alert('Customer Name is required.'); return; }
    if (!visitDate)    { alert('Visit Date is required.');    return; }
    // Mandatory — Contact Person only (Contact Details is optional as of 2026-07-03).
    if (!contactPerson) {
      alert('Contact Person is required.\n\nEvery planned visit must record who the salesperson is meeting — the head will use this to verify the visit was real.');
      document.getElementById('fContactPerson').focus();
      return;
    }
    // Mandatory — Visit Agenda (2026-07-06).
    if (!visitAgenda) {
      alert('Visit Agenda is required.\n\nDescribe the purpose of the visit.');
      document.getElementById('fVisitAgenda').focus();
      return;
    }
    // Mandatory — role-based name: FAE flow needs FAE, everyone else needs FSR (2026-07-06).
    if (isFae && !fae) {
      alert('FAE name is required.');
      document.getElementById('fFAE').focus();
      return;
    }
    if (!isFae && !fsr) {
      alert('FSR name is required.');
      document.getElementById('fFSR').focus();
      return;
    }

    const body = {
      week:           document.getElementById('fWeek').value.trim(),
      visitDate,
      fsr:            document.getElementById('fFSR').value.trim(),
      fae:            document.getElementById('fFAE').value.trim(),
      customerName,
      application:    document.getElementById('fApplication').value.trim(),
      customerType:   document.getElementById('fCustomerType').value,
      visitAgenda:    document.getElementById('fVisitAgenda').value.trim(),
      location:       document.getElementById('fLocation').value.trim(),
      contactPerson:  document.getElementById('fContactPerson').value.trim(),
      contactDetails: document.getElementById('fContactDetails').value.trim(),
      visitDone:      document.getElementById('fVisitDone').checked,
      mom:            document.getElementById('fMOM').value.trim(),
      // NAV mapping + Places-picked location → backend auto-creates/reuses the geofence
      customerCode:   document.getElementById('fCustomerCode').value.trim(),
      visitLat:       document.getElementById('fVisitLat').value,
      visitLng:       document.getElementById('fVisitLng').value,
      placeId:        document.getElementById('fPlaceId').value,
      address:        document.getElementById('fAddr').value,
      city:           document.getElementById('fCity').value,
      state:          document.getElementById('fState').value,
      pincode:        document.getElementById('fPincode').value
    };

    const saveBtn = document.getElementById('modalSaveBtn');
    saveBtn.textContent = 'Saving…';
    saveBtn.disabled    = true;

    try {
      if (editingId) {
        await apiRequest(API + '/' + editingId, { method: 'PUT', body });
      } else {
        await apiRequest(API, { method: 'POST', body });
      }
      closeModal();
      loadDashboard();
      loadList();
    } catch (err) {
      // Show duplicate error differently from generic errors
      if (err.message && err.message.toLowerCase().includes('duplicate')) {
        alert('⚠ Duplicate Entry\n\n' + err.message + '\n\nSame customer on same date already exists for this salesperson.');
      } else {
        alert('Save failed: ' + err.message);
      }
    } finally {
      saveBtn.textContent = 'Save';
      saveBtn.disabled    = false;
    }
  }

  // ── global handlers (for inline onclick) ─────────────────────────────────
  window.editRecord = async (id) => {
    try {
      const record = await apiRequest(API + '/' + id);
      openModal(record);
    } catch (err) { alert('Could not load record: ' + err.message); }
  };

  window.deleteRecord = async (id) => {
    if (!confirm('Delete this visit plan record? This cannot be undone.')) return;
    try {
      await apiRequest(API + '/' + id, { method: 'DELETE' });
      loadDashboard();
      loadList();
    } catch (err) { alert('Delete failed: ' + err.message); }
  };

  window.showMOM = (id) => {
    const row = allRows.find(r => r.Id === id);
    if (!row) return;
    document.getElementById('momText').textContent = row.MOM || '—';
    document.getElementById('momOverlay').style.display = 'flex';
  };

  window.goPage = (p) => { currentPage = p; loadList(); };

  // ── pagination ───────────────────────────────────────────────────────────
  function renderPagination() {
    const totalPages = Math.ceil(totalRecords / PAGE_LIMIT);
    const pag        = document.getElementById('pagination');
    if (totalPages <= 1) { pag.innerHTML = `<span class="page-info">${totalRecords} record(s)</span>`; return; }

    let html = `<span class="page-info">${totalRecords} records</span>`;
    if (currentPage > 1)
      html += `<button class="page-btn" onclick="goPage(${currentPage - 1})">‹</button>`;

    const start = Math.max(1, currentPage - 2);
    const end   = Math.min(totalPages, currentPage + 2);
    for (let p = start; p <= end; p++) {
      html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="goPage(${p})">${p}</button>`;
    }
    if (currentPage < totalPages)
      html += `<button class="page-btn" onclick="goPage(${currentPage + 1})">›</button>`;

    pag.innerHTML = html;
  }

  // ── Excel import ─────────────────────────────────────────────────────────
  async function importExcel(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.match(/\.xlsx?$/i)) { alert('Please select an Excel file (.xlsx)'); return; }

    const importBtn = document.getElementById('importBtn');
    importBtn.textContent = 'Importing…';
    importBtn.disabled = true;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const token = getToken();
      const res = await fetch('/api/sales/visitplan/import', {
        method: 'POST',
        headers: { ...(token ? { Authorization: token } : {}) },
        body: formData
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.message || 'Import failed');

      // Separate duplicates from real errors
      const duplicates = (data.errors || []).filter(e => e.error.toLowerCase().includes('duplicate'));
      const realErrors = (data.errors || []).filter(e => !e.error.toLowerCase().includes('duplicate'));

      let msg = data.message;
      if (duplicates.length) {
        msg += '\n\n⚠ Duplicates skipped (' + duplicates.length + '):\n' +
          duplicates.map(e => '  Row ' + e.row + ': ' + e.error.replace('Duplicate: ', '')).join('\n');
      }
      if (realErrors.length) {
        msg += '\n\n❌ Errors (' + realErrors.length + '):\n' +
          realErrors.map(e => '  Row ' + e.row + ': ' + e.error).join('\n');
      }
      alert(msg);
      loadDashboard();
      loadList();
    } catch (err) {
      alert('Import failed: ' + err.message);
    } finally {
      importBtn.textContent = 'Import Excel';
      importBtn.disabled = false;
      e.target.value = ''; // reset file input
    }
  }

  // ── Excel export — FETCH ALL ROWS for the current filter (not current page) ─
  // Previously this dumped `allRows` which only held the current paginated 15-row
  // chunk. For a month with 1552 visits the user got only 15 in Excel. Now we
  // fire a separate request with limit=10000 to get the full filtered dataset.
  async function exportExcel() {
    const btn = document.getElementById('exportBtn');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    try {
      // Build query mirroring loadList(), but limit=10000 to grab everything
      const params = new URLSearchParams({
        search: currentSearch,
        status: currentStatus,
        month:  currentMonth,
        page:   1,
        limit:  10000,
      });
      if (currentDate) params.set('date', currentDate);
      if (currentPerson) params.set('salespersonCode', currentPerson);
      const data = await apiRequest(API + '?' + params.toString());
      const fullRows = data.data || [];
      if (!fullRows.length) { alert('No data to export.'); return; }

      const rows = fullRows.map(r => ({
        'Week':            r.Week           || '',
        'FSR':             r.FSR            || '',
        'FAE':             r.FAE            || '',
        'Visit Date':      r.VisitDate      || '',
        'Customer Name':   r.CustomerName   || '',
        'Application':     r.Application    || '',
        'Customer Type':   r.CustomerType   || '',
        'Visit Agenda':    r.VisitAgenda    || '',
        'Location':        r.Location       || '',
        'Contact Person':  r.ContactPerson  || '',
        'Contact Details': r.ContactDetails || '',
        'Visit Y/N':       r.VisitDone ? 'Yes' : 'No',
        'Remark':          r.MOM            || ''
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Visit Plan');
      const filename = 'VisitPlan_' + (currentMonth || 'All') + '_' + rows.length + 'rows.xlsx';
      const wbBin = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const blob  = new Blob([wbBin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      nativeSaveAndShare(blob, filename, { dialogTitle: 'Share Visit Plan' });
    } catch (err) {
      console.error('Export failed', err);
      alert('Export failed: ' + (err.message || err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  function showLoading(show) {
    document.getElementById('listLoading').style.display = show ? 'flex'  : 'none';
    if (show) {
      document.getElementById('visitTable').style.display = 'none';
      document.getElementById('visitEmpty').style.display = 'none';
    }
  }

})();