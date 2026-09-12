// =====================================================================
// services/pdcReminderCron.js — PDC "cheque deposit" WhatsApp reminders
//
// Reminds a customer (and CCs the Salesperson + Sales Head, exactly like the
// payment-reminder chain) that a post-dated cheque of theirs is due to be
// deposited in our bank — so they keep sufficient balance. Fires on a tiered
// cadence BEFORE the cheque date: 5, 3, 1 days before + on the day (0).
//
// Source of truth: BN_PDC rows with Status='not_deposited' (configurable) and
// a ChequeDate that is DaysBefore days away. Uses the approved Meta template
// `pdc_deposit_reminder` (5 body vars). De-dups via BN_PdcReminderLog so a
// given cheque×tier×phone sends at most once — the cron is safe to re-run.
//
// Reuses reminderCron's recipient resolvers so the Customer→Salesperson→
// Sales-Head chain stays single-sourced.
//
// Config (.env), all optional — safe defaults, OFF until PDC_REMINDER_ENABLED=true:
//   PDC_REMINDER_ENABLED=false
//   PDC_REMINDER_CRON=0 10 * * *            # daily 10:00 IST
//   PDC_REMINDER_TIERS=5,3,1,0              # days before cheque date
//   PDC_REMINDER_STATUSES=not_deposited     # BN_PDC statuses that trigger
//   PDC_REMINDER_TEMPLATE=pdc_deposit_reminder
//   PDC_REMINDER_LANG=en
//   PDC_REMINDER_CC_ROLES=                  # falls back to REMINDER_WA_CC_ROLES
//   PDC_REMINDER_CC_USERNAMES=              # falls back to REMINDER_WA_CC_USERNAMES
//   PDC_REMINDER_COMPANIES=COMPANYA              # which companies to scan
//   (test-mode reuses REMINDER_WA_TEST_MODE + REMINDER_WA_TEST_FORWARD_TO)
// =====================================================================
const cron     = require('node-cron');
const { getPool, getAppPool, sql } = require('../db');
const whatsapp = require('../shared/whatsapp');
const { getCompanyByCode } = require('../shared/company');
const reminder = require('./reminderCron');   // reuse recipient resolvers

// ── config ───────────────────────────────────────────────────────────
const ENABLED    = String(process.env.PDC_REMINDER_ENABLED || '').toLowerCase() === 'true';
const CRON_EXPR  = process.env.PDC_REMINDER_CRON || '0 10 * * *';
const TIERS      = (process.env.PDC_REMINDER_TIERS || '5,3,1,0')
                     .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
const STATUSES   = (process.env.PDC_REMINDER_STATUSES || 'not_deposited')
                     .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const TEMPLATE   = process.env.PDC_REMINDER_TEMPLATE || 'pdc_deposit_reminder';
const LANG       = process.env.PDC_REMINDER_LANG || 'en';
const CC_ROLES   = (process.env.PDC_REMINDER_CC_ROLES || process.env.REMINDER_WA_CC_ROLES || '')
                     .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CC_USERS   = (process.env.PDC_REMINDER_CC_USERNAMES || process.env.REMINDER_WA_CC_USERNAMES || '')
                     .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const COMPANY_CODES = (process.env.PDC_REMINDER_COMPANIES || 'COMPANYA')
                     .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const WA_TEST_MODE       = String(process.env.REMINDER_WA_TEST_MODE || '').toLowerCase() === 'true';
const WA_TEST_FORWARD_TO = (process.env.REMINDER_WA_TEST_FORWARD_TO || '').trim();
// Hard dry-run: resolve recipients + write SKIPPED audit rows but make ZERO Meta
// API calls. Use to validate the pipeline before the template is approved.
const DRY_RUN = String(process.env.PDC_REMINDER_DRY_RUN || '').toLowerCase() === 'true';

// ── helpers ──────────────────────────────────────────────────────────
function fmtAmt(companyCode, amt) {
  const cur = companyCode === 'COMPANYB' ? 'USD' : 'INR';
  return cur + ' ' + new Intl.NumberFormat('en-IN',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amt || 0);
}

