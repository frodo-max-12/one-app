// =====================================================================
// modules/sales/routes/customers.js — UNIFIED COMPANYA + CompanyB
//
// Replaces backend/routes/customers.js (COMPANYA) and backend/routes/CompanyBCustomers.js (CompanyB).
// Company is resolved from req via getCompany() (?company= or X-Company header).
//
// Endpoints:
//   GET  /api/sales/customers              — paginated list with search
//   GET  /api/sales/customers/:id          — full customer detail + complete ledger
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const { getCompany }   = require('../../../shared/company');

/* ── GET /api/sales/customers ────────────────────────────────────────────── */
router.get('/', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const P       = company.prefix;
    const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';

    const pool    = await getPool();
    // Full access = admin / operation head / director only. Heads (sales head /
    // north sales head / Sales Head Electrical / Electrical Head, etc.) and
    // sales/* roles all get codes-based scoping; head's User_Login.CompanyACode
    // already contains the team's union, so heads naturally see team data.
    const role    = (req.user.role || '').toLowerCase();
    const isAdmin = isFullAccess(req.user);
    const codes   = (req.user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);

    const search = (req.query.search || '').trim();
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.max(1, parseInt(req.query.limit || '15', 10));
    const offset = (page - 1) * limit;

    const spAnd = !isAdmin && codes.length
      ? 'AND (' + codes.map((_, i) => 'c.[Salesperson Code] = @spCode' + i).join(' OR ') + ')'
      : '';

    const searchAnd = search
      ? "AND (c.[No_] COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search" +
        " OR c.[Name] COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search" +
        " OR ISNULL(c.[City],'') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search" +
        " OR ISNULL(c.[State Code],'') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search" +
        " OR ISNULL(c.[Phone No_],'') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search" +
        " OR ISNULL(sp.[Name],'') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search)"
      : '';

    const balanceCTE =
      "WITH DCLEAgg AS (" +
      "  SELECT [Cust_ Ledger Entry No_] AS EntryNo, SUM([Amount (LCY)]) AS RemainingAmount" +
      "  FROM " + P + "Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_]" +
      "), CustomerBalance AS (" +
      "  SELECT cle.[Customer No_] AS CN, SUM(ISNULL(d.RemainingAmount,0)) AS BalanceDue" +
      "  FROM " + P + "Cust_ Ledger Entry] cle" +
      "  LEFT JOIN DCLEAgg d ON d.EntryNo = cle.[Entry No_]" +
      "  WHERE cle.[Open]=1 GROUP BY cle.[Customer No_]" +
      ")";

    const baseFROM =
      " FROM " + P + "Customer] c" +
      " LEFT JOIN CustomerBalance cb ON cb.CN = c.[No_]" +
      " LEFT JOIN " + P + "Salesperson_Purchaser] sp ON sp.[Code] = c.[Salesperson Code]" +
      " WHERE ISNULL(LTRIM(RTRIM(c.[Name])),'') <> '' " + spAnd + " " + searchAnd;

    const addSP = r => { codes.forEach((c, i) => r.input('spCode' + i, sql.NVarChar, c)); return r; };

    const cntR = addSP(pool.request());
    if (search) cntR.input('search', sql.NVarChar, '%' + search + '%');
    const cntRes = await cntR.query(balanceCTE + " SELECT COUNT(*) AS Total " + baseFROM);

    const dataR = addSP(pool.request());
    dataR.input('lim', sql.Int, limit);
    dataR.input('off', sql.Int, offset);
    if (search) dataR.input('search', sql.NVarChar, '%' + search + '%');

    const dataRes = await dataR.query(
      balanceCTE +
      " SELECT c.[No_] AS CustomerNo, c.[Name] AS Name, c.[City] AS City," +
      "  c.[State Code] AS State, c.[Phone No_] AS Phone," +
      "  ISNULL(sp.[Name], c.[Salesperson Code]) AS Salesperson," +
      "  c.[Payment Terms Code] AS PaymentTerms, c.[Credit Limit (LCY)] AS CreditLimit," +
      "  ISNULL(cb.BalanceDue,0) AS BalanceDue, ISNULL(cb.BalanceDue,0) AS TotalAR" +
      baseFROM +
      // Highest Total AR (outstanding) first so users prioritise big balances (2026-08-11).
      " ORDER BY ISNULL(cb.BalanceDue,0) DESC, c.[Name] OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY"
    );

    res.json({
      total:    cntRes.recordset[0]?.Total || 0,
      data:     dataRes.recordset || [],
      currency: company.currency,
      symbol:   company.symbol,
      company:  company.code,
    });

  } catch (err) {
    console.error('Customers list error:', err.message);
    res.status(500).json({ message: 'Failed to load customers', error: err.message });
  }
});

