// =====================================================================
// modules/warehouse/routes/sales.js — Posted-sales dispatch tracking (Company B SG)
//
// Hybrid module like Purchase. BN_WhSales holds the warehouse's MANUAL
// dispatch / paperwork fields (cartons, courier, AWB, permits, GST claim,
// dispatch dates). The NAV side provides the posted invoice's live header
// + line + customer details via JOIN at query time.
//
// NAV sources:
//   [Company B Pte Ltd_$Sales Invoice Header]  — invoice meta
//   [Company B Pte Ltd_$Sales Invoice Line]    — item / qty / rate
//   [Company B Pte Ltd_$Customer]              — customer name + country
//
// UPSERT semantics on POST: UNIQUE (Company, InvoiceNo, LineNumber) means
// inserting the same (Inv, Line) twice would error. POST detects existing
// row and updates instead, so the warehouse can "re-add" a previously-
// dispatched line without first finding + clicking Edit.
//
// Auth: warehouse=CRUD, isFullAccess=READ.
// =====================================================================

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { sql, getPool, getAppPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const X = require('../_excel');

const upload      = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const COMPANY     = 'COMPANYB';
const NAV_PREFIX  = '[dbo].[Company B Pte Ltd_$';
const SG_GST_RATE = 0.09;

function isWarehouseRole(user) {
  return ((user && user.role) || '').toLowerCase().trim() === 'warehouse';
}
function canRead(user)  { return isWarehouseRole(user) || isFullAccess(user); }
function canWrite(user) { return isWarehouseRole(user); }

// ── Enrich BN_WhSales rows with live NAV data ──────────────────────────
async function enrichWithNav(rows) {
  if (!rows.length) return rows;
  const keys = rows
    .filter(r => r.InvoiceNo && r.LineNumber != null)
    .map(r => ({ InvoiceNo: String(r.InvoiceNo), LineNumber: Number(r.LineNumber) }));
  if (!keys.length) return rows;

  const pool = await getPool();
  const r = pool.request();
  const tuples = [];
  keys.forEach((k, i) => {
    r.input('inv' + i, sql.NVarChar(50), k.InvoiceNo);
    r.input('ln'  + i, sql.Int,         k.LineNumber);
    tuples.push(`(@inv${i}, @ln${i})`);
  });
  const navRes = await r.query(`
    WITH Keys AS (SELECT * FROM (VALUES ${tuples.join(',')}) AS V(InvoiceNo, LineNumber))
    SELECT
      k.InvoiceNo, k.LineNumber,
      sl.[Sell-to Customer No_]      AS CustomerCode,
      ISNULL(c.[Name], '')           AS CustomerName,
      ISNULL(c.[Country_Region Code], '') AS CustomerCountry,
      sh.[Posting Date]              AS InvoiceDate,
      sh.[External Document No_]     AS CustomerPo,
      sh.[Currency Code]             AS Currency,
      ISNULL(sh.[Currency Factor], 1) AS CurrencyFactor,
      ISNULL(sh.[Salesperson Code], '') AS SalespersonCode,
      sl.[No_]                       AS ItemNo,
      ISNULL(sl.[Description], '')   AS ItemName,
      ISNULL(sl.[Quantity], 0)       AS Quantity,
      ISNULL(sl.[Unit Price], 0)     AS UnitPrice,
      ISNULL(sl.[Line Amount], 0)    AS LineAmount,
      ISNULL(sl.[Amount Including VAT], 0) AS AmountInclVAT,
      ISNULL(sl.[VAT _], 0)          AS VATPercent
    FROM Keys k
    LEFT JOIN ${NAV_PREFIX}Sales Invoice Line] sl
      ON sl.[Document No_]  = k.InvoiceNo
     AND sl.[Line No_]      = k.LineNumber
    LEFT JOIN ${NAV_PREFIX}Sales Invoice Header] sh
      ON sh.[No_] = k.InvoiceNo
    LEFT JOIN ${NAV_PREFIX}Customer] c
      ON c.[No_] = sh.[Sell-to Customer No_];
  `);

  const navByKey = new Map();
  for (const n of navRes.recordset) navByKey.set(`${n.InvoiceNo}::${n.LineNumber}`, n);

  return rows.map(row => {
    const nav = navByKey.get(`${row.InvoiceNo}::${row.LineNumber}`) || null;
    const Quantity      = nav ? Number(nav.Quantity      || 0) : 0;
    const UnitPrice     = nav ? Number(nav.UnitPrice     || 0) : 0;
    const LineAmount    = nav ? Number(nav.LineAmount    || 0) : 0;
    const AmountInclVAT = nav ? Number(nav.AmountInclVAT || 0) : 0;
    const VATPercent    = nav ? Number(nav.VATPercent    || 0) : 0;
    const GstAmount     = +(AmountInclVAT - LineAmount).toFixed(2);

    return {
      ...row,
      CustomerCode:    nav ? nav.CustomerCode    : null,
      CustomerName:    nav ? nav.CustomerName    : null,
      CustomerCountry: nav ? nav.CustomerCountry : null,
      InvoiceDate:     nav ? nav.InvoiceDate     : null,
      CustomerPo:      nav ? nav.CustomerPo      : null,
      Currency:        nav ? nav.Currency        : null,
      CurrencyFactor:  nav ? Number(nav.CurrencyFactor || 1) : 1,
      SalespersonCode: nav ? nav.SalespersonCode : null,
      ItemNo:          nav ? nav.ItemNo          : null,
      ItemName:        nav ? nav.ItemName        : null,
      Quantity, UnitPrice, LineAmount, AmountInclVAT, VATPercent, GstAmount,
    };
  });
}

// ── GET /api/warehouse/sales ───────────────────────────────────────────
// DEFAULT (2026-06-11 per user direction): show **upcoming invoices** —
// SO Backlog rows with Remarks='PFP', formatted as Sales Invoices with
// the pre-assigned Posting No used as the Invoice No. Mirrors the
// In-Transit filter on the Purchase page; Amit only sees rows that are
// physically about to dispatch from his warehouse.
//
// ESCAPE HATCH: pass ?showPosted=1 to revert to the old "all posted
// Sales Invoices" view (kept for admin / oversight).
router.get('/', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const search  = (req.query.search  || '').trim();
    const tracked = (req.query.tracked || 'all').trim().toLowerCase();
    const dateFrom = (req.query.dateFrom || '').trim();
    const dateTo   = (req.query.dateTo   || '').trim();
    const days    = Math.min(1825, Math.max(1, parseInt(req.query.days || '90', 10)));
    const page    = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit   = Math.min(500, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset  = (page - 1) * limit;
    const showPosted = (req.query.showPosted ?? '0') === '1';
    // Specific PFP variant to filter on (one of PFP / PFP-WAITING-FF / PFP-DROP /
    // PFP-PICK-PACK), or empty/missing → include all PFP-prefix variants (the
    // "All" mode powering the default Sales-Invoices view).
    const remarksParam = (req.query.remarks || '').trim();
    const remarksFilterSql = remarksParam
      ? `ISNULL(SL.[Remarks], '') = @remarksParam`
      : `ISNULL(SL.[Remarks], '') LIKE 'PFP%'`;

    const navPool = await getPool();
    const r = navPool.request();
    r.input('co',     sql.NVarChar(10), COMPANY);
    r.input('offset', sql.Int, offset);
    r.input('limit',  sql.Int, limit);
    r.input('days',   sql.Int, days);
    if (remarksParam) r.input('remarksParam', sql.NVarChar(50), remarksParam);

    // Date column differs by mode:
    //   showPosted=1 → filter on sh.[Posting Date] (when actually posted)
    //   default PFP  → filter on SH.[Order Date]   (when SO was raised)
    // Date filter is OPTIONAL in PFP mode (match SO Backlog behaviour — Amit
    // wants to see all upcoming invoices regardless of order age). In
    // showPosted mode we keep the default last-N-days filter as before.
    const dateColumn = showPosted ? 'sh.[Posting Date]' : 'SH.[Order Date]';
    let dateWhere = showPosted
      ? `${dateColumn} >= DATEADD(DAY, -@days, CAST(SYSDATETIME() AS DATE))`
      : '1 = 1';   // PFP default: no date filter
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      r.input('df', sql.Date, dateFrom);
      dateWhere = `${dateColumn} >= @df`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        r.input('dt', sql.Date, dateTo);
        dateWhere += ` AND ${dateColumn} <= @dt`;
      }
    }

    // Broad search across NAV + manual fields. Alias set differs by mode.
    let searchWhere = '';
    if (search) {
      r.input('q', sql.NVarChar(200), '%' + search + '%');
      searchWhere = showPosted ? ` AND (
           il.[Document No_] LIKE @q OR il.[No_] LIKE @q
        OR il.[Description] LIKE @q
        OR ISNULL(i.[Vendor Item No_], '') LIKE @q
        OR ISNULL(il.[Shortcut Dimension 2 Code], '') LIKE @q
        OR ISNULL(sh.[Bill-to Name], '') LIKE @q
        OR ISNULL(sh.[Bill-to Address], '') LIKE @q
        OR ISNULL(sh.[External Document No_], '') LIKE @q
        OR ISNULL(sh.[Currency Code], '') LIKE @q
        OR ISNULL(il.[Transport Method], '') LIKE @q
        OR CAST(il.[Quantity] AS NVARCHAR(40)) LIKE @q
        OR CAST(il.[Unit Price] AS NVARCHAR(40)) LIKE @q
        OR CAST(il.[Amount] AS NVARCHAR(40)) LIKE @q
        OR CAST(il.[Amount To Customer] AS NVARCHAR(40)) LIKE @q
        OR CONVERT(NVARCHAR(20), sh.[Posting Date], 23) LIKE @q
        OR ISNULL(bn.AirWaybillNo, '') LIKE @q
        OR ISNULL(bn.DispatchThrough, '') LIKE @q
        OR ISNULL(bn.Status, '') LIKE @q
        OR ISNULL(bn.PermitNo, '') LIKE @q
        OR ISNULL(bn.FrightInvoice, '') LIKE @q
        OR ISNULL(bn.GSTClaimedMonth, '') LIKE @q
        OR ISNULL(bn.Remark, '') LIKE @q
        OR CONVERT(NVARCHAR(20), bn.DispatchDate, 23) LIKE @q
      )` : ` AND (
           SH.[Posting No_] LIKE @q OR SH.[No_] LIKE @q OR SL.[No_] LIKE @q
        OR SL.[Description] LIKE @q
        OR ISNULL(I.[Vendor Item No_], '') LIKE @q
        OR ISNULL(SL.[Shortcut Dimension 2 Code], '') LIKE @q
        OR ISNULL(SH.[Sell-to Customer Name], '') LIKE @q
        OR ISNULL(SH.[Sell-to Address], '') LIKE @q
        OR ISNULL(SH.[External Document No_], '') LIKE @q
        OR ISNULL(SH.[Currency Code], '') LIKE @q
        OR ISNULL(SH.[Shipment Method Code], '') LIKE @q
        OR CAST(SL.[Outstanding Quantity] AS NVARCHAR(40)) LIKE @q
        OR CAST(SL.[Unit Price] AS NVARCHAR(40)) LIKE @q
        OR CONVERT(NVARCHAR(20), SH.[Order Date], 23) LIKE @q
        OR ISNULL(bn.AirWaybillNo, '') LIKE @q
        OR ISNULL(bn.DispatchThrough, '') LIKE @q
        OR ISNULL(bn.Status, '') LIKE @q
        OR ISNULL(bn.Remark, '') LIKE @q
      )`;
    }

    let trackedWhere = '';
    if (tracked === 'yes') trackedWhere = ' AND bn.Id IS NOT NULL';
    else if (tracked === 'no') trackedWhere = ' AND bn.Id IS NULL';

    // Build the query depending on mode. The output schema is the same in
    // both cases so the frontend renderer doesn't care which CTE produced it.
    const postedSql = `
      WITH ChargesAgg AS (
        SELECT
          [Document No_] AS InvNo,
          SUM(CASE WHEN [No_] = '4112904' THEN ISNULL([Amount], 0) ELSE 0 END) AS BankCharge_GL,
          SUM(CASE WHEN [No_] = '3112021' THEN ISNULL([Amount], 0) ELSE 0 END) AS FreightCharge_GL
        FROM ${NAV_PREFIX}Sales Invoice Line]
        WHERE [Type] = 1 AND [No_] IN ('4112904', '3112021')
        GROUP BY [Document No_]
      ),
      ItemLines AS (
        -- Rank item lines per invoice so we can mark line 1
        SELECT sl.*,
          ROW_NUMBER() OVER (PARTITION BY sl.[Document No_] ORDER BY sl.[Line No_]) AS LineRank
        FROM ${NAV_PREFIX}Sales Invoice Line] sl
        WHERE sl.[Type] = 2
      ),
      Filtered AS (
        SELECT
          il.[Document No_]                    AS InvoiceNo,
          il.[Line No_]                        AS LineNumber,
          sh.[Posting Date]                    AS InvoiceDate,
          sh.[Bill-to Customer No_]            AS CustomerCode,
          ISNULL(sh.[Bill-to Name], '')        AS CustomerName,
          ISNULL(sh.[Bill-to Address], '')     AS CustomerAddress,
          ISNULL(c.[Country_Region Code], '')  AS CustomerCountry,
          ISNULL(sh.[External Document No_], '') AS CustomerPo,
          ISNULL(sh.[Currency Code], '')       AS Currency,
          ISNULL(sh.[Salesperson Code], '')    AS SalespersonCode,
          il.[No_]                             AS ItemCode,
          ISNULL(NULLIF(i.[Vendor Item No_], ''), il.[Description]) AS ItemName,
          ISNULL(il.[Description], '')         AS ItemDescription,
          ISNULL(il.[Shortcut Dimension 2 Code], '') AS Make,
          ISNULL(il.[Quantity], 0)             AS Quantity,
          ISNULL(il.[Unit Price], 0)           AS UnitPrice,
          ISNULL(il.[Amount], 0)               AS LineAmount,
          ISNULL(il.[Charges To Customer], 0)  AS GstAmount,
          ISNULL(il.[Transport Method], '')    AS ShipmentTerms,
          il.LineRank                          AS LineRank,
          -- Bank Charge + Freight: ONLY on the first item line of each invoice
          CASE WHEN il.LineRank = 1 THEN ISNULL(cg.BankCharge_GL, 0)   ELSE 0 END AS BankCharge,
          CASE WHEN il.LineRank = 1 THEN ISNULL(cg.FreightCharge_GL,0) ELSE 0 END AS FreightCharges,
          -- Total Amt = Value + GST + Bank (line 1 only) + Freight (line 1 only)
          ISNULL(il.[Amount], 0)
            + ISNULL(il.[Charges To Customer], 0)
            + CASE WHEN il.LineRank = 1 THEN ISNULL(cg.BankCharge_GL, 0)   ELSE 0 END
            + CASE WHEN il.LineRank = 1 THEN ISNULL(cg.FreightCharge_GL,0) ELSE 0 END
            AS AmountInclVAT,
          -- BN_WhSales manual fields (NULL if not tracked yet)
          bn.Id AS BnId, bn.Cartons, bn.DispatchThrough, bn.AirWaybillNo,
          bn.LocalCharges, bn.DispatchDate, bn.Status,
          bn.FrightInvoice, bn.PermitNo,
          bn.ExportPermitType, bn.GSTClaimedMonth, bn.Remark
        FROM ItemLines il
        INNER JOIN ${NAV_PREFIX}Sales Invoice Header] sh
          ON sh.[No_] = il.[Document No_]
        LEFT JOIN ${NAV_PREFIX}Customer] c
          ON c.[No_] = sh.[Bill-to Customer No_]
        LEFT JOIN ${NAV_PREFIX}Item] i
          ON i.[No_] = il.[No_]
        LEFT JOIN ChargesAgg cg
          ON cg.InvNo = il.[Document No_]
        LEFT JOIN BizNAV_App.dbo.BN_WhSales bn
          ON bn.Company COLLATE DATABASE_DEFAULT = @co COLLATE DATABASE_DEFAULT
         AND bn.IsActive = 1
         AND bn.InvoiceNo COLLATE DATABASE_DEFAULT = il.[Document No_] COLLATE DATABASE_DEFAULT
         AND bn.LineNumber = il.[Line No_]
        WHERE ${dateWhere}
          ${searchWhere}
          ${trackedWhere}
      )
      SELECT *, COUNT(*) OVER () AS TotalRows
      FROM Filtered
      ORDER BY InvoiceDate DESC, InvoiceNo DESC, LineNumber
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `;

    // PFP / "upcoming invoices" CTE — DEFAULT MODE.
    // Source: NAV Sales Header + Sales Line (open orders) with Remarks='PFP'.
    // Output schema MATCHES the posted CTE exactly so frontend renderer works
    // unchanged. Key mappings:
    //   InvoiceNo  ← SH.[Posting No_]            (pre-assigned future invoice no)
    //   InvoiceDate ← SH.[Order Date]            (Posting Date doesn't exist yet)
    //   Customer*  ← Sell-to* (Bill-to populated only after posting)
    //   Quantity   ← SL.[Outstanding Quantity]   (what's left to ship — the receivable)
    //   LineAmount ← Outstanding × Unit Price    (= "Bal. Value" on SO Backlog)
    //   GstAmount  ← estimated from SL.[VAT _]   (actual GST only known post-posting)
    //   BankCharge / FreightCharges ← NULL       (GL aggregates only exist after posting)
    //   AmountInclVAT ← Value + estimated GST
    const pfpSql = `
      WITH PfpBacklog AS (
        SELECT
          SH.[Posting No_]                       AS InvoiceNo,
          SL.[Line No_]                          AS LineNumber,
          SH.[Order Date]                        AS InvoiceDate,
          SH.[Sell-to Customer No_]              AS CustomerCode,
          ISNULL(SH.[Sell-to Customer Name], '') AS CustomerName,
          ISNULL(SH.[Sell-to Address], '')       AS CustomerAddress,
          ISNULL(C.[Country_Region Code], '')    AS CustomerCountry,
          ISNULL(SH.[External Document No_], '') AS CustomerPo,
          ISNULL(SH.[Currency Code], '')         AS Currency,
          ISNULL(SH.[Salesperson Code], '')      AS SalespersonCode,
          SL.[No_]                               AS ItemCode,
          ISNULL(NULLIF(I.[Vendor Item No_], ''), SL.[Description]) AS ItemName,
          ISNULL(SL.[Description], '')           AS ItemDescription,
          ISNULL(SL.[Shortcut Dimension 2 Code], '') AS Make,
          ISNULL(SL.[Outstanding Quantity], 0)   AS Quantity,
          ISNULL(SL.[Unit Price], 0)             AS UnitPrice,
          CAST(ISNULL(SL.[Outstanding Quantity], 0) * ISNULL(SL.[Unit Price], 0) AS DECIMAL(18,4)) AS LineAmount,
          CAST(ISNULL(SL.[Outstanding Quantity], 0) * ISNULL(SL.[Unit Price], 0)
             * ISNULL(SL.[VAT _], 0) / 100.0 AS DECIMAL(18,4)) AS GstAmount,
          ISNULL(SH.[Shipment Method Code], '')  AS ShipmentTerms,
          1                                      AS LineRank,
          CAST(NULL AS DECIMAL(18,4))            AS BankCharge,
          CAST(NULL AS DECIMAL(18,4))            AS FreightCharges,
          CAST(ISNULL(SL.[Outstanding Quantity], 0) * ISNULL(SL.[Unit Price], 0)
             * (1.0 + ISNULL(SL.[VAT _], 0) / 100.0) AS DECIMAL(18,4)) AS AmountInclVAT,
          -- BN_WhSales JOIN on (Posting No, Line No). Empty for new PFP rows;
          -- populated once Amit saves dispatch fields against the future invoice no.
          bn.Id AS BnId, bn.Cartons, bn.DispatchThrough, bn.AirWaybillNo,
          bn.LocalCharges, bn.DispatchDate, bn.Status,
          bn.FrightInvoice, bn.PermitNo,
          bn.ExportPermitType, bn.GSTClaimedMonth, bn.Remark
        FROM ${NAV_PREFIX}Sales Header] SH
        INNER JOIN ${NAV_PREFIX}Sales Line] SL
          ON SH.[Document Type] = SL.[Document Type]
         AND SH.[No_]           = SL.[Document No_]
        LEFT JOIN ${NAV_PREFIX}Customer] C
          ON C.[No_] = SH.[Sell-to Customer No_]
        LEFT JOIN ${NAV_PREFIX}Item] I
          ON I.[No_] = SL.[No_]
        LEFT JOIN BizNAV_App.dbo.BN_WhSales bn
          ON bn.Company COLLATE DATABASE_DEFAULT = @co COLLATE DATABASE_DEFAULT
         AND bn.IsActive = 1
         AND bn.InvoiceNo COLLATE DATABASE_DEFAULT = SH.[Posting No_] COLLATE DATABASE_DEFAULT
         AND bn.LineNumber = SL.[Line No_]
        WHERE SH.[Document Type] = 1
          AND SL.[Type]          = 2
          AND ISNULL(SL.[Outstanding Quantity], 0) > 0
          AND ${remarksFilterSql}
          AND ${dateWhere}
          ${searchWhere}
          ${trackedWhere}
      )
      SELECT *, COUNT(*) OVER () AS TotalRows
      FROM PfpBacklog
      ORDER BY InvoiceDate DESC, InvoiceNo DESC, LineNumber
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `;

    const result = await r.query(showPosted ? postedSql : pfpSql);
    const rows = result.recordset || [];
    const total = rows.length > 0 ? rows[0].TotalRows : 0;
    const enriched = rows.map(row => ({
      ...row,
      Id: row.BnId,
      IsTracked: row.BnId != null,
    }));

    // Stat-card aggregates. In PFP mode we always return BREAKDOWN BY VARIANT
    // (so the 4 clickable cards each show their own count + value) regardless
    // of which variant is currently selected. The cards' counts should be
    // STABLE as the user clicks between them.
    let stats = null;
    if (!showPosted) {
      try {
        const statReq = navPool.request();
        statReq.input('co', sql.NVarChar(10), COMPANY);
        const statRes = await statReq.query(`
          WITH PfpAll AS (
            SELECT
              SH.[Posting No_]                       AS InvoiceNo,
              SL.[Line No_]                          AS LineNumber,
              ISNULL(SL.[Remarks], '')               AS Remarks,
              CAST(ISNULL(SL.[Outstanding Quantity], 0) * ISNULL(SL.[Unit Price], 0)
                 * (1.0 + ISNULL(SL.[VAT _], 0) / 100.0) AS DECIMAL(18,4)) AS LineTotal,
              bn.Status                              AS BnStatus
            FROM ${NAV_PREFIX}Sales Header] SH
            INNER JOIN ${NAV_PREFIX}Sales Line] SL
              ON SH.[Document Type] = SL.[Document Type]
             AND SH.[No_]           = SL.[Document No_]
            LEFT JOIN BizNAV_App.dbo.BN_WhSales bn
              ON bn.Company COLLATE DATABASE_DEFAULT = @co COLLATE DATABASE_DEFAULT
             AND bn.IsActive = 1
             AND bn.InvoiceNo COLLATE DATABASE_DEFAULT = SH.[Posting No_] COLLATE DATABASE_DEFAULT
             AND bn.LineNumber = SL.[Line No_]
            WHERE SH.[Document Type] = 1
              AND SL.[Type]          = 2
              AND ISNULL(SL.[Outstanding Quantity], 0) > 0
              AND ISNULL(SL.[Remarks], '') LIKE 'PFP%'
          )
          SELECT
            Remarks,
            COUNT(*)                                                  AS Lines,
            COUNT(DISTINCT InvoiceNo)                                 AS Invoices,
            CAST(ISNULL(SUM(LineTotal), 0) AS DECIMAL(18,2))          AS TotalValue,
            SUM(CASE WHEN BnStatus = 'Dispatched' THEN 1 ELSE 0 END)  AS DispatchedLines,
            COUNT(DISTINCT CASE WHEN BnStatus = 'Dispatched' THEN InvoiceNo END) AS DispatchedInvoices
          FROM PfpAll
          GROUP BY Remarks
          ORDER BY Remarks;
        `);
        const variants = statRes.recordset || [];
        // Also build a single combined "all PFP-prefix" totals row for convenience
        const allTotals = variants.reduce((acc, v) => ({
          Lines:              acc.Lines              + Number(v.Lines || 0),
          Invoices:           acc.Invoices           + Number(v.Invoices || 0), // upper bound — same invoice across variants double-counts
          TotalValue:         acc.TotalValue         + Number(v.TotalValue || 0),
          DispatchedLines:    acc.DispatchedLines    + Number(v.DispatchedLines || 0),
          DispatchedInvoices: acc.DispatchedInvoices + Number(v.DispatchedInvoices || 0),
        }), { Lines: 0, Invoices: 0, TotalValue: 0, DispatchedLines: 0, DispatchedInvoices: 0 });
        stats = { variants, all: allTotals };
      } catch (e) {
        console.warn('Sales stats query failed:', e.message);
      }
    }

    res.json({ data: enriched, total, page, limit, mode: showPosted ? 'posted' : 'pfp', stats });
  } catch (err) {
    console.error('GET /warehouse/sales error:', err.message);
    res.status(500).json({ message: 'Failed to list sales', error: err.message });
  }
});

