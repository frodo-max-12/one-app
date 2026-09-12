// =====================================================================
// modules/hr/routes/engage.js — Engage feed (Phase 4D)
// Mounted at /api/hr/engage/* by ../index.js
//
// Kinds: post | kudos | poll | birthday | joiner
//   - Kudos is open to everyone (peer-to-peer recognition)
//   - Everything else is HR-only
// Reactions, comments, votes are open to all logged-in users.
//
// Endpoints:
//   GET    /options
//   GET    /suggest                        — HR-only: today's birthdays + joiners-this-week
//   GET    /feed                           — paginated feed (?kind=, ?limit=, ?before=)
//   POST   /posts                          — create
//   GET    /posts/:id                      — full detail (comments + reactions + votes)
//   PATCH  /posts/:id                      — edit (author or HR)
//   DELETE /posts/:id                      — soft delete (author or HR)
//   POST   /posts/:id/react                — toggle reaction { kind }
//   DELETE /posts/:id/react                — explicit remove { kind }
//   POST   /posts/:id/comments             — add comment { body }
//   DELETE /comments/:id                   — soft-delete comment (author or HR)
//   POST   /posts/:id/vote                 — upsert poll vote { optionIndex }
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');

const POST_KINDS     = ['post', 'kudos', 'poll', 'birthday', 'joiner'];
const REACTION_KINDS = ['like', 'celebrate', 'support', 'thanks', 'clap', 'rocket'];
const KUDOS_BADGES   = ['team-player', 'star-performer', 'innovator', 'mentor', 'above-beyond', 'customer-first'];
const HR_GATED_KINDS = ['post', 'poll', 'birthday', 'joiner'];

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }

// ── Permission helper ──────────────────────────────────────────────────────
async function loadPostForUser(pool, postId, user) {
  const r = await pool.request()
    .input('id', sql.Int, postId)
    .query('SELECT * FROM HRM_Engage_Post WHERE PostId = @id AND IsActive = 1');
  const row = r.recordset[0];
  if (!row) return { row: null, isAuthor: false, canModerate: false };
  return {
    row,
    isAuthor:    user && row.AuthorUserId === user.id,
    canModerate: isLensAdmin(user),
  };
}

// Enrich a list of posts with reactionCounts, myReactions, commentCount, optionCounts, myVote
async function attachInteractions(pool, posts, user) {
  if (!posts.length) return posts;
  const ids = posts.map(p => p.PostId);
  // mssql 'in' clause: build a comma list (safe — ids are integers we control)
  const idList = ids.join(',');

  const [reactQ, mineQ, cntQ, voteQ, myVoteQ] = await Promise.all([
    pool.request().query(`
      SELECT PostId, Kind, COUNT(*) AS Cnt
      FROM HRM_Engage_Reaction
      WHERE PostId IN (${idList})
      GROUP BY PostId, Kind;`),
    pool.request().input('uid', sql.Int, user.id).query(`
      SELECT PostId, Kind FROM HRM_Engage_Reaction
      WHERE UserId = @uid AND PostId IN (${idList});`),
    pool.request().query(`
      SELECT PostId, COUNT(*) AS Cnt FROM HRM_Engage_Comment
      WHERE IsDeleted = 0 AND PostId IN (${idList})
      GROUP BY PostId;`),
    pool.request().query(`
      SELECT PostId, OptionIndex, COUNT(*) AS Cnt FROM HRM_Engage_Poll_Vote
      WHERE PostId IN (${idList})
      GROUP BY PostId, OptionIndex;`),
    pool.request().input('uid', sql.Int, user.id).query(`
      SELECT PostId, OptionIndex FROM HRM_Engage_Poll_Vote
      WHERE UserId = @uid AND PostId IN (${idList});`),
  ]);

  const reactMap = {};        // postId -> { kind: count }
  reactQ.recordset.forEach(r => { (reactMap[r.PostId] = reactMap[r.PostId] || {})[r.Kind] = r.Cnt; });
  const mineMap = {};         // postId -> set of my reaction kinds
  mineQ.recordset.forEach(r => { (mineMap[r.PostId] = mineMap[r.PostId] || new Set()).add(r.Kind); });
  const cntMap = {};          // postId -> commentCount
  cntQ.recordset.forEach(r => { cntMap[r.PostId] = r.Cnt; });
  const voteMap = {};         // postId -> { optionIndex: count }
  voteQ.recordset.forEach(r => { (voteMap[r.PostId] = voteMap[r.PostId] || {})[r.OptionIndex] = r.Cnt; });
  const myVoteMap = {};       // postId -> myOptionIndex
  myVoteQ.recordset.forEach(r => { myVoteMap[r.PostId] = r.OptionIndex; });

  return posts.map(p => ({
    ...p,
    Payload:        safeJson(p.Payload),
    reactionCounts: reactMap[p.PostId] || {},
    myReactions:    Array.from(mineMap[p.PostId] || []),
    commentCount:   cntMap[p.PostId]   || 0,
    optionCounts:   voteMap[p.PostId]  || {},
    myVoteIndex:    myVoteMap[p.PostId] !== undefined ? myVoteMap[p.PostId] : null,
  }));
}

