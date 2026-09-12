// =====================================================================
// services/paymentAdvice.js — Payment Advice data layer (v1.8)
//
// Read-only NAV queries that the Payment Advice feature uses end-to-end:
//   1. findNewPayments     — daily cron picks rows to advise
//   2. getAdvisedEntryNos  — set of payments already in BN_PaymentAdvice
//                            (for the cron's "skip already-done" check)
//   3. getPaymentByDocNo   — frontend `/payments/:docNo/pdf` lookup
//   4. getAppliedInvoices  — structured per-row list of invoices a payment
//                            cleared. Pattern lifted from
//                            modules/sales/routes/customers.js (the DCLE
//                            forward+reverse UNION) but returns rows, not
//                            the "; "-joined string.
//   5. getPaymentBankDetails — bank name + UTR / cheque no. Joined via
//                            [Bal_ Account No_] → Bank Account / Bank Acc
//                            Ledger Entry.
//   6. getCustomerDetails  — billing block info for the PDF (name, address,
//                            GSTIN, phone, email). PAN omitted — GSTIN is
//                            sufficient identification for B2B advice.
//   7. getAccountSummary   — previous-balance / this-payment / closing-balance
//                            for the "Account Summary" PDF section.
//
// NAV table prefix per company comes from shared/company.js (same as
// services/invoicePdf.js uses). NAV reads via getPool() — auto NOLOCK.
// BizNAV_App reads/writes via getAppPool().
//
// All functions are pure data fetchers — no PDF generation, no WhatsApp
// send. Those layers (Phase 2b, 2c) consume this module.
// =====================================================================

const { sql, getPool, getAppPool } = require('../db');
const { getCompanyByCode } = require('../shared/company');

// ─── 1. findNewPayments ─────────────────────────────────────────────────
// Find NAV payment entries (Document Type = 1) posted on/after `sinceDate`
// for customers in the whitelist. Filters out payments already in
// BN_PaymentAdvice in JS (avoids cross-DB join, keeps NAV query simple).
//
// Args:
//   companyCode  — 'COMPANYA' | 'COMPANYB'
//   sinceDate    — JS Date or 'YYYY-MM-DD' string (lower bound, inclusive)
//   whitelist    — array of customer codes; empty → returns nothing
//
// Returns: [{ PaymentEntryNo, PaymentDocNo, CustomerCode, CustomerName,
//             PaymentDate, Amount, RefRaw, BalAccountNo }]
async function findNewPayments(companyCode, sinceDate, whitelist) {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return [];

  const company = getCompanyByCode(companyCode);
  const P       = company.prefix;
  const pool    = await getPool();

  // 1a. Fetch payments from NAV.
  const r = pool.request();
  r.input('since', sql.Date, sinceDate);
  whitelist.forEach((c, i) => r.input('w' + i, sql.NVarChar(50), c));
  const inList = whitelist.map((_, i) => '@w' + i).join(',');

  // NAV's Cust_ Ledger Entry does NOT carry [Amount (LCY)] directly — that
  // column lives on Detailed Cust_ Ledg_ Entry. Use the same "first DCLE row
  // per CLE" pattern that modules/sales/routes/customers.js uses (line 282+
  // DCLEInitial CTE + reference_nav_dcle_initial_entry memory).
  const navRes = await r.query(`
    WITH PaymentInitial AS (
      SELECT EntryNo, InitialAmount FROM (
        SELECT [Cust_ Ledger Entry No_] AS EntryNo,
               [Amount (LCY)]           AS InitialAmount,
               ROW_NUMBER() OVER (PARTITION BY [Cust_ Ledger Entry No_]
                                  ORDER BY [Entry No_]) AS rn
          FROM ${P}Detailed Cust_ Ledg_ Entry]
      ) ranked WHERE ranked.rn = 1
    )
    SELECT cle.[Entry No_]               AS PaymentEntryNo,
           cle.[Document No_]            AS PaymentDocNo,
           cle.[Customer No_]            AS CustomerCode,
           c.[Name]                      AS CustomerName,
           cle.[Posting Date]            AS PaymentDate,
           ABS(ISNULL(pi.InitialAmount, 0)) AS Amount,
           cle.[External Document No_]   AS RefRaw,
           cle.[Bal_ Account No_]        AS BalAccountNo
      FROM ${P}Cust_ Ledger Entry] cle
      LEFT JOIN ${P}Customer]      c  ON c.[No_]   = cle.[Customer No_]
      LEFT JOIN PaymentInitial     pi ON pi.EntryNo = cle.[Entry No_]
     WHERE cle.[Document Type] = 1                     -- 1 = Payment
       AND cle.[Posting Date] >= @since
       AND cle.[Customer No_] IN (${inList})
     ORDER BY cle.[Posting Date], cle.[Entry No_];
  `);

  if (navRes.recordset.length === 0) return [];

  // 1b. Filter out entries already advised (BizNAV_App lookup).
  const advised = await getAdvisedEntryNos(companyCode);
  return navRes.recordset.filter(row => !advised.has(Number(row.PaymentEntryNo)));
}

