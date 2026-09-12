// =====================================================================
// modules/warehouse/routes/stocks.js — Carton-level inventory (Company B SG)
//
// Pure-manual ledger. Each row = one carton in the Singapore warehouse.
// Defaults can be pre-filled from BN_WhPurchase if the user enters an
// InvoiceNo that matches an existing purchase line — but once written,
// the BN_WhStock row stands on its own (so warehouse can correct typos
// or carton-split without rewriting NAV-linked purchase data).
//
// Aging is computed server-side on every read:
//   AgingDays = DATEDIFF(DAY, InwordDate, GETDATE())   if still in stock
//   AgingDays = DATEDIFF(DAY, InwordDate, DispatchedDate) if dispatched
//
// Auth: warehouse=CRUD, isFullAccess=READ.
// =====================================================================

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { sql, getPool, getAppPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const X = require('../_excel');

const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const COMPANY    = 'COMPANYB';
const NAV_PREFIX = '[dbo].[Company B Pte Ltd_$';

function isWarehouseRole(user) {
  return ((user && user.role) || '').toLowerCase().trim() === 'warehouse';
}
function canRead(user)  { return isWarehouseRole(user) || isFullAccess(user); }
function canWrite(user) { return isWarehouseRole(user); }

// ── GET /api/warehouse/stocks  (NAV-FIRST view) ────────────────────────
// Source rows = NAV [Item Ledger Entry] filtered to currently-on-hand
// purchase entries (Entry Type=0 Purchase, Open=1, Remaining Quantity>0).
// JOINed to [Item] for description + Value Entry for unit cost, then
// LEFT JOINed to BN_WhStock for the warehouse lead's manual carton tracking.
router.get('/', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const search   = (req.query.search   || '').trim();
    const tracked  = (req.query.tracked  || 'all').trim().toLowerCase();
    const location = (req.query.location || '').trim();
    const dateFrom = (req.query.dateFrom || '').trim();
    const dateTo   = (req.query.dateTo   || '').trim();
    const days     = Math.min(7300, Math.max(1, parseInt(req.query.days || '365', 10)));
    const page     = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit    = Math.min(500, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset   = (page - 1) * limit;

    const navPool = await getPool();
    const r = navPool.request();
    r.input('co',     sql.NVarChar(10), COMPANY);
    r.input('offset', sql.Int, offset);
    r.input('limit',  sql.Int, limit);
    r.input('days',   sql.Int, days);

    let dateWhere = 'ile.[Posting Date] >= DATEADD(DAY, -@days, CAST(SYSDATETIME() AS DATE))';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      r.input('df', sql.Date, dateFrom);
      dateWhere = 'ile.[Posting Date] >= @df';
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        r.input('dt', sql.Date, dateTo);
        dateWhere += ' AND ile.[Posting Date] <= @dt';
      }
    }

    let searchWhere = '';
    if (search) {
      r.input('q', sql.NVarChar(200), '%' + search + '%');
      searchWhere = ` AND (ile.[Item No_] LIKE @q OR ISNULL(i.[Description],'') LIKE @q
                        OR ile.[Document No_] LIKE @q OR ISNULL(bn.CartonNo,'') LIKE @q
                        OR ISNULL(bn.CustomerName,'') LIKE @q)`;
    }
    let locWhere = '';
    if (location) {
      r.input('loc', sql.NVarChar(50), location);
      locWhere = ` AND (ile.[Location Code] = @loc OR ISNULL(bn.NewLocation,'') = @loc)`;
    }
    let trackedWhere = '';
    if (tracked === 'yes') trackedWhere = ' AND bn.Id IS NOT NULL';
    else if (tracked === 'no') trackedWhere = ' AND bn.Id IS NULL';

    // Carton-FIRST list. Each row = either:
    //   • One active BN_WhStock row (carton tracked by Amit) — LEFT JOIN to NAV
    //     ILE for live NAV item / qty / location / cost data, OR
    //   • One NAV ILE entry with NO matching BN_WhStock carton ("untracked")
    //     so Amit can click + Add tracking to start a new carton.
    // This 1:N expansion is what makes the Split workflow work: when Amit
    // splits one carton into 3, the list shows 3 rows for that same NAV ILE.
    const result = await r.query(`
      WITH NavIle AS (
        SELECT
          ile.[Entry No_]                AS IleEntryNo,
          -- Internal NAV item code (e.g. TDKMIC0076) — kept for reference
          ile.[Item No_]                 AS NavItemCode,
          -- MPN per user's mapping = Item.[Vendor Item No_] (the supplier's
          -- own part number Amit knows, e.g. HAL1504UA-A-2-B-1-39-HASX-030H).
          -- Falls back to internal code if Vendor Item No is blank.
          ISNULL(NULLIF(i.[Vendor Item No_], ''), ile.[Item No_]) AS NavItemNo,
          ISNULL(i.[Description],'')     AS NavItemName,
          -- Make per user's mapping = Item.[Global Dimension 2 Code]
          -- (e.g. "TDK MICRO", "ZHEJIANG JINJIA"). The previous source was
          -- Description 2 which is empty on most Items.
          ISNULL(i.[Global Dimension 2 Code], '') AS NavMake,
          ile.[Posting Date]             AS NavInwordDate,
          ile.[Location Code]            AS NavLocation,
          ile.[Document No_]             AS NavInvoiceNo,
          ile.[Quantity]                 AS NavQtyOriginal,
          ile.[Remaining Quantity]       AS NavQtyRemaining,
          ile.[Country_Region Code]      AS NavOrigin,
          DATEDIFF(DAY, ile.[Posting Date], CAST(SYSDATETIME() AS DATE)) AS NavAgingDays,
          (SELECT TOP 1 ve.[Cost per Unit] FROM ${NAV_PREFIX}Value Entry] ve
             WHERE ve.[Item Ledger Entry No_] = ile.[Entry No_]
             ORDER BY ve.[Entry No_]) AS NavUnitCost
        FROM ${NAV_PREFIX}Item Ledger Entry] ile
        LEFT JOIN ${NAV_PREFIX}Item] i ON i.[No_] = ile.[Item No_]
        WHERE ile.[Entry Type] = 0 AND ile.[Open] = 1 AND ile.[Remaining Quantity] > 0
      ),
      Cartons AS (
        -- Every active BN_WhStock row → one carton row. LEFT JOIN to NavIle
        -- so cartons without an ILE link (the warehouse lead's imported Excel rows where
        -- IleEntryNo is still NULL) still appear, just without NAV enrichment.
        -- COLLATE DATABASE_DEFAULT on every BN string column in COALESCE
        -- because BizNAV_App is SQL_Latin1_General_CP1_CI_AS and NAV is
        -- Latin1_General_100_CS_AS — without coercion COALESCE errors out.
        SELECT
          bn.Id AS BnId, bn.IleEntryNo,
          -- MPN priority:
          --   1. the warehouse lead's typed MPN — only if it's NOT just the internal NAV code default
          --      (older rows saved that, before we switched to Vendor Item No)
          --   2. NAV's Item.[Vendor Item No_] — the warehouse lead's real supplier part no
          --   3. NAV's internal code (fallback)
          COALESCE(
            NULLIF(bn.MPN COLLATE DATABASE_DEFAULT, ni.NavItemCode COLLATE DATABASE_DEFAULT),
            ni.NavItemNo COLLATE DATABASE_DEFAULT,
            ni.NavItemCode COLLATE DATABASE_DEFAULT
          )                                                                                           AS ItemNo,
          COALESCE(ni.NavItemName COLLATE DATABASE_DEFAULT, '')                                       AS ItemName,
          COALESCE(ni.NavMake COLLATE DATABASE_DEFAULT, bn.Make COLLATE DATABASE_DEFAULT, '')         AS Make,
          COALESCE(bn.InwordDate, ni.NavInwordDate)                                                   AS InwordDate,
          COALESCE(bn.Location COLLATE DATABASE_DEFAULT, ni.NavLocation COLLATE DATABASE_DEFAULT, '') AS Location,
          COALESCE(bn.InvoiceNo COLLATE DATABASE_DEFAULT, ni.NavInvoiceNo COLLATE DATABASE_DEFAULT)   AS InvoiceNo,
          ni.NavQtyOriginal                                                                           AS QtyOriginal,
          ni.NavQtyRemaining                                                                          AS QtyRemaining,
          COALESCE(bn.Origin COLLATE DATABASE_DEFAULT, ni.NavOrigin COLLATE DATABASE_DEFAULT, '')     AS Origin,
          CASE WHEN bn.InwordDate IS NOT NULL
            THEN DATEDIFF(DAY, bn.InwordDate, CAST(SYSDATETIME() AS DATE))
            ELSE ni.NavAgingDays END                 AS AgingDays,
          COALESCE(bn.PurchasePrice, ni.NavUnitCost) AS UnitCost,
          bn.SN, bn.CartonNo, bn.NewLocation, bn.MPN,
          bn.QtyPcs, bn.Dimension, bn.WeightKg, bn.DateCode,
          bn.PurchasePrice, bn.PurchaseAmount, bn.CustResale, bn.CustResaleAmount,
          bn.CustomerName, bn.FranchiseType,
          bn.Status, bn.DispatchedDate, bn.Remark, bn.Package, bn.ItemType,
          bn.Legend, bn.Meaning, bn.SplitFromId,
          -- Show "split from C-XXXX" by joining BACK to BN_WhStock on SplitFromId
          (SELECT TOP 1 src.CartonNo FROM BizNAV_App.dbo.BN_WhStock src
             WHERE src.Id = bn.SplitFromId) AS SplitFromCarton,
          -- Source PO link (migration 19) — set by the Purchase page's
          -- "Received Material" auto-link flow. Lets UI show "↳ from PO ABC L30000".
          bn.SourcePoNo, bn.SourcePoLine,
          1 AS IsCarton
        FROM BizNAV_App.dbo.BN_WhStock bn
        LEFT JOIN NavIle ni
          ON ni.IleEntryNo = bn.IleEntryNo
        WHERE bn.Company COLLATE DATABASE_DEFAULT = @co COLLATE DATABASE_DEFAULT
          AND bn.IsActive = 1
      ),
      UntrackedIle AS (
        -- NAV ILE rows that have NO active BN_WhStock carton yet → one
        -- "NAV-only" row per ILE so Amit can click + Add tracking.
        SELECT
          CAST(NULL AS INT) AS BnId, ni.IleEntryNo,
          ni.NavItemNo                   AS ItemNo,
          ni.NavItemName                 AS ItemName,
          ni.NavMake                     AS Make,
          ni.NavInwordDate               AS InwordDate,
          ni.NavLocation                 AS Location,
          ni.NavInvoiceNo                AS InvoiceNo,
          ni.NavQtyOriginal              AS QtyOriginal,
          ni.NavQtyRemaining             AS QtyRemaining,
          ni.NavOrigin                   AS Origin,
          ni.NavAgingDays                AS AgingDays,
          ni.NavUnitCost                 AS UnitCost,
          NULL AS SN, NULL AS CartonNo, NULL AS NewLocation, NULL AS MPN,
          NULL AS QtyPcs, NULL AS Dimension, NULL AS WeightKg, NULL AS DateCode,
          NULL AS PurchasePrice, NULL AS PurchaseAmount, NULL AS CustResale, NULL AS CustResaleAmount,
          NULL AS CustomerName, NULL AS FranchiseType,
          NULL AS Status, NULL AS DispatchedDate, NULL AS Remark, NULL AS Package,
          NULL AS ItemType, NULL AS Legend, NULL AS Meaning,
          NULL AS SplitFromId, NULL AS SplitFromCarton,
          NULL AS SourcePoNo, NULL AS SourcePoLine,
          0 AS IsCarton
        FROM NavIle ni
        WHERE NOT EXISTS (
          SELECT 1 FROM BizNAV_App.dbo.BN_WhStock bn
          WHERE bn.IsActive = 1
            AND bn.Company COLLATE DATABASE_DEFAULT = @co COLLATE DATABASE_DEFAULT
            AND bn.IleEntryNo = ni.IleEntryNo
        )
      ),
      Combined AS (
        SELECT * FROM Cartons
        UNION ALL
        SELECT * FROM UntrackedIle
      ),
      Filtered AS (
        SELECT
          c.BnId, c.IleEntryNo, c.ItemNo, c.ItemName, c.Make,
          c.InwordDate, c.Location, c.InvoiceNo,
          c.QtyOriginal, c.QtyRemaining, c.Origin, c.AgingDays, c.UnitCost,
          c.SN, c.CartonNo, c.NewLocation, c.MPN,
          c.QtyPcs, c.Dimension, c.WeightKg, c.DateCode,
          c.PurchasePrice, c.PurchaseAmount, c.CustResale, c.CustResaleAmount,
          c.CustomerName, c.FranchiseType,
          c.Status, c.DispatchedDate, c.Remark, c.Package, c.ItemType,
          c.Legend, c.Meaning, c.SplitFromId, c.SplitFromCarton,
          c.SourcePoNo, c.SourcePoLine,
          c.IsCarton,
          -- Display qty: the warehouse lead's QtyPcs for cartons, else NAV's Remaining
          CASE WHEN c.IsCarton = 1 THEN ISNULL(c.QtyPcs, 0)
               ELSE ISNULL(c.QtyRemaining, 0) END AS QtyDisplay
        FROM Combined c
        WHERE 1 = 1
          AND (c.InwordDate IS NULL OR ${dateWhere.replace(/ile\.\[Posting Date\]/g, 'c.InwordDate')})
          ${searchWhere
              .replace(/ile\.\[Item No_\]/g, 'c.ItemNo')
              .replace(/i\.\[Description\]/g, 'c.ItemName')
              .replace(/ile\.\[Document No_\]/g, 'c.InvoiceNo')
              .replace(/bn\.CartonNo/g, 'c.CartonNo')
              .replace(/bn\.CustomerName/g, 'c.CustomerName')}
          ${locWhere
              .replace(/ile\.\[Location Code\]/g, 'c.Location')
              .replace(/bn\.NewLocation/g, 'c.NewLocation')}
          ${trackedWhere
              .replace(/bn\.Id IS NOT NULL/g, 'c.BnId IS NOT NULL')
              .replace(/bn\.Id IS NULL/g,    'c.BnId IS NULL')}
      )
      SELECT *, COUNT(*) OVER () AS TotalRows,
        SUM(ISNULL(QtyDisplay, 0)) OVER () AS TotalQtyRemaining,
        SUM(ISNULL(QtyDisplay, 0) * ISNULL(UnitCost, 0)) OVER () AS TotalStockValue
      FROM Filtered
      ORDER BY InwordDate DESC, IleEntryNo DESC, BnId
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);
    const rows = result.recordset || [];
    const enriched = rows.map(row => ({
      ...row,
      Id: row.BnId,
      IsTracked: row.BnId != null,
    }));
    res.json({
      data: enriched,
      total:              rows.length > 0 ? rows[0].TotalRows : 0,
      totalQtyRemaining:  rows.length > 0 ? Number(rows[0].TotalQtyRemaining || 0) : 0,
      totalStockValue:    rows.length > 0 ? Number(rows[0].TotalStockValue || 0) : 0,
      page, limit,
    });
  } catch (err) {
    console.error('GET /warehouse/stocks error:', err.message);
    res.status(500).json({ message: 'Failed to list stock', error: err.message });
  }
});

// ── GET /api/warehouse/stocks/carton-list ──────────────────────────────
// Returns ALL existing carton numbers (deduped) so the frontend can populate
// a <datalist> for the Carton No combobox — Amit picks an existing carton
// (e.g. "12944") to record an additional movement, or types a new one.
router.get('/carton-list', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('co', sql.NVarChar(10), COMPANY).query(`
      SELECT DISTINCT TOP 5000 CartonNo
      FROM dbo.BN_WhStock
      WHERE Company = @co AND IsActive = 1 AND NULLIF(LTRIM(RTRIM(CartonNo)), '') IS NOT NULL
      ORDER BY CartonNo;`);
    res.json({ data: r.recordset.map(x => x.CartonNo) });
  } catch (err) {
    console.error('GET /warehouse/stocks/carton-list error:', err.message);
    res.status(500).json({ message: 'Carton list fetch failed', error: err.message });
  }
});

// ── GET /api/warehouse/stocks/location-list ────────────────────────────
// All distinct NewLocation values currently in BN_WhStock — feeds the
// Location combobox in the Stocks page + Receive-to-Stocks modal so Amit
// can pick "same place as the other cartons of this item" or type a new
// location.
router.get('/location-list', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('co', sql.NVarChar(10), COMPANY).query(`
      SELECT DISTINCT TOP 2000 NewLocation
      FROM dbo.BN_WhStock
      WHERE Company = @co AND IsActive = 1
        AND NULLIF(LTRIM(RTRIM(NewLocation)), '') IS NOT NULL
      ORDER BY NewLocation;`);
    res.json({ data: r.recordset.map(x => x.NewLocation) });
  } catch (err) {
    console.error('GET /warehouse/stocks/location-list error:', err.message);
    res.status(500).json({ message: 'Location list fetch failed', error: err.message });
  }
});

// ── GET /api/warehouse/stocks/by-mpn/:mpn ──────────────────────────────
// Returns existing active cartons whose MPN matches the requested item.
// Used by the "Add Received Material to Stocks" modal to show Amit what's
// already in stock for this part — so he can decide whether to add to an
// existing carton/location manually on the Stocks page, or create new
// cartons here. No auto-merge, no auto-decide — just informational.
router.get('/by-mpn/:mpn', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const mpn = (req.params.mpn || '').trim();
    if (!mpn) return res.json({ data: [] });
    const pool = await getAppPool();
    const r = await pool.request()
      .input('co',  sql.NVarChar(10), COMPANY)
      .input('mpn', sql.NVarChar(100), mpn)
      .query(`
        SELECT TOP 50
          Id, CartonNo, NewLocation, Location, QtyPcs, InvoiceNo,
          Status, InwordDate, CustomerName, SourcePoNo, SourcePoLine
        FROM dbo.BN_WhStock
        WHERE Company = @co AND IsActive = 1
          AND MPN = @mpn
        ORDER BY InwordDate DESC, Id DESC;
      `);
    res.json({ data: r.recordset });
  } catch (err) {
    console.error('GET /warehouse/stocks/by-mpn error:', err.message);
    res.status(500).json({ message: 'By-MPN lookup failed', error: err.message });
  }
});

// ── GET /api/warehouse/stocks/by-invoice/:invoiceNo ────────────────────
// Pre-fill helper: when the warehouse user types an InvoiceNo in the Add
// form, look up that invoice's MPN/Make/Origin/Price from BN_WhPurchase
// so the form auto-populates. Falls back to {} if not found.
router.get('/by-invoice/:invoiceNo', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getAppPool();
    const r = await pool.request()
      .input('co',  sql.NVarChar(10), COMPANY)
      .input('inv', sql.NVarChar(50), req.params.invoiceNo)
      .query(`
        SELECT TOP 1
          PoNo, LineNumber, MatlReceivedDate, COO, Dimension, WeightKg,
          InvoiceValue, InvoiceDate
        FROM dbo.BN_WhPurchase
        WHERE Company = @co AND InvoiceNo = @inv AND IsActive = 1
        ORDER BY Id DESC;
      `);
    res.json({ data: r.recordset[0] || null });
  } catch (err) {
    console.error('GET /warehouse/stocks/by-invoice error:', err.message);
    res.status(500).json({ message: 'Lookup failed', error: err.message });
  }
});

// ── GET /api/warehouse/stocks/:id ──────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
    const pool = await getAppPool();
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('co', sql.NVarChar(10), COMPANY)
      .query(`
        SELECT *,
          CASE
            WHEN InwordDate IS NULL THEN NULL
            WHEN DispatchedDate IS NOT NULL THEN DATEDIFF(DAY, InwordDate, DispatchedDate)
            ELSE DATEDIFF(DAY, InwordDate, GETDATE())
          END AS AgingDays
        FROM dbo.BN_WhStock
        WHERE Id = @id AND Company = @co;
      `);
    if (!r.recordset.length) return res.status(404).json({ message: 'Stock not found' });
    res.json({ data: r.recordset[0] });
  } catch (err) {
    console.error('GET /warehouse/stocks/:id error:', err.message);
    res.status(500).json({ message: 'Failed to fetch stock', error: err.message });
  }
});

// ── POST /api/warehouse/stocks ─────────────────────────────────────────
// UPSERT on (Company, IleEntryNo) — Amit picks a NAV Item Ledger Entry
// (current on-hand stock) and saves his manual carton tracking.
router.post('/', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const b = req.body || {};
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co',           sql.NVarChar(10),  COMPANY);
    r.input('ileEntryNo',   sql.Int,           b.IleEntryNo != null ? Number(b.IleEntryNo) : null);
    r.input('sn',           sql.Int,           b.SN != null ? Number(b.SN) : null);
    r.input('carton',       sql.NVarChar(50),  b.CartonNo || null);
    r.input('invNo',        sql.NVarChar(50),  b.InvoiceNo || null);
    r.input('newLoc',       sql.NVarChar(50),  b.NewLocation || null);
    r.input('loc',          sql.NVarChar(50),  b.Location || null);
    r.input('mpn',          sql.NVarChar(100), b.MPN || null);
    r.input('make',         sql.NVarChar(100), b.Make || null);
    r.input('qty',          sql.Int,           b.QtyPcs != null ? Number(b.QtyPcs) : null);
    r.input('dim',          sql.NVarChar(50),  b.Dimension || null);
    r.input('wt',           sql.Decimal(10,3), b.WeightKg != null ? Number(b.WeightKg) : null);
    r.input('origin',       sql.NVarChar(100), b.Origin || null);
    r.input('dateCode',     sql.NVarChar(50),  b.DateCode || null);
    r.input('inwordDt',     sql.Date,          b.InwordDate || null);
    r.input('purPrice',     sql.Decimal(18,4), b.PurchasePrice != null ? Number(b.PurchasePrice) : null);
    r.input('purAmt',       sql.Decimal(18,2), b.PurchaseAmount != null ? Number(b.PurchaseAmount) : null);
    r.input('custResale',   sql.Decimal(18,4), b.CustResale != null ? Number(b.CustResale) : null);
    r.input('custResaleAmt',sql.Decimal(18,2), b.CustResaleAmount != null ? Number(b.CustResaleAmount) : null);
    r.input('customer',     sql.NVarChar(200), b.CustomerName || null);
    r.input('franchise',    sql.NVarChar(10),  b.FranchiseType || null);
    r.input('status',       sql.NVarChar(20),  b.Status || 'Stock');
    r.input('dispatchedDt', sql.Date,          b.DispatchedDate || null);
    r.input('remark',       sql.NVarChar(500), b.Remark || null);
    r.input('package',      sql.NVarChar(50),  b.Package || null);
    r.input('itemType',     sql.NVarChar(50),  b.ItemType || null);
    r.input('legend',       sql.NVarChar(50),  b.Legend || null);
    r.input('meaning',      sql.NVarChar(100), b.Meaning || null);
    r.input('createdBy',    sql.Int,           req.user.id);

    const result = await r.query(`
      MERGE dbo.BN_WhStock AS tgt
      USING (SELECT @co AS Company, @ileEntryNo AS IleEntryNo) AS src
        ON  tgt.Company    = src.Company
        AND tgt.IleEntryNo = src.IleEntryNo
        AND tgt.IsActive   = 1
      WHEN MATCHED THEN UPDATE SET
        SN = @sn, CartonNo = @carton, InvoiceNo = @invNo,
        NewLocation = @newLoc, Location = @loc,
        MPN = @mpn, Make = @make, QtyPcs = @qty, Dimension = @dim,
        WeightKg = @wt, Origin = @origin, DateCode = @dateCode,
        InwordDate = @inwordDt, PurchasePrice = @purPrice, PurchaseAmount = @purAmt,
        CustResale = @custResale, CustResaleAmount = @custResaleAmt,
        CustomerName = @customer, FranchiseType = @franchise,
        Status = @status, DispatchedDate = @dispatchedDt,
        Remark = @remark, Package = @package, ItemType = @itemType,
        Legend = @legend, Meaning = @meaning, UpdatedAt = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (Company, IleEntryNo, SN, CartonNo, InvoiceNo, NewLocation, Location,
         MPN, Make, QtyPcs, Dimension, WeightKg, Origin,
         DateCode, InwordDate, PurchasePrice, PurchaseAmount,
         CustResale, CustResaleAmount, CustomerName, FranchiseType,
         Status, DispatchedDate, Remark, Package, ItemType, Legend, Meaning,
         CreatedBy)
      VALUES
        (@co, @ileEntryNo, @sn, @carton, @invNo, @newLoc, @loc,
         @mpn, @make, @qty, @dim, @wt, @origin,
         @dateCode, @inwordDt, @purPrice, @purAmt,
         @custResale, @custResaleAmt, @customer, @franchise,
         @status, @dispatchedDt, @remark, @package, @itemType, @legend, @meaning,
         @createdBy)
      OUTPUT $action AS Action, INSERTED.Id AS Id;
    `);
    const out = result.recordset[0] || {};
    res.status(out.Action === 'INSERT' ? 201 : 200).json({
      ok: true, Id: out.Id, action: out.Action,
    });
  } catch (err) {
    console.error('POST /warehouse/stocks error:', err.message);
    res.status(500).json({ message: 'Failed to save stock', error: err.message });
  }
});

// ── PUT /api/warehouse/stocks/:id ──────────────────────────────────────
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
    r.input('sn',           sql.Int,           b.SN != null ? Number(b.SN) : null);
    r.input('carton',       sql.NVarChar(50),  b.CartonNo || null);
    r.input('invNo',        sql.NVarChar(50),  b.InvoiceNo || null);
    r.input('newLoc',       sql.NVarChar(50),  b.NewLocation || null);
    r.input('loc',          sql.NVarChar(50),  b.Location || null);
    r.input('mpn',          sql.NVarChar(100), b.MPN || null);
    r.input('make',         sql.NVarChar(100), b.Make || null);
    r.input('qty',          sql.Int,           b.QtyPcs != null ? Number(b.QtyPcs) : null);
    r.input('dim',          sql.NVarChar(50),  b.Dimension || null);
    r.input('wt',           sql.Decimal(10,3), b.WeightKg != null ? Number(b.WeightKg) : null);
    r.input('origin',       sql.NVarChar(100), b.Origin || null);
    r.input('dateCode',     sql.NVarChar(50),  b.DateCode || null);
    r.input('inwordDt',     sql.Date,          b.InwordDate || null);
    r.input('purPrice',     sql.Decimal(18,4), b.PurchasePrice != null ? Number(b.PurchasePrice) : null);
    r.input('purAmt',       sql.Decimal(18,2), b.PurchaseAmount != null ? Number(b.PurchaseAmount) : null);
    r.input('custResale',   sql.Decimal(18,4), b.CustResale != null ? Number(b.CustResale) : null);
    r.input('custResaleAmt',sql.Decimal(18,2), b.CustResaleAmount != null ? Number(b.CustResaleAmount) : null);
    r.input('customer',     sql.NVarChar(200), b.CustomerName || null);
    r.input('franchise',    sql.NVarChar(10),  b.FranchiseType || null);
    r.input('status',       sql.NVarChar(20),  b.Status || null);
    r.input('dispatchedDt', sql.Date,          b.DispatchedDate || null);
    r.input('remark',       sql.NVarChar(500), b.Remark || null);
    r.input('package',      sql.NVarChar(50),  b.Package || null);
    r.input('itemType',     sql.NVarChar(50),  b.ItemType || null);
    r.input('legend',       sql.NVarChar(50),  b.Legend || null);
    r.input('meaning',      sql.NVarChar(100), b.Meaning || null);

    const result = await r.query(`
      UPDATE dbo.BN_WhStock SET
        SN = @sn, CartonNo = @carton, InvoiceNo = @invNo,
        NewLocation = @newLoc, Location = @loc,
        MPN = @mpn, Make = @make, QtyPcs = @qty, Dimension = @dim,
        WeightKg = @wt, Origin = @origin, DateCode = @dateCode,
        InwordDate = @inwordDt, PurchasePrice = @purPrice, PurchaseAmount = @purAmt,
        CustResale = @custResale, CustResaleAmount = @custResaleAmt,
        CustomerName = @customer, FranchiseType = @franchise,
        Status = @status, DispatchedDate = @dispatchedDt,
        Remark = @remark, Package = @package, ItemType = @itemType,
        Legend = @legend, Meaning = @meaning, UpdatedAt = SYSDATETIME()
      WHERE Id = @id AND Company = @co;
      SELECT @@ROWCOUNT AS Updated;
    `);
    if (!result.recordset[0].Updated) return res.status(404).json({ message: 'Stock not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /warehouse/stocks/:id error:', err.message);
    res.status(500).json({ message: 'Failed to update stock', error: err.message });
  }
});

// ── POST /api/warehouse/stocks/:id/split ───────────────────────────────
// Accepts either:
//   { parts: N }              → equal-divide (legacy) — base = floor(qty/N),
//                                remainder goes on the original row.
//   { qtys: [q1, q2, ..., qN] } → manual mode (preferred) — each carton's
//                                exact qty. The first value goes on the
//                                ORIGINAL row, the rest become new sibling
//                                rows. Sum must equal the source qty
//                                (otherwise we return 400 with a sum delta
//                                so the UI can show the mismatch).
//
//   Examples:
//     parts=3 on qty 10000     → original=3334, two new rows of 3333
//     qtys=[5000,3000,2000]    → original=5000, two new rows of 3000 + 2000
//     qtys=[10000,10000,...]   → 10 cartons of exactly 10000 each
router.post('/:id/split', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can split' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });

    const pool = await getAppPool();
    const src = await pool.request()
      .input('id', sql.Int, id)
      .input('co', sql.NVarChar(10), COMPANY)
      .query(`SELECT * FROM dbo.BN_WhStock
              WHERE Id = @id AND Company = @co AND IsActive = 1;`);
    if (!src.recordset.length) return res.status(404).json({ message: 'Source carton not found' });
    const row = src.recordset[0];
    const sourceQty = Number(row.QtyPcs || 0);
    if (sourceQty <= 0) return res.status(400).json({ message: 'Cannot split a row with qty <= 0' });

    // Resolve target qtys — manual mode wins if both supplied
    let qtys = [];
    if (Array.isArray(req.body && req.body.qtys) && req.body.qtys.length >= 2) {
      qtys = req.body.qtys.map(v => Math.floor(Number(v) || 0));
      if (qtys.some(q => q <= 0)) {
        return res.status(400).json({ message: 'All qtys must be positive integers' });
      }
      if (qtys.length > 50) {
        return res.status(400).json({ message: 'Max 50 split pieces at once' });
      }
      const sum = qtys.reduce((a, b) => a + b, 0);
      if (sum !== sourceQty) {
        return res.status(400).json({
          message: `Qty sum mismatch — entered ${sum.toLocaleString()}, source has ${sourceQty.toLocaleString()} (diff ${(sum - sourceQty).toLocaleString()})`,
        });
      }
    } else {
      const parts = parseInt(req.body && req.body.parts, 10);
      if (!Number.isFinite(parts) || parts < 2 || parts > 50) {
        return res.status(400).json({ message: 'Either supply qtys[] (2..50) or parts (2..50)' });
      }
      const base = Math.floor(sourceQty / parts);
      const remainder = sourceQty - base * parts;
      // First entry gets the remainder so the sum stays exact
      qtys = [base + remainder].concat(Array(parts - 1).fill(base));
    }

    const r = pool.request();
    r.input('id',        sql.Int, id);
    r.input('co',        sql.NVarChar(10),  COMPANY);
    r.input('newQty',    sql.Int, qtys[0]);
    r.input('createdBy', sql.Int, req.user.id);
    r.input('inheritIleEntryNo',  sql.Int,           row.IleEntryNo);
    r.input('inheritMPN',         sql.NVarChar(100), row.MPN);
    r.input('inheritMake',        sql.NVarChar(100), row.Make);
    r.input('inheritInvoiceNo',   sql.NVarChar(50),  row.InvoiceNo);
    r.input('inheritOrigin',      sql.NVarChar(100), row.Origin);
    r.input('inheritInwordDt',    sql.Date,          row.InwordDate);
    r.input('inheritPurPrice',    sql.Decimal(18,4), row.PurchasePrice);
    r.input('inheritCustomer',    sql.NVarChar(200), row.CustomerName);
    r.input('inheritStatus',      sql.NVarChar(20),  row.Status || 'Stock');
    r.input('inheritFranchise',   sql.NVarChar(10),  row.FranchiseType);
    r.input('inheritItemType',    sql.NVarChar(50),  row.ItemType);
    // Each child qty as its own parameter
    qtys.slice(1).forEach((q, i) => r.input('childQty' + i, sql.Int, q));

    // Build the INSERT VALUES list once per child
    const childInserts = qtys.slice(1).map((_, i) => `
      INSERT INTO dbo.BN_WhStock
        (Company, IleEntryNo, MPN, Make, InvoiceNo, Origin, InwordDate,
         PurchasePrice, PurchaseAmount, CustomerName, FranchiseType,
         Status, ItemType, QtyPcs, SplitFromId, CreatedBy)
      OUTPUT INSERTED.Id INTO @created(Id)
      VALUES
        (@co, @inheritIleEntryNo, @inheritMPN, @inheritMake, @inheritInvoiceNo,
         @inheritOrigin, @inheritInwordDt, @inheritPurPrice,
         CASE WHEN @inheritPurPrice IS NOT NULL THEN @inheritPurPrice * @childQty${i} ELSE NULL END,
         @inheritCustomer, @inheritFranchise,
         @inheritStatus, @inheritItemType, @childQty${i}, @id, @createdBy);
    `).join('');

    const out = await r.query(`
      BEGIN TRAN;

      UPDATE dbo.BN_WhStock
        SET QtyPcs = @newQty,
            PurchaseAmount = CASE WHEN PurchasePrice IS NOT NULL
              THEN PurchasePrice * @newQty ELSE PurchaseAmount END,
            UpdatedAt = SYSDATETIME()
        WHERE Id = @id AND Company = @co;

      DECLARE @created TABLE (Id INT);
      ${childInserts}

      COMMIT;
      SELECT Id FROM @created;
    `);
    const newIds = (out.recordset || []).map(x => x.Id);
    res.json({
      ok: true,
      originalId: id,
      originalQty: qtys[0],
      childQtys: qtys.slice(1),
      newIds,
      total: qtys.length,
    });
  } catch (err) {
    console.error('POST /warehouse/stocks/:id/split error:', err.message);
    res.status(500).json({ message: 'Split failed', error: err.message });
  }
});

// ── DELETE /api/warehouse/stocks/:id (soft delete) ─────────────────────
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
        UPDATE dbo.BN_WhStock SET IsActive = 0, UpdatedAt = SYSDATETIME()
        WHERE Id = @id AND Company = @co;
        SELECT @@ROWCOUNT AS Deleted;
      `);
    if (!result.recordset[0].Deleted) return res.status(404).json({ message: 'Stock not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /warehouse/stocks/:id error:', err.message);
    res.status(500).json({ message: 'Failed to delete stock', error: err.message });
  }
});