// ── GET /api/warehouse/sales/invoice-suggest?q= ────────────────────────
// Typeahead for the "Add Sales Line" form — searches NAV's posted Sales
// Invoice Headers (recent first).
router.get('/invoice-suggest', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ data: [] });
    const pool = await getPool();
    const result = await pool.request()
      .input('q', sql.NVarChar(50), q + '%')
      .query(`
        SELECT TOP 20
          sh.[No_]                       AS InvoiceNo,
          sh.[Posting Date]              AS InvoiceDate,
          sh.[Sell-to Customer No_]      AS CustomerCode,
          ISNULL(c.[Name], '')           AS CustomerName,
          ISNULL(c.[Country_Region Code], '') AS CustomerCountry,
          sh.[Currency Code]             AS Currency,
          (SELECT COUNT(*) FROM ${NAV_PREFIX}Sales Invoice Line] sl
             WHERE sl.[Document No_] = sh.[No_] AND sl.[Type] = 2) AS LineCount
        FROM ${NAV_PREFIX}Sales Invoice Header] sh
        LEFT JOIN ${NAV_PREFIX}Customer] c
          ON c.[No_] = sh.[Sell-to Customer No_]
        WHERE sh.[No_] LIKE @q
        ORDER BY sh.[Posting Date] DESC, sh.[No_] DESC;
      `);
    res.json({ data: result.recordset || [] });
  } catch (err) {
    console.error('GET /warehouse/sales/invoice-suggest error:', err.message);
    res.status(500).json({ message: 'Invoice lookup failed', error: err.message });
  }
});

