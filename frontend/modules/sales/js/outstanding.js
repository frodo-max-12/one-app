const outstandingUser = requireAuth();
if (outstandingUser) {
  renderSidebar('outstanding');
  setRoleTag();
}

let outstandingPage = 1;
let outstandingSearch = '';
let outstandingAging = 'all';
const outstandingLimit = 15;
let outstandingSearchTimer;

document.getElementById('searchInput').addEventListener('input', function (e) {
  outstandingSearch = e.target.value.trim();
  clearTimeout(outstandingSearchTimer);
  outstandingSearchTimer = setTimeout(() => {
    outstandingPage = 1;
    loadOutstanding();
  }, 400);
});

document.getElementById('refreshBtn').addEventListener('click', loadOutstanding);

document.querySelectorAll('#agingTabs .filter-tab').forEach(tab => {
  tab.addEventListener('click', function () {
    document.querySelectorAll('#agingTabs .filter-tab').forEach(x => x.classList.remove('active'));
    this.classList.add('active');
    outstandingAging = this.dataset.aging;
    outstandingPage = 1;
    loadOutstanding();
  });
});

loadOutstanding();

async function loadOutstanding() {
  const loading = document.getElementById('outstandingLoading');
  const table = document.getElementById('outstandingTable');
  const empty = document.getElementById('outstandingEmpty');

  loading.style.display = 'flex';
  table.style.display = 'none';
  empty.style.display = 'none';

  try {
    const res = await apiRequest(`/sales/outstanding?${new URLSearchParams({
      search: outstandingSearch,
      aging: outstandingAging,
      page: outstandingPage,
      limit: outstandingLimit
    })}`);

    renderOutstandingSummary(res.summary || {}, res.symbol || (res.currency === 'USD' ? '$' : '₹'));
    renderOutstandingRows(res.data || [], (res.company || 'COMPANYA').toUpperCase());
    renderOutstandingPagination(res.summary || {});
  } catch (err) {
    empty.style.display = 'block';
  } finally {
    loading.style.display = 'none';
  }
}

function renderOutstandingSummary(summary, sym) {
  const s = sym || (getCompany() === 'COMPANYB' ? '$' : '₹');
  const cards = document.getElementById('summaryCards');
  cards.innerHTML = `
    <div class="card" style="border-top:2px solid var(--accent);">
      <div class="card-title">Total AR</div>
      <div class="card-value" style="color:var(--accent)">${s} ${fmt(summary.TotalOutstanding)}</div>
    </div>
    <div class="card" style="border-top:2px solid var(--green);">
      <div class="card-title">0–30 days</div>
      <div class="card-value" style="color:var(--green)">${s} ${fmt(summary.Age0_30)}</div>
    </div>
    <div class="card" style="border-top:2px solid var(--amber);">
      <div class="card-title">31–90 days</div>
      <div class="card-value" style="color:var(--amber)">${s} ${fmt((summary.Age31_60 || 0) + (summary.Age61_90 || 0))}</div>
    </div>
    <div class="card" style="border-top:2px solid var(--red);">
      <div class="card-title">90+ days (Critical)</div>
      <div class="card-value" style="color:var(--red)">${s} ${fmt(summary.Age90Plus)}</div>
    </div>
  `;
}

