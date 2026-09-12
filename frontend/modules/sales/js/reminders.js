const rlUser = requireAuth();
if (rlUser) {
  renderSidebar('ReminderLog');
  setRoleTag();
}

const fullAccessRoles = ['admin', 'operation head', 'director'];
const isAdminLike = rlUser && fullAccessRoles.includes((rlUser.role || '').toLowerCase());

if (isAdminLike) {
  document.getElementById('runEmailBtn').style.display = 'inline-block';
  document.getElementById('runWaBtn').style.display = 'inline-block';
}

// ─── Auto-lock to current company from sidebar selection ──────────────────
// sessionStorage 'nav_company' = 'COMPANYA' or 'CompanyB' (set by select-company.html)
const currentCompany = (sessionStorage.getItem('nav_company') || 'COMPANYA').toUpperCase();
document.getElementById('companyFilter').value = currentCompany === 'COMPANYB' ? 'COMPANYB' : 'COMPANYA';

// Update page title to reflect current company
const pageTitleEl = document.querySelector('.page-title');
if (pageTitleEl) {
  pageTitleEl.textContent = `${currentCompany === 'COMPANYB' ? 'CompanyB' : 'COMPANYA'} — Payment Reminders`;
}

let rlPage = 1;
let rlLimit = 25;
let rlTimer;
// Monotonic load counter — a response only renders if it's still the LATEST
// load. Prevents a slow /log response from painting the reminder table (and
// its pagination) over the Payment Advice view after a channel switch.
let rlLoadSeq = 0;

document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(rlTimer);
  rlTimer = setTimeout(() => { rlPage = 1; loadLog(); }, 400);
});
['channelFilter','stageFilter','fromDate','toDate'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { rlPage = 1; loadLog(); });
});
document.getElementById('refreshBtn').addEventListener('click', () => loadLog());
document.getElementById('runEmailBtn').addEventListener('click', () => runNow('EMAIL'));
document.getElementById('runWaBtn').addEventListener('click', () => runNow('WHATSAPP'));

loadStats();
loadLog();

async function loadStats() {
  try {
    // company is auto-attached by apiRequest from sessionStorage — don't duplicate it here
    const s = await apiRequest('/sales/reminders/stats');
    const cards = document.getElementById('statsCards');
    cards.innerHTML = `
      <div class="card" style="border-top:2px solid var(--accent);">
        <div class="card-title">Total Sent</div>
        <div class="card-value" style="color:var(--accent)">${fmt(s.TotalSent || 0)}</div>
        <div style="font-size:11px; color:var(--text3); margin-top:4px;">Today: ${fmt(s.SentToday || 0)}</div>
      </div>
      <div class="card" style="border-top:2px solid var(--green);">
        <div class="card-title">Email Sent</div>
        <div class="card-value" style="color:var(--green)">${fmt(s.EmailCount != null ? s.EmailCount : (s.Successful || 0))}</div>
        <div style="font-size:11px; color:var(--text3); margin-top:4px;">Failed: ${fmt(s.Failed || 0)}</div>
      </div>
      <div class="card" style="border-top:2px solid var(--teal);">
        <div class="card-title">WhatsApp Sent</div>
        <div class="card-value" style="color:var(--teal)">${fmt(s.WhatsAppCount || 0)}</div>
        <div style="font-size:11px; color:var(--text3); margin-top:4px;">via Meta Cloud API</div>
      </div>
      <div class="card" style="border-top:2px solid var(--purple);">
        <div class="card-title">Manual Sent</div>
        <div class="card-value" style="color:var(--purple)">${fmt(s.ManualCount || 0)}</div>
      </div>
      <div class="card" style="border-top:2px solid #25D366;">
        <div class="card-title">Payment Advice</div>
        <div class="card-value" style="color:#25D366">${fmt(s.PaymentAdviceCount || 0)}</div>
        <div style="font-size:11px; color:var(--text3); margin-top:4px;">Today: ${fmt(s.PaymentAdviceToday || 0)} · WhatsApp + PDF${s.PaymentAdviceFailed ? ` · <span style="color:var(--red);">Failed: ${fmt(s.PaymentAdviceFailed)}</span>` : ''}</div>
      </div>
    `;
  } catch (err) {
    // ignore
  }
}