/* ── DEBUG endpoint — MUST come before /:id so Express doesn't match the
   debug-apply path against the generic /:id route. Uses ?docNo= query param
   instead of a path segment to avoid slash-encoding issues in the NAV doc no.
   Hit:
     /api/sales/customers/debug-apply?company=COMPANYA&docNo=COMPANYA/2627/01187
*/
router.get('/debug-apply', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const P       = company.prefix;
    const pool    = await getPool();
    const docNo   = String(req.query.docNo || '').trim();
    if (!docNo) return res.status(400).json({ message: 'docNo query param required' });

    // (1) Column list for the DCLE table — confirms exact field names in this NAV instance
    const colQ = await pool.request().query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS" +
      " WHERE TABLE_NAME = '" + P.replace(/\$/g, '').replace(/[\[\]]/g, '').replace(/^\s+|\s+$/g, '') + "Detailed Cust_ Ledg_ Entry'" +
      " ORDER BY ORDINAL_POSITION"
    );

    // (2) Raw payment CLE row with every apply-related field
    const cleQ = await pool.request().input('docNo', sql.NVarChar, docNo).query(
      " SELECT TOP 5" +
      "   [Entry No_]                                AS EntryNo," +
      "   [Document Type]                            AS DocType," +
      "   [Document No_]                             AS DocNo," +
      "   [Customer No_]                             AS CustomerNo," +
      "   [Posting Date]                             AS PostingDate," +
      "   [External Document No_]                    AS OwnExtDocNo," +
      "   [Applies-to Doc_ Type]                     AS AppliesToDocType," +
      "   [Applies-to Doc_ No_]                      AS AppliesToDocNo," +
      "   [Applies-to ID]                            AS AppliesToId," +
      "   [Closed by Entry No_]                      AS ClosedByEntryNo," +
      "   [Closed at Date]                           AS ClosedAtDate," +
      "   CAST([Open] AS bit)                        AS IsOpen" +
      " FROM " + P + "Cust_ Ledger Entry]" +
      " WHERE [Document No_] = @docNo"
    );

    // (3) ALL Detailed Cust. Ledg. Entry rows for this payment's CLE entry(ies)
    const dcleQ = await pool.request().input('docNo', sql.NVarChar, docNo).query(
      " SELECT TOP 50 *" +
      " FROM " + P + "Detailed Cust_ Ledg_ Entry]" +
      " WHERE [Cust_ Ledger Entry No_] IN (" +
      "   SELECT [Entry No_] FROM " + P + "Cust_ Ledger Entry] WHERE [Document No_] = @docNo" +
      " )" +
      " ORDER BY [Entry No_]"
    );

    res.json({
      docNo,
      company: company.code,
      dcleColumns:  colQ.recordset,        // confirms exact column names
      paymentCleRows: cleQ.recordset,      // 1+ payment CLE rows with apply fields
      detailedRows:   dcleQ.recordset,     // raw DCLE rows
      hint: 'Look at dcleColumns to confirm field names. Look at detailedRows for actual values linking this payment to invoice(s).',
    });
  } catch (err) {
    console.error('Debug apply error:', err);
    res.status(500).json({ message: 'Debug failed', error: err.message, stack: err.stack });
  }
});

