// ============================================================================
// ONE App Lens — Add Employee wizard (HR-only)
// ============================================================================
const user = requireAuth();
let currentStep = 1;

window.next = next;
window.submitForm = submitForm;

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
  if (typeof renderSidebar === 'function') renderSidebar('employee-add');
  await loadOffices();
  setupGatedFields();
}

// Wire each Statutory checkbox to enable/disable its related number inputs.
function setupGatedFields() {
  const wirings = [
    { checkbox: 'includePF',  fields: ['pfNo', 'pfUan'], hideHint: ['pfNoHint', 'pfUanHint'], hostField: ['pfNoField', 'pfUanField'] },
    { checkbox: 'includeESI', fields: ['esiNo'],         hideHint: ['esiNoHint'],            hostField: ['esiNoField'] },
  ];
  wirings.forEach(({ checkbox, fields, hideHint, hostField }) => {
    const cb = document.getElementById(checkbox);
    if (!cb) return;
    function apply() {
      const on = cb.checked;
      fields.forEach((fid, i) => {
        const el = document.getElementById(fid);
        if (!el) return;
        el.disabled = !on;
        if (!on) el.value = '';        // clear value when disabling
        const host = document.getElementById(hostField[i]);
        if (host) host.classList.toggle('disabled', !on);
        const hint = document.getElementById(hideHint[i]);
        if (hint) hint.style.display = on ? 'none' : '';
      });
    }
    cb.addEventListener('change', apply);
    apply();  // initial state
  });
}

async function loadOffices() {
  try {
    const r = await apiRequest('/hr/office-presence/employees');
    const sel = document.getElementById('officeId');
    const offices = r.offices || [];
    sel.innerHTML = '<option value="">— None —</option>' +
      offices.map(o => `<option value="${o.GeofenceId}">${escape(o.Name)} (${escape(o.City || '—')})</option>`).join('');
  } catch (e) { /* silent — picker is optional */ }
}

function next(step) {
  if (step > currentStep) {
    // Validate the current step before advancing
    if (currentStep === 1) {
      if (!document.getElementById('firstName').value.trim() || !document.getElementById('lastName').value.trim()) {
        alert('First Name and Last Name are required.');
        return;
      }
    }
    if (currentStep === 3) {
      const pan = document.getElementById('pan').value.trim().toUpperCase();
      const aad = document.getElementById('aadhaar').value.trim().replace(/\s+/g, '');
      if (!pan)                                  { alert('PAN Number is required.'); return; }
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan))  { alert('PAN format invalid. Expected 10 chars like ABCDE1234F.'); return; }
      if (!aad)                                  { alert('Aadhaar Number is required.'); return; }
      if (!/^\d{12}$/.test(aad))                 { alert('Aadhaar must be 12 digits.'); return; }
      // Normalise back into the input
      document.getElementById('pan').value = pan;
      document.getElementById('aadhaar').value = aad;
    }
  }
  document.getElementById('step' + currentStep).style.display = 'none';
  document.getElementById('step' + step).style.display = '';
  currentStep = step;
  // Update indicator
  document.querySelectorAll('.wiz-step').forEach(el => {
    const n = parseInt(el.dataset.step);
    el.classList.toggle('active', n === currentStep);
    el.classList.toggle('done',  n <  currentStep);
  });
  window.scrollTo(0, 0);
}

async function submitForm() {
  const err = document.getElementById('formError'); err.style.display = 'none';
  const success = document.getElementById('formSuccess'); success.style.display = 'none';

  const payload = {
    title:         val('title'),
    firstName:     val('firstName'),
    middleName:    val('middleName'),
    lastName:      val('lastName'),
    gender:        val('gender'),
    dob:           val('dob'),
    mobile:        val('mobile'),
    personalEmail: val('personalEmail'),

    dateOfJoining: val('dateOfJoining'),
    employeeType:  val('employeeType'),
    designation:   val('designation'),
    department:    val('department'),
    location:      val('location'),
    officeId:      val('officeId') ? parseInt(val('officeId')) : null,

    pan:           val('pan'),
    aadhaar:       val('aadhaar'),
    includePF:     document.getElementById('includePF').checked,
    includeESI:    document.getElementById('includeESI').checked,
    includeLWF:    document.getElementById('includeLWF').checked,
    pfNo:          val('pfNo'),
    pfUan:         val('pfUan'),
    esiNo:         val('esiNo'),

    paymentMode:   val('paymentMode'),
    bankName:      val('bankName'),
    bankAccountNo: val('bankAccountNo'),
    ifsc:          val('ifsc'),
    bankBranch:    val('bankBranch'),

    email:         val('email'),
    password:      val('password'),
    role:          val('role'),
    companyaCode:       val('companyaCode'),
    companybCode:    val('companybCode'),
  };

  // Validate required fields (defence in depth — wizard also validates per step)
  if (!payload.firstName || !payload.lastName) { err.textContent = 'First Name and Last Name are required'; err.style.display = 'block'; return; }
  if (!payload.pan || !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(payload.pan.toUpperCase())) { err.textContent = 'PAN Number is required (format ABCDE1234F)'; err.style.display = 'block'; return; }
  if (!payload.aadhaar || !/^\d{12}$/.test((payload.aadhaar || '').replace(/\s+/g, ''))) { err.textContent = 'Aadhaar Number is required (12 digits)'; err.style.display = 'block'; return; }
  if (!payload.email || !/^[^@]+@[^@]+\.[^@]+$/.test(payload.email)) { err.textContent = 'Valid Work Email is required'; err.style.display = 'block'; return; }
  if (!payload.password || payload.password.length < 6) { err.textContent = 'Initial Password must be 6+ characters'; err.style.display = 'block'; return; }
  if (!payload.role) { err.textContent = 'Role is required'; err.style.display = 'block'; return; }

  try {
    const r = await apiRequest('/hr/employees', { method: 'POST', body: payload });
    if (r && r.ok) {
      document.getElementById('successMsg').innerHTML = `${escape(r.fullName)} added. <a href="/modules/hr/employee-profile.html?id=${r.userId}" style="color:#166534;font-weight:600;">View profile →</a> · <a href="/modules/hr/employees.html" style="color:#166534;font-weight:600;">Back to list</a>`;
      success.style.display = 'block';
      document.querySelector('.wiz-next-btn.finish').style.display = 'none';
    } else {
      err.textContent = (r && r.message) || 'Create failed';
      err.style.display = 'block';
    }
  } catch (e) {
    err.textContent = e.message || 'Create failed';
    err.style.display = 'block';
  }
}

function val(id) { const el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