async function loadLog() {
  const seq = ++rlLoadSeq;
  const loading = document.getElementById('loadingDiv');
  const table   = document.getElementById('reminderTable');
  const paTable = document.getElementById('paTable');
  const empty   = document.getElementById('emptyDiv');

  // Channel = Payment Advice → different table (BN_PaymentAdvice) with its
  // own columns; stages don't apply there, so the stage filter is disabled.
  const channelVal = document.getElementById('channelFilter')?.value || '';
  const isPa = channelVal === 'PAYMENT_ADVICE';
  document.getElementById('stageFilter').disabled = isPa;

  loading.style.display = 'flex';
  table.style.display   = 'none';
  paTable.style.display = 'none';
  empty.style.display   = 'none';

  if (isPa) return loadPaLog(seq);

  // company is auto-attached by apiRequest from sessionStorage — don't include it here
  // (sending it twice makes Express treat req.query.company as an array and mssql rejects it)
  const params = new URLSearchParams({
    page: rlPage, limit: rlLimit,
    search:   document.getElementById('searchInput').value.trim(),
    channel:  document.getElementById('channelFilter')?.value || '',
    stage:    document.getElementById('stageFilter').value,
    fromDate: document.getElementById('fromDate').value,
    toDate:   document.getElementById('toDate').value,
  });

  try {
    const res  = await apiRequest(`/sales/reminders/log?${params}`);
    if (seq !== rlLoadSeq) return;   // superseded by a newer load — drop it
    const rows = res.data || [];
    const total = res.total || 0;

    if (!rows.length) {
      empty.style.display = 'block';
      // Reset in case the PA view changed it earlier
      document.querySelector('#emptyDiv .empty-text').textContent =
        'No reminders found for the selected filters';
    } else {
      table.style.display = 'table';
      renderRows(rows);
    }
    renderPagination(total);
  } catch (err) {
    if (seq !== rlLoadSeq) return;
    empty.style.display = 'block';
    document.querySelector('#emptyDiv .empty-text').textContent =
      'Could not load reminders — check your connection and refresh';
    renderPagination(0);
  } finally {
    if (seq === rlLoadSeq) loading.style.display = 'none';
  }
}

function renderRows(rows) {
  const tbody = document.getElementById('reminderBody');
  tbody.innerHTML = rows.map(r => `
    <tr style="cursor:pointer;" onclick='showDetail(${JSON.stringify(r).replace(/'/g,"&#39;")})'>
      <td class="td-mono" style="font-size:12px; white-space:nowrap;">${fmtDateTime(r.SentAt)}</td>
      <td><span class="badge ${r.CompanyCode==='COMPANYA'?'badge-teal':'badge-purple'}">${r.CompanyCode}</span></td>
      <td>
        <div class="td-bold">${escapeHtml(r.CustomerName || r.CustomerNo)}</div>
        <div style="font-size:11px; color:var(--text3); font-family:var(--mono);">${r.CustomerNo || ''}</div>
      </td>
      <td>
        <div class="td-mono">${r.InvoiceNo || ''}</div>
        ${r.ExtInvoiceNo ? `<div style="font-size:11px; color:var(--text3); font-family:var(--mono);">${r.ExtInvoiceNo}</div>` : ''}
      </td>
      <td style="color:${r.OverdueDays > 0 ? 'var(--red)' : 'var(--text2)'};">${fmtDate(r.DueDate)}</td>
      <td style="text-align:right;" class="td-mono">${fmtCur(r.Amount)}</td>
      <td>${stageBadge(r.ReminderStage)}</td>
      <td>${channelBadge(r.Channel)}</td>
      <td class="td-mono">${r.ReminderNumber || 1}</td>
      <td>${escapeHtml(r.SalespersonName || '—')}</td>
      <td style="font-size:11px; max-width:220px;">
        ${r.Channel === 'WHATSAPP'
          ? `<div style="color:var(--text2);" class="td-mono">📱 ${escapeHtml(r.WhatsAppPhoneTo || '—')}</div>
             ${recipientKindBadge(r.RecipientKind, r)}`
          : `<div style="color:var(--text2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px;" title="${escAttr(r.EmailTo || '')}">${escapeHtml(r.EmailTo || '')}</div>
             ${r.EmailCc ? `<div style="color:var(--text3); font-size:10px;" title="${escAttr(r.EmailCc)}">CC: ${ccBadge(r.EmailCc)}</div>` : ''}`}
      </td>
      <td style="font-size:12px;">
        ${escapeHtml(r.SentByUserName || 'SYSTEM')}
        ${r.IsManual ? '<span class="badge badge-amber" style="margin-left:4px;">MANUAL</span>' : ''}
      </td>
      <td>${statusBadge(r.Status, r.ErrorMessage)}</td>
    </tr>
  `).join('');
}