function tierLabel(d) {
  if (d === 0) return 'today (deposit day)';
  if (d === 1) return 'in 1 day';
  return `in ${d} days`;
}

// Batch NAV lookup: customer code → { phone (normalised), spCode }.
async function loadCustomerInfo(company, codes) {
  const map = new Map();
  const uniq = [...new Set((codes || []).filter(Boolean))];
  if (!uniq.length) return map;
  const navPool = await getPool();
  const params = uniq.map((_, i) => `@c${i}`).join(',');
  const req = navPool.request();
  uniq.forEach((c, i) => req.input(`c${i}`, sql.NVarChar(50), c));
  const r = await req.query(`
    SELECT [No_] AS Code, [Phone No_] AS Phone, [Salesperson Code] AS SpCode
    FROM ${company.prefix}Customer] WITH (NOLOCK)
    WHERE [No_] IN (${params})`);
  for (const row of r.recordset) {
    map.set(row.Code, {
      phone:  row.Phone ? whatsapp._normalisePhone(row.Phone) : null,
      spCode: row.SpCode || null,
    });
  }
  return map;
}

// Has this exact cheque × tier × phone already been SENT?
async function alreadySent(appPool, companyCode, chequeNo, chequeDate, daysBefore, phone) {
  const r = await appPool.request()
    .input('co', sql.NVarChar(10), companyCode)
    .input('cn', sql.NVarChar(50), chequeNo)
    .input('cd', sql.Date, chequeDate)
    .input('db', sql.Int, daysBefore)
    .input('ph', sql.NVarChar(30), phone)
    .query(`SELECT TOP 1 Id FROM dbo.BN_PdcReminderLog
            WHERE CompanyCode=@co AND ChequeNo=@cn AND ChequeDate=@cd
              AND DaysBefore=@db AND PhoneTo=@ph AND Status='SENT'`);
  return r.recordset.length > 0;
}

async function logPdc(appPool, row) {
  await appPool.request()
    .input('co',   sql.NVarChar(10),  row.CompanyCode)
    .input('pid',  sql.Int,           row.PDCId || null)
    .input('cc',   sql.NVarChar(50),  row.CustomerCode || null)
    .input('cn',   sql.NVarChar(200), row.CustomerName || null)
    .input('chq',  sql.NVarChar(50),  row.ChequeNo || null)
    .input('cd',   sql.Date,          row.ChequeDate || null)
    .input('amt',  sql.Decimal(18,2), row.Amount || 0)
    .input('bank', sql.NVarChar(100), row.BankName || null)
    .input('db',   sql.Int,           row.DaysBefore)
    .input('kind', sql.NVarChar(30),  row.RecipientKind || null)
    .input('ph',   sql.NVarChar(30),  row.PhoneTo || null)
    .input('tpl',  sql.NVarChar(100), row.TemplateName || null)
    .input('mid',  sql.NVarChar(100), row.WaMessageId || null)
    .input('st',   sql.NVarChar(20),  row.Status)
    .input('err',  sql.NVarChar(500), row.ErrorMessage || null)
    .input('man',  sql.Bit,           row.IsManual ? 1 : 0)
    .query(`INSERT INTO dbo.BN_PdcReminderLog
      (CompanyCode, PDCId, CustomerCode, CustomerName, ChequeNo, ChequeDate, Amount,
       BankName, DaysBefore, RecipientKind, PhoneTo, TemplateName, WaMessageId,
       Status, ErrorMessage, IsManual, SentAt)
      VALUES (@co,@pid,@cc,@cn,@chq,@cd,@amt,@bank,@db,@kind,@ph,@tpl,@mid,@st,@err,@man,SYSDATETIME())`)
    .catch(e => console.error('[pdcReminder] log insert failed:', e.message));
}

