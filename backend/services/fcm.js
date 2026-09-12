// =====================================================================
// services/fcm.js — Firebase Cloud Messaging sender (native mobile push)
//
// Delivers a notification to a user's installed phone even when the app is
// CLOSED. Uses the Firebase Admin SDK (HTTP v1) with a service-account JSON.
//
// SAFE-BY-DEFAULT: the whole thing is behind a guarded lazy-require. If
// `firebase-admin` isn't installed yet, or no service account is configured,
// isConfigured() is false and send() is a no-op — the app (and the in-app bell)
// keep working with zero push. So this file can ship BEFORE Firebase is set up.
//
// To turn push ON (after `npm install firebase-admin`):
//   FCM_SERVICE_ACCOUNT_PATH=./secrets/fcm-service-account.json   (preferred)
//   — or —  FCM_SERVICE_ACCOUNT_JSON={...}                        (inline JSON)
// =====================================================================
const fs = require('fs');
const path = require('path');

let _admin = null;         // the firebase-admin module (lazy)
let _app = null;           // the initialized admin app
let _initTried = false;
let _initError = null;

function _loadServiceAccount() {
  const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim()) {
    try { return JSON.parse(inline); }
    catch (e) { throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message); }
  }
  const p = process.env.FCM_SERVICE_ACCOUNT_PATH;
  if (p && p.trim()) {
    const abs = path.isAbsolute(p) ? p : path.join(__dirname, '..', p);
    if (!fs.existsSync(abs)) throw new Error('FCM_SERVICE_ACCOUNT_PATH not found: ' + abs);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  return null;   // not configured
}

// Initialize once (idempotent). Returns true if push is ready.
function _init() {
  if (_app) return true;
  if (_initTried) return !!_app;
  _initTried = true;
  try {
    const sa = _loadServiceAccount();
    if (!sa) { _initError = 'no service account configured'; return false; }
    // Lazy require so a missing dependency never crashes the server.
    _admin = require('firebase-admin');
    _app = _admin.initializeApp({ credential: _admin.credential.cert(sa) }, 'one-app-notify');
    console.log('✅ FCM push initialized (project:', sa.project_id + ')');
    return true;
  } catch (e) {
    _initError = e.message;
    console.warn('⚠ FCM push disabled —', e.message, '(in-app notifications still work)');
    return false;
  }
}

function isConfigured() { return _init(); }

// Send one notification to a list of device tokens.
// Returns { ok, sent, failed, invalidTokens[] }. invalidTokens are stale/
// unregistered tokens the caller should deactivate in BN_PushToken.
async function sendToTokens(tokens, { title, body, data } = {}) {
  const list = (tokens || []).filter(Boolean);
  if (!list.length) return { ok: false, reason: 'no_tokens', sent: 0, failed: 0, invalidTokens: [] };
  if (!_init())     return { ok: false, reason: _initError || 'not_configured', sent: 0, failed: 0, invalidTokens: [] };

  // FCM data payload must be all-strings.
  const strData = {};
  for (const [k, v] of Object.entries(data || {})) strData[k] = v == null ? '' : String(v);

  const message = {
    tokens: list,
    notification: { title: title || 'ONE App', body: body || '' },
    data: strData,
    android: {
      priority: 'high',
      notification: { channelId: 'companya_one_default', sound: 'default' },
    },
    apns: { payload: { aps: { sound: 'default' } } },
  };

  try {
    const resp = await _admin.messaging(_app).sendEachForMulticast(message);
    const invalidTokens = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code || '';
        // These codes mean the token is dead — clean it up.
        if (/registration-token-not-registered|invalid-registration-token|invalid-argument/i.test(code)) {
          invalidTokens.push(list[i]);
        }
      }
    });
    return { ok: resp.successCount > 0, sent: resp.successCount, failed: resp.failureCount, invalidTokens };
  } catch (e) {
    console.error('[fcm] sendEachForMulticast failed:', e.message);
    return { ok: false, reason: e.message, sent: 0, failed: list.length, invalidTokens: [] };
  }
}

module.exports = { isConfigured, sendToTokens };
