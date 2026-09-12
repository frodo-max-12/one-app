// =====================================================================
// modules/hr/js/letters.js — Letter generation page (Phase 6C)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];

let allTemplates = [];
let allEmployees = [];
let allIssued    = [];
let placeholders = [];

Object.assign(window, {
  switchTab, updatePreview, debouncePreview, generateLetter,
  openTemplateEdit, closeTemplateEdit, submitTemplate, archiveTemplate,
  insertPlaceholder, downloadIssued, onTemplateChange,
});

function onTemplateChange() {
  renderExtraFields();
  updatePreview();
}

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-letters');
  if (!HR_ROLES.includes((user.role || '').toLowerCase())) {
    document.querySelector('.pr-wrap').innerHTML = '<div class="pr-empty">HR / admin only.</div>';
    return;
  }
  try {
    const p = await apiRequest('/hr/letters/placeholders');
    placeholders = p.placeholders || [];
  } catch (_) {}
  await Promise.all([loadTemplates(), loadEmployees()]);
  populateGenerateUI();
}

function switchTab(t) {
  document.querySelectorAll('.ps-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.getElementById('paneGenerate').style.display  = (t === 'generate')  ? '' : 'none';
  document.getElementById('paneTemplates').style.display = (t === 'templates') ? '' : 'none';
  document.getElementById('paneIssued').style.display    = (t === 'issued')    ? '' : 'none';
  if (t === 'issued' && !allIssued.length) loadIssued();
}

// ────────────────────────────────────────────────────────────────────────────
// GENERATE tab
// ────────────────────────────────────────────────────────────────────────────
async function loadEmployees() {
  try {
    // Reuse the non-HR-gated engage endpoint (returns Id + Name + Department + EmpCode)
    const r = await apiRequest('/hr/engage/users');
    allEmployees = r.users || [];
    const dl = document.getElementById('empListDL');
    dl.innerHTML = allEmployees.map(e =>
      `<option value="${escapeAttr(e.Name)}" data-id="${e.UserId}">${escapeHtml((e.EmpCode || '') + (e.Department ? ' · ' + e.Department : ''))}</option>`
    ).join('');
  } catch (_) { allEmployees = []; }
}
function resolveEmpId(name) {
  const m = allEmployees.find(e => e.Name === name);
  return m ? m.UserId : null;
}

function populateGenerateUI() {
  const sel = document.getElementById('genTemplate');
  sel.innerHTML = allTemplates.map(t =>
    `<option value="${t.TemplateId}">${escapeHtml(t.Name)} (${escapeHtml(t.Code)})</option>`
  ).join('');
  renderExtraFields();   // initial render for whichever template is selected
}

let previewTimer = null;
function debouncePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 350); }

// ── Dynamic placeholders (user-input + DB-overridable fields) ──
// Re-renders whenever the chosen template changes. Pulls in:
//   • placeholders marked userInput  — pure user-supplied (Required-ish)
//   • placeholders marked overridable — DB-resolved but HR can override
//                                       (blank input → DB value wins)
// Both are sorted with userInput rows first, then overridable.
function renderExtraFields() {
  const tid = parseInt(document.getElementById('genTemplate').value, 10);
  const tmpl = allTemplates.find(t => t.TemplateId === tid);
  const wrap = document.getElementById('extraFieldsWrap');
  const body = document.getElementById('extraFields');
  if (!tmpl) { wrap.style.display = 'none'; body.innerHTML = ''; return; }

  // Scan template body + subject for {{X}} placeholders
  const text = (tmpl.BodyTemplate || '') + ' ' + (tmpl.Subject || '');
  const found = new Set();
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ph = placeholders.find(p => p.key === m[1] && (p.userInput || p.overridable));
    if (ph) found.add(ph.key);
  }
  if (!found.size) { wrap.style.display = 'none'; body.innerHTML = ''; return; }

  // Sort: userInput placeholders first (required-ish), then overridable
  const ordered = placeholders.filter(p => found.has(p.key))
    .sort((a, b) => Number(!!b.userInput) - Number(!!a.userInput));

  // Pair them up for 2-col grid
  const pairs = [];
  for (let i = 0; i < ordered.length; i += 2) pairs.push(ordered.slice(i, i + 2));

  // If we have ANY userInput placeholder, show a divider before overridable section
  const hasUser     = ordered.some(p => p.userInput);
  const hasOverride = ordered.some(p => !p.userInput && p.overridable);
  const headLine = hasUser && hasOverride
    ? 'Fill in the values below. Fields marked <em>(override)</em> are optional — leave blank to use the saved value.'
    : (hasUser
        ? 'Fill in the values below to insert in the letter:'
        : 'Optional overrides — leave blank to use the value from the employee record:');
  document.querySelector('.ltr-extra-head').innerHTML = headLine;

  body.innerHTML = pairs.map(pair => `
    <div class="ltr-extra-row">
      ${pair.map(p => fieldHtml(p)).join('')}
    </div>`).join('');
  wrap.style.display = '';

  // Bind change/input handler → debounced preview
  body.querySelectorAll('input, textarea').forEach(el => {
    el.addEventListener('input', debouncePreview);
  });
}

