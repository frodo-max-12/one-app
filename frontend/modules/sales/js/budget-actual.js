/* budget-actual.js — Sales Budget vs Actual (v1.11, Phase 1: Booking + Billing) */
(function () {
  const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  const $ = (id) => document.getElementById(id);
  const show = (id) => { const e = $(id); if (e) e.style.display = ''; };
  const hide = (id) => { const e = $(id); if (e) e.style.display = 'none'; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let lastData = null;      // cached GET / response, so re-sort/search doesn't refetch
  let lastMonthly = null;   // cached GET /monthly response
  let dashCharts = [];      // live Chart.js instances (destroyed before each re-render)
  // Salesperson selector = the top "Salesperson" dropdown (id=baSearch). '' = all. ONE control that
  // drives BOTH the summary-table filter AND the dashboard focus (no separate dropdown). Value = NAME
  // (works for the /monthly rows too, which key on name not code).
  const selectedSp = () => (($('baSearch') && $('baSearch').value) || '').trim();
  const matchesSearch = (r) => { const n = selectedSp(); return !n || (r && r.name) === n; };
  function fillSpSelect(userRows) {
    const sel = $('baSearch'); if (!sel || sel.tagName !== 'SELECT') return;
    const cur = sel.value;
    const names = (userRows || []).map(r => r.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
    sel.innerHTML = ['<option value="">All salespeople</option>']
      .concat(names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`)).join('');
    if (cur && names.includes(cur)) sel.value = cur;
  }
  // Money shown in ₹ Lakh (COMPANYA) / $ '000 (CompanyB) — like the MIS report. Visit stays a raw count.
  const dispFactor = () => getCompany() === 'COMPANYB' ? 1000 : 100000;
  const dispUnit   = () => getCompany() === 'COMPANYB' ? "$ '000" : '₹ Lakh';
  const fmtMoney   = (raw) => (Number(raw || 0) / dispFactor()).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  // Entry unit: budgets are TYPED in ₹ Lakh (COMPANYA) / $ '000 (CompanyB) — like the MIS sheet —
  // and stored RAW (× factor) so they compare against raw NAV actuals. Same factor as the display.
  function unit() {
    return getCompany() === 'COMPANYB' ? { factor: 1000, label: "$ '000" } : { factor: 100000, label: '₹ Lakh' };
  }
  function currentFiscal() {
    const t = new Date(), cm = t.getMonth() + 1;
    return { fy: cm >= 4 ? t.getFullYear() : t.getFullYear() - 1, fmi: cm >= 4 ? cm - 3 : cm + 9 };
  }

  function initControls() {
    const cf = currentFiscal();
    const fySel = $('baFy');
    for (let y = cf.fy; y >= cf.fy - 3; y--) {
      const o = document.createElement('option');
      o.value = y; o.textContent = `FY ${y}-${String(y + 1).slice(2)}`;
      fySel.appendChild(o);
    }
    fySel.value = cf.fy;
    const mSel = $('baMonth');
    MONTHS.forEach((m, i) => { const o = document.createElement('option'); o.value = i + 1; o.textContent = m; mSel.appendChild(o); });
    mSel.value = cf.fmi;
    $('baPeriod').value = 'month';
    if ($('baWeekDate')) $('baWeekDate').value = new Date().toISOString().slice(0, 10);
    syncPeriodUi();
  }

  function syncPeriodUi() {
    const p = $('baPeriod').value;
    $('baWeekWrap').style.display  = (p === 'week') ? '' : 'none';
    $('baMonthWrap').style.display = (p === 'week' || p === 'fy') ? 'none' : '';
    $('baMonthLabel').textContent = (p === 'quarter') ? 'Month (picks quarter)' : 'Month';
  }

  function pctCell(p, g) {
    if (p === null || p === undefined) return `<td class="num pct ${g}">—</td>`;
    return `<td class="num pct ${g} ${p >= 100 ? 'good' : 'bad'}">${p.toFixed(0)}%</td>`;
  }

  async function load() {
    const view = $('baView') ? $('baView').value : 'summary';
    if (view === 'monthly') return loadMonthly();
    show('baLoading'); hide('baTableWrap'); hide('baMonthlyWrap'); hide('baDashboardWrap'); hide('baEmpty'); hide('baError');
    try {
      const q = new URLSearchParams({ fiscalYear: $('baFy').value, period: $('baPeriod').value, month: $('baMonth').value, weekDate: $('baWeekDate').value || '' });
      const data = await apiRequest(`/sales/budget?${q.toString()}`);
      $('baSetBtn').style.display = data.canEdit ? '' : 'none';
      $('baImportBtn').style.display = data.canEdit ? '' : 'none';
      $('baBookingBtn').style.display = data.canEdit ? '' : 'none';
      $('baPeriodText').textContent = `${data.range.label} · money in ${dispUnit()}`;
      lastData = data;
      fillSpSelect((data.rows || []).filter(r => r.isUser));   // dropdown lists current ONE App users
      hide('baLoading');
      if (!data.rows.length) { show('baEmpty'); return; }
      if (view === 'dashboard') { renderDashboard(data); show('baDashboardWrap'); }
      else { renderTable(data); show('baTableWrap'); }
    } catch (e) {
      hide('baLoading'); $('baErrorText').textContent = e.message || 'Failed to load.'; show('baError');
    }
  }

  function renderTable(data) {
    const sort = $('baSort') ? $('baSort').value : 'overall';
    const ov = (r) => (r.overall == null ? -1 : r.overall);
    // Leaderboard rank = position by Overall desc over the FULL set (rank is stable when searching).
    const rankOf = {};
    data.rows.slice().sort((a, b) => ov(b) - ov(a)).forEach((r, i) => { rankOf[r.code] = i + 1; });
    const rows = data.rows.filter(r => matchesSearch(r));
    if (sort === 'overall') rows.sort((a, b) => ov(b) - ov(a));
    else rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const n = rows.length;
    $('baBody').innerHTML = rows.map(r => {
      const rk = rankOf[r.code];
      const cls = (r.overall != null && rk === 1) ? 'ba-top'
        : (r.overall != null && n > 1 && rk === n) ? 'ba-bottom' : '';
      return `<tr class="${cls}">
        <td class="num">${rk || ''}</td>
        <td>${esc(r.name)}</td>
        <td class="num ba-group-booking">${fmtMoney(r.bookingBudget)}</td>
        <td class="num ba-group-booking ba-drill" data-metric="booking" data-code="${esc(r.code)}" data-name="${esc(r.name)}">${fmtMoney(r.bookingActual)}</td>
        ${pctCell(r.bookingPct, 'ba-group-booking')}
        <td class="num ba-group-billing">${fmtMoney(r.billingBudget)}</td>
        <td class="num ba-group-billing ba-drill" data-metric="billing" data-code="${esc(r.code)}" data-name="${esc(r.name)}">${fmtMoney(r.billingActual)}</td>
        ${pctCell(r.billingPct, 'ba-group-billing')}
        <td class="num ba-group-ar ba-drill" data-metric="ar-collectible" data-code="${esc(r.code)}" data-name="${esc(r.name)}" title="Collected ${fmtMoney(r.arActual)} + still-owed ${fmtMoney(r.arClosing)} = Collectible — click for the still-owed invoices">${fmtMoney(r.arBudget)}</td>
        <td class="num ba-group-ar ba-drill" data-metric="ar" data-code="${esc(r.code)}" data-name="${esc(r.name)}" title="Collected this period — click for the invoices">${fmtMoney(r.arActual)}</td>
        ${pctCell(r.arPct, 'ba-group-ar')}
        <td class="num ba-group-ar${(r.arOverduePct != null && Number(r.arOverdue) > 0) ? ' ba-drill' : ''}" data-metric="ar-overdue" data-code="${esc(r.code)}" data-name="${esc(r.name)}" title="overdue ${fmtMoney(r.arOverdue)} ÷ open-invoice AR ${fmtMoney(r.arOpenInv)} — click for the overdue invoices">${r.arOverduePct == null ? '—' : r.arOverduePct + '%'}</td>
        <td class="num ba-group-inv" title="Ex-Stock (open Ex-Stock SO value) + Billed = total ex-stock exposure">${fmtMoney(r.inventoryBudget)}</td>
        <td class="num ba-group-inv ba-drill" data-metric="inventory" data-code="${esc(r.code)}" data-name="${esc(r.name)}" title="Billing value">${fmtMoney(r.inventoryActual)}</td>
        ${pctCell(r.inventoryPct, 'ba-group-inv')}
        <td class="num ba-group-visit">${r.visitTarget ? Math.round(r.visitTarget) : '—'}</td>
        <td class="num ba-group-visit">${r.visitPlanned || 0}</td>
        <td class="num ba-group-visit ba-drill" data-metric="visit" data-code="${esc(r.code)}" data-name="${esc(r.name)}">${r.visitDone || 0}</td>
        ${pctCell(r.visitPct, 'ba-group-visit')}
        ${pctCell(r.overall, 'ba-overall')}
      </tr>`;
    }).join('');
    const t = computeTotals(rows);   // totals reflect the VISIBLE (searched) rows
    $('baFoot').innerHTML = `
      <tr class="ba-total-row">
        <td></td><td>Total (${n})</td>
        <td class="num">${fmtMoney(t.bookingBudget)}</td><td class="num">${fmtMoney(t.bookingActual)}</td>${pctCell(t.bookingPct, '')}
        <td class="num">${fmtMoney(t.billingBudget)}</td><td class="num">${fmtMoney(t.billingActual)}</td>${pctCell(t.billingPct, '')}
        <td class="num">${fmtMoney(t.arBudget)}</td><td class="num">${fmtMoney(t.arActual)}</td>${pctCell(t.arPct, '')}<td class="num">${t.arOverduePct == null ? '—' : t.arOverduePct + '%'}</td>
        <td class="num">${fmtMoney(t.inventoryBudget)}</td><td class="num">${fmtMoney(t.inventoryActual)}</td>${pctCell(t.inventoryPct, '')}
        <td class="num">${t.visitTarget ? Math.round(t.visitTarget) : '—'}</td><td class="num">${t.visitPlanned || 0}</td><td class="num">${t.visitDone || 0}</td>${pctCell(t.visitPct, '')}
        ${pctCell(t.overall, 'ba-overall')}
      </tr>`;
  }

  // Client-side totals over the visible rows (matches the backend's blended-overall logic,
  // so it equals data.totals when nothing is filtered).
  function computeTotals(rows) {
    const t = { bookingBudget: 0, bookingActual: 0, billingBudget: 0, billingActual: 0, arBudget: 0, arActual: 0,
                arClosing: 0, arOverdue: 0, arOpenInv: 0,
                inventoryBudget: 0, inventoryActual: 0, visitTarget: 0, visitPlanned: 0, visitDone: 0 };
    rows.forEach(r => { for (const k in t) t[k] += Number(r[k] || 0); });
    const p = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);
    t.bookingPct = p(t.bookingActual, t.bookingBudget); t.billingPct = p(t.billingActual, t.billingBudget);
    t.arPct = p(t.arActual, t.arBudget); t.arOverduePct = p(t.arOverdue, t.arOpenInv); t.inventoryPct = p(t.inventoryActual, t.inventoryBudget);
    t.visitPct = p(t.visitDone, t.visitTarget);
    let na = 0, nb = 0, comps = 0;
    [['bookingActual', 'bookingBudget'], ['billingActual', 'billingBudget'], ['arActual', 'arBudget'], ['inventoryActual', 'inventoryBudget']]
      .forEach(([ak, bk]) => { if (t[bk] > 0) { na += t[ak]; nb += t[bk]; comps++; } });
    const curPct = nb > 0 ? (na / nb) * 100 : null;                                        // money score (rupee-weighted)
    const visitPct = t.visitTarget > 0 ? (t.visitDone / t.visitTarget) * 100 : null;       // visit = plain Done/Target, like the others
    let osum = 0, owt = 0;
    if (curPct != null) { osum += curPct * comps; owt += comps; }
    if (visitPct != null) { osum += visitPct; owt += 1; }
    t.overall = owt > 0 ? Math.round((osum / owt) * 100) / 100 : null;
    return t;
  }

  // ── Set Budgets modal ──────────────────────────────────────────────────────
  function closeModal() { $('baModal').style.display = 'none'; }

  async function openModal() {
    $('baModal').style.display = 'flex';
    const u = unit();
    $('baColBooking').textContent = `Annual Booking (${u.label})`;
    $('baColBilling').textContent = `Annual Billing (${u.label})`;
    $('baColVisit').textContent = `Visit Target (count/yr)`;
    show('baEntryLoading'); hide('baEntryTable');
    const fy = $('baFy').value;
    try {
      const [sp, tg] = await Promise.all([
        apiRequest('/sales/budget/salespeople'),
        apiRequest(`/sales/budget/targets?fiscalYear=${fy}`),
      ]);
      const tmap = {};
      (tg.targets || []).forEach(t => { tmap[t.SalespersonCode] = t; });
      const rows = (sp.salespeople || []).map(p => {
        const t = tmap[p.code] || {};
        const bk = t.BookingAnnual ? (Number(t.BookingAnnual) / u.factor) : '';
        const bl = t.BillingAnnual ? (Number(t.BillingAnnual) / u.factor) : '';
        const vt = t.VisitTargetAnnual ? Math.round(Number(t.VisitTargetAnnual)) : '';
        return `<tr data-code="${esc(p.code)}" data-name="${esc(p.name)}">
          <td>${esc(p.name)} <span class="card-sub">(${esc(p.code)})</span></td>
          <td><input type="number" step="any" min="0" class="form-input ba-in-booking" value="${bk}" /></td>
          <td><input type="number" step="any" min="0" class="form-input ba-in-billing" value="${bl}" /></td>
          <td><input type="number" step="1" min="0" class="form-input ba-in-visit" value="${vt}" /></td>
        </tr>`;
      }).join('');
      $('baEntryBody').innerHTML = rows || '<tr><td colspan="4">No salespeople available for this company.</td></tr>';
      hide('baEntryLoading'); show('baEntryTable');
    } catch (e) {
      hide('baEntryLoading'); alert(e.message || 'Failed to load salespeople.');
    }
  }

  async function saveAll() {
    const u = unit();
    const fy = parseInt($('baFy').value, 10);
    const rows = Array.from(document.querySelectorAll('#baEntryBody tr[data-code]'));
    const btn = $('baSaveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      for (const tr of rows) {
        const bk = parseFloat(tr.querySelector('.ba-in-booking').value) || 0;
        const bl = parseFloat(tr.querySelector('.ba-in-billing').value) || 0;
        const vt = parseFloat(tr.querySelector('.ba-in-visit').value) || 0;
        await apiRequest('/sales/budget', {
          method: 'POST',
          body: {
            fiscalYear: fy,
            salespersonCode: tr.getAttribute('data-code'),
            salespersonName: tr.getAttribute('data-name'),
            bookingAnnual: bk * u.factor,
            billingAnnual: bl * u.factor,
            visitTargetAnnual: vt,   // AR & Inventory are auto-computed — not entered.
          },
        });
      }
      closeModal(); load();
    } catch (e) {
      alert(e.message || 'Save failed.');
    } finally {
      btn.disabled = false; btn.textContent = 'Save all';
    }
  }

  // ── Import budget from Excel (MIS/admin) ──────────────────────────────────
  async function doImport(file) {
    const btn = $('baImportBtn'); const old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const fd = new FormData(); fd.append('file', file);
      const co = getCompany(), fy = $('baFy').value;
      const res = await fetch(`/api/sales/budget/import?company=${encodeURIComponent(co)}&fiscalYear=${fy}`, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + getToken() }, body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Import failed');
      let msg = `Imported ${data.saved} salesperson budget(s) for FY ${data.fiscalYear}.`;
      if (data.unmatched && data.unmatched.length) msg += `\n\nSkipped (no matching salesperson): ${data.unmatched.join(', ')}`;
      alert(msg);
      load();
    } catch (e) {
      alert(e.message || 'Import failed.');
    } finally {
      btn.disabled = false; btn.textContent = old; $('baImportFile').value = '';
    }
  }

  // ── Upload Booking ACTUAL from the consolidated Excel (MIS/admin) ─────────
  // Booking ACTUAL = SUM(Amount) per salesperson (ISR NAME) by date, from the
  // "<Company> Booking Billing Consolidated" sheet. Replaces-by-month, so a growing
  // consolidated file can be re-uploaded daily/weekly with no double-count. COMPANYA and
  // CompanyB are separate uploads (switch company first).
  async function doBookingImport(file) {
    const btn = $('baBookingBtn'); const old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const fd = new FormData(); fd.append('file', file);
      const co = getCompany();
      const res = await fetch(`/api/sales/budget/booking-import?company=${encodeURIComponent(co)}`, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + getToken() }, body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Booking upload failed');
      const money = (n) => Number(n || 0).toLocaleString();
      let msg = `Booking uploaded for ${data.company} — ${(data.months || []).join(', ')}.\n` +
                `${data.inserted} line(s) loaded (${data.replaced} previous replaced).\n` +
                `Matched to a salesperson: ${money(data.matchedAmount)}.`;
      if (data.unmatched && data.unmatched.length) {
        msg += `\n\n⚠ NOT counted — no matching salesperson (${money(data.unmatchedAmount)}):\n` +
               data.unmatched.map(u => `   • ${u.name} — ${money(u.amount)}`).join('\n') +
               `\n\nFix: correct the ISR NAME spelling in the sheet, or give this person a salesperson code (User Management).`;
      }
      alert(msg);
      load();
    } catch (e) {
      alert(e.message || 'Booking upload failed.');
    } finally {
      btn.disabled = false; btn.textContent = old; $('baBookingFile').value = '';
    }
  }

  // ── Export current comparison to Excel ────────────────────────────────────
  async function doExport() {
    const btn = $('baExportBtn'); const old = btn.textContent; btn.disabled = true; btn.textContent = 'Exporting…';
    try {
      const q = new URLSearchParams({ company: getCompany(), fiscalYear: $('baFy').value, period: $('baPeriod').value, month: $('baMonth').value, weekDate: $('baWeekDate').value || '' });
      const res = await fetch(`/api/sales/budget/export?${q.toString()}`, { headers: { 'Authorization': 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${getCompany()}_BudgetVsActual.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { alert(e.message || 'Export failed.'); }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  // ── View toggle (Summary ↔ Monthly trend) ─────────────────────────────────
  function syncView() {
    const v = $('baView').value;
    const monthly = v === 'monthly';
    $('baPeriodWrap').style.display = monthly ? 'none' : '';
    $('baSortWrap').style.display   = (v === 'summary') ? '' : 'none';   // sort is table-only
    $('baMetricWrap').style.display = monthly ? '' : 'none';
    $('baExportBtn').style.display  = monthly ? 'none' : '';
    if (monthly) $('baMonthWrap').style.display = 'none'; else syncPeriodUi();
    load();
  }

  async function loadMonthly() {
    show('baLoading'); hide('baTableWrap'); hide('baMonthlyWrap'); hide('baEmpty'); hide('baError');
    try {
      const q = new URLSearchParams({ fiscalYear: $('baFy').value, metric: $('baMetric').value });
      const data = await apiRequest(`/sales/budget/monthly?${q.toString()}`);
      lastMonthly = data;
      $('baPeriodText').textContent = `${$('baMetric').selectedOptions[0].textContent} — FY ${data.fiscalYear}-${String(data.fiscalYear + 1).slice(2)} (monthly)`;
      renderMonthly(data);
      hide('baLoading');
      if (!data.rows.length) show('baEmpty'); else show('baMonthlyWrap');
    } catch (e) { hide('baLoading'); $('baErrorText').textContent = e.message || 'Failed to load.'; show('baError'); }
  }

  function renderMonthly(data) {
    const isVisit = $('baMetric').value === 'visit';
    const fmt = isVisit ? (v) => (v ? Math.round(v) : '—') : (v) => (v ? fmtMoney(v) : '—');
    const head = `<thead><tr><th>Salesperson</th>${data.months.map(x => `<th class="num">${x}</th>`).join('')}<th class="num">Target/mo</th><th class="num">YTD Actual</th><th class="num">%</th></tr></thead>`;
    const body = data.rows.filter(r => matchesSearch(r)).map(r => {
      const cells = r.months.map(v => {
        const cls = r.monthlyBudget > 0 ? (v >= r.monthlyBudget ? 'good' : 'bad') : '';
        return `<td class="num pct ${cls}">${fmt(v)}</td>`;
      }).join('');
      const pc = r.pct == null ? '' : (r.pct >= 100 ? 'good' : 'bad');
      return `<tr><td>${esc(r.name)}</td>${cells}<td class="num">${fmt(r.monthlyBudget)}</td><td class="num">${fmt(r.totalActual)}</td><td class="num pct ${pc}">${r.pct == null ? '—' : r.pct.toFixed(0) + '%'}</td></tr>`;
    }).join('');
    $('baMonthlyWrap').innerHTML = `<table class="ba-table">${head}<tbody>${body}</tbody></table>`;
  }

  // ── Premium Dashboard view (Chart.js) ─────────────────────────────────────
  const NAVY = '#1e3a5f', GOLD = '#c9a227';
  function ringColor(p) {
    if (p == null) return '#9ca3af';
    if (p >= 100) return '#16a34a';
    if (p >= 75)  return GOLD;
    if (p >= 40)  return '#f59e0b';
    return '#dc2626';
  }
  function themeColors() {
    const cs = getComputedStyle(document.body);
    const g = (v, d) => (cs.getPropertyValue(v) || '').trim() || d;
    return { text: g('--text2', '#556'), grid: g('--border', 'rgba(0,0,0,.08)'), card: g('--bg2', '#fff') };
  }
  function destroyDashCharts() { dashCharts.forEach(c => { try { c.destroy(); } catch (_) {} }); dashCharts = []; }

  function renderDashboard(data) {
    destroyDashCharts();
    const t = data.totals || {};
    const allRows = (data.rows || []).slice();
    // Per-person views (dropdown, pie, leaderboard) show only CURRENT ONE App users (isUser).
    // Totals/KPIs stay COMPLETE (include ex-staff data) so Booking/Billing/AR aren't understated.
    const userRows = allRows.filter(r => r.isUser);
    const u = dispUnit();
    // Focus salesperson = the shared top "Salesperson" dropdown (by name); '' = whole company.
    const selName = selectedSp();
    const sel = selName ? userRows.find(r => r.name === selName) : null;
    const src = sel || t;

    const kpi = (name, actual, budget, pct, isCount) => {
      const p = pct == null ? null : pct;
      const ringPct = p == null ? 0 : Math.max(0, Math.min(100, p));
      const figs = isCount ? `${Math.round(actual || 0)} / ${Math.round(budget || 0)}` : `${fmtMoney(actual)} / ${fmtMoney(budget)}`;
      return `<div class="kpi-card">
        <div class="kpi-ring" style="--pct:${ringPct};--col:${ringColor(p)};"><div class="kpi-ring-inner"><span class="kpi-pct">${p == null ? '—' : Math.round(p) + '%'}</span></div></div>
        <div class="kpi-name">${name}</div>
        <div class="kpi-figs">${figs}</div>
        <div class="kpi-sub">${isCount ? 'Done / Target' : 'Actual / Budget · ' + u}</div>
      </div>`;
    };
    $('baDashboardWrap').innerHTML = `
      <div class="ba-dash">
        <div class="kpi-row">
          ${kpi('Booking',   src.bookingActual,   src.bookingBudget,   src.bookingPct,   false)}
          ${kpi('Billing',   src.billingActual,   src.billingBudget,   src.billingPct,   false)}
          ${kpi('AR Coll.',  src.arActual,        src.arBudget,        src.arPct,        false)}
          ${kpi('Inventory', src.inventoryActual, src.inventoryBudget, src.inventoryPct, false)}
          ${kpi('Visit',     src.visitDone,       src.visitTarget,     src.visitPct,     true)}
        </div>
        <div class="dash-grid">
          <div class="dash-card dash-card-wide"><div class="dash-card-title">Budget vs Actual — ${u}${sel ? ' · ' + esc(sel.name) : ''}</div><div class="dash-canvas-wrap"><canvas id="dashBar"></canvas></div></div>
          <div class="dash-card"><div class="dash-card-title">Booking share by salesperson</div><div class="dash-canvas-wrap pie"><canvas id="dashPie"></canvas></div></div>
          <div class="dash-card dash-card-wide"><div class="dash-card-title">Leaderboard — Overall %</div><div class="dash-canvas-wrap" id="dashLeaderWrap"><canvas id="dashLeader"></canvas></div></div>
          <div class="dash-card dash-card-wide"><div class="dash-card-title">Monthly trend — Booking &amp; Billing (${u})${sel ? ' · ' + esc(sel.name) : ''}</div><div class="dash-canvas-wrap"><canvas id="dashTrend"></canvas></div></div>
        </div>
      </div>`;

    if (!window.Chart) return;   // KPI rings still render (pure CSS); charts need the library
    const tc = themeColors();
    Chart.defaults.color = tc.text;
    Chart.defaults.font.family = "'IBM Plex Sans','DM Sans',sans-serif";
    const money = v => Math.round((Number(v || 0) / dispFactor()) * 100) / 100;

    // 1) Budget vs Actual grouped bar (from `src` — company totals or the selected person)
    dashCharts.push(new Chart($('dashBar'), {
      type: 'bar',
      data: { labels: ['Booking', 'Billing', 'AR', 'Inventory'], datasets: [
        { label: 'Budget', data: [money(src.bookingBudget), money(src.billingBudget), money(src.arBudget), money(src.inventoryBudget)], backgroundColor: NAVY, borderRadius: 4, maxBarThickness: 48 },
        { label: 'Actual', data: [money(src.bookingActual), money(src.billingActual), money(src.arActual), money(src.inventoryActual)], backgroundColor: GOLD, borderRadius: 4, maxBarThickness: 48 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: tc.grid }, ticks: { callback: v => v.toLocaleString('en-IN') } } } },
    }));

    // 2) Booking share doughnut — ONE App users only (top 8 + Others)
    const PIE = ['#1e3a5f', '#c9a227', '#2e7d5b', '#b4642e', '#5b7fb4', '#8a6d3b', '#6b8e9e', '#a0562e', '#9aa0a6'];
    const bk = userRows.filter(r => Number(r.bookingActual) > 0).sort((a, b) => b.bookingActual - a.bookingActual);
    const pieTop = bk.slice(0, 8), othersVal = bk.slice(8).reduce((s, r) => s + Number(r.bookingActual || 0), 0);
    const pieLabels = pieTop.map(r => r.name).concat(othersVal > 0 ? ['Others'] : []);
    const pieVals = pieTop.map(r => money(r.bookingActual)).concat(othersVal > 0 ? [money(othersVal)] : []);
    if (pieVals.length) dashCharts.push(new Chart($('dashPie'), {
      type: 'doughnut',
      data: { labels: pieLabels, datasets: [{ data: pieVals, backgroundColor: PIE, borderWidth: 2, borderColor: tc.card }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '58%', plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } } },
    }));

    // 3) Leaderboard — Overall % — ONE App users only (top 12), height scales to bar count so a
    //    single-salesperson login doesn't get one enormous bar; selected person is outlined.
    const lb = userRows.filter(r => r.overall != null).sort((a, b) => b.overall - a.overall);   // ALL ONE App users — no cap, so nobody is missed
    const lbWrap = $('dashLeaderWrap');
    if (lbWrap) lbWrap.style.height = Math.max(140, lb.length * 30 + 60) + 'px';   // grows to fit everyone
    if (lb.length) dashCharts.push(new Chart($('dashLeader'), {
      type: 'bar',
      data: { labels: lb.map(r => r.name), datasets: [{ label: 'Overall %', data: lb.map(r => r.overall),
        backgroundColor: lb.map(r => ringColor(r.overall)), borderRadius: 4, maxBarThickness: 24,
        borderColor: lb.map(r => (selName && r.name === selName) ? NAVY : 'transparent'), borderWidth: lb.map(r => (selName && r.name === selName) ? 2 : 0) }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.x + '%' } } },
        scales: { x: { grid: { color: tc.grid }, ticks: { callback: v => v + '%' } }, y: { grid: { display: false } } } },
    }));

    // 4) Monthly trend — Booking + Billing (summed per month; filtered to the selected person if any)
    (async () => {
      try {
        const fy = $('baFy').value;
        const [mb, ml] = await Promise.all([
          apiRequest(`/sales/budget/monthly?fiscalYear=${fy}&metric=booking`),
          apiRequest(`/sales/budget/monthly?fiscalYear=${fy}&metric=billing`),
        ]);
        const months = mb.months || [];
        const pick = d => sel ? (d.rows || []).filter(r => (r.name || '') === sel.name) : (d.rows || []);
        const sum = d => { const rs = pick(d); return months.map((_, i) => money(rs.reduce((s, r) => s + (Number((r.months || [])[i]) || 0), 0))); };
        const el = $('dashTrend'); if (!el || $('baView').value !== 'dashboard') return;   // view changed while fetching
        dashCharts.push(new Chart(el, {
          type: 'line',
          data: { labels: months, datasets: [
            { label: 'Booking', data: sum(mb), borderColor: GOLD, backgroundColor: 'rgba(201,162,39,.12)', fill: true, tension: .35, pointRadius: 3 },
            { label: 'Billing', data: sum(ml), borderColor: NAVY, backgroundColor: 'rgba(30,58,95,.08)', fill: true, tension: .35, pointRadius: 3 },
          ] },
          options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: { x: { grid: { display: false } }, y: { grid: { color: tc.grid }, ticks: { callback: v => v.toLocaleString('en-IN') } } } },
        }));
      } catch (_) { /* trend is optional */ }
    })();
  }

  // ── Drill-down: documents behind an Actual number ─────────────────────────
  async function openDetail(metric, code, name) {
    $('baDetailModal').style.display = 'flex';
    const AR_LABELS = { 'ar': 'AR — Collected', 'ar-collectible': 'AR — Collectible (still to collect)', 'ar-overdue': 'AR — Overdue invoices' };
    const label = AR_LABELS[metric] || (metric.charAt(0).toUpperCase() + metric.slice(1));
    $('baDetailTitle').textContent = `${name} — ${label} · ${$('baPeriodText').textContent}`;
    // Breakdown note — reuses the numbers already on the row so every AR figure is self-explanatory.
    const row = ((lastData && lastData.rows) || []).find(r => r.code === code);
    let note = '';
    if (row) {
      if (metric === 'ar-collectible')
        note = `Collectible ${fmtMoney(row.arBudget)} = Collected ${fmtMoney(row.arActual)} (received this period) + Still-owed ${fmtMoney(row.arClosing)} (the open invoices below). Amounts in ${dispUnit()}.`;
      else if (metric === 'ar-overdue')
        note = `Overdue ${fmtMoney(row.arOverdue)} ÷ open-invoice AR ${fmtMoney(row.arOpenInv)} = ${row.arOverduePct == null ? '—' : row.arOverduePct + '%'} past due. The invoices below are past their due date. Amounts in ${dispUnit()}.`;
      else if (metric === 'ar')
        note = `Collected ${fmtMoney(row.arActual)} this period against this rep's own invoices. Amounts in ${dispUnit()}.`;
    }
    if ($('baDetailNote')) $('baDetailNote').textContent = note;
    show('baDetailLoading'); hide('baDetailTable');
    try {
      const q = new URLSearchParams({ metric, code, fiscalYear: $('baFy').value, period: $('baPeriod').value, month: $('baMonth').value, weekDate: $('baWeekDate').value || '' });
      const data = await apiRequest(`/sales/budget/detail?${q.toString()}`);
      const cur = data.isCurrency !== false;
      const lastIdx = data.columns.length - 1;
      $('baDetailHead').innerHTML = `<tr>${data.columns.map((c, i) => `<th class="${cur && i === lastIdx ? 'num' : ''}">${esc(c)}</th>`).join('')}</tr>`;
      const body = (data.rows || []).map(row => `<tr>${row.map((v, i) =>
        (cur && i === lastIdx) ? `<td class="num">${fmtCur(v)}</td>` : `<td>${esc(v)}</td>`).join('')}</tr>`).join('');
      let footer;
      if (cur) {
        const total = (data.rows || []).reduce((s, row) => s + Number(row[lastIdx] || 0), 0);
        footer = `<tr class="ba-total-row"><td colspan="${lastIdx}">Total (${(data.rows || []).length})</td><td class="num">${fmtCur(total)}</td></tr>`;
      } else {
        footer = `<tr class="ba-total-row"><td colspan="${data.columns.length}">Total (${(data.rows || []).length})</td></tr>`;
      }
      $('baDetailBody').innerHTML = body + footer;
      hide('baDetailLoading'); show('baDetailTable');
    } catch (e) { hide('baDetailLoading'); alert(e.message || 'Failed to load details.'); closeDetail(); }
  }
  function closeDetail() { $('baDetailModal').style.display = 'none'; }

  document.addEventListener('DOMContentLoaded', () => {
    const user = requireAuth();
    if (!user) return;
    renderSidebar('budget-actual');
    if (typeof setRoleTag === 'function') setRoleTag();
    initControls();

    $('baFy').addEventListener('change', load);
    $('baPeriod').addEventListener('change', () => { syncPeriodUi(); load(); });
    $('baMonth').addEventListener('change', load);
    $('baWeekDate').addEventListener('change', load);
    $('baSort').addEventListener('change', () => { if (lastData) renderTable(lastData); });
    if ($('baSearch')) $('baSearch').addEventListener('change', () => {
      const v = $('baView').value;
      if (v === 'monthly') { if (lastMonthly) renderMonthly(lastMonthly); }
      else if (v === 'dashboard') { if (lastData) renderDashboard(lastData); }
      else if (lastData) renderTable(lastData);
    });
    $('baRefreshBtn').addEventListener('click', load);
    $('baSetBtn').addEventListener('click', openModal);
    $('baImportBtn').addEventListener('click', () => $('baImportFile').click());
    $('baImportFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) doImport(f); });
    $('baBookingBtn').addEventListener('click', () => $('baBookingFile').click());
    $('baBookingFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) doBookingImport(f); });
    $('baCancelBtn').addEventListener('click', closeModal);
    $('baSaveBtn').addEventListener('click', saveAll);
    $('baModal').addEventListener('click', (e) => { if (e.target === $('baModal')) closeModal(); });
    $('baView').addEventListener('change', syncView);
    $('baMetric').addEventListener('change', load);
    $('baExportBtn').addEventListener('click', doExport);
    $('baBody').addEventListener('click', (e) => {
      const cell = e.target.closest && e.target.closest('.ba-drill');
      if (cell) openDetail(cell.getAttribute('data-metric'), cell.getAttribute('data-code'), cell.getAttribute('data-name'));
    });
    $('baDetailClose').addEventListener('click', closeDetail);
    $('baDetailModal').addEventListener('click', (e) => { if (e.target === $('baDetailModal')) closeDetail(); });

    load();
  });
})();
