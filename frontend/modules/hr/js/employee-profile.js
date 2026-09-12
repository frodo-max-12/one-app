// ============================================================================
// ONE App Lens — Employee Profile (tabbed)
// ============================================================================
const user = requireAuth();
let viewingUserId = null;
let profile = null;
let family  = [];
let docs    = [];
let positions   = [];
let prevEmp     = [];
let nominations = [];
let editMode = false;

window.showTab = showTab;
window.toggleEdit = toggleEdit;
window.saveAll = saveAll;
window.showAddFamily = showAddFamily;
window.hideAddFamily = hideAddFamily;
window.saveFamily = saveFamily;
window.removeFamily = removeFamily;
window.uploadDoc = uploadDoc;
window.removeDoc = removeDoc;
window.showAddPosition = showAddPosition;
window.hideAddPosition = hideAddPosition;
window.savePosition    = savePosition;
window.removePosition  = removePosition;
window.showAddPrev     = showAddPrev;
window.hideAddPrev     = hideAddPrev;
window.savePrev        = savePrev;
window.removePrev      = removePrev;
window.showAddNom      = showAddNom;
window.hideAddNom      = hideAddNom;
window.saveNom         = saveNom;
window.removeNom       = removeNom;
window.applyResign     = applyResign;
window.saveSeparation  = saveSeparation;

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

function diag(label, msg) {
  const box = document.getElementById('lensDiag'); const list = document.getElementById('diagList');
  if (!box || !list) return console.error(label, msg);
  const li = document.createElement('li'); li.textContent = `[${new Date().toLocaleTimeString('en-IN',{hour12:false})}] ${label}: ${msg}`;
  list.appendChild(li); box.style.display = 'block';
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('employees');
  const params = new URLSearchParams(location.search);
  viewingUserId = parseInt(params.get('id')) || user.id;

  const role = (user.role || '').toLowerCase();
  const isAdminish = ['admin','operation head','director','hr','hr head'].includes(role);
  if (isAdminish || viewingUserId === user.id) {
    document.getElementById('editBtn').style.display = '';
  }
  await load();
}

async function load() {
  try {
    const r = await apiRequest('/hr/employees/' + viewingUserId);
    profile     = r.profile || {};
    family      = r.family  || [];
    docs        = r.documents || [];
    positions   = r.positions || [];
    prevEmp     = r.previousEmployment || [];
    nominations = r.nominations || [];
    renderHero();
    renderTabs();
  } catch (e) {
    diag('GET /employees/:id', e.message || e);
    document.getElementById('profileName').textContent = 'Failed to load';
    document.getElementById('profileMeta').textContent = e.message || '';
  }
}

function renderHero() {
  const name = profile.Name || [profile.FirstName, profile.MiddleName, profile.LastName].filter(Boolean).join(' ') || '—';
  const ini = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  document.getElementById('avatar').textContent = ini;
  document.getElementById('profileName').textContent = name;
  const meta = [profile.Designation, profile.Department, profile.Location].filter(Boolean).join(' · ');
  document.getElementById('profileMeta').textContent = meta || '—';
  const pills = [];
  if (profile.EmpCode || profile.CompanyACode) pills.push(`<span class="pill">#${escape(profile.EmpCode || profile.CompanyACode)}</span>`);
  if (profile.Role)          pills.push(`<span class="pill">${escape(profile.Role)}</span>`);
  if (profile.EmployeeType)  pills.push(`<span class="pill">${escape(profile.EmployeeType)}</span>`);
  if (profile.OfficeName)    pills.push(`<span class="pill">🏛️ ${escape(profile.OfficeName)}</span>`);
  if (profile.DateOfJoining) pills.push(`<span class="pill">Joined ${new Date(profile.DateOfJoining).toLocaleDateString('en-IN',{month:'short', year:'numeric'})}</span>`);
  document.getElementById('profilePills').innerHTML = pills.join('');
}

