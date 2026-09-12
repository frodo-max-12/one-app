// =====================================================================
// shared/whatsapp.js — direct Meta WhatsApp Cloud API client
//
// We do NOT use a BSP (Gupshup/AiSensy/WATI/Interakt). All calls go
// directly to graph.facebook.com using the Phone Number ID + access
// token issued by Meta Business Manager for the WABA.
//
// Required env (set in backend/.env on the server):
//   META_WA_PHONE_NUMBER_ID   the WABA phone number ID (NOT the human number)
//   META_WA_ACCESS_TOKEN      long-lived system-user access token
//   META_WA_API_VERSION       graph version, e.g. v22.0  (default: v22.0)
//
// Public API:
//   isConfigured()                       → bool
//   sendTemplate({ to, templateName, languageCode, variables, mediaUrl? })
//      to            E.164 phone, digits only ("919999988888")
//      templateName  Meta-approved template_name (utility-category, pre-approved)
//      languageCode  e.g. "en"
//      variables     ordered string[] matching {{1}}…{{N}} positions
//      mediaUrl      optional public URL of header image/document
//      → { ok: true,  messageId: "wamid....", raw: <full response> }
//      → { ok: false, error: "<reason>",     raw: <full response or err> }
//   sendText({ to, body })  — only valid inside the 24h customer-service window;
//                             will fail outside it. Use sendTemplate for cold reaches.
//
// All callers should treat sendTemplate's return as the source of truth and
// log the messageId into BN_ReminderLog.WhatsAppMessageId for delivery tracking.
// =====================================================================

const META_WA_PHONE_NUMBER_ID = process.env.META_WA_PHONE_NUMBER_ID || '';
const META_WA_ACCESS_TOKEN    = process.env.META_WA_ACCESS_TOKEN    || '';
const META_WA_API_VERSION     = process.env.META_WA_API_VERSION     || 'v22.0';

function isConfigured() {
  return !!(META_WA_PHONE_NUMBER_ID && META_WA_ACCESS_TOKEN);
}

function _endpoint() {
  return `https://graph.facebook.com/${META_WA_API_VERSION}/${META_WA_PHONE_NUMBER_ID}/messages`;
}

// Extract every plausible phone number from a NAV phone cell.
// Customer cards often hold multiple numbers in one field, separated by
// '/', ',', ';', '|' or newlines (e.g. "9876543210/9123456789, 022-12345").
// Each candidate is normalised to E.164 digits-only:
//   - if the chunk contains an explicit '+' (e.g. "+65 9123 4567" or
//     "+91 98765 43210") the country code is taken from the digits as-is
//     and NO auto-prefix is applied (handles Singapore +65, etc.).
//   - else a bare 10-digit string is treated as an Indian mobile and "91"
//     is prepended (most NAV cards on both COMPANYA and CompanyB are Indian customers).
//   - else 11–15 digits are kept as-is (assumed already country-coded).
//   - anything else is discarded.
// Returns an array of unique valid numbers (may be empty).
function _extractAllPhones(raw) {
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  for (const chunk of String(raw).split(/[\/,;|\n\r]+/)) {
    const hasPlus = /\+/.test(chunk);
    const digits  = chunk.replace(/\D/g, '');
    if (!digits) continue;
    let normalised = null;
    if (hasPlus && digits.length >= 8 && digits.length <= 15) {
      normalised = digits;                                // explicit country code, trust it
    } else if (digits.length === 10) {
      normalised = '91' + digits;                         // bare 10-digit → Indian mobile
    } else if (digits.length >= 11 && digits.length <= 15) {
      normalised = digits;                                // already country-coded
    }
    if (normalised && !seen.has(normalised)) {
      seen.add(normalised);
      out.push(normalised);
    }
  }
  return out;
}

// Returns the FIRST valid number from a (possibly multi-number) phone cell,
// or null if none. Backward-compatible with the original single-string callers.
function _normalisePhone(raw) {
  const all = _extractAllPhones(raw);
  return all.length ? all[0] : null;
}

// Build the components array Meta expects. We currently support body
// variables only; extend later if templates use header/button substitutions.
function _buildComponents(variables, mediaUrl) {
  const components = [];

  if (mediaUrl) {
    components.push({
      type: 'header',
      parameters: [
        { type: 'image', image: { link: mediaUrl } },
      ],
    });
  }

  if (variables && variables.length) {
    components.push({
      type: 'body',
      parameters: variables.map(v => ({ type: 'text', text: String(v ?? '') })),
    });
  }

  return components;
}

