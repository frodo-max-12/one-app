// =====================================================================
// modules/sales/routes/reminders.js — Payment Reminder module
//   GET    /log              list all reminders (role-filtered)
//   GET    /stats            summary counts
//   POST   /send-manual      send a manual reminder for one invoice
//   POST   /run-now          admin-only: trigger the daily cron right now
//   GET    /run-status       admin-only: check if cron is running
//   GET    /templates        list all templates
//   PUT    /templates/:stage edit a template (admin only)
//
// Mounted under /api/sales/reminders by modules/sales/index.js.
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getPool, getAppPool } = require('../../../db');
const { authenticate, isFullAccess, isSalesHead } = require('../../../auth');
const { getCompany } = require('../../../shared/company');
const reminderCron = require('../../../services/reminderCron');

// ─── Role-scope helper for BN_ReminderLog ──────────────────────────────────
function buildScopeClause(req, paramPrefix='sp') {
  const user  = req.user;
  const admin = isFullAccess(user);
  const head  = isSalesHead(user);

  // admin/full-access → no filter
  if (admin) return { clause: '', params: {} };

  // Collect user's codes (COMPANYA + CompanyB combined — filter applies per row via SalespersonCode match)
  const codes = [
    ...(user.companyaCode    || '').split('/').map(s=>s.trim()).filter(Boolean),
    ...(user.companybCode || '').split('/').map(s=>s.trim()).filter(Boolean),
  ];
  if (!codes.length) return { clause: ' AND 1=0 ', params: {} };   // no codes → no data

  const params = {};
  const placeholders = codes.map((c, i) => {
    const key = `${paramPrefix}${i}`;
    params[key] = c;
    return `@${key}`;
  }).join(',');

  return { clause: ` AND SalespersonCode IN (${placeholders}) `, params };
}

// ─── Payment-Advice scope helper ───────────────────────────────────────────
// BN_PaymentAdvice has no SalespersonCode column, so ownership is resolved the
// same way pdc.js does it: look up the user's customers in NAV first, then
// filter by CustomerCode. Salesperson-code namespaces are INDEPENDENT per NAV
// company, so ONLY the company-matching code column counts (companyaCode for COMPANYA,
// companybCode for COMPANYB) — a COMPANYA-only user must get zero COMPANYB rows.
// Admins skip the lookup. Binds the IN-list params onto the caller's request.

// 2-min cache of the NAV salesperson→customer lookup so stats + log + search
// keystrokes don't re-scan NAV Customer on every request.
const paCustCache = new Map();   // `${userId}|${companyCode}` -> { codes:[], at:ms }

async function getOwnedCustomerCodes(userId, company, spCodes) {
  const key = `${userId}|${company.code}`;
  const hit = paCustCache.get(key);
  if (hit && Date.now() - hit.at < 120000) return hit.codes;

  const navReq = (await getPool()).request();
  const ph = spCodes.map((c, i) => { navReq.input('sc'+i, sql.NVarChar(20), c); return '@sc'+i; }).join(',');
  const res = await navReq.query(
    `SELECT [No_] FROM ${company.prefix}Customer] WHERE [Salesperson Code] IN (${ph});`
  );
  const codes = res.recordset.map(x => x.No_);
  if (paCustCache.size > 200) paCustCache.clear();
  paCustCache.set(key, { codes, at: Date.now() });
  return codes;
}

async function buildPaScope(req, r, paramPrefix = 'pac') {
  if (isFullAccess(req.user)) return '';

  const company = getCompany(req);
  const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';
  const codes = (req.user[codeCol] || '').split('/').map(s=>s.trim()).filter(Boolean);
  if (!codes.length) return ' AND 1=0 ';

  const custCodes = await getOwnedCustomerCodes(req.user.id, company, codes);
  if (!custCodes.length) return ' AND 1=0 ';

  const inList = custCodes.map((c, i) => {
    const key = `${paramPrefix}${i}`;
    r.input(key, sql.NVarChar(20), c);
    return `@${key}`;
  }).join(',');
  return ` AND pa.CustomerCode IN (${inList}) `;
}

