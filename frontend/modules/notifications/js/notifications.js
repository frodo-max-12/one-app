// notifications.js — the full Notification Center page.
// Reuses the shared bell helpers/icons from common.js (_notifIcon, _timeAgo, _esc, apiRequest).
(function () {
  const user = requireAuth();
  if (!user) return;
  if (typeof renderSidebar === 'function') renderSidebar('notifications');
  if (typeof setRoleTag === 'function') setRoleTag();

  const PAGE = 30;
  let filter = 'all';     // all | unread
  let offset = 0;
  let loading = false;

  const listEl = () => document.getElementById('ncList');
  const moreBtn = () => document.getElementById('ncMore');

  async function load(reset) {
    if (loading) return;
    loading = true;
    if (reset) { offset = 0; listEl().innerHTML = '<div class="nc-empty">Loading…</div>'; }
    try {
      const q = `/notifications?limit=${PAGE}&offset=${offset}${filter === 'unread' ? '&unreadOnly=1' : ''}`;
      const r = await apiRequest(q);
      const rows = (r && r.rows) || [];
      if (reset) listEl().innerHTML = '';
      if (offset === 0 && !rows.length) {
        listEl().innerHTML = `<div class="nc-empty">${filter === 'unread' ? 'No unread notifications 🎉' : 'No notifications yet.'}</div>`;
        moreBtn().style.display = 'none';
        return;
      }
      listEl().insertAdjacentHTML('beforeend', rows.map(cardHtml).join(''));
      bindCards();
      offset += rows.length;
      moreBtn().style.display = rows.length === PAGE ? 'inline-flex' : 'none';
    } catch (e) {
      if (reset) listEl().innerHTML = '<div class="nc-empty">Couldn\'t load notifications.</div>';
    } finally { loading = false; }
  }

  function cardHtml(n) {
    const sev = (n.Severity || 'info');
    return `
      <div class="nc-card nc-sev-${sev} ${n.IsRead ? '' : 'unread'}" data-id="${n.NotifId}" data-link="${n.DeepLink || ''}">
        <div class="nc-ic">${_notifIcon(n.Type)}</div>
        <div class="nc-bd">
          <div class="nc-row1">
            <p class="nc-ti">${_esc(n.Title)}</p>
            ${n.Category ? `<span class="nc-cat">${_esc(n.Category)}</span>` : ''}
          </div>
          ${n.Body ? `<p class="nc-tx">${_esc(n.Body)}</p>` : ''}
          <div class="nc-tm">${_timeAgo(n.CreatedAt)}</div>
        </div>
        <button class="nc-x" data-dismiss="${n.NotifId}" title="Dismiss">✕</button>
      </div>`;
  }

  function bindCards() {
    listEl().querySelectorAll('.nc-card').forEach(card => {
      if (card._bound) return; card._bound = true;
      card.addEventListener('click', async (e) => {
        if (e.target.classList.contains('nc-x')) return;
        const id = card.dataset.id, link = card.dataset.link;
        try { await apiRequest('/notifications/' + id + '/read', { method: 'POST' }); } catch (_) {}
        card.classList.remove('unread');
        if (typeof _notifRefreshCount === 'function') _notifRefreshCount();
        if (link) window.location.href = link;
      });
      const x = card.querySelector('.nc-x');
      if (x) x.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = x.dataset.dismiss;
        try { await apiRequest('/notifications/' + id, { method: 'DELETE' }); } catch (_) {}
        card.remove();
        if (typeof _notifRefreshCount === 'function') _notifRefreshCount();
      });
    });
  }

  // Tabs
  document.querySelectorAll('.nc-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.nc-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    filter = t.dataset.f;
    load(true);
  }));

  document.getElementById('ncMarkAll').addEventListener('click', async () => {
    try { await apiRequest('/notifications/read-all', { method: 'POST' }); } catch (_) {}
    if (typeof _notifRefreshCount === 'function') _notifRefreshCount();
    load(true);
  });
  document.getElementById('ncMore').addEventListener('click', () => load(false));

  load(true);
})();
