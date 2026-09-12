// =====================================================================
// modules/sales/routes/inventory.js — UNIFIED COMPANYA + CompanyB
// Replaces backend/routes/CompanyAInventory.js + backend/routes/CompanyBInventory.js
//
// Note: standardized on "Brand" column alias (was "Make" in COMPANYA, "Brand" in
// CompanyB). Frontend should use response.data[i].Brand uniformly. The legacy
// COMPANYA-specific "Electronics Components" description exclusion is applied
// only for company=COMPANYA.
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const { getCompany }   = require('../../../shared/company');

router.get('/', authenticate, async (req, res) => {
  try {
    const company  = getCompany(req);
    const P        = company.prefix;
    const isCompanyA    = company.code === 'COMPANYA';

    const mode     = (req.query.mode || 'total').trim();
    const search   = (req.query.search   || '').trim();
    const asOnDate = (req.query.asOnDate || '').trim() || null;
    const page     = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit    = Math.max(1, parseInt(req.query.limit || '50', 10));
    const offset   = (page - 1) * limit;

    const pool = await getPool();

    if (mode === 'soInventory') {
      return await handleSOInventory(req, res, pool, company, { search, asOnDate, page, limit, offset });
    }

    const openInvFilter = (mode === 'openInventory')
      ? "AND ISNULL(itm.[Remarks 1], '') LIKE '%OILP%'"
      : '';

    const companyaExclusion = isCompanyA
      ? "AND NOT (ISNULL(itm.[Description], '') = 'Electronics Components')"
      : '';

    const inventoryCTE =
      "WITH ValueByILE AS (\n" +
      "  SELECT ve.[Item Ledger Entry No_] AS ILEntryNo,\n" +
      "         SUM(CAST(ISNULL(ve.[Cost Amount (Actual)], 0) AS DECIMAL(18,4))) AS CostAmountActual\n" +
      "  FROM " + P + "Value Entry] ve\n" +
      "  GROUP BY ve.[Item Ledger Entry No_]\n" +
      "),\n" +
      "OpenLayers AS (\n" +
      "  SELECT\n" +
      "    ile.[Item No_]                       AS [Item No.],\n" +
      "    itm.[Vendor Item No_]                AS [Vendor Item No.],\n" +
      "    itm.[Global Dimension 2 Code]        AS [Brand],\n" +
      "    itm.[Description]                    AS [Item Description],\n" +
      "    CAST(ISNULL(ile.[Remaining Quantity], 0) AS DECIMAL(18,4)) AS [Quantity],\n" +
      "    itm.[Remarks 1]                      AS [Remarks 1]\n" +
      "  FROM " + P + "Item Ledger Entry] ile\n" +
      "  INNER JOIN " + P + "Item] itm ON itm.[No_] = ile.[Item No_]\n" +
      "  LEFT JOIN ValueByILE v ON v.ILEntryNo = ile.[Entry No_]\n" +
      "  WHERE ISNULL(ile.[Remaining Quantity], 0) > 0\n" +
      "    AND ISNULL(ile.[Quantity], 0) > 0\n" +
      "    AND ile.[Posting Date] <= @asOnDate\n" +
      "    " + companyaExclusion + "\n" +
      "    " + openInvFilter + "\n" +
      "),\n" +
      "Aggregated AS (\n" +
      "  SELECT [Item No.], [Vendor Item No.], [Brand], [Item Description],\n" +
      "         SUM([Quantity]) AS [Quantity], MAX([Remarks 1]) AS [Remarks 1]\n" +
      "  FROM OpenLayers\n" +
      "  GROUP BY [Item No.], [Vendor Item No.], [Brand], [Item Description]\n" +
      ")\n";

    const searchClause = search
      ? "WHERE ([Item No.] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
        " OR [Vendor Item No.] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
        " OR [Brand] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
        " OR [Item Description] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
        " OR ISNULL([Remarks 1], '') LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS)"
      : '';

    const countResult = await pool.request()
      .input('asOnDate', sql.Date, asOnDate ? new Date(asOnDate) : new Date())
      .input('search',   sql.NVarChar, '%' + search + '%')
      .query(inventoryCTE + "SELECT COUNT(*) AS Total FROM Aggregated\n" + searchClause);

    const dataResult = await pool.request()
      .input('asOnDate', sql.Date, asOnDate ? new Date(asOnDate) : new Date())
      .input('search',   sql.NVarChar, '%' + search + '%')
      .input('offset',   sql.Int,      offset)
      .input('limit',    sql.Int,      limit)
      .query(
        inventoryCTE +
        "SELECT [Item No.], [Vendor Item No.], [Brand], [Item Description], [Quantity], [Remarks 1]" +
        "\nFROM Aggregated\n" + searchClause +
        "\nORDER BY [Item No.]" +
        "\nOFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY"
      );

    return res.json({
      total: countResult.recordset[0]?.Total || 0,
      page, limit,
      data: dataResult.recordset || [],
      currency: company.currency,
      symbol:   company.symbol,
      company:  company.code,
    });

  } catch (err) {
    console.error('Inventory error:', err.message);
    res.status(500).json({ message: 'Failed to load inventory', error: err.message });
  }
});