// ─── GET /api/sales/reminders/payment-advice-log ───────────────────────────
// Audit list of WhatsApp Payment Advices (BN_PaymentAdvice — separate table
// from BN_ReminderLog). Same page, selected via the Channel dropdown.
router.get('/payment-advice-log', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const flat = (v) => Array.isArray(v) ? (v[0] || '') : (v || '');
    const company  = flat(req.query.company);
    const status   = flat(req.query.status);
    const search   = flat(req.query.search);
    const fromDate = flat(req.query.fromDate);
    const toDate   = flat(req.query.toDate);
    const page  = parseInt(flat(req.query.page)  || '1',  10);
    const limit = parseInt(flat(req.query.limit) || '25', 10);
    const offset = (page - 1) * limit;

    const r = pool.request();
    let where = ' WHERE 1=1 ';
    where += await buildPaScope(req, r);

    if (company) { where += ' AND pa.Company = @company '; r.input('company', sql.NVarChar, company); }
    if (status)  { where += ' AND pa.Status = @status ';   r.input('status',  sql.NVarChar, status); }
    if (search)  {
      where += ` AND (pa.CustomerName LIKE @search OR pa.CustomerCode LIKE @search
                      OR pa.PaymentDocNo LIKE @search OR pa.Reference LIKE @search) `;
      r.input('search', sql.NVarChar, `%${search}%`);
    }
    if (fromDate) {
      const f = new Date(fromDate); f.setHours(0,0,0,0);   // local midnight, not UTC-parsed 05:30 IST
      where += ' AND pa.CreatedAt >= @fromDate '; r.input('fromDate', sql.DateTime, f);
    }
    if (toDate)   {
      const t = new Date(toDate); t.setHours(23,59,59,999);
      where += ' AND pa.CreatedAt <= @toDate '; r.input('toDate', sql.DateTime, t);
    }

    r.input('lim', sql.Int, limit);
    r.input('off', sql.Int, offset);

    const result = await r.query(`
      SELECT pa.Id, pa.Company, pa.CustomerCode, pa.CustomerName,
             pa.PaymentEntryNo, pa.PaymentDocNo,
             CONVERT(VARCHAR(10), pa.PaymentDate, 23) AS PaymentDate, pa.Amount,
             pa.PaymentMode, pa.Reference, pa.BankName, pa.AppliedInvoicesJson,
             pa.PdfUrl, pa.WhatsAppPhoneTo, pa.WhatsAppMessageId,
             pa.WhatsAppSentAt, pa.WhatsAppError, pa.Status, pa.CreatedAt
      FROM [dbo].[BN_PaymentAdvice] pa
      ${where}
      ORDER BY pa.CreatedAt DESC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY;

      SELECT COUNT(*) AS TotalRecords FROM [dbo].[BN_PaymentAdvice] pa ${where};
    `);
    res.json({
      data: result.recordsets[0] || [],
      total: result.recordsets[1]?.[0]?.TotalRecords || 0,
    });
  } catch (err) {
    console.error('Payment advice log error:', err.message);
    res.status(500).json({ message: 'Failed to load payment advice log', error: err.message });
  }
});