/* ── GET /api/sales/customers/:id ────────────────────────────────────────── */
// ── GET /suggest — typeahead for Customer Name input in PDC / Visit / etc. ───
// MUST be declared before /:id otherwise Express 5 matches "suggest" as an id.
// Returns up to N rows: [{ CustomerCode, Name, City, Phone }].
router.get('/suggest', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const P       = company.prefix;
    const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';
    const role    = (req.user.role || '').toLowerCase();
    const isAdmin = isFullAccess(req.user);
    const codes   = (req.user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);

    const q     = (req.query.q || '').trim();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    // `?all=1` bypasses the salesperson-code scope. Used by Visit Punch so reps
    // can punch at ANY NAV customer (covering for colleagues, prospect visits,
    // etc.), not just their own assigned book. Names + phones only — no
    // financial data is exposed by this endpoint, so the relaxation is safe.
    const showAll = req.query.all === '1' || req.query.all === 'true';
    if (q.length < 2) return res.json({ data: [] });

    const pool = await getPool();
    const r = pool.request();
    r.input('q',       sql.NVarChar(200), '%' + q + '%');
    r.input('qPrefix', sql.NVarChar(200), q + '%');
    r.input('lim',     sql.Int, limit);

    const spAnd = (!isAdmin && !showAll && codes.length)
      ? 'AND (' + codes.map((_, i) => 'c.[Salesperson Code] = @spCode' + i).join(' OR ') + ')'
      : '';
    if (!isAdmin && !showAll) codes.forEach((c, i) => r.input('spCode' + i, sql.NVarChar, c));

    const result = await r.query(`
      SELECT TOP (@lim)
        c.[No_]  AS CustomerCode,
        c.[Name] AS Name,
        ISNULL(c.[City],'')     AS City,
        ISNULL(c.[Phone No_],'') AS Phone
      FROM ${P}Customer] c
      WHERE ISNULL(LTRIM(RTRIM(c.[Name])),'') <> ''
        AND (c.[Name] COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @q
          OR c.[No_]  COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @q)
        ${spAnd}
      ORDER BY
        CASE WHEN c.[Name] COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @qPrefix THEN 0 ELSE 1 END,
        c.[Name]
    `);
    res.json({ data: result.recordset || [] });
  } catch (err) {
    console.error('Customer suggest error:', err.message);
    res.status(500).json({ message: 'Suggest failed', error: err.message });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const P       = company.prefix;
    const pool    = await getPool();

    // ── Customer header
    const custRes = await pool.request()
      .input('id', sql.NVarChar, req.params.id)
      .query(
        "WITH DCLEAgg AS (" +
        "  SELECT [Cust_ Ledger Entry No_] AS EntryNo, SUM([Amount (LCY)]) AS RemainingAmount" +
        "  FROM " + P + "Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_]" +
        "), CB AS (" +
        "  SELECT cle.[Customer No_] AS CN, SUM(ISNULL(d.RemainingAmount,0)) AS BD" +
        "  FROM " + P + "Cust_ Ledger Entry] cle" +
        "  LEFT JOIN DCLEAgg d ON d.EntryNo = cle.[Entry No_]" +
        "  WHERE cle.[Open]=1 GROUP BY cle.[Customer No_]" +
        ")" +
        " SELECT TOP 1" +
        "  c.[No_] AS CustomerNo, c.[Name] AS Name," +
        "  c.[City] AS City, c.[State Code] AS State," +
        "  c.[Phone No_] AS Phone, c.[E-Mail] AS Email," +
        "  c.[Address] AS Address, c.[Address 2] AS Address2," +
        "  c.[Post Code] AS PinCode," +
        (company.code === 'COMPANYA' ? "  c.[GST Registration No_] AS GSTNo," : "  '' AS GSTNo,") +
        "  ISNULL(sp.[Name], c.[Salesperson Code]) AS Salesperson," +
        "  c.[Payment Terms Code] AS PaymentTerms," +
        "  c.[Credit Limit (LCY)] AS CreditLimit," +
        "  ISNULL(cb.BD,0) AS BalanceDue, ISNULL(cb.BD,0) AS TotalAR" +
        " FROM " + P + "Customer] c" +
        " LEFT JOIN CB cb ON cb.CN = c.[No_]" +
        " LEFT JOIN " + P + "Salesperson_Purchaser] sp ON sp.[Code] = c.[Salesperson Code]" +
        " WHERE c.[No_] = @id"
      );

    // ── Full ledger — all entries (open + closed), oldest first
    //
    // SalesLCY column source = DCLE.[Amount (LCY)] of the FIRST detail row
    // per CLE Entry (Initial Entry by NAV convention). This gives the original
    // posted amount INCLUDES GST — what the customer actually owes/owed.
    //
    // Why ROW_NUMBER over MIN([Entry No_]) instead of [Entry Type]=0 or
    // [Initial Entry]=1 filters:
    //   In this NAV instance both filters fail —
    //     [Entry Type] = 0       returns NULL for many CLEs
    //     [Initial Entry] = 1    column does not exist (SQL error)
    //   The Initial Entry row is always the FIRST DCLE row created for a CLE,
    //   so ranking by [Entry No_] ASC and taking rn=1 reliably picks it.
    //
    // Other columns (Doc No, Description, Posting Date, Due Date, etc.) come
    // from CLE — DCLE only feeds the Amount (LCY) and Outstanding columns.
    const ledRes = await pool.request()
      .input('id', sql.NVarChar, req.params.id)
      .query(
        "WITH DCLEAgg AS (" +
        "  SELECT [Cust_ Ledger Entry No_] AS EntryNo, SUM([Amount (LCY)]) AS RemainingAmount" +
        "  FROM " + P + "Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_]" +
        "), DCLEInitial AS (" +
        "  SELECT EntryNo, InitialAmount FROM (" +
        "    SELECT [Cust_ Ledger Entry No_] AS EntryNo," +
        "           [Amount (LCY)]           AS InitialAmount," +
        "           ROW_NUMBER() OVER (PARTITION BY [Cust_ Ledger Entry No_]" +
        "                              ORDER BY [Entry No_]) AS rn" +
        "    FROM " + P + "Detailed Cust_ Ledg_ Entry]" +
        "  ) ranked WHERE ranked.rn = 1" +
        ")" +
        " SELECT" +
        "  cle.[Entry No_]                                         AS EntryNo," +
        "  CASE cle.[Document Type]" +
        "    WHEN 0 THEN '' WHEN 1 THEN 'Payment' WHEN 2 THEN 'Invoice'" +
        "    WHEN 3 THEN 'Credit Memo' WHEN 4 THEN 'Finance Charge'" +
        "    WHEN 5 THEN 'Reminder' WHEN 6 THEN 'Refund' ELSE 'Other'" +
        "  END                                                      AS DocType," +
        "  cle.[Document No_]                                       AS DocNo," +
        // ExtDocNo: For Payment rows (Document Type = 1), surface the applied
        // INVOICE's DOCUMENT NUMBER (e.g. COMPANYA/BE-2526/0376). When the payment
        // is applied to MULTIPLE invoices, all of them are concatenated
        // ("COMPANYA/BE-2526/0376; COMPANYA/BE-2526/0381"). For non-payment rows, the
        // entry's own External Document No_ still shows.
        //
        // Lookup order (first non-empty wins):
        //   (c) DCLE aggregate — primary, works for both direct-apply AND
        //       Apply-Entries modes, single OR multi-invoice. NAV creates
        //       Detailed Cust_ Ledg_ Entry rows for every application.
        //   (a) Applies-to Doc_ No_ on the payment CLE — direct apply at posting
        //   (b) Closed by Entry No_ → invoice CLE — full-closure case
        //   fallback: payment's own External Document No_
        "  CASE WHEN cle.[Document Type] = 1" +
        "       THEN COALESCE(" +
        "              NULLIF(applDcle.InvDocNos, '')," +
        "              NULLIF(cle.[Applies-to Doc_ No_], '')," +
        "              NULLIF(applClosed.InvDocNo, '')," +
        "              ISNULL(cle.[External Document No_], '')" +
        "            )" +
        "       ELSE ISNULL(cle.[External Document No_], '')" +
        "  END                                                      AS ExtDocNo," +
        "  cle.[Description]                                        AS Description," +
        "  cle.[Posting Date]                                       AS PostingDate," +
        "  cle.[Due Date]                                           AS DueDate," +
        "  ISNULL(di.InitialAmount, 0)                              AS SalesLCY," +
        "  ISNULL(d.RemainingAmount, 0)                             AS Outstanding," +
        "  CAST(cle.[Open] AS bit)                                  AS IsOpen," +
        "  ISNULL(cle.[On Hold],'')                                 AS OnHold," +
        "  cle.[Salesperson Code]                                   AS Salesperson," +
        "  cle.[Currency Code]                                      AS Currency," +
        "  cle.[Pmt_ Discount Date]                                 AS PmtDiscDate," +
        "  cle.[Original Pmt_ Disc_ Possible]                      AS PmtDiscPossible," +
        "  cle.[Closed at Date]                                     AS ClosedDate," +
        "  cle.[User ID]                                            AS UserId" +
        " FROM " + P + "Cust_ Ledger Entry] cle" +
        " LEFT JOIN DCLEAgg     d  ON d.EntryNo  = cle.[Entry No_]" +
        " LEFT JOIN DCLEInitial di ON di.EntryNo = cle.[Entry No_]" +
        // Path (b) CLOSED BY: payment's Closed by Entry No_ → invoice CLE
        " OUTER APPLY (" +
        "   SELECT TOP 1 invCle.[Document No_] AS InvDocNo" +
        "   FROM " + P + "Cust_ Ledger Entry] invCle" +
        "   WHERE invCle.[Entry No_]     = cle.[Closed by Entry No_]" +
        "     AND invCle.[Document Type] = 2" +
        " ) applClosed" +
        // Path (c) PRIMARY: DCLE-based aggregation — concatenates ALL distinct
        // invoice Document Nos applied to this payment. UNIONs both directions
        // because NAV writes DCLE on the side that initiates "Apply Entries":
        //   FORWARD — DCLE row on payment, points to invoice (Cash Receipts apply)
        //   REVERSE — DCLE row on invoice, points to payment (Apply from invoice)
        // Without the UNION we miss every payment applied from the invoice side.
        // FOR XML PATH used instead of STRING_AGG for SQL 2014 compatibility.
        " OUTER APPLY (" +
        "   SELECT STUFF((" +
        "     SELECT '; ' + InvDocNo" +
        "     FROM (" +
        "       SELECT DISTINCT invCle.[Document No_] AS InvDocNo" +
        "       FROM " + P + "Detailed Cust_ Ledg_ Entry] dcle" +
        "       JOIN " + P + "Cust_ Ledger Entry] invCle" +
        "         ON invCle.[Entry No_] = dcle.[Applied Cust_ Ledger Entry No_]" +
        "       WHERE dcle.[Cust_ Ledger Entry No_] = cle.[Entry No_]" +
        "         AND dcle.[Applied Cust_ Ledger Entry No_] <> 0" +
        "         AND dcle.[Applied Cust_ Ledger Entry No_] <> cle.[Entry No_]" +
        "         AND invCle.[Document Type] = 2" +
        "       UNION" +
        "       SELECT DISTINCT invCle.[Document No_] AS InvDocNo" +
        "       FROM " + P + "Detailed Cust_ Ledg_ Entry] dcle" +
        "       JOIN " + P + "Cust_ Ledger Entry] invCle" +
        "         ON invCle.[Entry No_] = dcle.[Cust_ Ledger Entry No_]" +
        "       WHERE dcle.[Applied Cust_ Ledger Entry No_] = cle.[Entry No_]" +
        "         AND dcle.[Cust_ Ledger Entry No_] <> 0" +
        "         AND dcle.[Cust_ Ledger Entry No_] <> cle.[Entry No_]" +
        "         AND invCle.[Document Type] = 2" +
        "     ) X" +
        "     FOR XML PATH(''), TYPE" +
        "   ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS InvDocNos" +
        " ) applDcle" +
        " WHERE cle.[Customer No_] = @id" +
        " ORDER BY cle.[Posting Date] ASC, cle.[Entry No_] ASC"
      );

    res.json({
      customer: custRes.recordset[0] || null,
      ledger:   ledRes.recordset     || [],
      currency: company.currency,
      symbol:   company.symbol,
      company:  company.code,
    });

  } catch (err) {
    console.error('Customer detail error:', err.message);
    res.status(500).json({ message: 'Failed to load customer detail', error: err.message });
  }
});