// ── GET /api/warehouse/sales/invoice-lines/:invoiceNo ──────────────────
// All NAV Sales Invoice Lines (item rows only) for a given invoice — used
// when warehouse picks an invoice and wants to add all its lines.
router.get('/invoice-lines/:invoiceNo', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('inv', sql.NVarChar(50), req.params.invoiceNo)
      .query(`
        SELECT
          sl.[Document No_]    AS InvoiceNo,
          sl.[Line No_]        AS LineNumber,
          sl.[No_]             AS ItemNo,
          ISNULL(sl.[Description], '')         AS ItemName,
          ISNULL(sl.[Quantity], 0)             AS Quantity,
          ISNULL(sl.[Unit Price], 0)           AS UnitPrice,
          ISNULL(sl.[Line Amount], 0)          AS LineAmount,
          ISNULL(sl.[Amount Including VAT], 0) AS AmountInclVAT,
          sh.[Posting Date]    AS InvoiceDate,
          ISNULL(c.[Name], '') AS CustomerName,
          sh.[Currency Code]   AS Currency
        FROM ${NAV_PREFIX}Sales Invoice Line] sl
        LEFT JOIN ${NAV_PREFIX}Sales Invoice Header] sh
          ON sh.[No_] = sl.[Document No_]
        LEFT JOIN ${NAV_PREFIX}Customer] c
          ON c.[No_] = sh.[Sell-to Customer No_]
        WHERE sl.[Document No_] = @inv
          AND sl.[Type]         = 2   -- 2 = Item line
        ORDER BY sl.[Line No_];
      `);
    res.json({ data: result.recordset || [] });
  } catch (err) {
    console.error('GET /warehouse/sales/invoice-lines error:', err.message);
    res.status(500).json({ message: 'Lookup failed', error: err.message });
  }
});