function channelBadge(c) {
  if (c === 'WHATSAPP') return `<span class="badge badge-green" title="WhatsApp">WA</span>`;
  return `<span class="badge badge-blue" title="Email">✉</span>`;
}

// ─── Payment Advice log (v1.8) ─────────────────────────────────────────────
// Fired from loadLog() when the Channel dropdown = "Payment Advice".
// Reads BN_PaymentAdvice via /sales/reminders/payment-advice-log.
async function loadPaLog(seq) {
  const loading = document.getElementById('loadingDiv');
  const paTable = document.getElementById('paTable');
  const empty   = document.getElementById('emptyDiv');

  const search   = document.getElementById('searchInput').value.trim();
  const fromDate = document.getElementById('fromDate').value;
  const toDate   = document.getElementById('toDate').value;
  const params = new URLSearchParams({
    page: rlPage, limit: rlLimit, search, fromDate, toDate,
  });

  try {
    const res  = await apiRequest(`/sales/reminders/payment-advice-log?${params}`);
    if (seq !== rlLoadSeq) return;   // superseded by a newer load — drop it
    const rows = (res && res.data) || [];
    const total = (res && res.total) || 0;

    if (!rows.length) {
      empty.style.display = 'block';
      document.querySelector('#emptyDiv .empty-text').textContent =
        (search || fromDate || toDate)
          ? 'No payment advices found for the selected filters'
          : 'No payment advices yet — they appear here once the daily 9 AM pass (or a manual cron run) sends them';
    } else {
      paTable.style.display = 'table';
      renderPaRows(rows);
    }
    renderPagination(total);
  } catch (err) {
    if (seq !== rlLoadSeq) return;
    empty.style.display = 'block';
    document.querySelector('#emptyDiv .empty-text').textContent =
      'Could not load payment advices — check your connection and refresh';
    renderPagination(0);
  } finally {
    if (seq === rlLoadSeq) loading.style.display = 'none';
  }
}