// ─── GET /api/sales/reminders/log ──────────────────────────────────────────
router.get('/log', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    // Coerce in case any param arrives twice in the URL (Express turns dupes into arrays)
    const flat = (v) => Array.isArray(v) ? (v[0] || '') : (v || '');
    const company  = flat(req.query.company);
    const channel  = flat(req.query.channel);
    const stage    = flat(req.query.stage);
    const search   = flat(req.query.search);
    const fromDate = flat(req.query.fromDate);
    const toDate   = flat(req.query.toDate);
    const page  = parseInt(flat(req.query.page)  || '1',  10);
    const limit = parseInt(flat(req.query.limit) || '25', 10);
    const offset = (page - 1) * limit;

    const { clause: scope, params: scopeParams } = buildScopeClause(req);

    let where = ' WHERE 1=1 ' + scope;
    const r = pool.request();
    Object.entries(scopeParams).forEach(([k, v]) => r.input(k, sql.NVarChar, v));

    if (company) { where += ' AND CompanyCode = @company ';  r.input('company', sql.NVarChar, company); }
    if (channel) { where += ' AND Channel = @channel ';      r.input('channel', sql.NVarChar, channel); }
    if (stage)   { where += ' AND ReminderStage = @stage ';  r.input('stage',   sql.NVarChar, stage); }
    if (search)  {
      where += ` AND (CustomerName LIKE @search OR CustomerNo LIKE @search
                      OR InvoiceNo LIKE @search OR ExtInvoiceNo LIKE @search) `;
      r.input('search', sql.NVarChar, `%${search}%`);
    }
    if (fromDate) { where += ' AND SentAt >= @fromDate '; r.input('fromDate', sql.DateTime, new Date(fromDate)); }
    if (toDate)   {
      const t = new Date(toDate); t.setHours(23,59,59,999);
      where += ' AND SentAt <= @toDate '; r.input('toDate', sql.DateTime, t);
    }

    r.input('lim', sql.Int, parseInt(limit));
    r.input('off', sql.Int, offset);

    const dataSql = `
      SELECT Id, CompanyCode, CustomerNo, CustomerName, InvoiceNo, ExtInvoiceNo,
             CONVERT(VARCHAR(10), PostingDate, 23) AS PostingDate,
             CONVERT(VARCHAR(10), DueDate, 23)     AS DueDate, Amount, OverdueDays,
             ReminderStage, ReminderNumber, SalespersonCode, SalespersonName,
             EmailTo, EmailCc, EmailFrom, Subject,
             SentAt, SentByUserName, IsManual, Status, ErrorMessage,
             Channel, WhatsAppMessageId, WhatsAppPhoneTo,
             -- Parse the recipient-kind out of Body for WhatsApp rows so the UI
             -- can show "Customer / Salesperson / Sales Head / Electrical Head /
             -- Admin" alongside the phone number. Body format is
             -- "Template: NAME | Recipient: KIND | Phone: NUMBER | Vars: [...]"
             -- so we slice between " | Recipient: " and " | Phone: ".
             CASE
               WHEN Channel = 'WHATSAPP'
                AND CHARINDEX(' | Recipient: ', Body) > 0
                AND CHARINDEX(' | Phone: ', Body, CHARINDEX(' | Recipient: ', Body)) > 0
               THEN SUBSTRING(
                      Body,
                      CHARINDEX(' | Recipient: ', Body) + 14,
                      CHARINDEX(' | Phone: ', Body, CHARINDEX(' | Recipient: ', Body))
                        - CHARINDEX(' | Recipient: ', Body) - 14
                    )
               ELSE NULL
             END AS RecipientKind
      FROM [dbo].[BN_ReminderLog]
      ${where}
      ORDER BY SentAt DESC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY;

      SELECT COUNT(*) AS TotalRecords FROM [dbo].[BN_ReminderLog] ${where};
    `;
    const result = await r.query(dataSql);
    res.json({
      data: result.recordsets[0] || [],
      total: result.recordsets[1]?.[0]?.TotalRecords || 0,
    });
  } catch (err) {
    console.error('Reminders log error:', err.message);
    res.status(500).json({ message: 'Failed to load reminder log', error: err.message });
  }
});