// ── SO Inventory handler ──────────────────────────────────────────────
async function handleSOInventory(req, res, pool, company, opts) {
  const { search, asOnDate, page, limit, offset } = opts;
  const P        = company.prefix;
  const codeCol  = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';
  // Full access = admin / operation head / director only. Heads (sales head /
  // north sales head / Sales Head Electrical / Electrical Head, etc.) and
  // sales/* roles all get codes-based scoping; head's User_Login.CompanyACode
  // already contains the team's union, so heads naturally see team data.
  const userRole = (req.user.role || '').toLowerCase();
  const isAdmin  = isFullAccess(req.user);

  let spFilter = '';
  let spCodes  = [];

  if (!isAdmin) {
    spCodes = (req.user[codeCol] || '').split('/').map(c => c.trim()).filter(Boolean);
    if (!spCodes.length) {
      return res.json({ total: 0, page, limit, data: [], currency: company.currency, company: company.code });
    }
    const inList = spCodes.map((_, i) => '@sp' + i).join(',');
    spFilter = 'AND h.[Salesperson Code] IN (' + inList + ')';
  }

  const soCTE = "\n" +
    "WITH SalesLines_Sales AS (\n" +
    "  SELECT CAST(h.[Posting Date] AS DATE) AS SalePostingDate,\n" +
    "         h.[Salesperson Code]           AS SalespersonCode,\n" +
    "         ISNULL(sp.[Name], h.[Salesperson Code]) AS SalespersonName,\n" +
    "         UPPER(LTRIM(RTRIM(l.[No_])))   AS ItemNo,\n" +
    "         l.[Document No_]               AS SalesDocNo,\n" +
    "         l.[Remarks]                    AS Remarks,\n" +
    "         CAST(ISNULL(l.[Quantity],0) AS DECIMAL(18,4)) AS SaleQty,\n" +
    "         CAST(ISNULL(l.[Unit Price],0) AS DECIMAL(18,4)) AS UnitPrice,\n" +
    "         CAST(ISNULL(l.[Amount],0) AS DECIMAL(18,4)) AS LineAmount\n" +
    "  FROM " + P + "Sales Header] h\n" +
    "  INNER JOIN " + P + "Sales Line] l ON l.[Document No_] = h.[No_]\n" +
    "  LEFT JOIN " + P + "Salesperson_Purchaser] sp ON sp.[Code] = h.[Salesperson Code]\n" +
    "  WHERE CAST(h.[Posting Date] AS DATE) <= @asOnDate\n" +
    "    AND ISNULL(h.[Salesperson Code],'') <> ''\n" +
    "    " + spFilter + "\n" +
    "    AND TRY_CAST(l.[Quantity] AS DECIMAL(18,4)) IS NOT NULL\n" +
    "    AND ISNULL(l.[No_],'') <> ''\n" +
    "    AND ISNULL(l.[Remarks],'') LIKE '%EX%'\n" +
    "    AND ISNULL(l.[Description],'') NOT IN ('Invoice Round Account','Freight,Transport and Courier charges Indirect')\n" +
    "),\n" +
    "InvFromSalesLines_Sales AS (\n" +
    "  SELECT sl.SalespersonCode, sl.SalespersonName, sl.ItemNo, sl.SalesDocNo, sl.Remarks,\n" +
    "         ISNULL(sl.SaleQty,0) AS SaleQty,\n" +
    "         CAST(CASE WHEN ISNULL(sl.LineAmount,0) <> 0 THEN sl.LineAmount\n" +
    "                   ELSE ISNULL(sl.SaleQty,0) * ISNULL(sl.UnitPrice,0) END AS DECIMAL(18,4)) AS LineValue\n" +
    "  FROM SalesLines_Sales sl\n" +
    "  WHERE ISNULL(sl.SaleQty,0) <> 0\n" +
    "),\n" +
    "InvBySalesperson AS (\n" +
    "  SELECT i.SalespersonCode, i.SalespersonName, i.ItemNo, i.SalesDocNo, i.Remarks,\n" +
    "         SUM(i.SaleQty) AS Quantity, SUM(i.LineValue) AS TotalValue\n" +
    "  FROM InvFromSalesLines_Sales i\n" +
    "  GROUP BY i.SalespersonCode, i.SalespersonName, i.ItemNo, i.SalesDocNo, i.Remarks\n" +
    "),\n" +
    "Final AS (\n" +
    "  SELECT ibs.SalespersonName               AS [Salesperson Code],\n" +
    "         ibs.ItemNo                        AS [Item No.],\n" +
    "         itm.[Vendor Item No_]             AS [Vendor Item No.],\n" +
    "         itm.[Global Dimension 2 Code]     AS [Brand],\n" +
    "         itm.[Description]                 AS [Item Description],\n" +
    "         ibs.SalesDocNo                    AS [SO No.],\n" +
    "         CAST(ibs.Quantity AS DECIMAL(18,4))    AS [Quantity],\n" +
    "         CAST(CASE WHEN NULLIF(ibs.Quantity,0) IS NULL THEN 0\n" +
    "                   ELSE ibs.TotalValue / NULLIF(ibs.Quantity,0) END AS DECIMAL(18,4)) AS [Unit Value],\n" +
    "         CAST(ibs.TotalValue AS DECIMAL(18,4))  AS [Total Value],\n" +
    "         ibs.Remarks                       AS [Remarks 1]\n" +
    "  FROM InvBySalesperson ibs\n" +
    "  INNER JOIN " + P + "Item] itm ON itm.[No_] = ibs.ItemNo\n" +
    "  WHERE ibs.Quantity <> 0\n" +
    ")\n";

  const searchClause = search
    ? "WHERE ([Item No.] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
      " OR [Vendor Item No.] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
      " OR [Brand] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
      " OR [Item Description] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
      " OR [Salesperson Code] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
      " OR [SO No.] LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS" +
      " OR ISNULL([Remarks 1], '') LIKE @search COLLATE SQL_Latin1_General_CP1_CI_AS)"
    : '';

  function buildRequest() {
    const r = pool.request()
      .input('asOnDate', sql.Date, asOnDate ? new Date(asOnDate) : new Date())
      .input('search',   sql.NVarChar, '%' + search + '%');
    spCodes.forEach((code, i) => r.input('sp' + i, sql.NVarChar, code));
    return r;
  }

  const countResult = await buildRequest()
    .query(soCTE + "SELECT COUNT(*) AS Total FROM Final\n" + searchClause);

  const dataResult = await buildRequest()
    .input('offset', sql.Int, offset)
    .input('limit',  sql.Int, limit)
    .query(
      soCTE +
      "SELECT [Salesperson Code], [Item No.], [Vendor Item No.], [Brand], [Item Description]," +
      " [SO No.], [Quantity], [Unit Value], [Total Value], [Remarks 1]" +
      " FROM Final\n" + searchClause +
      "\nORDER BY [Salesperson Code], [Item No.], [SO No.]" +
      "\nOFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY"
    );

  return res.json({
    total: countResult.recordset[0]?.Total || 0,
    page, limit,
    data: dataResult.recordset || [],
    currency: company.currency,
    symbol:   company.symbol,
    company:  company.code,
  });
}

module.exports = router;
