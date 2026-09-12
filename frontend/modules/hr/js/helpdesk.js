// =====================================================================
// modules/hr/js/helpdesk.js — Helpdesk list page (Phase 4C)
//
// Tabs: My Tickets / Assigned to Me / All Tickets (HR only).
// Filters: Status / Priority / Category.
// Click a row → /modules/hr/helpdesk-ticket.html?id=N
// + New Ticket modal: Category + Priority + Subject + Description → POST.
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];
let scope = 'mine';
let options = { categories: [], priorities: [], statuses: [] };

window.switchScope    = switchScope;
window.loadTickets    = loadTickets;
window.openNewTicket  = openNewTicket;
window.closeNewTicket = closeNewTicket;
window.submitNewTicket= submitNewTicket;

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-helpdesk');

  // Show the "All Tickets" tab only for HR/admin
  const role = (user.role || '').toLowerCase();
  if (HR_ROLES.includes(role)) {
    document.querySelectorAll('.hr-only').forEach(el => el.style.display = '');
  }

  // Load category options for filter + new-ticket modal
  try {
    options = await apiRequest('/hr/helpdesk/options');
  } catch (_) { options = { categories: [], priorities: [], statuses: [] }; }

  const catSel = document.getElementById('filterCategory');
  const ntCat  = document.getElementById('ntCategory');
  options.categories.forEach(c => {
    catSel.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`);
    ntCat.insertAdjacentHTML('beforeend',  `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`);
  });

  await loadTickets();
}

function switchScope(s) {
  scope = s;
  document.querySelectorAll('#hdTabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scope === s);
  });
  loadTickets();
}

async function loadTickets() {
  const params = new URLSearchParams({ scope });
  const st = document.getElementById('filterStatus').value;
  const pr = document.getElementById('filterPriority').value;
  const ct = document.getElementById('filterCategory').value;
  if (st) params.set('status',   st);
  if (pr) params.set('priority', pr);
  if (ct) params.set('category', ct);

  const wrap = document.getElementById('hdList');
  wrap.innerHTML = '<div class="hd-empty">Loading…</div>';
  try {
    const r = await apiRequest('/hr/helpdesk/tickets?' + params.toString());
    renderList(r.tickets || []);
  } catch (err) {
    wrap.innerHTML = `<div class="hd-empty hd-err">${escapeHtml(err.message || err)}</div>`;
  }
}

function renderList(tickets) {
  document.getElementById('hdCount').textContent = `${tickets.length} ticket(s)`;
  const wrap = document.getElementById('hdList');
  if (!tickets.length) {
    wrap.innerHTML = `<div class="hd-empty">
      ${scope === 'mine'     ? "You haven't raised any tickets yet."
        : scope === 'assigned' ? 'No tickets are assigned to you.'
        : 'No tickets in the system match the current filters.'}
    </div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="hd-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Subject</th>
          <th>Category</th>
          <th>Priority</th>
          <th>Status</th>
          ${scope === 'mine' ? '<th>Assignee</th>' : '<th>Raiser</th>'}
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        ${tickets.map(t => `
          <tr onclick="location.href='/modules/hr/helpdesk-ticket.html?id=${t.TicketId}'">
            <td class="hd-tno">${escapeHtml(t.TicketNo || '#' + t.TicketId)}</td>
            <td class="hd-subj">
              <div>${escapeHtml(t.Subject || '')}</div>
              <div class="hd-meta">${t.CommentsCount || 0} comment(s) · ${t.AttachmentsCount || 0} file(s)</div>
            </td>
            <td>${escapeHtml(t.Category || '')}</td>
            <td><span class="prio prio-${escapeAttr((t.Priority||'').toLowerCase())}">${escapeHtml(t.Priority || '')}</span></td>
            <td><span class="status status-${escapeAttr((t.Status||'').toLowerCase())}">${escapeHtml(prettyStatus(t.Status))}</span></td>
            <td>${escapeHtml((scope === 'mine' ? t.AssigneeName : t.RaiserName) || '—')}</td>
            <td>${formatLocal(t.UpdatedAt || t.CreatedAt)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// ── NEW TICKET modal ────────────────────────────────────────────────────────
function openNewTicket() {
  document.getElementById('ntCategory').value    = options.categories[0] || '';
  document.getElementById('ntPriority').value    = 'Medium';
  document.getElementById('ntSubject').value     = '';
  document.getElementById('ntDescription').value = '';
  document.getElementById('ntErr').style.display = 'none';
  document.getElementById('newModal').hidden = false;
}
function closeNewTicket() {
  document.getElementById('newModal').hidden = true;
}
async function submitNewTicket() {
  const category    = document.getElementById('ntCategory').value;
  const priority    = document.getElementById('ntPriority').value;
  const subject     = document.getElementById('ntSubject').value.trim();
  const description = document.getElementById('ntDescription').value.trim();
  const err = document.getElementById('ntErr');
  err.style.display = 'none';
  if (!subject) { err.textContent = 'Subject is required.'; err.style.display = ''; return; }
  try {
    const r = await apiRequest('/hr/helpdesk/tickets', {
      method: 'POST',
      body: { category, priority, subject, description },
    });
    closeNewTicket();
    // Jump straight into the new ticket
    location.href = `/modules/hr/helpdesk-ticket.html?id=${r.ticketId}`;
  } catch (e) {
    err.textContent = e.message || String(e);
    err.style.display = '';
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function prettyStatus(s) {
  if (!s) return '';
  return s.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
}
function formatLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-IN', { hour12: false, day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