// ─── GET /api/sales/reminders/stats ────────────────────────────────────────
router.get('/stats', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const { clause: scope, params: scopeParams } = buildScopeClause(req);
    const r = pool.request();
    Object.entries(scopeParams).forEach(([k, v]) => r.input(k, sql.NVarChar, v));

    let companyClause = '';
    const flat = (v) => Array.isArray(v) ? (v[0] || '') : (v || '');
    const companyParam = flat(req.query.company);
    if (companyParam) {
      companyClause = ' AND CompanyCode = @company ';
      r.input('company', sql.NVarChar, companyParam);
    }

    // NOTE on counting:
    //   BN_ReminderLog stores ONE row per (recipient × triggered invoice) for
    //   audit. A single Meta WhatsApp send to one phone covering 3 triggered
    //   invoices is 3 rows. So COUNT(*) over-reports vs. what Meta / Gmail
    //   actually saw. The "Sent" counts below use COUNT(DISTINCT WhatsAppMessageId)
    //   and COUNT(DISTINCT MessageId) so the UI cards match the actual outbound
    //   message count on the provider side.
    //   Also: TEST_MODE skipped rows carry a synthetic 'TEST-…' WhatsAppMessageId.
    //   We filter those out (NOT LIKE 'TEST-%') so the dashboard count always
    //   matches Meta's real outbound — never the test-mode phantom sends.
    //   Failed / stage counts stay row-based — each row is an audit entry.

    // Payment Advice counts come from BN_PaymentAdvice (its own table — these
    // are acknowledgements of money RECEIVED, not reminders). Same counting
    // convention: distinct real wamids only, TEST- rows excluded. Runs in
    // PARALLEL with the reminder aggregate, and degrades to zeros on its own
    // failure so a NAV hiccup can never blank the four pre-existing cards.
    const paStatsPromise = (async () => {
      try {
        const r2 = pool.request();
        let paWhere = ' WHERE 1=1 ';
        paWhere += await buildPaScope(req, r2, 'pas');
        if (companyParam) {
          paWhere += ' AND pa.Company = @company ';
          r2.input('company', sql.NVarChar, companyParam);
        }
        const paRes = await r2.query(`
          SELECT
            COUNT(DISTINCT CASE WHEN pa.Status='sent' AND pa.WhatsAppMessageId NOT LIKE 'TEST-%'
                                THEN pa.WhatsAppMessageId END) AS PaymentAdviceCount,
            COUNT(DISTINCT CASE WHEN pa.Status='sent' AND pa.WhatsAppMessageId NOT LIKE 'TEST-%'
                                 AND CAST(pa.CreatedAt AS DATE) = CAST(GETDATE() AS DATE)
                                THEN pa.WhatsAppMessageId END) AS PaymentAdviceToday,
            ISNULL(SUM(CASE WHEN pa.Status='skipped'   THEN 1 ELSE 0 END), 0) AS PaymentAdviceSkipped,
            ISNULL(SUM(CASE WHEN pa.Status='failed'    THEN 1 ELSE 0 END), 0) AS PaymentAdviceFailed,
            ISNULL(SUM(CASE WHEN pa.Status='test_mode' THEN 1 ELSE 0 END), 0) AS PaymentAdviceTest
          FROM [dbo].[BN_PaymentAdvice] pa ${paWhere}
        `);
        return paRes.recordset[0] || {};
      } catch (e) {
        console.error('PA stats failed (card degrades to 0):', e.message);
        return { PaymentAdviceCount: 0, PaymentAdviceToday: 0, PaymentAdviceSkipped: 0, PaymentAdviceFailed: 0, PaymentAdviceTest: 0 };
      }
    })();

    const result = await r.query(`
      SELECT
        COUNT(DISTINCT CASE WHEN Channel='EMAIL'    AND Status='SENT' THEN MessageId         END) AS EmailCount,
        COUNT(DISTINCT CASE WHEN Channel='WHATSAPP' AND Status='SENT' AND WhatsAppMessageId NOT LIKE 'TEST-%' THEN WhatsAppMessageId END) AS WhatsAppCount,

        COUNT(DISTINCT CASE WHEN Channel='EMAIL'    AND Status='SENT' THEN MessageId         END)
          + COUNT(DISTINCT CASE WHEN Channel='WHATSAPP' AND Status='SENT' AND WhatsAppMessageId NOT LIKE 'TEST-%' THEN WhatsAppMessageId END) AS TotalSent,

        COUNT(DISTINCT CASE WHEN CAST(SentAt AS DATE)=CAST(GETDATE() AS DATE) AND Channel='EMAIL'    AND Status='SENT' THEN MessageId         END)
          + COUNT(DISTINCT CASE WHEN CAST(SentAt AS DATE)=CAST(GETDATE() AS DATE) AND Channel='WHATSAPP' AND Status='SENT' AND WhatsAppMessageId NOT LIKE 'TEST-%' THEN WhatsAppMessageId END) AS SentToday,

        COUNT(DISTINCT CASE WHEN IsManual=1 AND Channel='EMAIL'    AND Status='SENT' THEN MessageId         END)
          + COUNT(DISTINCT CASE WHEN IsManual=1 AND Channel='WHATSAPP' AND Status='SENT' AND WhatsAppMessageId NOT LIKE 'TEST-%' THEN WhatsAppMessageId END) AS ManualCount,

        SUM(CASE WHEN Status='SENT'    THEN 1 ELSE 0 END) AS Successful,
        SUM(CASE WHEN Status='SKIPPED' THEN 1 ELSE 0 END) AS Skipped,
        SUM(CASE WHEN Status='FAILED'  THEN 1 ELSE 0 END) AS Failed,

        SUM(CASE WHEN ReminderStage='PRE_DUE'   THEN 1 ELSE 0 END) AS StagePreDue,
        SUM(CASE WHEN ReminderStage='DUE_DAY'   THEN 1 ELSE 0 END) AS StageDueDay,
        SUM(CASE WHEN ReminderStage='OVERDUE'   THEN 1 ELSE 0 END) AS StageOverdue,
        SUM(CASE WHEN ReminderStage='FOLLOW_UP' THEN 1 ELSE 0 END) AS StageFollowUp
      FROM [dbo].[BN_ReminderLog]
      WHERE 1=1 ${scope} ${companyClause}
    `);

    const paStats = await paStatsPromise;
    res.json({ ...(result.recordset[0] || {}), ...paStats });
  } catch (err) {
    console.error('Reminders stats error:', err.message);
    res.status(500).json({ message: 'Failed to load stats', error: err.message });
  }
});