// ─── 2. getAdvisedEntryNos ─────────────────────────────────────────────
// Set of PaymentEntryNo already in BN_PaymentAdvice for a company. Used by
// the cron's dedup pre-filter (cheaper than cross-DB NOT EXISTS).
async function getAdvisedEntryNos(companyCode) {
  const appPool = await getAppPool();
  const res = await appPool.request()
    .input('co', sql.NVarChar(10), companyCode)
    .query(`SELECT PaymentEntryNo FROM dbo.BN_PaymentAdvice WHERE Company = @co;`);
  return new Set(res.recordset.map(r => Number(r.PaymentEntryNo)));
}

// ─── 3. getPaymentByDocNo ──────────────────────────────────────────────
// Fetch one payment by its NAV Document No. (e.g. 'COMPANYA/26/27/02346').
// Used by GET /api/sales/payments/:docNo/pdf when a user clicks the 📄
// Receipt icon in Customer Ledger. Returns the same shape as
// findNewPayments() rows, or null if not found.
async function getPaymentByDocNo(companyCode, docNo) {
  const company = getCompanyByCode(companyCode);
  const P       = company.prefix;
  const pool    = await getPool();
  const r = await pool.request()
    .input('doc', sql.NVarChar(50), docNo)
    .query(`
      WITH PaymentInitial AS (
        SELECT EntryNo, InitialAmount FROM (
          SELECT [Cust_ Ledger Entry No_] AS EntryNo,
                 [Amount (LCY)]           AS InitialAmount,
                 ROW_NUMBER() OVER (PARTITION BY [Cust_ Ledger Entry No_]
                                    ORDER BY [Entry No_]) AS rn
            FROM ${P}Detailed Cust_ Ledg_ Entry]
        ) ranked WHERE ranked.rn = 1
      )
      SELECT TOP 1
             cle.[Entry No_]               AS PaymentEntryNo,
             cle.[Document No_]            AS PaymentDocNo,
             cle.[Customer No_]            AS CustomerCode,
             c.[Name]                      AS CustomerName,
             cle.[Posting Date]            AS PaymentDate,
             ABS(ISNULL(pi.InitialAmount, 0)) AS Amount,
             cle.[External Document No_]   AS RefRaw,
             cle.[Bal_ Account No_]        AS BalAccountNo
        FROM ${P}Cust_ Ledger Entry] cle
        LEFT JOIN ${P}Customer]      c  ON c.[No_]   = cle.[Customer No_]
        LEFT JOIN PaymentInitial     pi ON pi.EntryNo = cle.[Entry No_]
       WHERE cle.[Document Type] = 1
         AND cle.[Document No_]  = @doc;
    `);
  return r.recordset[0] || null;
}