// Build the deduped recipient chain for one cheque (mirrors reminderCron).
async function buildRecipients(companyCode, custPhone, spCode) {
  const recipients = [];
  recipients.push({ phone: custPhone, kind: 'CUSTOMER' });                 // (1) TO

  const spPhone = await reminder.resolveSalespersonPhone(companyCode, spCode); // (2) salesperson
  if (spPhone) recipients.push({ phone: spPhone, kind: 'SALESPERSON' });

  for (const role of CC_ROLES) {                                           // (3) role CCs (sales head…)
    const phones = await reminder.getRolePhones(companyCode, [role], spCode);
    phones.forEach(p => recipients.push({ phone: p, kind: 'ROLE_CC:' + role.toUpperCase().replace(/\s+/g, '_') }));
  }
  if (CC_USERS.length) {                                                   // (4) explicit user CCs
    const phones = await reminder.getSpecificUserPhones(CC_USERS);
    phones.forEach(p => recipients.push({ phone: p, kind: 'USER_CC' }));
  }

  // Test-mode: collapse the whole chain to one forward number.
  if (WA_TEST_MODE && WA_TEST_FORWARD_TO) {
    return [{ phone: WA_TEST_FORWARD_TO, kind: 'TEST_FORWARD' }];
  }

  // Dedupe by phone, keep first occurrence (earliest in escalation order).
  const seen = new Set();
  return recipients.filter(r => {
    if (!r.phone) return false;
    if (seen.has(r.phone)) return false;
    seen.add(r.phone); return true;
  });
}

// ── per-company pass ─────────────────────────────────────────────────
async function processCompany(companyCode, { isManual = false, dryRun } = {}) {
  const stats = { cheques: 0, sent: 0, skipped: 0, failed: 0 };
  const company = getCompanyByCode(companyCode);
  const appPool = await getAppPool();

  // Due cheques for the configured tiers + statuses.
  const stParams = STATUSES.map((_, i) => `@s${i}`).join(',');
  const tierList = TIERS.join(',');           // small integer set — safe to inline
  const req = appPool.request().input('co', sql.NVarChar(10), companyCode);
  STATUSES.forEach((s, i) => req.input(`s${i}`, sql.NVarChar(20), s));
  const dueRes = await req.query(`
    SELECT PDCId, CustomerCode, CustomerName, ChequeNo, ChequeDate, Amount, BankName,
           DATEDIFF(day, CAST(GETDATE() AS DATE), ChequeDate) AS DaysToDue,
           CONVERT(VARCHAR(11), ChequeDate, 106) AS ChequeDateDisp
    FROM dbo.BN_PDC WITH (NOLOCK)
    WHERE IsActive = 1 AND Company = @co AND ChequeDate IS NOT NULL
      AND LOWER(Status) IN (${stParams})
      AND DATEDIFF(day, CAST(GETDATE() AS DATE), ChequeDate) IN (${tierList})`);

  const cheques = dueRes.recordset || [];
  stats.cheques = cheques.length;
  if (!cheques.length) { console.log(`   PDC reminder ${companyCode}: no cheques due at tiers [${tierList}]`); return stats; }

  const custInfo = await loadCustomerInfo(company, cheques.map(c => c.CustomerCode));
  const dry = (dryRun === undefined) ? DRY_RUN : !!dryRun;
  const skipRealSend = dry || (WA_TEST_MODE ? false : !whatsapp.isConfigured());

  for (const chq of cheques) {
    const daysBefore = chq.DaysToDue;
    const info = custInfo.get(chq.CustomerCode) || {};
    const recipients = await buildRecipients(companyCode, info.phone, info.spCode);

    if (!recipients.length) {
      await logPdc(appPool, { CompanyCode: companyCode, PDCId: chq.PDCId, CustomerCode: chq.CustomerCode,
        CustomerName: chq.CustomerName, ChequeNo: chq.ChequeNo, ChequeDate: chq.ChequeDate, Amount: chq.Amount,
        BankName: chq.BankName, DaysBefore: daysBefore, RecipientKind: 'NONE', PhoneTo: null,
        TemplateName: TEMPLATE, Status: 'FAILED', ErrorMessage: 'No recipients resolved (customer phone empty on NAV + no CC)',
        IsManual: isManual });
      stats.failed++;
      continue;
    }

    // Template body vars: {{1}} name  {{2}} cheque no  {{3}} amount(cur)  {{4}} bank  {{5}} deposit date
    const variables = [
      chq.CustomerName || 'Customer',
      chq.ChequeNo || '-',
      fmtAmt(companyCode, chq.Amount),
      chq.BankName || 'your bank',
      chq.ChequeDateDisp,
    ];

    for (const rcpt of recipients) {
      // De-dup: never resend the same cheque×tier×phone.
      if (await alreadySent(appPool, companyCode, chq.ChequeNo, chq.ChequeDate, daysBefore, rcpt.phone)) {
        stats.skipped++;
        continue;
      }

      if (skipRealSend) {
        await logPdc(appPool, { CompanyCode: companyCode, PDCId: chq.PDCId, CustomerCode: chq.CustomerCode,
          CustomerName: chq.CustomerName, ChequeNo: chq.ChequeNo, ChequeDate: chq.ChequeDate, Amount: chq.Amount,
          BankName: chq.BankName, DaysBefore: daysBefore, RecipientKind: rcpt.kind, PhoneTo: rcpt.phone,
          TemplateName: TEMPLATE, Status: 'SKIPPED', ErrorMessage: 'WA not configured / dry-run', IsManual: isManual });
        stats.skipped++;
        continue;
      }

      const res = await whatsapp.sendTemplate({ to: rcpt.phone, templateName: TEMPLATE, languageCode: LANG, variables });
      await logPdc(appPool, { CompanyCode: companyCode, PDCId: chq.PDCId, CustomerCode: chq.CustomerCode,
        CustomerName: chq.CustomerName, ChequeNo: chq.ChequeNo, ChequeDate: chq.ChequeDate, Amount: chq.Amount,
        BankName: chq.BankName, DaysBefore: daysBefore, RecipientKind: rcpt.kind, PhoneTo: rcpt.phone,
        TemplateName: TEMPLATE, WaMessageId: res.ok ? res.messageId : null,
        Status: res.ok ? 'SENT' : 'FAILED', ErrorMessage: res.ok ? null : (res.error || 'send failed'),
        IsManual: isManual });
      if (res.ok) stats.sent++; else stats.failed++;
    }
  }

  console.log(`   PDC reminder ${companyCode}: cheques=${stats.cheques} sent=${stats.sent} skipped=${stats.skipped} failed=${stats.failed}`);
  return stats;
}

