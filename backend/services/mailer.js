// =====================================================================
// Mailer service — Nodemailer wrapper for Payment Reminder module
// Reads SMTP credentials from .env. If not configured, logs + returns fail.
// =====================================================================

const nodemailer = require('nodemailer');
require('dotenv').config();

let transporter = null;
let transporterReady = false;

function buildTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  if (!host || !user || !pass) {
    console.warn('⚠️  SMTP not configured — reminder emails will NOT be sent. Fill SMTP_* in .env');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

function getTransporter() {
  if (!transporter && !transporterReady) {
    transporter = buildTransporter();
    transporterReady = true;
  }
  return transporter;
}

// Returns the formatted "Name <email>" from-address for a given company.
// - company = 'COMPANYA'    → reminders@company-a.example
// - company = 'COMPANYB' → reminders@company-b.example
// - anything else      → fallback SMTP_FROM_* (or SMTP_USER)
function getFromAddress(company) {
  const c = (company || '').toString().toUpperCase();
  let name, email;
  if (c === 'COMPANYA') {
    name  = process.env.SMTP_COMPANYA_FROM_NAME  || 'Company A - Payment Reminders';
    email = process.env.SMTP_COMPANYA_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '';
  } else if (c === 'COMPANYB') {
    name  = process.env.SMTP_COMPANYB_FROM_NAME  || 'Company B - Payment Reminders';
    email = process.env.SMTP_COMPANYB_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '';
  } else {
    name  = process.env.SMTP_FROM_NAME  || 'Payment Reminders';
    email = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '';
  }
  if (!email) return null;
  return `"${name}" <${email}>`;
}

// Returns just the email portion (for logging)
function getFromEmail(company) {
  const c = (company || '').toString().toUpperCase();
  if (c === 'COMPANYA')    return process.env.SMTP_COMPANYA_FROM_EMAIL    || process.env.SMTP_FROM_EMAIL || '';
  if (c === 'COMPANYB') return process.env.SMTP_COMPANYB_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || '';
  return process.env.SMTP_FROM_EMAIL || '';
}

/**
 * Send an email.
 * @param {object} opts
 * @param {string|string[]} opts.to
 * @param {string|string[]} [opts.cc]
 * @param {string} opts.subject
 * @param {string} opts.text
 * @param {string} [opts.html]
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
// Auto-generated footer — appended to every outgoing mail so we never forget
// to put it on a new template. Disable per-mail with `opts.noAutoFooter = true`
// (no current caller needs this, but it's there if a future human-composed mail
// goes through the same mailer).
const AUTO_FOOTER_TEXT =
  '\n\n---\n' +
  'This is an auto-generated email from ONE App — please do not reply to this address.\n' +
  'For questions, reach out to your salesperson or accounts contact directly.';

const AUTO_FOOTER_HTML =
  '<hr style="margin:24px 0 12px;border:0;border-top:1px solid #d4d4d4;">' +
  '<div style="font-size:11px;color:#737373;line-height:1.45;font-family:Arial,sans-serif;">' +
    '<em>This is an auto-generated email from ONE App — please do not reply to this address.</em><br>' +
    'For questions, reach out to your salesperson or accounts contact directly.' +
  '</div>';

async function sendMail(opts) {
  const t = getTransporter();
  // opts.from (a full `"Name" <email>` string) overrides the per-company default —
  // used by the MOM module for its dedicated sender. Falls back to company default.
  const from = opts.from || getFromAddress(opts.company);

  if (!t || !from) {
    return { ok: false, error: 'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_FROM_EMAIL in .env' };
  }

  try {
    const appendFooter = !opts.noAutoFooter;
    const textBody = appendFooter ? ((opts.text || '') + AUTO_FOOTER_TEXT) : (opts.text || '');
    const htmlBase = opts.html || (opts.text || '').replace(/\n/g, '<br>');
    const htmlBody = appendFooter ? (htmlBase + AUTO_FOOTER_HTML) : htmlBase;

    const mailOpts = {
      from,
      to: Array.isArray(opts.to) ? opts.to.join(',') : opts.to,
      cc: opts.cc ? (Array.isArray(opts.cc) ? opts.cc.join(',') : opts.cc) : undefined,
      subject: opts.subject,
      text: textBody,
      html: htmlBody,
    };

    // Email threading — chain replies into same conversation
    if (opts.inReplyTo) {
      mailOpts.inReplyTo = opts.inReplyTo;
      mailOpts.references = opts.references || opts.inReplyTo;
    }

    const info = await t.sendMail(mailOpts);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('Mailer error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Render a template string by substituting {{placeholder}} tokens.
 */
function renderTemplate(template, vars) {
  if (!template) return '';
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? '' : String(v);
  });
}

module.exports = { sendMail, renderTemplate, getFromAddress, getFromEmail };