// ─── 4. getAppliedInvoices ─────────────────────────────────────────────
// Per-invoice rows for the PDF table. UNIONs forward + reverse DCLE because
// NAV writes the application linkage on whichever side initiated
// "Apply Entries" — see reference_nav_dcle_apply_direction memory + the
// equivalent block in modules/sales/routes/customers.js (lines 351-375).
//
// Each row:
//   { InvoiceEntryNo, InvoiceNo, InvoiceDate, OrderRef,
//     OriginalAmount, AppliedAmount }
//
// OriginalAmount comes from the first DCLE row for the invoice CLE (the
// "Initial Entry" workaround — see reference_nav_dcle_initial_entry memory).
async function getAppliedInvoices(companyCode, paymentEntryNo) {
  const company = getCompanyByCode(companyCode);
  const P       = company.prefix;
  const pool    = await getPool();

  const res = await pool.request()
    .input('pen', sql.Int, paymentEntryNo)
    .query(`
      WITH AppliedDcle AS (
        -- Forward (Cash Receipts apply): DCLE on payment, points to invoice.
        SELECT [Applied Cust_ Ledger Entry No_] AS InvEntryNo,
               ABS([Amount (LCY)])              AS AppliedAmount
          FROM ${P}Detailed Cust_ Ledg_ Entry]
         WHERE [Cust_ Ledger Entry No_]         = @pen
           AND [Applied Cust_ Ledger Entry No_] <> 0
           AND [Applied Cust_ Ledger Entry No_] <> @pen
        UNION ALL
        -- Reverse (Apply from invoice): DCLE on invoice, points to payment.
        SELECT [Cust_ Ledger Entry No_] AS InvEntryNo,
               ABS([Amount (LCY)])      AS AppliedAmount
          FROM ${P}Detailed Cust_ Ledg_ Entry]
         WHERE [Applied Cust_ Ledger Entry No_] = @pen
           AND [Cust_ Ledger Entry No_]         <> 0
           AND [Cust_ Ledger Entry No_]         <> @pen
      ),
      AppliedByInvoice AS (
        -- Multiple DCLE rows can hit the same invoice → sum.
        SELECT InvEntryNo, SUM(AppliedAmount) AS AppliedAmount
          FROM AppliedDcle GROUP BY InvEntryNo
      ),
      InvoiceInitial AS (
        -- First DCLE row per invoice = the original invoiced amount
        -- (NAV's "Initial Entry" workaround for COMPANYA NAV 2016).
        SELECT EntryNo, InitialAmount FROM (
          SELECT [Cust_ Ledger Entry No_] AS EntryNo,
                 [Amount (LCY)]           AS InitialAmount,
                 ROW_NUMBER() OVER (PARTITION BY [Cust_ Ledger Entry No_]
                                    ORDER BY [Entry No_]) AS rn
            FROM ${P}Detailed Cust_ Ledg_ Entry]
        ) ranked WHERE ranked.rn = 1
      )
      SELECT invCle.[Entry No_]            AS InvoiceEntryNo,
             invCle.[Document No_]         AS InvoiceNo,
             invCle.[Posting Date]         AS InvoiceDate,
             invCle.[External Document No_] AS OrderRef,
             ISNULL(ii.InitialAmount, 0)   AS OriginalAmount,
             a.AppliedAmount               AS AppliedAmount
        FROM AppliedByInvoice a
        JOIN ${P}Cust_ Ledger Entry] invCle
          ON invCle.[Entry No_]      = a.InvEntryNo
         AND invCle.[Document Type]  = 2  -- 2 = Invoice
        LEFT JOIN InvoiceInitial ii ON ii.EntryNo = invCle.[Entry No_]
       ORDER BY invCle.[Posting Date], invCle.[Entry No_];
    `);
  return res.recordset;
}

// ─── 5. getPaymentBankDetails ──────────────────────────────────────────
// Look up the bank a payment was received into (and any UTR / cheque no.
// stored on the bank ledger). NAV stores payment-mode metadata on the
// linked Bank Account / Bank Acc_ Ledger Entry rows, NOT on the customer
// ledger entry itself — only the Bal_ Account No_ FK lives on CLE.
//
// Returns: { PaymentMode, Reference, BankName }
//
// If the [Bal_ Account No_] is blank (very rare — typically Cash payments
// posted to a G/L account instead of a Bank Account), returns nulls — the
// PDF will fall back to showing "Cash" / no bank line.
async function getPaymentBankDetails(companyCode, paymentEntryNo) {
  const company = getCompanyByCode(companyCode);
  const P       = company.prefix;
  const pool    = await getPool();

  // Payment mode + reference detection (2026-06-05):
  //   1. JOIN to the Bank Account Ledger Entry via the payment's [Document No_].
  //      NAV stores the Cheque No. on BALE, NOT on Cust_ Ledger Entry — so
  //      without this JOIN we can't tell a cheque payment from a bank transfer.
  //      Confirmed by SSMS query on dbo.[*$Bank Account Ledger Entry] WHERE
  //      [Document No_] = 'COMPANYA/2627/02346' → [Cheque No_] = '330547'.
  //   2. If [Cheque No_] is populated → mode='Cheque', reference=cheque_no.
  //   3. Else if bal-account type is Bank (3) → mode='Bank Transfer', no ref
  //      (accounts doesn't consistently enter NEFT/RTGS/UPI refs — per user
  //      confirmation 2026-06-05).
  //   4. Else if bal-account type is G/L (0) → mode='Cash'.
  //   5. Else → 'Other'.
  const r = await pool.request()
    .input('pen', sql.Int, paymentEntryNo)
    .query(`
      SELECT TOP 1
             cle.[Document No_]            AS PaymentDocNo,
             cle.[Bal_ Account No_]        AS BalAccountNo,
             cle.[Bal_ Account Type]       AS BalAccountType,  -- 0=G/L, 3=Bank
             ba.[Name]                     AS BankName,
             ba.[Bank Branch No_]          AS BankBranch,
             bale.[Cheque No_]             AS ChequeNo,        -- only populated for cheque payments
             bale.[Cheque Date]            AS ChequeDate
        FROM ${P}Cust_ Ledger Entry] cle
        LEFT JOIN ${P}Bank Account] ba
          ON ba.[No_] = cle.[Bal_ Account No_]
         AND cle.[Bal_ Account Type] = 3
        LEFT JOIN ${P}Bank Account Ledger Entry] bale
          ON bale.[Document No_]    = cle.[Document No_]
         AND bale.[Bank Account No_] = cle.[Bal_ Account No_]
       WHERE cle.[Entry No_] = @pen;
    `);

  const row = r.recordset[0] || {};
  const chequeNo = (row.ChequeNo || '').toString().trim();

  let mode, reference;
  if (chequeNo) {
    mode      = 'Cheque';
    reference = chequeNo;
  } else if (row.BalAccountType === 3) {
    mode      = 'Bank Transfer';
    reference = null;
  } else if (row.BalAccountType === 0) {
    mode      = 'Cash';
    reference = null;
  } else {
    mode      = 'Other';
    reference = null;
  }

  const bankName = row.BankName
    ? (row.BankBranch ? `${row.BankName}, ${row.BankBranch}` : row.BankName)
    : null;

  return {
    PaymentMode: mode,
    Reference:   reference,
    BankName:    bankName,
  };
}

