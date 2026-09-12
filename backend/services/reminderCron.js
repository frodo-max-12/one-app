// =====================================================================
// Reminder Cron — scans open invoices across COMPANYA & CompanyB, sends emails
// and WhatsApp template messages on independent schedules.
//
// EMAIL — Monthly Statement mode (2026-05-14):
//   Cron fires once a month (REMINDER_EMAIL_CRON=0 9 1 * *) at 9 AM IST
//   on the 1st of every month. Every customer with at least one open
//   invoice receives ONE consolidated mail listing all their open
//   invoices grouped into 3 sections (Overdue / Follow-up, Due Today,
//   Pre-Due / Upcoming) with subtotals and a grand total. No per-day
//   stage-based trigger filter — the cron schedule itself controls
//   cadence. CC chain is fixed (REMINDER_EMAIL_CC_ROLES) regardless of
//   severity: Salesperson + Sales Head (team-scoped) + Admin + ALWAYS_CC.
//
// WHATSAPP — Trigger-based mode (unchanged):
//   decideStage() per invoice; PRE_DUE 4 days before, DUE_DAY on due,
//   OVERDUE +3 days, FOLLOW_UP every 3 days after. Templates approved
//   in Meta. Per-customer chain: Customer → Salesperson → role-CCs →
//   user-CCs. Independent cron schedule (REMINDER_WA_CRON).
// =====================================================================

const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const { sql, getPool, getAppPool } = require('../db');
const { sendMail, renderTemplate, getFromEmail } = require('./mailer');
const whatsapp = require('../shared/whatsapp');
const pa       = require('./paymentAdvice');
const paPdf    = require('./paymentAdvicePdf');
require('dotenv').config();

const COMPANIES = [
  { code: 'COMPANYA',    prefix: '[dbo].[Company A Pvt_ Ltd_$',   label: 'Company A Pvt. Ltd.',   currency: 'INR', locale: 'en-IN' },
  { code: 'COMPANYB', prefix: '[dbo].[Company B Pte Ltd_$', label: 'Company B Pte Ltd.', currency: 'USD', locale: 'en-US' },
];

// Legacy single flag — affects BOTH email and WhatsApp unless a per-channel
// flag below overrides it. Kept for backward-compatibility with old .env files.
const TEST_MODE      = String(process.env.REMINDER_TEST_MODE || 'true').toLowerCase() === 'true';

// Per-channel test-mode flags. If set, they take precedence over TEST_MODE so
// you can (for example) keep emails in test mode while sending real WhatsApp.
//   REMINDER_EMAIL_TEST_MODE  → drives the email pass below
//   REMINDER_WA_TEST_MODE     → drives the WhatsApp pass (skipRealSend)
const EMAIL_TEST_MODE = process.env.REMINDER_EMAIL_TEST_MODE !== undefined
  ? String(process.env.REMINDER_EMAIL_TEST_MODE).toLowerCase() === 'true'
  : TEST_MODE;
const WA_TEST_MODE = process.env.REMINDER_WA_TEST_MODE !== undefined
  ? String(process.env.REMINDER_WA_TEST_MODE).toLowerCase() === 'true'
  : TEST_MODE;

const TEST_EMAIL     = process.env.REMINDER_TEST_EMAIL || 'reminders@company-b.example';
const PRE_DUE_DAYS   = parseInt(process.env.REMINDER_PRE_DUE_DAYS) || 4;
const FOLLOWUP_INT   = parseInt(process.env.REMINDER_FOLLOWUP_INTERVAL) || 3;

// ─── Isolated test-mode flags (2026-05-14) ─────────────────────────────────
// REMINDER_EMAIL_TEST_SUPPRESS_CC — when true AND EMAIL_TEST_MODE is on,
//   the CC list is emptied so the test email goes ONLY to TEST_EMAIL.
//   Useful when you want a fully-isolated end-to-end test without spamming
//   the team's real sales heads / salesperson / mis@ on every test run.
// REMINDER_WA_TEST_FORWARD_TO — when set AND WA_TEST_MODE is on, the entire
//   recipient chain (customer + salesperson + heads + admin) collapses to
//   this single phone number — one real Meta API call per customer reminder
//   is made to this number. Supersedes REMINDER_WA_CUSTOMER_OVERRIDE.
//   Set to a phone like 91XXXXXXXXXX to receive test WA at your own number.
const EMAIL_TEST_SUPPRESS_CC = String(process.env.REMINDER_EMAIL_TEST_SUPPRESS_CC || 'false').toLowerCase() === 'true';
const WA_TEST_FORWARD_TO     = (process.env.REMINDER_WA_TEST_FORWARD_TO || '').trim();

