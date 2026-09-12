// =====================================================================
// modules/hr/js/dashboard.js — HR Dashboard (Phase 4A)
//
// Fetches /api/hr/dashboard/summary and renders:
//   • 7 KPI cards
//   • 1 line chart (Additions & Attrition, 12 months)
//   • 5 charts (Years In Service / Age / Gender / Location / Department)
//   • Top 5 Leave Takers list
//
// Chart.js 4.x is loaded from CDN in dashboard.html.
// =====================================================================

(() => {
  const user = (typeof requireAuth === 'function') ? requireAuth() : null;
  if (!user) return;   // requireAuth redirects to /login

  const charts = {};   // keep instances so we can destroy on reload

  // ── Boot ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);

  async function init() {
    if (typeof renderSidebar === 'function') renderSidebar('hr-dashboard');
    await loadDashboard();
  }

  // Expose for the Refresh button
  window.loadDashboard = loadDashboard;

  async function loadDashboard() {
    showDiag();   // clear
    try {
      const data = await apiRequest('/hr/dashboard/summary');
      renderFy(data.fy);
      renderKpis(data.kpis || {});
      renderAdditionsAttrition(data.additionsAttrition || []);
      renderYearsInService(data.yearsInService || []);
      renderAge(data.ageDistribution || []);
      renderGender(data.genderDistribution || []);
      renderLocation(data.byLocation || []);
      renderDepartment(data.byDepartment || []);
      renderLeaveTakers(data.topLeaveTakers || [], data.fy);
    } catch (err) {
      showDiag('Failed to load dashboard: ' + (err.message || err));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = (v == null ? '—' : v); }
  function renderFy(fy)   { setText('dashFyTag', fy || 'FY—'); setText('ltFyTag', fy || ''); }

  function showDiag(msg) {
    const sec = document.getElementById('dashDiag');
    const list = document.getElementById('diagList');
    if (!sec || !list) return;
    if (!msg) { sec.style.display = 'none'; list.innerHTML = ''; return; }
    sec.style.display = 'block';
    const li = document.createElement('li');
    li.textContent = msg;
    list.appendChild(li);
  }

  function destroyChart(key) {
    if (charts[key]) { try { charts[key].destroy(); } catch (_) {} charts[key] = null; }
  }

  // Read CSS variables so charts pick up day/night theme
  function themeVars() {
    const s = getComputedStyle(document.body);
    return {
      text:    s.getPropertyValue('--text').trim()    || '#e8eaf2',
      text2:   s.getPropertyValue('--text2').trim()   || '#8b91a8',
      border:  s.getPropertyValue('--border').trim()  || '#2a2f40',
      bg2:     s.getPropertyValue('--bg2').trim()     || '#13161e',
      accent:  s.getPropertyValue('--accent').trim()  || '#4f8ef7',
      green:   s.getPropertyValue('--green').trim()   || '#34c77b',
      red:     s.getPropertyValue('--red').trim()     || '#f25757',
      amber:   s.getPropertyValue('--amber').trim()   || '#f0a22e',
      purple:  s.getPropertyValue('--purple').trim()  || '#9b71f5',
      teal:    s.getPropertyValue('--teal').trim()    || '#2ec4b6',
    };
  }

  // Palette used for categorical charts
  function palette(n) {
    const t = themeVars();
    const base = [t.accent, t.green, t.amber, t.purple, t.teal, t.red, '#ff6b9d', '#8dd3c7', '#bebada', '#fdb462'];
    return Array.from({ length: n }, (_, i) => base[i % base.length]);
  }

  // ── KPIs ──────────────────────────────────────────────────────────────
  function renderKpis(k) {
    setText('kpiTotal',          k.total);
    setText('kpiActiveNow',      k.activeFieldStaffNow);
    setText('kpiNewJoiners',     k.newJoinersMonth);
    setText('kpiBirthdays',      k.birthdaysMonth);
    setText('kpiAnniversaries',  k.anniversariesMonth);
    setText('kpiConfirmation',   k.confirmationDue30d);
    setText('kpiResign',         k.resignationsPending);
  }

  // ── Additions & Attrition (line) ──────────────────────────────────────
  function renderAdditionsAttrition(rows) {
    destroyChart('aa');
    const ctx = document.getElementById('aaChart');
    if (!ctx || !window.Chart) return;
    const t = themeVars();
    const labels = rows.map(r => formatMonth(r.month));
    charts.aa = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Joined', data: rows.map(r => r.joined), backgroundColor: t.green, borderRadius: 4 },
          { label: 'Left',   data: rows.map(r => r.left),   backgroundColor: t.red,   borderRadius: 4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: t.text2 } },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: { ticks: { color: t.text2 }, grid: { color: t.border } },
          y: { ticks: { color: t.text2, precision: 0 }, grid: { color: t.border }, beginAtZero: true },
        },
      },
    });
  }

  function formatMonth(yyyyMm) {
    if (!yyyyMm) return '';
    const [y, m] = yyyyMm.split('-').map(Number);
    return new Date(y, (m || 1) - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
  }

  // ── Years In Service (doughnut) ───────────────────────────────────────
  function renderYearsInService(rows) {
    destroyChart('yis');
    const ctx = document.getElementById('yisChart');
    if (!ctx || !window.Chart) return;
    const t = themeVars();
    charts.yis = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: rows.map(r => r.bucket),
        datasets: [{ data: rows.map(r => r.count), backgroundColor: palette(rows.length), borderColor: t.bg2, borderWidth: 2 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { color: t.text2, boxWidth: 12 } } },
      },
    });
  }

  // ── Age Distribution (bar) ────────────────────────────────────────────
  function renderAge(rows) {
    destroyChart('age');
    const ctx = document.getElementById('ageChart');
    if (!ctx || !window.Chart) return;
    const t = themeVars();
    charts.age = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.bucket),
        datasets: [{ label: 'Employees', data: rows.map(r => r.count), backgroundColor: t.purple, borderRadius: 4 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: t.text2 }, grid: { color: t.border } },
          y: { ticks: { color: t.text2, precision: 0 }, grid: { color: t.border }, beginAtZero: true },
        },
      },
    });
  }

  // ── Gender Distribution (doughnut) ────────────────────────────────────
  function renderGender(rows) {
    destroyChart('gender');
    const ctx = document.getElementById('genderChart');
    if (!ctx || !window.Chart) return;
    const t = themeVars();
    const colorFor = (name) => {
      const n = (name || '').toLowerCase();
      if (n.startsWith('male'))   return t.accent;
      if (n.startsWith('female')) return '#ff6b9d';
      if (n.startsWith('other'))  return t.purple;
      return t.text2;
    };
    charts.gender = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: rows.map(r => r.name),
        datasets: [{ data: rows.map(r => r.count), backgroundColor: rows.map(r => colorFor(r.name)), borderColor: t.bg2, borderWidth: 2 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { color: t.text2, boxWidth: 12 } } },
      },
    });
  }

  // ── By Location (horizontal bar) ──────────────────────────────────────
  function renderLocation(rows) {
    destroyChart('loc');
    const ctx = document.getElementById('locChart');
    if (!ctx || !window.Chart) return;
    const t = themeVars();
    charts.loc = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name),
        datasets: [{ label: 'Employees', data: rows.map(r => r.count), backgroundColor: t.teal, borderRadius: 4 }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: t.text2, precision: 0 }, grid: { color: t.border }, beginAtZero: true },
          y: { ticks: { color: t.text2 }, grid: { color: t.border } },
        },
      },
    });
  }

  // ── By Department (horizontal bar) ────────────────────────────────────
  function renderDepartment(rows) {
    destroyChart('dept');
    const ctx = document.getElementById('deptChart');
    if (!ctx || !window.Chart) return;
    const t = themeVars();
    charts.dept = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name),
        datasets: [{ label: 'Employees', data: rows.map(r => r.count), backgroundColor: t.amber, borderRadius: 4 }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: t.text2, precision: 0 }, grid: { color: t.border }, beginAtZero: true },
          y: { ticks: { color: t.text2 }, grid: { color: t.border } },
        },
      },
    });
  }

  // ── Top 5 Leave Takers (list) ─────────────────────────────────────────
  function renderLeaveTakers(rows, fy) {
    const wrap = document.getElementById('leaveTakersList');
    if (!wrap) return;
    if (!rows.length) {
      wrap.innerHTML = `<div class="lt-empty">No approved leaves yet ${fy ? 'in ' + fy : ''}.</div>`;
      return;
    }
    const maxDays = Math.max(...rows.map(r => Number(r.days) || 0)) || 1;
    wrap.innerHTML = rows.map((r, idx) => {
      const pct = Math.round((Number(r.days) || 0) / maxDays * 100);
      const initials = (r.name || '?').split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
      return `
        <div class="lt-row">
          <div class="lt-rank">${idx + 1}</div>
          <div class="lt-avatar">${escapeHtml(initials)}</div>
          <div class="lt-main">
            <div class="lt-name"><a href="/modules/hr/employee-profile.html?id=${r.userId}">${escapeHtml(r.name || '—')}</a></div>
            <div class="lt-sub">${escapeHtml(r.empCode || '—')} · ${escapeHtml(r.department || '—')}</div>
            <div class="lt-bar"><div class="lt-bar-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="lt-days"><b>${Number(r.days).toFixed(1)}</b><span>days</span></div>
        </div>`;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
})();
