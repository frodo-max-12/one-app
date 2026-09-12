// =====================================================================
// modules/sales/routes/billing.js — UNIFIED COMPANYA + CompanyB
// Replaces backend/routes/CompanyABilling.js + backend/routes/CompanyBBilling.js
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
    const companyLabel = company.label;

    // Full access = admin / operation head / director only. Heads (sales head /
    // north sales head / Sales Head Electrical / Electrical Head, etc.) and
    // sales/* roles all get codes-based scoping; head's User_Login.CompanyACode
    // already contains the team's union, so heads naturally see team data.
    const role    = (req.user.role || '').toLowerCase();
    const isAdmin = isFullAccess(req.user);
    const codes   = (req.user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);
    const spParam = codes.map((_, i) => `@spCode${i}`).join(',');
    const spAnd   = !isAdmin && codes.length
      ? `AND SIH.[Salesperson Code] IN (${spParam})`
      : '';

    const search = (req.query.search || '').trim();
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.max(1, parseInt(req.query.limit || '50', 10));
    const offset = (page - 1) * limit;

    const today        = new Date();
    const defaultFrom  = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    const defaultTo    = today.toISOString().slice(0, 10);
    const fromDate     = req.query.fromDate || defaultFrom;
    const toDate       = req.query.toDate   || defaultTo;

    const pool = await getPool();
    const r    = pool.request();
    r.input('fromDate', sql.Date,     new Date(fromDate));
    r.input('toDate',   sql.Date,     new Date(toDate));
    r.input('search',   sql.NVarChar, `%${search}%`);
    r.input('offset',   sql.Int,      offset);
    r.input('limit',    sql.Int,      limit);
    codes.forEach((c, i) => r.input(`spCode${i}`, sql.NVarChar, c));

    // Drop fully-returned lines (NetQty netted to 0) so a returned item / fully-returned
    // invoice disappears from billing; combine with the search filter when present.
    const outerSearch = search ? `
      WHERE [Ship Quantity] > 0 AND (
           ISNULL([Invoice No.], '')      COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
        OR ISNULL([Customer Name], '')    COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
        OR ISNULL([Customer], '')         COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
        OR ISNULL([SO No.], '')           COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
        OR ISNULL([Customer PO No.], '')  COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
      )` : 'WHERE [Ship Quantity] > 0';

    const query = `
      ;WITH ValidHeaders AS (
        SELECT
          SIH.[No_]                         AS InvoiceNo,
          SIH.[Sell-to Customer No_]        AS SellToCustomerNo,
          SIH.[Bill-to Customer No_]        AS BillToCustomerNo,
          SIH.[Bill-to Name]                AS BillToName,
          SIH.[Bill-to Country_Region Code] AS BillToCountryCode,
          SIH.[Posting Date]                AS PostingDate,
          SIH.[Document Date]               AS DocumentDate,
          SIH.[External Document No_]       AS ExternalDocumentNo,
          SIH.[Order No_]                   AS OrderNo,
          SIH.[Air Waybill No__Docket no_]  AS AirWaybillNo,
          SIH.[Currency Code]               AS CurrencyCode,
          SIH.[Salesperson Code]            AS SalespersonCode,
          SIH.[Created DateTime]            AS CreatedDateTime,
          SIH.[Posted By UserID]            AS PostedByUserID
        FROM ${P}Sales Invoice Header] SIH
        WHERE CAST(SIH.[Posting Date] AS DATE) BETWEEN @fromDate AND @toDate
          ${spAnd}
      ),
      -- Returned qty per (invoice, item) from ALL credit memos applied to the invoice.
      -- Used to NET the returned quantity out of the billing (2026-08-12). The old
      -- "NOT EXISTS a credit memo → drop the whole invoice" erased an entire invoice for
      -- even a 1-item partial return (e.g. a ₹604 return wiped a ₹94k invoice). We now
      -- subtract the returned qty per line instead. Matched by ITEM No_ (credit-memo line
      -- numbers do NOT align with invoice line numbers — only ~3% match — so a line-no
      -- join would be wrong); a full return zeroes every line and the invoice drops out.
      ReturnAgg AS (
        SELECT SCMH.[Applies-to Doc_ No_] AS InvoiceNo, SCML.[No_] AS ItemNo,
               SUM(CAST(ISNULL(SCML.[Quantity],0) AS DECIMAL(18,4))) AS ReturnedQty
        FROM ${P}Sales Cr_Memo Line] SCML
        INNER JOIN ${P}Sales Cr_Memo Header] SCMH ON SCMH.[No_] = SCML.[Document No_]
        WHERE ISNULL(SCMH.[Applies-to Doc_ No_],'') <> '' AND ISNULL(SCML.[Type],0) = 2
        GROUP BY SCMH.[Applies-to Doc_ No_], SCML.[No_]
      ),
      BaseLines AS (
        SELECT
          VIH.InvoiceNo, SIL.[Line No_] AS InvoiceLineNo,
          CAST(VIH.PostingDate AS DATE) AS InvoiceDate,
          CASE WHEN MONTH(VIH.PostingDate) >= 4 THEN YEAR(VIH.PostingDate) + 1 ELSE YEAR(VIH.PostingDate) END  AS FiscalYear,
          CASE WHEN MONTH(VIH.PostingDate) IN (4,5,6) THEN 1
               WHEN MONTH(VIH.PostingDate) IN (7,8,9) THEN 2
               WHEN MONTH(VIH.PostingDate) IN (10,11,12) THEN 3
               ELSE 4 END                      AS FiscalQuarterNo,
          CONCAT(YEAR(VIH.PostingDate),'-',MONTH(VIH.PostingDate)) AS FiscalMonth,
          VIH.SellToCustomerNo, VIH.BillToCustomerNo, VIH.BillToName, VIH.BillToCountryCode,
          VIH.DocumentDate, VIH.ExternalDocumentNo, VIH.OrderNo, VIH.AirWaybillNo,
          VIH.CurrencyCode, VIH.SalespersonCode, VIH.CreatedDateTime, VIH.PostedByUserID,
          SIL.[Document No_] AS DocumentNo, SIL.[No_] AS ItemNo,
          SIL.[Description] AS LineDescription, SIL.[Quantity] AS Quantity,
          SIL.[Unit Price] AS UnitPrice, SIL.[Dispatch Through] AS DispatchThrough,
          CAST(SIL.[Posting Date] AS DATE) AS LinePostingDate,
          SIL.[Dimension Set ID] AS DimensionSetID,
          SIL.[Remarks] AS RemarksCode,
          -- Running qty of PRIOR lines of the same item in this invoice, so a returned
          -- qty distributes across same-item lines in line order (110 invoices repeat an item).
          ISNULL(SUM(CAST(ISNULL(SIL.[Quantity],0) AS DECIMAL(18,4)))
                 OVER (PARTITION BY VIH.InvoiceNo, SIL.[No_] ORDER BY SIL.[Line No_]
                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS QtyBefore
        FROM ValidHeaders VIH
        INNER JOIN ${P}Sales Invoice Line] SIL ON VIH.InvoiceNo = SIL.[Document No_]
        WHERE ISNULL(SIL.[Type], 0) = 2
      ),
      ChargeAgg AS (
        SELECT VE.[Document No_] AS DocumentNo, VE.[Item No_] AS ItemNo,
               SUM(CAST(ISNULL(VE.[Sales Amount (Actual)], 0) AS DECIMAL(18,4))) AS ChargeAmount
        FROM ${P}Value Entry] VE
        INNER JOIN BaseLines B ON B.DocumentNo = VE.[Document No_] AND B.ItemNo = VE.[Item No_]
        WHERE ISNULL(VE.[Item Charge No_], '') <> ''
        GROUP BY VE.[Document No_], VE.[Item No_]
      ),
      CostAgg AS (
        SELECT VE.[Document No_] AS DocumentNo, VE.[Item No_] AS ItemNo,
               VE.[Posting Date] AS PostingDate, VE.[Document Line No_] AS DocumentLineNo,
               SUM(CAST(ISNULL(VE.[Cost Amount (Actual)], 0) AS DECIMAL(18,4))) AS CostAmountActual
        FROM ${P}Value Entry] VE
        INNER JOIN BaseLines B ON B.DocumentNo = VE.[Document No_] AND B.ItemNo = VE.[Item No_]
          AND B.LinePostingDate = CAST(VE.[Posting Date] AS DATE)
          AND B.InvoiceLineNo = VE.[Document Line No_]
        GROUP BY VE.[Document No_], VE.[Item No_], VE.[Posting Date], VE.[Document Line No_]
      ),
      Dims AS (
        SELECT DSE.[Dimension Set ID] AS DimensionSetID,
          MAX(CASE WHEN DSE.[Dimension Code] = 'REGION'       THEN DSE.[Dimension Value Code] END) AS Region,
          MAX(CASE WHEN DSE.[Dimension Code] = 'BR'           THEN DSE.[Dimension Value Code] END) AS Branch,
          MAX(CASE WHEN DSE.[Dimension Code] = 'COMPANYA VERTICAL' THEN DSE.[Dimension Value Code] END) AS Vertical,
          MAX(CASE WHEN DSE.[Dimension Code] = 'SEGMENT'      THEN DSE.[Dimension Value Code] END) AS Segment,
          MAX(CASE WHEN DSE.[Dimension Code] = 'SUBSEGMENT'   THEN DSE.[Dimension Value Code] END) AS SubSegment,
          MAX(CASE WHEN DSE.[Dimension Code] IN ('BRANDS','BRAND') THEN DSE.[Dimension Value Code] END) AS Brand
        FROM ${P}Dimension Set Entry] DSE
        INNER JOIN (SELECT DISTINCT DimensionSetID FROM BaseLines) X ON X.DimensionSetID = DSE.[Dimension Set ID]
        GROUP BY DSE.[Dimension Set ID]
      ),
      PurchaseLink AS (
        SELECT B.InvoiceNo, B.InvoiceLineNo,
               MAX(PL.[Document No_]) AS PurchDocumentNo, MAX(PL.[Document Type]) AS PurchDocumentType
        FROM BaseLines B
        LEFT JOIN ${P}Purchase Line] PL
          ON PL.[Custom Sales Order No_] = B.OrderNo AND PL.[Custom Sales Order Line No_] = B.InvoiceLineNo
        GROUP BY B.InvoiceNo, B.InvoiceLineNo
      ),
      NetLines AS (
        -- NetQty = invoice line qty minus the portion of this item's returned qty that
        -- falls on this line (QtyBefore distributes the return across same-item lines).
        SELECT B.*,
          CAST(B.Quantity - CASE
            WHEN ISNULL(RA.ReturnedQty,0) - B.QtyBefore <= 0          THEN 0
            WHEN ISNULL(RA.ReturnedQty,0) - B.QtyBefore >= B.Quantity THEN B.Quantity
            ELSE ISNULL(RA.ReturnedQty,0) - B.QtyBefore END AS DECIMAL(18,4)) AS NetQty
        FROM BaseLines B
        LEFT JOIN ReturnAgg RA ON RA.InvoiceNo = B.InvoiceNo AND RA.ItemNo = B.ItemNo
      ),
      Final AS (
        SELECT
          B.FiscalYear AS [Year],
          CONCAT(B.FiscalYear,'-',B.FiscalQuarterNo) AS [Quarter],
          B.FiscalMonth AS [Month],
          B.InvoiceDate AS [Invoice Date],
          CASE WHEN SSH.[Requested Delivery Date] IS NULL OR CAST(SSH.[Requested Delivery Date] AS DATE) = '1753-01-01' THEN NULL
               ELSE CAST(SSH.[Requested Delivery Date] AS DATE) END AS [CRD (Customer Require Date)],
          CASE WHEN SSH.[Promised Delivery Date] IS NULL OR CAST(SSH.[Promised Delivery Date] AS DATE) = '1753-01-01' THEN NULL
               ELSE CAST(SSH.[Promised Delivery Date] AS DATE) END AS [Promise Delivery Date],
          CASE WHEN SSH.[Revised Promise Delivery Date] IS NULL OR CAST(SSH.[Revised Promise Delivery Date] AS DATE) = '1753-01-01' THEN NULL
               ELSE CAST(SSH.[Revised Promise Delivery Date] AS DATE) END AS [Revised Promise Delivery Date],
          CASE WHEN PH.[Posting Date] IS NULL OR CAST(PH.[Posting Date] AS DATE) = '1753-01-01' THEN NULL
               ELSE CAST(PH.[Posting Date] AS DATE) END AS [Inword Date (DPK Purchase)],
          CASE WHEN SSH.[Revised Promise Delivery Date] IS NOT NULL AND CAST(SSH.[Revised Promise Delivery Date] AS DATE) <> '1753-01-01'
               THEN DATEDIFF(DAY, B.InvoiceDate, CAST(SSH.[Revised Promise Delivery Date] AS DATE))
               ELSE NULL END AS [Store to dispatch],
          CASE WHEN SSH.[Requested Delivery Date] IS NOT NULL AND CAST(SSH.[Requested Delivery Date] AS DATE) <> '1753-01-01'
               THEN DATEDIFF(DAY, B.InvoiceDate, CAST(SSH.[Requested Delivery Date] AS DATE))
               ELSE NULL END AS [Total Time],
          CASE WHEN SSH.[Requested Delivery Date] IS NOT NULL AND CAST(SSH.[Requested Delivery Date] AS DATE) <> '1753-01-01'
                AND SSH.[Revised Promise Delivery Date] IS NOT NULL AND CAST(SSH.[Revised Promise Delivery Date] AS DATE) <> '1753-01-01'
               THEN DATEDIFF(DAY, CAST(SSH.[Requested Delivery Date] AS DATE), CAST(SSH.[Revised Promise Delivery Date] AS DATE))
               ELSE NULL END AS [Vendor Commi. Gap],
          CASE WHEN SSH.[Revised Promise Delivery Date] IS NOT NULL AND CAST(SSH.[Revised Promise Delivery Date] AS DATE) <> '1753-01-01'
                AND SSH.[Promised Delivery Date] IS NOT NULL AND CAST(SSH.[Promised Delivery Date] AS DATE) <> '1753-01-01'
               THEN DATEDIFF(DAY, CAST(SSH.[Revised Promise Delivery Date] AS DATE), CAST(SSH.[Promised Delivery Date] AS DATE))
               ELSE NULL END AS [Purchase Response Time],
          B.InvoiceNo                           AS [Invoice No.],
          CR.[Name]                             AS [Country],
          D.Region                              AS [Region],
          D.Branch                              AS [Branch],
          SP.[Name]                             AS [FSR],
          B.BillToName                          AS [Customer Name],
          B.BillToCustomerNo                    AS [Customer],
          D.Vertical                            AS [Vertical],
          D.Segment                             AS [Segment],
          D.SubSegment                          AS [Sub Segment],
          B.CurrencyCode                        AS [Currency],
          B.ExternalDocumentNo                  AS [Customer PO No.],
          CAST(B.DocumentDate AS DATE)          AS [Customer PO Date],
          B.OrderNo                             AS [SO No.],
          B.AirWaybillNo                        AS [Air Waybill No./Docket no.],
          B.DispatchThrough                     AS [Dispatch Through],
          '${companyLabel}'                     AS [Company],
          ICR.[Cross-Reference No_]             AS [Customer Part No.],
          IT.[Vendor Item No_]                  AS [MPN],
          B.LineDescription                     AS [Description],
          COALESCE(D.Brand, IT.[Manufacturer Code]) AS [Make],
          CAST(ISNULL(B.NetQty,0) AS DECIMAL(18,4))                            AS [Ship Quantity],
          CAST(ISNULL(B.UnitPrice,0) AS DECIMAL(18,4))                         AS [Unit Resale],
          CAST(ISNULL(B.UnitPrice,0) * ISNULL(B.NetQty,0) AS DECIMAL(18,4))    AS [Extn Resale],
          CAST(ISNULL(CA.ChargeAmount,0)     * CASE WHEN ISNULL(B.Quantity,0)=0 THEN 0 ELSE B.NetQty/B.Quantity END AS DECIMAL(18,4)) AS [Charge Amount],
          CAST(ISNULL(COA.CostAmountActual,0) * CASE WHEN ISNULL(B.Quantity,0)=0 THEN 0 ELSE B.NetQty/B.Quantity END AS DECIMAL(18,4)) AS [Unit Cost],
          IT.[Base Unit of Measure]             AS [Basic Unit],
          RT.[Remarks Description]              AS [Remarks],
          IT.[Inventory Posting Group]          AS [Inventory Posting Group],
          CAST(NULL AS NVARCHAR(100))           AS [IRN No.],
          CUST.[GST Registration No_]           AS [Customer GSTN No.],
          B.CreatedDateTime                     AS [Posted Invoice by CSR Date & Time],
          B.PostedByUserID                      AS [Posted Invoice by CSR Name]
        FROM NetLines B
        LEFT JOIN ${P}Sales Shipment Line] SSH ON SSH.[Order No_] = B.OrderNo AND SSH.[Order Line No_] = B.InvoiceLineNo
        LEFT JOIN PurchaseLink PLK ON PLK.InvoiceNo = B.InvoiceNo AND PLK.InvoiceLineNo = B.InvoiceLineNo
        LEFT JOIN ${P}Purchase Header] PH ON PH.[Document Type] = PLK.PurchDocumentType AND PH.[No_] = PLK.PurchDocumentNo
        LEFT JOIN ${P}Country_Region] CR ON CR.[Code] = B.BillToCountryCode
        LEFT JOIN ${P}Salesperson_Purchaser] SP ON SP.[Code] = B.SalespersonCode
        LEFT JOIN ${P}Customer] CUST ON CUST.[No_] = B.SellToCustomerNo
        LEFT JOIN ${P}Item] IT ON IT.[No_] = B.ItemNo
        LEFT JOIN ${P}Item Cross Reference] ICR ON ICR.[Item No_] = B.ItemNo AND ICR.[Cross-Reference Type No_] = B.SellToCustomerNo
        LEFT JOIN ChargeAgg CA ON CA.DocumentNo = B.DocumentNo AND CA.ItemNo = B.ItemNo
        LEFT JOIN CostAgg COA ON COA.DocumentNo = B.DocumentNo AND COA.ItemNo = B.ItemNo
          AND COA.PostingDate = B.LinePostingDate AND COA.DocumentLineNo = B.InvoiceLineNo
        LEFT JOIN Dims D ON D.DimensionSetID = B.DimensionSetID
        LEFT JOIN ${P}Remarks Table] RT ON RT.[Remarks Code] = B.RemarksCode
      )
      SELECT
        COUNT(*) OVER ()                            AS TotalCount,
        CAST(SUM([Extn Resale])    OVER () AS DECIMAL(18,4)) AS TotalExtnResale,
        CAST(SUM([Unit Cost])      OVER () AS DECIMAL(18,4)) AS TotalUnitCost,
        CAST(SUM([Charge Amount])  OVER () AS DECIMAL(18,4)) AS TotalChargeAmount,
        CAST(SUM([Ship Quantity])  OVER () AS DECIMAL(18,4)) AS TotalShipQuantity,
        [Year],[Quarter],[Month],[Invoice Date],
        [CRD (Customer Require Date)],[Promise Delivery Date],[Revised Promise Delivery Date],
        [Inword Date (DPK Purchase)],[Store to dispatch],[Total Time],[Vendor Commi. Gap],[Purchase Response Time],
        [Invoice No.],[Country],[Region],[Branch],[FSR],[Customer Name],[Customer],
        [Vertical],[Segment],[Sub Segment],[Currency],[Customer PO No.],[Customer PO Date],
        [SO No.],[Air Waybill No./Docket no.],[Dispatch Through],[Company],
        [Customer Part No.],[MPN],[Description],[Make],
        [Ship Quantity],[Unit Resale],[Extn Resale],[Charge Amount],[Unit Cost],
        [Basic Unit],[Remarks],[Inventory Posting Group],[IRN No.],
        [Customer GSTN No.],[Posted Invoice by CSR Date & Time],[Posted Invoice by CSR Name]
      FROM Final
      ${outerSearch}
      ORDER BY [Invoice Date], [Invoice No.]
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const result = await r.query(query);
    const total  = result.recordset[0]?.TotalCount || 0;
    const totals = {
      ExtnResale:    Number(result.recordset[0]?.TotalExtnResale    || 0),
      UnitCost:      Number(result.recordset[0]?.TotalUnitCost      || 0),
      ChargeAmount:  Number(result.recordset[0]?.TotalChargeAmount  || 0),
      ShipQuantity:  Number(result.recordset[0]?.TotalShipQuantity  || 0),
    };

    res.json({
      total, page, limit, fromDate, toDate, totals,
      data: result.recordset || [],
      currency: company.currency,
      symbol:   company.symbol,
      company:  company.code,
    });

  } catch (err) {
    console.error('Billing error:', err.message);
    res.status(500).json({ message: 'Failed to load Billing', error: err.message });
  }
});

module.exports = router;