function fieldHtml(p) {
  const id = 'extra_' + p.key;
  const label = p.key.replace(/([A-Z])/g, ' $1').trim();   // "FromDate" → "From Date"
  const overrideTag = (!p.userInput && p.overridable) ? ' <em class="ltr-opt">(override)</em>' : '';
  const placeholderHint = (!p.userInput && p.overridable)
    ? 'Leave blank to use saved value'
    : (p.desc || '');
  if (p.type === 'textarea') {
    return `<label class="ltr-extra-field"><span>${escapeHtml(label)}${overrideTag}</span>
      <textarea id="${id}" rows="2" placeholder="${escapeAttr(placeholderHint)}"></textarea></label>`;
  }
  const inputType = p.type === 'date' ? 'date' : (p.type === 'number' ? 'number' : 'text');
  return `<label class="ltr-extra-field"><span>${escapeHtml(label)}${overrideTag}</span>
    <input type="${inputType}" id="${id}" placeholder="${escapeAttr(placeholderHint)}" /></label>`;
}

// Read all extra inputs into the `extras` object that goes to /preview + /generate.
// Date inputs (YYYY-MM-DD) are reformatted to DD-MM-YYYY, the format the
// rest of the placeholder map uses.
function collectExtras() {
  const out = {};
  document.querySelectorAll('#extraFields input, #extraFields textarea').forEach(el => {
    const key = el.id.replace(/^extra_/, '');
    const ph  = placeholders.find(p => p.key === key);
    let v = el.value;
    if (v === '' || v == null) return;          // skip blanks so DB defaults / template literals stay intact
    if (ph && ph.type === 'date') {
      // YYYY-MM-DD → DD-MM-YYYY
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (m) v = `${m[3]}-${m[2]}-${m[1]}`;
    } else if (ph && ph.type === 'number') {
      const n = Number(v);
      if (!isNaN(n)) v = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
    }
    out[key] = v;
  });
  return out;
}

async function updatePreview() {
  const tid = parseInt(document.getElementById('genTemplate').value, 10);
  const uid = resolveEmpId(document.getElementById('genEmpName').value.trim());
  const wrap = document.getElementById('ltrPreview');
  if (!tid)  { wrap.innerHTML = '<div class="pr-empty">Pick a template.</div>'; return; }
  if (!uid)  { wrap.innerHTML = '<div class="pr-empty">Pick an employee.</div>'; return; }
  try {
    const extras = collectExtras();
    const r = await apiRequest('/hr/letters/preview', { method:'POST', body: { templateId: tid, forUserId: uid, extras }});
    const unresolved = r.unresolved && r.unresolved.length
      ? `<div class="ltr-warn">⚠ Unresolved placeholders: ${escapeHtml(r.unresolved.join(', '))}</div>`
      : '';
    wrap.innerHTML = `
      ${unresolved}
      ${r.subject ? `<div class="ltr-subj">${escapeHtml(r.subject)}</div>` : ''}
      <div class="ltr-body">${escapeHtml(r.renderedBody || '')}</div>
      ${r.signatureBlock ? `<div class="ltr-sig">${escapeHtml(r.signatureBlock)}</div>` : ''}
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="pr-empty pr-err">${escapeHtml(e.message || e)}</div>`;
  }
}

