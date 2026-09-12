// =====================================================================
// shared/common.js — ONE App shared frontend helpers
//
// Functions: auth, apiRequest (auto-attaches company), formatting,
// theme toggle, sidebar render (driven by shared/modules.js registry),
// mobile menu init.
// =====================================================================

// ─── PWA Service Worker registration ───────────────────────────────────────
// Registers /service-worker.js once on page load. Enables:
//   • Offline shell (UI opens even on poor signal — APIs still need network)
//   • "Add to Home Screen" / "Install app" prompts on Android Chrome + iOS Safari
// SW only runs over HTTPS (or localhost). Cloudflare Tunnel serves https — works.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .catch((err) => console.warn('[PWA] Service worker registration failed:', err));
  });
}

const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('nav_token') || sessionStorage.getItem('nav_token');
}

function getUser() {
  const raw = localStorage.getItem('nav_user') || sessionStorage.getItem('nav_user');
  return raw ? JSON.parse(raw) : null;
}

function getCompany() {
  return sessionStorage.getItem('nav_company') || 'COMPANYA';
}

function clearAuth() {
  localStorage.removeItem('nav_token');
  localStorage.removeItem('nav_user');
  sessionStorage.removeItem('nav_token');
  sessionStorage.removeItem('nav_user');
}

async function apiRequest(path, options = {}) {
  const token   = getToken();
  const company = getCompany();

  // Auto-attach ?company= so single backend route serves both COMPANYA + CompanyB
  const sep = path.includes('?') ? '&' : '?';
  const fullPath = `${API_BASE}${path}${sep}company=${encodeURIComponent(company)}`;

  const res = await fetch(fullPath, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Company':    company,
      ...(token ? { Authorization: token } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let data = {};
  try { data = await res.json(); } catch (err) {}

  if (res.status === 401 || res.status === 403) {
    clearAuth();
    window.location.href = '/index.html';
    return;
  }
  if (!res.ok) throw new Error(data.message || data.error || data.detail || ('HTTP ' + res.status));
  return data;
}

function fmt(n, dec = 0) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n);
}

