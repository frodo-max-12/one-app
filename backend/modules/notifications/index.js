// =====================================================================
// modules/notifications — the in-app notification inbox + push-token registry
// Mounted at /api/notifications (server.js). All endpoints require auth and are
// strictly scoped to the logged-in user (req.user.id) — you only ever see/act on
// your own notifications.
// =====================================================================
const express = require('express');
const router = express.Router();
const { getAppPool, sql } = require('../../db');
const { authenticate, isFullAccess } = require('../../auth');
const { notify } = require('../../services/notify');

// ── GET / — list my notifications ────────────────────────────────────────────
// ?unreadOnly=1  ?limit=30  ?offset=0
router.get('/', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const unreadOnly = String(req.query.unreadOnly || '') === '1';

    const r = pool.request().input('u', sql.Int, req.user.id)
      .input('lim', sql.Int, limit).input('off', sql.Int, offset);
    const where = 'UserId=@u AND IsActive=1' + (unreadOnly ? ' AND IsRead=0' : '');
    const rows = await r.query(`
      SELECT NotifId, Category, Type, Severity, Title, Body, DeepLink, DueDate, Company,
             IsRead, ReadAt, CreatedAt
      FROM dbo.BN_Notification
      WHERE ${where}
      ORDER BY CreatedAt DESC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY;`);

    const cnt = await pool.request().input('u', sql.Int, req.user.id)
      .query('SELECT COUNT(*) AS unread FROM dbo.BN_Notification WHERE UserId=@u AND IsActive=1 AND IsRead=0');

    return res.json({ ok: true, rows: rows.recordset, unread: cnt.recordset[0].unread });
  } catch (e) {
    console.error('[GET /notifications] failed:', e.message);
    return res.status(500).json({ message: 'Failed to load notifications', detail: e.message });
  }
});

// ── GET /unread-count — the badge number (cheap, polled) ─────────────────────
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const cnt = await pool.request().input('u', sql.Int, req.user.id)
      .query('SELECT COUNT(*) AS count FROM dbo.BN_Notification WHERE UserId=@u AND IsActive=1 AND IsRead=0');
    return res.json({ ok: true, count: cnt.recordset[0].count });
  } catch (e) {
    return res.status(500).json({ message: 'Failed', detail: e.message });
  }
});

// ── POST /:id/read — mark one read ───────────────────────────────────────────
router.post('/:id/read', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Bad id' });
  try {
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, id).input('u', sql.Int, req.user.id)
      .query(`UPDATE dbo.BN_Notification SET IsRead=1, ReadAt=SYSDATETIME()
              WHERE NotifId=@id AND UserId=@u AND IsActive=1`);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Failed', detail: e.message });
  }
});

// ── POST /read-all — mark all my notifications read ──────────────────────────
router.post('/read-all', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('u', sql.Int, req.user.id)
      .query(`UPDATE dbo.BN_Notification SET IsRead=1, ReadAt=SYSDATETIME()
              WHERE UserId=@u AND IsActive=1 AND IsRead=0`);
    return res.json({ ok: true, updated: r.rowsAffected[0] || 0 });
  } catch (e) {
    return res.status(500).json({ message: 'Failed', detail: e.message });
  }
});

// ── DELETE /:id — dismiss (soft delete) ──────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Bad id' });
  try {
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, id).input('u', sql.Int, req.user.id)
      .query('UPDATE dbo.BN_Notification SET IsActive=0 WHERE NotifId=@id AND UserId=@u');
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Failed', detail: e.message });
  }
});

// ── POST /register-token — the app registers its FCM device token on login ───
// Upsert on Token: a device belongs to exactly one current user (re-login on a
// shared phone re-points it). Body: { token, platform, deviceInfo }.
router.post('/register-token', authenticate, async (req, res) => {
  const token = String(req.body && req.body.token || '').trim();
  if (!token) return res.status(400).json({ message: 'token required' });
  const platform = String(req.body.platform || '').slice(0, 20) || null;
  const deviceInfo = String(req.body.deviceInfo || '').slice(0, 200) || null;
  try {
    const pool = await getAppPool();
    await pool.request()
      .input('u', sql.Int, req.user.id)
      .input('t', sql.NVarChar(400), token)
      .input('p', sql.NVarChar(20), platform)
      .input('d', sql.NVarChar(200), deviceInfo)
      .query(`
        MERGE dbo.BN_PushToken AS tgt
        USING (SELECT @t AS Token) AS src ON tgt.Token = src.Token
        WHEN MATCHED THEN UPDATE SET UserId=@u, Platform=@p, DeviceInfo=@d, IsActive=1, LastSeenAt=SYSDATETIME()
        WHEN NOT MATCHED THEN INSERT (UserId, Token, Platform, DeviceInfo) VALUES (@u, @t, @p, @d);`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[register-token] failed:', e.message);
    return res.status(500).json({ message: 'Failed', detail: e.message });
  }
});

// ── POST /unregister-token — on logout / permission revoked ──────────────────
router.post('/unregister-token', authenticate, async (req, res) => {
  const token = String(req.body && req.body.token || '').trim();
  if (!token) return res.json({ ok: true });
  try {
    const pool = await getAppPool();
    await pool.request().input('t', sql.NVarChar(400), token).input('u', sql.Int, req.user.id)
      .query('UPDATE dbo.BN_PushToken SET IsActive=0 WHERE Token=@t AND UserId=@u');
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Failed', detail: e.message });
  }
});

// ── POST /test — send myself a test notification (verifies bell + push) ──────
router.post('/test', authenticate, async (req, res) => {
  const r = await notify({
    userId: req.user.id, category: 'system', type: 'test',
    title: 'Test notification', body: 'If you can see this, the bell works. 🔔',
    deepLink: '/modules/notifications/notifications.html', severity: 'info',
  });
  return res.json({ ok: true, created: r.created });
});

// ── POST /run-scan — admin: manually trigger the daily scan + NAV poll ───────
router.post('/run-scan', authenticate, async (req, res) => {
  if (!isFullAccess(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const cron = require('../../services/notificationCron');
    const out = await cron.runAllNow();
    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ message: 'Scan failed', detail: e.message });
  }
});

module.exports = router;