// ── GET /options ───────────────────────────────────────────────────────────
router.get('/options', authenticate, (req, res) => {
  res.json({
    postKinds:      POST_KINDS,
    reactionKinds:  REACTION_KINDS,
    kudosBadges:    KUDOS_BADGES,
    hrGatedKinds:   HR_GATED_KINDS,
    isHr:           isLensAdmin(req.user),
  });
});

// ── GET /users — lightweight directory for Kudos autocomplete (anyone) ─────
// Returns only Id + Name + Department so non-HR users can pick kudos targets
// without hitting the HR-gated /hr/employees endpoint (which 403s and triggers
// the auto-logout in apiRequest). Active users only.
router.get('/users', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = await pool.request().query(`
      SELECT U.Id AS UserId, U.Name, E.Department, E.EmpCode
      FROM User_Login U
      LEFT JOIN HRM_Employee E ON E.UserId = U.Id
      WHERE U.IsActive = 1 AND U.Id <> 0
      ORDER BY U.Name;
    `);
    res.json({ users: r.recordset });
  } catch (err) {
    console.error('[engage/users]', err);
    res.status(500).json({ message: 'Failed to load users', error: err.message });
  }
});

// ── GET /suggest — HR-only birthday + new-joiner suggestions ────────────────
router.get('/suggest', authenticate, async (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().query(`
      DECLARE @Today DATE = CAST(GETDATE() AS DATE);
      DECLARE @WeekAgo DATE = DATEADD(DAY, -7, @Today);

      SELECT 'birthday' AS Kind, U.Id AS UserId, U.Name, E.EmpCode, E.Department, E.DOB AS Day
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1
        AND E.DOB IS NOT NULL
        AND MONTH(E.DOB) = MONTH(@Today) AND DAY(E.DOB) = DAY(@Today)

      UNION ALL

      SELECT 'joiner' AS Kind, U.Id AS UserId, U.Name, E.EmpCode, E.Department, E.DateOfJoining AS Day
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1
        AND E.DateOfJoining BETWEEN @WeekAgo AND @Today
      ORDER BY Kind, Day DESC;
    `);
    res.json({ suggestions: r.recordset });
  } catch (err) {
    console.error('[engage/suggest]', err);
    res.status(500).json({ message: 'Failed to load suggestions', error: err.message });
  }
});

// ── GET /feed ──────────────────────────────────────────────────────────────
router.get('/feed', authenticate, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const kind   = (req.query.kind || '').toLowerCase();
    const before = req.query.before ? new Date(req.query.before) : null;

    const pool = await getAppPool();
    const r = pool.request().input('lim', sql.Int, limit);
    const where = ['P.IsActive = 1'];
    if (kind && POST_KINDS.includes(kind)) {
      r.input('k', sql.NVarChar(20), kind);
      where.push('P.Kind = @k');
    }
    if (kind === 'birthdays-joiners') {
      where.pop();   // remove the @k branch above (would be empty anyway)
      where.push("P.Kind IN ('birthday','joiner')");
    }
    if (before && !isNaN(before)) {
      r.input('bf', sql.DateTime2, before);
      where.push('P.CreatedAt < @bf');
    }

    const result = await r.query(`
      SELECT TOP (@lim + 1)
        P.PostId, P.Kind, P.AuthorUserId, P.TargetUserId, P.Title, P.Body, P.Payload,
        P.PinnedUntil, P.CreatedAt, P.UpdatedAt,
        U.Name AS AuthorName, U.Role AS AuthorRole,
        T.Name AS TargetName, TE.EmpCode AS TargetEmpCode, TE.Department AS TargetDepartment
      FROM HRM_Engage_Post P
      JOIN      User_Login U  ON U.Id  = P.AuthorUserId
      LEFT JOIN User_Login T  ON T.Id  = P.TargetUserId
      LEFT JOIN HRM_Employee TE ON TE.UserId = P.TargetUserId
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE WHEN P.PinnedUntil IS NOT NULL AND P.PinnedUntil > GETDATE() THEN 1 ELSE 0 END DESC,
        P.CreatedAt DESC;
    `);

    const rows    = result.recordset;
    const hasMore = rows.length > limit;
    const page    = rows.slice(0, limit);
    const enriched = await attachInteractions(pool, page, req.user);
    res.json({ posts: enriched, hasMore });
  } catch (err) {
    console.error('[engage/feed]', err);
    res.status(500).json({ message: 'Failed to load feed', error: err.message });
  }
});