// ── (OLD path-segment-based debug — kept disabled to avoid clashing with /:id) ──
// The new query-param version above (`GET /debug-apply?docNo=...`) is the one
// to use. This one is dead code; the early `return` short-circuits any hit.
router.get('/debug-apply-old/:docNo', authenticate, async (req, res) => {
  return res.status(410).json({ message: 'Use /api/sales/customers/debug-apply?docNo=... instead' });
  // eslint-disable-next-line no-unreachable
  /* legacy body retained for reference only */
  (async () => {
  try {
    const company = getCompany(req);
    const P    = company.prefix;
    const pool = await getPool();
    const docNo = req.params.docNo;
    const r = await pool.request().input('docNo', sql.NVarChar, docNo).query(
      " SELECT TOP 5" +
      "  cle.[Entry No_]                                 AS EntryNo," +
      "  cle.[Document Type]                             AS DocType," +
      "  cle.[Document No_]                              AS DocNo," +
      "  cle.[Customer No_]                              AS CustomerNo," +
      "  cle.[External Document No_]                     AS OwnExtDocNo," +
      "  cle.[Applies-to Doc_ Type]                      AS AppliesToDocType," +
      "  cle.[Applies-to Doc_ No_]                       AS AppliesToDocNo," +
      "  cle.[Applies-to ID]                             AS AppliesToId," +
      "  cle.[Closed by Entry No_]                       AS ClosedByEntryNo," +
      "  cle.[Closed at Date]                            AS ClosedAtDate," +
      "  CAST(cle.[Open] AS bit)                         AS IsOpen," +
      "  applDirect.InvDocNo                             AS PathA_DirectApply," +
      "  applClosed.InvDocNo                             AS PathB_ClosedBy," +
      "  applDcle.InvDocNo                               AS PathC_DcleJoin," +
      "  (SELECT COUNT(*) FROM " + P + "Detailed Cust_ Ledg_ Entry] WHERE [Cust_ Ledger Entry No_] = cle.[Entry No_])  AS DcleRowCount," +
      "  (SELECT COUNT(*) FROM " + P + "Detailed Cust_ Ledg_ Entry] WHERE [Cust_ Ledger Entry No_] = cle.[Entry No_] AND ISNULL([Applied Cust_ Ledger Entry No_], 0) <> 0) AS DcleAppliedCount" +
      " FROM " + P + "Cust_ Ledger Entry] cle" +
      " OUTER APPLY (" +
      "   SELECT TOP 1 invCle.[Document No_] AS InvDocNo" +
      "   FROM " + P + "Cust_ Ledger Entry] invCle" +
      "   WHERE invCle.[Customer No_]  = cle.[Customer No_]" +
      "     AND invCle.[Document No_]  = NULLIF(cle.[Applies-to Doc_ No_], '')" +
      "     AND invCle.[Document Type] = 2" +
      " ) applDirect" +
      " OUTER APPLY (" +
      "   SELECT TOP 1 invCle.[Document No_] AS InvDocNo" +
      "   FROM " + P + "Cust_ Ledger Entry] invCle" +
      "   WHERE invCle.[Entry No_]     = cle.[Closed by Entry No_]" +
      "     AND invCle.[Document Type] = 2" +
      " ) applClosed" +
      " OUTER APPLY (" +
      "   SELECT STUFF((" +
      "     SELECT DISTINCT '; ' + invCle.[Document No_]" +
      "     FROM " + P + "Detailed Cust_ Ledg_ Entry] dcle" +
      "     JOIN " + P + "Cust_ Ledger Entry] invCle ON invCle.[Entry No_] = dcle.[Applied Cust_ Ledger Entry No_]" +
      "     WHERE dcle.[Cust_ Ledger Entry No_] = cle.[Entry No_]" +
      "       AND dcle.[Applied Cust_ Ledger Entry No_] <> 0" +
      "       AND dcle.[Applied Cust_ Ledger Entry No_] <> cle.[Entry No_]" +
      "       AND invCle.[Document Type] = 2" +
      "     FOR XML PATH(''), TYPE" +
      "   ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS InvDocNo" +
      " ) applDcle" +
      " WHERE cle.[Document No_] = @docNo"
    );

    // Also pull the raw DCLE rows for visibility
    const dcle = await pool.request().input('docNo', sql.NVarChar, docNo).query(
      " SELECT TOP 20 dcle.[Entry No_] AS DcleEntryNo," +
      "        dcle.[Cust_ Ledger Entry No_]            AS CustLedgEntryNo," +
      "        dcle.[Entry Type]                        AS EntryType," +
      "        dcle.[Applied Cust_ Ledger Entry No_]    AS AppliedCustLedgEntryNo," +
      "        dcle.[Document Type]                     AS DocType," +
      "        dcle.[Document No_]                      AS DocNo," +
      "        dcle.[Amount]                            AS Amount" +
      " FROM " + P + "Detailed Cust_ Ledg_ Entry] dcle" +
      " WHERE dcle.[Cust_ Ledger Entry No_] IN (" +
      "   SELECT [Entry No_] FROM " + P + "Cust_ Ledger Entry] WHERE [Document No_] = @docNo)" +
      " ORDER BY dcle.[Entry No_]"
    );

    res.json({ docNo, company: company.code, cleRows: r.recordset, detailedRows: dcle.recordset });
  } catch (err) {
    console.error('Debug apply error:', err.message);
    res.status(500).json({ message: 'Debug failed', error: err.message });
  }
  })();   // close the dead-code IIFE
});

module.exports = router;