// ── entry points ─────────────────────────────────────────────────────
async function runNow({ isManual = true, companies, dryRun } = {}) {
  const codes = companies && companies.length ? companies : COMPANY_CODES;
  const out = {};
  for (const code of codes) {
    try { out[code] = await processCompany(code, { isManual, dryRun }); }
    catch (e) { console.error(`[pdcReminder] ${code} failed:`, e.message); out[code] = { error: e.message }; }
  }
  return out;
}

function start() {
  if (!ENABLED) { console.log('⏸  PDC deposit reminder cron disabled (PDC_REMINDER_ENABLED=false)'); return; }
  if (!cron.validate(CRON_EXPR)) { console.warn(`⚠ PDC reminder: invalid cron "${CRON_EXPR}" — not scheduled`); return; }
  cron.schedule(CRON_EXPR, () => {
    console.log(`⏰ PDC deposit reminder run (${new Date().toISOString()})`);
    runNow({ isManual: false }).catch(e => console.error('[pdcReminder] run failed:', e.message));
  }, { timezone: 'Asia/Kolkata' });
  console.log(`⏰ PDC deposit reminder cron scheduled: "${CRON_EXPR}" (Asia/Kolkata) · tiers [${TIERS.join(',')}] · statuses [${STATUSES.join(',')}] · companies [${COMPANY_CODES.join(',')}]`);
}

module.exports = { start, runNow, processCompany };