function fmtCur(n, currency) {
  if (n == null) return '—';
  const cur = (currency || (getCompany() === 'COMPANYB' ? 'USD' : 'INR')).toUpperCase();
  if (cur === 'USD') {
    return '$ ' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  }
  return '₹ ' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtINR(n) { return fmtCur(n, 'INR'); }
function fmtUSD(n) { return fmtCur(n, 'USD'); }

function fmtDate(d) {
  if (!d) return '—';
  // A plain 'YYYY-MM-DD' (date-only, no time) must show that exact calendar day on
  // EVERY timezone. Passing it to new Date() parses it as UTC midnight and
  // toLocaleDateString then shifts it ±1 day by the browser's offset — that's the
  // "date shows one day extra" bug. Build a LOCAL date from the parts instead.
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function agingBadge(days) {
  if (days == null) return `<span class="badge badge-blue">—</span>`;
  if (days <= 0)    return `<span class="badge badge-green">Current</span>`;
  if (days <= 60)   return `<span class="badge badge-amber">${days}d</span>`;
  return `<span class="badge badge-red">${days}d overdue</span>`;
}

function requireAuth() {
  const user = getUser();
  if (!user) { window.location.href = '/index.html'; return null; }
  initTheme();
  const afterLoad = () => { injectThemeToggle(); injectNotificationBell(); initPushNotifications(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', afterLoad);
  } else {
    setTimeout(afterLoad, 0);
  }
  return user;
}

function logout() {
  clearAuth();
  sessionStorage.removeItem('nav_company');
  window.location.href = '/index.html';
}

// ── Native-aware Save & Share helper ────────────────────────────────────
// In Capacitor (Android APK / iOS): writes the blob to Cache, then pops the
//   native Share Sheet so the user can send to WhatsApp / Email / Files / Drive.
// In a browser (PWA / desktop): falls back to the standard `<a download>` click.
//
// Use this from anywhere we previously called XLSX.writeFile / jsPDF.save /
// window.open(blobUrl) — those don't work inside Capacitor's WebView.
async function nativeSaveAndShare(blob, filename, opts = {}) {
  const inCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (inCapacitor) {
    try {
      const Filesystem = window.Capacitor.Plugins.Filesystem;
      const Share      = window.Capacitor.Plugins.Share;
      // Capacitor Filesystem needs base64 (no data:URI prefix)
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      const w = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: 'CACHE',
        recursive: true,
      });
      await Share.share({
        title: opts.title || filename,
        text:  opts.text  || filename,
        url:   w.uri,
        dialogTitle: opts.dialogTitle || 'Share file via…',
      });
      return { ok: true, native: true };
    } catch (err) {
      // user cancelled the share sheet → not a real error
      const msg = String(err && err.message || err);
      if (/cancel/i.test(msg)) return { ok: false, cancelled: true, native: true };
      console.warn('[nativeSaveAndShare] native path failed, falling back to browser download:', err);
      // fall through to browser download
    }
  }
  // Browser fallback — classic <a download> click
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  return { ok: true, native: false };
}

// ── Auth-friendly Tax Invoice PDF download ──────────────────────────────
// Used by Customer Ledger, Billing, Outstanding etc. Fetches the PDF with
// JWT attached, then either opens the native Share Sheet (Capacitor) or
// pops the blob in a new tab (browser).
async function downloadInvoicePdf(invoiceNo) {
  return _downloadPostedPdf({
    url:        `/api/sales/invoices/${encodeURIComponent(invoiceNo)}/pdf`,
    fileName:   `Invoice_${invoiceNo}.pdf`,
    label:      'invoice',
    shareTitle: 'Share invoice',
    docNo:      invoiceNo,
  });
}

// ── Auth-friendly Sales Credit Memo PDF download ────────────────────────
// Triggered from Customer Ledger on Credit Memo rows (NAV Report 207 layout).
async function downloadCreditMemoPdf(memoNo) {
  return _downloadPostedPdf({
    url:        `/api/sales/credit-memos/${encodeURIComponent(memoNo)}/pdf`,
    fileName:   `CreditMemo_${memoNo}.pdf`,
    label:      'credit memo',
    shareTitle: 'Share credit memo',
    docNo:      memoNo,
  });
}

// ── Auth-friendly Payment Advice PDF download (v1.8) ───────────────────
// Triggered from Customer Ledger on Payment rows (Document Type=1 in NAV).
// Shows amount received + applied invoices + account summary.
async function downloadPaymentAdvicePdf(docNo) {
  return _downloadPostedPdf({
    url:        `/api/sales/payments/${encodeURIComponent(docNo)}/pdf`,
    // NAV doc nos contain '/' (e.g. COMPANYA/2627/02346) — replace for filename.
    fileName:   `PaymentAdvice_${String(docNo).replace(/[\/\\]/g, '-')}.pdf`,
    label:      'payment advice',
    shareTitle: 'Share payment advice',
    docNo,
  });
}

// ── Shared helper: GET a posted-document PDF and open / share it ────────
async function _downloadPostedPdf({ url, fileName, label, shareTitle, docNo }) {
  if (!docNo) return;
  const token   = getToken();
  const company = getCompany();
  try {
    const fullUrl = `${url}?company=${encodeURIComponent(company)}`;
    const res = await fetch(fullUrl, { headers: { 'Authorization': token, 'X-Company': company } });
    if (!res.ok) {
      let msg = `Failed to download ${label} (HTTP ${res.status})`;
      try { const j = await res.json(); msg = j.message || msg; } catch {}
      alert(msg);
      return;
    }
    const blob = await res.blob();
    const inCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if (inCapacitor) {
      await nativeSaveAndShare(blob, fileName, { dialogTitle: shareTitle });
    } else {
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
  } catch (err) {
    alert(`Error downloading ${label}: ` + (err.message || err));
  }
}

function setRoleTag() {
  const user = getUser();
  const roleTag = document.getElementById('roleTag');
  if (user && roleTag) roleTag.textContent = (user.role || '').toUpperCase();
}

// ── Theme: Day / Night ────────────────────────────────────────────────────

function getTheme()  { return localStorage.getItem('biznav_theme') || 'night'; }

function setTheme(theme) {
  localStorage.setItem('biznav_theme', theme);
  if (theme === 'day') document.body.classList.add('day-theme');
  else                  document.body.classList.remove('day-theme');
  document.querySelectorAll('.theme-input').forEach(inp => inp.checked = (theme === 'day'));
  document.querySelectorAll('.theme-label').forEach(lbl => lbl.textContent = theme === 'day' ? 'Day' : 'Night');
}

function toggleTheme() { setTheme(getTheme() === 'night' ? 'day' : 'night'); }
function initTheme()   { setTheme(getTheme()); }

function injectThemeToggle() {
  const actions = document.querySelector('.topbar-actions');
  if (!actions || document.getElementById('themeToggle')) return;

  const wrap = document.createElement('div');
  wrap.className = 'theme-toggle-wrap';
  wrap.innerHTML = `
    <label class="theme-toggle" id="themeToggle" title="Toggle Day / Night theme">
      <input type="checkbox" class="theme-input" onchange="toggleTheme()" />
      <div class="theme-track"><div class="theme-thumb"></div></div>
    </label>
    <span class="theme-label">Night</span>
  `;
  actions.insertBefore(wrap, actions.firstChild);
  const theme = getTheme();
  const inp = wrap.querySelector('.theme-input');
  if (inp) inp.checked = (theme === 'day');
  const lbl = wrap.querySelector('.theme-label');
  if (lbl) lbl.textContent = theme === 'day' ? 'Day' : 'Night';
}

// ══════════════════════════════════════════════════════════════════════════
// Notification bell (topbar) — in-app inbox + unread badge. Injected on every
// authenticated page via requireAuth(). Data from /api/notifications.
// ══════════════════════════════════════════════════════════════════════════
let _notifPollTimer = null;

function _notifInjectStyle() {
  if (document.getElementById('notifBellStyle')) return;
  const s = document.createElement('style');
  s.id = 'notifBellStyle';
  s.textContent = `
    .notif-wrap{position:relative;display:inline-flex;align-items:center}
    .notif-btn{position:relative;background:transparent;border:none;cursor:pointer;font-size:20px;line-height:1;padding:6px;border-radius:10px;color:inherit}
    .notif-btn:hover{background:rgba(127,127,127,.15)}
    .notif-badge{position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#e5484d;color:#fff;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;line-height:16px;text-align:center}
    .notif-badge.show{display:flex}
    .notif-panel{position:absolute;top:120%;right:0;width:360px;max-width:88vw;max-height:70vh;overflow-y:auto;background:var(--bg2,#1b2130);color:var(--text,#e8edf5);border:1px solid var(--border,#2a3346);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45);z-index:4000;display:none}
    .notif-panel.open{display:block}
    .notif-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border,#2a3346);position:sticky;top:0;background:inherit}
    .notif-head b{font-size:14px}
    .notif-head a{font-size:12px;color:#4f8ef7;cursor:pointer;text-decoration:none}
    .notif-item{display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border,#242c3d);cursor:pointer;text-decoration:none;color:inherit}
    .notif-item:hover{background:rgba(127,127,127,.08)}
    .notif-item.unread{background:rgba(79,142,247,.08)}
    .notif-dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;margin-top:5px;background:#4f8ef7;opacity:0}
    .notif-item.unread .notif-dot{opacity:1}
    .notif-ic{flex:0 0 22px;font-size:18px;line-height:1.2}
    .notif-bd{flex:1;min-width:0}
    .notif-ti{font-size:13px;font-weight:600;margin:0 0 2px}
    .notif-tx{font-size:12px;opacity:.8;margin:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .notif-tm{font-size:11px;opacity:.55;margin-top:3px}
    .notif-empty{padding:34px 14px;text-align:center;opacity:.6;font-size:13px}
  `;
  document.head.appendChild(s);
}

const NOTIF_ICONS = {
  visit_today:'📍', payment_overdue:'⚠️', pdc_lapsed:'🏦', payment_received:'💰',
  invoice_created:'🧾', so_ex_stock:'📦', holiday_tomorrow:'🎉', leave_applied:'📝',
  leave_approved:'✅', leave_rejected:'🚫', payslip_available:'💵', salary_paid:'💵',
  letter_issued:'📄', form16_ready:'📑', helpdesk:'🎫', wh_received:'📦', store_verify:'🔍',
  mom_ap_due:'🗒️', workflow_pending:'📝', test:'🔔', system:'🔔',
};
function _notifIcon(t){ return NOTIF_ICONS[t] || '🔔'; }
function _timeAgo(iso){
  if(!iso) return '';
  const d=new Date(iso), s=Math.floor((Date.now()-d.getTime())/1000);
  if(s<60)return 'just now'; if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago'; if(s<604800)return Math.floor(s/86400)+'d ago';
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'});
}

function injectNotificationBell(){
  const actions = document.querySelector('.topbar-actions');
  if(!actions || document.getElementById('notifBell')) return;
  _notifInjectStyle();
  const wrap = document.createElement('div');
  wrap.className = 'notif-wrap';
  wrap.innerHTML = `
    <button class="notif-btn" id="notifBell" title="Notifications" aria-label="Notifications">🔔<span class="notif-badge" id="notifBadge">0</span></button>
    <div class="notif-panel" id="notifPanel">
      <div class="notif-head"><b>Notifications</b><a id="notifMarkAll">Mark all read</a></div>
      <div id="notifList"><div class="notif-empty">Loading…</div></div>
      <div class="notif-head" style="border-top:1px solid var(--border,#2a3346);border-bottom:none;justify-content:center">
        <a href="/modules/notifications/notifications.html">See all notifications →</a>
      </div>
    </div>`;
  actions.insertBefore(wrap, actions.firstChild);

  const bell = wrap.querySelector('#notifBell');
  const panel = wrap.querySelector('#notifPanel');
  bell.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.contains('open') ? _notifClose() : _notifOpen(); });
  document.addEventListener('click', (e) => { if(!wrap.contains(e.target)) _notifClose(); });
  wrap.querySelector('#notifMarkAll').addEventListener('click', async (e) => {
    e.stopPropagation();
    try{ await apiRequest('/notifications/read-all',{method:'POST'}); }catch(_){ }
    _notifRefreshCount(); _notifLoadList();
  });

  _notifRefreshCount();
  if(_notifPollTimer) clearInterval(_notifPollTimer);
  _notifPollTimer = setInterval(_notifRefreshCount, 60000);
}

