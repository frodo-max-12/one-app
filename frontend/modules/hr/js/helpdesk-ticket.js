// =====================================================================
// modules/hr/js/helpdesk-ticket.js — Ticket detail (Phase 4C)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];
const ticketId = parseInt(new URLSearchParams(location.search).get('id') || '0', 10);

let viewer = { canEditAsHr: false, canActAsOwner: false };
let ticket = null;

window.postComment = postComment;
window.uploadFiles = uploadFiles;
window.hrUpdate    = hrUpdate;
window.actAsOwner  = actAsOwner;

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-helpdesk');
  if (!ticketId) { diag('Missing ticket id'); return; }

  const role = (user.role || '').toLowerCase();
  if (HR_ROLES.includes(role)) {
    document.querySelectorAll('.hr-only').forEach(el => el.style.display = '');
    // Populate assignee dropdown
    try {
      const a = await apiRequest('/hr/helpdesk/assignees');
      const sel = document.getElementById('hrAssignee');
      (a.assignees || []).forEach(u => {
        sel.insertAdjacentHTML('beforeend',
          `<option value="${u.UserId}">${escapeHtml(u.Name)}${u.Role ? ' · ' + escapeHtml(u.Role) : ''}</option>`);
      });
    } catch (_) {}
  }

  await load();
}

async function load() {
  try {
    const r = await apiRequest('/hr/helpdesk/tickets/' + ticketId);
    ticket = r.ticket;
    viewer = r.viewer || viewer;
    renderHeader(ticket);
    renderMeta(ticket);
    renderComments(r.comments || []);
    renderAttachments(r.attachments || []);
    renderActions();
  } catch (err) {
    diag(err.message || String(err));
  }
}

function renderHeader(t) {
  document.getElementById('topTicketNo').textContent = t.TicketNo || ('#' + t.TicketId);
  document.getElementById('ticketNo').textContent    = t.TicketNo || ('#' + t.TicketId);
  document.getElementById('ticketSubj').textContent  = t.Subject || '';
  setStatusPill(document.getElementById('ticketStatus'), t.Status);
  setPrioPill  (document.getElementById('ticketPrio'),   t.Priority);
  const cat = document.getElementById('ticketCat');
  cat.textContent = t.Category || '';
  document.getElementById('ticketDesc').textContent = t.Description || '— No description provided —';
}

function renderMeta(t) {
  setStatusPill(document.getElementById('metaStatus'), t.Status);
  setPrioPill  (document.getElementById('metaPrio'),   t.Priority);
  document.getElementById('metaCat').textContent      = t.Category || '—';
  document.getElementById('metaRaiser').textContent   = t.RaiserName || '—';
  document.getElementById('metaAssignee').textContent = t.AssigneeName || 'Unassigned';
  document.getElementById('metaCreated').textContent  = formatLocal(t.CreatedAt);
  document.getElementById('metaUpdated').textContent  = formatLocal(t.UpdatedAt || t.CreatedAt);
  if (t.ResolvedAt) {
    document.getElementById('rowResolved').style.display = '';
    document.getElementById('metaResolved').textContent = formatLocal(t.ResolvedAt);
  }
  if (t.ClosedAt) {
    document.getElementById('rowClosed').style.display = '';
    document.getElementById('metaClosed').textContent = formatLocal(t.ClosedAt);
  }
  // Sync HR controls
  if (viewer.canEditAsHr) {
    document.getElementById('hrPanel').style.display = '';
    document.getElementById('hrStatus').value   = t.Status   || 'open';
    document.getElementById('hrPriority').value = t.Priority || 'Medium';
    document.getElementById('hrAssignee').value = t.AssignedToUserId || '';
    if (['resolved','closed'].includes((t.Status || '').toLowerCase())) {
      document.getElementById('hrResolutionWrap').style.display = '';
      document.getElementById('hrResolution').value = t.Resolution || '';
    }
  }
}

function renderComments(rows) {
  const wrap = document.getElementById('threadList');
  document.getElementById('threadCount').textContent = `${rows.length} message(s)`;
  if (!rows.length) {
    wrap.innerHTML = `<div class="hd-empty hd-empty-sm">No replies yet. Start the conversation below.</div>`;
    return;
  }
  wrap.innerHTML = rows.map(c => {
    const isMine = c.UserId === user.id;
    const cls = `hdt-msg${isMine ? ' is-mine' : ''}${c.IsInternal ? ' is-internal' : ''}`;
    const initials = (c.AuthorName || '?').split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
    return `
      <div class="${cls}">
        <div class="hdt-msg-av">${escapeHtml(initials)}</div>
        <div class="hdt-msg-body">
          <div class="hdt-msg-head">
            <b>${escapeHtml(c.AuthorName || 'Unknown')}</b>
            <span>${escapeHtml(c.AuthorRole || '')}</span>
            <span>· ${formatLocal(c.CreatedAt)}</span>
            ${c.IsInternal ? '<span class="hdt-internal-pill">Internal</span>' : ''}
          </div>
          <div class="hdt-msg-text">${escapeHtml(c.Body || '')}</div>
        </div>
      </div>`;
  }).join('');
}