// ── GET /api/warehouse/sales/:id ───────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  // Numeric :id only — let path-style routes above handle non-numeric.
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ message: 'Not found' });
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getAppPool();
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('co', sql.NVarChar(10), COMPANY)
      .query(`SELECT * FROM dbo.BN_WhSales WHERE Id = @id AND Company = @co;`);
    if (!r.recordset.length) return res.status(404).json({ message: 'Sales row not found' });
    const enriched = await enrichWithNav(r.recordset);
    res.json({ data: enriched[0] });
  } catch (err) {
    console.error('GET /warehouse/sales/:id error:', err.message);
    res.status(500).json({ message: 'Failed to fetch sales row', error: err.message });
  }
});

// ── POST /api/warehouse/sales — UPSERT on (InvoiceNo, LineNumber) ──────
router.post('/', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const b = req.body || {};
    if (!b.InvoiceNo || b.LineNumber == null) {
      return res.status(400).json({ message: 'InvoiceNo and LineNumber are required' });
    }
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co',         sql.NVarChar(10),  COMPANY);
    r.input('invNo',      sql.NVarChar(50),  b.InvoiceNo);
    r.input('lineNumber', sql.Int,           Number(b.LineNumber));
    r.input('cartons',    sql.Int,           b.Cartons != null ? Number(b.Cartons) : null);
    r.input('dispThru',   sql.NVarChar(50),  b.DispatchThrough || null);
    r.input('awb',        sql.NVarChar(50),  b.AirWaybillNo || null);
    r.input('shipTerms',  sql.NVarChar(50),  b.ShipmentTerms || null);
    r.input('freight',    sql.Decimal(18,2), b.FreightCharges != null ? Number(b.FreightCharges) : null);
    r.input('local',      sql.Decimal(18,2), b.LocalCharges != null ? Number(b.LocalCharges) : null);
    r.input('dispDt',     sql.Date,          b.DispatchDate || null);
    r.input('status',     sql.NVarChar(20),  b.Status || null);
    r.input('frInv',      sql.NVarChar(100), b.FrightInvoice || null);
    r.input('permitNo',   sql.NVarChar(50),  b.PermitNo || null);
    r.input('permitType', sql.NVarChar(30),  b.ExportPermitType || null);
    r.input('gstClaim',   sql.NVarChar(20),  b.GSTClaimedMonth || null);
    r.input('remark',     sql.NVarChar(500), b.Remark || null);
    r.input('createdBy',  sql.Int,           req.user.id);

    // UPSERT: insert if not exists, else update the manual fields. We need
    // the Id of the resulting row to return to the client either way.
    const result = await r.query(`
      MERGE dbo.BN_WhSales AS tgt
      USING (SELECT @co AS Company, @invNo AS InvoiceNo, @lineNumber AS LineNumber) AS src
        ON  tgt.Company    = src.Company
        AND tgt.InvoiceNo  = src.InvoiceNo
        AND tgt.LineNumber = src.LineNumber
      WHEN MATCHED THEN UPDATE SET
        Cartons          = @cartons,
        DispatchThrough  = @dispThru,
        AirWaybillNo     = @awb,
        ShipmentTerms    = @shipTerms,
        FreightCharges   = @freight,
        LocalCharges     = @local,
        DispatchDate     = @dispDt,
        Status           = @status,
        FrightInvoice    = @frInv,
        PermitNo         = @permitNo,
        ExportPermitType = @permitType,
        GSTClaimedMonth  = @gstClaim,
        Remark           = @remark,
        IsActive         = 1,
        UpdatedAt        = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (Company, InvoiceNo, LineNumber, Cartons, DispatchThrough, AirWaybillNo,
         ShipmentTerms, FreightCharges, LocalCharges, DispatchDate,
         Status, FrightInvoice, PermitNo, ExportPermitType, GSTClaimedMonth,
         Remark, CreatedBy)
      VALUES
        (@co, @invNo, @lineNumber, @cartons, @dispThru, @awb,
         @shipTerms, @freight, @local, @dispDt,
         @status, @frInv, @permitNo, @permitType, @gstClaim,
         @remark, @createdBy)
      OUTPUT $action AS Action, INSERTED.Id AS Id;
    `);
    const out = result.recordset[0] || {};
    res.status(out.Action === 'INSERT' ? 201 : 200).json({
      ok: true, Id: out.Id, action: out.Action,
    });
  } catch (err) {
    console.error('POST /warehouse/sales error:', err.message);
    res.status(500).json({ message: 'Failed to save sales row', error: err.message });
  }
});