// ── POST /api/warehouse/stocks/import ─────────────────────────────────
router.post('/import', authenticate, upload.single('file'), async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can import' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name = "file")' });
  try {
    const wb = X.xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
    // Try the 'stock' keyword first; if not found AND the workbook only has
    // one sheet (e.g. user exported a single tab named "Sheet1"), use it.
    // Multi-sheet workbooks with no 'stock' match still error so we don't
    // accidentally import the wrong tab.
    let sheetName = X.resolveSheet(wb, 'stock');
    if (!sheetName && wb.SheetNames.length === 1) {
      sheetName = wb.SheetNames[0];
    }
    if (!sheetName) return res.status(400).json({
      message: 'No Stock sheet found. Sheets: ' + wb.SheetNames.join(', ') +
               '. Either rename one to contain "stock", or upload a single-sheet file.'
    });
    const { headers, rows } = X.readSheet(wb, sheetName);
    if (!rows.length) return res.json({ sheet: sheetName, inserted: 0, message: 'Sheet had no data rows' });
    const pool = await getAppPool();
    let wiped = 0;
    if (req.query.wipe === '1' || req.query.wipe === 'true') {
      const w = await pool.request().input('co', sql.NVarChar(10), COMPANY)
        .query(`UPDATE dbo.BN_WhStock SET IsActive=0 WHERE Company=@co AND IsActive=1; SELECT @@ROWCOUNT AS Wiped;`);
      wiped = w.recordset[0].Wiped || 0;
    }
    let inserted = 0; let failed = 0; const errors = [];
    for (const r of rows) {
      try {
        const req2 = pool.request();
        req2.input('co',            sql.NVarChar(10),  COMPANY);
        req2.input('sn',            sql.Int,           X.toInt(X.cell(r, headers, 'SN','Sr No','Sr','#')));
        req2.input('carton',        sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Cartoon No','Carton No','Carton','Carton Number')));
        req2.input('invNo',         sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Invoice_no','Invoice No','Inv No')));
        req2.input('newLoc',        sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'NEW Location','New Location','New Loc')));
        req2.input('loc',           sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Location','Loc','Rack')));
        req2.input('mpn',           sql.NVarChar(100), X.toStr(X.cell(r, headers, 'MPN','Mfr Part No','Manufacturer PN')));
        req2.input('make',          sql.NVarChar(100), X.toStr(X.cell(r, headers, 'Make','Manufacturer','Brand')));
        req2.input('qty',           sql.Int,           X.toInt(X.cell(r, headers, 'Qty Pcs','Qty (Pcs)','Qty','Quantity')));
        req2.input('dim',           sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Dimension Cms','Dimension','Dim')));
        req2.input('wt',            sql.Decimal(10,3), X.toNum(X.cell(r, headers, 'Weight','Weight (Kg)','Wt (Kg)','Wt')));
        req2.input('origin',        sql.NVarChar(100), X.toStr(X.cell(r, headers, 'Origin','COO','Country of Origin')));
        req2.input('dateCode',      sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Date Code','Datecode','DC')));
        req2.input('inwordDt',      sql.Date,          X.toDate(X.cell(r, headers, 'Inword Date','Inward Date','In Date')));
        req2.input('purPrice',      sql.Decimal(18,4), X.toNum(X.cell(r, headers, 'Purchase Price','P Price','Cost Price','Unit Cost')));
        req2.input('purAmt',        sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Purchase Amount','P Amount','Cost Amount')));
        req2.input('custResale',    sql.Decimal(18,4), X.toNum(X.cell(r, headers, 'Cust Resale','Customer Resale','Sale Price','Resale Price')));
        req2.input('custResaleAmt', sql.Decimal(18,2), X.toNum(X.cell(r, headers, 'Cust Resale Amount','Resale Amount','Sale Amount')));
        req2.input('customer',      sql.NVarChar(200), X.toStr(X.cell(r, headers, 'Customer Name','Customer','Cust')));
        req2.input('franchise',     sql.NVarChar(10),  X.toStr(X.cell(r, headers, 'Franchise/Non -Franchise','Franchise/Non-Franchise','Franchise Type','F','Franchise')));
        req2.input('status',        sql.NVarChar(20),  X.toStr(X.cell(r, headers, 'Status')) || 'Stock');
        req2.input('dispatchedDt',  sql.Date,          X.toDate(X.cell(r, headers, 'Dispatched Date','Disp Date','Out Date')));
        req2.input('remark',        sql.NVarChar(500), X.toStr(X.cell(r, headers, 'Remark','Remarks','Notes')));
        req2.input('package',       sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Package','Packing')));
        req2.input('itemType',      sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Type','Item Type')));
        req2.input('legend',        sql.NVarChar(50),  X.toStr(X.cell(r, headers, 'Legend')));
        req2.input('meaning',       sql.NVarChar(100), X.toStr(X.cell(r, headers, 'Meaning')));
        req2.input('createdBy',     sql.Int,           req.user.id);
        await req2.query(`
          INSERT INTO dbo.BN_WhStock
            (Company, SN, CartonNo, InvoiceNo, NewLocation, Location,
             MPN, Make, QtyPcs, Dimension, WeightKg, Origin,
             DateCode, InwordDate, PurchasePrice, PurchaseAmount,
             CustResale, CustResaleAmount, CustomerName, FranchiseType,
             Status, DispatchedDate, Remark, Package, ItemType, Legend, Meaning, CreatedBy)
          VALUES
            (@co, @sn, @carton, @invNo, @newLoc, @loc,
             @mpn, @make, @qty, @dim, @wt, @origin,
             @dateCode, @inwordDt, @purPrice, @purAmt,
             @custResale, @custResaleAmt, @customer, @franchise,
             @status, @dispatchedDt, @remark, @package, @itemType, @legend, @meaning, @createdBy);`);
        inserted++;
      } catch (e) { failed++; if (errors.length < 10) errors.push(e.message); }
    }
    res.json({ ok: true, sheet: sheetName, inserted, failed, wiped, errors });
  } catch (err) {
    console.error('POST /warehouse/stocks/import error:', err.message);
    res.status(500).json({ message: 'Import failed', error: err.message });
  }
});

// ── GET /api/warehouse/stocks/export ──────────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const pool = await getAppPool();
    const r = pool.request();
    r.input('co', sql.NVarChar(10), COMPANY);
    let where = 'WHERE Company = @co AND IsActive = 1';
    if (req.query.search) {
      r.input('q', sql.NVarChar(200), '%' + req.query.search + '%');
      where += ' AND (CartonNo LIKE @q OR InvoiceNo LIKE @q OR MPN LIKE @q OR Make LIKE @q OR CustomerName LIKE @q OR Remark LIKE @q)';
    }
    if (req.query.status && req.query.status !== 'all') {
      r.input('st', sql.NVarChar(20), req.query.status); where += ' AND Status = @st';
    }
    const data = (await r.query(`
      SELECT SN, CartonNo, InvoiceNo, NewLocation, Location, MPN, Make, QtyPcs,
             Dimension, WeightKg, Origin, DateCode, InwordDate,
             PurchasePrice, PurchaseAmount, CustResale, CustResaleAmount,
             CustomerName, FranchiseType, Status, DispatchedDate, Remark
      FROM dbo.BN_WhStock ${where} ORDER BY InwordDate DESC, Id DESC;`)).recordset;
    const buf = X.buildXlsx(data, [
      { key: 'SN',               label: 'SN' },
      { key: 'CartonNo',         label: 'Carton No' },
      { key: 'InvoiceNo',        label: 'Invoice No' },
      { key: 'NewLocation',      label: 'New Location' },
      { key: 'Location',         label: 'Location' },
      { key: 'MPN',              label: 'MPN' },
      { key: 'Make',             label: 'Make' },
      { key: 'QtyPcs',           label: 'Qty (Pcs)' },
      { key: 'Dimension',        label: 'Dimension' },
      { key: 'WeightKg',         label: 'Weight (Kg)' },
      { key: 'Origin',           label: 'Origin' },
      { key: 'DateCode',         label: 'Date Code' },
      { key: 'InwordDate',       label: 'Inword Date', type: 'date' },
      { key: 'PurchasePrice',    label: 'Purchase Price' },
      { key: 'PurchaseAmount',   label: 'Purchase Amount' },
      { key: 'CustResale',       label: 'Cust Resale' },
      { key: 'CustResaleAmount', label: 'Cust Resale Amount' },
      { key: 'CustomerName',     label: 'Customer Name' },
      { key: 'FranchiseType',    label: 'Franchise Type' },
      { key: 'Status',           label: 'Status' },
      { key: 'DispatchedDate',   label: 'Dispatched Date', type: 'date' },
      { key: 'Remark',           label: 'Remark' },
    ], 'Stocks');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Stocks_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('GET /warehouse/stocks/export error:', err.message);
    res.status(500).json({ message: 'Export failed', error: err.message });
  }
});

// ── POST /api/warehouse/stocks/from-po-receipt ────────────────────────
// Auto-creates BN_WhStock cartons from a Purchase Order line when Amit
// marks the row as "Received Material" on the Purchase page.
//
// Body: { PoNo, LineNumber, cartons: [{ CartonNo, QtyPcs, NewLocation? }, ...] }
//
// Server-side: looks up the matching NAV Purchase Line for MPN/Make/Invoice
// + the existing BN_WhPurchase row (if any) for the warehouse lead's manual fields, then
// best-effort matches a NAV ILE entry on (Item No, Document No) so the new
// carton row links into Stocks' NAV-first view. ILE may be NULL during the
// in-transit window — picked up later by the ILE linker. Companion to
// migration 19 (SourcePoNo / SourcePoLine on BN_WhStock).
router.post('/from-po-receipt', authenticate, async (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ message: 'Only warehouse user can write' });
  try {
    const { PoNo, LineNumber, cartons } = req.body || {};
    if (!PoNo || !Number.isFinite(Number(LineNumber))) {
      return res.status(400).json({ message: 'PoNo and LineNumber required' });
    }
    if (!Array.isArray(cartons) || !cartons.length) {
      return res.status(400).json({ message: 'cartons[] required (at least 1 carton)' });
    }
    for (const c of cartons) {
      const q = Number(c.QtyPcs);
      if (!Number.isFinite(q) || q <= 0) {
        return res.status(400).json({ message: 'Every carton needs a positive QtyPcs' });
      }
    }

    const navPool = await getPool();
    const appPool = await getAppPool();

    // Pull NAV Purchase Line context (MPN, Make, supplier-side fields) +
    // BN_WhPurchase carry-over (the warehouse lead's InvoiceNo etc. if he typed it).
    const navRow = (await navPool.request()
      .input('po', sql.NVarChar(50), PoNo)
      .input('ln', sql.Int, Number(LineNumber))
      .query(`
        SELECT TOP 1
          pl.[No_]                                AS NavItemCode,
          NULLIF(pl.[Vendor Item No_], '')        AS NavVendorItemNo,
          NULLIF(pl.[Description], '')            AS NavDescription,
          pl.[Shortcut Dimension 2 Code]          AS NavMake,
          ISNULL(pl.[Direct Unit Cost], 0)        AS NavRate,
          ISNULL(pl.[Unit Cost (LCY)], 0)         AS NavBasePriceLCY,
          ph.[Order Date]                         AS NavOrderDate
        FROM ${NAV_PREFIX}Purchase Line] pl
        LEFT JOIN ${NAV_PREFIX}Purchase Header] ph
          ON ph.[Document Type] = 1 AND ph.[No_] = pl.[Document No_]
        WHERE pl.[Document Type] = 1
          AND pl.[Document No_]  = @po
          AND pl.[Line No_]      = @ln;
      `)).recordset[0];

    if (!navRow) return res.status(404).json({ message: `No NAV Purchase Line for ${PoNo} L${LineNumber}` });

    const bnRow = (await appPool.request()
      .input('co', sql.NVarChar(10), COMPANY)
      .input('po', sql.NVarChar(50), PoNo)
      .input('ln', sql.Int, Number(LineNumber))
      .query(`
        SELECT TOP 1 InvoiceNo, MatlReceivedDate, COO AS Origin
        FROM dbo.BN_WhPurchase
        WHERE Company = @co AND PoNo = @po AND LineNumber = @ln AND IsActive = 1
        ORDER BY Id DESC;
      `)).recordset[0];

    // Best-effort ILE lookup: match (Item No_, Document No_) where
    // Document No_ is the matching Purchase Receipt No (one PO can produce
    // multiple receipt docs over time). May return NULL — that's OK; linker
    // script will fill it later when Pune posts the receipt.
    let ileEntryNo = null;
    if (bnRow?.InvoiceNo) {
      const ileRow = (await navPool.request()
        .input('itm', sql.NVarChar(50), navRow.NavItemCode)
        .input('doc', sql.NVarChar(50), bnRow.InvoiceNo)
        .query(`
          SELECT TOP 1 [Entry No_] AS IleEntryNo
          FROM ${NAV_PREFIX}Item Ledger Entry]
          WHERE [Item No_] = @itm AND [Document No_] = @doc
            AND [Entry Type] = 0 AND ISNULL([Remaining Quantity], 0) > 0
          ORDER BY [Entry No_];
        `)).recordset[0];
      ileEntryNo = ileRow ? ileRow.IleEntryNo : null;
    }

    const mpn      = navRow.NavVendorItemNo || navRow.NavItemCode || null;
    const make     = (navRow.NavMake || '').trim() || null;
    const invNo    = bnRow?.InvoiceNo || null;
    const origin   = bnRow?.Origin    || null;
    const inwordDt = bnRow?.MatlReceivedDate || navRow.NavOrderDate || null;
    const purPrice = Number(navRow.NavBasePriceLCY) || null;

    const insertedIds = [];
    for (const c of cartons) {
      const cartonNo = (c.CartonNo || '').trim() || null;
      const qty      = Math.round(Number(c.QtyPcs));
      const newLoc   = (c.NewLocation || '').trim() || null;
      const purAmt   = purPrice != null ? +(purPrice * qty).toFixed(2) : null;

      const r = appPool.request();
      r.input('co',       sql.NVarChar(10),  COMPANY);
      r.input('ile',      sql.Int,           ileEntryNo);
      r.input('carton',   sql.NVarChar(50),  cartonNo);
      r.input('invNo',    sql.NVarChar(50),  invNo);
      r.input('newLoc',   sql.NVarChar(50),  newLoc);
      r.input('mpn',      sql.NVarChar(100), mpn);
      r.input('make',     sql.NVarChar(100), make);
      r.input('qty',      sql.Int,           qty);
      r.input('origin',   sql.NVarChar(100), origin);
      r.input('inwordDt', sql.Date,          inwordDt);
      r.input('purPrice', sql.Decimal(18,4), purPrice);
      r.input('purAmt',   sql.Decimal(18,2), purAmt);
      r.input('status',   sql.NVarChar(20),  'Stock');
      r.input('srcPo',    sql.NVarChar(50),  PoNo);
      r.input('srcLn',    sql.Int,           Number(LineNumber));
      r.input('createdBy', sql.Int,          req.user.id);

      const ins = await r.query(`
        INSERT INTO dbo.BN_WhStock
          (Company, IleEntryNo, CartonNo, InvoiceNo, NewLocation,
           MPN, Make, QtyPcs, Origin, InwordDate,
           PurchasePrice, PurchaseAmount, Status,
           SourcePoNo, SourcePoLine, CreatedBy)
        OUTPUT INSERTED.Id
        VALUES
          (@co, @ile, @carton, @invNo, @newLoc,
           @mpn, @make, @qty, @origin, @inwordDt,
           @purPrice, @purAmt, @status,
           @srcPo, @srcLn, @createdBy);
      `);
      insertedIds.push(ins.recordset[0].Id);
    }

    res.status(201).json({
      ok: true,
      inserted: insertedIds.length,
      ids: insertedIds,
      ileLinked: ileEntryNo != null,
    });
  } catch (err) {
    console.error('POST /warehouse/stocks/from-po-receipt error:', err.message);
    res.status(500).json({ message: 'Failed to create stocks from PO', error: err.message });
  }
});

module.exports = router;