// ─── POST /api/sales/reminders/send-manual ─────────────────────────────────
// Body: { company: 'COMPANYA'|'COMPANYB', invoiceNo: 'INV-001', stage?: 'PRE_DUE'|..., channel?: 'EMAIL'|'WHATSAPP' }
// channel defaults to 'EMAIL' for backward compatibility.
router.post('/send-manual', authenticate, async (req, res) => {
  try {
    const { company, invoiceNo, stage } = req.body || {};
    const channel = ((req.body || {}).channel || 'EMAIL').toUpperCase();
    if (!company || !invoiceNo) {
      return res.status(400).json({ message: 'company and invoiceNo are required' });
    }
    if (!['EMAIL', 'WHATSAPP'].includes(channel)) {
      return res.status(400).json({ message: 'channel must be EMAIL or WHATSAPP' });
    }

    const companyObj = reminderCron.COMPANIES.find(c => c.code === company.toUpperCase());
    if (!companyObj) return res.status(400).json({ message: 'Invalid company' });

    // Fetch that one invoice (also pull phone number for WhatsApp path)
    const pool = await getPool();
    const P = companyObj.prefix;
    const q = await pool.request()
      .input('inv', sql.NVarChar, invoiceNo)
      .query(`
        WITH D AS (
          SELECT [Cust_ Ledger Entry No_] E, SUM([Amount (LCY)]) A
          FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_]
        )
        SELECT TOP 1
          cle.[Customer No_]          AS CustomerNo,
          c.[Name]                    AS CustomerName,
          c.[E-Mail]                  AS CustomerEmail,
          c.[Phone No_]               AS CustomerPhone,
          c.[Salesperson Code]        AS SalespersonCode,
          ISNULL(sp.[Name], c.[Salesperson Code]) AS SalespersonName,
          sp.[E-Mail]                 AS SalespersonEmailNav,
          cle.[Document No_]          AS InvoiceNo,
          cle.[External Document No_] AS ExtInvoiceNo,
          cle.[Posting Date]          AS PostingDate,
          cle.[Due Date]              AS DueDate,
          ISNULL(d.A,0)               AS RemainingAmount,
          DATEDIFF(DAY,cle.[Due Date],CAST(GETDATE() AS DATE)) AS OverdueDays,
          DATEDIFF(DAY,CAST(GETDATE() AS DATE),cle.[Due Date]) AS DaysToDue
        FROM ${P}Cust_ Ledger Entry] cle
        LEFT JOIN D d ON d.E = cle.[Entry No_]
        LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
        LEFT JOIN ${P}Salesperson_Purchaser] sp ON sp.[Code] = c.[Salesperson Code]
        WHERE cle.[Open] = 1 AND ISNULL(d.A,0) > 0 AND cle.[Document No_] = @inv
      `);

    const inv = q.recordset[0];
    if (!inv) return res.status(404).json({ message: 'Invoice not found or already paid/closed' });

    // Role-scope: sales/sales-head can only manual-send for their own customers
    if (!isFullAccess(req.user)) {
      const userCodes = [
        ...(req.user.companyaCode    || '').split('/').map(s=>s.trim()).filter(Boolean),
        ...(req.user.companybCode || '').split('/').map(s=>s.trim()).filter(Boolean),
      ];
      if (inv.SalespersonCode && !userCodes.includes(inv.SalespersonCode)) {
        return res.status(403).json({ message: 'Not authorized for this customer' });
      }
    }

    // Decide stage — if caller provided one use it, else auto-detect
    let finalStage = stage;
    if (!finalStage) {
      const od = inv.OverdueDays;
      if      (od < 0)  finalStage = 'PRE_DUE';
      else if (od === 0) finalStage = 'DUE_DAY';
      else if (od <= 3)  finalStage = 'OVERDUE';
      else               finalStage = 'FOLLOW_UP';
    }

    let result;
    if (channel === 'WHATSAPP') {
      // Reuse the consolidated WhatsApp path with a single triggered invoice
      const triggered = [{ ...inv, ComputedStage: finalStage }];
      result = await reminderCron.sendWhatsAppReminder({
        company:     companyObj,
        customer: {
          customerNo:          inv.CustomerNo,
          customerName:        inv.CustomerName,
          customerEmail:       inv.CustomerEmail,
          customerPhone:       inv.CustomerPhone,
          salespersonCode:     inv.SalespersonCode,
          salespersonName:     inv.SalespersonName,
          salespersonEmailNav: inv.SalespersonEmailNav,
        },
        triggered,
        allInvoices: triggered,
        isManual:    true,
        user:        req.user,
      });
    } else {
      result = await reminderCron.sendOneReminder({
        company: companyObj,
        invoice: inv,
        stage:   finalStage,
        user:    req.user,
        isManual: true,
      });
    }

    if (result.status === 'FAILED') {
      return res.status(502).json({
        message: channel === 'WHATSAPP' ? 'WhatsApp send failed' : 'Email failed',
        error:   result.errorMessage,
      });
    }
    res.json({ message: 'Reminder sent', channel, stage: finalStage, status: result.status });
  } catch (err) {
    console.error('send-manual error:', err);
    res.status(500).json({ message: 'Failed to send reminder', error: err.message });
  }
});