// ── PUT /api/warehouse/sales/:id ───────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const b = req.body || {};
    const pool = await getAppPool();
    const r = pool.request();
    r.input('id',         sql.Int,           id);
    r.input('co',         sql.NVarChar(10),  COMPANY);
    r.input('cartons',    sql.Int,           b.Cartons != null ? Number(b.Cartons) : null);
    r.input('dispThru',   sql.NVarChar(50),  b.DispatchThrough || null);
    r.input('awb',        sql.NVarChar(50),  b.AirWaybillNo || null);
    r.input('shipTerms',  sql.NVarChar(50),  b.ShipmentTerms || null);
    r.input('freight',    sql.Decimal(18,2), b.FreightCharges != null ? Number(b.FreightCharges) : null);
    r.input('local',      sql.Decimal(18,2), b.LocalCharges != null ? Number(b.LocalCharges) : null);
    r.input('dispDt',     sql.Date,          b.DispatchDate || null);
    r.input('status',     sql.NVarChar(20),  b.Status || null);
    r.input('frInv',      sql.NVarChar(100), b.FrightInvoice || null);
    r.input('permitNo',   sql.NVarChar(50),  b.PermitNo || null);
    r.input('permitType', sql.NVarChar(30),  b.ExportPermitType || null);
    r.input('gstClaim',   sql.NVarChar(20),  b.GSTClaimedMonth || null);
    r.input('remark',     sql.NVarChar(500), b.Remark || null);

    const result = await r.query(`
      UPDATE dbo.BN_WhSales SET
        Cartons = @cartons, DispatchThrough = @dispThru, AirWaybillNo = @awb,
        ShipmentTerms = @shipTerms, FreightCharges = @freight, LocalCharges = @local,
        DispatchDate = @dispDt, Status = @status, FrightInvoice = @frInv,
        PermitNo = @permitNo, ExportPermitType = @permitType,
        GSTClaimedMonth = @gstClaim, Remark = @remark, UpdatedAt = SYSDATETIME()
      WHERE Id = @id AND Company = @co;
      SELECT @@ROWCOUNT AS Updated;
    `);
    if (!result.recordset[0].Updated) return res.status(404).json({ message: 'Sales row not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /warehouse/sales/:id error:', err.message);
    res.status(500).json({ message: 'Failed to update sales row', error: err.message });
  }
});

