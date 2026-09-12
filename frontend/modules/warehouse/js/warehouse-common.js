/* warehouse-common.js — tiny helpers shared by every warehouse page.
   Keep this file dependency-free (only uses what /shared/common.js already
   loads: apiRequest, getUser, escapeHtml, debounce, fmtDate, fmtMoney). */

window.WH = (function () {
  const W = {};

  // ── Debounce (shared common.js doesn't define one) ────────────────
  W.debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  };

  // ── Number / date helpers ──────────────────────────────────────────
  W.fmtN = (v, dp) => {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '';
    return Number(v).toLocaleString('en-IN', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
  };
  W.fmt2 = (v) => W.fmtN(v, 2);
  W.fmt0 = (v) => W.fmtN(v, 0);
  // Timezone-safe date helpers.
  //
  // Fast-path applies ONLY to plain "YYYY-MM-DD" strings (10 chars exact),
  // because those come from backend SELECTs that already CONVERT DATE
  // columns to VARCHAR(10) — there's no time component to misinterpret.
  //
  // Anything with a time component (full ISO like
  // "2026-06-17T18:30:00.000Z") goes through new Date() + LOCAL getDate().
  // The earlier version used the same regex on full ISOs and grabbed the
  // UTC date prefix — for a DATE column stored as 2026-06-18 in IST the
  // driver returns a JS Date whose UTC is 2026-06-17T18:30Z, so slicing
  // the first 10 chars gave 2026-06-17 → DISPLAYED PREVIOUS DAY. Bug
  // surfaced on Stocks Inward Date 2026-06-18 (auto-stock from Purchase).
  W.fmtDate = (v) => {
    if (!v) return '';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return `${v.slice(8,10)}/${v.slice(5,7)}/${v.slice(0,4)}`;
    }
    const d = new Date(v);
    if (isNaN(d)) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  };
  W.toInputDate = (v) => {
    if (!v) return '';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (isNaN(d)) return '';
    const y  = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  };

  // ── Status pill renderer ───────────────────────────────────────────
  W.pill = (status) => {
    if (!status) return '';
    const cls = String(status).toLowerCase().replace(/\s+/g, '');
    return `<span class="wh-pill ${cls}">${W.esc(status)}</span>`;
  };

  // ── HTML escaper (mirrors common.js but doesn't depend on it) ─────
  W.esc = (s) => {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // ── Toast (uses /shared/common.js showToast if available) ─────────
  W.toast = (msg, type) => {
    if (typeof showToast === 'function') return showToast(msg, type);
    alert(msg);
  };

  // ── Modal open/close ───────────────────────────────────────────────
  W.openModal = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  };
  W.closeModal = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  };

  // ── Read-only / write detection ────────────────────────────────────
  W.canWrite = () => {
    const u = (typeof getUser === 'function') ? getUser() : null;
    return ((u && u.role) || '').toLowerCase().trim() === 'warehouse';
  };
  // Admin family — for the Edit-row gate (warehouse user can CREATE via
  // wizard but cannot modify existing rows; only admin can edit after save).
  W.isAdminFamily = () => {
    const u = (typeof getUser === 'function') ? getUser() : null;
    const role = ((u && u.role) || '').toLowerCase().trim();
    return ['admin', 'operation head', 'director'].includes(role);
  };

  // ── Confirm + delete helper ────────────────────────────────────────
  W.deleteRow = async (endpoint, id, refresh) => {
    if (!confirm('Delete this row? (soft-delete — recoverable in DB)')) return;
    try {
      const r = await apiRequest(endpoint + '/' + id, { method: 'DELETE' });
      if (r && r.ok) { W.toast('Deleted', 'success'); refresh && refresh(); }
      else W.toast(r?.message || 'Delete failed', 'error');
    } catch (e) { W.toast(e.message || 'Delete failed', 'error'); }
  };

  // ── Form field helper: read a value from a form by name ───────────
  W.formVal = (form, name) => {
    const el = form.elements[name];
    if (!el) return null;
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number')   return el.value === '' ? null : Number(el.value);
    return el.value === '' ? null : el.value;
  };

  // ── Build URL-search-string from a plain object (skip blanks) ─────
  W.qs = (obj) => {
    const p = new URLSearchParams();
    Object.keys(obj).forEach(k => {
      const v = obj[k];
      if (v !== null && v !== undefined && v !== '') p.set(k, v);
    });
    const s = p.toString();
    return s ? '?' + s : '';
  };

  // ── Pagination renderer ────────────────────────────────────────────
  W.renderPaging = (containerId, total, page, limit, onPage) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    const pages = Math.max(1, Math.ceil(total / limit));
    const from = total === 0 ? 0 : (page - 1) * limit + 1;
    const to   = Math.min(total, page * limit);
    el.innerHTML = `
      <span>${from}-${to} of ${total}</span>
      <button ${page <= 1 ? 'disabled' : ''} data-pg="${page - 1}">← Prev</button>
      <span>Page ${page} of ${pages}</span>
      <button ${page >= pages ? 'disabled' : ''} data-pg="${page + 1}">Next →</button>
    `;
    el.querySelectorAll('button[data-pg]').forEach(b => {
      b.onclick = () => onPage(Number(b.dataset.pg));
    });
  };

  // ── Import: triggers hidden file input, uploads to /import ────────
  // Pass { endpoint, onDone } — onDone is called after a successful import.
  W.wireImport = (btnId, fileInputId, endpoint, onDone) => {
    const btn  = document.getElementById(btnId);
    const file = document.getElementById(fileInputId);
    if (!btn || !file) return;
    btn.onclick = () => file.click();
    file.addEventListener('change', async () => {
      if (!file.files || !file.files[0]) return;
      const fd = new FormData();
      fd.append('file', file.files[0]);
      const token   = (typeof getToken === 'function') ? getToken() : null;
      const company = (typeof getCompany === 'function') ? getCompany() : 'COMPANYB';
      btn.disabled = true; btn.textContent = '⏳ Importing…';
      try {
        const res = await fetch(`/api${endpoint}/import?company=${encodeURIComponent(company)}`, {
          method:  'POST',
          headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
          body:    fd,
        });
        let data = {}; try { data = await res.json(); } catch (_) {}
        if (res.status === 401 || res.status === 403) {
          W.toast(data.message || 'Permission denied — only the warehouse user can import', 'error');
        } else if (!res.ok) {
          W.toast(data.message || ('Import failed: HTTP ' + res.status), 'error');
        } else {
          const msg = `Imported ${data.inserted || 0} row(s)`
                    + (data.failed ? `, ${data.failed} failed` : '')
                    + (data.sheet  ? ` from "${data.sheet}"` : '');
          W.toast(msg, 'success');
          if (data.errors && data.errors.length) console.warn('Import errors (first 10):', data.errors);
          onDone && onDone();
        }
      } catch (e) { W.toast(e.message || 'Import failed', 'error'); }
      finally {
        btn.disabled = false; btn.textContent = '⇧ Import Excel';
        file.value = '';   // allow re-uploading the same file
      }
    });
  };

  // ── Export: GET /export?…filters → blob download ──────────────────
  W.wireExport = (btnId, endpoint, getFilters) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.onclick = async () => {
      const filters = (typeof getFilters === 'function') ? (getFilters() || {}) : {};
      const token   = (typeof getToken   === 'function') ? getToken()           : null;
      const company = (typeof getCompany === 'function') ? getCompany()         : 'COMPANYB';
      const qs = W.qs({ ...filters, company });
      btn.disabled = true; btn.textContent = '⏳ Exporting…';
      try {
        const res = await fetch(`/api${endpoint}/export${qs}`, {
          headers: { 'X-Company': company, ...(token ? { Authorization: token } : {}) },
        });
        if (res.status === 401 || res.status === 403) { W.toast('Permission denied', 'error'); return; }
        if (!res.ok) { W.toast('Export failed: HTTP ' + res.status, 'error'); return; }
        const blob = await res.blob();
        const cd = res.headers.get('content-disposition') || '';
        const m  = /filename="?([^"]+)"?/i.exec(cd);
        const fname = m ? m[1] : ('export_' + Date.now() + '.xlsx');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { W.toast(e.message || 'Export failed', 'error'); }
      finally { btn.disabled = false; btn.textContent = '⇩ Export Excel'; }
    };
  };

  return W;
})();

// Expose debounce globally so existing inline calls (debounce(fn, ms)) work
// without sprinkling WH.debounce everywhere. Other modules already do this.
if (typeof window !== 'undefined' && typeof window.debounce !== 'function') {
  window.debounce = window.WH.debounce;
}