function renderPaRows(rows) {
  const tbody = document.getElementById('paBody');
  tbody.innerHTML = rows.map(r => `
    <tr style="cursor:pointer;" onclick='showPaDetail(${JSON.stringify(r).replace(/'/g,"&#39;")})'>
      <td class="td-mono" style="font-size:12px; white-space:nowrap;">${fmtDateTime(r.CreatedAt)}</td>
      <td><span class="badge ${r.Company==='COMPANYA'?'badge-teal':'badge-purple'}">${escapeHtml(r.Company)}</span></td>
      <td>
        <div class="td-bold">${escapeHtml(r.CustomerName || r.CustomerCode)}</div>
        <div style="font-size:11px; color:var(--text3); font-family:var(--mono);">${escapeHtml(r.CustomerCode || '')}</div>
      </td>
      <td>
        <div class="td-mono">${escapeHtml(r.PaymentDocNo || '')}</div>
        ${r.Reference ? `<div style="font-size:11px; color:var(--text3);">${escapeHtml(r.Reference)}</div>` : ''}
      </td>
      <td style="white-space:nowrap;">${fmtDate(r.PaymentDate)}</td>
      <td style="text-align:right;" class="td-mono">${fmtCur(r.Amount)}</td>
      <td>${paModeBadge(r.PaymentMode)}</td>
      <td class="td-mono" style="font-size:12px;">${escapeHtml(r.WhatsAppPhoneTo || '—')}</td>
      <td>${paStatusBadge(r.Status, r.WhatsAppError)}</td>
      <td onclick="event.stopPropagation();">
        <a href="javascript:void(0)" onclick="downloadPaymentAdvicePdf('${escAttr(r.PaymentDocNo)}')"
           title="Download Payment Advice PDF"
           style="text-decoration:none;color:#16a34a;font-size:18px;">📄</a>
      </td>
    </tr>
  `).join('');
}

function paModeBadge(mode) {
  const m = String(mode || '').toLowerCase();
  if (m === 'cheque')        return `<span class="badge badge-amber">Cheque</span>`;
  if (m === 'cash')          return `<span class="badge badge-purple">Cash</span>`;
  if (m === 'bank transfer') return `<span class="badge badge-teal">Bank Transfer</span>`;
  return `<span class="badge badge-blue">${escapeHtml(mode || '—')}</span>`;
}

function paStatusBadge(s, err) {
  const v = String(s || '').toLowerCase();
  if (v === 'sent')      return `<span class="badge badge-green">SENT</span>`;
  if (v === 'skipped')   return `<span class="badge badge-amber" title="${escAttr(err || 'Skipped — usually no phone number in NAV')}">SKIPPED</span>`;
  if (v === 'failed')    return `<span class="badge badge-red"   title="${escAttr(err || '')}">FAILED</span>`;
  if (v === 'test_mode') return `<span class="badge badge-blue"  title="${escAttr(err || 'TEST MODE — no Meta call was made')}">TEST</span>`;
  return `<span class="badge badge-blue">${escapeHtml(s || '—')}</span>`;
}

function showPaDetail(r) {
  document.querySelector('#detailModal h3').textContent = 'Payment Advice Details';
  let applied = [];
  try { applied = JSON.parse(r.AppliedInvoicesJson || '[]'); } catch (e) { applied = []; }
  const appliedHtml = applied.length
    ? `<table style="width:100%; font-size:12px; margin-top:6px;">
         <thead><tr style="color:var(--text3); text-align:left;">
           <th>Invoice</th><th>Order Ref</th><th style="text-align:right;">Applied</th>
         </tr></thead>
         <tbody>${applied.map(a => `
           <tr>
             <td class="td-mono">${escapeHtml(a.InvoiceNo || '—')}</td>
             <td class="td-mono" style="color:var(--text3);">${escapeHtml(a.OrderRef || '')}</td>
             <td class="td-mono" style="text-align:right;">${fmtCur(a.AppliedAmount != null ? a.AppliedAmount : a.Amount)}</td>
           </tr>`).join('')}
         </tbody></table>`
    : `<div style="color:var(--text3); font-size:12px; margin-top:4px;">No applied-invoice breakdown (on-account payment)</div>`;

  const body = document.getElementById('detailBody');
  body.innerHTML = `
    <div class="rl-detail-grid">
      <div><span class="rl-label">Company</span><span>${escapeHtml(r.Company || '')}</span></div>
      <div><span class="rl-label">Status</span><span>${paStatusBadge(r.Status, r.WhatsAppError)}</span></div>
      <div><span class="rl-label">Customer</span><span>${escapeHtml(r.CustomerName || '')} (${escapeHtml(r.CustomerCode || '')})</span></div>
      <div><span class="rl-label">Payment Doc</span><span class="td-mono">${escapeHtml(r.PaymentDocNo || '')}</span></div>
      <div><span class="rl-label">Payment Date</span><span>${fmtDate(r.PaymentDate)}</span></div>
      <div><span class="rl-label">Amount</span><span>${fmtCur(r.Amount)}</span></div>
      <div><span class="rl-label">Mode</span><span>${paModeBadge(r.PaymentMode)} ${r.Reference ? '<span class="td-mono" style="font-size:11px;">' + escapeHtml(r.Reference) + '</span>' : ''}</span></div>
      <div><span class="rl-label">Bank</span><span>${escapeHtml(r.BankName || '—')}</span></div>
      <div><span class="rl-label">Phone</span><span class="td-mono">${escapeHtml(r.WhatsAppPhoneTo || '—')}</span></div>
      <div><span class="rl-label">Sent At</span><span>${fmtDateTime(r.WhatsAppSentAt || r.CreatedAt)}</span></div>
    </div>
    <hr style="border:none; border-top:1px solid var(--border); margin:14px 0;" />
    <div class="rl-mail">
      <div><strong>Applied to invoices:</strong></div>
      ${appliedHtml}
      <div style="margin-top:10px;"><strong>wamid:</strong> <span class="td-mono" style="font-size:11px;">${escapeHtml(r.WhatsAppMessageId || '—')}</span></div>
    </div>
    ${r.WhatsAppError && String(r.Status).toLowerCase() === 'failed'
      ? `<div class="rl-error"><strong>Error:</strong> ${escapeHtml(r.WhatsAppError)}</div>` : ''}
  `;
  document.getElementById('detailModal').style.display = 'flex';
}

