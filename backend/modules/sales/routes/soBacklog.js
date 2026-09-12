// =====================================================================
// modules/sales/routes/soBacklog.js — UNIFIED COMPANYA + CompanyB
// Replaces backend/routes/CompanyASOBacklog.js + backend/routes/CompanyBSOBacklog.js
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const { getCompany }   = require('../../../shared/company');

router.get('/', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const P       = company.prefix;
    const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';

    // Full access = admin / operation head / director only. Heads (sales head /
    // north sales head / Sales Head Electrical / Electrical Head, etc.) and
    // sales/* roles all get codes-based scoping; head's User_Login.CompanyACode
    // already contains the team's union, so heads naturally see team data.
    const role    = (req.user.role || '').toLowerCase();
    const isAdmin = isFullAccess(req.user);
    const codes   = (req.user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);
    // Match on EITHER the Sales Header's frozen salesperson OR the Customer's
    // current salesperson. The customer-side check handles reassignment:
    // when an old SO's salesperson leaves and the customer gets reassigned in
    // NAV's Customer master, the SO Header keeps the FROZEN ex-employee code.
    // Dashboard's SO KPI (dashboard.js:26) already uses c.[Salesperson Code],
    // so this aligns the two views — was the root cause of "Dashboard shows N
    // open orders but SO Backlog list is empty" reported 2026-05-25.
    const codeList = codes.map((_, i) => `@spCode${i}`).join(',');
    const spAnd    = !isAdmin && codes.length
      ? `AND (SH.[Salesperson Code] IN (${codeList}) OR C.[Salesperson Code] IN (${codeList}))`
      : '';

    const search      = (req.query.search      || '').trim();
    const remarks     = (req.query.remarks     || '').trim();   // exact match (e.g. ?remarks=PFP)
    const remarksLike = (req.query.remarksLike || '').trim();   // CSV LIKE-OR (e.g. ?remarksLike=PWV-T,PWPR-INT,PWPR-VPD INT)
    const page    = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit   = Math.max(1, parseInt(req.query.limit || '50', 10));
    const offset  = (page - 1) * limit;

    // Date filter is OPTIONAL. SO Backlog = "every open order regardless of when
    // it was placed". Dashboard's SO Backlog KPI has no date filter, so users get
    // confused when Dashboard shows N open orders but this page filters them out
    // because they were placed before the (default) date range. Only apply the
    // filter when BOTH dates are explicitly passed; otherwise show all open orders.
    const startDate = (req.query.startDate || '').trim();
    const endDate   = (req.query.endDate   || '').trim();
    const hasDates  = !!(startDate && endDate);
    const dateClause = hasDates
      ? 'AND CAST(SH.[Order Date] AS DATE) BETWEEN @startDate AND @endDate'
      : '';

    const pool = await getPool();

    const backlogCTE = `
      WITH Inventory AS (
        SELECT ile.[Item No_] AS ItemNo,
               SUM(CAST(ISNULL(ile.[Quantity], 0) AS DECIMAL(18,4))) AS InventoryQty
        FROM ${P}Item Ledger Entry] ile
        GROUP BY ile.[Item No_]
      ),
      OpenPO AS (
        SELECT pl.[No_] AS ItemNo,
               SUM(CAST(ISNULL(pl.[Outstanding Quantity], 0) AS DECIMAL(18,4))) AS QtyOnPO,
               MAX(ph.[Buy-from Vendor Name]) AS VendorName
        FROM ${P}Purchase Line] pl
        INNER JOIN ${P}Purchase Header] ph
          ON ph.[Document Type] = pl.[Document Type] AND ph.[No_] = pl.[Document No_]
        WHERE pl.[Document Type] = 1 AND pl.[Type] = 2
          AND ISNULL(pl.[Outstanding Quantity], 0) > 0
        GROUP BY pl.[No_]
      ),
      OpenInboundLayers AS (
        SELECT ile.[Item No_] AS ItemNo, ile.[Entry No_] AS ItemLedgerEntryNo,
               CAST(ile.[Posting Date] AS DATE) AS PostingDate,
               CAST(ISNULL(ile.[Quantity], 0) AS DECIMAL(18,4)) AS InboundQty,
               CAST(ISNULL(ile.[Remaining Quantity], 0) AS DECIMAL(18,4)) AS RemainingQty,
               CAST(SUM(ISNULL(ve.[Cost Amount (Actual)], 0)) AS DECIMAL(18,4)) AS LayerTotalCost,
               CAST(CASE WHEN ABS(ISNULL(ile.[Quantity], 0)) = 0 THEN 0
                         ELSE SUM(ISNULL(ve.[Cost Amount (Actual)], 0)) / ABS(ile.[Quantity])
                    END AS DECIMAL(18,4)) AS LayerUnitCost,
               ROW_NUMBER() OVER (PARTITION BY ile.[Item No_]
                                  ORDER BY CAST(ile.[Posting Date] AS DATE), ile.[Entry No_]) AS rn
        FROM ${P}Item Ledger Entry] ile
        INNER JOIN ${P}Value Entry] ve ON ve.[Item Ledger Entry No_] = ile.[Entry No_]
        WHERE ISNULL(ile.[Quantity], 0) > 0 AND ISNULL(ile.[Remaining Quantity], 0) > 0
        GROUP BY ile.[Item No_], ile.[Entry No_], ile.[Posting Date],
                 ile.[Quantity], ile.[Remaining Quantity]
      ),
      FIFOCurrentCost AS (
        SELECT ItemNo, LayerUnitCost AS [FIFO Purchase Cost]
        FROM OpenInboundLayers WHERE rn = 1
      ),
      Backlog AS (
        SELECT
          YEAR(CAST(SH.[Order Date] AS DATE))                     AS [Year],
          DATEPART(QUARTER, CAST(SH.[Order Date] AS DATE))        AS [Quarter],
          DATENAME(MONTH, CAST(SH.[Order Date] AS DATE))          AS [Month],
          SH.[Sell-to Customer No_]                               AS [Customer ID],
          SH.[Sell-to Customer Name]                              AS [Customer],
          SH.[External Document No_]                              AS [Customer PO No.],
          -- NAV stores "no date set" as SQL Server datetime min (1753-01-01).
          -- NULLIF converts those to NULL so the frontend renders "—" instead
          -- of "01 Jan 1753". 2026-05-25 fix per user request.
          NULLIF(CAST(SH.[Order Date]                  AS DATE), '1753-01-01') AS [Customer PO Rec. Date],
          NULLIF(CAST(SH.[Document Date]               AS DATE), '1753-01-01') AS [Customer PO Date],
          NULLIF(CAST(SL.[Requested Delivery Date]     AS DATE), '1753-01-01') AS [CRD (Customer Require Date)],
          CASE WHEN CAST(SL.[Requested Delivery Date] AS DATE) <> '1753-01-01'
               THEN DATEPART(WEEK, SL.[Requested Delivery Date]) END             AS [CRD Week],
          NULLIF(CAST(SL.[Promised Delivery Date]      AS DATE), '1753-01-01') AS [Promise Delivery Date],
          NULLIF(CAST(SL.[Revised Promise Delivery Date] AS DATE), '1753-01-01') AS [Revised Promise Delivery Date],
          CASE WHEN CAST(COALESCE(NULLIF(SL.[Revised Promise Delivery Date], '1753-01-01'),
                                  NULLIF(SL.[Promised Delivery Date],         '1753-01-01')) AS DATE) IS NOT NULL
               THEN DATEPART(WEEK, COALESCE(NULLIF(SL.[Revised Promise Delivery Date], '1753-01-01'),
                                            NULLIF(SL.[Promised Delivery Date],         '1753-01-01'))) END AS [VPD Week],
          ISNULL(NULLIF(SL.[Cross-Reference No_], ''), SL.[No_]) AS [CPN],
          ISNULL(NULLIF(SL.[Description], ''), I.[Description])  AS [Item Name],
          ISNULL(NULLIF(I.[Vendor Item No_], ''), SL.[No_])      AS [MPN],
          I.[Global Dimension 2 Code]                            AS [Make],
          CAST(ISNULL(SL.[Unit Price], 0) AS DECIMAL(18,4))      AS [Unit Price],
          CAST(ISNULL(SL.[Quantity], 0) AS DECIMAL(18,4))        AS [PO Qty.],
          SL.[Unit of Measure Code]                              AS [UOM],
          CAST(ISNULL(SL.[Quantity], 0) * ISNULL(SL.[Unit Price], 0) AS DECIMAL(18,4)) AS [PO Value],
          CAST(ISNULL(SL.[Outstanding Quantity], 0) AS DECIMAL(18,4)) AS [Bal. Qty.],
          CAST(ISNULL(SL.[Outstanding Quantity], 0) * ISNULL(SL.[Unit Price], 0) AS DECIMAL(18,4)) AS [Bal. Value],
          CAST(COALESCE(FIFO.[FIFO Purchase Cost], I.[Unit Cost], SL.[Unit Cost (LCY)], 0) AS DECIMAL(18,4)) AS [Purchase Cost],
          CAST(CASE WHEN ISNULL(SL.[Reserve], 0) <> 0 THEN ISNULL(SL.[Outstanding Quantity], 0) ELSE 0 END AS DECIMAL(18,4)) AS [Reserve Qty.],
          CAST(CASE WHEN ISNULL(SL.[Reserve], 0) <> 0 THEN ISNULL(SL.[Outstanding Quantity], 0) * ISNULL(SL.[Unit Price], 0) ELSE 0 END AS DECIMAL(18,4)) AS [Reserve Qty. Value],
          CAST(ISNULL(INV.InventoryQty, 0) AS DECIMAL(18,4))     AS [Item Current Qty On Hand],
          ISNULL(SP.[Name], SH.[Salesperson Code])               AS [Sales Person],
          SH.[No_]                                               AS [SO No.],
          NULLIF(CAST(SH.[Order Date] AS DATE), '1753-01-01')    AS [SO Date],
          SH.[Posting No_]                                       AS [Posting No],
          SL.[Remarks]                                           AS [Remarks],
          SL.[Remarks 2]                                         AS [Remarks 2],
          SL.[Remarks 3]                                         AS [Remarks 3],
          SL.[Remarks 4]                                         AS [Remarks 4],
          SL.[Remarks 5]                                         AS [Remarks 5],
          SH.[Sell-to Address]                                   AS [Customer Address1],
          SH.[Sell-to Address 2]                                 AS [Customer Address2],
          SH.[Sell-to Customer Name 2]                           AS [Customer Address3],
          SH.[Sell-to City]                                      AS [Customer City],
          C.[Phone No_]                                          AS [Customer Phone No.],
          C.[E-Mail]                                             AS [Customer Email],
          C.[Home Page]                                          AS [Customer Website],
          SH.[Sell-to Contact]                                   AS [Customer Contact],
          SH.[Vertical Name]                                     AS [Vertical],
          CAST(ISNULL(PO.QtyOnPO, 0) AS DECIMAL(18,4))           AS [Qty On PO],
          SH.[Currency Code]                                     AS [Currency Code],
          PO.[VendorName]                                        AS [Vendor Name],
          SH.[User ID1]                                          AS [User ID],
          SH.[Created Date Time]                                 AS [Created Date Time],
          SH.[Modified User ID]                                  AS [Modified Header User ID],
          SH.[Modified Date Time]                                AS [Modified Header Date Time],
          SL.[Modified User ID]                                  AS [Modified Line User ID],
          SL.[Modified Date Time]                                AS [Modified Line Date Time]
        FROM ${P}Sales Header] SH
        INNER JOIN ${P}Sales Line] SL
          ON SH.[Document Type] = SL.[Document Type] AND SH.[No_] = SL.[Document No_]
        LEFT JOIN ${P}Customer] C ON C.[No_] = SH.[Sell-to Customer No_]
        LEFT JOIN ${P}Item] I ON I.[No_] = SL.[No_]
        LEFT JOIN ${P}Salesperson_Purchaser] SP ON SP.[Code] = SH.[Salesperson Code]
        LEFT JOIN Inventory INV ON INV.ItemNo = SL.[No_]
        LEFT JOIN OpenPO PO ON PO.ItemNo = SL.[No_]
        LEFT JOIN FIFOCurrentCost FIFO ON FIFO.ItemNo = SL.[No_]
        WHERE SH.[Document Type] = 1 AND SL.[Type] = 2
          AND ISNULL(SL.[Outstanding Quantity], 0) > 0
          ${dateClause}
          ${spAnd}
      )
    `;

    // Build WHERE filters: search across name/SO/customer + optional Remarks.
    //   ?remarks=PFP                            → exact match
    //   ?remarksLike=PWV-T,PWPR-INT,PWPR-VPD INT  → CSV; each becomes a
    //                                                 [Remarks] LIKE '%token%'
    //                                                 OR'd together. Used by
    //                                                 the warehouse "In Transit
    //                                                 material" card.
    const remarksLikeTokens = remarksLike
      ? remarksLike.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const conditions = [];
    if (search)  conditions.push(`(
      ISNULL([Sales Person], '') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
      OR [SO No.] COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
      OR ISNULL([Customer], '') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
      OR ISNULL([Customer ID], '') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
    )`);
    if (remarks) conditions.push(`ISNULL([Remarks], '') COLLATE SQL_Latin1_General_CP1_CI_AS = @remarks`);
    if (remarksLikeTokens.length) {
      const ors = remarksLikeTokens
        .map((_, i) => `ISNULL([Remarks], '') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @remarksLike${i}`)
        .join(' OR ');
      conditions.push('(' + ors + ')');
    }
    const searchClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countReq = pool.request()
      .input('search',    sql.NVarChar, `%${search}%`)
      .input('remarks',   sql.NVarChar, remarks);
    remarksLikeTokens.forEach((t, i) => countReq.input('remarksLike' + i, sql.NVarChar, '%' + t + '%'));
    if (hasDates) {
      countReq.input('startDate', sql.Date, new Date(startDate));
      countReq.input('endDate',   sql.Date, new Date(endDate));
    }
    codes.forEach((c, i) => countReq.input(`spCode${i}`, sql.NVarChar, c));

    const countResult = await countReq.query(
      backlogCTE + ` SELECT COUNT(*) AS Total FROM Backlog ` + searchClause
    );

    const dataReq = pool.request()
      .input('search',    sql.NVarChar, `%${search}%`)
      .input('remarks',   sql.NVarChar, remarks)
      .input('offset',    sql.Int,      offset)
      .input('limit',     sql.Int,      limit);
    remarksLikeTokens.forEach((t, i) => dataReq.input('remarksLike' + i, sql.NVarChar, '%' + t + '%'));
    if (hasDates) {
      dataReq.input('startDate', sql.Date, new Date(startDate));
      dataReq.input('endDate',   sql.Date, new Date(endDate));
    }
    codes.forEach((c, i) => dataReq.input(`spCode${i}`, sql.NVarChar, c));

    const dataResult = await dataReq.query(
      backlogCTE +
      ` SELECT * FROM Backlog ` + searchClause +
      ` ORDER BY [SO Date], [SO No.] OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
    );

    res.json({
      total: countResult.recordset[0]?.Total || 0,
      page, limit,
      startDate: hasDates ? startDate : '',
      endDate:   hasDates ? endDate   : '',
      data: dataResult.recordset || [],
      currency: company.currency,
      symbol:   company.symbol,
      company:  company.code,
    });

  } catch (err) {
    console.error('SO Backlog error:', err.message);
    res.status(500).json({ message: 'Failed to load SO Backlog', error: err.message });
  }
});

module.exports = router;