async function generateLetter() {
  const tid = parseInt(document.getElementById('genTemplate').value, 10);
  const uid = resolveEmpId(document.getElementById('genEmpName').value.trim());
  const notes = document.getElementById('genNotes').value.trim();
  const err = document.getElementById('genErr');
  err.style.display = 'none';
  if (!tid) { err.textContent = 'Pick a template.'; err.style.display = ''; return; }
  if (!uid) { err.textContent = 'Pick an employee from the list.'; err.style.display = ''; return; }
  try {
    const r = await apiRequest('/hr/letters/generate', {
      method: 'POST',
      body: { templateId: tid, forUserId: uid, notes: notes || null, extras: collectExtras() },
    });
    await downloadIssued(r.letterId, r.letterNo);
    if (allIssued.length) await loadIssued();   // refresh history if open
  } catch (e) { err.textContent = e.message || e; err.style.display = ''; }
}

async function downloadIssued(id, label) {
  try {
    const company = (typeof getCompany === 'function') ? getCompany() : '';
    const token   = (typeof getToken   === 'function') ? getToken()   : '';
    const res = await fetch(`/api/hr/letters/issued/${id}/pdf?company=${encodeURIComponent(company)}`, {
      headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'HTTP ' + res.status); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = (label || ('LTR-' + id)) + '.pdf';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  } catch (e) { alert(e.message || e); }
}

// ────────────────────────────────────────────────────────────────────────────
// TEMPLATES tab
// ────────────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  try {
    const r = await apiRequest('/hr/letters/templates');
    allTemplates = r.templates || [];
    renderTemplates();
    populateGenerateUI();
  } catch (e) {
    document.getElementById('tmplTbody').innerHTML = `<tr><td colspan="5" class="ps-empty pr-err">${escapeHtml(e.message || e)}</td></tr>`;
  }
}

function renderTemplates() {
  const tbody = document.getElementById('tmplTbody');
  if (!allTemplates.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="ps-empty">No templates yet.</td></tr>';
    return;
  }
  tbody.innerHTML = allTemplates.map(t => `
    <tr>
      <td class="mono">${escapeHtml(t.Code)}</td>
      <td>${escapeHtml(t.Name)}<div class="pr-meta">${escapeHtml(t.Subject || '')}</div></td>
      <td><span class="pill">${escapeHtml(t.Category)}</span></td>
      <td class="r mono">${t.IssuedCount || 0}</td>
      <td class="r" style="white-space:nowrap;">
        <button class="btn btn-sm" onclick="openTemplateEdit(${t.TemplateId})">✎ Edit</button>
        <button class="btn btn-sm btn-danger" onclick="archiveTemplate(${t.TemplateId})">🗑</button>
      </td>
    </tr>`).join('');
}

async function openTemplateEdit(id) {
  const isNew = !id;
  document.getElementById('tmplModalTitle').textContent = isNew ? 'New Template' : 'Edit Template';
  document.getElementById('tmId').value      = id || '';
  document.getElementById('tmErr').style.display = 'none';

  // Render placeholder chips
  document.getElementById('phChips').innerHTML = placeholders.map(p =>
    `<button type="button" class="ph-chip" title="${escapeAttr(p.desc)}" onclick="insertPlaceholder('${escapeAttr(p.key)}')">{{${escapeHtml(p.key)}}}</button>`
  ).join('');

  if (isNew) {
    document.getElementById('tmCode').value     = '';
    document.getElementById('tmCode').disabled  = false;
    document.getElementById('tmName').value     = '';
    document.getElementById('tmCategory').value = 'general';
    document.getElementById('tmSubject').value  = '';
    document.getElementById('tmBody').value     = '';
    document.getElementById('tmSig').value      = '';
  } else {
    try {
      const r = await apiRequest('/hr/letters/templates/' + id);
      const t = r.template;
      document.getElementById('tmCode').value     = t.Code;
      document.getElementById('tmCode').disabled  = true;
      document.getElementById('tmName').value     = t.Name;
      document.getElementById('tmCategory').value = t.Category || 'general';
      document.getElementById('tmSubject').value  = t.Subject || '';
      document.getElementById('tmBody').value     = t.BodyTemplate || '';
      document.getElementById('tmSig').value      = t.SignatureBlock || '';
    } catch (e) {
      document.getElementById('tmErr').textContent = e.message || e;
      document.getElementById('tmErr').style.display = '';
      return;
    }
  }
  document.getElementById('tmplModal').hidden = false;
}
function closeTemplateEdit() { document.getElementById('tmplModal').hidden = true; }