function renderOutstandingRows(rows, company) {
  const tbody = document.getElementById('outstandingBody');
  const table = document.getElementById('outstandingTable');
  const empty = document.getElementById('outstandingEmpty');

  if (!rows.length) {
    table.style.display = 'none';
    empty.style.display = 'block';
    tbody.innerHTML = '';
    return;
  }

  table.style.display = 'table';
  empty.style.display = 'none';

  const co = (company || getCompany() || 'COMPANYA').toUpperCase();

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>
        <div class="td-bold">${r.CustomerName || r.CustomerNo}</div>
        <div style="display:flex; gap:6px; margin-top:2px; flex-wrap:wrap;">
          <span style="font-size:11px; color:var(--text3); font-family:var(--mono);">${r.CustomerNo || ''}</span>
          ${r.GSTNo ? `<span style="font-size:10px; color:var(--teal); font-family:var(--mono);">${r.GSTNo}</span>` : ''}
          ${r.State ? `<span style="font-size:10px; color:var(--text3);">${r.State}</span>` : ''}
        </div>
      </td>
      <td>
        <div class="td-mono">${r.DocNo || ''}</div>
        ${r.ExtDocNo ? `<div style="font-size:11px; color:var(--text3); font-family:var(--mono);">${r.ExtDocNo}</div>` : ''}
      </td>
      <td>${r.Salesperson || '—'}</td>
      <td>${fmtDate(r.PostingDate)}</td>
      <td style="color:${r.OverdueDays > 0 ? 'var(--red)' : 'var(--text2)'};">${fmtDate(r.DueDate)}</td>
      <td style="text-align:right;" class="td-mono">${fmtCur(r.OriginalAmount)}</td>
      <td style="text-align:right; font-weight:600; color:var(--text);" class="td-mono">${fmtCur(r.RemainingAmount)}</td>
      <td>${agingBadge(r.OverdueDays)}</td>
      <td style="text-align:center; white-space:nowrap;">
        <button class="btn btn-ghost btn-sm"
                title="Send payment reminder email${r.CustomerEmail ? ' to ' + escAttr(r.CustomerEmail) : ' (no customer email on card)'}"
                ${r.CustomerEmail ? '' : 'disabled style="opacity:.45;"'}
                onclick="sendReminder('${co}', '${(r.DocNo||'').replace(/'/g,"\\'")}', 'EMAIL', this)">
          ✉ Email
        </button>
        <button class="btn btn-ghost btn-sm"
                title="Send WhatsApp reminder${r.CustomerPhone ? ' to ' + escAttr(r.CustomerPhone) : ' (no phone on customer card)'}"
                style="margin-left:4px; color:#25D366;${r.CustomerPhone ? '' : 'opacity:.45;'}"
                ${r.CustomerPhone ? '' : 'disabled'}
                onclick="sendReminder('${co}', '${(r.DocNo||'').replace(/'/g,"\\'")}', 'WHATSAPP', this)">
          <span style="font-weight:700;">⌬</span> WA
        </button>
      </td>
    </tr>
  `).join('');
}

async function sendReminder(company, invoiceNo, channel, btn) {
  // Backward-compat: old call sites passed (company, invoiceNo, btn) — detect & shift
  if (channel && typeof channel === 'object' && channel.tagName) {
    btn = channel;
    channel = 'EMAIL';
  }
  channel = (channel || 'EMAIL').toUpperCase();
  if (!invoiceNo) return;

  const channelLabel = channel === 'WHATSAPP' ? 'WhatsApp message' : 'reminder email';
  const testNote = channel === 'WHATSAPP'
    ? '(In TEST MODE the WA message is logged but NOT sent to Meta API)'
    : '(In TEST MODE all mails go to the test email configured in .env)';
  if (!confirm(`Send ${channelLabel} for invoice ${invoiceNo}?\n\n${testNote}`)) return;

  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const r = await apiRequest('/sales/reminders/send-manual', {
      method: 'POST',
      body: { company, invoiceNo, channel },
    });
    btn.textContent = '✓ Sent';
    setTimeout(() => { btn.disabled = false; btn.innerHTML = originalHTML; }, 2500);
  } catch (err) {
    btn.textContent = '✗ Failed';
    alert(`Failed to send ${channelLabel}:\n` + (err.message || err));
    setTimeout(() => { btn.disabled = false; btn.innerHTML = originalHTML; }, 2500);
  }
}

// Escape a value so it's safe to embed inside an HTML attribute (title="…")
function escAttr(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderOutstandingPagination(summary) {
  const pagination = document.getElementById('pagination');
  const totalRecords = summary.TotalRecords || 0;
  const totalPages = Math.ceil(totalRecords / outstandingLimit);

  if (totalPages <= 1) {
    pagination.innerHTML = '';
    return;
  }

  let html = `<span class="page-info">${fmt(totalRecords)} records</span>`;
  html += `<button class="page-btn" onclick="changeOutstandingPage(${Math.max(1, outstandingPage - 1)})">&lt;</button>`;

  for (let i = 1; i <= totalPages; i++) {
    if (i >= outstandingPage - 2 && i <= outstandingPage + 2) {
      html += `<button class="page-btn ${i === outstandingPage ? 'active' : ''}" onclick="changeOutstandingPage(${i})">${i}</button>`;
    }
  }

  html += `<button class="page-btn" onclick="changeOutstandingPage(${Math.min(totalPages, outstandingPage + 1)})">&gt;</button>`;
  pagination.innerHTML = html;
}

function changeOutstandingPage(page) {
  outstandingPage = page;
  loadOutstanding();
}