function renderAttachments(rows) {
  const wrap = document.getElementById('attachList');
  if (!rows.length) {
    wrap.innerHTML = `<div class="hd-empty hd-empty-sm">No files attached.</div>`;
    return;
  }
  wrap.innerHTML = rows.map(a => `
    <button class="hdt-attach-item" type="button"
            onclick="downloadAttachment(${a.AttachmentId}, ${JSON.stringify(a.FileName).replace(/"/g,'&quot;')})">
      <span class="hdt-attach-icon">📎</span>
      <span class="hdt-attach-name">${escapeHtml(a.FileName)}</span>
      <span class="hdt-attach-meta">${prettyBytes(a.FileSize)} · ${formatLocal(a.UploadedAt)}</span>
    </button>
  `).join('');
}

window.downloadAttachment = async function (attId, fileName) {
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/helpdesk/tickets/${ticketId}/attachments/${attId}?company=${encodeURIComponent(company)}`, {
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).message || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName || ('attachment-' + attId);
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  } catch (err) { diag(err.message || String(err)); }
};

function renderActions() {
  const box = document.getElementById('hdtActions');
  if (!ticket) { box.innerHTML = ''; return; }
  const s = (ticket.Status || '').toLowerCase();
  const buttons = [];
  if (viewer.canActAsOwner && !viewer.canEditAsHr) {
    if (s === 'resolved') {
      buttons.push(`<button class="btn btn-success" onclick="actAsOwner('closed')">✓ Mark closed</button>`);
      buttons.push(`<button class="btn"            onclick="actAsOwner('in-progress')">↻ Reopen</button>`);
    } else if (s === 'closed') {
      buttons.push(`<button class="btn" onclick="actAsOwner('open')">↻ Reopen</button>`);
    }
  }
  box.innerHTML = buttons.join('');
}

// ── Mutations ───────────────────────────────────────────────────────────────
async function postComment() {
  const ta  = document.getElementById('newComment');
  const chk = document.getElementById('cmtInternal');
  const body = (ta.value || '').trim();
  if (!body) return;
  try {
    await apiRequest(`/hr/helpdesk/tickets/${ticketId}/comments`, {
      method: 'POST',
      body: { body, isInternal: !!(chk && chk.checked) },
    });
    ta.value = '';
    if (chk) chk.checked = false;
    await load();
  } catch (err) { diag(err.message || String(err)); }
}

async function uploadFiles() {
  const inp = document.getElementById('fileUpload');
  if (!inp.files || !inp.files.length) return;
  const fd = new FormData();
  Array.from(inp.files).forEach(f => fd.append('files', f));
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/helpdesk/tickets/${ticketId}/attachments?company=${encodeURIComponent(company)}`, {
      method: 'POST',
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
      body: fd,
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).message || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    inp.value = '';
    await load();
  } catch (err) { diag(err.message || String(err)); }
}

async function hrUpdate(patch) {
  try {
    await apiRequest(`/hr/helpdesk/tickets/${ticketId}`, { method: 'PATCH', body: patch });
    await load();
  } catch (err) { diag(err.message || String(err)); }
}

async function actAsOwner(newStatus) {
  try {
    await apiRequest(`/hr/helpdesk/tickets/${ticketId}`, { method: 'PATCH', body: { status: newStatus } });
    await load();
  } catch (err) { diag(err.message || String(err)); }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function setStatusPill(el, s) {
  if (!el) return;
  const k = (s || '').toLowerCase();
  el.className = 'status status-' + (k || 'open');
  el.textContent = (s || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '—';
}
function setPrioPill(el, p) {
  if (!el) return;
  el.className = 'prio prio-' + ((p || '').toLowerCase() || 'medium');
  el.textContent = p || '—';
}
function diag(msg) {
  const el = document.getElementById('hdtDiag');
  if (!el) return alert(msg);
  el.style.display = '';
  el.textContent = '⚠ ' + msg;
}
function formatLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-IN', { hour12: false, day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function prettyBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB']; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i];
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