// ── POST /posts ────────────────────────────────────────────────────────────
router.post('/posts', authenticate, async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '').toLowerCase();
  if (!POST_KINDS.includes(kind)) return res.status(400).json({ message: 'Invalid kind' });

  if (HR_GATED_KINDS.includes(kind) && !isLensAdmin(req.user)) {
    return res.status(403).json({ message: `Only HR / admin can create '${kind}' posts` });
  }

  const title = String(b.title || '').trim().slice(0, 200);
  const body  = String(b.body  || '').trim();
  const target = (b.targetUserId == null || b.targetUserId === '') ? null : parseInt(b.targetUserId, 10);

  // Validate kind-specific payload
  let payload = null;
  if (kind === 'kudos') {
    if (!target || !Number.isFinite(target))   return res.status(400).json({ message: 'targetUserId required for kudos' });
    if (!body)                                  return res.status(400).json({ message: 'Kudos body is required' });
    const badge = (b.payload && b.payload.badge) || '';
    if (!KUDOS_BADGES.includes(badge))           return res.status(400).json({ message: 'Invalid kudos badge' });
    payload = { badge };
  } else if (kind === 'poll') {
    if (!title)                                  return res.status(400).json({ message: 'Poll question (title) is required' });
    const opts = (b.payload && Array.isArray(b.payload.options)) ? b.payload.options.map(s => String(s).trim()).filter(Boolean) : [];
    if (opts.length < 2 || opts.length > 6)      return res.status(400).json({ message: 'Poll needs 2-6 options' });
    const closeAt = b.payload && b.payload.closeAt ? new Date(b.payload.closeAt) : null;
    payload = { options: opts, closeAt: closeAt && !isNaN(closeAt) ? closeAt.toISOString() : null };
  } else if (kind === 'post') {
    if (!title && !body)                         return res.status(400).json({ message: 'Title or body required' });
  } else if (kind === 'birthday' || kind === 'joiner') {
    if (!target || !Number.isFinite(target))     return res.status(400).json({ message: 'targetUserId required' });
  }

  try {
    const pool = await getAppPool();
    const r = await pool.request()
      .input('k',     sql.NVarChar(20),     kind)
      .input('aid',   sql.Int,              req.user.id)
      .input('tid',   sql.Int,              target)
      .input('tt',    sql.NVarChar(200),    title || null)
      .input('bd',    sql.NVarChar(sql.MAX), body || null)
      .input('pl',    sql.NVarChar(sql.MAX), payload ? JSON.stringify(payload) : null)
      .query(`
        INSERT INTO HRM_Engage_Post (Kind, AuthorUserId, TargetUserId, Title, Body, Payload)
        OUTPUT INSERTED.PostId
        VALUES (@k, @aid, @tid, @tt, @bd, @pl);
      `);
    res.status(201).json({ postId: r.recordset[0].PostId });
  } catch (err) {
    console.error('[engage/create]', err);
    res.status(500).json({ message: 'Failed to create post', error: err.message });
  }
});

// ── GET /posts/:id ─────────────────────────────────────────────────────────
router.get('/posts/:id', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const meta = await loadPostForUser(pool, id, req.user);
    if (!meta.row) return res.status(404).json({ message: 'Post not found' });

    const headQ = await pool.request().input('id', sql.Int, id).query(`
      SELECT
        P.PostId, P.Kind, P.AuthorUserId, P.TargetUserId, P.Title, P.Body, P.Payload,
        P.PinnedUntil, P.CreatedAt, P.UpdatedAt,
        U.Name AS AuthorName, U.Role AS AuthorRole,
        T.Name AS TargetName, TE.EmpCode AS TargetEmpCode, TE.Department AS TargetDepartment
      FROM HRM_Engage_Post P
      JOIN      User_Login U  ON U.Id  = P.AuthorUserId
      LEFT JOIN User_Login T  ON T.Id  = P.TargetUserId
      LEFT JOIN HRM_Employee TE ON TE.UserId = P.TargetUserId
      WHERE P.PostId = @id;
    `);
    const [enriched] = await attachInteractions(pool, headQ.recordset, req.user);

    const cQ = await pool.request().input('id', sql.Int, id).query(`
      SELECT C.CommentId, C.UserId, U.Name AS AuthorName, U.Role AS AuthorRole,
             C.Body, C.IsDeleted, C.CreatedAt
      FROM HRM_Engage_Comment C
      LEFT JOIN User_Login U ON U.Id = C.UserId
      WHERE C.PostId = @id AND C.IsDeleted = 0
      ORDER BY C.CreatedAt ASC, C.CommentId ASC;
    `);

    res.json({
      post: enriched,
      comments: cQ.recordset,
      viewer: { isAuthor: meta.isAuthor, canModerate: meta.canModerate },
    });
  } catch (err) {
    console.error('[engage/detail]', err);
    res.status(500).json({ message: 'Failed to load post', error: err.message });
  }
});

