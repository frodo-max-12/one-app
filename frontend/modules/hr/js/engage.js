// =====================================================================
// modules/hr/js/engage.js — Engage feed (Phase 4D)
// =====================================================================

const user = (typeof requireAuth === 'function') ? requireAuth() : null;
const HR_ROLES = ['admin','operation head','director','hr','hr head'];

const REACTION_META = [
  { kind: 'like',      emoji: '❤️',  label: 'Like'     },
  { kind: 'celebrate', emoji: '🎉',  label: 'Celebrate'},
  { kind: 'clap',      emoji: '👏',  label: 'Clap'     },
  { kind: 'support',   emoji: '🤝',  label: 'Support'  },
  { kind: 'thanks',    emoji: '🙏',  label: 'Thanks'   },
  { kind: 'rocket',    emoji: '🚀',  label: 'Rocket'   },
];
const BADGE_META = {
  'team-player':      { emoji: '🤝', label: 'Team Player'      },
  'star-performer':   { emoji: '⭐', label: 'Star Performer'   },
  'innovator':        { emoji: '💡', label: 'Innovator'        },
  'mentor':           { emoji: '🎓', label: 'Mentor'           },
  'above-beyond':     { emoji: '🚀', label: 'Above & Beyond'   },
  'customer-first':   { emoji: '🏆', label: 'Customer First'   },
};

let mode      = 'kudos';   // composer mode
let filterKind = '';
let oldest    = null;      // last loaded post CreatedAt, for pagination
let posts     = [];
let employees = [];        // for kudos autocomplete (loaded once)
let myExpanded = new Set();// post ids with comments expanded
let isHr      = false;

// Expose for inline onclick
Object.assign(window, {
  switchMode, setFilter, submitPost, submitKudos, submitPoll,
  addPollOption, removePollOption, loadMore,
  toggleReaction, toggleComments, postComment, deletePost, deleteComment,
  vote, useSuggestion,
});

if (user) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
}

async function init() {
  if (typeof renderSidebar === 'function') renderSidebar('hr-engage');
  isHr = HR_ROLES.includes((user.role || '').toLowerCase());
  if (isHr) document.querySelectorAll('.hr-only').forEach(el => el.style.display = '');

  // Populate badge dropdown
  const sel = document.getElementById('kudosBadge');
  Object.entries(BADGE_META).forEach(([k, v]) => {
    sel.insertAdjacentHTML('beforeend', `<option value="${k}">${v.emoji} ${v.label}</option>`);
  });

  // Default poll options (2)
  addPollOption(); addPollOption();

  // Load employees for kudos autocomplete (fire-and-forget)
  loadEmployees();

  // Load HR suggestions
  if (isHr) loadSuggestions();

  await refreshFeed();
}

async function loadEmployees() {
  // Use the lightweight, non-HR-gated endpoint so non-HR users don't get
  // auto-logged-out by apiRequest's 403 handler.
  try {
    const r = await apiRequest('/hr/engage/users');
    employees = r.users || [];
    const dl = document.getElementById('empListDL');
    dl.innerHTML = employees
      .map(e => `<option value="${escapeAttr(e.Name)}" data-id="${e.UserId}">${escapeHtml((e.EmpCode || '') + (e.Department ? ' · ' + e.Department : ''))}</option>`)
      .join('');
  } catch (_) {}
}

function resolveTargetUserId(name) {
  if (!name) return null;
  const match = employees.find(e => e.Name === name);
  return match ? match.UserId : null;
}

// ── Composer mode swap ─────────────────────────────────────────────────────
function switchMode(m) {
  mode = m;
  document.querySelectorAll('#compTabs .comp-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  ['Post','Kudos','Poll'].forEach(k => {
    document.getElementById('compForm' + k).style.display = (m === k.toLowerCase()) ? '' : 'none';
  });
  hideErr();
}

