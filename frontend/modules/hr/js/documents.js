// =====================================================================
// modules/hr/js/documents.js — Document Center (Phase 4E)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];

let category = '';
let docs = [];
let isHr = false;

const CATEGORY_META = {
  policy:       { emoji: '📜', label: 'Policy' },
  form:         { emoji: '📋', label: 'Form' },
  handbook:     { emoji: '📘', label: 'Handbook' },
  announcement: { emoji: '📢', label: 'Announcement' },
  other:        { emoji: '📄', label: 'Other' },
};

Object.assign(window, {
  setCategory, loadDocs,
  openUpload, closeUpload, submitUpload, onFilePick,
  openEdit, closeEdit, submitEdit,
  downloadDoc, archiveDoc, togglePin, unarchive,
});

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-documents');
  isHr = HR_ROLES.includes((user.role || '').toLowerCase());
  if (isHr) document.querySelectorAll('.hr-only').forEach(el => el.style.display = '');
  await loadDocs();
}

// ── Filters ────────────────────────────────────────────────────────────────
function setCategory(c) {
  category = c;
  document.querySelectorAll('#catChips .chip[data-cat]').forEach(b =>
    b.classList.toggle('active', b.dataset.cat === c));
  loadDocs();
}

async function loadDocs() {
  const q = (document.getElementById('docSearch').value || '').trim();
  const archived = document.getElementById('showArchived') && document.getElementById('showArchived').checked;
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (q)        params.set('q', q);
  if (archived) params.set('archived', 'true');

  const grid = document.getElementById('docsGrid');
  grid.innerHTML = '<div class="docs-empty">Loading…</div>';
  try {
    const r = await apiRequest('/hr/documents?' + params.toString());
    docs = r.documents || [];
    renderGrid();
  } catch (err) {
    grid.innerHTML = `<div class="docs-empty docs-err">${escapeHtml(err.message || err)}</div>`;
  }
}

function renderGrid() {
  const grid = document.getElementById('docsGrid');
  if (!docs.length) {
    grid.innerHTML = `<div class="docs-empty">No documents${category ? ' in ' + (CATEGORY_META[category] && CATEGORY_META[category].label || category) : ''} yet.</div>`;
    return;
  }
  grid.innerHTML = docs.map(renderCard).join('');
}

function renderCard(d) {
  const meta = CATEGORY_META[d.Category] || { emoji: '📄', label: d.Category || 'Document' };
  const pinned = d.IsPinned ? '<span class="pin-badge">📌 Pinned</span>' : '';
  const archived = !d.IsActive ? '<span class="arch-badge">Archived</span>' : '';
  const ext = (d.FileName || '').split('.').pop().toLowerCase();
  return `
    <article class="doc-card ${d.IsPinned ? 'is-pinned' : ''} ${!d.IsActive ? 'is-archived' : ''}">
      <header class="doc-card-head">
        <div class="doc-icon">${meta.emoji}</div>
        <div class="doc-head-meta">
          <div class="doc-cat">${escapeHtml(meta.label)}</div>
          <div class="doc-pillrow">${pinned}${archived}</div>
        </div>
        ${isHr ? `
          <div class="doc-menu">
            <button type="button" class="doc-iconbtn" title="${d.IsPinned ? 'Unpin' : 'Pin'}" onclick="togglePin(${d.DocumentId}, ${d.IsPinned ? 'false' : 'true'})">📌</button>
            <button type="button" class="doc-iconbtn" title="Edit" onclick="openEdit(${d.DocumentId})">✎</button>
            ${d.IsActive
              ? `<button type="button" class="doc-iconbtn doc-iconbtn-danger" title="Archive" onclick="archiveDoc(${d.DocumentId})">🗑</button>`
              : `<button type="button" class="doc-iconbtn" title="Restore" onclick="unarchive(${d.DocumentId})">↻</button>`}
          </div>
        ` : ''}
      </header>
      <h3 class="doc-title">${escapeHtml(d.Title || d.FileName)}</h3>
      ${d.Description ? `<p class="doc-desc">${escapeHtml(d.Description)}</p>` : ''}
      <div class="doc-file">
        <span class="doc-ext">${escapeHtml(ext.toUpperCase() || 'FILE')}</span>
        <span class="doc-filename" title="${escapeAttr(d.FileName)}">${escapeHtml(d.FileName || '')}</span>
        <span class="doc-size">${prettyBytes(d.FileSize)}</span>
      </div>
      <footer class="doc-foot">
        <div class="doc-foot-meta">
          ${escapeHtml(d.UploaderName || '—')} · ${formatDate(d.UploadedAt)}
        </div>
        <button class="btn btn-primary btn-sm" type="button" onclick="downloadDoc(${d.DocumentId}, ${JSON.stringify(d.FileName).replace(/"/g,'&quot;')})">⇩ Download</button>
      </footer>
    </article>
  `;
}

