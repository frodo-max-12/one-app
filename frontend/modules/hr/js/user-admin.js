// User Management (admin / HR only) — list + edit login + reset password + activate.
(function () {
  'use strict';
  const LENS_ADMIN = ['admin', 'operation head', 'director', 'hr', 'hr head'];
  let allUsers = [];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function show(id, on) { const e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none'; }

  document.addEventListener('DOMContentLoaded', () => {
    const user = requireAuth(); if (!user) return;
    const role = (user.role || '').toLowerCase().trim();
    if (!LENS_ADMIN.includes(role)) { location.href = '/modules/hr/home.html'; return; }   // admin/HR only
    if (typeof renderSidebar === 'function') renderSidebar('user-admin');
    const rt = document.getElementById('roleTag'); if (rt) rt.textContent = user.name || user.username || '';
    document.getElementById('uaRefresh').addEventListener('click', loadUsers);
    document.getElementById('uaShowInactive').addEventListener('change', loadUsers);
    document.getElementById('uaSearch').addEventListener('input', renderTable);
    // Team-picker: toggling a member adds/removes BOTH their COMPANYA + CompanyB code(s)
    // (heads scope on both — DC File / reminders use CompanyACode AND CompanyBCode).
    document.getElementById('eTeamList').addEventListener('change', (e) => {
      const cb = e.target; if (!cb || cb.type !== 'checkbox') return;
      applyTeamCodes('eCompanyA', cb.dataset.codes,  cb.checked);
      applyTeamCodes('eAdv', cb.dataset.companyb, cb.checked);
    });
    loadUsers();
  });

  // ── Team picker (builds COMPANYA + CompanyB code lists by ticking people) ──
  function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
  // Add/remove a person's code(s) into a code field, deduped + cleaned (no trailing '/').
  function applyTeamCodes(fieldId, codesStr, add) {
    const codes = (codesStr || '').split('/').map(c => c.trim()).filter(Boolean);
    if (!codes.length) return;
    const el = document.getElementById(fieldId); if (!el) return;
    const set = new Set(el.value.split('/').map(c => c.trim()).filter(Boolean));
    if (add) codes.forEach(c => set.add(c)); else codes.forEach(c => set.delete(c));
    el.value = [...set].join('/');
  }
  window.uaToggleTeam = function () {
    const p = document.getElementById('eTeamPanel');
    const open = p.style.display === 'none';
    p.style.display = open ? '' : 'none';
    if (open) uaRenderTeam();
  };
  window.uaRenderTeam = function () {
    const q = (document.getElementById('eTeamSearch').value || '').toLowerCase().trim();
    const cur = new Set(document.getElementById('eCompanyA').value.split('/').map(c => c.trim()).filter(Boolean));
    const selfId = document.getElementById('eId').value;
    // Candidates = users who HAVE a COMPANYA code (salespeople/product/etc.), excluding the row being edited.
    const people = allUsers.filter(u => (u.CompanyACode || '').trim() && String(u.UserId) !== String(selfId)
      && (!q || String(u.Name || '').toLowerCase().includes(q) || String(u.CompanyACode || '').toLowerCase().includes(q)));
    document.getElementById('eTeamList').innerHTML = people.length ? people.map(u => {
      const codes = (u.CompanyACode || '').split('/').map(c => c.trim()).filter(Boolean);
      const checked = codes.some(c => cur.has(c));
      return `<label style="display:flex;gap:8px;align-items:center;padding:3px 0;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-codes="${escAttr(u.CompanyACode || '')}" data-companyb="${escAttr(u.CompanyBCode || '')}" ${checked ? 'checked' : ''} />
        <span>${esc(u.Name || '')}</span>
        <span class="td-mono" style="color:var(--text3);font-size:11px;">COMPANYA ${esc(u.CompanyACode || '—')}${u.CompanyBCode ? ' · Adv ' + esc(u.CompanyBCode) : ''}</span>
        <span style="color:var(--text3);font-size:11px;">${esc(u.Role || '')}</span>
      </label>`;
    }).join('') : '<div style="color:var(--text3);font-size:12px;">No people found.</div>';
  };

  async function loadUsers() {
    show('uaLoading', true); show('uaTable', false); show('uaEmpty', false);
    try {
      const inc = document.getElementById('uaShowInactive').checked;
      const reqs = [apiRequest('/hr/employees?active=true')];
      if (inc) reqs.push(apiRequest('/hr/employees?active=false'));
      const res = await Promise.all(reqs);
      allUsers = res.flatMap(r => (r && r.employees) || []);
      renderTable();
    } catch (e) {
      show('uaLoading', false); show('uaEmpty', true);
      document.querySelector('#uaEmpty .empty-text').textContent = 'Could not load users — ' + (e.message || e);
    }
  }

  function renderTable() {
    const q = (document.getElementById('uaSearch').value || '').toLowerCase().trim();
    const rows = allUsers.filter(u => !q ||
      [u.Name, u.Username, u.Role, u.CompanyACode, u.CompanyBCode].some(v => String(v || '').toLowerCase().includes(q)));
    document.getElementById('uaCount').textContent = `— ${rows.length}`;
    show('uaLoading', false);
    if (!rows.length) { show('uaTable', false); show('uaEmpty', true); return; }
    show('uaEmpty', false); show('uaTable', true);
    document.getElementById('uaBody').innerHTML = rows.map(u => `
      <tr>
        <td class="td-bold">${esc(u.Name || '—')}</td>
        <td>${esc(u.Username || '—')}</td>
        <td><span class="badge">${esc(u.Role || '—')}</span></td>
        <td class="td-mono">${esc(u.CompanyACode || '—')}</td>
        <td class="td-mono">${esc(u.CompanyBCode || '—')}</td>
        <td>${u.IsActive ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-amber">Inactive</span>'}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn-icon" title="Edit login" onclick='uaOpenEdit(${u.UserId})'>✎</button>
          <button class="btn-icon" title="Reset password" onclick='uaOpenPw(${u.UserId})'>🔑</button>
          <button class="btn-icon ${u.IsActive ? 'btn-icon-red' : ''}" title="${u.IsActive ? 'Deactivate' : 'Reactivate'}" onclick='uaToggle(${u.UserId})'>${u.IsActive ? '⨯' : '↺'}</button>
        </td>
      </tr>`).join('');
  }

  const byId = id => allUsers.find(u => u.UserId === id);

  // ── Edit login ──
  window.uaOpenEdit = function (id) {
    const u = byId(id); if (!u) return;
    document.getElementById('eId').value = id;
    document.getElementById('eName').value = u.Name || '';
    document.getElementById('eRole').value = (u.Role || '').toLowerCase();
    document.getElementById('eCompanyA').value = u.CompanyACode || '';
    document.getElementById('eAdv').value = u.CompanyBCode || '';
    document.getElementById('eEmail').value = u.Email || '';
    document.getElementById('ePhone').value = u.Phone || u.Mobile || '';
    document.getElementById('eActive').checked = !!u.IsActive;
    document.getElementById('uaEditTitle').textContent = 'Edit Login — ' + (u.Name || u.Username || '');
    document.getElementById('eTeamPanel').style.display = 'none';
    document.getElementById('eTeamSearch').value = '';
    show('uaEditErr', false);
    document.getElementById('uaEditOverlay').style.display = 'flex';
  };
  window.uaCloseEdit = function () { document.getElementById('uaEditOverlay').style.display = 'none'; };
  // Normalize a code field: dedupe, drop blanks, no trailing '/'.
  const cleanCodes = v => [...new Set(String(v || '').split('/').map(c => c.trim()).filter(Boolean))].join('/');
  window.uaSaveEdit = async function () {
    const id = document.getElementById('eId').value;
    const body = {
      name: document.getElementById('eName').value.trim(),
      role: document.getElementById('eRole').value,
      companyaCode: cleanCodes(document.getElementById('eCompanyA').value),
      companybCode: cleanCodes(document.getElementById('eAdv').value),
      email: document.getElementById('eEmail').value.trim(),
      phone: document.getElementById('ePhone').value.trim(),
      isActive: document.getElementById('eActive').checked,
    };
    try {
      await apiRequest(`/hr/employees/${id}/login`, { method: 'PATCH', body });
      uaCloseEdit(); loadUsers();
    } catch (e) {
      const el = document.getElementById('uaEditErr'); el.style.display = 'block'; el.textContent = e.message || 'Save failed';
    }
  };

  // ── Reset password ──
  window.uaOpenPw = function (id) {
    const u = byId(id); if (!u) return;
    document.getElementById('pwId').value = id;
    document.getElementById('pwWho').textContent = u.Name || u.Username || '';
    document.getElementById('pwVal').value = '';
    show('uaPwErr', false);
    document.getElementById('uaPwOverlay').style.display = 'flex';
  };
  window.uaClosePw = function () { document.getElementById('uaPwOverlay').style.display = 'none'; };
  window.uaSavePw = async function () {
    const id = document.getElementById('pwId').value;
    const password = document.getElementById('pwVal').value;
    if (password.length < 6) { const el = document.getElementById('uaPwErr'); el.style.display = 'block'; el.textContent = 'Password must be at least 6 characters.'; return; }
    try {
      await apiRequest(`/hr/employees/${id}/reset-password`, { method: 'POST', body: { password } });
      uaClosePw(); alert('Password updated.');
    } catch (e) {
      const el = document.getElementById('uaPwErr'); el.style.display = 'block'; el.textContent = e.message || 'Reset failed';
    }
  };

  // ── Activate / deactivate ──
  window.uaToggle = async function (id) {
    const u = byId(id); if (!u) return;
    const to = !u.IsActive;
    if (!confirm(`${to ? 'Reactivate' : 'Deactivate'} ${u.Name || u.Username}? ${to ? 'They will be able to log in.' : 'They will NOT be able to log in.'}`)) return;
    try { await apiRequest(`/hr/employees/${id}/login`, { method: 'PATCH', body: { isActive: to } }); loadUsers(); }
    catch (e) { alert('Failed: ' + (e.message || e)); }
  };
})();