function insertPlaceholder(key) {
  const ta = document.activeElement && document.activeElement.tagName === 'TEXTAREA'
    ? document.activeElement
    : document.getElementById('tmBody');
  const token = `{{${key}}}`;
  const start = ta.selectionStart || 0, end = ta.selectionEnd || 0;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + token.length;
  ta.focus();
}

async function submitTemplate() {
  const id = document.getElementById('tmId').value;
  const err = document.getElementById('tmErr');
  err.style.display = 'none';
  const body = {
    name:           document.getElementById('tmName').value.trim(),
    category:       document.getElementById('tmCategory').value,
    subject:        document.getElementById('tmSubject').value.trim(),
    bodyTemplate:   document.getElementById('tmBody').value,
    signatureBlock: document.getElementById('tmSig').value,
  };
  if (!id) body.code = document.getElementById('tmCode').value.trim().toUpperCase();
  if (!body.name)           { err.textContent = 'Name required.';  err.style.display = ''; return; }
  if (!id && !body.code)     { err.textContent = 'Code required.';  err.style.display = ''; return; }
  if (!body.bodyTemplate)    { err.textContent = 'Body required.';  err.style.display = ''; return; }
  try {
    if (id) await apiRequest('/hr/letters/templates/' + id, { method:'PATCH', body });
    else    await apiRequest('/hr/letters/templates',       { method:'POST',  body });
    closeTemplateEdit();
    await loadTemplates();
  } catch (e) { err.textContent = e.message || e; err.style.display = ''; }
}

async function archiveTemplate(id) {
  if (!confirm('Archive this template? History of letters already generated stays intact.')) return;
  try { await apiRequest('/hr/letters/templates/' + id, { method:'DELETE' }); await loadTemplates(); }
  catch (e) { alert(e.message || e); }
}

// ────────────────────────────────────────────────────────────────────────────
// HISTORY tab
// ────────────────────────────────────────────────────────────────────────────
async function loadIssued() {
  try {
    const r = await apiRequest('/hr/letters/issued');
    allIssued = r.letters || [];
    renderIssued();
  } catch (e) {
    document.getElementById('issuedTbody').innerHTML = `<tr><td colspan="6" class="ps-empty pr-err">${escapeHtml(e.message || e)}</td></tr>`;
  }
}

function renderIssued() {
  const tbody = document.getElementById('issuedTbody');
  if (!allIssued.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="ps-empty">No letters generated yet.</td></tr>';
    return;
  }
  tbody.innerHTML = allIssued.map(l => `
    <tr>
      <td class="mono">${escapeHtml(l.LetterNo || ('#' + l.LetterId))}</td>
      <td>${escapeHtml(l.TemplateName)}<div class="pr-meta">${escapeHtml(l.TemplateCode)}</div></td>
      <td>${escapeHtml(l.ForEmpName || '—')}<div class="pr-meta">${escapeHtml(l.ForEmpCode || '')}</div></td>
      <td>${escapeHtml(l.IssuedByName || ('User ' + l.IssuedBy))}</td>
      <td>${formatLocal(l.IssuedAt)}</td>
      <td class="r"><button class="btn btn-sm btn-primary" onclick="downloadIssued(${l.LetterId}, ${JSON.stringify(l.LetterNo || '').replace(/"/g, '&quot;')})">⇩ PDF</button></td>
    </tr>`).join('');
}

function formatLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleString('en-IN', { hour12:false, day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
