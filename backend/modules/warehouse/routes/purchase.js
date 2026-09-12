// =====================================================================
// modules/warehouse/routes/purchase.js — Purchase tracking (Company B SG)
//
// Hybrid module: BN_WhPurchase carries the manual import-tracking fields
// (received date, freight, permits, GST claim) while the NAV side
// supplies the live item / qty / rate / supplier / payment-term values
// via JOIN at query time.
//
// NAV sources (read-only via getPool()):
//   [Company B Pte Ltd_$Purchase Header]  — PO header + currency
//   [Company B Pte Ltd_$Purchase Line]    — item, qty, rate
//   [Company B Pte Ltd_$Vendor]           — supplier name + country
//
// Computed (server-side) fields:
//   BaseTotal         = Quantity × DirectUnitCost
//   ItemWiseValue     = BN_WhPurchase.InvoiceValue (override) || BaseTotal
//   GstPaidByUs       = ItemWiseValue × 9%   if VendorCountry != 'SG'
//   GstPaidBySupplier = (ItemWiseValue + BankOtherCharges) × 9%   if VendorCountry == 'SG'
//   NetInvoiceValue   = ItemWiseValue + BankOtherCharges + GstPaidBySupplier
//   GstAccFreight     = FreightSGD × 9%
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
const SG_GST_RATE = 0.09;   // Singapore GST/VAT 9%

function isWarehouseRole(user) {
  return ((user && user.role) || '').toLowerCase().trim() === 'warehouse';
}
function canRead(user)  { return isWarehouseRole(user) || isFullAccess(user); }
function canWrite(user) { return isWarehouseRole(user); }

// ── Date helper ─────────────────────────────────────────────────────────
// Frontend <input type="date"> emits YYYY-MM-DD strings. Passing the raw
// string to sql.Date causes the mssql driver to parse it via new Date(),
// which treats it as UTC midnight. If the SQL Server box is west of UTC
// (any negative offset), that UTC midnight becomes the previous day in
// local time → DATE column stores N-1. Mirrors the timezone landmine
// already documented in db.js (useUTC:false).
//
// Fix: parse as LOCAL midnight so the driver's "extract local components"
// path returns the same Y/M/D the user typed.
function toLocalDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  // Accept YYYY-MM-DD (input type=date) or YYYY-MM-DDTHH:mm:ss[.sssZ] (ISO).
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// ── Enrich BN_WhPurchase rows with live NAV data ────────────────────────
// Takes an array of rows from BN_WhPurchase and decorates each with the
// joined NAV Purchase Line / Header / Vendor fields. Done as ONE NAV query
// (not N) to keep things snappy even for 500-row pages.
async function enrichWithNav(rows) {
  if (!rows.length) return rows;

  // Build a list of (PoNo, LineNumber) keys for the IN clause. Rows with
  // no PoNo (pure expense entries) are skipped — they stay unjoined.
  const keys = rows
    .filter(r => r.PoNo && r.LineNumber != null)
    .map(r => ({ PoNo: String(r.PoNo), LineNumber: Number(r.LineNumber) }));
  if (!keys.length) return rows;

  const pool = await getPool();
  const r = pool.request();
  const poParams = [];
  keys.forEach((k, i) => {
    r.input('po' + i, sql.NVarChar(50), k.PoNo);
    r.input('ln' + i, sql.Int,         k.LineNumber);
    poParams.push(`(@po${i}, @ln${i})`);
  });
  // NAV deletes Purchase Line rows once a PO is fully received + invoiced,
  // so historical POs need to be sourced from Posted Purch_ Rcpt_ Line (which
  // permanently preserves the original Order No_ + Order Line No_ + item +
  // qty + cost). COALESCE prefers the open-PO row when present (more current
  // qty/cost), then falls back to the receipt aggregate for closed POs.
  const navRes = await r.query(`
    WITH Keys AS (SELECT * FROM (VALUES ${poParams.join(',')}) AS V(PoNo, LineNumber)),
    RcptAgg AS (
      -- Posted receipt aggregator. We also bring forward [Vendor Item No_]
      -- and [Shortcut Dimension 2 Code] so closed-PO rows have ItemName +
      -- Make on the listing.
      SELECT [Order No_] AS PoNo, [Order Line No_] AS LineNumber,
             MAX([Buy-from Vendor No_])         AS VendorCode,
             MAX([No_])                         AS ItemNo,
             MAX([Vendor Item No_])             AS VendorItemNo,
             MAX([Description])                 AS DescriptionFallback,
             MAX([Shortcut Dimension 2 Code])   AS Make,
             SUM(ISNULL([Quantity], 0))         AS Quantity,
             AVG(NULLIF([Direct Unit Cost], 0)) AS Rate
      FROM ${NAV_PREFIX}Purch_ Rcpt_ Line]
      WHERE [Type] = 2 AND [Order No_] IS NOT NULL
      GROUP BY [Order No_], [Order Line No_]
    )
    SELECT
      k.PoNo, k.LineNumber,
      COALESCE(pl.[Buy-from Vendor No_], rcpt.VendorCode)        AS VendorCode,
      ISNULL(v.[Name], '')                                       AS SupplierName,
      ISNULL(v.[Country_Region Code], '')                        AS VendorCountry,
      ISNULL(v.[Payment Terms Code], '')                         AS PaymentTerms,
      COALESCE(pl.[No_], rcpt.ItemNo)                            AS ItemNo,
      -- ItemName = Purchase Line.[Vendor Item No_] (the warehouse lead's preferred display
      -- per Purchase Column Information.xlsx). When NAV leaves it blank, fall
      -- back to Description so the cell never shows empty for ItemName.
      COALESCE(NULLIF(pl.[Vendor Item No_], ''),
               NULLIF(rcpt.VendorItemNo,     ''),
               NULLIF(pl.[Description],      ''),
               rcpt.DescriptionFallback,
               '')                                               AS ItemName,
      -- Make = Purchase Line.[Shortcut Dimension 2 Code] (the brand
      -- shortcut, e.g. ONSEMI / TDK). Item.[Description 2] is almost
      -- always blank — that was the old bug.
      COALESCE(NULLIF(pl.[Shortcut Dimension 2 Code], ''),
               rcpt.Make,
               '')                                               AS Make,
      COALESCE(NULLIF(pl.[Quantity], 0), rcpt.Quantity, 0)       AS Quantity,
      COALESCE(NULLIF(pl.[Direct Unit Cost], 0), rcpt.Rate, 0)   AS Rate,
      ph.[Currency Code]                                         AS Currency,
      ph.[Order Date]                                            AS OrderDate,
      ph.[Expected Receipt Date]                                 AS ExpectedReceiptDate
    FROM Keys k
    LEFT JOIN ${NAV_PREFIX}Purchase Line] pl
      ON pl.[Document Type] = 1
     AND pl.[Document No_]  = k.PoNo
     AND pl.[Line No_]      = k.LineNumber
    LEFT JOIN RcptAgg rcpt
      ON rcpt.PoNo = k.PoNo AND rcpt.LineNumber = k.LineNumber
    LEFT JOIN ${NAV_PREFIX}Purchase Header] ph
      ON ph.[Document Type] = 1
     AND ph.[No_]           = k.PoNo
    LEFT JOIN ${NAV_PREFIX}Vendor] v
      ON v.[No_] = COALESCE(pl.[Buy-from Vendor No_], rcpt.VendorCode);
  `);

  // Index NAV recordset by (PoNo, LineNumber)
  const navByKey = new Map();
  for (const n of navRes.recordset) {
    navByKey.set(`${n.PoNo}::${n.LineNumber}`, n);
  }

  // Merge each BN row with its NAV counterpart + compute derived fields
  return rows.map(row => {
    const nav = (row.PoNo && row.LineNumber != null)
      ? (navByKey.get(`${row.PoNo}::${row.LineNumber}`) || null)
      : null;

    const Quantity        = nav ? Number(nav.Quantity || 0) : 0;
    const Rate            = nav ? Number(nav.Rate     || 0) : 0;
    const BaseTotal       = +(Quantity * Rate).toFixed(2);
    const ItemWiseValue   = row.InvoiceValue != null && row.InvoiceValue !== ''
                            ? Number(row.InvoiceValue)
                            : BaseTotal;
    const BankOtherCharges = Number(row.BankOtherCharges || 0);

    const isSingaporeSupplier = nav && (nav.VendorCountry || '').toUpperCase() === 'SG';
    const GstPaidByUs       = !isSingaporeSupplier ? +(ItemWiseValue * SG_GST_RATE).toFixed(2) : 0;
    const GstPaidBySupplier = isSingaporeSupplier  ? +((ItemWiseValue + BankOtherCharges) * SG_GST_RATE).toFixed(2) : 0;
    const NetInvoiceValue   = +(ItemWiseValue + BankOtherCharges + GstPaidBySupplier).toFixed(2);
    const GstAccFreight     = +(Number(row.FreightSGD || 0) * SG_GST_RATE).toFixed(2);

    return {
      ...row,
      VendorCode:          nav ? nav.VendorCode      : null,
      SupplierName:        nav ? nav.SupplierName    : null,
      VendorCountry:       nav ? nav.VendorCountry   : null,
      PaymentTerms:        nav ? nav.PaymentTerms    : null,
      ItemNo:              nav ? nav.ItemNo          : null,
      ItemName:            nav ? nav.ItemName        : null,
      // VendorItemNo + Make are computed in the NAV query above (as part of
      // ItemName resolution + Shortcut Dimension 2 Code). Expose them so the
      // export columns + Invoice Summary modal don't have to JOIN again.
      VendorItemNo:        nav ? (nav.ItemName || '') : null,
      Make:                nav ? nav.Make            : null,
      Quantity,
      Rate,
      Currency:            nav ? nav.Currency        : null,
      OrderDate:           nav ? nav.OrderDate       : null,
      ExpectedReceiptDate: nav ? nav.ExpectedReceiptDate : null,
      // Computed
      BaseTotal,
      ItemWiseValue,
      GstPaidByUs,
      GstPaidBySupplier,
      NetInvoiceValue,
      GstAccFreight,
    };
  });
}