// ─── POST /api/sales/reminders/run-now (admin only — trigger cron manually) ─
// Non-blocking: kicks off cron in background and returns immediately.
router.post('/run-now', authenticate, async (req, res) => {
  if (!isFullAccess(req.user)) return res.status(403).json({ message: 'Admin only' });

  // Prevent concurrent runs
  if (global.__reminderCronRunning) {
    return res.status(409).json({
      message: 'Cron is already running. Please wait for it to finish.',
    });
  }

  const filterCompany = (req.body?.company || req.query?.company || '').toString().toUpperCase();
  const channel       = (req.body?.channel || req.query?.channel || 'ALL').toString().toUpperCase();

  global.__reminderCronRunning = true;
  setImmediate(async () => {
    try {
      await reminderCron.runDaily(filterCompany || null, { channel });
    } catch (err) {
      console.error('Background cron run failed:', err);
    } finally {
      global.__reminderCronRunning = false;
    }
  });

  res.json({
    message: 'Cron started in background. Check server terminal for progress. Refresh the page in a few minutes to see results.',
    note:    'At ~25 mails/min due to Gmail rate limits, 300 mails take ~12 minutes.',
  });
});

// ─── GET /api/sales/reminders/run-status — check if cron is running ────────
router.get('/run-status', authenticate, async (req, res) => {
  res.json({ running: !!global.__reminderCronRunning });
});

// ─── GET /api/sales/reminders/templates ────────────────────────────────────
router.get('/templates', authenticate, async (req, res) => {
  try {
    const pool = await getAppPool();
    const result = await pool.request().query(`
      SELECT Id, Stage, Subject, Body, IsActive, UpdatedAt, UpdatedBy
      FROM [dbo].[BN_ReminderTemplates]
      ORDER BY
        CASE Stage
          WHEN 'PRE_DUE'   THEN 1
          WHEN 'DUE_DAY'   THEN 2
          WHEN 'OVERDUE'   THEN 3
          WHEN 'FOLLOW_UP' THEN 4
          ELSE 99 END
    `);
    res.json({ data: result.recordset || [] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load templates', error: err.message });
  }
});

// ─── PUT /api/sales/reminders/templates/:stage (admin only) ────────────────
router.put('/templates/:stage', authenticate, async (req, res) => {
  if (!isFullAccess(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const { subject, body, isActive } = req.body || {};
    const stage = (req.params.stage || '').toUpperCase();
    const pool = await getAppPool();
    await pool.request()
      .input('stage',    sql.NVarChar, stage)
      .input('subject',  sql.NVarChar, subject || '')
      .input('body',     sql.NVarChar(sql.MAX), body || '')
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .input('user',     sql.NVarChar, req.user.name || req.user.username || '')
      .query(`
        UPDATE [dbo].[BN_ReminderTemplates]
        SET Subject = @subject, Body = @body, IsActive = @isActive,
            UpdatedAt = GETDATE(), UpdatedBy = @user
        WHERE Stage = @stage
      `);
    res.json({ message: 'Template updated' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update template', error: err.message });
  }
});

module.exports = router;