function _notifOpen(){ const p=document.getElementById('notifPanel'); if(p){ p.classList.add('open'); _notifLoadList(); } }
function _notifClose(){ const p=document.getElementById('notifPanel'); if(p) p.classList.remove('open'); }

async function _notifRefreshCount(){
  try{
    const r = await apiRequest('/notifications/unread-count');
    const b = document.getElementById('notifBadge');
    if(!b || !r) return;
    const n = r.count||0;
    b.textContent = n>99?'99+':n;
    b.classList.toggle('show', n>0);
  }catch(_){ }
}

async function _notifLoadList(){
  const list = document.getElementById('notifList');
  if(!list) return;
  try{
    const r = await apiRequest('/notifications?limit=15');
    const rows = (r&&r.rows)||[];
    if(!rows.length){ list.innerHTML = '<div class="notif-empty">You\'re all caught up 🎉</div>'; return; }
    list.innerHTML = rows.map(n => `
      <a class="notif-item ${n.IsRead?'':'unread'}" data-id="${n.NotifId}" data-link="${n.DeepLink||''}">
        <span class="notif-dot"></span>
        <span class="notif-ic">${_notifIcon(n.Type)}</span>
        <span class="notif-bd">
          <p class="notif-ti">${_esc(n.Title)}</p>
          ${n.Body?`<p class="notif-tx">${_esc(n.Body)}</p>`:''}
          <div class="notif-tm">${_timeAgo(n.CreatedAt)}</div>
        </span>
      </a>`).join('');
    list.querySelectorAll('.notif-item').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.id, link = el.dataset.link;
      try{ await apiRequest('/notifications/'+id+'/read',{method:'POST'}); }catch(_){ }
      _notifRefreshCount();
      if(link) window.location.href = link;
    }));
  }catch(_){ list.innerHTML = '<div class="notif-empty">Couldn\'t load notifications</div>'; }
}
function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ══════════════════════════════════════════════════════════════════════════
// Native push (FCM) — registers the device token on the installed mobile app.
// No-op in a browser and on app builds that don't yet bundle the Push plugin,
// so it is safe to ship before the APK rebuild. Activates automatically once
// @capacitor/push-notifications is compiled in.
// ══════════════════════════════════════════════════════════════════════════
let _pushInitDone = false;
async function initPushNotifications(){
  if(_pushInitDone) return; _pushInitDone = true;
  const Cap = window.Capacitor;
  if(!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;   // browser → native push only
  const Push = Cap.Plugins && Cap.Plugins.PushNotifications;
  if(!Push) return;                                                       // plugin not in this build yet
  try{
    let perm = await Push.checkPermissions();
    if(perm.receive !== 'granted') perm = await Push.requestPermissions();
    if(perm.receive !== 'granted') return;
    // Android 8+ needs the channel our FCM sender targets (channelId 'companya_one_default').
    try{ if(Push.createChannel) await Push.createChannel({ id:'companya_one_default', name:'ONE App', description:'ONE App alerts', importance:5, visibility:1 }); }catch(_){ }
    Push.addListener('registration', (token) => {
      const platform = (Cap.getPlatform && Cap.getPlatform()) || 'android';
      apiRequest('/notifications/register-token', { method:'POST', body:{ token: token.value, platform } }).catch(()=>{});
    });
    Push.addListener('registrationError', (e) => console.warn('[push] registration error', e));
    // Foreground push → refresh the bell badge immediately.
    Push.addListener('pushNotificationReceived', () => { if(typeof _notifRefreshCount==='function') _notifRefreshCount(); });
    // Tap on a (background) push → deep-link to the relevant page.
    Push.addListener('pushNotificationActionPerformed', (action) => {
      const dl = action && action.notification && action.notification.data && action.notification.data.deepLink;
      if(dl) window.location.href = dl;
    });
    await Push.register();
  }catch(e){ console.warn('[push] init failed', e && e.message); }
}

// ── Sidebar — driven by shared/modules.js registry ──────────────────────
function renderSidebar(activePage) {
  const user    = getUser();
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || !user) return;

  const company  = getCompany();
  const userRole = (user.role || '').toLowerCase();
  const visible  = (window.ONEAPP_getVisibleModules || (() => []))(user, company);

  // Substitute {userId} in hrefs so we can have "My Profile" point at the
  // logged-in user's own page without inventing a separate backend route.
  const resolveHref = (raw) => String(raw || '').replace('{userId}', user && user.id != null ? user.id : '');

  // Collapsible sidebar sections (2026-06-17). Sidebar got long once Lens shipped
  // (30+ items for admin). Section headers are now clickable to collapse/expand.
  // Default state on first load: only the section containing the active page
  // is open. Choice persists in localStorage so reps keep their preferred view.
  const STORAGE_KEY = 'companya_sidebar_expanded_v1';
  let savedExpanded = {};
  try { savedExpanded = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
  catch (_) { savedExpanded = {}; }
  // Find the section containing the active page (for the default-open logic)
  const activeSectionKey = (visible.find(s => s.items.some(i => i.key === activePage)) || {}).dept;

  const sectionsHTML = visible.map(section => {
    const key = section.dept || section.label;
    // If user has explicitly toggled this section, use that choice;
    // else default-open only the section containing the active page.
    const isExpanded = (key in savedExpanded) ? !!savedExpanded[key] : (key === activeSectionKey);
    const items = section.items.map(item => `
      <a class="nav-item ${activePage === item.key ? 'active' : ''}" href="${resolveHref(item.href)}">${item.label}</a>
    `).join('');
    return `
      <div class="nav-section ${isExpanded ? 'expanded' : 'collapsed'}" data-dept="${key}">
        <div class="nav-section-label nav-section-toggle" data-dept="${key}">
          <span class="nav-section-chevron">${isExpanded ? '▾' : '▸'}</span>
          <span>${section.label}</span>
          <span class="nav-section-count">${section.items.length}</span>
        </div>
        <div class="nav-section-items">${items}</div>
      </div>
    `;
  }).join('');

  // Product + FAE are locked to a single company (COMPANYA) — the "Switch Company"
  // picker is meaningless for them, so drop it from their sidebar.
  const roleLc = (user && user.role || '').toLowerCase().trim();
  const singleCompanyRole = /\bfae\b/.test(roleLc) || /\bproduct\b/.test(roleLc);
  const accountItems = (window.ONEAPP_ACCOUNT_ITEMS || [])
    .filter(item => !(item.key === 'switch-company' && singleCompanyRole))
    .map(item => `
    <a class="nav-item" href="${resolveHref(item.href)}">${item.label}</a>
  `).join('');

  sidebar.innerHTML = `
    <div class="sidebar">
      <div class="sidebar-logo">
        <div class="logo-mark">
          <div class="logo-icon">1</div>
          <div>
            <div class="logo-text">ONE App</div>
            <div class="logo-sub">${company}</div>
          </div>
        </div>
      </div>

      <nav class="sidebar-nav">
        ${sectionsHTML}
        <div class="nav-section-label nav-section-label-static" style="margin-top:12px;">Account</div>
        ${accountItems}
      </nav>

      <div class="sidebar-footer">
        <div class="user-card">
          <div class="avatar">${(user.name || 'US').slice(0, 2).toUpperCase()}</div>
          <div>
            <div class="user-name">${user.name || 'User'}</div>
            <div class="user-role">${userRole}</div>
          </div>
          <button class="logout-btn" onclick="logout()" title="Logout">⎋</button>
        </div>
      </div>
    </div>
  `;

  // Wire collapse/expand toggles. Click the header (or chevron) to toggle.
  sidebar.querySelectorAll('.nav-section-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const key = toggle.dataset.dept;
      const section = toggle.closest('.nav-section');
      const isExpanded = section.classList.toggle('expanded');
      section.classList.toggle('collapsed', !isExpanded);
      const chev = toggle.querySelector('.nav-section-chevron');
      if (chev) chev.textContent = isExpanded ? '▾' : '▸';
      // Persist
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
        saved[key] = isExpanded;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      } catch (_) { /* localStorage disabled — silently skip */ }
    });
  });

  _initMobileMenu();
}

// ── Mobile hamburger menu ───────────────────────────────────────────────
function _initMobileMenu() {
  if (document.getElementById('mobMenuBtn')) return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  var btn = document.createElement('button');
  btn.id = 'mobMenuBtn';
  btn.className = 'mob-btn';
  btn.setAttribute('aria-label', 'Toggle menu');
  btn.innerHTML = '☰';
  document.body.appendChild(btn);

  var overlay = document.createElement('div');
  overlay.id = 'mobOverlay';
  overlay.className = 'mob-overlay';
  document.body.appendChild(overlay);

  function openMenu()  { sidebar.classList.add('open');    overlay.classList.add('show');    btn.innerHTML = '✕'; }
  function closeMenu() { sidebar.classList.remove('open'); overlay.classList.remove('show'); btn.innerHTML = '☰'; }

  btn.addEventListener('click', () => sidebar.classList.contains('open') ? closeMenu() : openMenu());
  overlay.addEventListener('click', closeMenu);
  sidebar.querySelectorAll('.nav-item').forEach(link => link.addEventListener('click', closeMenu));
}