// Legacy per-stage CC role lists — still used by the per-invoice manual send
// (sendOneReminder, called from the Outstanding-page ✉ button). The monthly
// bulk email no longer uses these; see EMAIL_CC_ROLES below.
const ROLE_DUE_DAY   = (process.env.REMINDER_CC_DUE_DAY   || 'sales head').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ROLE_OVERDUE   = (process.env.REMINDER_CC_OVERDUE   || 'sales head,admin').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ROLE_FOLLOWUP  = (process.env.REMINDER_CC_FOLLOWUP  || 'sales head,admin').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Monthly-statement CC roles (2026-05-14). The 1st-of-month bulk email
// always CCs this fixed set regardless of severity. Salesperson is added
// separately by resolveSalespersonEmail(); ALWAYS_CC is appended below.
// "head" role strings are team-scoped inside getRoleEmails — a head only
// gets CC'd if the customer's salesperson is in their CompanyACode/CompanyBCode.
// "admin" is global. Default covers admin + every head role currently in
// use so a fresh install works without env tuning.
const EMAIL_CC_ROLES = (process.env.REMINDER_EMAIL_CC_ROLES
  || 'admin,sales head,sales head electrical,electrical head,north sales head,south sales head'
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const ALWAYS_CC      = (process.env.REMINDER_ALWAYS_CC    || '').split(',').map(s => s.trim()).filter(Boolean);

// ─── Paid-in-advance customer detection (2026-05-14) ───────────────────────
// A customer is treated as "settled" (skipped from reminders) if either:
//   (a) absolute net balance is at/below a tiny floor — pure rounding noise,
//   (b) net balance is < MIN_OUTSTANDING_RATIO of their open invoice total —
//       i.e. ≥ (1 - ratio) of the invoice value is covered by unapplied
//       payments / credit memos sitting on the customer's account in NAV.
//
// Net balance = SUM(Detailed Cust_ Ledg_ Entry.Amount LCY) across ALL of the
// customer's open ledger entries (invoices +ve, payments + credit memos -ve).
// Matches NAV's Customer.[Balance (LCY)] FlowField.
//
// Example — SiXSense Mobility 2026-05-14:
//   Open invoice COMPANYA/26/27/0275 = ₹1,04,696, but customer's net balance = ₹0.50
//   (advance payments collected but accounting hasn't yet APPLIED them in NAV).
//   → 99.9995% covered → settled → no reminder fired.
//
// Anti-pattern — MITATRONICS 2026-05-14:
//   Open invoice ₹90.72, net balance ₹90.72 → 0% covered → real owing → send.
//
// Defaults:
//   MIN_BALANCE_*           = 1 (LCY unit — only catches literal zero/rounding)
//   MIN_OUTSTANDING_RATIO   = 0.05 (5% — if < 5% of invoice total remains
//                                    after netting unapplied payments, skip)
const MIN_BALANCE_COMPANYA          = Number(process.env.REMINDER_MIN_BALANCE_COMPANYA          || 1);
const MIN_BALANCE_COMPANYB       = Number(process.env.REMINDER_MIN_BALANCE_COMPANYB       || 1);
const MIN_OUTSTANDING_RATIO    = Number(process.env.REMINDER_MIN_OUTSTANDING_RATIO    || 0.05);

function getMinBalance(companyCode) {
  return companyCode === 'COMPANYA' ? MIN_BALANCE_COMPANYA : MIN_BALANCE_COMPANYB;
}

// Returns { settled, reason } for a customer group. Used by both email and
// WhatsApp passes to skip paid-in-advance customers consistently.
function checkSettled(group, companyCode) {
  const minBal = getMinBalance(companyCode);
  if (group.netBalance <= minBal) {
    return { settled: true, reason: `net balance ≤ ${minBal} (near zero)` };
  }
  const sumInv = group.invoices.reduce((s, i) => s + Number(i.RemainingAmount || 0), 0);
  if (sumInv > 0 && group.netBalance < sumInv * MIN_OUTSTANDING_RATIO) {
    const coveragePct = ((1 - group.netBalance / sumInv) * 100).toFixed(2);
    return { settled: true, reason: `${coveragePct}% of invoice total covered by unapplied payments` };
  }
  return { settled: false };
}

const SEVERITY_RANK = { PRE_DUE: 1, DUE_DAY: 2, OVERDUE: 3, FOLLOW_UP: 4 };

// ─── Customer-No exclusion list (per company) ──────────────────────────────
// Customers whose [No_] matches any pattern in EXCLUDE_* are SKIPPED entirely
// (no email, no WhatsApp). Customers matching WHATSAPP_* are routed to the
// WhatsApp pass instead of email.
// Patterns are SQL LIKE — use '%' for wildcard, no '%' for exact match.
// Configurable via .env so the list can change without a code edit.
//   REMINDER_EXCLUDE_COMPANYA_CUSTOMERS=...           (skip entirely)
//   REMINDER_EXCLUDE_COMPANYB_CUSTOMERS=...
//   REMINDER_WHATSAPP_COMPANYA_CUSTOMERS=RETAILER%,DCGBPL%,CG-BPL%,RRK%,PANC%   (route to WA)
//   REMINDER_WHATSAPP_COMPANYB_CUSTOMERS=...
function getExcludePatterns(companyCode) {
  const envKey = companyCode === 'COMPANYA'
    ? 'REMINDER_EXCLUDE_COMPANYA_CUSTOMERS'
    : 'REMINDER_EXCLUDE_COMPANYB_CUSTOMERS';
  return (process.env[envKey] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getWhatsAppPatterns(companyCode) {
  const envKey = companyCode === 'COMPANYA'
    ? 'REMINDER_WHATSAPP_COMPANYA_CUSTOMERS'
    : 'REMINDER_WHATSAPP_COMPANYB_CUSTOMERS';
  return (process.env[envKey] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// ─── Fetch all open outstanding invoices for a company (EMAIL pass) ────────
// Excludes both the EXCLUDE_* list AND the WHATSAPP_* list, so WhatsApp
// customers don't get double-messaged.
async function fetchOpenInvoices(company) {
  const pool = await getPool();
  const P = company.prefix;

  const excludePatterns = getExcludePatterns(company.code);
  const whatsappPatterns = getWhatsAppPatterns(company.code);
  const allSkip = [...excludePatterns, ...whatsappPatterns];

  const excludeClause = allSkip.length
    ? allSkip.map((_, i) => `AND cle.[Customer No_] NOT LIKE @excl${i}`).join(' ')
    : '';

  if (excludePatterns.length) {
    console.log(`   ↳ ${company.code}: skipping (excluded) customers matching ${excludePatterns.length} pattern(s): ${excludePatterns.join(', ')}`);
  }
  if (whatsappPatterns.length) {
    console.log(`   ↳ ${company.code}: routing to WhatsApp ${whatsappPatterns.length} pattern(s): ${whatsappPatterns.join(', ')}`);
  }

  const req = pool.request();
  allSkip.forEach((p, i) => req.input(`excl${i}`, sql.NVarChar, p));

  const result = await req.query(`
    WITH D AS (
      SELECT [Cust_ Ledger Entry No_] E, SUM([Amount (LCY)]) A
      FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_]
    ),
    -- Per-customer net balance across ALL open ledger entries (invoices,
    -- payments, credit memos). Matches NAV's Customer.[Balance (LCY)].
    -- Lets us skip customers who are effectively settled because unapplied
    -- payments already cover their open invoices.
    CB AS (
      SELECT cle2.[Customer No_] AS CustomerNo,
             SUM(ISNULL(d2.A, 0)) AS NetBalance
      FROM ${P}Cust_ Ledger Entry] cle2
      LEFT JOIN D d2 ON d2.E = cle2.[Entry No_]
      WHERE cle2.[Open] = 1
      GROUP BY cle2.[Customer No_]
    )
    SELECT
      cle.[Customer No_]          AS CustomerNo,
      c.[Name]                    AS CustomerName,
      c.[E-Mail]                  AS CustomerEmail,
      -- Salesperson: prefer invoice-level, fall back to customer master
      ISNULL(NULLIF(cle.[Salesperson Code], ''), c.[Salesperson Code]) AS SalespersonCode,
      ISNULL(sp.[Name], ISNULL(NULLIF(cle.[Salesperson Code], ''), c.[Salesperson Code])) AS SalespersonName,
      sp.[E-Mail]                 AS SalespersonEmailNav,
      cle.[Document No_]          AS InvoiceNo,
      cle.[External Document No_] AS ExtInvoiceNo,
      cle.[Posting Date]          AS PostingDate,
      cle.[Due Date]              AS DueDate,
      ISNULL(d.A,0)               AS RemainingAmount,
      DATEDIFF(DAY,cle.[Due Date],CAST(GETDATE() AS DATE)) AS OverdueDays,
      DATEDIFF(DAY,CAST(GETDATE() AS DATE),cle.[Due Date]) AS DaysToDue,
      ISNULL(cb.NetBalance, 0)    AS CustomerNetBalance
    FROM ${P}Cust_ Ledger Entry] cle
    LEFT JOIN D d ON d.E = cle.[Entry No_]
    LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
    LEFT JOIN ${P}Salesperson_Purchaser] sp
      ON sp.[Code] = ISNULL(NULLIF(cle.[Salesperson Code], ''), c.[Salesperson Code])
    LEFT JOIN CB cb ON cb.CustomerNo = cle.[Customer No_]
    WHERE cle.[Open] = 1 AND ISNULL(d.A,0) > 0
      AND cle.[Document Type] = 2   -- Invoice
      ${excludeClause}
  `);

  return result.recordset || [];
}

// ─── Fetch open invoices for WhatsApp customers only ───────────────────────
// Mirrors fetchOpenInvoices but inverts the LIKE clause and pulls phone numbers.
async function fetchWhatsAppOpenInvoices(company) {
  const pool = await getPool();
  const P = company.prefix;

  const patterns = getWhatsAppPatterns(company.code);
  if (!patterns.length) return [];

  // Build (cle.[Customer No_] LIKE @wa0 OR ... OR @waN)
  const orClause = patterns.map((_, i) => `cle.[Customer No_] LIKE @wa${i}`).join(' OR ');

  const req = pool.request();
  patterns.forEach((p, i) => req.input(`wa${i}`, sql.NVarChar, p));

  const result = await req.query(`
    WITH D AS (
      SELECT [Cust_ Ledger Entry No_] E, SUM([Amount (LCY)]) A
      FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_]
    ),
    CB AS (
      SELECT cle2.[Customer No_] AS CustomerNo,
             SUM(ISNULL(d2.A, 0)) AS NetBalance
      FROM ${P}Cust_ Ledger Entry] cle2
      LEFT JOIN D d2 ON d2.E = cle2.[Entry No_]
      WHERE cle2.[Open] = 1
      GROUP BY cle2.[Customer No_]
    )
    SELECT
      cle.[Customer No_]          AS CustomerNo,
      c.[Name]                    AS CustomerName,
      c.[E-Mail]                  AS CustomerEmail,
      c.[Phone No_]               AS CustomerPhone,
      ISNULL(NULLIF(cle.[Salesperson Code], ''), c.[Salesperson Code]) AS SalespersonCode,
      ISNULL(sp.[Name], ISNULL(NULLIF(cle.[Salesperson Code], ''), c.[Salesperson Code])) AS SalespersonName,
      sp.[E-Mail]                 AS SalespersonEmailNav,
      cle.[Document No_]          AS InvoiceNo,
      cle.[External Document No_] AS ExtInvoiceNo,
      cle.[Posting Date]          AS PostingDate,
      cle.[Due Date]              AS DueDate,
      ISNULL(d.A,0)               AS RemainingAmount,
      DATEDIFF(DAY,cle.[Due Date],CAST(GETDATE() AS DATE)) AS OverdueDays,
      DATEDIFF(DAY,CAST(GETDATE() AS DATE),cle.[Due Date]) AS DaysToDue,
      ISNULL(cb.NetBalance, 0)    AS CustomerNetBalance
    FROM ${P}Cust_ Ledger Entry] cle
    LEFT JOIN D d ON d.E = cle.[Entry No_]
    LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
    LEFT JOIN ${P}Salesperson_Purchaser] sp
      ON sp.[Code] = ISNULL(NULLIF(cle.[Salesperson Code], ''), c.[Salesperson Code])
    LEFT JOIN CB cb ON cb.CustomerNo = cle.[Customer No_]
    WHERE cle.[Open] = 1 AND ISNULL(d.A,0) > 0
      AND cle.[Document Type] = 2   -- Invoice
      AND (${orClause})
  `);

  return result.recordset || [];
}

// ─── Decide reminder-trigger stage based on days ───────────────────────────
// Returns one of PRE_DUE / DUE_DAY / OVERDUE / FOLLOW_UP, or null if no trigger today
function decideStage(inv) {
  const daysToDue    = inv.DaysToDue;
  const overdueDays  = inv.OverdueDays;

  if (overdueDays < 0 && Math.abs(overdueDays) === PRE_DUE_DAYS)   return 'PRE_DUE';
  if (daysToDue === PRE_DUE_DAYS)                                  return 'PRE_DUE';
  if (overdueDays === 0)                                            return 'DUE_DAY';
  if (overdueDays > 0 && overdueDays % FOLLOWUP_INT === 0) {
    return overdueDays === FOLLOWUP_INT ? 'OVERDUE' : 'FOLLOW_UP';
  }
  return null;
}

// ─── Current status bucket (for grouping in email — not a trigger) ─────────
function currentBucket(inv) {
  const od = inv.OverdueDays || 0;
  if (od > 0)  return 'OVERDUE';     // Overdue + Follow-up combined per requirement
  if (od === 0) return 'DUE_DAY';
  return 'PRE_DUE';
}

// ─── Group invoices by customer ────────────────────────────────────────────
function groupByCustomer(invoices) {
  const map = new Map();
  for (const inv of invoices) {
    const key = inv.CustomerNo;
    if (!map.has(key)) {
      map.set(key, {
        customerNo:           inv.CustomerNo,
        customerName:         inv.CustomerName,
        customerEmail:        inv.CustomerEmail,
        customerPhone:        inv.CustomerPhone || null,
        salespersonCode:      inv.SalespersonCode,
        salespersonName:      inv.SalespersonName,
        salespersonEmailNav:  inv.SalespersonEmailNav,
        // Net balance across all OPEN ledger entries for this customer.
        // Used to skip customers who are effectively settled (paid-in-
        // advance unapplied payments cancel out their open invoices).
        // Same value on every row of the same customer — take from first.
        netBalance:           Number(inv.CustomerNetBalance || 0),
        invoices:             [],
      });
    }
    map.get(key).invoices.push(inv);
  }
  return Array.from(map.values());
}

// ─── Resolve salesperson email for a given salesperson code ───────────────
// Prefers NAV Salesperson_Purchaser.[E-Mail]. If NAV has none, falls back
// to User_Login where the salesperson code is in CompanyACode/CompanyBCode list.
async function resolveSalespersonEmail(companyCode, salespersonCode, navEmail) {
  const nav = (navEmail || '').trim();
  if (nav) return nav;
  if (!salespersonCode) return null;
  const pool = await getAppPool();
  const codeCol = companyCode === 'COMPANYA' ? 'CompanyACode' : 'CompanyBCode';
  const result = await pool.request()
    .input('code', sql.NVarChar, salespersonCode)
    .query(`
      SELECT TOP 1 Email FROM [dbo].[User_Login]
      WHERE IsActive = 1
        AND Email IS NOT NULL AND Email <> ''
        AND ('/' + ISNULL(${codeCol}, '') + '/') LIKE '%/' + @code + '/%'
      ORDER BY
        CASE LOWER(Role)
          WHEN 'sales'               THEN 1
          WHEN 'international sales' THEN 1
          WHEN 'north sales'         THEN 1
          WHEN 'south sales'         THEN 1
          ELSE 2 END
    `);
  return result.recordset[0]?.Email || null;
}

// ─── Get user emails by role for a given company ───────────────────────────
// Rules:
//  - Role 'admin' (full access — Director/Ops Head): always included
//  - Any 'head' role (sales head, north sales head, electrical head, etc.):
//    TEAM-SCOPED — only included if the invoice's salesperson code
//    is in their CompanyACode or CompanyBCode column (slash-separated list).
//  - Other roles: included if listed in REMINDER_CC_* without team filter.
async function getRoleEmails(companyCode, roles, salespersonCode) {
  if (!roles || !roles.length) return [];
  const pool = await getAppPool();
  const roleList = roles.map((_, i) => `@r${i}`).join(',');
  const req = pool.request();
  roles.forEach((r, i) => req.input(`r${i}`, sql.NVarChar, r));
  const result = await req.query(`
    SELECT DISTINCT Email, Role, CompanyACode, CompanyBCode
    FROM [dbo].[User_Login]
    WHERE IsActive = 1
      AND Email IS NOT NULL AND Email <> ''
      AND LOWER(Role) IN (${roleList})
  `);

  const rows = result.recordset || [];
  const codeCol = companyCode === 'COMPANYA' ? 'CompanyACode' : 'CompanyBCode';

  return rows
    .filter(r => {
      const role = (r.Role || '').toLowerCase();
      if (role === 'admin') return true;                // admin = no team filter
      // Treat any role containing the word "head" as team-scoped. Catches
      // "sales head", "electrical head", "north sales head", AND multi-word
      // patterns like "sales head electrical" (the sales head).
      if (/\bhead\b/.test(role)) {
        if (!salespersonCode) return false;
        const codes = (r[codeCol] || '')
          .split('/').map(s => s.trim()).filter(Boolean);
        return codes.includes(salespersonCode);
      }
      return true;                                       // other roles — no filter
    })
    .map(r => r.Email);
}

// ─── Resolve salesperson WhatsApp phone (parallels resolveSalespersonEmail) ─
async function resolveSalespersonPhone(companyCode, salespersonCode) {
  if (!salespersonCode) return null;
  const pool = await getAppPool();
  const codeCol = companyCode === 'COMPANYA' ? 'CompanyACode' : 'CompanyBCode';
  const result = await pool.request()
    .input('code', sql.NVarChar, salespersonCode)
    .query(`
      SELECT TOP 1 Phone FROM [dbo].[User_Login]
      WHERE IsActive = 1
        AND Phone IS NOT NULL AND Phone <> ''
        AND ('/' + ISNULL(${codeCol}, '') + '/') LIKE '%/' + @code + '/%'
      ORDER BY
        CASE LOWER(Role)
          WHEN 'sales'               THEN 1
          WHEN 'international sales' THEN 1
          WHEN 'north sales'         THEN 1
          WHEN 'south sales'         THEN 1
          ELSE 2 END
    `);
  return result.recordset[0]?.Phone || null;
}

// ─── Get phones for users with one of the listed roles (parallels getRoleEmails)
// Team-scoping: 'head' roles only match if their CompanyACode/CompanyBCode covers the
// invoice's salesperson code. 'admin' matches without team filter.
async function getRolePhones(companyCode, roles, salespersonCode) {
  if (!roles || !roles.length) return [];
  const pool = await getAppPool();
  const roleList = roles.map((_, i) => `@r${i}`).join(',');
  const req = pool.request();
  roles.forEach((r, i) => req.input(`r${i}`, sql.NVarChar, r));
  const result = await req.query(`
    SELECT DISTINCT Phone, Role, CompanyACode, CompanyBCode
    FROM [dbo].[User_Login]
    WHERE IsActive = 1
      AND Phone IS NOT NULL AND Phone <> ''
      AND LOWER(Role) IN (${roleList})
  `);
  const rows = result.recordset || [];
  const codeCol = companyCode === 'COMPANYA' ? 'CompanyACode' : 'CompanyBCode';
  return rows
    .filter(r => {
      const role = (r.Role || '').toLowerCase();
      if (role === 'admin') return true;
      // Treat any role containing the word "head" as team-scoped. Catches
      // "sales head", "electrical head", "north sales head", AND multi-word
      // patterns like "sales head electrical" (the sales head).
      if (/\bhead\b/.test(role)) {
        if (!salespersonCode) return false;
        const codes = (r[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);
        return codes.includes(salespersonCode);
      }
      return true;
    })
    .map(r => r.Phone);
}

// ─── Get phones for an explicit username include-list (no role / no team filter)
// Used for "always CC the admin but not other admins" pattern.
async function getSpecificUserPhones(usernames) {
  if (!usernames || !usernames.length) return [];
  const pool = await getAppPool();
  const userList = usernames.map((_, i) => `@u${i}`).join(',');
  const req = pool.request();
  usernames.forEach((u, i) => req.input(`u${i}`, sql.NVarChar, u));
  const result = await req.query(`
    SELECT Phone FROM [dbo].[User_Login]
    WHERE IsActive = 1
      AND Phone IS NOT NULL AND Phone <> ''
      AND LOWER(Username) IN (${userList})
  `);
  return (result.recordset || []).map(r => r.Phone);
}

// ─── Has this customer already received a (cron) reminder today? ───────────
async function customerAlreadySentToday(companyCode, customerNo) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input('comp', sql.NVarChar, companyCode)
    .input('cust', sql.NVarChar, customerNo)
    .query(`
      SELECT TOP 1 Id FROM [dbo].[BN_ReminderLog]
      WHERE CompanyCode=@comp AND CustomerNo=@cust
        AND CAST(SentAt AS DATE) = CAST(GETDATE() AS DATE)
        AND IsManual = 0 AND Status = 'SENT'
    `);
  return (result.recordset || []).length > 0;
}

// ─── Count previous reminders for a specific invoice (for ReminderNumber) ──
async function countPrevious(companyCode, invoiceNo) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input('comp', sql.NVarChar, companyCode)
    .input('inv',  sql.NVarChar, invoiceNo)
    .query(`SELECT COUNT(*) AS C FROM [dbo].[BN_ReminderLog]
            WHERE CompanyCode=@comp AND InvoiceNo=@inv AND Status='SENT'`);
  return (result.recordset[0]?.C || 0) + 1;
}

// ─── Per-customer email thread info (chain all mails into one conversation)
// RFC 5322 threading:
//   In-Reply-To = Message-ID of the most recent parent
//   References  = full chain (oldest → newest), space-separated
// Gmail/Outlook group by any matching Message-ID, so even if manual
// replies happened between cron runs, the next cron mail lands in the
// same customer conversation thread.
async function getCustomerThreadInfo(companyCode, customerNo) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input('comp', sql.NVarChar, companyCode)
    .input('cust', sql.NVarChar, customerNo)
    .query(`
      SELECT MessageId
      FROM [dbo].[BN_ReminderLog]
      WHERE CompanyCode=@comp AND CustomerNo=@cust AND Status='SENT'
        AND MessageId IS NOT NULL AND MessageId <> ''
      ORDER BY SentAt ASC
    `);
  const rows = result.recordset || [];
  if (!rows.length) return { inReplyTo: null, references: null };
  // Dedupe (consolidated mail writes N log rows sharing the same MessageId)
  const unique = [...new Set(rows.map(r => r.MessageId))];
  return {
    inReplyTo:  unique[unique.length - 1],   // most recent — the immediate parent
    references: unique.join(' '),             // full chain, oldest → newest
  };
}

// ─── Load template for a stage + channel ───────────────────────────────────
// Defaults to EMAIL channel for backward compatibility with existing callers.
// For WhatsApp, returns the Meta-template metadata as well.
async function loadTemplate(stage, channel = 'EMAIL') {
  const pool = await getAppPool();
  const result = await pool.request()
    .input('stage',   sql.NVarChar, stage)
    .input('channel', sql.NVarChar, channel)
    .query(`SELECT TOP 1 Subject, Body, MetaTemplateName, MetaLanguageCode, Variables
            FROM [dbo].[BN_ReminderTemplates]
            WHERE Stage=@stage AND Channel=@channel AND IsActive=1`);
  return result.recordset[0] || null;
}

// ─── Log a reminder row to BN_ReminderLog ──────────────────────────────────
async function logReminder(row) {
  const pool = await getAppPool();
  await pool.request()
    .input('company',  sql.NVarChar, row.CompanyCode)
    .input('custNo',   sql.NVarChar, row.CustomerNo)
    .input('custName', sql.NVarChar, row.CustomerName || '')
    .input('inv',      sql.NVarChar, row.InvoiceNo)
    .input('extInv',   sql.NVarChar, row.ExtInvoiceNo || '')
    .input('postDate', sql.Date,     row.PostingDate || null)
    .input('dueDate',  sql.Date,     row.DueDate || null)
    .input('amount',   sql.Decimal(18,2), row.Amount || 0)
    .input('odDays',   sql.Int,      row.OverdueDays || 0)
    .input('stage',    sql.NVarChar, row.ReminderStage)
    .input('rNum',     sql.Int,      row.ReminderNumber || 1)
    .input('spCode',   sql.NVarChar, row.SalespersonCode || '')
    .input('spName',   sql.NVarChar, row.SalespersonName || '')
    .input('emailTo',  sql.NVarChar, row.EmailTo || '')
    .input('emailCc',  sql.NVarChar, row.EmailCc || '')
    .input('emailFrom',sql.NVarChar, row.EmailFrom || '')
    .input('subject',  sql.NVarChar, row.Subject || '')
    .input('body',     sql.NVarChar(sql.MAX), row.Body || '')
    .input('userId',   sql.Int,      row.SentByUserId || null)
    .input('userName', sql.NVarChar, row.SentByUserName || 'SYSTEM')
    .input('isManual', sql.Bit,      row.IsManual ? 1 : 0)
    .input('status',   sql.NVarChar, row.Status || 'SENT')
    .input('errMsg',   sql.NVarChar(sql.MAX), row.ErrorMessage || null)
    .input('msgId',    sql.NVarChar, row.MessageId || null)
    .input('channel',  sql.NVarChar, row.Channel || 'EMAIL')
    .input('waMsgId',  sql.NVarChar, row.WhatsAppMessageId || null)
    .input('waPhone',  sql.NVarChar, row.WhatsAppPhoneTo || null)
    .query(`
      INSERT INTO [dbo].[BN_ReminderLog]
        (CompanyCode, CustomerNo, CustomerName, InvoiceNo, ExtInvoiceNo,
         PostingDate, DueDate, Amount, OverdueDays,
         ReminderStage, ReminderNumber,
         SalespersonCode, SalespersonName,
         EmailTo, EmailCc, EmailFrom, Subject, Body,
         SentByUserId, SentByUserName, IsManual, Status, ErrorMessage, MessageId,
         Channel, WhatsAppMessageId, WhatsAppPhoneTo)
      VALUES
        (@company, @custNo, @custName, @inv, @extInv,
         @postDate, @dueDate, @amount, @odDays,
         @stage, @rNum,
         @spCode, @spName,
         @emailTo, @emailCc, @emailFrom, @subject, @body,
         @userId, @userName, @isManual, @status, @errMsg, @msgId,
         @channel, @waMsgId, @waPhone);
    `);
}

// ─── Build HTML invoice table (3 sections, subtotals, grand total) ─────────
function buildInvoiceTableHtml(invoices, { currency = 'INR', locale = 'en-IN' } = {}) {
  const buckets = { OVERDUE: [], DUE_DAY: [], PRE_DUE: [] };
  for (const inv of invoices) buckets[currentBucket(inv)].push(inv);

  // Sort each section — most urgent first
  buckets.OVERDUE.sort((a, b) => (b.OverdueDays || 0) - (a.OverdueDays || 0));
  buckets.PRE_DUE.sort((a, b) => (a.DaysToDue || 0) - (b.DaysToDue || 0));

  const SECTION = {
    OVERDUE: { label: 'Overdue / Follow-up', color: '#c62828' },
    DUE_DAY: { label: 'Due Today',           color: '#ef6c00' },
    PRE_DUE: { label: 'Due Soon (Upcoming)', color: '#2e7d32' },
  };

  let html = `<table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #ccc;font-family:Arial,sans-serif;font-size:13px;width:100%;margin-top:12px;">`;
  let grandTotal = 0;
  let grandCount = 0;

  for (const key of ['OVERDUE', 'DUE_DAY', 'PRE_DUE']) {
    const list = buckets[key];
    if (!list.length) continue;
    const meta = SECTION[key];
    const subtotal = list.reduce((s, i) => s + (Number(i.RemainingAmount) || 0), 0);

    html += `<tr><td colspan="6" style="background:${meta.color};color:#fff;font-weight:bold;padding:8px;">`
         +  `${meta.label} — ${list.length} invoice(s) &nbsp;|&nbsp; Subtotal: ${currency} ${fmtAmount(subtotal, locale)}`
         +  `</td></tr>`;

    html += `<tr style="background:#f5f5f5;font-weight:bold;">
      <td style="border:1px solid #ccc;">Invoice No</td>
      <td style="border:1px solid #ccc;">Your PO</td>
      <td style="border:1px solid #ccc;">Posting Date</td>
      <td style="border:1px solid #ccc;">Due Date</td>
      <td style="border:1px solid #ccc;">Status</td>
      <td style="border:1px solid #ccc;text-align:right;">Amount (${currency})</td>
    </tr>`;

    for (const inv of list) {
      const od = inv.OverdueDays;
      let statusTxt;
      if (od > 0)       statusTxt = `${od} day(s) overdue`;
      else if (od === 0) statusTxt = 'Due today';
      else               statusTxt = `${Math.abs(od)} day(s) remaining`;

      html += `<tr>
        <td style="border:1px solid #ccc;">${esc(inv.InvoiceNo)}</td>
        <td style="border:1px solid #ccc;">${esc(inv.ExtInvoiceNo || '-')}</td>
        <td style="border:1px solid #ccc;">${fmtDate(inv.PostingDate)}</td>
        <td style="border:1px solid #ccc;">${fmtDate(inv.DueDate)}</td>
        <td style="border:1px solid #ccc;">${statusTxt}</td>
        <td style="border:1px solid #ccc;text-align:right;">${fmtAmount(inv.RemainingAmount, locale)}</td>
      </tr>`;
    }
    grandTotal += subtotal;
    grandCount += list.length;
  }

  html += `<tr style="background:#eceff1;font-weight:bold;">
    <td colspan="5" style="border:1px solid #ccc;text-align:right;">Grand Total (${grandCount} invoices):</td>
    <td style="border:1px solid #ccc;text-align:right;">${currency} ${fmtAmount(grandTotal, locale)}</td>
  </tr></table>`;

  return { html, grandTotal, grandCount };
}

// ─── Plain-text invoice table (for text/plain mail part) ───────────────────
function buildInvoiceTableText(invoices, { currency = 'INR', locale = 'en-IN' } = {}) {
  const buckets = { OVERDUE: [], DUE_DAY: [], PRE_DUE: [] };
  for (const inv of invoices) buckets[currentBucket(inv)].push(inv);
  buckets.OVERDUE.sort((a, b) => (b.OverdueDays || 0) - (a.OverdueDays || 0));
  buckets.PRE_DUE.sort((a, b) => (a.DaysToDue || 0) - (b.DaysToDue || 0));

  const LBL = { OVERDUE: 'OVERDUE / FOLLOW-UP', DUE_DAY: 'DUE TODAY', PRE_DUE: 'DUE SOON' };
  let out = '';
  let grand = 0;

  for (const key of ['OVERDUE', 'DUE_DAY', 'PRE_DUE']) {
    const list = buckets[key];
    if (!list.length) continue;
    const subtotal = list.reduce((s, i) => s + (Number(i.RemainingAmount) || 0), 0);
    out += `\n=== ${LBL[key]} — ${list.length} invoice(s)  |  Subtotal: ${currency} ${fmtAmount(subtotal, locale)} ===\n`;
    for (const inv of list) {
      const od = inv.OverdueDays;
      const st = od > 0 ? `${od}d overdue` : (od === 0 ? 'due today' : `${Math.abs(od)}d left`);
      out += `  ${inv.InvoiceNo.padEnd(14)}  PO:${(inv.ExtInvoiceNo || '-').padEnd(14)}  Due:${fmtDate(inv.DueDate)}  ${st.padEnd(12)}  ${currency} ${fmtAmount(inv.RemainingAmount, locale)}\n`;
    }
    grand += subtotal;
  }
  out += `\nGrand Total: ${currency} ${fmtAmount(grand, locale)}\n`;
  return out;
}

// ─── NEW — Send one consolidated email per customer ────────────────────────
async function sendConsolidatedReminder({ company, customer, triggered, allInvoices, isManual, user }) {
  const companyCode  = company.code;
  const companyLabel = company.label;
  const currency     = company.currency || 'INR';
  const locale       = company.locale   || 'en-IN';

  // Highest severity from the customer's actual invoice buckets (OVERDUE >
  // DUE_DAY > PRE_DUE). In monthly mode, ComputedStage is null for most
  // invoices (they didn't hit a per-day trigger), so we derive severity
  // from currentBucket() instead. Drives the {{HighestStage}} template var.
  let highest = 'PRE_DUE';
  for (const inv of allInvoices) {
    const bucket = currentBucket(inv);
    if (bucket === 'OVERDUE')                              { highest = 'OVERDUE'; break; }
    else if (bucket === 'DUE_DAY' && highest !== 'OVERDUE') highest = 'DUE_DAY';
  }

  const tpl = await loadTemplate('CONSOLIDATED');
  if (!tpl) throw new Error(`No active CONSOLIDATED template — run SQL Files/BN_ReminderTemplates_Consolidated.sql`);

  const htmlTable = buildInvoiceTableHtml(allInvoices, { currency, locale });
  const textTable = buildInvoiceTableText(allInvoices, { currency, locale });

  const baseVars = {
    CustomerName:    customer.customerName || customer.customerNo,
    CompanyName:     companyLabel,
    SalespersonName: customer.salespersonName || '',
    GrandTotal:      fmtAmount(htmlTable.grandTotal, locale),
    TotalCount:      htmlTable.grandCount,
    HighestStage:    highest.replace('_', ' '),
    Currency:        currency,
  };

  const subject  = renderTemplate(tpl.Subject, baseVars);
  const bodyHtml = renderTemplate(tpl.Body, { ...baseVars, InvoiceTable: htmlTable.html });
  // Plain-text variant: strip any HTML markup from the template, then inject text table
  const bodyText = renderTemplate(tpl.Body, { ...baseVars, InvoiceTable: textTable })
                    .replace(/<[^>]+>/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

  // ─── Recipients ─────────────────────────────────────────────────────────
  const realTo = (customer.customerEmail || '').trim();
  const realCcList = [];

  // Salesperson — prefer NAV, fall back to User_Login
  const spEmail = await resolveSalespersonEmail(
    companyCode, customer.salespersonCode, customer.salespersonEmailNav
  );
  if (spEmail) realCcList.push(spEmail);

  // Monthly mode (2026-05-14): always CC the configured EMAIL_CC_ROLES set
  // regardless of severity. Salesperson already pushed above; ALWAYS_CC
  // pushed below. "head" roles are team-scoped inside getRoleEmails (fires
  // only if the customer's salesperson is in their CompanyACode/CompanyBCode);
  // "admin" is global.
  if (EMAIL_CC_ROLES.length) {
    const roleEmails = await getRoleEmails(companyCode, EMAIL_CC_ROLES, customer.salespersonCode);
    realCcList.push(...roleEmails);
  }

  // Always-CC (mis@ etc) — added to every mail regardless of stage
  realCcList.push(...ALWAYS_CC);

  const uniqueCc = [...new Set(realCcList.filter(Boolean))];

  // In TEST mode: customer To redirected to TEST_EMAIL. CC behavior:
  //   default → stays real (team can verify the full recipient flow)
  //   EMAIL_TEST_SUPPRESS_CC=true → emptied (fully-isolated test, no team spam)
  const mailTo = EMAIL_TEST_MODE ? TEST_EMAIL : realTo;
  const mailCc = (EMAIL_TEST_MODE && EMAIL_TEST_SUPPRESS_CC) ? '' : uniqueCc.join(',');

  // Prefix subject + prepend banner so test recipients know it's NOT a real mail
  let finalSubject = subject;
  let finalBodyHtml = bodyHtml;
  let finalBodyText = bodyText;
  if (EMAIL_TEST_MODE) {
    finalSubject  = `[TEST] ${subject}`;
    const ccNote  = EMAIL_TEST_SUPPRESS_CC
      ? ` &nbsp;|&nbsp; CC suppressed (REMINDER_EMAIL_TEST_SUPPRESS_CC=true). In live mode CC would be: <b>${esc(uniqueCc.join(', ') || '(none)')}</b>`
      : '';
    finalBodyHtml = `<div style="background:#fff3cd;border:1px solid #ffc107;padding:10px;margin-bottom:12px;font-family:Arial,sans-serif;font-size:13px;color:#333;">`
                  + `<b>⚠ TEST MODE</b> — preview only. Customer was NOT mailed. In live mode this would go to: <b>${esc(realTo || '(no customer email on file)')}</b>${ccNote}`
                  + `</div>` + bodyHtml;
    const ccNoteTxt = EMAIL_TEST_SUPPRESS_CC ? `\nCC suppressed in test mode — live CC would be: ${uniqueCc.join(', ') || '(none)'}` : '';
    finalBodyText = `⚠ TEST MODE — customer was NOT mailed. In live mode real To would have been: ${realTo || '(no customer email on file)'}${ccNoteTxt}\n\n${bodyText}`;
  }

  const thread = await getCustomerThreadInfo(companyCode, customer.customerNo);

  let status = 'SENT';
  let errorMessage = null;
  let messageId = null;

  if (!mailTo) {
    status = 'FAILED';
    errorMessage = 'No recipient email (customer email missing in NAV)';
  } else {
    const send = await sendMail({
      company:    companyCode,
      to: mailTo, cc: mailCc, subject: finalSubject,
      text: finalBodyText, html: finalBodyHtml,
      inReplyTo:  thread.inReplyTo,
      references: thread.references,
    });
    if (!send.ok) {
      status = 'FAILED';
      errorMessage = send.error;
    } else {
      messageId = send.messageId;
    }
  }

  // Log one row per TRIGGERED invoice (audit trail preserved)
  // All rows share MessageId so per-customer threading works.
  for (const inv of triggered) {
    const rNum = await countPrevious(companyCode, inv.InvoiceNo);
    await logReminder({
      CompanyCode:     companyCode,
      CustomerNo:      customer.customerNo,
      CustomerName:    customer.customerName,
      InvoiceNo:       inv.InvoiceNo,
      ExtInvoiceNo:    inv.ExtInvoiceNo,
      PostingDate:     inv.PostingDate,
      DueDate:         inv.DueDate,
      Amount:          inv.RemainingAmount,
      OverdueDays:     inv.OverdueDays,
      // Monthly mode: ComputedStage is null for most invoices (they didn't
      // hit a per-day trigger today). Fall back to currentBucket so the log
      // shows the invoice's actual status at month-start (OVERDUE / DUE_DAY
      // / PRE_DUE) — meaningful for audit + UI filtering.
      ReminderStage:   inv.ComputedStage || currentBucket(inv),
      ReminderNumber:  rNum,
      SalespersonCode: customer.salespersonCode,
      SalespersonName: customer.salespersonName,
      EmailTo:         mailTo,
      EmailCc:         mailCc,
      EmailFrom:       getFromEmail(companyCode),
      Subject:         subject,
      Body:            bodyHtml,
      SentByUserId:    user?.id || null,
      SentByUserName:  user?.name || user?.username || 'SYSTEM',
      IsManual:        isManual ? 1 : 0,
      Status:          status,
      ErrorMessage:    errorMessage,
      MessageId:       messageId,
    });
  }

  return { status, errorMessage, triggeredCount: triggered.length, totalCount: allInvoices.length };
}

// ─── LEGACY — Single-invoice send (used by the manual "✉ Send" button on ───
// Outstanding page). Now also threads per-customer.
async function sendOneReminder({ company, invoice, stage, user, isManual }) {
  const companyCode  = company.code;
  const companyLabel = company.label;
  const currency     = company.currency || 'INR';
  const locale       = company.locale   || 'en-IN';

  const tpl = await loadTemplate(stage);
  if (!tpl) throw new Error(`No active template for stage ${stage}`);

  const rNum = await countPrevious(companyCode, invoice.InvoiceNo);

  const vars = {
    CustomerName:    invoice.CustomerName || invoice.CustomerNo,
    InvoiceNo:       invoice.InvoiceNo,
    ExtInvoiceNo:    invoice.ExtInvoiceNo || '',
    PostingDate:     fmtDate(invoice.PostingDate),
    DueDate:         fmtDate(invoice.DueDate),
    Amount:          fmtAmount(invoice.RemainingAmount, locale),
    OverdueDays:     Math.max(0, invoice.OverdueDays || 0),
    CompanyName:     companyLabel,
    SalespersonName: invoice.SalespersonName || '',
    Currency:        currency,
  };

  const subject = renderTemplate(tpl.Subject, vars);
  const body    = renderTemplate(tpl.Body, vars);

  const realTo = (invoice.CustomerEmail || '').trim();
  const realCcList = [];

  // Salesperson — prefer NAV, fall back to User_Login
  const spEmail = await resolveSalespersonEmail(
    companyCode, invoice.SalespersonCode, invoice.SalespersonEmailNav
  );
  if (spEmail) realCcList.push(spEmail);

  let extraRoles = [];
  if (stage === 'DUE_DAY')   extraRoles = ROLE_DUE_DAY;
  if (stage === 'OVERDUE')   extraRoles = ROLE_OVERDUE;
  if (stage === 'FOLLOW_UP') extraRoles = ROLE_FOLLOWUP;
  if (extraRoles.length) {
    const roleEmails = await getRoleEmails(companyCode, extraRoles, invoice.SalespersonCode);
    realCcList.push(...roleEmails);
  }

  // Always-CC (mis@ etc) — added to every mail regardless of stage
  realCcList.push(...ALWAYS_CC);

  const uniqueCc = [...new Set(realCcList.filter(Boolean))];

  // In TEST mode: customer To redirected. CC empty if EMAIL_TEST_SUPPRESS_CC=true.
  const mailTo = EMAIL_TEST_MODE ? TEST_EMAIL : realTo;
  const mailCc = (EMAIL_TEST_MODE && EMAIL_TEST_SUPPRESS_CC) ? '' : uniqueCc.join(',');

  // Prefix subject + body for test awareness
  let finalSubject = subject;
  let finalBody    = body;
  if (EMAIL_TEST_MODE) {
    finalSubject = `[TEST] ${subject}`;
    const ccNote = EMAIL_TEST_SUPPRESS_CC
      ? `\nCC suppressed — live CC would be: ${uniqueCc.join(', ') || '(none)'}`
      : '';
    finalBody    = `⚠ TEST MODE — customer was NOT mailed. In live mode real To would have been: ${realTo || '(no customer email on file)'}${ccNote}\n\n${body}`;
  }

  const thread = await getCustomerThreadInfo(companyCode, invoice.CustomerNo);

  let status = 'SENT';
  let errorMessage = null;
  let messageId = null;

  if (!mailTo) {
    status = 'FAILED';
    errorMessage = 'No recipient email (customer email missing in NAV)';
  } else {
    const send = await sendMail({
      company:    companyCode,
      to: mailTo, cc: mailCc, subject: finalSubject, text: finalBody,
      inReplyTo:  thread.inReplyTo,
      references: thread.references,
    });
    if (!send.ok) { status = 'FAILED'; errorMessage = send.error; }
    else          { messageId = send.messageId; }
  }

  await logReminder({
    CompanyCode:     companyCode,
    CustomerNo:      invoice.CustomerNo,
    CustomerName:    invoice.CustomerName,
    InvoiceNo:       invoice.InvoiceNo,
    ExtInvoiceNo:    invoice.ExtInvoiceNo,
    PostingDate:     invoice.PostingDate,
    DueDate:         invoice.DueDate,
    Amount:          invoice.RemainingAmount,
    OverdueDays:     invoice.OverdueDays,
    ReminderStage:   stage,
    ReminderNumber:  rNum,
    SalespersonCode: invoice.SalespersonCode,
    SalespersonName: invoice.SalespersonName,
    EmailTo:         mailTo,
    EmailCc:         mailCc,
    EmailFrom:       process.env.SMTP_FROM_EMAIL || '',
    Subject:         subject,
    Body:            body,
    SentByUserId:    user?.id || null,
    SentByUserName:  user?.name || user?.username || 'SYSTEM',
    IsManual:        isManual ? 1 : 0,
    Status:          status,
    ErrorMessage:    errorMessage,
    MessageId:       messageId,
  });

  return { status, errorMessage };
}

// ─── Send one WhatsApp reminder to a customer (consolidated triggered list) ─
// Uses Meta WhatsApp Cloud API directly via shared/whatsapp.js.
// Logs ONE row per triggered invoice into BN_ReminderLog with Channel='WHATSAPP'.
async function sendWhatsAppReminder({ company, customer, triggered, allInvoices, isManual, user }) {
  const companyCode  = company.code;
  const companyLabel = company.label;
  const currency     = company.currency || 'INR';
  const locale       = company.locale   || 'en-IN';

  // Highest severity drives which template to send (one WA template per stage)
  let highest = 'PRE_DUE';
  for (const t of triggered) {
    if ((SEVERITY_RANK[t.ComputedStage] || 0) > (SEVERITY_RANK[highest] || 0)) {
      highest = t.ComputedStage;
    }
  }

  const tpl = await loadTemplate(highest, 'WHATSAPP');
  if (!tpl) {
    return {
      status: 'FAILED',
      errorMessage: `No active WhatsApp template for stage ${highest} — seed it in BN_ReminderTemplates`,
    };
  }
  if (!tpl.MetaTemplateName) {
    return {
      status: 'FAILED',
      errorMessage: `WhatsApp template for stage ${highest} has no MetaTemplateName — fill in approved Meta template_name and set IsActive=1`,
    };
  }

  // Pick the most-relevant single triggered invoice for the WA body (WA templates
  // have fixed variable count, so we send one invoice's data per message). Most-overdue first.
  const sortedTriggered = [...triggered].sort((a, b) => (b.OverdueDays || 0) - (a.OverdueDays || 0));
  const headInv = sortedTriggered[0];

  // Build variable substitutions matching tpl.Variables (JSON array of names)
  let varsList = [];
  try { varsList = JSON.parse(tpl.Variables || '[]'); }
  catch { varsList = []; }

  const ctx = {
    CustomerName:    customer.customerName || customer.customerNo,
    InvoiceNo:       headInv?.InvoiceNo || '',
    ExtInvoiceNo:    headInv?.ExtInvoiceNo || '',
    PostingDate:     fmtDate(headInv?.PostingDate),
    DueDate:         fmtDate(headInv?.DueDate),
    Amount:          fmtAmount(headInv?.RemainingAmount, locale),
    OverdueDays:     Math.max(0, headInv?.OverdueDays || 0),
    Currency:        currency,
    CompanyName:     companyLabel,
    SalespersonName: customer.salespersonName || '',
    TotalCount:      allInvoices.length,
    GrandTotal:      fmtAmount(
                       allInvoices.reduce((s, i) => s + (Number(i.RemainingAmount) || 0), 0),
                       locale
                     ),
  };

  const variables = varsList.map(v => ctx[v] != null ? String(ctx[v]) : '');

  // ── Build the CC recipient chain ────────────────────────────────────────
  // Escalation order (matches business rule: Customer is the TO; the rest
  // are CC, listed from closest-to-customer to top-of-org):
  //   1. Customer                — NAV phone, optionally overridden by REMINDER_WA_CUSTOMER_OVERRIDE
  //   2. Salesperson             — NAV salesperson code → active User_Login row
  //   3. Role CCs (in env order) — REMINDER_WA_CC_ROLES e.g. "sales head electrical,electrical head"
  //                                 → the sales head (team-scoped) then the electrical head (team-scoped, full union)
  //   4. User CCs                — REMINDER_WA_CC_USERNAMES e.g. "admin@company-b.example" (Admin)
  //
  // For customers whose NAV salesperson has resigned (no User_Login row),
  // slot #2 is silently skipped; the rest of the chain still fires.
  //
  // Each recipient receives the same approved template + same variable values.
  // Duplicates by phone are removed below — important when one person holds
  // multiple slots (e.g. the sales head as both Salesperson and Sales Head Electrical
  // for his own customers — he only gets ONE message, not two).
  //
  // One BN_ReminderLog row per (triggered invoice × deduped recipient phone).
  const recipients = [];

  // (1) CUSTOMER — TO
  const overridePhone = (process.env.REMINDER_WA_CUSTOMER_OVERRIDE || '').trim();
  const customerPhoneRaw = overridePhone || customer.customerPhone || null;
  // Always push a CUSTOMER slot — even if phone is missing — so the audit log
  // has an explicit FAILED row showing the customer was meant to be reached
  // but had no number on NAV. (CC chain still fires normally below.)
  recipients.push({
    phone:          customerPhoneRaw,
    kind:           overridePhone ? 'CUSTOMER_OVERRIDE' : 'CUSTOMER',
    failureReason:  customerPhoneRaw ? null : 'No phone number on customer master (NAV Customer.[Phone No_] empty)',
  });

  // (2) SALESPERSON — active sales rep matched by NAV code
  const spPhone = await resolveSalespersonPhone(companyCode, customer.salespersonCode);
  if (spPhone) recipients.push({ phone: spPhone, kind: 'SALESPERSON' });

  // (3) ROLE CCs — looped per-role so REMINDER_WA_CC_ROLES order is preserved
  //     (e.g. "sales head electrical,electrical head" → the sales head first,
  //     then a colleague). getRolePhones() does the team-scope check for any
  //     role string containing the word "head".
  const ccRoles = (process.env.REMINDER_WA_CC_ROLES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const role of ccRoles) {
    const rolePhones = await getRolePhones(companyCode, [role], customer.salespersonCode);
    const kindLabel = 'ROLE_CC:' + role.toUpperCase().replace(/\s+/g, '_');
    rolePhones.forEach(p => recipients.push({ phone: p, kind: kindLabel }));
  }

  // (4) USER CCs — explicit username allow-list (Admin)
  const ccUsernames = (process.env.REMINDER_WA_CC_USERNAMES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (ccUsernames.length) {
    const userPhones = await getSpecificUserPhones(ccUsernames);
    userPhones.forEach(p => recipients.push({ phone: p, kind: 'USER_CC' }));
  }

  // Dedupe by phone — keep the FIRST occurrence so the kind that fires
  // is the one earliest in the escalation order (Salesperson beats Role-CC
  // beats User-CC for someone holding multiple slots). Slots with no phone
  // (e.g. CUSTOMER with missing NAV phone) are kept as-is for audit.
  {
    const seenPhones = new Set();
    const deduped = [];
    let dupCount = 0;
    for (const r of recipients) {
      if (r.phone) {
        if (seenPhones.has(r.phone)) { dupCount++; continue; }
        seenPhones.add(r.phone);
      }
      deduped.push(r);
    }
    if (dupCount > 0) {
      console.log(`   ${companyCode} WA → cust ${customer.customerNo}: deduped ${dupCount} duplicate phone(s)`);
    }
    recipients.length = 0;
    recipients.push(...deduped);
  }

  // ── Isolated test-mode redirect (2026-05-14) ────────────────────────────
  // When REMINDER_WA_TEST_MODE=true AND REMINDER_WA_TEST_FORWARD_TO=<phone>,
  // collapse the entire chain into a single message to the test phone. Real
  // Meta API call is still made (so we get a wamid + verify delivery), but
  // no team member receives anything. Supersedes REMINDER_WA_CUSTOMER_OVERRIDE.
  if (WA_TEST_MODE && WA_TEST_FORWARD_TO) {
    recipients.length = 0;
    recipients.push({
      phone:         WA_TEST_FORWARD_TO,
      kind:          'TEST_FORWARD',
      failureReason: null,
    });
    console.log(`   ${companyCode} WA → cust ${customer.customerNo}: TEST FORWARD MODE — chain collapsed to ${WA_TEST_FORWARD_TO}`);
  }

  if (!recipients.length) {
    // Nothing to send to — log one FAILED row per triggered invoice
    for (const inv of triggered) {
      const rNum = await countPrevious(companyCode, inv.InvoiceNo);
      await logReminder({
        CompanyCode:       companyCode,
        CustomerNo:        customer.customerNo,
        CustomerName:      customer.customerName,
        InvoiceNo:         inv.InvoiceNo,
        ExtInvoiceNo:      inv.ExtInvoiceNo,
        PostingDate:       inv.PostingDate,
        DueDate:           inv.DueDate,
        Amount:            inv.RemainingAmount,
        OverdueDays:       inv.OverdueDays,
        ReminderStage:     inv.ComputedStage,
        ReminderNumber:    rNum,
        SalespersonCode:   customer.salespersonCode,
        SalespersonName:   customer.salespersonName,
        EmailTo:           '', EmailCc: '', EmailFrom: '',
        Subject:           tpl.Subject || `WhatsApp ${highest} reminder`,
        Body:              `Template: ${tpl.MetaTemplateName} | NO RECIPIENTS RESOLVED`,
        SentByUserId:      user?.id || null,
        SentByUserName:    user?.name || user?.username || 'SYSTEM',
        IsManual:          isManual ? 1 : 0,
        Status:            'FAILED',
        ErrorMessage:      'No WhatsApp recipients (customer phone empty AND no CC phones resolved)',
        MessageId:         null,
        Channel:           'WHATSAPP',
        WhatsAppMessageId: null,
        WhatsAppPhoneTo:   null,
      });
    }
    return { status: 'FAILED', errorMessage: 'No WhatsApp recipients', triggeredCount: triggered.length, totalCount: allInvoices.length, recipientCount: 0 };
  }

  console.log(`   ${companyCode} WA → cust ${customer.customerNo}: ${recipients.length} recipient(s): ${recipients.map(r => `${r.kind}=${r.phone}`).join(', ')}`);

  // ── Send to each recipient ──────────────────────────────────────────────
  // When REMINDER_WA_CUSTOMER_OVERRIDE or REMINDER_WA_TEST_FORWARD_TO is set,
  // we WANT to actually send to the test phone — so they beat WA_TEST_MODE.
  // When BOTH override and forward are empty AND WA_TEST_MODE=true, we skip
  // real API calls and log a SKIPPED row (NOT 'SENT') so the dashboard
  // counter stays honest.
  const skipRealSend = WA_TEST_MODE && !overridePhone && !WA_TEST_FORWARD_TO;
  let totalSent = 0, totalSkipped = 0, totalFailed = 0;

  for (const r of recipients) {
    let status = 'SENT';
    let errorMessage = null;
    let waMessageId = null;

    if (r.failureReason) {
      // Recipient slot known to be unreachable before any API call (e.g. no phone)
      status = 'FAILED';
      errorMessage = r.failureReason;
    } else if (skipRealSend) {
      // TEST_MODE: don't actually hit Meta — log a SKIPPED row for audit only.
      // The synthetic TEST- prefix is what /stats uses to exclude these from
      // the "WhatsApp Sent" counter so it always matches Meta's real count.
      status = 'SKIPPED';
      errorMessage = `[TEST_MODE] would send WA template ${tpl.MetaTemplateName} to ${r.phone} (${r.kind})`;
      waMessageId = `TEST-${Date.now()}-${r.kind}`;
    } else {
      const send = await whatsapp.sendTemplate({
        to:           r.phone,
        templateName: tpl.MetaTemplateName,
        languageCode: tpl.MetaLanguageCode || 'en',
        variables,
      });
      if (!send.ok) { status = 'FAILED'; errorMessage = send.error; }
      else          { waMessageId = send.messageId; }
    }

    if      (status === 'SENT')    totalSent++;
    else if (status === 'SKIPPED') totalSkipped++;
    else                            totalFailed++;

    for (const inv of triggered) {
      const rNum = await countPrevious(companyCode, inv.InvoiceNo);
      await logReminder({
        CompanyCode:       companyCode,
        CustomerNo:        customer.customerNo,
        CustomerName:      customer.customerName,
        InvoiceNo:         inv.InvoiceNo,
        ExtInvoiceNo:      inv.ExtInvoiceNo,
        PostingDate:       inv.PostingDate,
        DueDate:           inv.DueDate,
        Amount:            inv.RemainingAmount,
        OverdueDays:       inv.OverdueDays,
        ReminderStage:     inv.ComputedStage,
        ReminderNumber:    rNum,
        SalespersonCode:   customer.salespersonCode,
        SalespersonName:   customer.salespersonName,
        EmailTo:           '', EmailCc: '', EmailFrom: '',
        Subject:           tpl.Subject || `WhatsApp ${highest} reminder (${r.kind})`,
        Body:              `Template: ${tpl.MetaTemplateName} | Recipient: ${r.kind} | Phone: ${r.phone} | Vars: ${JSON.stringify(variables)}`,
        SentByUserId:      user?.id || null,
        SentByUserName:    user?.name || user?.username || 'SYSTEM',
        IsManual:          isManual ? 1 : 0,
        Status:            status,
        ErrorMessage:      errorMessage,
        MessageId:         null,
        Channel:           'WHATSAPP',
        WhatsAppMessageId: waMessageId,
        WhatsAppPhoneTo:   r.phone,
      });
    }

    // Brief delay between sends to be polite to Meta when chain is long
    if (recipients.length > 1) await new Promise(res => setTimeout(res, 500));
  }

  // Aggregate outcome:
  //   SENT    — at least one recipient actually delivered to Meta
  //   SKIPPED — all recipients were TEST_MODE skips (no Meta calls made)
  //   FAILED  — every reachable recipient hit a real error
  let aggStatus;
  if      (totalSent > 0)                       aggStatus = 'SENT';
  else if (totalSkipped > 0 && totalFailed === 0) aggStatus = 'SKIPPED';
  else                                          aggStatus = 'FAILED';

  return {
    status:         aggStatus,
    triggeredCount: triggered.length,
    totalCount:     allInvoices.length,
    recipientCount: recipients.length,
    sentCount:      totalSent,
    skippedCount:   totalSkipped,
    failedCount:    totalFailed,
  };
}

// ─── Daily cron runner — consolidated mode ─────────────────────────────────
// opts.channel: 'EMAIL' | 'WHATSAPP' | 'ALL' (default 'ALL').
// Lets the scheduled crons fire one pass at a time independently.
async function runDaily(filterCompany, opts = {}) {
  const filter   = (filterCompany || '').toUpperCase();
  const channel  = String(opts.channel || 'ALL').toUpperCase();
  const runEmail = (channel === 'ALL' || channel === 'EMAIL');
  const runWA    = (channel === 'ALL' || channel === 'WHATSAPP');
  console.log(`\n📬 [${new Date().toISOString()}] Reminder cron starting (channel=${channel}${filter ? ', company='+filter : ''})`);

  let totalCustomersMailed = 0, totalMailsSent = 0, totalFailed = 0, totalSkipped = 0;

  const SEND_DELAY_MS = parseInt(process.env.REMINDER_SEND_DELAY_MS) || 2500;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const companiesToRun = filter ? COMPANIES.filter(c => c.code === filter) : COMPANIES;

  // ─── Email pass ───────────────────────────────────────────────────────────
  if (runEmail) {
  for (const company of companiesToRun) {
    try {
      const rawInvoices = await fetchOpenInvoices(company);
      console.log(`   ${company.code}: ${rawInvoices.length} open invoices`);

      // Compute per-invoice trigger stage (still useful for the log even though
      // monthly mode doesn't filter on it — captures any invoice that happens
      // to hit a stage trigger day on the 1st of the month).
      const invoices = rawInvoices.map(inv => ({ ...inv, ComputedStage: decideStage(inv) }));

      // Group by customer
      const allGroups = groupByCustomer(invoices);

      // Skip "settled" customers — those whose unapplied payments in NAV
      // already cover their open invoices (paid-in-advance scenario). See
      // checkSettled() comment for the two-criterion rule.
      const settledGroups = [];
      const groups = [];
      for (const g of allGroups) {
        const check = checkSettled(g, company.code);
        if (check.settled) settledGroups.push({ ...g, _settledReason: check.reason });
        else               groups.push(g);
      }
      if (settledGroups.length) {
        console.log(`   ${company.code}: skipped ${settledGroups.length} settled customer(s) — payment already received, just not applied in NAV:`);
        for (const s of settledGroups.slice(0, 10)) {
          const invTotal = s.invoices.reduce((sum, i) => sum + Number(i.RemainingAmount || 0), 0);
          console.log(`     ⊘ ${s.customerNo} ${s.customerName}: balance ${fmtAmount(s.netBalance, company.locale)} ${company.currency}, ${s.invoices.length} open invoice(s) totaling ${fmtAmount(invTotal, company.locale)} ${company.currency} — ${s._settledReason}`);
        }
        if (settledGroups.length > 10) console.log(`     ... and ${settledGroups.length - 10} more`);
      }

      // Monthly-statement breakdown by current bucket (not trigger stage).
      const bucketStats = { OVERDUE: 0, DUE_DAY: 0, PRE_DUE: 0 };
      let customersToMail = 0;
      for (const g of groups) {
        if (!g.invoices.length) continue;
        customersToMail++;
        for (const inv of g.invoices) bucketStats[currentBucket(inv)]++;
      }

      console.log(`   ${company.code} monthly statement →  OVERDUE:${bucketStats.OVERDUE}  DUE_TODAY:${bucketStats.DUE_DAY}  UPCOMING:${bucketStats.PRE_DUE}  |  customers to mail: ${customersToMail}`);

      let done = 0;
      for (const cg of groups) {
        // Monthly mode: every customer with at least one open invoice gets a
        // statement. No per-day stage-trigger filter — cron schedule
        // (REMINDER_EMAIL_CRON=0 9 1 * *) controls cadence.
        if (!cg.invoices.length) continue;

        if (await customerAlreadySentToday(company.code, cg.customerNo)) {
          totalSkipped++;
          continue;
        }

        try {
          const r = await sendConsolidatedReminder({
            company,
            customer:    cg,
            triggered:   cg.invoices,   // log one row per invoice in this month's statement
            allInvoices: cg.invoices,
            isManual:    false,
            user:        null,
          });
          if (r.status === 'SENT') totalMailsSent++;
          else                     totalFailed++;
          totalCustomersMailed++;
        } catch (err) {
          totalFailed++;
          console.error(`   ❌ ${company.code} cust ${cg.customerNo}: ${err.message}`);
        }

        done++;
        if (done % 10 === 0) {
          console.log(`   ${company.code} progress: ${done}/${customersToMail}  (sent=${totalMailsSent} failed=${totalFailed})`);
        }

        if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
      }
    } catch (err) {
      console.error(`   ❌ ${company.code} fetch failed:`, err.message);
    }
  }
  } else {
    console.log(`   ⏭  Email pass skipped (channel=${channel})`);
  }

  // ─── WhatsApp pass — only customers matching REMINDER_WHATSAPP_*_CUSTOMERS ─
  let totalWaCustomers = 0, totalWaSent = 0, totalWaFailed = 0, totalWaSkipped = 0;

  if (runWA) {
  for (const company of companiesToRun) {
    const waPatterns = getWhatsAppPatterns(company.code);
    if (!waPatterns.length) continue;

    if (!whatsapp.isConfigured()) {
      console.log(`   ⏸  ${company.code}: ${waPatterns.length} WhatsApp pattern(s) configured but META_WA_* env not set — skipping WA pass`);
      continue;
    }

    try {
      const rawWa = await fetchWhatsAppOpenInvoices(company);
      console.log(`   ${company.code} (WhatsApp): ${rawWa.length} open invoices for matching customers`);

      const waInvoices = rawWa.map(inv => ({ ...inv, ComputedStage: decideStage(inv) }));
      const waAllGroups = groupByCustomer(waInvoices);

      // Same paid-in-advance filter as email pass
      const waSettled = [];
      const waGroups = [];
      for (const g of waAllGroups) {
        const check = checkSettled(g, company.code);
        if (check.settled) waSettled.push({ ...g, _settledReason: check.reason });
        else               waGroups.push(g);
      }
      if (waSettled.length) {
        console.log(`   ${company.code} WhatsApp: skipped ${waSettled.length} settled customer(s) — payment received but not applied in NAV`);
        for (const s of waSettled.slice(0, 5)) {
          console.log(`     ⊘ ${s.customerNo} ${s.customerName}: balance ${fmtAmount(s.netBalance, company.locale)} ${company.currency} — ${s._settledReason}`);
        }
      }

      let customersToWa = 0;
      for (const g of waGroups) {
        if (g.invoices.some(i => i.ComputedStage)) customersToWa++;
      }
      console.log(`   ${company.code} WhatsApp customers to message: ${customersToWa}`);

      let done = 0;
      for (const cg of waGroups) {
        const triggered = cg.invoices.filter(i => i.ComputedStage);
        if (!triggered.length) continue;

        if (await customerAlreadySentToday(company.code, cg.customerNo)) {
          totalWaSkipped++;
          continue;
        }

        try {
          const r = await sendWhatsAppReminder({
            company,
            customer:    cg,
            triggered,
            allInvoices: cg.invoices,
            isManual:    false,
            user:        null,
          });
          if      (r.status === 'SENT')    totalWaSent++;
          else if (r.status === 'SKIPPED') totalWaSkipped++;
          else                              totalWaFailed++;
          totalWaCustomers++;
        } catch (err) {
          totalWaFailed++;
          console.error(`   ❌ ${company.code} WA cust ${cg.customerNo}: ${err.message}`);
        }

        done++;
        if (done % 10 === 0) {
          console.log(`   ${company.code} WA progress: ${done}/${customersToWa}  (sent=${totalWaSent} failed=${totalWaFailed})`);
        }

        if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
      }
    } catch (err) {
      console.error(`   ❌ ${company.code} WA pass failed:`, err.message);
    }
  }
  } else {
    console.log(`   ⏭  WhatsApp pass skipped (channel=${channel})`);
  }

  // ─── Payment Advice pass — rides on the WhatsApp cron schedule ──────────
  // Fires when channel === 'ALL' || 'WHATSAPP' || 'PAYMENT_ADVICE'. Detects
  // NAV payments posted since the lookback window that match the WhatsApp
  // whitelist + haven't already been advised. For each, generates a PDF,
  // uploads to Meta as media, sends the approved template with the document
  // header, and records BN_PaymentAdvice.
  const runPA = (channel === 'ALL' || channel === 'WHATSAPP' || channel === 'PAYMENT_ADVICE');
  let totalPaCandidates = 0, totalPaSent = 0, totalPaFailed = 0, totalPaSkipped = 0;
  if (runPA && PAYMENT_ADVICE_ENABLED) {
    for (const company of companiesToRun) {
      try {
        const stats = await processPaymentAdvices(company);
        totalPaCandidates += stats.candidates;
        totalPaSent       += stats.sent;
        totalPaFailed     += stats.failed;
        totalPaSkipped    += stats.skipped;
      } catch (err) {
        console.error(`   ❌ ${company.code} Payment Advice pass failed:`, err.message);
      }
    }
  } else if (runPA && !PAYMENT_ADVICE_ENABLED) {
    console.log('   ⏭  Payment Advice pass disabled (PAYMENT_ADVICE_ENABLED=false)');
  } else {
    console.log(`   ⏭  Payment Advice pass skipped (channel=${channel})`);
  }

  console.log(
    `📬 Done — channel=${channel} | EMAIL: customers=${totalCustomersMailed} sent=${totalMailsSent} failed=${totalFailed} skipped=${totalSkipped}` +
    ` | WHATSAPP: customers=${totalWaCustomers} sent=${totalWaSent} failed=${totalWaFailed} skipped=${totalWaSkipped}` +
    ` | PAYMENT_ADVICE: candidates=${totalPaCandidates} sent=${totalPaSent} failed=${totalPaFailed} skipped=${totalPaSkipped}\n`
  );
  return {
    totalCustomersMailed, totalMailsSent, totalFailed, totalSkipped,
    totalWaCustomers, totalWaSent, totalWaFailed, totalWaSkipped,
    totalPaCandidates, totalPaSent, totalPaFailed, totalPaSkipped,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Payment Advice pass (v1.8 — 2026-06-04)
//
// For each NAV payment posted in the last PAYMENT_ADVICE_LOOKBACK_DAYS days
// that hasn't been advised yet AND whose customer matches the WhatsApp
// whitelist, generate a PDF + send a Meta template with the PDF attached.
//
// Idempotency: BN_PaymentAdvice has a unique index on (Company, PaymentEntryNo).
// processPaymentAdvices() also pre-filters via getAdvisedEntryNos() so the
// Meta + PDF work doesn't even run for already-advised entries.
//
// TEST_MODE: when REMINDER_WA_TEST_MODE=true, PDFs are still generated to
// disk but no Meta call fires; the BN_PaymentAdvice row is inserted with
// Status='test_mode' for auditability.
// ═══════════════════════════════════════════════════════════════════════════
const PAYMENT_ADVICE_ENABLED        = String(process.env.PAYMENT_ADVICE_ENABLED || 'true').toLowerCase() === 'true';
const PAYMENT_ADVICE_LOOKBACK_DAYS  = parseInt(process.env.PAYMENT_ADVICE_LOOKBACK_DAYS) || 7;
const PA_TEMPLATE_NAME              = process.env.META_WA_PAYMENT_ADVICE_TEMPLATE || 'payment_received_advice';
const PA_TEMPLATE_LANG              = process.env.META_WA_PAYMENT_ADVICE_LANG     || 'en';
const PA_UPLOADS_ROOT               = path.join(__dirname, '..', 'uploads', 'payment-advice');

// Resolve env LIKE patterns ('RETAILER%,DCGBPL%,...') into the actual list of
// NAV CustomerCodes that match. Used to drive findNewPayments + dedup the
// "is this customer on the WA whitelist" check.
async function expandWhatsAppCustomers(company) {
  const patterns = getWhatsAppPatterns(company.code);
  if (!patterns.length) return [];
  const pool = await getPool();
  const r = pool.request();
  patterns.forEach((p, i) => r.input('p' + i, sql.NVarChar(50), p));
  const ors = patterns.map((_, i) => `[No_] LIKE @p${i}`).join(' OR ');
  const res = await r.query(`SELECT [No_] FROM ${company.prefix}Customer] WHERE ${ors};`);
  return res.recordset.map(row => row.No_);
}

// Sanitise a NAV doc no ("COMPANYA/2627/02346") into a filename-safe stem.
function safeDocStem(docNo) {
  return String(docNo || 'unknown').replace(/[\/\\:*?"<>|]/g, '-');
}

// Write a PDF buffer to backend/uploads/payment-advice/{Company}/{year}/{docStem}.pdf
// and return the relative URL the frontend serves it from.
function savePdfToDisk(companyCode, payment, buffer) {
  const year     = new Date(payment.PaymentDate).getFullYear();
  const docStem  = safeDocStem(payment.PaymentDocNo);
  const dir      = path.join(PA_UPLOADS_ROOT, companyCode, String(year));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${docStem}.pdf`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/payment-advice/${companyCode}/${year}/${filename}`;
}

// Insert/update BN_PaymentAdvice row for one payment.
async function recordAdvice(appPool, row) {
  const r = appPool.request();
  r.input('co',    sql.NVarChar(10),   row.Company);
  r.input('cc',    sql.NVarChar(20),   row.CustomerCode);
  r.input('cn',    sql.NVarChar(200),  row.CustomerName || null);
  r.input('pen',   sql.Int,            row.PaymentEntryNo);
  r.input('pdn',   sql.NVarChar(50),   row.PaymentDocNo);
  r.input('pd',    sql.Date,           row.PaymentDate);
  r.input('amt',   sql.Decimal(18, 2), row.Amount || 0);
  r.input('mode',  sql.NVarChar(30),   row.PaymentMode || null);
  r.input('ref',   sql.NVarChar(100),  row.Reference || null);
  r.input('bank',  sql.NVarChar(200),  row.BankName || null);
  r.input('apjs',  sql.NVarChar(sql.MAX), row.AppliedInvoicesJson || null);
  r.input('pdf',   sql.NVarChar(500),  row.PdfUrl || null);
  r.input('phone', sql.NVarChar(20),   row.WhatsAppPhoneTo || null);
  r.input('mid',   sql.NVarChar(100),  row.WhatsAppMessageId || null);
  r.input('sent',  sql.DateTime2(0),   row.WhatsAppSentAt || null);
  r.input('err',   sql.NVarChar(500),  row.WhatsAppError || null);
  r.input('st',    sql.NVarChar(20),   row.Status || 'pending');
  await r.query(`
    INSERT INTO dbo.BN_PaymentAdvice
      (Company, CustomerCode, CustomerName, PaymentEntryNo, PaymentDocNo,
       PaymentDate, Amount, PaymentMode, Reference, BankName,
       AppliedInvoicesJson, PdfUrl, WhatsAppPhoneTo, WhatsAppMessageId,
       WhatsAppSentAt, WhatsAppError, Status, CreatedAt)
    VALUES
      (@co, @cc, @cn, @pen, @pdn, @pd, @amt, @mode, @ref, @bank,
       @apjs, @pdf, @phone, @mid, @sent, @err, @st, SYSDATETIME());
  `);
}

// Pick the customer phone for WhatsApp. Mirrors the WA reminder flow — reads
// NAV Customer.[Phone No_] and uses the shared whatsapp.js normaliser to
// extract the first valid number (handles slash/comma/semicolon-separated
// multi-number cells + Indian-default 10-digit normalisation).
async function getCustomerPhone(company, customerCode) {
  const pool = await getPool();
  const r = await pool.request()
    .input('cc', sql.NVarChar(50), customerCode)
    .query(`SELECT TOP 1 [Phone No_] AS Phone FROM ${company.prefix}Customer] WHERE [No_] = @cc;`);
  const raw = (r.recordset[0] && r.recordset[0].Phone) || null;
  return raw ? whatsapp._normalisePhone(raw) : null;
}

// Process all eligible payments for one company. Returns aggregate counters.
async function processPaymentAdvices(company) {
  const stats = { candidates: 0, sent: 0, failed: 0, skipped: 0 };

  // Lookback window: today minus N days. ISO date for SQL.
  const since = new Date();
  since.setDate(since.getDate() - PAYMENT_ADVICE_LOOKBACK_DAYS);
  const sinceISO = since.toISOString().slice(0, 10);

  // 1. Resolve WhatsApp whitelist → actual customer codes.
  const whitelist = await expandWhatsAppCustomers(company);
  if (!whitelist.length) {
    console.log(`   ${company.code} Payment Advice: no WhatsApp whitelist customers — pass skipped.`);
    return stats;
  }

  // 2. Find new payments (NAV) excluding those already advised (BN_PaymentAdvice).
  const candidates = await pa.findNewPayments(company.code, sinceISO, whitelist);
  stats.candidates = candidates.length;
  console.log(`   ${company.code} Payment Advice: ${candidates.length} new payment(s) since ${sinceISO} for ${whitelist.length} whitelist customer(s)`);
  if (!candidates.length) return stats;

  const appPool = await getAppPool();
  const skipRealSend = WA_TEST_MODE || !whatsapp.isConfigured();

  // 3. Process one payment at a time. Per-payment errors don't abort the loop.
  for (const payment of candidates) {
    let pdfUrl = null;
    let messageId = null;
    let sentAt = null;
    let waError = null;
    let status = 'pending';
    let phone = null;

    try {
      // 3a. Assemble full data shape via the PDF service.
      const data = await paPdf.fetchPaymentAdviceData(company.code, payment.PaymentDocNo);
      if (!data) {
        throw new Error(`fetchPaymentAdviceData returned null for ${payment.PaymentDocNo}`);
      }

      // 3b. Generate PDF + save to disk.
      const buffer = await paPdf.bufferPaymentAdvicePdf(data);
      pdfUrl = savePdfToDisk(company.code, payment, buffer);

      // 3c. Resolve customer phone — skip-with-log if none.
      phone = await getCustomerPhone(company, payment.CustomerCode);
      if (!phone) {
        status = 'skipped';
        waError = 'No valid phone in NAV';
        stats.skipped++;
      } else if (skipRealSend) {
        // TEST_MODE — log only, mark row as test_mode for audit visibility.
        status = 'test_mode';
        messageId = `TEST-${Date.now()}-${payment.PaymentEntryNo}`;
        waError = `[TEST_MODE] would send PA template ${PA_TEMPLATE_NAME} to ${phone} for ${payment.PaymentDocNo}`;
        console.log(`     ⊘ ${payment.PaymentDocNo} → ${phone} ${waError}`);
        stats.skipped++;
      } else {
        // 3d. Upload PDF to Meta → media_id.
        const filename = `Payment-Advice-${safeDocStem(payment.PaymentDocNo)}.pdf`;
        const up = await whatsapp.uploadMedia(buffer, filename, 'application/pdf');
        if (!up.ok) throw new Error('Meta upload failed: ' + up.error);

        // 3e. Send template with document header.
        //   {{4}} composition (2026-06-05): if cheque → "Cheque No. <n>",
        //   else → just the mode ('Bank Transfer' / 'Cash' / 'Other').
        //   Reads naturally as "...via Cheque No. 330547." OR "...via Bank Transfer."
        const payViaText = (data.bank.PaymentMode === 'Cheque' && data.bank.Reference)
          ? `Cheque No. ${data.bank.Reference}`
          : (data.bank.PaymentMode || 'Bank Transfer');
        const vars = [
          data.customer && data.customer.Name || payment.CustomerName || 'Customer',
          `${data.company.currency} ${fmtAmount(payment.Amount, data.company.locale)}`,
          fmtDate(payment.PaymentDate),
          payViaText,
        ];
        const send = await whatsapp.sendTemplateWithDocument({
          to:           phone,
          templateName: PA_TEMPLATE_NAME,
          languageCode: PA_TEMPLATE_LANG,
          variables:    vars,
          mediaId:      up.mediaId,
          documentFilename: filename,
        });
        if (!send.ok) {
          status   = 'failed';
          waError  = send.error;
          stats.failed++;
          console.error(`     ❌ ${payment.PaymentDocNo} → ${phone}: ${send.error}`);
        } else {
          status    = 'sent';
          messageId = send.messageId;
          sentAt    = new Date();
          stats.sent++;
          console.log(`     ✓ ${payment.PaymentDocNo} → ${phone}: ${messageId}`);
        }
      }

      // 3f. Persist BN_PaymentAdvice row (always, regardless of outcome — gives
      //     us a per-payment audit trail and dedup key).
      await recordAdvice(appPool, {
        Company:             company.code,
        CustomerCode:        payment.CustomerCode,
        CustomerName:        payment.CustomerName,
        PaymentEntryNo:      payment.PaymentEntryNo,
        PaymentDocNo:        payment.PaymentDocNo,
        PaymentDate:         payment.PaymentDate,
        Amount:              payment.Amount,
        PaymentMode:         data.bank.PaymentMode,
        Reference:           data.bank.Reference,
        BankName:            data.bank.BankName,
        AppliedInvoicesJson: JSON.stringify(data.applied || []),
        PdfUrl:              pdfUrl,
        WhatsAppPhoneTo:     phone,
        WhatsAppMessageId:   messageId,
        WhatsAppSentAt:      sentAt,
        WhatsAppError:       waError,
        Status:              status,
      });
    } catch (err) {
      stats.failed++;
      console.error(`     ❌ ${payment.PaymentDocNo} processing failed:`, err.message);
      // Best-effort: still record the failure row so we don't keep retrying.
      try {
        await recordAdvice(appPool, {
          Company:             company.code,
          CustomerCode:        payment.CustomerCode,
          CustomerName:        payment.CustomerName,
          PaymentEntryNo:      payment.PaymentEntryNo,
          PaymentDocNo:        payment.PaymentDocNo,
          PaymentDate:         payment.PaymentDate,
          Amount:              payment.Amount,
          PdfUrl:              pdfUrl,
          WhatsAppPhoneTo:     phone,
          WhatsAppError:       err.message,
          Status:              'failed',
        });
      } catch (logErr) {
        console.error(`     ❌ failed to log error row:`, logErr.message);
      }
    }
  }

  return stats;
}

// ─── Start scheduler ───────────────────────────────────────────────────────
// Schedules TWO INDEPENDENT crons — one for the Email pass, one for the WhatsApp
// pass. Each has its own enable flag and schedule, so they can be turned on/off
// or shifted in time independently.
//
// Env vars:
//   REMINDER_EMAIL_CRON          (default: '0 9 1 * *' — 9 AM IST on 1st of month)
//   REMINDER_EMAIL_CRON_ENABLED  (default: 'true')
//   REMINDER_WA_CRON             (default: '0 9 * * *' — daily 9 AM IST)
//   REMINDER_WA_CRON_ENABLED     (default: 'true')
//   REMINDER_CRON                (legacy — fallback for WhatsApp schedule only;
//                                 email always defaults to the monthly schedule
//                                 if no per-channel value is set)
//   REMINDER_CRON_ENABLED        (legacy — used if per-channel flag absent)
function start() {
  const legacyEnabled  = String(process.env.REMINDER_CRON_ENABLED || 'true').toLowerCase() === 'true';
  const legacySchedule = process.env.REMINDER_CRON || '0 9 * * *';

  const emailEnabled = process.env.REMINDER_EMAIL_CRON_ENABLED !== undefined
    ? String(process.env.REMINDER_EMAIL_CRON_ENABLED).toLowerCase() === 'true'
    : legacyEnabled;
  // Monthly statement default — overrides legacy daily schedule for email.
  // Explicit REMINDER_EMAIL_CRON in .env wins.
  const emailSchedule = process.env.REMINDER_EMAIL_CRON || '0 9 1 * *';

  const waEnabled = process.env.REMINDER_WA_CRON_ENABLED !== undefined
    ? String(process.env.REMINDER_WA_CRON_ENABLED).toLowerCase() === 'true'
    : legacyEnabled;
  const waSchedule = process.env.REMINDER_WA_CRON || legacySchedule;

  // Email cron
  if (!emailEnabled) {
    console.log('⏸  Email reminder cron disabled (REMINDER_EMAIL_CRON_ENABLED=false)');
  } else if (!cron.validate(emailSchedule)) {
    console.error(`❌ Invalid REMINDER_EMAIL_CRON: "${emailSchedule}"`);
  } else {
    cron.schedule(emailSchedule, () => runDaily(null, { channel: 'EMAIL' }), { timezone: 'Asia/Kolkata' });
    console.log(`⏰ Email reminder cron scheduled: "${emailSchedule}" (Asia/Kolkata)`);
  }

  // WhatsApp cron
  if (!waEnabled) {
    console.log('⏸  WhatsApp reminder cron disabled (REMINDER_WA_CRON_ENABLED=false)');
  } else if (!cron.validate(waSchedule)) {
    console.error(`❌ Invalid REMINDER_WA_CRON: "${waSchedule}"`);
  } else {
    cron.schedule(waSchedule, () => runDaily(null, { channel: 'WHATSAPP' }), { timezone: 'Asia/Kolkata' });
    console.log(`⏰ WhatsApp reminder cron scheduled: "${waSchedule}" (Asia/Kolkata)`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = dt.toLocaleString('en-IN', { month: 'short' });
  return `${dd}-${mm}-${dt.getFullYear()}`;
}
function fmtAmount(n, locale = 'en-IN') {
  if (n == null) return '0.00';
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  start, runDaily,
  sendOneReminder, sendConsolidatedReminder, sendWhatsAppReminder,
  fetchOpenInvoices, fetchWhatsAppOpenInvoices,
  getExcludePatterns, getWhatsAppPatterns,
  processPaymentAdvices,            // v1.8 — Payment Advice pass (testable in isolation)
  COMPANIES,
  // Recipient-resolution helpers reused by the PDC deposit reminder (pdcReminderCron.js)
  // so the Customer→Salesperson→Sales-Head chain stays single-sourced.
  resolveSalespersonPhone, getRolePhones, getSpecificUserPhones, getCustomerPhone,
};