// Translate the raw recipient-kind string (set by reminderCron.js, parsed out
// of BN_ReminderLog.Body by the /log route) into a human-readable badge so
// the Reminder Log table tells you whether each row hit the customer or a
// specific person on the internal CC chain.
//   CUSTOMER / CUSTOMER_OVERRIDE  → green  "Customer"
//   SALESPERSON                   → blue   "Salesperson"
//   ROLE_CC:SALES_HEAD_ELECTRICAL → purple "Sales Head"
//   ROLE_CC:ELECTRICAL_HEAD       → teal   "Electrical Head"
//   USER_CC                       → amber  "Admin"
//   anything else                  → grey   the raw kind
function recipientKindBadge(kind, row) {
  if (!kind) return '';
  const k = String(kind).trim().toUpperCase();
  let cls, label;
  if (k === 'CUSTOMER' || k === 'CUSTOMER_OVERRIDE') {
    cls = 'badge-green';   label = 'Customer';
  } else if (k === 'SALESPERSON') {
    cls = 'badge-blue';    label = 'Salesperson';
  } else if (k === 'ROLE_CC:SALES_HEAD_ELECTRICAL' || k === 'ROLE_CC:SALES_HEAD') {
    cls = 'badge-purple';  label = 'Sales Head';
  } else if (k === 'ROLE_CC:ELECTRICAL_HEAD' || k === 'ROLE_CC:NORTH_SALES_HEAD') {
    cls = 'badge-teal';    label = k === 'ROLE_CC:NORTH_SALES_HEAD' ? 'North Sales Head' : 'Electrical Head';
  } else if (k === 'USER_CC') {
    cls = 'badge-amber';   label = 'Admin';
  } else if (k.startsWith('ROLE_CC:')) {
    cls = 'badge-purple';  label = k.slice(8).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  } else {
    cls = 'badge-blue';    label = k;
  }
  // Surface the salesperson/customer name in the tooltip when relevant
  let tip = label;
  if (k === 'SALESPERSON' && row && row.SalespersonName) tip = `Salesperson: ${row.SalespersonName}`;
  if ((k === 'CUSTOMER' || k === 'CUSTOMER_OVERRIDE') && row && row.CustomerName) tip = `Customer: ${row.CustomerName}`;
  return `<div style="margin-top:2px;"><span class="badge ${cls}" title="${escAttr(tip)}">${label}</span></div>`;
}