// ── DELETE /api/warehouse/sales/:id (soft delete) ──────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const pool = await getAppPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('co', sql.NVarChar(10), COMPANY)
      .query(`
        UPDATE dbo.BN_WhSales SET IsActive = 0, UpdatedAt = SYSDATETIME()
        WHERE Id = @id AND Company = @co;
        SELECT @@ROWCOUNT AS Deleted;
      `);
    if (!result.recordset[0].Deleted) return res.status(404).json({ message: 'Sales row not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /warehouse/sales/:id error:', err.message);
    res.status(500).json({ message: 'Failed to delete sales row', error: err.message });
  }
});

// ── POST /api/warehouse/sales/import ──────────────────────────────────
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can import' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name = "file")' });
  try {
    const wb = X.xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheetName = X.resolveSheet(wb, 'sale');
    if (!sheetName) return res.status(400).json({ message: 'No Sales sheet found. Sheets: ' + wb.SheetNames.join(', ') });
    const { headers, rows } = X.readSheet(wb, sheetName);
    if (!rows.length) return res.json({ sheet: sheetName, inserted: 0, message: 'Sheet had no data rows' });

    const appPool = await getAppPool();
    const navPool = await getPool();

    let wiped = 0;
    if (req.query.wipe === '1' || req.query.wipe === 'true') {
      const w = await appPool.request().input('co', sql.NVarChar(10), COMPANY)
        .query(`UPDATE dbo.BN_WhSales SET IsActive=0 WHERE Company=@co AND IsActive=1; SELECT @@ROWCOUNT AS Wiped;`);
      wiped = w.recordset[0].Wiped || 0;
    }

    // Group rows by Invoice No → resolve Line No_ from NAV by position.
    const invByIdx = new Array(rows.length).fill(null);
    const groups = new Map();
    rows.forEach((r, i) => {
      const inv = X.toStr(X.cell(r, headers, 'Invoice No','Inv No','Invoice Number'));
      invByIdx[i] = inv;
      if (!inv) return;
      if (!groups.has(inv)) groups.set(inv, []);
      groups.get(inv).push(i);
    });
    const lineMap = new Map();
    const navHits = []; const navMisses = [];
    for (const inv of groups.keys()) {
      try {
        const nr = await navPool.request().input('inv', sql.NVarChar(50), inv).query(`
          SELECT [Line No_] FROM ${NAV_PREFIX}Sales Invoice Line]
          WHERE [Document No_] = @inv AND [Type] = 2
          ORDER BY [Line No_];`);
        const lns = nr.recordset.map(x => x['Line No_']);
        lineMap.set(inv, lns);
        if (lns.length) navHits.push(inv); else navMisses.push(inv);
      } catch (_) { lineMap.set(inv, []); navMisses.push(inv); }
    }
    const seenByInv = new Map();

    let inserted = 0; let failed = 0; const errors = [];
    let synthLineSeed = 90000;   // fallback when NAV has no line for this row
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const inv = invByIdx[i];
      if (!inv) { failed++; if (errors.length < 10) errors.push('Row ' + (i+2) + ' missing Invoice No'); continue; }
      const used = seenByInv.get(inv) || 0;
      const navLines = lineMap.get(inv) || [];
      const line = X.toInt(X.cell(r, headers, 'Line No','Line Number','Sr No'))
                || navLines[used]
                || (synthLineSeed + i);
      seenByInv.set(inv, used + 1);
      try {
        const req2 = appPool.request();
        req2.input('co',         sql.NVarChar(10),  COMPANY);
        req2.input('invNo',      sql.NVarChar(50),  inv);
        req2.input('lineNumber', sql.Int,           line);
        req2.input('cartons',    sql.Int,           X.toInt(X.cell(r, headers, 'Cartoons','Cartons','Carton Count','No of Cartons')));
        req2.input('dispThru',   sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Dispatch Through','Through','Courier')));
        req2.input('awb',        sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Air Waybill No.','Air Waybill No','AWB','AWB No')));
        req2.input('shipTerms',  sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Shipment Terms','Terms','Incoterm')));
        req2.input('freight',    sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Freight Charges','Freight','Freight Cost')));
        req2.input('local',      sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Local Charges','Local Chg')));
        req2.input('dispDt',     sql.Date,          X.toDate(X.cell(r, headers, 'Dispatch Date','Disp Date')));
        req2.input('status',     sql.NVarChar(20),  X.toStr(X.cell(r, headers, 'Status')));
        req2.input('frInv',      sql.NVarChar(100), X.toStr(X.cell(r, headers, 'Fright Invoice','Freight Invoice','FF Invoice')));
        req2.input('permitNo',   sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Permit No.','Permit No','Permit Number')));
        req2.input('permitType', sql.NVarChar(30),  X.toStr(X.cell(r, headers, 'ExportPermit/Local/  Exempt(drop Shipment)','ExportPermit/Local/ Exempt(drop Shipment)','Export Permit Type','Permit Type')));
        req2.input('gstClaim',   sql.NVarChar(20),  X.toStr(X.cell(r, headers, 'GST Clamed month','GST Claimed Month','GST Month')));
        req2.input('remark',     sql.NVarChar(500), X.toStr(X.cell(r, headers, 'Remark','Remarks','Notes')));
        req2.input('createdBy',  sql.Int,           req.user.id);
        // UPSERT (UNIQUE on Company+InvoiceNo+LineNumber). Re-importing the same
        // workbook updates rather than failing.
        await req2.query(`
          MERGE dbo.BN_WhSales AS tgt
          USING (SELECT @co AS Company, @invNo AS InvoiceNo, @lineNumber AS LineNumber) AS src
            ON  tgt.Company=src.Company AND tgt.InvoiceNo=src.InvoiceNo AND tgt.LineNumber=src.LineNumber
          WHEN MATCHED THEN UPDATE SET
            Cartons=@cartons, DispatchThrough=@dispThru, AirWaybillNo=@awb,
            ShipmentTerms=@shipTerms, FreightCharges=@freight, LocalCharges=@local,
            DispatchDate=@dispDt, Status=@status, FrightInvoice=@frInv,
            PermitNo=@permitNo, ExportPermitType=@permitType, GSTClaimedMonth=@gstClaim,
            Remark=@remark, IsActive=1, UpdatedAt=SYSDATETIME()
          WHEN NOT MATCHED THEN INSERT
            (Company, InvoiceNo, LineNumber, Cartons, DispatchThrough, AirWaybillNo,
             ShipmentTerms, FreightCharges, LocalCharges, DispatchDate,
             Status, FrightInvoice, PermitNo, ExportPermitType, GSTClaimedMonth,
             Remark, CreatedBy)
          VALUES
            (@co, @invNo, @lineNumber, @cartons, @dispThru, @awb,
             @shipTerms, @freight, @local, @dispDt,
             @status, @frInv, @permitNo, @permitType, @gstClaim,
             @remark, @createdBy);`);
        inserted++;
      } catch (e) { failed++; if (errors.length < 10) errors.push(e.message); }
    }
    res.json({
      ok: true, sheet: sheetName, inserted, failed, wiped,
      navHits: navHits.length, navMisses: navMisses.length,
      navMissedPos: navMisses.slice(0, 8),
      errors,
    });
  } catch (err) {
    console.error('POST /warehouse/sales/import error:', err.message);
    res.status(500).json({ message: 'Import failed', error: err.message });
  }
});

// ── GET /api/warehouse/sales/export ───────────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co', sql.NVarChar(10), COMPANY);
    let where = 'WHERE Company = @co AND IsActive = 1';
    if (req.query.search) {
      r.input('q', sql.NVarChar(200), '%' + req.query.search + '%');
      where += ' AND (InvoiceNo LIKE @q OR AirWaybillNo LIKE @q OR PermitNo LIKE @q OR FrightInvoice LIKE @q OR Remark LIKE @q)';
    }
    if (req.query.status && req.query.status !== 'all') {
      r.input('st', sql.NVarChar(20), req.query.status); where += ' AND Status = @st';
    }
    const rawRows = (await r.query(`
      SELECT * FROM dbo.BN_WhSales ${where} ORDER BY DispatchDate DESC, Id DESC;`)).recordset;
    const enriched = await enrichWithNav(rawRows);
    const buf = X.buildXlsx(enriched, [
      { key: 'InvoiceDate',       label: 'Invoice Date', type: 'date' },
      { key: 'InvoiceNo',         label: 'Invoice No' },
      { key: 'LineNumber',        label: 'Line No' },
      { key: 'CustomerName',      label: 'Customer' },
      { key: 'CustomerCountry',   label: 'Country' },
      { key: 'SalespersonCode',   label: 'Salesperson' },
      { key: 'ItemNo',            label: 'Item No' },
      { key: 'ItemName',          label: 'Item Name' },
      { key: 'Quantity',          label: 'Qty' },
      { key: 'UnitPrice',         label: 'Unit Price' },
      { key: 'Currency',          label: 'Currency' },
      { key: 'LineAmount',        label: 'Line Amount' },
      { key: 'GstAmount',         label: 'GST' },
      { key: 'AmountInclVAT',     label: 'Total' },
      { key: 'Cartons',           label: 'Cartons' },
      { key: 'DispatchThrough',   label: 'Dispatch Through' },
      { key: 'AirWaybillNo',      label: 'AWB' },
      { key: 'ShipmentTerms',     label: 'Shipment Terms' },
      { key: 'FreightCharges',    label: 'Freight' },
      { key: 'LocalCharges',      label: 'Local' },
      { key: 'DispatchDate',      label: 'Dispatch Date', type: 'date' },
      { key: 'Status',            label: 'Status' },
      { key: 'PermitNo',          label: 'Permit No' },
      { key: 'ExportPermitType',  label: 'Permit Type' },
      { key: 'GSTClaimedMonth',   label: 'GST Claimed Month' },
      { key: 'Remark',            label: 'Remark' },
    ], 'Sales');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Sales_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('GET /warehouse/sales/export error:', err.message);
    res.status(500).json({ message: 'Export failed', error: err.message });
  }
});

module.exports = router;