// ── Submit handlers ────────────────────────────────────────────────────────
async function submitPost() {
  const title = document.getElementById('postTitle').value.trim();
  const body  = document.getElementById('postBody').value.trim();
  if (!title && !body) return showErr('Add a headline or body.');
  try {
    await apiRequest('/hr/engage/posts', { method:'POST', body: { kind:'post', title, body }});
    document.getElementById('postTitle').value = '';
    document.getElementById('postBody').value  = '';
    await refreshFeed();
  } catch (e) { showErr(e.message || String(e)); }
}

async function submitKudos() {
  const name  = document.getElementById('kudosTarget').value.trim();
  const badge = document.getElementById('kudosBadge').value;
  const body  = document.getElementById('kudosBody').value.trim();
  const tid   = resolveTargetUserId(name);
  if (!tid)  return showErr('Pick a teammate from the list.');
  if (!body) return showErr('Write a quick note about why.');
  try {
    await apiRequest('/hr/engage/posts', { method:'POST', body: { kind:'kudos', targetUserId: tid, payload: { badge }, body }});
    document.getElementById('kudosTarget').value = '';
    document.getElementById('kudosBody').value   = '';
    await refreshFeed();
  } catch (e) { showErr(e.message || String(e)); }
}

async function submitPoll() {
  const title = document.getElementById('pollQuestion').value.trim();
  if (!title) return showErr('Type a poll question.');
  const inputs = Array.from(document.querySelectorAll('#pollOptionsWrap input.poll-option'));
  const options = inputs.map(i => i.value.trim()).filter(Boolean);
  if (options.length < 2) return showErr('Add at least 2 options.');
  const closeAtRaw = document.getElementById('pollCloseAt').value;
  const closeAt = closeAtRaw ? new Date(closeAtRaw).toISOString() : null;
  try {
    await apiRequest('/hr/engage/posts', { method:'POST', body: { kind:'poll', title, payload: { options, closeAt }}});
    document.getElementById('pollQuestion').value  = '';
    document.getElementById('pollCloseAt').value   = '';
    document.getElementById('pollOptionsWrap').innerHTML = '';
    addPollOption(); addPollOption();
    await refreshFeed();
  } catch (e) { showErr(e.message || String(e)); }
}

function addPollOption() {
  const wrap = document.getElementById('pollOptionsWrap');
  const idx  = wrap.querySelectorAll('input.poll-option').length;
  if (idx >= 6) return;
  const row = document.createElement('div');
  row.className = 'poll-opt-row';
  row.innerHTML = `
    <input type="text" class="poll-option" placeholder="Option ${idx + 1}" maxlength="100" />
    <button type="button" class="btn btn-sm btn-ghost" onclick="removePollOption(this)">×</button>
  `;
  wrap.appendChild(row);
}
function removePollOption(btn) {
  const row = btn.closest('.poll-opt-row');
  if (row) row.remove();
}

// ── Feed loading ───────────────────────────────────────────────────────────
function setFilter(k) {
  filterKind = k;
  document.querySelectorAll('#filterChips .chip').forEach(c =>
    c.classList.toggle('active', c.dataset.kind === k));
  refreshFeed();
}

async function refreshFeed() {
  oldest = null;
  posts = [];
  document.getElementById('feedList').innerHTML = '<div class="eng-empty">Loading…</div>';
  await loadMore();
}

