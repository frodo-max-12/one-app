// HR/heads view: where each employee signed in & out on a given day (incl. WFH).
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtTime(iso) { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }); }
  function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function mapLink(lat, lng) { if (lat == null || lng == null) return ''; return `<a class="sl-map" href="https://maps.google.com/?q=${lat},${lng}" target="_blank" rel="noopener">📍 map</a>`; }
  function badge(place, wfh) {
    if (!place || place === '—') return '<span class="sl-sub">—</span>';
    const cls = wfh ? 'wfh' : (/^office/i.test(place) ? 'office' : 'site');
    return `<span class="sl-badge ${cls}">${esc(place)}</span>`;
  }
  function hhmm(min) { if (!min) return '—'; return Math.floor(min / 60) + 'h ' + (min % 60) + 'm'; }

  window.clearFilters = function () {
    document.getElementById('slDate').value = today();
    document.getElementById('slCompany').value = '';
    document.getElementById('slSearch').value = '';
    load();
  };

  window.load = async function () {
    const date = document.getElementById('slDate').value || today();
    const co = document.getElementById('slCompany').value;
    const q = document.getElementById('slSearch').value.trim();
    const params = new URLSearchParams({ date });
    if (co) params.set('company', co);
    if (q) params.set('q', q);
    document.getElementById('slBody').innerHTML = `<tr><td colspan="6" class="sl-loading">Loading…</td></tr>`;
    try {
      const data = await apiRequest('/hr/attendance/sign-locations?' + params.toString());
      const rows = data.data || [];
      document.getElementById('slCount').textContent = `${data.total || 0} session${data.total === 1 ? '' : 's'}`;
      document.getElementById('slTotal').textContent = data.total || 0;
      document.getElementById('slWfh').textContent = data.wfhCount || 0;
      if (!rows.length) { document.getElementById('slBody').innerHTML = `<tr><td colspan="6" class="sl-loading">No sign-ins recorded for this day.</td></tr>`; return; }
      document.getElementById('slBody').innerHTML = rows.map(r => `
        <tr>
          <td>
            <div class="sl-emp">${esc(r.UserName || '—')}</div>
            <div class="sl-sub">${esc(r.UserCode || '')}${r.UserRole ? ' · ' + esc(r.UserRole) : ''}${r.Session > 1 ? ' · S' + r.Session : ''}</div>
          </td>
          <td><span class="sl-time">${fmtTime(r.SignInTime)}</span></td>
          <td>${badge(r.SignInPlace, r.SignInWfh)}${mapLink(r.SignInLat, r.SignInLng)}</td>
          <td><span class="sl-time">${fmtTime(r.SignOutTime)}</span></td>
          <td>${r.SignOutTime ? badge(r.SignOutPlace, r.SignOutWfh) + mapLink(r.SignOutLat, r.SignOutLng) : '<span class="sl-sub">still signed in</span>'}</td>
          <td class="r">${hhmm(r.TotalWorkMin)}</td>
        </tr>`).join('');
    } catch (e) {
      document.getElementById('slBody').innerHTML = `<tr><td colspan="6" class="sl-loading" style="color:var(--red);">Failed: ${esc(e.message || e)}</td></tr>`;
    }
  };

  document.getElementById('slSearch').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof requireAuth === 'function') requireAuth();                       // theme + toggle
    if (typeof renderSidebar === 'function') renderSidebar('sign-locations');   // left rail
    const rt = document.getElementById('roleTag');
    try { const u = JSON.parse(localStorage.getItem('nav_user') || sessionStorage.getItem('nav_user') || '{}'); if (rt && u.name) rt.textContent = u.name; } catch (_) {}
    document.getElementById('slDate').value = today();
    load();
  });
})();