// ─── 6. getCustomerDetails ─────────────────────────────────────────────
// Customer block for the PDF "Received From" section. GSTIN-only — PAN
// dropped by design (2026-06-04).
// Returns: { CustomerCode, Name, Address1, Address2, City, State, Pincode,
//            Country, GSTIN, Phone, Email }
async function getCustomerDetails(companyCode, customerCode) {
  const company = getCompanyByCode(companyCode);
  const P       = company.prefix;
  const pool    = await getPool();
  // GSTIN is sufficient identification for the PDF — PAN is omitted by design
  // (2026-06-04 user decision). The standard B2B payment-advice format uses
  // GST Reg. No. as the customer identifier in India.
  const r = await pool.request()
    .input('cc', sql.NVarChar(50), customerCode)
    .query(`
      SELECT TOP 1
             c.[No_]                  AS CustomerCode,
             c.[Name]                 AS Name,
             c.[Address]              AS Address1,
             c.[Address 2]            AS Address2,
             c.[City]                 AS City,
             c.[County]               AS State,   -- NAV India localisation: State stored in [County]
             c.[Post Code]            AS Pincode,
             c.[Country_Region Code]  AS Country,
             c.[VAT Registration No_] AS GSTIN,
             c.[Phone No_]            AS Phone,
             c.[E-Mail]               AS Email
        FROM ${P}Customer] c
       WHERE c.[No_] = @cc;
    `);
  return r.recordset[0] || null;
}

// ─── 7. getAccountSummary ──────────────────────────────────────────────
// Computes "Previous Outstanding / This Payment / Closing Outstanding"
// for the PDF's Account Summary block.
//
// Approach:
//   ClosingOutstanding = SUM of remaining LCY across all currently-open
//     CLE entries (Open=1) for this customer. Matches what /api/sales/
//     dashboard already computes as TotalOutstanding (DCLE-summed amount
//     on each open entry).
//   PreviousOutstanding = ClosingOutstanding + Amount (this payment).
//   ThisPayment         = absolute payment amount.
//
// Caveat (documented in PDF design): if multiple payments arrive on the
// same day, "Previous" is an approximation — it's the balance AS-OF-NOW
// plus this payment, not the balance just before this specific payment.
// For 99% of cases (advice sent within hours of the payment), accurate.
async function getAccountSummary(companyCode, customerCode, paymentAmount) {
  const company = getCompanyByCode(companyCode);
  const P       = company.prefix;
  const pool    = await getPool();
  const r = await pool.request()
    .input('cc', sql.NVarChar(50), customerCode)
    .query(`
      WITH DCLEAgg AS (
        SELECT [Cust_ Ledger Entry No_] AS EntryNo,
               SUM([Amount (LCY)])      AS Remaining
          FROM ${P}Detailed Cust_ Ledg_ Entry]
         GROUP BY [Cust_ Ledger Entry No_]
      )
      SELECT ISNULL(SUM(d.Remaining), 0) AS ClosingOutstanding
        FROM ${P}Cust_ Ledger Entry] cle
        LEFT JOIN DCLEAgg d ON d.EntryNo = cle.[Entry No_]
       WHERE cle.[Customer No_] = @cc
         AND cle.[Open] = 1;
    `);
  const closing  = Number((r.recordset[0] && r.recordset[0].ClosingOutstanding) || 0);
  const payment  = Number(paymentAmount || 0);
  const previous = closing + payment;
  return {
    PreviousOutstanding: previous,
    ThisPayment:         payment,
    ClosingOutstanding:  closing,
  };
}

module.exports = {
  findNewPayments,
  getAdvisedEntryNos,
  getPaymentByDocNo,
  getAppliedInvoices,
  getPaymentBankDetails,
  getCustomerDetails,
  getAccountSummary,
};