async function _post(payload) {
  const res = await fetch(_endpoint(), {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${META_WA_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  let data;
  try { data = await res.json(); } catch { data = {}; }

  if (!res.ok) {
    const errMsg = data?.error?.message
      || data?.error_user_msg
      || `HTTP ${res.status}`;
    return { ok: false, error: errMsg, raw: data };
  }

  const messageId = data?.messages?.[0]?.id || null;
  return { ok: true, messageId, raw: data };
}

// ─── Send approved template (works any time, no 24h window) ───────────────
async function sendTemplate({ to, templateName, languageCode = 'en', variables = [], mediaUrl } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'META_WA_NOT_CONFIGURED' };
  }

  const phone = _normalisePhone(to);
  if (!phone)                  return { ok: false, error: 'INVALID_PHONE' };
  if (!templateName)           return { ok: false, error: 'TEMPLATE_NAME_REQUIRED' };

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                phone,
    type:              'template',
    template: {
      name:     templateName,
      language: { code: languageCode },
      components: _buildComponents(variables, mediaUrl),
    },
  };

  try {
    return await _post(payload);
  } catch (err) {
    return { ok: false, error: err.message || 'NETWORK_ERROR', raw: err };
  }
}

// ─── Upload a media file (PDF/image) to Meta → returns media_id ───────────
// Used by sendTemplateWithDocument to attach a PDF as a template header.
// Meta-hosted media expires after ~30 days; for our flow that's fine — we
// upload, send, and the customer's WhatsApp downloads the file immediately.
//
// Args:
//   buffer    — file content as Buffer
//   filename  — display filename (e.g. "Payment-Advice-COMPANYA-2627-02346.pdf")
//   mimeType  — e.g. "application/pdf"
// Returns: { ok: true, mediaId } | { ok: false, error, raw }
async function uploadMedia(buffer, filename, mimeType = 'application/pdf') {
  if (!isConfigured()) return { ok: false, error: 'META_WA_NOT_CONFIGURED' };
  if (!buffer || !buffer.length) return { ok: false, error: 'EMPTY_BUFFER' };

  const url = `https://graph.facebook.com/${META_WA_API_VERSION}/${META_WA_PHONE_NUMBER_ID}/media`;
  const form = new FormData();
  // Node 18+ has FormData + Blob globals.
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${META_WA_ACCESS_TOKEN}` },
      body: form,
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || !data.id) {
      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      return { ok: false, error: errMsg, raw: data };
    }
    return { ok: true, mediaId: data.id, raw: data };
  } catch (err) {
    return { ok: false, error: err.message || 'NETWORK_ERROR', raw: err };
  }
}

// ─── Send approved template with a DOCUMENT header (PDF attachment) ───────
// Used by the Payment Advice cron to deliver the PDF alongside the message.
// Caller is responsible for first uploading the PDF via uploadMedia() to get
// the mediaId.
//
// Args (in addition to sendTemplate's):
//   mediaId          — from uploadMedia() above
//   documentFilename — what the customer sees as the file name in WhatsApp
async function sendTemplateWithDocument({ to, templateName, languageCode = 'en', variables = [], mediaId, documentFilename } = {}) {
  if (!isConfigured())  return { ok: false, error: 'META_WA_NOT_CONFIGURED' };
  if (!mediaId)         return { ok: false, error: 'MEDIA_ID_REQUIRED' };
  if (!templateName)    return { ok: false, error: 'TEMPLATE_NAME_REQUIRED' };
  const phone = _normalisePhone(to);
  if (!phone)           return { ok: false, error: 'INVALID_PHONE' };

  const components = [
    {
      type: 'header',
      parameters: [{
        type: 'document',
        document: {
          id: mediaId,
          filename: documentFilename || 'Payment-Advice.pdf',
        },
      }],
    },
  ];
  if (variables && variables.length) {
    components.push({
      type: 'body',
      parameters: variables.map(v => ({ type: 'text', text: String(v ?? '') })),
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                phone,
    type:              'template',
    template: { name: templateName, language: { code: languageCode }, components },
  };

  try {
    return await _post(payload);
  } catch (err) {
    return { ok: false, error: err.message || 'NETWORK_ERROR', raw: err };
  }
}

// ─── Send freeform text (only inside the 24h conversation window) ─────────
async function sendText({ to, body } = {}) {
  if (!isConfigured()) return { ok: false, error: 'META_WA_NOT_CONFIGURED' };
  const phone = _normalisePhone(to);
  if (!phone) return { ok: false, error: 'INVALID_PHONE' };
  if (!body)  return { ok: false, error: 'BODY_REQUIRED' };

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                phone,
    type:              'text',
    text: { preview_url: false, body: String(body) },
  };

  try {
    return await _post(payload);
  } catch (err) {
    return { ok: false, error: err.message || 'NETWORK_ERROR', raw: err };
  }
}

module.exports = {
  isConfigured,
  sendTemplate,
  sendTemplateWithDocument,
  uploadMedia,
  sendText,
  _normalisePhone,    // exported for unit tests
  _extractAllPhones,  // exported for unit tests + future "send to all" mode
};