function renderTabs() {
  renderKV('kv-employee', [
    ['Title', 'Title'],
    ['First Name', 'FirstName'],
    ['Middle Name', 'MiddleName'],
    ['Last Name', 'LastName'],
    ['Nick Name', 'NickName'],
    ['Gender', 'Gender'],
    ['Login Username', 'Username'],
    ['Work Email', 'Email'],
    ['Mobile', 'Mobile'],
    ['Extension', 'Extension'],
  ]);
  renderKV('kv-personal', [
    ['Date of Birth', 'DOB', 'date'],
    ['Blood Group', 'BloodGroup'],
    ['Marital Status', 'MaritalStatus'],
    ['Marriage Date', 'MarriageDate', 'date'],
    ['Spouse Name', 'SpouseName'],
    ['Father\'s Name', 'FatherName'],
    ['Mother\'s Name', 'MotherName'],
    ['Nationality', 'Nationality'],
    ['PAN Number', 'PAN'],
    ['Personal Email', 'PersonalEmail'],
  ]);
  renderKV('kv-contact', [
    ['Address', 'Address'],
    ['City', 'City'],
    ['District', 'District'],
    ['State', 'State'],
    ['Country', 'Country'],
    ['Pincode', 'Pincode'],
    ['Alternate Phone', 'AltPhone'],
  ]);
  renderKV('kv-emergency', [
    ['Name', 'EmgName'],
    ['Relationship', 'EmgRelationship'],
    ['Phone', 'EmgPhone'],
    ['Address', 'EmgAddress'],
  ]);
  renderKV('kv-bank', [
    ['Payment Mode', 'PaymentMode'],
    ['Bank Name', 'BankName'],
    ['Account Number', 'BankAccountNo'],
    ['IFSC', 'IFSC'],
    ['Branch', 'BankBranch'],
  ]);
  renderKV('kv-statutory', [
    ['Include in PF', 'IncludePF', 'bool'],
    ['Include in ESI', 'IncludeESI', 'bool'],
    ['Include in LWF', 'IncludeLWF', 'bool'],
    ['PF Number', 'PFNo'],
    ['PF UAN', 'PFUAN'],
    ['ESI Number', 'ESINo'],
  ]);
  renderKV('kv-passport', [
    ['Passport No', 'PassportNo'],
    ['Country', 'PassportCountry'],
    ['Issue Date', 'PassportIssueDate', 'date'],
    ['Expiry Date', 'PassportExpiryDate', 'date'],
    ['Place of Issue', 'PassportPlaceOfIssue'],
  ]);
  renderKV('kv-visa', [
    ['Visa Number', 'VisaNo'],
    ['Visa Type', 'VisaType'],
    ['Visa Country', 'VisaCountry'],
    ['Visa Expiry', 'VisaExpiryDate', 'date'],
  ]);
  renderFamily();
  renderDocs();
  renderPositions();
  renderPrev();
  renderNominations();
  renderSeparation();
}

function renderKV(targetId, pairs) {
  const wrap = document.getElementById(targetId);
  if (!wrap) return;   // defensive — skip if the tab panel isn't in the DOM yet
  wrap.innerHTML = pairs.map(([label, field, type]) => {
    let raw = profile[field];
    let display;
    if (type === 'bool') display = raw ? '✓ Yes' : '✗ No';
    else if (type === 'date' && raw) display = new Date(raw).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    else display = raw || '';
    const isEmpty = !display;
    if (editMode) {
      let inputHtml;
      if (type === 'bool') {
        inputHtml = `<select data-field="${field}"><option value="0" ${!raw ? 'selected' : ''}>No</option><option value="1" ${raw ? 'selected' : ''}>Yes</option></select>`;
      } else if (type === 'date') {
        inputHtml = `<input type="date" data-field="${field}" value="${raw ? String(raw).slice(0,10) : ''}" />`;
      } else if (field === 'Address' || field === 'EmgAddress') {
        inputHtml = `<textarea data-field="${field}" rows="2">${escape(raw || '')}</textarea>`;
      } else {
        inputHtml = `<input type="text" data-field="${field}" value="${escape(raw || '')}" />`;
      }
      return `<div class="kv-pair"><label>${escape(label)}</label>${inputHtml}</div>`;
    }
    return `<div class="kv-pair"><label>${escape(label)}</label><div class="val ${isEmpty ? 'empty' : ''}">${isEmpty ? '— not set —' : escape(display)}</div></div>`;
  }).join('');
}