// ── GET /api/warehouse/purchase  (BN-FIRST view — tracked rows only) ──
// 2026-06-17 rewrite: the listing now starts FROM BN_WhPurchase, NOT from
// NAV Purchase Line. Rationale:
//   1. Matches the warehouse lead's mental model — he only sees what he has manually
//      entered via the Vendor → PO → Lines wizard.
//   2. Decouples Purchase fully from SO Backlog (NAV is now an enrichment
//      source, not the driver).
//   3. Lets us read the optional Amit columns (Incoterms, Datecode, LotNo,
//      NetWeightKg, GstPaidByUsFlag, NoOfCartons) defensively — if migration
//      22 hasn't been applied yet we wrap the column list in a try/fallback.
//
// Filters (all on BN_ columns):
//   ?search=<text>        PoNo / InvoiceNo / SystemNo / AWB / Permit / Status
//   ?status=<val>         exact match on BN_WhPurchase.Status
//   ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD  on MatlReceivedDate
//   ?days=90              recent N days on UpdatedAt (default 365)
//   ?sortBy=recent        sort by UpdatedAt DESC instead of MatlRecvDate DESC
//   ?page=1&limit=50
router.get('/', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const search   = (req.query.search   || '').trim();
    const statusF  = (req.query.status   || '').trim();
    const dateFrom = (req.query.dateFrom || '').trim();
    const dateTo   = (req.query.dateTo   || '').trim();
    const days     = Math.min(1825, Math.max(1, parseInt(req.query.days || '365', 10)));
    const page     = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit    = Math.min(500, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset   = (page - 1) * limit;
    const sortBy   = (req.query.sortBy || '').trim().toLowerCase();

    const appPool = await getAppPool();
    const r = appPool.request();
    r.input('co',     sql.NVarChar(10), COMPANY);
    r.input('offset', sql.Int, offset);
    r.input('limit',  sql.Int, limit);
    r.input('days',   sql.Int, days);

    // Date filter — applies to MatlReceivedDate, falls back to UpdatedAt when null.
    let dateWhere = '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      r.input('df', sql.Date, toLocalDate(dateFrom));
      dateWhere = ' AND COALESCE(bn.MatlReceivedDate, bn.UpdatedAt) >= @df';
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        r.input('dt', sql.Date, toLocalDate(dateTo));
        dateWhere += ' AND COALESCE(bn.MatlReceivedDate, bn.UpdatedAt) <= @dt';
      }
    }

    // Detect which migration-added columns exist FIRST — both the SELECT
    // and the search WHERE need to know what's available so they can omit
    // missing columns rather than crash with "Invalid column name".
    const colsRes = await appPool.request().query(`
      SELECT name FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase')
        AND name IN ('Incoterms','Datecode','LotNo','NetWeightKg','GstPaidByUsFlag','NoOfCartons','CartonNo');
    `);
    const cols = new Set(colsRes.recordset.map(c => c.name));

    // Free-text search across BN_WhPurchase fields. BizNAV_App default
    // collation is CI so no COLLATE override needed. Migration-22/23
    // columns are only referenced if they exist.
    let searchWhere = '';
    if (search) {
      r.input('q', sql.NVarChar(200), '%' + search + '%');
      const searchExprs = [
        'bn.PoNo                LIKE @q',
        "ISNULL(bn.SystemNo, '')     LIKE @q",
        "ISNULL(bn.InvoiceNo, '')    LIKE @q",
        "ISNULL(bn.AirWaybillNo,'')  LIKE @q",
        "ISNULL(bn.PermitNo, '')     LIKE @q",
        "ISNULL(bn.Status, '')       LIKE @q",
        "ISNULL(bn.COO, '')          LIKE @q",
        "ISNULL(bn.Dimension, '')    LIKE @q",
        "ISNULL(bn.Remark, '')       LIKE @q",
      ];
      if (cols.has('Datecode'))  searchExprs.push("ISNULL(bn.Datecode, '')  LIKE @q");
      if (cols.has('LotNo'))     searchExprs.push("ISNULL(bn.LotNo, '')     LIKE @q");
      if (cols.has('Incoterms')) searchExprs.push("ISNULL(bn.Incoterms, '') LIKE @q");
      if (cols.has('CartonNo'))  searchExprs.push("ISNULL(bn.CartonNo, '')  LIKE @q");
      searchWhere = ' AND (' + searchExprs.join(' OR ') + ')';
    }

    let statusWhere = '';
    if (statusF && statusF !== 'all') {
      r.input('statusVal', sql.NVarChar(30), statusF);
      statusWhere = ' AND bn.Status = @statusVal';
    }
    const extraCols = [
      ['Incoterms',       'NVARCHAR(20)'],
      ['Datecode',        'NVARCHAR(30)'],
      ['LotNo',           'NVARCHAR(50)'],
      ['NetWeightKg',     'DECIMAL(10,3)'],
      ['GstPaidByUsFlag', 'BIT'],
      ['NoOfCartons',     'INT'],
      ['CartonNo',        'NVARCHAR(50)'],
    ].map(([col, typ]) =>
      cols.has(col) ? `bn.${col}` : `CAST(NULL AS ${typ}) AS ${col}`,
    ).join(', ');
    const amitCols = extraCols + ',';

    // Aggregate split-carton rows. A single NAV PO line that's been split
    // across N physical cartons exists as N rows in BN_WhPurchase (one per
    // SplitSeq). On the home table Amit wants ONE merged row per
    // (Company, PoNo, LineNumber) with summed Recd Qty + concatenated
    // Cartons / Dimensions. The Edit button targets MIN(BnId) so opening
    // Edit still works — but the modal still edits just that one underlying
    // row, which keeps split values per-carton.
    //
    // String fields use MAX (they should be identical across splits since
    // they're shipment-level common). CartonNo + Dimension use STRING_AGG
    // because they're per-carton.
    // Numeric: QuantityReceived + WeightKg + NetWeightKg are SUM'd; rates
    // and prices are MAX (per-line, identical across splits).
    const result = await r.query(`
      WITH BaseRows AS (
        SELECT
          bn.Id AS BnId, bn.PoNo, bn.LineNumber, bn.Company,
          -- DATE columns sent as YYYY-MM-DD strings to bypass the mssql
          -- driver / JSON / new Date() round-trip timezone shift.
          CONVERT(VARCHAR(10), bn.MatlReceivedDate, 23) AS MatlReceivedDate,
          bn.SystemNo, bn.PurchaseType,
          CONVERT(VARCHAR(10), bn.InvoiceDate, 23) AS InvoiceDate,
          bn.InvoiceNo, bn.PoReceived,
          bn.InvoiceValue AS InvoiceValueManual,
          bn.BankOtherCharges, bn.QuantityReceived,
          bn.Dimension, bn.WeightKg, bn.COO,
          bn.ReceivedThrough, bn.AirWaybillNo, bn.Status,
          CONVERT(VARCHAR(10), bn.PaidDate, 23) AS PaidDate,
          bn.FreightSGD, bn.GSTFreightStatus, bn.FreightSGDPerKg,
          bn.TotalFFCharges, bn.InvoiceNoFFCourier, bn.LocalCharges,
          bn.PermitNo, bn.ImportPermitType, bn.GSTClaimedMonth, bn.Remark,
          ${amitCols}
          bn.CreatedAt, bn.UpdatedAt
        FROM dbo.BN_WhPurchase bn
        WHERE bn.Company = @co
          AND bn.IsActive = 1
          ${dateWhere}
          ${searchWhere}
          ${statusWhere}
      ),
      Merged AS (
        SELECT
          MIN(BnId)                                                    AS BnId,
          Company, PoNo, LineNumber,
          MAX(MatlReceivedDate)                                        AS MatlReceivedDate,
          MAX(SystemNo)                                                AS SystemNo,
          MAX(PurchaseType)                                            AS PurchaseType,
          MAX(InvoiceDate)                                             AS InvoiceDate,
          MAX(InvoiceNo)                                               AS InvoiceNo,
          MAX(PoReceived)                                              AS PoReceived,
          MAX(InvoiceValueManual)                                      AS InvoiceValueManual,
          MAX(BankOtherCharges)                                        AS BankOtherCharges,
          SUM(QuantityReceived)                                        AS QuantityReceived,
          STRING_AGG(NULLIF(Dimension, ''),  ' · ') WITHIN GROUP (ORDER BY BnId) AS Dimension,
          SUM(WeightKg)                                                AS WeightKg,
          MAX(COO)                                                     AS COO,
          MAX(ReceivedThrough)                                         AS ReceivedThrough,
          MAX(AirWaybillNo)                                            AS AirWaybillNo,
          CASE WHEN COUNT(DISTINCT ISNULL(Status, '')) > 1
               THEN 'Mixed' ELSE MAX(Status) END                       AS Status,
          MAX(PaidDate)                                                AS PaidDate,
          MAX(FreightSGD)                                              AS FreightSGD,
          MAX(GSTFreightStatus)                                        AS GSTFreightStatus,
          MAX(FreightSGDPerKg)                                         AS FreightSGDPerKg,
          MAX(TotalFFCharges)                                          AS TotalFFCharges,
          MAX(InvoiceNoFFCourier)                                      AS InvoiceNoFFCourier,
          MAX(LocalCharges)                                            AS LocalCharges,
          MAX(PermitNo)                                                AS PermitNo,
          MAX(ImportPermitType)                                        AS ImportPermitType,
          MAX(GSTClaimedMonth)                                         AS GSTClaimedMonth,
          MAX(Remark)                                                  AS Remark,
          ${cols.has('Incoterms')       ? 'MAX(Incoterms)       AS Incoterms,'       : "CAST(NULL AS NVARCHAR(20)) AS Incoterms,"}
          ${cols.has('Datecode')        ? 'MAX(Datecode)        AS Datecode,'        : "CAST(NULL AS NVARCHAR(30)) AS Datecode,"}
          ${cols.has('LotNo')           ? 'MAX(LotNo)           AS LotNo,'           : "CAST(NULL AS NVARCHAR(50)) AS LotNo,"}
          ${cols.has('NetWeightKg')     ? 'SUM(NetWeightKg)     AS NetWeightKg,'     : "CAST(NULL AS DECIMAL(10,3)) AS NetWeightKg,"}
          ${cols.has('GstPaidByUsFlag') ? 'MAX(CAST(GstPaidByUsFlag AS INT)) AS GstPaidByUsFlag,' : "CAST(NULL AS BIT) AS GstPaidByUsFlag,"}
          ${cols.has('NoOfCartons')     ? 'MAX(NoOfCartons)     AS NoOfCartons,'     : "CAST(NULL AS INT) AS NoOfCartons,"}
          ${cols.has('CartonNo')        ? "STRING_AGG(NULLIF(CartonNo, ''), ' · ') WITHIN GROUP (ORDER BY BnId) AS CartonNo," : "CAST(NULL AS NVARCHAR(200)) AS CartonNo,"}
          MIN(CreatedAt)                                               AS CreatedAt,
          MAX(UpdatedAt)                                               AS UpdatedAt,
          COUNT(*)                                                     AS SplitCount
        FROM BaseRows
        GROUP BY Company, PoNo, LineNumber
      )
      SELECT *, COUNT(*) OVER () AS TotalRows
      FROM Merged
      ORDER BY
        ${sortBy === 'recent'
          ? 'UpdatedAt DESC, MatlReceivedDate DESC, InvoiceNo, PoNo, LineNumber'
          : 'MatlReceivedDate DESC, InvoiceNo, PoNo, LineNumber, BnId DESC'}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);

    const bnRows = result.recordset || [];
    const total = bnRows.length > 0 ? bnRows[0].TotalRows : 0;

    // Enrich each BN row with NAV's live item/qty/rate/vendor data so the
    // table can show "Supplier Name" / "Item Name" / "Make" / NAV Qty / Rate /
    // ItemWiseValue without storing them locally. Uses the same combined
    // NAV query as before (OPEN line preferred, posted receipt aggregate
    // fallback for closed POs).
    const enriched = await enrichWithNav(bnRows);

    // Apply the GST + Net derived computations consistently.
    const out = enriched.map(row => {
      const Quantity         = Number(row.Quantity || 0);
      const ItemWiseValue    = Number(row.ItemWiseValue || row.InvoiceValueManual || 0);
      const BankOtherCharges = Number(row.BankOtherCharges || 0);
      const isSG             = (row.VendorCountry || '').toUpperCase() === 'SG';
      const usPaysGst        = row.GstPaidByUsFlag != null ? !!row.GstPaidByUsFlag : !isSG;
      const GstPaidByUs      = usPaysGst  ? +(ItemWiseValue * SG_GST_RATE).toFixed(2) : 0;
      const GstPaidBySupplier = !usPaysGst ? +((ItemWiseValue + BankOtherCharges) * SG_GST_RATE).toFixed(2) : 0;
      const NetInvoiceValue  = +(ItemWiseValue + BankOtherCharges + GstPaidBySupplier).toFixed(2);
      const GstAccFreight    = +(Number(row.FreightSGD || 0) * SG_GST_RATE).toFixed(2);
      return {
        ...row,
        Id: row.BnId,
        IsTracked: true,
        OutstandingQuantity: Quantity - Number(row.QuantityReceived || 0),
        GstPaidByUs, GstPaidBySupplier, NetInvoiceValue, GstAccFreight,
      };
    });

    res.json({ data: out, total, page, limit, migrationsApplied: { m22: ['Incoterms','Datecode','LotNo','NetWeightKg','GstPaidByUsFlag','NoOfCartons'].every(c => cols.has(c)), m23: cols.has('CartonNo') } });
  } catch (err) {
    console.error('GET /warehouse/purchase error:', err.message);
    res.status(500).json({ message: 'Failed to list purchases', error: err.message });
  }
});

// ── GET /api/warehouse/purchase/vendor-suggest?q= ──────────────────────
// Vendor-first wizard step. Returns top-20 vendors that have at least one
// PO (open OR posted). Vendors with zero PO history are filtered out so
// the picker stays useful. Matches by vendor code OR name.
router.get('/vendor-suggest', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ data: [] });
    const pool = await getPool();
    const result = await pool.request()
      .input('q', sql.NVarChar(100), '%' + q + '%')
      .query(`
        WITH AllPOs AS (
          SELECT [Buy-from Vendor No_] AS VendorCode
          FROM ${NAV_PREFIX}Purchase Header]
          WHERE [Document Type] = 1
          UNION ALL
          SELECT [Buy-from Vendor No_] AS VendorCode
          FROM ${NAV_PREFIX}Purch_ Rcpt_ Header]
          WHERE [Order No_] <> ''
        ),
        VendorPoCount AS (
          SELECT VendorCode, COUNT(*) AS PoCount
          FROM AllPOs
          WHERE VendorCode <> ''
          GROUP BY VendorCode
        )
        SELECT TOP 20
          v.[No_]                                AS VendorCode,
          ISNULL(v.[Name], '')                   AS SupplierName,
          ISNULL(v.[Country_Region Code], '')    AS VendorCountry,
          ISNULL(v.[Currency Code], '')          AS DefaultCurrency,
          ISNULL(v.[Payment Terms Code], '')     AS PaymentTerms,
          vpc.PoCount
        FROM VendorPoCount vpc
        INNER JOIN ${NAV_PREFIX}Vendor] v ON v.[No_] = vpc.VendorCode
        -- COLLATE makes the LIKE case-insensitive — NAV's column collation is
        -- Latin1_General_100_CS_AS, so a lowercase 'retailer' would otherwise
        -- never match the stored 'RETAILER'. CI_AS keeps accents strict.
        WHERE v.[No_]  COLLATE Latin1_General_CI_AS LIKE @q
           OR v.[Name] COLLATE Latin1_General_CI_AS LIKE @q
        ORDER BY vpc.PoCount DESC, v.[Name];
      `);
    res.json({ data: result.recordset || [] });
  } catch (err) {
    console.error('GET /warehouse/purchase/vendor-suggest error:', err.message);
    res.status(500).json({ message: 'Vendor lookup failed', error: err.message });
  }
});

// ── GET /api/warehouse/purchase/next-carton-no ─────────────────────────
// Returns the next CartonNo in the CTN-YY-NNNN series (e.g. CTN-26-0042).
// Scans BN_WhStock + BN_WhPurchase for the highest existing sequence with
// the current year prefix, +1, padded to 4 digits. If no existing carton
// for this year, starts at CTN-YY-0001.
//
// Optional ?year=YY to query a different year (rarely used; defaults to
// current calendar year, last 2 digits).
router.get('/next-carton-no', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const yy = (req.query.year || String(new Date().getFullYear()).slice(-2)).padStart(2, '0');
    const prefix = `CTN-${yy}-`;
    const pool = await getAppPool();
    const r = await pool.request()
      .input('co',   sql.NVarChar(10),  COMPANY)
      .input('pre',  sql.NVarChar(20),  prefix + '%')
      .query(`
        WITH AllCartons AS (
          SELECT CartonNo FROM dbo.BN_WhStock
            WHERE Company = @co AND IsActive = 1 AND CartonNo LIKE @pre
          UNION ALL
          SELECT CartonNo FROM dbo.BN_WhPurchase
            WHERE Company = @co AND IsActive = 1 AND CartonNo LIKE @pre
        )
        SELECT MAX(TRY_CAST(RIGHT(CartonNo, 4) AS INT)) AS MaxSeq
        FROM AllCartons;
      `);
    const maxSeq = (r.recordset[0] && r.recordset[0].MaxSeq) || 0;
    const next = prefix + String(maxSeq + 1).padStart(4, '0');
    res.json({ nextCartonNo: next, prefix, maxSeq });
  } catch (err) {
    console.error('GET /warehouse/purchase/next-carton-no error:', err.message);
    res.status(500).json({ message: 'Failed to compute next carton no', error: err.message });
  }
});

// ── GET /api/warehouse/purchase/pos-by-vendor/:vendorCode ──────────────
// Step-2 of the vendor-cascade wizard. Returns every PO (open + posted)
// for the picked vendor, with order date / currency / line count so the
// user can see how many lines each PO carries before drilling in.
router.get('/pos-by-vendor/:vendorCode', authenticate, async (req, res, next) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const vendorCode = (req.params.vendorCode || '').trim();
    if (!vendorCode) return res.status(400).json({ message: 'vendorCode required' });
    const q = (req.query.q || '').trim();
    const pool = await getPool();
    const reqDb = pool.request().input('vendor', sql.NVarChar(50), vendorCode);
    let poFilter = '';
    if (q) {
      reqDb.input('q', sql.NVarChar(100), '%' + q + '%');
      poFilter = ` AND po.PoNo COLLATE Latin1_General_CI_AS LIKE @q`;
    }
    // One row per PO. Source derived as:
    //   OPEN    — PO is in Purchase Header only (no receipts posted yet)
    //   PARTIAL — PO is in BOTH tables (some lines received in NAV, some still open)
    //   POSTED  — PO is in Purch_ Rcpt_ Header only (fully received & NAV-closed)
    // LineCount = distinct order-line-numbers across both tables (so partial
    // receipts don't double-count).
    const result = await reqDb.query(`
        WITH AllPOs AS (
          SELECT ph.[No_] AS PoNo, ph.[Buy-from Vendor No_] AS VendorCode,
                 ph.[Order Date] AS OrderDate, ph.[Currency Code] AS Currency,
                 ph.[Expected Receipt Date] AS ExpectedReceiptDate,
                 'OPEN' AS Source
          FROM ${NAV_PREFIX}Purchase Header] ph
          WHERE ph.[Document Type] = 1 AND ph.[Buy-from Vendor No_] = @vendor
          UNION
          SELECT prh.[Order No_] AS PoNo, prh.[Buy-from Vendor No_] AS VendorCode,
                 prh.[Order Date] AS OrderDate, prh.[Currency Code] AS Currency,
                 NULL AS ExpectedReceiptDate,
                 'POSTED' AS Source
          FROM ${NAV_PREFIX}Purch_ Rcpt_ Header] prh
          WHERE prh.[Order No_] <> '' AND prh.[Buy-from Vendor No_] = @vendor
        ),
        Dedup AS (
          SELECT PoNo,
                 MAX(VendorCode)          AS VendorCode,
                 MAX(OrderDate)           AS OrderDate,
                 MAX(Currency)            AS Currency,
                 MAX(ExpectedReceiptDate) AS ExpectedReceiptDate,
                 MAX(CASE WHEN Source = 'OPEN'   THEN 1 ELSE 0 END) AS HasOpen,
                 MAX(CASE WHEN Source = 'POSTED' THEN 1 ELSE 0 END) AS HasPosted
          FROM AllPOs
          GROUP BY PoNo
        )
        SELECT
          d.PoNo, d.VendorCode,
          ISNULL(v.[Name], '')                AS SupplierName,
          ISNULL(v.[Country_Region Code], '') AS VendorCountry,
          d.OrderDate, d.ExpectedReceiptDate, d.Currency,
          CASE WHEN d.HasOpen = 1 AND d.HasPosted = 1 THEN 'PARTIAL'
               WHEN d.HasOpen = 1                     THEN 'OPEN'
               ELSE                                        'POSTED' END AS Source,
          d.HasOpen   AS HasOpenLines,
          d.HasPosted AS HasPostedReceipt,
          (
            SELECT COUNT(*)
            FROM (
              SELECT pl.[Line No_] AS Ln
              FROM ${NAV_PREFIX}Purchase Line] pl
              WHERE pl.[Document Type] = 1
                AND pl.[Document No_]  = d.PoNo
                AND pl.[Type]          = 2
              UNION
              SELECT prl.[Order Line No_] AS Ln
              FROM ${NAV_PREFIX}Purch_ Rcpt_ Line] prl
              WHERE prl.[Order No_]      = d.PoNo
                AND prl.[Type]           = 2
                AND prl.[Order Line No_] > 0
            ) X
          ) AS LineCount
        FROM Dedup d
        LEFT JOIN ${NAV_PREFIX}Vendor] v ON v.[No_] = d.VendorCode
        WHERE 1 = 1 ${poFilter.replace(/po\.PoNo/g, 'd.PoNo')}
        ORDER BY d.OrderDate DESC, d.PoNo DESC;
      `);
    res.json({ data: result.recordset || [] });
  } catch (err) {
    console.error('GET /warehouse/purchase/pos-by-vendor error:', err.message);
    res.status(500).json({ message: 'POs-by-vendor lookup failed', error: err.message });
  }
});

// ── GET /api/warehouse/purchase/po-suggest?q= ──────────────────────────
// Typeahead for the "Add Purchase Line" form — searches NAV's open POs.
router.get('/po-suggest', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ data: [] });
    const pool = await getPool();
    // Union of open POs (Purchase Header) and historical POs (Purch_ Rcpt_ Header)
    // — historical POs that NAV closed still have their original Order No_ in
    // posted receipts, so they can be picked here.
    const result = await pool.request()
      .input('q', sql.NVarChar(50), q + '%')
      .query(`
        WITH AllPOs AS (
          SELECT ph.[No_] AS PoNo, ph.[Buy-from Vendor No_] AS VendorCode,
                 ph.[Order Date] AS OrderDate, ph.[Currency Code] AS Currency,
                 'OPEN' AS Source
          FROM ${NAV_PREFIX}Purchase Header] ph
          WHERE ph.[Document Type] = 1
            AND ph.[No_] COLLATE Latin1_General_CI_AS LIKE @q
          UNION
          SELECT prh.[Order No_] AS PoNo, prh.[Buy-from Vendor No_] AS VendorCode,
                 prh.[Order Date] AS OrderDate, prh.[Currency Code] AS Currency,
                 'POSTED' AS Source
          FROM ${NAV_PREFIX}Purch_ Rcpt_ Header] prh
          WHERE prh.[Order No_] COLLATE Latin1_General_CI_AS LIKE @q
            AND prh.[Order No_] <> ''
        )
        SELECT TOP 20
          po.PoNo, po.VendorCode,
          ISNULL(v.[Name], '')                AS SupplierName,
          ISNULL(v.[Country_Region Code], '') AS VendorCountry,
          po.OrderDate, po.Currency, po.Source,
          (SELECT COUNT(*) FROM ${NAV_PREFIX}Purchase Line] pl
             WHERE pl.[Document Type] = 1 AND pl.[Document No_] = po.PoNo)
          + (SELECT COUNT(DISTINCT [Order Line No_]) FROM ${NAV_PREFIX}Purch_ Rcpt_ Line] prl
             WHERE prl.[Order No_] = po.PoNo AND prl.[Type] = 2) AS LineCount
        FROM AllPOs po
        LEFT JOIN ${NAV_PREFIX}Vendor] v ON v.[No_] = po.VendorCode
        ORDER BY po.OrderDate DESC, po.PoNo DESC;
      `);
    res.json({ data: result.recordset || [] });
  } catch (err) {
    console.error('GET /warehouse/purchase/po-suggest error:', err.message);
    res.status(500).json({ message: 'PO lookup failed', error: err.message });
  }
});

// ── GET /api/warehouse/purchase/po-lines/:poNo ─────────────────────────
// Returns the lines the user can RECEIVE against for a PO. Matches NAV's
// PO Card behaviour — only currently-open lines (from Purchase Line).
//
// Why not UNION'd with posted receipts (as we used to)? Because NAV's
// receipt history can include lines that were posted with qty 0 (line
// cancelled / reduced to zero by Pune) and then dropped from Purchase
// Line. Those used to leak into the wizard as phantom rows with blank
// PO Qty, confusing Amit ("NAV shows 2 lines, app shows 3"). The new
// rule: use Purchase Line as source of truth; fall back to Receipt
// aggregator ONLY when Purchase Line is completely empty for this PO
// (the fully-closed PO case — still need to surface SOMETHING so Amit
// can record post-hoc tracking).
router.get('/po-lines/:poNo', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('po', sql.NVarChar(50), req.params.poNo)
      .query(`
        WITH PurchaseLines AS (
          SELECT [Line No_] AS LineNumber
          FROM ${NAV_PREFIX}Purchase Line]
          WHERE [Document Type] = 1
            AND [Document No_]  = @po
            AND [Type]          = 2
        ),
        RcptAgg AS (
          SELECT [Order No_] AS PoNo, [Order Line No_] AS LineNumber,
                 MAX([No_])                          AS ItemNo,
                 MAX([Vendor Item No_])              AS VendorItemNo,
                 MAX([Description])                  AS ItemName,
                 SUM(ISNULL([Quantity], 0))          AS Quantity,
                 AVG(NULLIF([Direct Unit Cost], 0))  AS Rate,
                 MAX([Buy-from Vendor No_])         AS VendorCode
          FROM ${NAV_PREFIX}Purch_ Rcpt_ Line]
          WHERE [Order No_]      = @po
            AND [Type]           = 2
            AND [Order Line No_] > 0
          GROUP BY [Order No_], [Order Line No_]
          -- HAVING SUM(...) > 0 so cancelled / reduced-to-zero lines don't
          -- surface even in the fully-closed fallback case below.
          HAVING SUM(ISNULL([Quantity], 0)) > 0
        ),
        Lines AS (
          -- Prefer Purchase Line rows when they exist (matches NAV PO Card).
          SELECT LineNumber FROM PurchaseLines
          UNION ALL
          -- Fall back to Receipt-only rows ONLY when Purchase Line is empty
          -- for this PO (fully-closed PO; PO Card view would show nothing).
          SELECT LineNumber FROM RcptAgg
          WHERE NOT EXISTS (SELECT 1 FROM PurchaseLines)
        )
        SELECT
          @po                                                AS PoNo,
          COALESCE(pl.[Line No_], rcpt.LineNumber)           AS LineNumber,
          COALESCE(pl.[No_], rcpt.ItemNo)                    AS ItemNo,
          COALESCE(NULLIF(pl.[Vendor Item No_], ''), rcpt.VendorItemNo, '') AS VendorItemNo,
          COALESCE(NULLIF(pl.[Description], ''), rcpt.ItemName, '') AS ItemName,
          COALESCE(NULLIF(pl.[Quantity], 0), rcpt.Quantity, 0) AS Quantity,
          COALESCE(NULLIF(pl.[Direct Unit Cost], 0), rcpt.Rate, 0) AS Rate,
          ISNULL(ph.[Currency Code], prh.[Currency Code])    AS Currency,
          COALESCE(pl.[Buy-from Vendor No_], rcpt.VendorCode) AS VendorCode,
          ISNULL(v.[Name], '')                                AS SupplierName,
          ISNULL(v.[Country_Region Code], '')                 AS VendorCountry
        FROM Lines
        LEFT JOIN ${NAV_PREFIX}Purchase Line] pl
          ON pl.[Document Type] = 1 AND pl.[Document No_] = @po AND pl.[Line No_] = Lines.LineNumber
        LEFT JOIN RcptAgg rcpt
          ON rcpt.LineNumber = Lines.LineNumber
        LEFT JOIN ${NAV_PREFIX}Purchase Header] ph
          ON ph.[Document Type] = 1 AND ph.[No_] = @po
        LEFT JOIN (
          SELECT TOP 1 [Order No_] AS PoNo, [Currency Code]
          FROM ${NAV_PREFIX}Purch_ Rcpt_ Header] WHERE [Order No_] = @po
          ORDER BY [Posting Date] DESC
        ) prh ON prh.PoNo = @po
        LEFT JOIN ${NAV_PREFIX}Vendor] v
          ON v.[No_] = COALESCE(pl.[Buy-from Vendor No_], rcpt.VendorCode)
        ORDER BY Lines.LineNumber;
      `);
    res.json({ data: result.recordset || [] });
  } catch (err) {
    console.error('GET /warehouse/purchase/po-lines error:', err.message);
    res.status(500).json({ message: 'PO lines lookup failed', error: err.message });
  }
});

// ── GET /api/warehouse/purchase/:id ────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  // Numeric :id only — let path-style routes above handle non-numeric.
  if (!/^\d+$/.test(req.params.id)) return next();
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const pool = await getAppPool();
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('co', sql.NVarChar(10), COMPANY)
      .query(`SELECT * FROM dbo.BN_WhPurchase WHERE Id = @id AND Company = @co;`);
    if (!r.recordset.length) return res.status(404).json({ message: 'Purchase not found' });
    const enriched = await enrichWithNav(r.recordset);
    res.json({ data: enriched[0] });
  } catch (err) {
    console.error('GET /warehouse/purchase/:id error:', err.message);
    res.status(500).json({ message: 'Failed to fetch purchase', error: err.message });
  }
});

// Auto-generate SystemNo as WH-PUR-YYYYMM-#### where #### is sequential per month.
async function genSystemNo(appPool) {
  const now = new Date();
  const yyyymm = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0');
  const r = await appPool.request()
    .input('pre', sql.NVarChar(30), 'WH-PUR-' + yyyymm + '-%')
    .query(`
      SELECT TOP 1 SystemNo FROM dbo.BN_WhPurchase
       WHERE SystemNo LIKE @pre
       ORDER BY Id DESC;
    `);
  const last = r.recordset[0] && r.recordset[0].SystemNo;
  const lastSeq = last ? parseInt(last.split('-').pop(), 10) : 0;
  return 'WH-PUR-' + yyyymm + '-' + String((lastSeq || 0) + 1).padStart(4, '0');
}

// ── POST /api/warehouse/purchase ───────────────────────────────────────
// UPSERT on (Company, PoNo, LineNumber). Amit clicks Edit/Add on a NAV row
// — if BN_Wh already has tracking for that PO line, UPDATE; else INSERT.
// Frontend just sends PoNo + LineNumber + manual fields, no need to know
// whether a row exists yet.
router.post('/', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const b = req.body || {};
    if (!b.PoNo) return res.status(400).json({ message: 'PoNo is required' });
    const pool = await getAppPool();
    const systemNo = b.SystemNo || await genSystemNo(pool);
    const r = pool.request();
    r.input('co',           sql.NVarChar(10),  COMPANY);
    r.input('poNo',         sql.NVarChar(50),  b.PoNo);
    r.input('lineNumber',   sql.Int,           b.LineNumber != null ? Number(b.LineNumber) : null);
    r.input('systemNo',     sql.NVarChar(50),  systemNo);
    r.input('purchaseType', sql.NVarChar(20),  b.PurchaseType || 'Purchase');
    r.input('invDate',      sql.Date,          toLocalDate(b.InvoiceDate));
    r.input('invNo',        sql.NVarChar(50),  b.InvoiceNo || null);
    r.input('poReceived',   sql.NVarChar(50),  b.PoReceived || null);
    r.input('invValue',     sql.Decimal(18,2), b.InvoiceValue != null ? Number(b.InvoiceValue) : null);
    r.input('bankCharges',  sql.Decimal(18,2), b.BankOtherCharges != null ? Number(b.BankOtherCharges) : 0);
    r.input('qtyReceived',  sql.Decimal(18,4), b.QuantityReceived != null && b.QuantityReceived !== '' ? Number(b.QuantityReceived) : null);
    r.input('dim',          sql.NVarChar(50),  b.Dimension || null);
    r.input('weight',       sql.Decimal(10,3), b.WeightKg != null ? Number(b.WeightKg) : null);
    r.input('coo',          sql.NVarChar(100), b.COO || null);
    r.input('rcvThrough',   sql.NVarChar(50),  b.ReceivedThrough || null);
    r.input('awb',          sql.NVarChar(50),  b.AirWaybillNo || null);
    // Default Status to 'Pending' when the wizard omits it.
    //
    // Workflow stages (per the warehouse lead's process):
    //   1. Wizard save (no AWB yet)        → Pending     (this default)
    //   2. Vendor shares AWB / consignment → In Transit  (Edit modal flip)
    //   3. Material lands in SG warehouse  → Received    (Edit modal flip → auto-stock fires)
    //
    // The carton-wise wizard (2026-06-24) intentionally drops the Status
    // picker because every NEW entry starts as Pending — Status only
    // changes later via the Edit modal as the shipment progresses.
    const statusForSave = (b.Status && String(b.Status).trim()) || 'Pending';
    r.input('status',       sql.NVarChar(20),  statusForSave);

    // MatlReceivedDate is the date material physically arrived. Only meaningful
    // when Status implies receipt — for Pending/In Transit/etc it must be NULL
    // so the home table shows blank. If status is Received and caller didn't
    // send a date, default to today (the implied receipt date).
    const statusLower = (statusForSave || '').toLowerCase().trim();
    const isReceivedStatus = statusLower === 'received' || statusLower === 'received material';
    const matlRecvDateForSave = isReceivedStatus
      ? (toLocalDate(b.MatlReceivedDate) || new Date())
      : null;
    r.input('matlRecvDate', sql.Date,          matlRecvDateForSave);
    r.input('paidDate',     sql.Date,          toLocalDate(b.PaidDate));
    r.input('freightSgd',   sql.Decimal(18,2), b.FreightSGD != null ? Number(b.FreightSGD) : null);
    r.input('gstFrStatus',  sql.NVarChar(20),  b.GSTFreightStatus || null);
    r.input('freightPerKg', sql.Decimal(18,4), b.FreightSGDPerKg != null ? Number(b.FreightSGDPerKg) : null);
    r.input('totalFF',      sql.Decimal(18,2), b.TotalFFCharges != null ? Number(b.TotalFFCharges) : null);
    r.input('invFFCourier', sql.NVarChar(50),  b.InvoiceNoFFCourier || null);
    r.input('localCharges', sql.Decimal(18,2), b.LocalCharges != null ? Number(b.LocalCharges) : null);
    r.input('permitNo',     sql.NVarChar(50),  b.PermitNo || null);
    r.input('permitType',   sql.NVarChar(30),  b.ImportPermitType || null);
    r.input('gstClaim',     sql.NVarChar(20),  b.GSTClaimedMonth || null);
    r.input('remark',       sql.NVarChar(500), b.Remark || null);
    // the warehouse lead's per-line fields (migration 22 + 23) — bound defensively. The
    // MERGE statement below conditionally includes them only if the columns
    // actually exist in BN_WhPurchase, so partial-migration DBs still work.
    r.input('incoterms',    sql.NVarChar(20),  b.Incoterms || null);
    r.input('datecode',     sql.NVarChar(30),  b.Datecode || null);
    r.input('lotNo',        sql.NVarChar(50),  b.LotNo || null);
    r.input('netWeightKg',  sql.Decimal(10,3), b.NetWeightKg != null && b.NetWeightKg !== '' ? Number(b.NetWeightKg) : null);
    r.input('gstByUsFlag',  sql.Bit,           b.GstPaidByUsFlag == null ? null : (b.GstPaidByUsFlag ? 1 : 0));
    r.input('noOfCartons',  sql.Int,           b.NoOfCartons != null && b.NoOfCartons !== '' ? Number(b.NoOfCartons) : null);
    r.input('cartonNo',     sql.NVarChar(50),  b.CartonNo || null);
    // SplitSeq — distinguishes split clones of the same NAV PO line so the
    // MERGE composite key doesn't collide. Base entry = 0 (or NULL); split
    // clones get 1, 2, ... per the wizard's split flow. See migration 24.
    r.input('splitSeq',     sql.Int,           b.SplitSeq != null ? Number(b.SplitSeq) : 0);
    r.input('createdBy',    sql.Int,           req.user.id);

    // Detect which post-13 columns exist. Lets the MERGE work on a partial DB.
    const colsRes = await pool.request().query(`
      SELECT name FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase')
        AND name IN ('Incoterms','Datecode','LotNo','NetWeightKg','GstPaidByUsFlag','NoOfCartons','CartonNo','SplitSeq');
    `);
    const cols = new Set(colsRes.recordset.map(c => c.name));
    const extras = [
      ['Incoterms',       '@incoterms'],
      ['Datecode',        '@datecode'],
      ['LotNo',           '@lotNo'],
      ['NetWeightKg',     '@netWeightKg'],
      ['GstPaidByUsFlag', '@gstByUsFlag'],
      ['NoOfCartons',     '@noOfCartons'],
      ['CartonNo',        '@cartonNo'],
      ['SplitSeq',        '@splitSeq'],
    ].filter(([col]) => cols.has(col));
    const extraSet      = extras.map(([col, p]) => `${col} = ${p}`).join(',\n        ');
    const extraInsCols  = extras.map(([col]) => col).join(', ');
    const extraInsVals  = extras.map(([, p]) => p).join(', ');

    // Match clause includes SplitSeq when column exists — base entry = 0,
    // splits = 1+. Wrap in ISNULL for pre-migration rows whose SplitSeq is NULL.
    const splitMatch = cols.has('SplitSeq')
      ? 'AND ISNULL(tgt.SplitSeq, 0) = ISNULL(@splitSeq, 0)'
      : '';

    const result = await r.query(`
      MERGE dbo.BN_WhPurchase AS tgt
      USING (SELECT @co AS Company, @poNo AS PoNo, @lineNumber AS LineNumber) AS src
        ON  tgt.Company    = src.Company
        AND tgt.PoNo       = src.PoNo
        AND ISNULL(tgt.LineNumber, -1) = ISNULL(src.LineNumber, -1)
        ${splitMatch}
        AND tgt.IsActive   = 1
      WHEN MATCHED THEN UPDATE SET
        MatlReceivedDate   = @matlRecvDate,
        PurchaseType       = @purchaseType,
        InvoiceDate        = @invDate,
        InvoiceNo          = @invNo,
        PoReceived         = @poReceived,
        InvoiceValue       = @invValue,
        BankOtherCharges   = @bankCharges,
        QuantityReceived   = @qtyReceived,
        Dimension          = @dim,
        WeightKg           = @weight,
        COO                = @coo,
        ReceivedThrough    = @rcvThrough,
        AirWaybillNo       = @awb,
        Status             = @status,
        PaidDate           = @paidDate,
        FreightSGD         = @freightSgd,
        GSTFreightStatus   = @gstFrStatus,
        FreightSGDPerKg    = @freightPerKg,
        TotalFFCharges     = @totalFF,
        InvoiceNoFFCourier = @invFFCourier,
        LocalCharges       = @localCharges,
        PermitNo           = @permitNo,
        ImportPermitType   = @permitType,
        GSTClaimedMonth    = @gstClaim,
        Remark             = @remark,
        ${extraSet ? extraSet + ',' : ''}
        UpdatedAt          = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (Company, PoNo, LineNumber, MatlReceivedDate, SystemNo, PurchaseType,
         InvoiceDate, InvoiceNo, PoReceived, InvoiceValue, BankOtherCharges,
         QuantityReceived,
         Dimension, WeightKg, COO, ReceivedThrough, AirWaybillNo,
         Status, PaidDate, FreightSGD, GSTFreightStatus, FreightSGDPerKg,
         TotalFFCharges, InvoiceNoFFCourier, LocalCharges, PermitNo,
         ImportPermitType, GSTClaimedMonth, Remark,
         ${extraInsCols ? extraInsCols + ',' : ''}
         CreatedBy)
      VALUES
        (@co, @poNo, @lineNumber, @matlRecvDate, @systemNo, @purchaseType,
         @invDate, @invNo, @poReceived, @invValue, @bankCharges,
         @qtyReceived,
         @dim, @weight, @coo, @rcvThrough, @awb,
         @status, @paidDate, @freightSgd, @gstFrStatus, @freightPerKg,
         @totalFF, @invFFCourier, @localCharges, @permitNo,
         @permitType, @gstClaim, @remark,
         ${extraInsVals ? extraInsVals + ',' : ''}
         @createdBy)
      OUTPUT $action AS Action, INSERTED.Id AS Id;
    `);
    const out = result.recordset[0] || {};

    // ── Auto-create Stock row when Status='Received' ──────────────────────
    // 2026-06-18: when Amit flips a Purchase row to Received, mirror it into
    // BN_WhStock so the Stocks page shows the carton immediately. Idempotent
    // — only inserts if no active BN_WhStock row exists for this PO line.
    // Failures here DO NOT block the purchase save (best-effort).
    let stockAutoCreated = null;
    try {
      // Use the same statusForSave that was just written, so the new wizard
      // (which omits Status) still triggers auto-stock via the 'Received' default.
      const status = (statusForSave || '').toLowerCase().trim();
      if (status === 'received' || status === 'received material') {
        // Pass the effective status into the helper via a shallow clone so the
        // downstream Stock row reflects the saved value, not the raw input.
        stockAutoCreated = await autoCreateStockFromPurchase(pool, { ...b, Status: statusForSave }, req.user.id);
      }
    } catch (autoErr) {
      console.warn('[auto-stock from purchase]', autoErr.message);
      // swallow; the purchase save still succeeded
    }

    res.status(out.Action === 'INSERT' ? 201 : 200).json({
      ok: true, Id: out.Id, SystemNo: systemNo, action: out.Action,
      stockAutoCreated,
    });
  } catch (err) {
    console.error('POST /warehouse/purchase error:', err.message);
    res.status(500).json({ message: 'Failed to create purchase', error: err.message });
  }
});

// Auto-create a BN_WhStock carton from a saved BN_WhPurchase line.
// Idempotent: skips if a Stock row already exists for (Company, PoNo, Line).
// Returns { ok, stockId, skipped, reason } so the POST response can surface it.
async function autoCreateStockFromPurchase(appPool, b, userId) {
  if (!b.PoNo) return { ok: false, reason: 'PoNo missing' };
  const lineNum = b.LineNumber != null ? Number(b.LineNumber) : null;
  if (lineNum == null) return { ok: false, reason: 'LineNumber missing' };

  // Idempotency guard: dedupe on (PoNo, LineNumber, CartonNo). Splitting a
  // line across 2+ cartons means each carton needs its OWN Stock row, so we
  // must include CartonNo in the dedup key. When CartonNo is blank we keep
  // the legacy behaviour (skip if any Stock row exists for this PO line).
  const carton = (b.CartonNo || '').trim();
  const dupReq = appPool.request()
    .input('co', sql.NVarChar(10), COMPANY)
    .input('po', sql.NVarChar(50), b.PoNo)
    .input('ln', sql.Int, lineNum);
  let dupSql = `
    SELECT TOP 1 Id FROM dbo.BN_WhStock
    WHERE Company = @co AND IsActive = 1
      AND SourcePoNo = @po AND SourcePoLine = @ln`;
  if (carton) {
    dupReq.input('carton', sql.NVarChar(50), carton);
    dupSql += ' AND ISNULL(CartonNo, \'\') = @carton';
  }
  const dupCheck = await dupReq.query(dupSql + ';');
  if (dupCheck.recordset.length) {
    return { ok: false, skipped: true, reason: 'Stock row already exists for this PO line + carton' };
  }

  // Pull NAV context (MPN / Make / Rate / Description) for this PO line.
  const navPool = await getPool();
  const navRow = (await navPool.request()
    .input('po', sql.NVarChar(50), b.PoNo)
    .input('ln', sql.Int, lineNum)
    .query(`
      SELECT TOP 1
        pl.[No_]                                AS NavItemCode,
        NULLIF(pl.[Vendor Item No_], '')        AS NavVendorItemNo,
        NULLIF(pl.[Description], '')            AS NavDescription,
        pl.[Shortcut Dimension 2 Code]          AS NavMake,
        ISNULL(pl.[Direct Unit Cost], 0)        AS NavRate,
        ISNULL(pl.[Unit Cost (LCY)], 0)         AS NavBasePriceLCY,
        ISNULL(pl.[Quantity], 0)                AS NavQty
      FROM ${NAV_PREFIX}Purchase Line] pl
      WHERE pl.[Document Type] = 1 AND pl.[Document No_] = @po AND pl.[Line No_] = @ln
      UNION ALL
      SELECT TOP 1
        MAX(prl.[No_])                          AS NavItemCode,
        NULLIF(MAX(prl.[Vendor Item No_]), '')  AS NavVendorItemNo,
        NULLIF(MAX(prl.[Description]), '')      AS NavDescription,
        MAX(prl.[Shortcut Dimension 2 Code])    AS NavMake,
        AVG(NULLIF(prl.[Direct Unit Cost], 0))  AS NavRate,
        AVG(NULLIF(prl.[Unit Cost (LCY)], 0))   AS NavBasePriceLCY,
        SUM(ISNULL(prl.[Quantity], 0))          AS NavQty
      FROM ${NAV_PREFIX}Purch_ Rcpt_ Line] prl
      WHERE prl.[Order No_] = @po AND prl.[Order Line No_] = @ln AND prl.[Type] = 2
      GROUP BY prl.[Order No_], prl.[Order Line No_];
    `)).recordset[0];

  if (!navRow) return { ok: false, reason: `NAV Purchase Line not found for ${b.PoNo} L${lineNum}` };

  // Best-effort ILE lookup so Stocks list links properly. NULL is fine.
  let ileEntryNo = null;
  if (b.InvoiceNo) {
    try {
      const ileRow = (await navPool.request()
        .input('itm', sql.NVarChar(50), navRow.NavItemCode)
        .input('doc', sql.NVarChar(50), b.InvoiceNo)
        .query(`
          SELECT TOP 1 [Entry No_] AS IleEntryNo
          FROM ${NAV_PREFIX}Item Ledger Entry]
          WHERE [Item No_] = @itm AND [Document No_] = @doc
            AND [Entry Type] = 0 AND ISNULL([Remaining Quantity], 0) > 0
          ORDER BY [Entry No_];
        `)).recordset[0];
      ileEntryNo = ileRow ? ileRow.IleEntryNo : null;
    } catch (_) {}
  }

  // Compose Stock-row values from BN_WhPurchase + NAV.
  const mpn      = navRow.NavVendorItemNo || navRow.NavItemCode || null;
  const make     = (navRow.NavMake || '').trim() || null;
  const cartonNo = (b.CartonNo || '').trim() || null;
  const qtyPcs   = b.QuantityReceived != null && b.QuantityReceived !== ''
                    ? Math.round(Number(b.QuantityReceived))
                    : Math.round(Number(navRow.NavQty || 0));
  const purPrice = Number(navRow.NavBasePriceLCY) || null;
  const purAmt   = purPrice != null && qtyPcs ? +(purPrice * qtyPcs).toFixed(2) : null;
  const inwordDt = toLocalDate(b.MatlReceivedDate);

  const ins = await appPool.request()
    .input('co',       sql.NVarChar(10),  COMPANY)
    .input('ile',      sql.Int,           ileEntryNo)
    .input('carton',   sql.NVarChar(50),  cartonNo)
    .input('invNo',    sql.NVarChar(50),  b.InvoiceNo || null)
    .input('mpn',      sql.NVarChar(100), mpn)
    .input('make',     sql.NVarChar(100), make)
    .input('qty',      sql.Int,           qtyPcs)
    .input('dim',      sql.NVarChar(50),  b.Dimension || null)
    .input('weight',   sql.Decimal(10,3), b.WeightKg != null ? Number(b.WeightKg) : null)
    .input('origin',   sql.NVarChar(100), b.COO || null)
    .input('datecode', sql.NVarChar(50),  b.Datecode || null)
    .input('inwordDt', sql.Date,          inwordDt)
    .input('purPrice', sql.Decimal(18,4), purPrice)
    .input('purAmt',   sql.Decimal(18,2), purAmt)
    .input('status',   sql.NVarChar(20),  'Stock')
    .input('srcPo',    sql.NVarChar(50),  b.PoNo)
    .input('srcLn',    sql.Int,           lineNum)
    .input('createdBy', sql.Int,          userId)
    .query(`
      INSERT INTO dbo.BN_WhStock
        (Company, IleEntryNo, CartonNo, InvoiceNo,
         MPN, Make, QtyPcs, Dimension, WeightKg, Origin,
         DateCode, InwordDate,
         PurchasePrice, PurchaseAmount, Status,
         SourcePoNo, SourcePoLine, CreatedBy)
      OUTPUT INSERTED.Id
      VALUES
        (@co, @ile, @carton, @invNo,
         @mpn, @make, @qty, @dim, @weight, @origin,
         @datecode, @inwordDt,
         @purPrice, @purAmt, @status,
         @srcPo, @srcLn, @createdBy);
    `);

  return {
    ok: true,
    stockId: ins.recordset[0].Id,
    cartonNo, mpn, qtyPcs, ileLinked: ileEntryNo != null,
  };
}

// ── GET /api/warehouse/purchase/by-invoice/:invoiceNo ──────────────────
// Invoice Summary endpoint. Returns every tracked BN_WhPurchase row that
// shares the given InvoiceNo, enriched with NAV item/qty/rate/supplier,
// plus a header object (Invoice No / Date / Supplier / Currency derived
// from the first row) and totals (subtotal, charges, GST, total amount).
// Drives the "click an invoice on the home table → see the full invoice
// summary" modal that mirrors the warehouse lead's Apps Script layout.
router.get('/by-invoice/:invoiceNo', authenticate, async (req, res, next) => {
  // /bulk-status & friends sit ABOVE this route, but :invoiceNo can match
  // a numeric id by accident — guard against that.
  if (/^\d+$/.test(req.params.invoiceNo)) return next();
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const invoiceNo = (req.params.invoiceNo || '').trim();
    if (!invoiceNo) return res.status(400).json({ message: 'invoiceNo required' });
    const pool = await getAppPool();
    const r = await pool.request()
      .input('co',  sql.NVarChar(10), COMPANY)
      .input('inv', sql.NVarChar(50), invoiceNo)
      .query(`
        SELECT
          Id AS BnId, PoNo, LineNumber, Company,
          CONVERT(VARCHAR(10), MatlReceivedDate, 23) AS MatlReceivedDate,
          SystemNo, PurchaseType,
          CONVERT(VARCHAR(10), InvoiceDate, 23) AS InvoiceDate,
          InvoiceNo, PoReceived,
          InvoiceValue AS InvoiceValueManual,
          BankOtherCharges, QuantityReceived,
          Dimension, WeightKg, COO,
          ReceivedThrough, AirWaybillNo, Status,
          CONVERT(VARCHAR(10), PaidDate, 23) AS PaidDate,
          FreightSGD, GSTFreightStatus, FreightSGDPerKg,
          TotalFFCharges, InvoiceNoFFCourier, LocalCharges,
          PermitNo, ImportPermitType, GSTClaimedMonth, Remark,
          Incoterms, Datecode, LotNo, NetWeightKg, GstPaidByUsFlag, NoOfCartons, CartonNo,
          CreatedAt, UpdatedAt
        FROM dbo.BN_WhPurchase
        WHERE Company = @co AND InvoiceNo = @inv AND IsActive = 1
        ORDER BY PoNo, LineNumber;
      `);
    const bnRows = r.recordset || [];
    if (!bnRows.length) {
      return res.json({ data: [], header: null, totals: null, message: 'No tracked lines for this invoice.' });
    }
    const enriched = await enrichWithNav(bnRows);

    // Hydrate Description + Global Dimension 2 Code (Item table) for each
    // unique ItemNo in the result set — these are the columns Amit wants
    // on the Invoice Summary table (matches Stocks page mapping).
    const itemCodes = Array.from(new Set(enriched.map(r => r.ItemNo).filter(Boolean)));
    if (itemCodes.length) {
      try {
        const navPool = await getPool();
        const itemReq = navPool.request();
        const placeholders = itemCodes.map((c, i) => { itemReq.input('itm' + i, sql.NVarChar(50), c); return '@itm' + i; }).join(',');
        const itemRes = await itemReq.query(`
          SELECT [No_]                     AS ItemNo,
                 [Description]             AS NavDescription,
                 [Global Dimension 2 Code] AS GlobalMake
          FROM ${NAV_PREFIX}Item]
          WHERE [No_] IN (${placeholders});
        `);
        const itemMap = new Map((itemRes.recordset || []).map(r => [String(r.ItemNo), r]));
        for (const row of enriched) {
          const it = itemMap.get(String(row.ItemNo));
          if (it) {
            // Description = NAV Item.[Description] (the human-readable text)
            row.Description = it.NavDescription || '';
            // Make (display) = Item.[Global Dimension 2 Code] — matches Stocks page
            row.MakeGlobal = it.GlobalMake || '';
          } else {
            row.Description = '';
            row.MakeGlobal = '';
          }
        }
      } catch (itemErr) {
        // Non-fatal — fall back to enrichWithNav's existing fields
        console.warn('[by-invoice item hydrate]', itemErr.message);
      }
    }

    // Header derived from the first tracked row + NAV-enriched supplier.
    // Status: when rows have different statuses, show "Mixed (A · B · C)".
    const statusSet = new Set(enriched.map(r => (r.Status || '').trim()).filter(Boolean));
    const first = enriched[0];
    const headerStatus = statusSet.size > 1
      ? `Mixed (${Array.from(statusSet).join(' · ')})`
      : (Array.from(statusSet)[0] || first.Status || '');
    const header = {
      InvoiceNo:    first.InvoiceNo,
      InvoiceDate:  first.InvoiceDate,
      SupplierName: first.SupplierName,
      Currency:     first.Currency,
      Incoterms:    first.Incoterms,
      MatlReceivedDate: first.MatlReceivedDate,
      Status:       headerStatus,
      StatusMixed:  statusSet.size > 1,
      AirWaybillNo: first.AirWaybillNo,
    };

    // Totals
    let subtotal = 0, totalQty = 0, totalNetWt = 0;
    const cartons = new Set();
    for (const row of enriched) {
      const qty   = Number(row.QuantityReceived != null ? row.QuantityReceived : (row.Quantity || 0));
      const rate  = Number(row.Rate || 0);
      const value = qty * rate;
      subtotal   += value;
      totalQty   += qty;
      totalNetWt += Number(row.NetWeightKg || 0);
      if (row.CartonNo) cartons.add(row.CartonNo);
    }
    const charges = Number(first.BankOtherCharges || 0);
    const isSG    = (first.VendorCountry || '').toUpperCase() === 'SG';
    const usPaysGst = first.GstPaidByUsFlag != null ? !!first.GstPaidByUsFlag : !isSG;
    const gstUs   = usPaysGst  ? +(subtotal * SG_GST_RATE).toFixed(2) : 0;
    const gstSup  = !usPaysGst ? +((subtotal + charges) * SG_GST_RATE).toFixed(2) : 0;
    const totalAmount = +(subtotal + charges + gstSup).toFixed(2);

    const totals = {
      lineCount:    enriched.length,
      cartonCount:  cartons.size,
      totalQty:     +totalQty.toFixed(2),
      totalNetWt:   +totalNetWt.toFixed(3),
      subtotal:     +subtotal.toFixed(2),
      charges:      +charges.toFixed(2),
      gstUs:        gstUs,
      gstSupplier:  gstSup,
      totalAmount,
    };

    res.json({ data: enriched, header, totals });
  } catch (err) {
    console.error('GET /warehouse/purchase/by-invoice error:', err.message);
    res.status(500).json({ message: 'Invoice summary failed', error: err.message });
  }
});

// ── POST /api/warehouse/purchase/bulk-status ──────────────────────────
// Bulk-update Status + optional shipment-level fields for every tracked
// BN_WhPurchase row matching a grouping key. Used by the Edit modal's
// "apply Status to all N lines on this PO/Invoice" confirm path so Amit
// doesn't have to open each sibling row one by one.
//
// Body: {
//   PoNo,                              // either PoNo OR InvoiceNo required
//   InvoiceNo,                         // preferred when both sent (more specific)
//   Status,                            // required
//   MatlReceivedDate? (YYYY-MM-DD),    // only flowed when present
//   AirWaybillNo?                      // only flowed when present (lines ship together)
// }
// Returns: { ok, updated, groupKey, stockAutoCreated }
//
// Auto-stock side-channel: every row that ends up at 'Received' /
// 'Received Material' AND has no existing BN_WhStock row gets one
// inserted (idempotent — see autoCreateStockFromPurchase).
router.post('/bulk-status', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const b = req.body || {};
    if (!b.Status) {
      return res.status(400).json({ message: 'Status is required' });
    }
    // Prefer Invoice grouping (single shipment) over PO grouping (whole
    // order which can ship in pieces). User opts in by sending one or
    // the other; if both are present, Invoice wins.
    const invoiceNo = b.InvoiceNo != null && String(b.InvoiceNo).trim() !== '' ? String(b.InvoiceNo).trim() : null;
    const poNo      = b.PoNo      != null && String(b.PoNo).trim()      !== '' ? String(b.PoNo).trim()      : null;
    if (!invoiceNo && !poNo) {
      return res.status(400).json({ message: 'PoNo or InvoiceNo required' });
    }
    const groupBy   = invoiceNo ? 'Invoice' : 'PO';
    const status    = String(b.Status).trim();
    const matlDate  = toLocalDate(b.MatlReceivedDate);
    // AWB: optional. Only flowed when the caller explicitly sent a non-empty
    // value. Empty / null preserves each row's existing AWB. Use null sentinel
    // when caller wants to KEEP existing — distinct from passing '' to clear.
    const awb = (b.AirWaybillNo != null && String(b.AirWaybillNo).trim() !== '')
      ? String(b.AirWaybillNo).trim()
      : null;
    const pool = await getAppPool();
    // Build WHERE on whichever grouping is active. Both paths support the
    // same auto-stock + AWB flow.
    const groupWhere = invoiceNo ? 'InvoiceNo = @grp' : 'PoNo = @grp';
    const groupVal   = invoiceNo || poNo;

    // Fetch all active rows in the group first so we can fire auto-stock
    // per-row after the bulk UPDATE commits.
    const rowsRes = await pool.request()
      .input('co',  sql.NVarChar(10), COMPANY)
      .input('grp', sql.NVarChar(50), groupVal)
      .query(`
        SELECT Id, PoNo, LineNumber, InvoiceNo, CartonNo,
               QuantityReceived, MatlReceivedDate, Datecode, Dimension, WeightKg, COO
        FROM dbo.BN_WhPurchase
        WHERE Company = @co AND ${groupWhere} AND IsActive = 1;
      `);
    const rows = rowsRes.recordset || [];
    if (!rows.length) return res.json({ ok: true, updated: 0, stockAutoCreated: 0, groupBy, message: `No tracked rows for this ${groupBy}.` });

    // Bulk UPDATE — MatlReceivedDate behavior:
    //   - caller sent explicit @date  → use it
    //   - flipping to Received w/ NULL existing → auto-stamp today
    //   - otherwise → keep existing
    // AirWaybillNo: caller-explicit overrides; else keep existing.
    const statusLow = status.toLowerCase();
    const triggersAutoStock = statusLow === 'received' || statusLow === 'received material';
    const upd = await pool.request()
      .input('co',     sql.NVarChar(10), COMPANY)
      .input('grp',    sql.NVarChar(50), groupVal)
      .input('status', sql.NVarChar(20), status)
      .input('date',   sql.Date,         matlDate)
      .input('isRcvd', sql.Bit,          triggersAutoStock ? 1 : 0)
      .input('awb',    sql.NVarChar(50), awb)
      .query(`
        UPDATE dbo.BN_WhPurchase
        SET Status = @status,
            MatlReceivedDate = CASE
              WHEN @date IS NOT NULL THEN @date
              WHEN @isRcvd = 1 AND MatlReceivedDate IS NULL THEN CAST(GETDATE() AS DATE)
              ELSE MatlReceivedDate
            END,
            AirWaybillNo     = CASE WHEN @awb  IS NOT NULL THEN @awb  ELSE AirWaybillNo     END,
            UpdatedAt = SYSDATETIME()
        WHERE Company = @co AND ${groupWhere} AND IsActive = 1;
        SELECT @@ROWCOUNT AS Updated;
      `);
    const updated = upd.recordset[0].Updated || 0;

    // Auto-stock fan-out — only when the bulk status implies physical receipt.
    // (triggersAutoStock already computed above when building the UPDATE.)
    let stockAutoCreated = 0;
    if (triggersAutoStock) {
      for (const row of rows) {
        try {
          const result = await autoCreateStockFromPurchase(pool, {
            PoNo: row.PoNo,
            LineNumber: row.LineNumber,
            InvoiceNo: row.InvoiceNo,
            CartonNo:  row.CartonNo,
            QuantityReceived: row.QuantityReceived,
            MatlReceivedDate: matlDate || row.MatlReceivedDate,
            Datecode:  row.Datecode,
            Dimension: row.Dimension,
            WeightKg:  row.WeightKg,
            COO:       row.COO,
            Status:    status,
          }, req.user.id);
          if (result && result.ok) stockAutoCreated++;
        } catch (autoErr) {
          console.warn('[bulk-status auto-stock] line', row.LineNumber, autoErr.message);
        }
      }
    }

    res.json({ ok: true, updated, stockAutoCreated, triggersAutoStock, groupBy });
  } catch (err) {
    console.error('POST /warehouse/purchase/bulk-status error:', err.message);
    res.status(500).json({ message: 'Failed to bulk-update status', error: err.message });
  }
});

// ── PUT /api/warehouse/purchase/:id ────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const b = req.body || {};
    const pool = await getAppPool();
    const r = pool.request();
    r.input('id',           sql.Int,           id);
    r.input('co',           sql.NVarChar(10),  COMPANY);
    r.input('poNo',         sql.NVarChar(50),  b.PoNo || null);
    r.input('lineNumber',   sql.Int,           b.LineNumber != null ? Number(b.LineNumber) : null);
    // MatlReceivedDate gated by Status — see POST handler for the rule.
    // For PUT (single-row Edit save), if Status is non-Received we force
    // NULL; if Status is Received and no date sent, default to today.
    const _putStatusLow = (b.Status || '').toLowerCase().trim();
    const _putIsRcvd    = _putStatusLow === 'received' || _putStatusLow === 'received material';
    const _putMatlDate  = _putIsRcvd
      ? (toLocalDate(b.MatlReceivedDate) || new Date())
      : null;
    r.input('matlRecvDate', sql.Date,          _putMatlDate);
    r.input('purchaseType', sql.NVarChar(20),  b.PurchaseType || 'Purchase');
    r.input('invDate',      sql.Date,          toLocalDate(b.InvoiceDate));
    r.input('invNo',        sql.NVarChar(50),  b.InvoiceNo || null);
    r.input('poReceived',   sql.NVarChar(50),  b.PoReceived || null);
    r.input('invValue',     sql.Decimal(18,2), b.InvoiceValue != null ? Number(b.InvoiceValue) : null);
    r.input('bankCharges',  sql.Decimal(18,2), b.BankOtherCharges != null ? Number(b.BankOtherCharges) : 0);
    r.input('qtyReceived',  sql.Decimal(18,4), b.QuantityReceived != null && b.QuantityReceived !== '' ? Number(b.QuantityReceived) : null);
    r.input('dim',          sql.NVarChar(50),  b.Dimension || null);
    r.input('weight',       sql.Decimal(10,3), b.WeightKg != null ? Number(b.WeightKg) : null);
    r.input('coo',          sql.NVarChar(100), b.COO || null);
    r.input('rcvThrough',   sql.NVarChar(50),  b.ReceivedThrough || null);
    r.input('awb',          sql.NVarChar(50),  b.AirWaybillNo || null);
    r.input('status',       sql.NVarChar(20),  b.Status || null);
    r.input('paidDate',     sql.Date,          toLocalDate(b.PaidDate));
    r.input('freightSgd',   sql.Decimal(18,2), b.FreightSGD != null ? Number(b.FreightSGD) : null);
    r.input('gstFrStatus',  sql.NVarChar(20),  b.GSTFreightStatus || null);
    r.input('freightPerKg', sql.Decimal(18,4), b.FreightSGDPerKg != null ? Number(b.FreightSGDPerKg) : null);
    r.input('totalFF',      sql.Decimal(18,2), b.TotalFFCharges != null ? Number(b.TotalFFCharges) : null);
    r.input('invFFCourier', sql.NVarChar(50),  b.InvoiceNoFFCourier || null);
    r.input('localCharges', sql.Decimal(18,2), b.LocalCharges != null ? Number(b.LocalCharges) : null);
    r.input('permitNo',     sql.NVarChar(50),  b.PermitNo || null);
    r.input('permitType',   sql.NVarChar(30),  b.ImportPermitType || null);
    r.input('gstClaim',     sql.NVarChar(20),  b.GSTClaimedMonth || null);
    r.input('remark',       sql.NVarChar(500), b.Remark || null);

    const result = await r.query(`
      UPDATE dbo.BN_WhPurchase SET
        PoNo = @poNo, LineNumber = @lineNumber, MatlReceivedDate = @matlRecvDate,
        PurchaseType = @purchaseType, InvoiceDate = @invDate, InvoiceNo = @invNo,
        PoReceived = @poReceived, InvoiceValue = @invValue, BankOtherCharges = @bankCharges,
        QuantityReceived = @qtyReceived,
        Dimension = @dim, WeightKg = @weight, COO = @coo,
        ReceivedThrough = @rcvThrough, AirWaybillNo = @awb,
        Status = @status, PaidDate = @paidDate, FreightSGD = @freightSgd,
        GSTFreightStatus = @gstFrStatus, FreightSGDPerKg = @freightPerKg,
        TotalFFCharges = @totalFF, InvoiceNoFFCourier = @invFFCourier,
        LocalCharges = @localCharges, PermitNo = @permitNo,
        ImportPermitType = @permitType, GSTClaimedMonth = @gstClaim,
        Remark = @remark, UpdatedAt = SYSDATETIME()
      WHERE Id = @id AND Company = @co;
      SELECT @@ROWCOUNT AS Updated;
    `);
    if (!result.recordset[0].Updated) return res.status(404).json({ message: 'Purchase not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /warehouse/purchase/:id error:', err.message);
    res.status(500).json({ message: 'Failed to update purchase', error: err.message });
  }
});

// ── DELETE /api/warehouse/purchase/:id (soft delete) ───────────────────
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
        UPDATE dbo.BN_WhPurchase SET IsActive = 0, UpdatedAt = SYSDATETIME()
        WHERE Id = @id AND Company = @co;
        SELECT @@ROWCOUNT AS Deleted;
      `);
    if (!result.recordset[0].Deleted) return res.status(404).json({ message: 'Purchase not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /warehouse/purchase/:id error:', err.message);
    res.status(500).json({ message: 'Failed to delete purchase', error: err.message });
  }
});

