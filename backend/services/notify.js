// =====================================================================
// services/notify.js — the ONE entry point for all ONE App notifications
//
//   const { notify } = require('../../../services/notify');
//   await notify({ userId, category, type, title, body, deepLink, refKey, severity });
//
// It (1) de-dupes on (UserId, RefKey) among active rows, (2) inserts one row
// into BN_Notification (the in-app inbox / bell), then (3) fires a native FCM
// push to that user's registered devices (no-op until Firebase is configured).
// WhatsApp escalation is optional and OFF by default (NOTIF_WA_ENABLED).
//
// Everything is best-effort and swallow-on-error: a notification must NEVER
// break the business action that triggered it.
// =====================================================================
const { getAppPool, sql } = require('../db');
const fcm = require('./fcm');

const WA_ENABLED = String(process.env.NOTIF_WA_ENABLED || '').toLowerCase() === 'true';

// ── Supervisor copies ────────────────────────────────────────────────
// Admins (by username) get a COPY of every notification; heads get a copy of
// their team members' notifications. Each copy's title is prefixed with the
// owner's name so the watcher sees WHO it is for. OFF unless configured.
//   NOTIF_COPY_ADMINS=admin@company-b.example,other@...   (copy ALL)
//   NOTIF_COPY_HEADS=true                                      (copy to owner's head)
const COPY_ADMINS = (process.env.NOTIF_COPY_ADMINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const COPY_HEADS = String(process.env.NOTIF_COPY_HEADS || '').toLowerCase() === 'true';
let _adminIds = null;               // cached admin-watcher userIds
const _labelCache = new Map();      // ownerId -> "Name (Role)"
const _headCache  = new Map();      // ownerId|company -> [headUserId]

// Insert one notification for one user. Returns { created, notifId } (created=false
// when de-duped). Never throws — logs and returns { created:false } on failure.
async function notify(opts = {}) {
  const {
    userId, type, title,
    category = null, body = null, deepLink = null,
    refKey = null, severity = 'info', dueDate = null,
    company = null, meta = null, createdBy = null,
    push = true,          // deliver to phone (FCM)
    _isCopy = false,      // internal: this row is a supervisor copy (no further fan-out)
  } = opts;

  if (!userId || !type || !title) {
    console.warn('[notify] missing required field (userId/type/title) — skipped');
    return { created: false };
  }

  try {
    const pool = await getAppPool();

    // De-dup: if an active notification with the same RefKey already exists for
    // this user, don't create another (the daily scan re-runs every morning).
    if (refKey) {
      const dup = await pool.request()
        .input('u', sql.Int, userId)
        .input('r', sql.NVarChar(200), refKey)
        .query('SELECT TOP 1 NotifId FROM dbo.BN_Notification WHERE UserId=@u AND RefKey=@r AND IsActive=1');
      if (dup.recordset.length) return { created: false, notifId: dup.recordset[0].NotifId, deduped: true };
    }

    const ins = await pool.request()
      .input('UserId', sql.Int, userId)
      .input('Category', sql.NVarChar(30), category)
      .input('Type', sql.NVarChar(50), type)
      .input('Severity', sql.NVarChar(10), severity || 'info')
      .input('Title', sql.NVarChar(200), String(title).slice(0, 200))
      .input('Body', sql.NVarChar(1000), body == null ? null : String(body).slice(0, 1000))
      .input('DeepLink', sql.NVarChar(300), deepLink)
      .input('RefKey', sql.NVarChar(200), refKey)
      .input('DueDate', sql.Date, dueDate ? new Date(dueDate) : null)
      .input('Company', sql.NVarChar(10), company)
      .input('Meta', sql.NVarChar(sql.MAX), meta ? (typeof meta === 'string' ? meta : JSON.stringify(meta)) : null)
      .input('CreatedByUserId', sql.Int, createdBy)
      .query(`INSERT INTO dbo.BN_Notification
                (UserId, Category, Type, Severity, Title, Body, DeepLink, RefKey, DueDate, Company, Meta, CreatedByUserId)
              OUTPUT INSERTED.NotifId
              VALUES (@UserId,@Category,@Type,@Severity,@Title,@Body,@DeepLink,@RefKey,@DueDate,@Company,@Meta,@CreatedByUserId)`);

    const notifId = ins.recordset[0].NotifId;

    // Fire the phone push (fire-and-forget; never blocks the caller).
    if (push) {
      dispatchPush(pool, userId, notifId, { title, body, deepLink, type }).catch(() => {});
    }
    // Fan out labeled copies to admins/heads (fire-and-forget; copies never re-fan).
    if (!_isCopy && (COPY_ADMINS.length || COPY_HEADS)) {
      fanOutCopies(pool, { userId, type, category, title, body, deepLink, severity, dueDate, company, meta, refKey }, notifId).catch(() => {});
    }
    return { created: true, notifId };
  } catch (e) {
    console.error('[notify] failed:', e.message);
    return { created: false, error: e.message };
  }
}

// Send the same notification to many users.
async function notifyMany(userIds, base) {
  const uniq = [...new Set((userIds || []).filter(Boolean))];
  const results = [];
  for (const uid of uniq) results.push(await notify({ ...base, userId: uid }));
  return results;
}

// Push one already-persisted notification to a user's FCM devices, then stamp
// PushSentAt and prune any dead tokens FCM reports.
async function dispatchPush(pool, userId, notifId, payload) {
  try {
    const toks = await pool.request().input('u', sql.Int, userId)
      .query('SELECT Token FROM dbo.BN_PushToken WHERE UserId=@u AND IsActive=1');
    const tokens = toks.recordset.map(r => r.Token);
    if (!tokens.length) return;
    if (!fcm.isConfigured()) return;   // push not set up yet — in-app row already stored

    const res = await fcm.sendToTokens(tokens, {
      title: payload.title,
      body: payload.body || '',
      data: { notifId: String(notifId), type: payload.type || '', deepLink: payload.deepLink || '' },
    });

    if (res.sent) {
      await pool.request().input('id', sql.Int, notifId)
        .query('UPDATE dbo.BN_Notification SET PushSentAt=SYSDATETIME() WHERE NotifId=@id').catch(() => {});
    }
    // Deactivate stale tokens so we stop trying them.
    for (const bad of (res.invalidTokens || [])) {
      await pool.request().input('t', sql.NVarChar(400), bad)
        .query('UPDATE dbo.BN_PushToken SET IsActive=0 WHERE Token=@t').catch(() => {});
    }
  } catch (e) {
    console.error('[notify.dispatchPush] failed:', e.message);
  }
}

// ── Supervisor-copy resolvers ────────────────────────────────────────
// Admin watchers (get a copy of EVERYTHING). Resolved once per process.
async function getAdminWatchers(pool) {
  if (_adminIds) return _adminIds;
  if (!COPY_ADMINS.length) { _adminIds = []; return _adminIds; }
  const list = COPY_ADMINS.map((_, i) => `@a${i}`).join(',');
  const req = pool.request();
  COPY_ADMINS.forEach((u, i) => req.input(`a${i}`, sql.NVarChar, u));
  const r = await req.query(`SELECT Id FROM dbo.User_Login
    WHERE IsActive = 1 AND LOWER(Username) IN (${list})`);
  _adminIds = r.recordset.map(x => x.Id);
  return _adminIds;
}

// "Name (Role)" for the owner, so the copy shows WHO it is for. Cached.
async function ownerLabel(pool, ownerId) {
  if (_labelCache.has(ownerId)) return _labelCache.get(ownerId);
  const r = await pool.request().input('id', sql.Int, ownerId)
    .query(`SELECT ISNULL(NULLIF(Name,''), Username) AS Nm, Role FROM dbo.User_Login WHERE Id=@id`);
  const row = r.recordset[0];
  const label = row ? (row.Nm + (row.Role ? ` (${row.Role})` : '')) : ('User#' + ownerId);
  _labelCache.set(ownerId, label);
  return label;
}

// Head(s) whose team-code list (CompanyACode/CompanyBCode) covers the owner's own code.
// Only when NOTIF_COPY_HEADS=true and the notification carries a company. Cached.
async function getHeadWatchers(pool, ownerId, company) {
  if (!COPY_HEADS || !company) return [];
  const key = ownerId + '|' + company;
  if (_headCache.has(key)) return _headCache.get(key);
  const codeCol = company === 'COMPANYB' ? 'CompanyBCode' : 'CompanyACode';
  const o = await pool.request().input('id', sql.Int, ownerId)
    .query(`SELECT ${codeCol} AS Codes FROM dbo.User_Login WHERE Id=@id`);
  const ownerCodes = ((o.recordset[0] && o.recordset[0].Codes) || '')
    .split('/').map(s => s.trim()).filter(Boolean);
  if (!ownerCodes.length) { _headCache.set(key, []); return []; }
  const heads = await pool.request().query(`
    SELECT Id, ${codeCol} AS Codes FROM dbo.User_Login
    WHERE IsActive=1 AND LOWER(Role) LIKE '%head%' AND LOWER(Role) <> 'fae head'
      AND ${codeCol} IS NOT NULL AND ${codeCol} <> ''`);
  const ids = [];
  for (const h of heads.recordset) {
    if (h.Id === ownerId) continue;
    const hc = (h.Codes || '').split('/').map(s => s.trim());
    if (ownerCodes.some(c => hc.includes(c))) ids.push(h.Id);
  }
  _headCache.set(key, ids);
  return ids;
}

// Create a labeled copy of one notification for each admin/head watcher.
async function fanOutCopies(pool, o, primaryNotifId) {
  try {
    const admins = await getAdminWatchers(pool);
    const heads  = await getHeadWatchers(pool, o.userId, o.company);
    const targets = [...new Set([...admins, ...heads])].filter(id => id && id !== o.userId);
    if (!targets.length) return;
    const label = await ownerLabel(pool, o.userId);
    const baseRef = (o.refKey || ('n' + primaryNotifId));
    for (const tid of targets) {
      await notify({
        userId:   tid,
        type:     o.type,
        category: o.category,
        severity: o.severity,
        title:    label + ' — ' + o.title,     // shows WHOSE notification this is
        body:     o.body,
        deepLink: o.deepLink,
        dueDate:  o.dueDate,
        company:  o.company,
        refKey:   baseRef + ':copy:' + tid,     // unique per watcher; dedups on re-scan
        meta:     Object.assign({}, (o.meta && typeof o.meta === 'object' ? o.meta : {}),
                                 { copyOf: o.userId, forUser: label }),
        _isCopy:  true,
      });
    }
  } catch (e) {
    console.error('[notify.fanOutCopies] failed:', e.message);
  }
}

// One-time backfill: create the admin/head copies for notifications that were
// created BEFORE the copy feature was on (the live fan-out only fires on new
// primaries). In-app only by default (push:false) so a batch backfill doesn't
// blast every watcher's phone. Safe to re-run — copies dedup on RefKey.
async function backfillCopies({ sinceHours = 24, push = false } = {}) {
  if (!COPY_ADMINS.length && !COPY_HEADS) return { primaries: 0, copies: 0, note: 'copies disabled' };
  const pool = await getAppPool();
  const r = await pool.request().input('h', sql.Int, sinceHours).query(`
    SELECT NotifId, UserId, Type, Category, Severity, Title, Body, DeepLink, DueDate, Company, RefKey
    FROM dbo.BN_Notification
    WHERE IsActive = 1 AND CreatedAt >= DATEADD(HOUR, -@h, SYSDATETIME())
      AND (RefKey IS NULL OR RefKey NOT LIKE '%:copy:%')
      AND ISNULL(Meta, '') NOT LIKE '%"copyOf"%'
    ORDER BY NotifId`);
  let copies = 0;
  for (const n of r.recordset) {
    const admins = await getAdminWatchers(pool);
    const heads  = await getHeadWatchers(pool, n.UserId, n.Company);
    const targets = [...new Set([...admins, ...heads])].filter(id => id && id !== n.UserId);
    if (!targets.length) continue;
    const label = await ownerLabel(pool, n.UserId);
    const baseRef = (n.RefKey || ('n' + n.NotifId));
    for (const tid of targets) {
      const res = await notify({
        userId: tid, type: n.Type, category: n.Category, severity: n.Severity,
        title: label + ' — ' + n.Title, body: n.Body, deepLink: n.DeepLink,
        dueDate: n.DueDate, company: n.Company,
        refKey: baseRef + ':copy:' + tid,
        meta: { copyOf: n.UserId, forUser: label, backfill: true },
        _isCopy: true, push,
      });
      if (res.created) copies++;
    }
  }
  return { primaries: r.recordset.length, copies };
}

module.exports = { notify, notifyMany, backfillCopies, WA_ENABLED };
