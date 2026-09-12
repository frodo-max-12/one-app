/* warehouse/expenses.js — CRUD page for BN_WhExpense. */

(function () {
  const ENDPOINT = '/warehouse/expenses';
  let page = 1, limit = 50, search = '', dateFrom = '', dateTo = '', editingId = null;

  document.addEventListener('DOMContentLoaded', () => {
    const u = requireAuth(); if (!u) return;
    renderSidebar('wh-expenses');
    const rt = document.getElementById('roleTag');
    if (rt) rt.textContent = (u.role || '').toUpperCase();

    document.getElementById('whSearch').addEventListener('input', debounce(() => {
      search = document.getElementById('whSearch').value.trim();
      page = 1; load();
    }, 280));
    document.getElementById('whApply').addEventListener('click', () => {
      dateFrom = document.getElementById('whFrom').value;
      dateTo   = document.getElementById('whTo').value;
      page = 1; load();
    });

    const canWrite = WH.canWrite();
    const addBtn = document.getElementById('whAdd');
    if (canWrite) {
      addBtn.onclick = () => openEdit(null);
      WH.wireImport('whImport', 'whFile', ENDPOINT, load);
    } else {
      addBtn.style.display = 'none';
      document.getElementById('whImport').style.display = 'none';
    }
    WH.wireExport('whExport', ENDPOINT, () => ({ search, dateFrom, dateTo }));

    document.getElementById('whModalClose').onclick = () => WH.closeModal('whModal');
    document.getElementById('whCancel').onclick      = () => WH.closeModal('whModal');
    document.getElementById('whForm').addEventListener('submit', onSave);

    load();
  });

  async function load() {
    const tbody = document.getElementById('whTbody');
    tbody.innerHTML = `<tr><td colspan="6" class="wh-loading">Loading…</td></tr>`;
    try {
      const url = ENDPOINT + WH.qs({ search, dateFrom, dateTo, page, limit });
      const res = await apiRequest(url);
      const rows = (res && res.data) || [];
      const totAmt = res?.totalAmount || 0;
      document.getElementById('whCount').textContent =
        (res?.total || 0) + ' expenses · ' + WH.fmt2(totAmt);
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="wh-empty">No expenses found.</td></tr>`;
      } else {
        tbody.innerHTML = rows.map(rowHtml).join('');
        tbody.querySelectorAll('button[data-edit]').forEach(b => b.onclick = () => openEdit(Number(b.dataset.edit)));
        tbody.querySelectorAll('button[data-del]').forEach(b  => b.onclick = () => WH.deleteRow(ENDPOINT, Number(b.dataset.del), load));
      }
      WH.renderPaging('whPaging', res?.total || 0, page, limit, (p) => { page = p; load(); });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="wh-empty">Failed to load: ${WH.esc(e.message)}</td></tr>`;
    }
  }

  function rowHtml(r) {
    const canWrite = WH.canWrite();
    return `<tr>
      <td>${WH.fmtDate(r.ExpenseDate)}</td>
      <td>${WH.esc(r.Explanation || '')}</td>
      <td class="num">${WH.fmt2(r.Amount)}</td>
      <td>${WH.esc(r.Currency || '')}</td>
      <td>${WH.esc(r.Remark || '')}</td>
      <td class="actions">
        ${canWrite ? `<button data-edit="${r.Id}">Edit</button>
                     <button class="btn-del" data-del="${r.Id}">Del</button>` : ''}
      </td>
    </tr>`;
  }

  async function openEdit(id) {
    editingId = id;
    const form = document.getElementById('whForm');
    form.reset();
    document.getElementById('whModalTitle').textContent = id ? 'Edit Expense' : 'Add Expense';
    if (id) {
      try {
        const res = await apiRequest(ENDPOINT + '/' + id);
        const d = res?.data; if (!d) throw new Error('Expense not found');
        form.elements.Explanation.value = d.Explanation || '';
        form.elements.Amount.value      = d.Amount ?? '';
        form.elements.Currency.value    = d.Currency || 'SGD';
        form.elements.Remark.value      = d.Remark || '';
        form.elements.ExpenseDate.value = WH.toInputDate(d.ExpenseDate);
      } catch (e) { WH.toast(e.message, 'error'); return; }
    } else {
      form.elements.ExpenseDate.value = new Date().toISOString().slice(0, 10);
    }
    WH.openModal('whModal');
  }

  async function onSave(e) {
    e.preventDefault();
    const form = document.getElementById('whForm');
    const payload = {};
    for (const f of form.elements) { if (f.name) payload[f.name] = WH.formVal(form, f.name); }
    try {
      const url = editingId ? ENDPOINT + '/' + editingId : ENDPOINT;
      const method = editingId ? 'PUT' : 'POST';
      const r = await apiRequest(url, { method, body: payload });
      if (r && r.ok) { WH.toast(editingId ? 'Updated' : 'Created', 'success'); WH.closeModal('whModal'); load(); }
      else WH.toast(r?.message || 'Save failed', 'error');
    } catch (err) { WH.toast(err.message || 'Save failed', 'error'); }
  }
})();