// ── PATCH /posts/:id ───────────────────────────────────────────────────────
router.patch('/posts/:id', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const b = req.body || {};
  try {
    const pool = await getAppPool();
    const meta = await loadPostForUser(pool, id, req.user);
    if (!meta.row) return res.status(404).json({ message: 'Not found' });
    if (!meta.isAuthor && !meta.canModerate) return res.status(403).json({ message: 'Not allowed' });

    const r = pool.request().input('id', sql.Int, id);
    const sets = [];
    if (b.title != null) { r.input('tt', sql.NVarChar(200),    String(b.title));    sets.push('Title = @tt'); }
    if (b.body  != null) { r.input('bd', sql.NVarChar(sql.MAX), String(b.body));    sets.push('Body = @bd'); }
    if (meta.canModerate && b.pinnedUntil !== undefined) {
      const pu = b.pinnedUntil ? new Date(b.pinnedUntil) : null;
      r.input('pu', sql.DateTime2, (pu && !isNaN(pu)) ? pu : null);
      sets.push('PinnedUntil = @pu');
    }
    if (!sets.length) return res.json({ ok: true, noChanges: true });
    sets.push('UpdatedAt = SYSDATETIME()');
    await r.query(`UPDATE HRM_Engage_Post SET ${sets.join(', ')} WHERE PostId = @id;`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[engage/patch]', err);
    res.status(500).json({ message: 'Failed to update', error: err.message });
  }
});

// ── DELETE /posts/:id ──────────────────────────────────────────────────────
router.delete('/posts/:id', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const meta = await loadPostForUser(pool, id, req.user);
    if (!meta.row) return res.status(404).json({ message: 'Not found' });
    if (!meta.isAuthor && !meta.canModerate) return res.status(403).json({ message: 'Not allowed' });
    await pool.request().input('id', sql.Int, id)
      .query('UPDATE HRM_Engage_Post SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE PostId = @id;');
    res.json({ ok: true });
  } catch (err) {
    console.error('[engage/delete]', err);
    res.status(500).json({ message: 'Failed to delete', error: err.message });
  }
});

// ── POST /posts/:id/react ──────────────────────────────────────────────────
router.post('/posts/:id/react', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const k  = (req.body && String(req.body.kind || '').toLowerCase()) || '';
  if (!Number.isFinite(id))           return res.status(400).json({ message: 'Invalid id' });
  if (!REACTION_KINDS.includes(k))    return res.status(400).json({ message: 'Invalid reaction kind' });
  try {
    const pool = await getAppPool();
    const meta = await loadPostForUser(pool, id, req.user);
    if (!meta.row) return res.status(404).json({ message: 'Post not found' });

    // Toggle: if it exists, delete; else insert
    const existing = await pool.request()
      .input('pid', sql.Int, id).input('uid', sql.Int, req.user.id).input('k', sql.NVarChar(20), k)
      .query('SELECT ReactionId FROM HRM_Engage_Reaction WHERE PostId=@pid AND UserId=@uid AND Kind=@k;');
    if (existing.recordset.length) {
      await pool.request().input('rid', sql.BigInt, existing.recordset[0].ReactionId)
        .query('DELETE FROM HRM_Engage_Reaction WHERE ReactionId = @rid;');
      return res.json({ ok: true, removed: true });
    }
    await pool.request()
      .input('pid', sql.Int, id).input('uid', sql.Int, req.user.id).input('k', sql.NVarChar(20), k)
      .query('INSERT INTO HRM_Engage_Reaction (PostId, UserId, Kind) VALUES (@pid, @uid, @k);');
    res.status(201).json({ ok: true, added: true });
  } catch (err) {
    console.error('[engage/react]', err);
    res.status(500).json({ message: 'Failed to toggle reaction', error: err.message });
  }
});
router.delete('/posts/:id/react', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const k  = (req.body && String(req.body.kind || '').toLowerCase()) || '';
  if (!Number.isFinite(id))           return res.status(400).json({ message: 'Invalid id' });
  if (!REACTION_KINDS.includes(k))    return res.status(400).json({ message: 'Invalid reaction kind' });
  try {
    const pool = await getAppPool();
    await pool.request()
      .input('pid', sql.Int, id).input('uid', sql.Int, req.user.id).input('k', sql.NVarChar(20), k)
      .query('DELETE FROM HRM_Engage_Reaction WHERE PostId=@pid AND UserId=@uid AND Kind=@k;');
    res.json({ ok: true });
  } catch (err) {
    console.error('[engage/unreact]', err);
    res.status(500).json({ message: 'Failed to remove reaction', error: err.message });
  }
});