function showTab(name) {
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.toggle('active', el.id === 'tab-' + name));
}

function toggleEdit() {
  editMode = true;
  document.getElementById('editBtn').style.display = 'none';
  document.getElementById('saveBtn').style.display = '';
  renderTabs();
}

async function saveAll() {
  const inputs = document.querySelectorAll('.kv-pair [data-field]');
  const payload = {};
  inputs.forEach(el => {
    const f = el.dataset.field;
    if (f === 'Username' || f === 'Email') return;        // never editable via PATCH
    let v = el.value;
    if (el.tagName === 'SELECT' && (v === '0' || v === '1')) v = (v === '1');
    payload[f.charAt(0).toLowerCase() + f.slice(1)] = v;
  });
  try {
    await apiRequest('/hr/employees/' + viewingUserId, { method: 'PATCH', body: payload });
    editMode = false;
    document.getElementById('editBtn').style.display = '';
    document.getElementById('saveBtn').style.display = 'none';
    await load();
  } catch (e) {
    alert('Save failed: ' + (e.message || e));
  }
}

// ── Family ─────────────────────────────────────────────────────────────────
function renderFamily() {
  const wrap = document.getElementById('familyList');
  if (!wrap) return;
  if (family.length === 0) {
    wrap.innerHTML = '<div class="kv-pair" style="padding:20px; background:var(--lens-card); border:1px dashed var(--lens-border); border-radius:14px; text-align:center; color:var(--lens-text-3);">No family members added yet.</div>';
    return;
  }
  wrap.innerHTML = family.map(f => {
    const icon = ({ Father: '👨', Mother: '👩', Spouse: '💑', Son: '👦', Daughter: '👧', Brother: '👬', Sister: '👭' })[f.Relationship] || '👤';
    const dob = f.DOB ? new Date(f.DOB).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    return `
      <article class="family-card">
        <div class="family-icon">${icon}</div>
        <div>
          <div class="family-name">${escape(f.Name)} <span style="font-size:11px; color:var(--lens-text-3); font-weight:normal;">— ${escape(f.Relationship)}</span></div>
          <div class="family-meta">${[f.Gender, dob, f.Occupation, f.Mobile].filter(Boolean).map(escape).join(' · ')}</div>
          <div style="margin-top:4px;">
            ${f.IsDependent ? '<span class="pill" style="background:#dcfce7; color:#166534; border:1px solid #a7f3d0; font-size:10px; padding:2px 6px; border-radius:8px;">Dependent</span>' : ''}
            ${f.IsEmergency ? '<span class="pill" style="background:#fef3c7; color:#92400e; border:1px solid #fde68a; font-size:10px; padding:2px 6px; border-radius:8px;">Emergency Contact</span>' : ''}
          </div>
        </div>
        <button class="remove-btn" onclick="removeFamily(${f.FamilyId})">Remove</button>
      </article>`;
  }).join('');
}

function showAddFamily() { document.getElementById('familyForm').style.display = ''; }
function hideAddFamily() { document.getElementById('familyForm').style.display = 'none'; }