// ── POST /api/warehouse/purchase/import ───────────────────────────────
// The Excel only carries the manual columns; the matching NAV item / qty /
// rate / supplier / GST come from NAV at READ time via enrichWithNav().
// For that JOIN to land, we need (PoNo, LineNumber) on every row. The Excel
// has PoNo but no Line No — so during import we:
//   1. Group Excel rows by PoNo.
//   2. Hit NAV once per PoNo, get its Purchase Line numbers in order.
//   3. Assign LineNumber by POSITION: 1st Excel row of PO X → 1st NAV line,
//      2nd → 2nd, etc. (Excel order is preserved from the sheet.)
// Rows whose PoNo doesn't exist in NAV, OR Excel rows that overflow NAV's
// line count, get LineNumber=NULL (still imported; just won't NAV-enrich).
// Pass ?wipe=1 to soft-delete existing rows before importing (clean re-run).
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can import' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name = "file")' });
  try {
    const wb = X.xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheetName = X.resolveSheet(wb, 'purchase');
    if (!sheetName) return res.status(400).json({ message: 'No Purchase sheet found. Sheets: ' + wb.SheetNames.join(', ') });
    const { headers, rows } = X.readSheet(wb, sheetName);
    if (!rows.length) return res.json({ sheet: sheetName, inserted: 0, message: 'Sheet had no data rows' });

    const appPool = await getAppPool();
    const navPool = await getPool();

    // Wipe prior rows if requested (soft-delete via IsActive=0).
    let wiped = 0;
    if (req.query.wipe === '1' || req.query.wipe === 'true') {
      const w = await appPool.request().input('co', sql.NVarChar(10), COMPANY)
        .query(`UPDATE dbo.BN_WhPurchase SET IsActive=0 WHERE Company=@co AND IsActive=1; SELECT @@ROWCOUNT AS Wiped;`);
      wiped = w.recordset[0].Wiped || 0;
    }

    // Group Excel rows by PoNo so we can resolve NAV line numbers per group.
    const groups = new Map();   // poNo -> [rowIdx, rowIdx, ...]
    const poByIdx = new Array(rows.length).fill(null);
    rows.forEach((r, i) => {
      const po = X.toStr(X.cell(r, headers, 'CompanyB Po No','PO No','CompanyB PO No','Po No'));
      poByIdx[i] = po;
      if (!po) return;
      if (!groups.has(po)) groups.set(po, []);
      groups.get(po).push(i);
    });

    // For each unique PoNo, fetch NAV's line numbers in order. Open-PO source
    // first; if empty (PO already closed in NAV), fall back to Posted Purchase
    // Receipt Line which retains the original Order Line No_.
    const lineMap = new Map();   // poNo -> [lineNo, lineNo, ...]
    const navHits = []; const navMisses = [];
    for (const po of groups.keys()) {
      let lns = [];
      try {
        const nr = await navPool.request().input('po', sql.NVarChar(50), po).query(`
          SELECT [Line No_]
          FROM ${NAV_PREFIX}Purchase Line]
          WHERE [Document Type] = 1 AND [Document No_] = @po AND [Type] = 2
          ORDER BY [Line No_];`);
        lns = nr.recordset.map(x => x['Line No_']);
      } catch (_) {}
      if (!lns.length) {
        try {
          const nr2 = await navPool.request().input('po', sql.NVarChar(50), po).query(`
            SELECT DISTINCT [Order Line No_] AS LineNo_
            FROM ${NAV_PREFIX}Purch_ Rcpt_ Line]
            WHERE [Order No_] = @po AND [Type] = 2 AND [Order Line No_] > 0
            ORDER BY [Order Line No_];`);
          lns = nr2.recordset.map(x => x.LineNo_);
        } catch (_) {}
      }
      lineMap.set(po, lns);
      if (lns.length) navHits.push(po); else navMisses.push(po);
    }

    // For SystemNo auto-gen on rows that don't carry one.
    const yyyymm = (new Date()).getFullYear() + String((new Date()).getMonth() + 1).padStart(2, '0');
    const sysRes = await appPool.request().input('pre', sql.NVarChar(30), 'WH-PUR-' + yyyymm + '-%')
      .query(`SELECT TOP 1 SystemNo FROM dbo.BN_WhPurchase WHERE SystemNo LIKE @pre ORDER BY Id DESC;`);
    let sysSeq = sysRes.recordset[0] ? (parseInt(sysRes.recordset[0].SystemNo.split('-').pop(), 10) || 0) : 0;
    const nextSystemNo = () => 'WH-PUR-' + yyyymm + '-' + String(++sysSeq).padStart(4, '0');

    // Track per-PoNo position counter (Excel order)
    const seenByPo = new Map();

    let inserted = 0; let failed = 0; const errors = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const po = poByIdx[i];
      let lineNumber = null;
      if (po) {
        const used = seenByPo.get(po) || 0;
        const navLines = lineMap.get(po) || [];
        lineNumber = navLines[used] || null;
        seenByPo.set(po, used + 1);
      }
      try {
        const req2 = appPool.request();
        req2.input('co',           sql.NVarChar(10),  COMPANY);
        req2.input('poNo',         sql.NVarChar(50),  po);
        req2.input('lineNumber',   sql.Int,           lineNumber);
        req2.input('matlRecvDate', sql.Date,          X.toDate(X.cell(r, headers, 'Matrl. Received Date','Matl Received Date','Material Received Date','Received Date')));
        req2.input('systemNo',     sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'System No.','System No','System Number','Sys No')) || nextSystemNo());
        req2.input('purchaseType', sql.NVarChar(20),  X.toStr(X.cell(r, headers, 'Purchase / Expences','Purchase / Expence','Purchase Type','Type')) || 'Purchase');
        req2.input('invDate',      sql.Date,          X.toDate(X.cell(r, headers, 'Invoice Date','Inv Date')));
        req2.input('invNo',        sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Invoice No','Inv No','Invoice Number')));
        req2.input('poReceived',   sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Po Received','PO Received','PO Receive')));
        req2.input('invValue',     sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'As per Invoice Item wise Value','Invoice Value','Item Wise Value')));
        req2.input('bankCharges',  sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Bank/Other Charges','Bank Other Charges','Bank Charges','Other Charges')) ?? 0);
        req2.input('dim',          sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Diamension','Dimension','Dim')));
        req2.input('weight',       sql.Decimal(10,3), X.toNum(X.cell(r, headers, 'Weight (kg)','Weight','Wt (kg)','Wt')));
        req2.input('coo',          sql.NVarChar(100), X.toStr(X.cell(r, headers, 'COO','Country of Origin','Origin Country')));
        req2.input('rcvThrough',   sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Received Through','Through','Courier')));
        req2.input('awb',          sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Air Waybill No.','Air Waybill No','AWB','AWB No')));
        req2.input('status',       sql.NVarChar(20),  X.toStr(X.cell(r, headers, 'Status')));
        req2.input('paidDate',     sql.Date,          X.toDate(X.cell(r, headers, 'Paid Date','Payment Date')));
        req2.input('freightSgd',   sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Fright acco to Invoice  (SGD)','Fright acco to Invoice (SGD)','Freight SGD','Freight','Freight (SGD)')));
        req2.input('gstFrStatus',  sql.NVarChar(20),  X.toStr(X.cell(r, headers, 'GST acc Fright Status','GST Freight Status','GST Status')));
        req2.input('freightPerKg', sql.Decimal(18,4), X.toNum(X.cell(r, headers, 'Freight (SGD)/Kg','Freight SGD/Kg','Freight per kg','Freight/Kg')));
        req2.input('totalFF',      sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Total FF Charges','FF Charges','Total Freight Charges')));
        req2.input('invFFCourier', sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Invoice No FF/   Courier','Invoice No FF/ Courier','Invoice No FF/Courier','FF Invoice No','Courier Invoice')));
        req2.input('localCharges', sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Local Charges','Local Chg')));
        req2.input('permitNo',     sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Permit No.','Permit No','Permit Number')));
        req2.input('permitType',   sql.NVarChar(30),  X.toStr(X.cell(r, headers, 'Import Permit /   Local /  Exempt     (drop Shipment)','Import Permit / Local / Exempt (drop Shipment)','Import Permit Type','Permit Type')));
        req2.input('gstClaim',     sql.NVarChar(20),  X.toStr(X.cell(r, headers, 'GST Claimed month','GST Claimed Month','GST Mth','GST Claimed Mth','GST Month','Claimed Month')));
        req2.input('remark',       sql.NVarChar(500), X.toStr(X.cell(r, headers, 'Remark','Remarks','Notes')));
        // Wizard-era columns added 2026-06-17 onward — pulled from Excel
        // when present, NULL otherwise. Lets exports round-trip through
        // /import safely (re-imported file recreates split rows + carton +
        // datecode + lot + net-wt fields).
        req2.input('cartonNo',     sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Carton No','Carton No.','Carton Number','CartonNo')));
        req2.input('datecode',     sql.NVarChar(30),  X.toStr(X.cell(r, headers, 'Datecode','Date Code','Date code')));
        req2.input('lotNo',        sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Lot No','Lot Number','LotNo','Batch No','Batch Number')));
        req2.input('netWeightKg',  sql.Decimal(10,3), X.toNum(X.cell(r, headers, 'Net Wt (kg)','Net Weight','Net Wt','NetWeightKg')));
        req2.input('noOfCartons',  sql.Int,           X.toNum(X.cell(r, headers, 'No. of Cartons','No of Cartons','Cartons Count','NoOfCartons')));
        req2.input('gstByUsFlag',  sql.Bit, (() => {
          const v = X.cell(r, headers, 'GST By Us Flag','GST Paid By Us Flag','GstPaidByUsFlag');
          if (v == null || v === '') return null;
          const s = String(v).trim().toLowerCase();
          return ['1','true','yes','y','on'].includes(s) ? 1 : 0;
        })());
        req2.input('incoterms',    sql.NVarChar(20),  X.toStr(X.cell(r, headers, 'Incoterms','Incoterm')));
        req2.input('qtyReceived',  sql.Decimal(18,4), X.toNum(X.cell(r, headers, 'Received Qty','Received Quantity','Recd Qty','Quantity Received')));
        req2.input('splitSeq',     sql.Int,           X.toNum(X.cell(r, headers, 'Split Seq','SplitSeq','Split Sequence')));
        req2.input('createdBy',    sql.Int,           req.user.id);
        // Detect which post-13 columns exist for defensive insert
        await req2.query(`
          INSERT INTO dbo.BN_WhPurchase
            (Company, PoNo, LineNumber, MatlReceivedDate, SystemNo, PurchaseType,
             InvoiceDate, InvoiceNo, PoReceived, InvoiceValue, BankOtherCharges,
             QuantityReceived,
             Dimension, WeightKg, COO, ReceivedThrough, AirWaybillNo,
             Status, PaidDate, FreightSGD, GSTFreightStatus, FreightSGDPerKg,
             TotalFFCharges, InvoiceNoFFCourier, LocalCharges, PermitNo,
             ImportPermitType, GSTClaimedMonth, Remark,
             Incoterms, Datecode, LotNo, NetWeightKg, GstPaidByUsFlag, NoOfCartons, CartonNo, SplitSeq,
             CreatedBy)
          VALUES
            (@co, @poNo, @lineNumber, @matlRecvDate, @systemNo, @purchaseType,
             @invDate, @invNo, @poReceived, @invValue, @bankCharges,
             @qtyReceived,
             @dim, @weight, @coo, @rcvThrough, @awb,
             @status, @paidDate, @freightSgd, @gstFrStatus, @freightPerKg,
             @totalFF, @invFFCourier, @localCharges, @permitNo,
             @permitType, @gstClaim, @remark,
             @incoterms, @datecode, @lotNo, @netWeightKg, @gstByUsFlag, @noOfCartons, @cartonNo, @splitSeq,
             @createdBy);`);
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
    console.error('POST /warehouse/purchase/import error:', err.message);
    res.status(500).json({ message: 'Import failed', error: err.message });
  }
});

// ── GET /api/warehouse/purchase/export ────────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co', sql.NVarChar(10), COMPANY);
    let where = 'WHERE Company = @co AND IsActive = 1';
    if (req.query.search) {
      r.input('q', sql.NVarChar(200), '%' + req.query.search + '%');
      where += ' AND (PoNo LIKE @q OR InvoiceNo LIKE @q OR SystemNo LIKE @q OR AirWaybillNo LIKE @q OR PermitNo LIKE @q)';
    }
    if (req.query.status && req.query.status !== 'all') {
      r.input('st', sql.NVarChar(20), req.query.status); where += ' AND Status = @st';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom || '')) {
      r.input('df', sql.Date, toLocalDate(req.query.dateFrom)); where += ' AND MatlReceivedDate >= @df';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo || '')) {
      r.input('dt', sql.Date, toLocalDate(req.query.dateTo)); where += ' AND MatlReceivedDate <= @dt';
    }
    // ORDER must match home table clustering so merge runs line up:
    // MatlReceivedDate DESC → InvoiceNo → PoNo → LineNumber → Id.
    const rows = (await r.query(`
      SELECT * FROM dbo.BN_WhPurchase ${where}
      ORDER BY MatlReceivedDate DESC, ISNULL(InvoiceNo, ''), PoNo, LineNumber, Id;`)).recordset;
    // Enrich with NAV joins + add computed Outstanding so export carries
    // the same data the user sees on the home table.
    const enriched = (await enrichWithNav(rows)).map(r => ({
      ...r,
      OutstandingQuantity: Number(r.Quantity || 0) - Number(r.QuantityReceived || 0),
    }));
    // Columns mirror the home table ordering as closely as possible. Each
    // split row exports as its own Excel row so the file is round-trip safe
    // through /import (no merged "CTN-A · CTN-B" cells to re-parse).
    const buf = X.buildXlsx(enriched, [
      { key: 'MatlReceivedDate',  label: 'Matrl. Received Date', type: 'date' },
      { key: 'SystemNo',          label: 'System No.' },
      { key: 'PurchaseType',      label: 'Purchase / Expences' },
      { key: 'InvoiceDate',       label: 'Invoice Date', type: 'date' },
      { key: 'InvoiceNo',         label: 'Invoice No' },
      { key: 'CartonNo',          label: 'Carton No' },
      { key: 'SupplierName',      label: 'Supplier Name' },
      { key: 'PoNo',              label: 'CompanyB Po No' },
      { key: 'LineNumber',        label: 'Line No' },
      { key: 'SplitSeq',          label: 'Split Seq' },
      { key: 'PoReceived',        label: 'Po Received' },
      { key: 'VendorItemNo',      label: 'Vendor Item No' },
      { key: 'ItemNo',            label: 'Item No' },
      { key: 'ItemName',          label: 'Item Name' },
      { key: 'Make',              label: 'Make' },
      { key: 'Quantity',          label: 'Total Quantity' },
      { key: 'QuantityReceived',  label: 'Received Qty' },
      { key: 'OutstandingQuantity', label: 'Outstanding Qty' },
      { key: 'Rate',              label: 'Rate' },
      { key: 'BaseTotal',         label: 'Base Total' },
      { key: 'ItemWiseValue',     label: 'Item Wise Value' },
      { key: 'BankOtherCharges',  label: 'Bank/Other Chg' },
      { key: 'GstPaidByUs',       label: 'GST By Us' },
      { key: 'GstPaidBySupplier', label: 'GST By Supp' },
      { key: 'NetInvoiceValue',   label: 'Net Inv Value' },
      { key: 'Status',            label: 'Status' },
      { key: 'Dimension',         label: 'Diamension' },
      { key: 'WeightKg',          label: 'Weight' },
      { key: 'COO',               label: 'COO' },
      { key: 'ReceivedThrough',   label: 'Received Through' },
      { key: 'AirWaybillNo',      label: 'Air Waybill No.' },
      { key: 'Currency',          label: 'Currency' },
      { key: 'PaymentTerms',      label: 'Payment Terms' },
      { key: 'PaidDate',          label: 'Paid Date', type: 'date' },
      { key: 'FreightSGD',        label: 'Freight (SGD)' },
      { key: 'GstAccFreight',     label: 'GST acc Fright' },
      { key: 'GSTFreightStatus',  label: 'Fright Status' },
      { key: 'FreightSGDPerKg',   label: 'Freight/Kg' },
      { key: 'TotalFFCharges',    label: 'Total FF' },
      { key: 'InvoiceNoFFCourier',label: 'FF/Courier Inv' },
      { key: 'LocalCharges',      label: 'Local Chg' },
      { key: 'PermitNo',          label: 'Permit No.' },
      { key: 'ImportPermitType',  label: 'Import Permit Type' },
      { key: 'GSTClaimedMonth',   label: 'GST Claimed Mth' },
      { key: 'Incoterms',         label: 'Incoterms' },
      { key: 'Datecode',          label: 'Datecode' },
      { key: 'LotNo',             label: 'Lot No' },
      { key: 'NetWeightKg',       label: 'Net Wt (kg)' },
      { key: 'NoOfCartons',       label: 'No. of Cartons' },
      { key: 'GstPaidByUsFlag',   label: 'GST By Us Flag' },
      { key: 'Remark',            label: 'Remark' },
    ], 'Purchase', {
      // Mirror home table cell-merge — Invoice/Supplier merge globally,
      // Carton/Dimension/WeightKg merge only within same Invoice. Sort
      // already clusters by (MatlReceivedDate, InvoiceNo, PoNo, LineNumber)
      // via the home GET / ORDER BY — but the export query has its own
      // ORDER BY, so we need to add InvoiceNo there too:
      mergeKeys:     ['InvoiceNo', 'SupplierName', 'CartonNo', 'Dimension', 'WeightKg'],
      mergeScopeKey: 'InvoiceNo',
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Purchase_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('GET /warehouse/purchase/export error:', err.message);
    res.status(500).json({ message: 'Export failed', error: err.message });
  }
});

module.exports = router;