// ── POST /posts/:id/comments ───────────────────────────────────────────────
router.post('/posts/:id/comments', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ message: 'Comment body required' });
  try {
    const pool = await getAppPool();
    const meta = await loadPostForUser(pool, id, req.user);
    if (!meta.row) return res.status(404).json({ message: 'Post not found' });
    const r = await pool.request()
      .input('pid', sql.Int, id).input('uid', sql.Int, req.user.id).input('bd', sql.NVarChar(sql.MAX), body)
      .query(`
        INSERT INTO HRM_Engage_Comment (PostId, UserId, Body)
        OUTPUT INSERTED.CommentId, INSERTED.CreatedAt
        VALUES (@pid, @uid, @bd);
      `);
    res.status(201).json({ comment: r.recordset[0] });
  } catch (err) {
    console.error('[engage/comment]', err);
    res.status(500).json({ message: 'Failed to add comment', error: err.message });
  }
});

// ── DELETE /comments/:id ───────────────────────────────────────────────────
router.delete('/comments/:id', authenticate, async (req, res) => {
  const cid = parseInt(req.params.id, 10);
  if (!Number.isFinite(cid)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('cid', sql.Int, cid)
      .query('SELECT UserId FROM HRM_Engage_Comment WHERE CommentId = @cid AND IsDeleted = 0;');
    const row = r.recordset[0];
    if (!row) return res.status(404).json({ message: 'Comment not found' });
    const isAuthor = row.UserId === req.user.id;
    if (!isAuthor && !isLensAdmin(req.user)) return res.status(403).json({ message: 'Not allowed' });
    await pool.request().input('cid', sql.Int, cid)
      .query('UPDATE HRM_Engage_Comment SET IsDeleted = 1 WHERE CommentId = @cid;');
    res.json({ ok: true });
  } catch (err) {
    console.error('[engage/delete-comment]', err);
    res.status(500).json({ message: 'Failed to delete', error: err.message });
  }
});

// ── POST /posts/:id/vote ───────────────────────────────────────────────────
router.post('/posts/:id/vote', authenticate, async (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const idx = parseInt(req.body && req.body.optionIndex, 10);
  if (!Number.isFinite(id) || !Number.isFinite(idx) || idx < 0 || idx > 5) {
    return res.status(400).json({ message: 'Invalid vote' });
  }
  try {
    const pool = await getAppPool();
    const meta = await loadPostForUser(pool, id, req.user);
    if (!meta.row)                   return res.status(404).json({ message: 'Post not found' });
    if (meta.row.Kind !== 'poll')    return res.status(400).json({ message: 'Not a poll' });
    const payload = safeJson(meta.row.Payload) || {};
    if (!Array.isArray(payload.options) || idx >= payload.options.length) {
      return res.status(400).json({ message: 'Option out of range' });
    }
    if (payload.closeAt && new Date(payload.closeAt) < new Date()) {
      return res.status(400).json({ message: 'Poll is closed' });
    }

    // Upsert: try update first, then insert if no row
    const upd = await pool.request()
      .input('pid', sql.Int, id).input('uid', sql.Int, req.user.id).input('idx', sql.Int, idx)
      .query(`
        UPDATE HRM_Engage_Poll_Vote
        SET OptionIndex = @idx, UpdatedAt = SYSDATETIME()
        WHERE PostId = @pid AND UserId = @uid;
        SELECT @@ROWCOUNT AS Cnt;
      `);
    if (upd.recordset[0].Cnt === 0) {
      await pool.request()
        .input('pid', sql.Int, id).input('uid', sql.Int, req.user.id).input('idx', sql.Int, idx)
        .query('INSERT INTO HRM_Engage_Poll_Vote (PostId, UserId, OptionIndex) VALUES (@pid, @uid, @idx);');
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[engage/vote]', err);
    res.status(500).json({ message: 'Failed to vote', error: err.message });
  }
});

module.exports = router;