async function saveFamily() {
  const payload = {
    name: document.getElementById('famName').value.trim(),
    relationship: document.getElementById('famRel').value,
    gender: document.getElementById('famGender').value || null,
    dob: document.getElementById('famDob').value || null,
    occupation: document.getElementById('famOcc').value.trim() || null,
    mobile: document.getElementById('famMob').value.trim() || null,
    isDependent: document.getElementById('famDep').checked,
    isEmergency: document.getElementById('famEmg').checked,
  };
  if (!payload.name) { alert('Name required'); return; }
  try {
    await apiRequest('/hr/employees/' + viewingUserId + '/family', { method: 'POST', body: payload });
    hideAddFamily();
    ['famName','famOcc','famMob','famDob'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('famDep').checked = false;
    document.getElementById('famEmg').checked = false;
    await load();
  } catch (e) { alert('Save failed: ' + (e.message || e)); }
}

async function removeFamily(fid) {
  if (!confirm('Remove this family member?')) return;
  try {
    await apiRequest('/hr/employees/family/' + fid, { method: 'DELETE' });
    await load();
  } catch (e) { alert('Delete failed: ' + (e.message || e)); }
}

// ── Documents ──────────────────────────────────────────────────────────────
function renderDocs() {
  const wrap = document.getElementById('docsList');
  if (!wrap) return;
  if (docs.length === 0) {
    wrap.innerHTML = '<div class="kv-pair" style="padding:20px; background:var(--lens-card); border:1px dashed var(--lens-border); border-radius:14px; text-align:center; color:var(--lens-text-3);">No documents uploaded yet.</div>';
    return;
  }
  wrap.innerHTML = docs.map(d => {
    const icon = ({ aadhaar: '🆔', pan: '🆔', passport: '📔', resume: '📝', 'offer-letter': '📨', 'experience-letter': '📃' })[d.DocType] || '📄';
    const uploaded = new Date(d.UploadedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const sizeKB = d.FileSize ? Math.round(d.FileSize / 1024) + ' KB' : '';
    return `
      <article class="doc-card">
        <div class="doc-icon">${icon}</div>
        <div>
          <div class="doc-name">${escape(d.DocName)} <span style="font-size:11px; color:var(--lens-text-3); font-weight:normal;">— ${escape(d.DocType)}</span></div>
          <div class="doc-meta">Uploaded ${uploaded} by ${escape(d.UploadedByName || 'HR')} ${sizeKB ? '· ' + sizeKB : ''} · <a href="${escape(d.FileUrl)}" target="_blank" style="color:#2563eb;">View</a></div>
        </div>
        <button class="remove-btn" onclick="removeDoc(${d.DocId})">Remove</button>
      </article>`;
  }).join('');
}

async function uploadDoc() {
  const fileEl = document.getElementById('docFile');
  if (!fileEl.files || fileEl.files.length === 0) return;
  const file = fileEl.files[0];
  const docType = document.getElementById('docType').value;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('docType', docType);
  fd.append('docName', file.name);
  const token = localStorage.getItem('nav_token') || sessionStorage.getItem('nav_token');
  try {
    const res = await fetch('/api/hr/employees/' + viewingUserId + '/documents?company=' + (sessionStorage.getItem('nav_company') || 'COMPANYA'), {
      method: 'POST',
      headers: { 'Authorization': token },
      body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Upload failed: ' + (err.message || res.statusText));
      return;
    }
    fileEl.value = '';
    await load();
  } catch (e) { alert('Upload failed: ' + (e.message || e)); }
}

async function removeDoc(id) {
  if (!confirm('Remove this document?')) return;
  try {
    await apiRequest('/hr/employees/documents/' + id, { method: 'DELETE' });
    await load();
  } catch (e) { alert('Delete failed: ' + (e.message || e)); }
}

// ── Position History ───────────────────────────────────────────────────────
function renderPositions() {
  const wrap = document.getElementById('positionList');
  if (!wrap) return;
  const role = (user.role || '').toLowerCase();
  const canEdit = ['admin','operation head','director','hr','hr head'].includes(role);
  const addBtn = document.getElementById('addPosBtn');
  if (addBtn) addBtn.style.display = canEdit ? '' : 'none';
  if (positions.length === 0) {
    wrap.innerHTML = '<div class="kv-pair" style="padding:20px; background:var(--lens-card); border:1px dashed var(--lens-border); border-radius:14px; text-align:center; color:var(--lens-text-3);">No position history yet. HR can record promotions / transfers here.</div>';
    return;
  }
  wrap.innerHTML = positions.map(p => {
    const from = p.EffectiveFrom ? new Date(p.EffectiveFrom).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
    const to   = p.EffectiveTo   ? new Date(p.EffectiveTo).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})   : '<b style="color:#16a34a;">Current</b>';
    const reasonLabel = ({ 'promotion':'⬆ Promotion','transfer':'↔ Transfer','role-change':'✎ Role change','initial':'👋 Initial','reorg':'🔁 Reorg' })[p.ReasonForChange] || p.ReasonForChange;
    return `
      <article class="family-card" style="border-left-color:#2563eb;">
        <div class="family-icon">💼</div>
        <div>
          <div class="family-name">${escape(p.Designation)} <span style="font-size:11px; color:var(--lens-text-3); font-weight:normal;">— ${escape(p.Department || '')} ${p.Location ? '· ' + escape(p.Location) : ''}</span></div>
          <div class="family-meta">${from} → ${to} · ${reasonLabel}${p.ReportingManagerName ? ' · reports to ' + escape(p.ReportingManagerName) : ''}</div>
          ${p.Notes ? `<div style="font-size:12px; color:var(--lens-text-3); margin-top:4px; font-style:italic;">"${escape(p.Notes)}"</div>` : ''}
        </div>
        ${canEdit ? `<button class="remove-btn" onclick="removePosition(${p.HistoryId})">Remove</button>` : '<div></div>'}
      </article>`;
  }).join('');
}
function showAddPosition() { document.getElementById('positionForm').style.display = ''; }
function hideAddPosition() { document.getElementById('positionForm').style.display = 'none'; }
async function savePosition() {
  const payload = {
    designation:     val('posDes'),
    department:      val('posDep') || null,
    location:        val('posLoc') || null,
    employeeType:    val('posET') || null,
    effectiveFrom:   val('posEF'),
    reasonForChange: val('posRFC'),
    notes:           val('posNotes') || null,
  };
  if (!payload.designation || !payload.effectiveFrom) { alert('Designation + Effective From required'); return; }
  try {
    await apiRequest('/hr/employees/' + viewingUserId + '/position', { method: 'POST', body: payload });
    hideAddPosition();
    ['posDes','posDep','posLoc','posET','posEF','posNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    await load();
  } catch (e) { alert('Save failed: ' + (e.message || e)); }
}
async function removePosition(id) {
  if (!confirm('Remove this position history entry?')) return;
  try { await apiRequest('/hr/employees/position/' + id, { method: 'DELETE' }); await load(); }
  catch (e) { alert('Delete failed: ' + (e.message || e)); }
}

// ── Previous Employment ────────────────────────────────────────────────────
function renderPrev() {
  const wrap = document.getElementById('prevList');
  if (!wrap) return;
  if (prevEmp.length === 0) {
    wrap.innerHTML = '<div class="kv-pair" style="padding:20px; background:var(--lens-card); border:1px dashed var(--lens-border); border-radius:14px; text-align:center; color:var(--lens-text-3);">No previous employment recorded.</div>';
    return;
  }
  wrap.innerHTML = prevEmp.map(p => {
    const from = p.FromDate ? new Date(p.FromDate).toLocaleDateString('en-IN',{month:'short',year:'numeric'}) : '—';
    const to   = p.ToDate   ? new Date(p.ToDate).toLocaleDateString('en-IN',{month:'short',year:'numeric'})   : '—';
    const sal  = p.LastSalary != null ? '₹ ' + new Intl.NumberFormat('en-IN').format(p.LastSalary) : '';
    return `
      <article class="family-card" style="border-left-color:#0891b2;">
        <div class="family-icon">🏢</div>
        <div>
          <div class="family-name">${escape(p.CompanyName)} ${p.Designation ? '<span style="font-size:11px; color:var(--lens-text-3); font-weight:normal;">— ' + escape(p.Designation) + '</span>' : ''}</div>
          <div class="family-meta">${from} → ${to}${sal ? ' · ' + sal + '/yr' : ''}</div>
          ${p.ReasonForLeaving ? `<div style="font-size:12px; color:var(--lens-text-3); margin-top:4px;">Left: ${escape(p.ReasonForLeaving)}</div>` : ''}
          ${p.Notes ? `<div style="font-size:12px; color:var(--lens-text-3); margin-top:2px; font-style:italic;">"${escape(p.Notes)}"</div>` : ''}
        </div>
        <button class="remove-btn" onclick="removePrev(${p.PrevId})">Remove</button>
      </article>`;
  }).join('');
}
function showAddPrev() { document.getElementById('prevForm').style.display = ''; }
function hideAddPrev() { document.getElementById('prevForm').style.display = 'none'; }
async function savePrev() {
  const payload = {
    companyName:      val('prevCo'),
    designation:      val('prevDes') || null,
    fromDate:         val('prevFD') || null,
    toDate:           val('prevTD') || null,
    lastSalary:       val('prevSal') ? Number(val('prevSal')) : null,
    reasonForLeaving: val('prevRFL') || null,
    notes:            val('prevNotes') || null,
  };
  if (!payload.companyName) { alert('Company Name required'); return; }
  try {
    await apiRequest('/hr/employees/' + viewingUserId + '/previous-employment', { method: 'POST', body: payload });
    hideAddPrev();
    ['prevCo','prevDes','prevFD','prevTD','prevSal','prevRFL','prevNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    await load();
  } catch (e) { alert('Save failed: ' + (e.message || e)); }
}
async function removePrev(id) {
  if (!confirm('Remove this previous employment?')) return;
  try { await apiRequest('/hr/employees/previous-employment/' + id, { method: 'DELETE' }); await load(); }
  catch (e) { alert('Delete failed: ' + (e.message || e)); }
}

// ── Nomination ─────────────────────────────────────────────────────────────
function renderNominations() {
  const wrap = document.getElementById('nomList');
  if (!wrap) return;
  if (nominations.length === 0) {
    wrap.innerHTML = '<div class="kv-pair" style="padding:20px; background:var(--lens-card); border:1px dashed var(--lens-border); border-radius:14px; text-align:center; color:var(--lens-text-3);">No nominees added.</div>';
    return;
  }
  // group by scheme
  const bySch = {};
  nominations.forEach(n => { (bySch[n.SchemeKind] = bySch[n.SchemeKind] || []).push(n); });
  wrap.innerHTML = Object.entries(bySch).map(([scheme, list]) => {
    const total = list.reduce((s, x) => s + Number(x.SharePct || 0), 0);
    const schEmoji = ({ PF:'💰', Gratuity:'🎁', Insurance:'🛡', Bonus:'💵', Other:'🏷' })[scheme] || '🏷';
    const totalOk = Math.abs(total - 100) < 0.01;
    return `
      <div style="margin-bottom:18px;">
        <div class="section-header" style="margin:6px 0;">
          <h3 style="font-size:13px;">${schEmoji} ${escape(scheme)}</h3>
          <span class="lens-sub" style="color:${totalOk ? 'var(--lens-text-3)' : '#ef4444'};">Total share: <b>${total.toFixed(0)}%</b>${totalOk ? ' ✓' : ' (must = 100)'}</span>
        </div>
        ${list.map(n => `
          <article class="family-card" style="border-left-color:#a855f7;">
            <div class="family-icon">👤</div>
            <div>
              <div class="family-name">${escape(n.NomineeName)} <span style="font-size:11px; color:var(--lens-text-3); font-weight:normal;">— ${escape(n.Relationship)}</span></div>
              <div class="family-meta">${Number(n.SharePct).toFixed(0)}% share${n.DOB ? ' · DOB ' + new Date(n.DOB).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : ''}${n.Address ? ' · ' + escape(n.Address) : ''}</div>
            </div>
            <button class="remove-btn" onclick="removeNom(${n.NominationId})">Remove</button>
          </article>`).join('')}
      </div>`;
  }).join('');
}
function showAddNom() { document.getElementById('nomForm').style.display = ''; }
function hideAddNom() { document.getElementById('nomForm').style.display = 'none'; }
async function saveNom() {
  const payload = {
    schemeKind:   val('nomScheme'),
    nomineeName:  val('nomName'),
    relationship: val('nomRel'),
    dob:          val('nomDob') || null,
    address:      val('nomAddr') || null,
    sharePct:     Number(val('nomShare') || 100),
  };
  if (!payload.schemeKind || !payload.nomineeName || !payload.relationship) { alert('Scheme / Name / Relationship required'); return; }
  try {
    await apiRequest('/hr/employees/' + viewingUserId + '/nomination', { method: 'POST', body: payload });
    hideAddNom();
    ['nomName','nomAddr','nomDob'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('nomShare').value = 100;
    await load();
  } catch (e) { alert('Save failed: ' + (e.message || e)); }
}
async function removeNom(id) {
  if (!confirm('Remove this nominee?')) return;
  try { await apiRequest('/hr/employees/nomination/' + id, { method: 'DELETE' }); await load(); }
  catch (e) { alert('Delete failed: ' + (e.message || e)); }
}

// ── Separation ─────────────────────────────────────────────────────────────
function renderSeparation() {
  const wrap = document.getElementById('separationContent');
  if (!wrap) return;
  const role = (user.role || '').toLowerCase();
  const isAdminish = ['admin','operation head','director','hr','hr head'].includes(role);
  const isSelf = Number(user.id) === Number(viewingUserId);
  const resigned = !!profile.ResignDate;

  if (!resigned) {
    if (isSelf) {
      wrap.innerHTML = `
        <div class="kv-pair" style="padding:24px; background:var(--lens-card); border:1px solid var(--lens-border); border-radius:14px; text-align:center;">
          <div style="font-size:48px; margin-bottom:10px;">✋</div>
          <div style="font-size:16px; color:var(--lens-text); font-weight:600;">No active resignation</div>
          <div style="font-size:13px; color:var(--lens-text-3); margin:8px 0 16px;">Take this step carefully — initiating resignation will notify your manager and HR.</div>
          <button class="emp-add-btn" style="background:#ef4444; box-shadow:0 6px 14px rgba(239,68,68,0.25);" onclick="applyResign()">Initiate Resignation</button>
        </div>`;
    } else {
      wrap.innerHTML = `<div class="kv-pair" style="padding:20px; background:var(--lens-card); border:1px dashed var(--lens-border); border-radius:14px; text-align:center; color:var(--lens-text-3);">Employee is active. No separation record.</div>`;
    }
    return;
  }

  const fmt = (d) => d ? new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  wrap.innerHTML = `
    <div class="kv-grid" id="kv-resign"></div>
    <div class="section-header" style="margin-top:18px;"><h3>Exit Interview</h3></div>
    <div class="kv-grid" id="kv-exit"></div>
    ${isAdminish ? `
      <div class="section-header" style="margin-top:18px;"><h3>HR Actions</h3></div>
      <div class="wiz-card">
        <div class="field-row">
          <div class="field"><label>Last Working Day</label><input type="date" id="sepLWD" value="${profile.LastWorkingDay ? String(profile.LastWorkingDay).slice(0,10) : ''}" /></div>
          <div class="field"><label>Settled On</label><input type="date" id="sepSettledOn" value="${profile.SettledOn ? String(profile.SettledOn).slice(0,10) : ''}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Exit Interview Date</label><input type="date" id="sepInterviewDate" value="${profile.ExitInterviewDate ? String(profile.ExitInterviewDate).slice(0,10) : ''}" /></div>
          <div class="field"><label>Notice Period (days)</label><input type="number" id="sepNoticeDays" value="${profile.NoticePeriodDays || ''}" /></div>
        </div>
        <div class="field-row">
          <div class="toggle-row"><input type="checkbox" id="sepNoticeServed" ${profile.NoticeServed ? 'checked' : ''} /><label for="sepNoticeServed">Notice fully served</label></div>
          <div class="toggle-row"><input type="checkbox" id="sepFitToRehire" ${profile.FitToBeRehired ? 'checked' : ''} /><label for="sepFitToRehire">Fit to be rehired</label></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Alternate Email (post-exit)</label><input type="email" id="sepAltEmail" value="${escape(profile.AltEmailOnExit || '')}" /></div>
          <div class="field"><label>Alternate Mobile (post-exit)</label><input type="tel" id="sepAltMobile" value="${escape(profile.AltMobileOnExit || '')}" /></div>
        </div>
        <div class="field-row full">
          <div class="field"><label>Exit Interview Notes</label><textarea id="sepInterviewNotes" rows="3">${escape(profile.ExitInterviewNotes || '')}</textarea></div>
        </div>
        <div class="wiz-actions">
          <div></div>
          <button class="wiz-next-btn" onclick="saveSeparation()">✓ Save Separation Details</button>
        </div>
      </div>
    ` : ''}`;
  renderKV('kv-resign', [
    ['Resignation Date', 'ResignDate', 'date'],
    ['Last Working Day', 'LastWorkingDay', 'date'],
    ['Settled On', 'SettledOn', 'date'],
    ['Notice Served', 'NoticeServed', 'bool'],
    ['Notice Period (days)', 'NoticePeriodDays'],
    ['Fit to be rehired', 'FitToBeRehired', 'bool'],
    ['Reason', 'ResignationReason'],
    ['Alt Email', 'AltEmailOnExit'],
    ['Alt Mobile', 'AltMobileOnExit'],
  ]);
  renderKV('kv-exit', [
    ['Exit Interview Date', 'ExitInterviewDate', 'date'],
    ['Exit Notes', 'ExitInterviewNotes'],
  ]);
}

async function applyResign() {
  const reason = prompt('Reason for resignation (required):');
  if (!reason || !reason.trim()) return;
  const proposed = prompt('Proposed last working day (YYYY-MM-DD):');
  try {
    await apiRequest('/hr/employees/' + viewingUserId, {
      method: 'PATCH',
      body: {
        resignDate: new Date().toISOString().slice(0, 10),
        resignationReason: reason.trim(),
        lastWorkingDay: proposed || null,
      },
    });
    await load();
  } catch (e) { alert('Resign failed: ' + (e.message || e)); }
}

async function saveSeparation() {
  const payload = {
    lastWorkingDay:    val('sepLWD') || null,
    settledOn:         val('sepSettledOn') || null,
    exitInterviewDate: val('sepInterviewDate') || null,
    noticePeriodDays:  val('sepNoticeDays') ? Number(val('sepNoticeDays')) : null,
    noticeServed:      document.getElementById('sepNoticeServed').checked,
    fitToBeRehired:    document.getElementById('sepFitToRehire').checked,
    altEmailOnExit:    val('sepAltEmail') || null,
    altMobileOnExit:   val('sepAltMobile') || null,
    exitInterviewNotes: val('sepInterviewNotes') || null,
  };
  try {
    await apiRequest('/hr/employees/' + viewingUserId, { method: 'PATCH', body: payload });
    await load();
    alert('Saved.');
  } catch (e) { alert('Save failed: ' + (e.message || e)); }
}

function val(id) { const el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