async function loadMore() {
  const params = new URLSearchParams();
  if (filterKind) params.set('kind', filterKind);
  params.set('limit', 20);
  if (oldest) params.set('before', oldest);
  try {
    const r = await apiRequest('/hr/engage/feed?' + params.toString());
    const fresh = r.posts || [];
    posts = posts.concat(fresh);
    if (fresh.length) oldest = fresh[fresh.length - 1].CreatedAt;
    renderFeed();
    document.getElementById('loadMoreBtn').style.display = r.hasMore ? '' : 'none';
  } catch (err) {
    document.getElementById('feedList').innerHTML =
      `<div class="eng-empty eng-err">${escapeHtml(err.message || err)}</div>`;
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderFeed() {
  const wrap = document.getElementById('feedList');
  if (!posts.length) {
    wrap.innerHTML = `<div class="eng-empty">Nothing here yet. Be the first to post!</div>`;
    return;
  }
  wrap.innerHTML = posts.map(renderCard).join('');
}

function renderCard(p) {
  const isMine    = p.AuthorUserId === user.id;
  const canDel    = isMine || isHr;
  const initials  = (p.AuthorName || '?').split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
  const pinned    = p.PinnedUntil && new Date(p.PinnedUntil) > new Date();
  let body = '';

  if (p.Kind === 'kudos') {
    const badge = (p.Payload && p.Payload.badge) ? BADGE_META[p.Payload.badge] : null;
    body = `
      <div class="kudos-head">
        <div class="kudos-arrow">${badge ? badge.emoji : '🏆'}</div>
        <div><b>${escapeHtml(p.AuthorName || '')}</b> gave kudos to <b>${escapeHtml(p.TargetName || 'someone')}</b>${p.TargetDepartment ? ' <span class="eng-meta">· ' + escapeHtml(p.TargetDepartment) + '</span>' : ''}</div>
        ${badge ? `<span class="badge-chip">${escapeHtml(badge.label)}</span>` : ''}
      </div>
      ${p.Body ? `<div class="card-body">${escapeHtml(p.Body)}</div>` : ''}
    `;
  } else if (p.Kind === 'poll') {
    const opts = (p.Payload && Array.isArray(p.Payload.options)) ? p.Payload.options : [];
    const totalVotes = Object.values(p.optionCounts || {}).reduce((a,b) => a + b, 0);
    const closed = p.Payload && p.Payload.closeAt && new Date(p.Payload.closeAt) < new Date();
    body = `
      ${p.Title ? `<div class="card-title">${escapeHtml(p.Title)}</div>` : ''}
      <div class="poll-list">
        ${opts.map((opt, idx) => {
          const cnt = (p.optionCounts && p.optionCounts[idx]) || 0;
          const pct = totalVotes ? Math.round((cnt / totalVotes) * 100) : 0;
          const mine = p.myVoteIndex === idx;
          return `
            <button type="button" class="poll-opt ${mine ? 'is-mine' : ''} ${closed ? 'is-closed' : ''}"
                    ${closed ? 'disabled' : ''}
                    onclick="vote(${p.PostId}, ${idx})">
              <div class="poll-opt-fill" style="width:${pct}%"></div>
              <div class="poll-opt-text">
                <span>${escapeHtml(opt)}</span>
                <span class="poll-opt-meta">${cnt} · ${pct}%</span>
              </div>
            </button>
          `;
        }).join('')}
      </div>
      <div class="poll-meta">${totalVotes} vote(s)${closed ? ' · Closed' : (p.Payload && p.Payload.closeAt ? ' · Closes ' + formatLocal(p.Payload.closeAt) : '')}</div>
    `;
  } else if (p.Kind === 'birthday') {
    body = `
      <div class="card-band band-birthday">🎂 Today is <b>${escapeHtml(p.TargetName || 'a teammate')}</b>'s birthday!</div>
      ${p.Body ? `<div class="card-body">${escapeHtml(p.Body)}</div>` : ''}
    `;
  } else if (p.Kind === 'joiner') {
    body = `
      <div class="card-band band-joiner">👋 Welcome <b>${escapeHtml(p.TargetName || '')}</b>${p.TargetDepartment ? ' to <b>' + escapeHtml(p.TargetDepartment) + '</b>' : ''}!</div>
      ${p.Body ? `<div class="card-body">${escapeHtml(p.Body)}</div>` : ''}
    `;
  } else {
    body = `
      ${p.Title ? `<div class="card-title">${escapeHtml(p.Title)}</div>` : ''}
      ${p.Body  ? `<div class="card-body">${escapeHtml(p.Body)}</div>`   : ''}
    `;
  }

  const reactions = REACTION_META.map(r => {
    const cnt = (p.reactionCounts && p.reactionCounts[r.kind]) || 0;
    const mine = (p.myReactions || []).includes(r.kind);
    return `
      <button class="react-btn ${mine ? 'is-mine' : ''}" type="button"
              title="${r.label}" onclick="toggleReaction(${p.PostId}, '${r.kind}')">
        <span>${r.emoji}</span>${cnt ? ' ' + cnt : ''}
      </button>`;
  }).join('');

  const expanded = myExpanded.has(p.PostId);

  return `
    <article class="eng-card eng-post post-${p.Kind}">
      <header class="eng-post-head">
        <div class="eng-avatar">${escapeHtml(initials)}</div>
        <div class="eng-post-meta">
          <div><b>${escapeHtml(p.AuthorName || '—')}</b> <span class="eng-meta">${escapeHtml(p.AuthorRole || '')}</span></div>
          <div class="eng-meta">${formatLocal(p.CreatedAt)}${pinned ? ' · 📌 Pinned' : ''}</div>
        </div>
        ${canDel ? `<button type="button" class="eng-del" title="Delete" onclick="deletePost(${p.PostId})">×</button>` : ''}
      </header>
      <div class="eng-post-body">${body}</div>
      <div class="eng-post-actions">
        <div class="react-row">${reactions}</div>
        <button type="button" class="comment-toggle" onclick="toggleComments(${p.PostId})">
          💬 ${p.commentCount || 0} comment${(p.commentCount || 0) === 1 ? '' : 's'}
        </button>
      </div>
      <div class="eng-comments" id="comments_${p.PostId}" style="${expanded ? '' : 'display:none;'}">
        <div class="comments-list" id="commentsList_${p.PostId}">${expanded ? '<div class="eng-empty-sm">Loading…</div>' : ''}</div>
        <div class="comment-box">
          <textarea id="newComment_${p.PostId}" rows="2" placeholder="Write a comment…"></textarea>
          <button class="btn btn-sm btn-primary" type="button" onclick="postComment(${p.PostId})">Send</button>
        </div>
      </div>
    </article>
  `;
}

// ── Interactions ───────────────────────────────────────────────────────────
async function toggleReaction(postId, kind) {
  try {
    await apiRequest(`/hr/engage/posts/${postId}/react`, { method:'POST', body: { kind } });
    // Lightweight refresh: just reload feed (small list, cheap)
    const data = await apiRequest('/hr/engage/posts/' + postId);
    const idx = posts.findIndex(p => p.PostId === postId);
    if (idx !== -1 && data.post) { posts[idx] = data.post; renderFeed(); }
  } catch (e) { alert(e.message || e); }
}

async function vote(postId, optionIndex) {
  try {
    await apiRequest(`/hr/engage/posts/${postId}/vote`, { method:'POST', body: { optionIndex } });
    const data = await apiRequest('/hr/engage/posts/' + postId);
    const idx = posts.findIndex(p => p.PostId === postId);
    if (idx !== -1 && data.post) { posts[idx] = data.post; renderFeed(); }
  } catch (e) { alert(e.message || e); }
}

async function deletePost(postId) {
  if (!confirm('Delete this post?')) return;
  try {
    await apiRequest('/hr/engage/posts/' + postId, { method:'DELETE' });
    posts = posts.filter(p => p.PostId !== postId);
    renderFeed();
  } catch (e) { alert(e.message || e); }
}

async function toggleComments(postId) {
  const wrap = document.getElementById('comments_' + postId);
  if (!wrap) return;
  if (myExpanded.has(postId)) {
    myExpanded.delete(postId);
    wrap.style.display = 'none';
    return;
  }
  myExpanded.add(postId);
  wrap.style.display = '';
  await loadComments(postId);
}

async function loadComments(postId) {
  const list = document.getElementById('commentsList_' + postId);
  if (!list) return;
  list.innerHTML = '<div class="eng-empty-sm">Loading…</div>';
  try {
    const data = await apiRequest('/hr/engage/posts/' + postId);
    const c = data.comments || [];
    // also refresh count
    const idx = posts.findIndex(p => p.PostId === postId);
    if (idx !== -1) posts[idx].commentCount = c.length;
    if (!c.length) {
      list.innerHTML = '<div class="eng-empty-sm">No comments yet.</div>';
      return;
    }
    list.innerHTML = c.map(cm => {
      const isMineC = cm.UserId === user.id;
      const initials = (cm.AuthorName || '?').split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
      return `
        <div class="cm-row">
          <div class="cm-av">${escapeHtml(initials)}</div>
          <div class="cm-body">
            <div class="cm-head"><b>${escapeHtml(cm.AuthorName || '')}</b> <span class="eng-meta">${formatLocal(cm.CreatedAt)}</span></div>
            <div class="cm-text">${escapeHtml(cm.Body || '')}</div>
          </div>
          ${(isMineC || isHr) ? `<button class="cm-del" title="Delete" onclick="deleteComment(${cm.CommentId}, ${postId})">×</button>` : ''}
        </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div class="eng-empty-sm eng-err">${escapeHtml(e.message || e)}</div>`;
  }
}

async function postComment(postId) {
  const ta = document.getElementById('newComment_' + postId);
  const body = (ta.value || '').trim();
  if (!body) return;
  try {
    await apiRequest(`/hr/engage/posts/${postId}/comments`, { method:'POST', body: { body }});
    ta.value = '';
    await loadComments(postId);
    // refresh count in feed
    renderFeed();
  } catch (e) { alert(e.message || e); }
}

async function deleteComment(commentId, postId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await apiRequest('/hr/engage/comments/' + commentId, { method:'DELETE' });
    await loadComments(postId);
    renderFeed();
  } catch (e) { alert(e.message || e); }
}

// ── HR suggestions ─────────────────────────────────────────────────────────
async function loadSuggestions() {
  try {
    const r = await apiRequest('/hr/engage/suggest');
    const items = r.suggestions || [];
    const list = document.getElementById('suggestList');
    if (!items.length) {
      list.innerHTML = '<div class="eng-empty eng-empty-sm">Nothing to suggest today.</div>';
      return;
    }
    list.innerHTML = items.map(s => {
      const isB = s.Kind === 'birthday';
      const label = isB
        ? `🎂 <b>${escapeHtml(s.Name)}</b>'s birthday today`
        : `👋 <b>${escapeHtml(s.Name)}</b> joined ${escapeHtml(s.Department || '')} on ${formatDate(s.Day)}`;
      return `
        <div class="suggest-row">
          <div>${label}</div>
          <button class="btn btn-sm" type="button" onclick="useSuggestion('${s.Kind}', ${s.UserId}, ${JSON.stringify(s.Name).replace(/"/g,'&quot;')}, ${JSON.stringify(s.Department || '').replace(/"/g,'&quot;')})">
            ${isB ? 'Wish them' : 'Welcome them'}
          </button>
        </div>`;
    }).join('');
  } catch (_) {}
}

async function useSuggestion(kind, targetUserId, name, department) {
  const defaultBody = kind === 'birthday'
    ? `🎉 Wishing ${name} a very happy birthday! Have an amazing year ahead.`
    : `👋 A warm welcome to ${name}${department ? ' joining ' + department : ''}! Excited to have you on the team.`;
  if (!confirm(`Create a ${kind} post for ${name}?`)) return;
  try {
    await apiRequest('/hr/engage/posts', {
      method: 'POST',
      body: { kind, targetUserId, body: defaultBody, title: null },
    });
    await loadSuggestions();   // remove this row from the panel (it's still in the feed though)
    await refreshFeed();
  } catch (e) { alert(e.message || e); }
}

// ── helpers ────────────────────────────────────────────────────────────────
function showErr(msg) {
  const el = document.getElementById('compErr');
  if (!el) return;
  el.style.display = '';
  el.textContent = msg;
}
function hideErr() {
  const el = document.getElementById('compErr');
  if (el) { el.style.display = 'none'; el.textContent = ''; }
}
function formatLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleString('en-IN', { hour12:false, day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