// ── Upload modal ───────────────────────────────────────────────────────────
function openUpload() {
  document.getElementById('upTitle').value       = '';
  document.getElementById('upDescription').value = '';
  document.getElementById('upCategory').value    = 'policy';
  document.getElementById('upPinned').checked    = false;
  document.getElementById('upFile').value        = '';
  document.getElementById('upFileLabel').textContent = 'Choose file… (max 25 MB)';
  document.getElementById('upErr').style.display = 'none';
  document.getElementById('uploadModal').hidden  = false;
}
function closeUpload() {
  document.getElementById('uploadModal').hidden = true;
}
function onFilePick() {
  const inp = document.getElementById('upFile');
  const lab = document.getElementById('upFileLabel');
  const titleInp = document.getElementById('upTitle');
  if (inp.files && inp.files[0]) {
    const f = inp.files[0];
    lab.textContent = `${f.name} · ${prettyBytes(f.size)}`;
    // Default title to the file name (without extension) if title is empty
    if (!titleInp.value.trim()) {
      titleInp.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    }
  } else {
    lab.textContent = 'Choose file… (max 25 MB)';
  }
}
async function submitUpload() {
  const title       = document.getElementById('upTitle').value.trim();
  const description = document.getElementById('upDescription').value.trim();
  const category    = document.getElementById('upCategory').value;
  const pinned      = document.getElementById('upPinned').checked;
  const fileInp     = document.getElementById('upFile');
  const err         = document.getElementById('upErr');
  err.style.display = 'none';

  if (!title)                                     return showErr(err, 'Title is required.');
  if (!fileInp.files || !fileInp.files[0])        return showErr(err, 'Pick a file to upload.');
  if (fileInp.files[0].size > 25 * 1024 * 1024)   return showErr(err, 'File too large (max 25 MB).');

  const fd = new FormData();
  fd.append('title',       title);
  fd.append('description', description);
  fd.append('category',    category);
  fd.append('isPinned',    pinned ? 'true' : 'false');
  fd.append('file',        fileInp.files[0]);

  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/documents?company=${encodeURIComponent(company)}`, {
      method: 'POST',
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
      body: fd,
    });
    if (!res.ok) {
      const m = (await res.json().catch(() => ({}))).message || ('HTTP ' + res.status);
      throw new Error(m);
    }
    closeUpload();
    await loadDocs();
  } catch (e) { showErr(err, e.message || String(e)); }
}

// ── Edit modal ─────────────────────────────────────────────────────────────
function openEdit(id) {
  const d = docs.find(x => x.DocumentId === id);
  if (!d) return;
  document.getElementById('edId').value          = id;
  document.getElementById('edTitle').value       = d.Title || '';
  document.getElementById('edDescription').value = d.Description || '';
  document.getElementById('edCategory').value    = d.Category || 'other';
  document.getElementById('edPinned').checked    = !!d.IsPinned;
  document.getElementById('edErr').style.display = 'none';
  document.getElementById('editModal').hidden    = false;
}
function closeEdit() {
  document.getElementById('editModal').hidden = true;
}
async function submitEdit() {
  const id  = parseInt(document.getElementById('edId').value, 10);
  const err = document.getElementById('edErr');
  err.style.display = 'none';
  try {
    await apiRequest('/hr/documents/' + id, {
      method: 'PATCH',
      body: {
        title:       document.getElementById('edTitle').value.trim(),
        description: document.getElementById('edDescription').value.trim(),
        category:    document.getElementById('edCategory').value,
        isPinned:    document.getElementById('edPinned').checked,
      },
    });
    closeEdit();
    await loadDocs();
  } catch (e) { showErr(err, e.message || String(e)); }
}

// ── Card actions ───────────────────────────────────────────────────────────
async function downloadDoc(id, fileName) {
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/documents/${id}/download?company=${encodeURIComponent(company)}`, {
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
    });
    if (!res.ok) {
      const m = (await res.json().catch(() => ({}))).message || ('HTTP ' + res.status);
      throw new Error(m);
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName || ('document-' + id);
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  } catch (e) { alert(e.message || e); }
}

async function archiveDoc(id) {
  if (!confirm('Archive this document?\nIt will be hidden from everyone (HR can still see it via the "Show archived" filter).')) return;
  try {
    await apiRequest('/hr/documents/' + id, { method: 'DELETE' });
    await loadDocs();
  } catch (e) { alert(e.message || e); }
}

async function unarchive(id) {
  try {
    await apiRequest('/hr/documents/' + id, { method: 'PATCH', body: { isActive: true } });
    await loadDocs();
  } catch (e) { alert(e.message || e); }
}

async function togglePin(id, newPinned) {
  try {
    await apiRequest('/hr/documents/' + id, { method: 'PATCH', body: { isPinned: !!newPinned } });
    await loadDocs();
  } catch (e) { alert(e.message || e); }
}

// ── helpers ────────────────────────────────────────────────────────────────
function showErr(el, msg) {
  el.style.display = '';
  el.textContent = msg;
}
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
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
function escapeAttr(s) { return escapeHtml(s); }