function renderPagination(total) {
  const pag = document.getElementById('pagination');
  const totalPages = Math.ceil(total / rlLimit);
  if (totalPages <= 1) { pag.innerHTML = ''; return; }

  let html = `<span class="page-info">${fmt(total)} records</span>`;
  html += `<button class="page-btn" onclick="changeRlPage(${Math.max(1, rlPage-1)})">&lt;</button>`;
  for (let i=1; i<=totalPages; i++) {
    if (i >= rlPage-2 && i <= rlPage+2) {
      html += `<button class="page-btn ${i===rlPage?'active':''}" onclick="changeRlPage(${i})">${i}</button>`;
    }
  }
  html += `<button class="page-btn" onclick="changeRlPage(${Math.min(totalPages, rlPage+1)})">&gt;</button>`;
  pag.innerHTML = html;
}
function changeRlPage(p) { rlPage = p; loadLog(); }

function stageBadge(s) {
  const map = {
    'PRE_DUE':   ['badge-blue',   'Pre-Due'],
    'DUE_DAY':   ['badge-amber',  'Due Day'],
    'OVERDUE':   ['badge-red',    'Overdue'],
    'FOLLOW_UP': ['badge-purple', 'Follow-Up'],
  };
  const [cls, label] = map[s] || ['badge-blue', s || '—'];
  return `<span class="badge ${cls}">${label}</span>`;
}
function statusBadge(s, err) {
  if (s === 'SENT')    return `<span class="badge badge-green">SENT</span>`;
  if (s === 'SKIPPED') return `<span class="badge badge-amber" title="${escapeHtml(err || 'TEST_MODE — no Meta call was made')}">SKIPPED</span>`;
  if (s === 'FAILED')  return `<span class="badge badge-red"   title="${escapeHtml(err || '')}">FAILED</span>`;
  return `<span class="badge badge-blue">${s || '—'}</span>`;
}
function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleString('en-IN', { day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escAttr(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}
// Compact CC display: show first address + "(+N more)" — full list lives in the title tooltip
function ccBadge(cc) {
  if (!cc) return '';
  const list = String(cc).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return escapeHtml(list[0]);
  const more = list.length - 1;
  return `${escapeHtml(list[0])} <span style="opacity:.7;">(+${more} more)</span>`;
}

function showDetail(r) {
  document.querySelector('#detailModal h3').textContent = 'Reminder Details';
  const body = document.getElementById('detailBody');
  body.innerHTML = `
    <div class="rl-detail-grid">
      <div><span class="rl-label">Company</span><span>${r.CompanyCode}</span></div>
      <div><span class="rl-label">Stage</span><span>${stageBadge(r.ReminderStage)}</span></div>
      <div><span class="rl-label">Customer</span><span>${escapeHtml(r.CustomerName)} (${r.CustomerNo})</span></div>
      <div><span class="rl-label">Invoice</span><span>${r.InvoiceNo}${r.ExtInvoiceNo ? ' / ' + r.ExtInvoiceNo : ''}</span></div>
      <div><span class="rl-label">Posting Date</span><span>${fmtDate(r.PostingDate)}</span></div>
      <div><span class="rl-label">Due Date</span><span>${fmtDate(r.DueDate)}</span></div>
      <div><span class="rl-label">Amount</span><span>${fmtCur(r.Amount)}</span></div>
      <div><span class="rl-label">Overdue Days</span><span>${r.OverdueDays || 0}</span></div>
      <div><span class="rl-label">Salesperson</span><span>${escapeHtml(r.SalespersonName || '—')}</span></div>
      <div><span class="rl-label">Sent At</span><span>${fmtDateTime(r.SentAt)}</span></div>
      <div><span class="rl-label">Sent By</span><span>${escapeHtml(r.SentByUserName)} ${r.IsManual ? '(manual)' : '(auto)'}</span></div>
      <div><span class="rl-label">Status</span><span>${statusBadge(r.Status, r.ErrorMessage)}</span></div>
    </div>
    <hr style="border:none; border-top:1px solid var(--border); margin:14px 0;" />
    <div class="rl-mail">
      ${r.Channel === 'WHATSAPP'
        ? `<div><strong>Channel:</strong> ${channelBadge('WHATSAPP')}</div>
           <div style="margin-top:6px;"><strong>Phone:</strong> <span class="td-mono">${escapeHtml(r.WhatsAppPhoneTo || '—')}</span></div>
           <div style="margin-top:6px;"><strong>Recipient:</strong> ${recipientKindBadge(r.RecipientKind, r) || '<span style="color:var(--text3);">unknown</span>'}</div>
           <div style="margin-top:6px;"><strong>wamid:</strong> <span class="td-mono" style="font-size:11px;">${escapeHtml(r.WhatsAppMessageId || '—')}</span></div>`
        : `<div><strong>To:</strong> ${escapeHtml(r.EmailTo)}</div>
           ${r.EmailCc ? `<div><strong>CC:</strong> ${escapeHtml(r.EmailCc)}</div>` : ''}
           <div><strong>From:</strong> ${escapeHtml(r.EmailFrom || '—')}</div>`}
      <div style="margin-top:10px;"><strong>Subject:</strong> ${escapeHtml(r.Subject || '')}</div>
    </div>
    ${r.ErrorMessage ? `<div class="rl-error"><strong>Error:</strong> ${escapeHtml(r.ErrorMessage)}</div>` : ''}
  `;
  document.getElementById('detailModal').style.display = 'flex';
}
function closeDetail() {
  document.getElementById('detailModal').style.display = 'none';
}

async function runNow(channel) {
  const isWA       = channel === 'WHATSAPP';
  const btn        = document.getElementById(isWA ? 'runWaBtn'    : 'runEmailBtn');
  const otherBtn   = document.getElementById(isWA ? 'runEmailBtn' : 'runWaBtn');
  const baseLabel  = isWA ? '⌬ Run WhatsApp Cron' : '✉ Run Email Cron';
  const startLabel = isWA ? 'Starting WhatsApp…'  : 'Starting Email…';
  const runLabel   = isWA ? '⏳ WA running…'       : '⏳ Email running…';
  const confirmMsg = isWA
    ? 'Start the WhatsApp reminder cron?\n\nReal Meta WhatsApp messages will be sent to matching customers (RETAILER/DCGBPL/CG-BPL/RRK/PANC patterns) plus 3 CC copies each (Admin / Electrical Head / Salesperson).\nUses customer phones from NAV — make sure these are correct before continuing.'
    : 'Start the Email reminder cron?\n\nIt will run in the background. Due to Gmail SMTP rate limits, ~25 mails/min.\nCheck this page in a few minutes to see the log grow.';
  if (!confirm(confirmMsg)) return;

  // Concurrency: backend allows only one runDaily at a time, so lock both buttons.
  btn.disabled = true; otherBtn.disabled = true;
  btn.textContent = startLabel;

  try {
    const r = await apiRequest('/sales/reminders/run-now', {
      method: 'POST',
      body: { company: currentCompany, channel }
    });
    alert(r.message || 'Cron started. Check back in a few minutes.');
    btn.textContent = runLabel;
    // Poll every 10s to refresh the log + re-enable buttons when finished
    const pollId = setInterval(async () => {
      try {
        const st = await apiRequest('/sales/reminders/run-status');
        loadStats();
        loadLog();
        if (!st.running) {
          clearInterval(pollId);
          btn.disabled = false; otherBtn.disabled = false;
          btn.textContent = baseLabel;
        }
      } catch (e) { /* ignore */ }
    }, 10000);
  } catch (err) {
    alert('Run failed: ' + (err.message || err));
    btn.disabled = false; otherBtn.disabled = false;
    btn.textContent = baseLabel;
  }
}
