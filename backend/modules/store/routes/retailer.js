/* ============================================================================
   backend/modules/store/routes/retailer.js
   New Retailer Audit modules: Invoice fetch (NAV), Pickout, Verification,
   Shipment (delivery), Item Audit. Reuses dbo.BN_StoreScan (expanded columns).

   Mounted by index.js at:  router.use('/retailer', require('./routes/retailer'));
   So all endpoints are under  /api/store/retailer/...

   Roles (from auth.js):
     retailer auditor   → Inward, Pickout, Store Audit
     store electrical→ Store Audit, Pickout-review, Shipment, Item Audit
     retailer delivery  → Shipment (capture)
   ============================================================================ */
const express = require('express');
const router  = express.Router();
const sql     = require('mssql');
const { getAppPool, getPool } = require('../../../db');
const {
  authenticate,
  isStore: isStoreRole, isFullAccess, isAnyHead,
  isRetailerAuditor, isRetailerDelivery
} = require('../../../auth');

/* ---- NAV (read-only) table names ---- */
const NAV_ITEM        = '[dbo].[Company A Pvt_ Ltd_$Item]';
const NAV_ITEM_LEDGER = '[dbo].[Company A Pvt_ Ltd_$Item Ledger Entry]';
const NAV_SIH         = '[dbo].[Company A Pvt_ Ltd_$Sales Invoice Header]';
const NAV_SIL         = '[dbo].[Company A Pvt_ Ltd_$Sales Invoice Line]';

/* ---- helpers ---- */
function companyOf(){ return 'COMPANYA'; }

/* Capture-date filter parsed from the query string:
     ?date=YYYY-MM-DD                  → that single day
     ?from=YYYY-MM-DD&to=YYYY-MM-DD    → inclusive range
     (nothing)                         → all dates
   Returns { active, from, to, label }. The matching SQL is DATE_COND below,
   bound with @dFrom / @dTo (sql.Date), filtering COALESCE(CapturedAt,CreatedAt). */
function parseDateFilter(req){
  const q = (req && req.query) || {};
  const date = (q.date||'').trim();
  let from = (q.from||'').trim(), to = (q.to||'').trim();
  if(date){ from = date; to = date; }
  if(from && !to) to = from;
  if(to && !from) from = to;
  const active = !!(from && to);
  const label = !active ? 'all dates' : (from===to ? from : (from+' to '+to));
  return { active, from, to, label };
}
/* Dates are compared in IST (UTC+5:30). We key off CreatedAt (written by
   SYSUTCDATETIME(), reliably UTC) rather than CapturedAt (written via the Node
   driver, whose timezone can vary) so "today" lines up with the server clock. */
const IST_DATE_EXPR = "CAST(DATEADD(MINUTE,330,CreatedAt) AS DATE)";
const IST_TODAY_SQL = "CAST(DATEADD(MINUTE,330,SYSUTCDATETIME()) AS DATE)";
const DATE_COND = " AND " + IST_DATE_EXPR + " BETWEEN @dFrom AND @dTo";
const TODAY_COND = " AND " + IST_DATE_EXPR + " = " + IST_TODAY_SQL;

function userEmail(req){
  return (req.user && (req.user.email || req.user.Email || req.user.username || req.user.Username)) || 'unknown';
}
function userName(req){
  return (req.user && (req.user.name || req.user.Name)) || userEmail(req);
}

/* ---- robust role checks ----
   auth.js does NOT always export isRetailerAuditor / isRetailerDelivery. Calling an
   undefined import as a function throws a TypeError INSIDE the middleware (before
   any handler/SQL runs) → HTTP 500. That is exactly why Pickout/Store-Audit/
   Shipment 500'd while Item-Audit (which never calls these) worked. scan.js
   guards the same helper with `typeof === 'function'`; we do the same here, and
   fall back to reading the role string directly so auditor/delivery logins are
   still recognised even when the helper is missing. None of these can throw. */
function roleOf(u){ return (u && (u.role || u.Role) || '').toString().toLowerCase().trim(); }
function safe(fn, u){ try { return (typeof fn === 'function') && !!fn(u); } catch(_) { return false; } }
function isAuditorRole(u){ return safe(isRetailerAuditor, u) || roleOf(u) === 'retailer auditor'; }
function isDeliveryRole(u){ return safe(isRetailerDelivery, u) || roleOf(u) === 'retailer delivery'; }
function isStoreLike(u){ return safe(isStoreRole, u) || safe(isFullAccess, u) || safe(isAnyHead, u) || roleOf(u) === 'store electrical'; }

/* Retailer read-only viewers — see all 4 Store Auditing tabs but can ONLY view:
   every capture / verify / edit / clear / transfer is blocked here, no matter
   what other role the account has. Reads (GET) pass; anything else → 403. */
const RETAILER_READONLY_EMAILS = ['store@company-a.example', 'store2@company-a.example'];
function isRetailerRO(req){
  const u = req.user;
  const e = ((u && (u.email || u.username)) || '').toString().toLowerCase().trim();
  return RETAILER_READONLY_EMAILS.includes(e);
}

/* ---- role middlewares ---- */
function isAuditor(req, res, next){     // auditors + store + admin (store can view)
  const u = req.user;
  if (isRetailerRO(req)) return req.method === 'GET' ? next() : res.status(403).json({ error: 'read-only access' });
  if (isAuditorRole(u) || isStoreLike(u)) return next();
  return res.status(403).json({ error: 'Auditor access required' });
}
function isStoreOnly(req, res, next){   // store + admin (verification / reviews)
  const u = req.user;
  if (isRetailerRO(req)) return req.method === 'GET' ? next() : res.status(403).json({ error: 'read-only access' });
  if (isStoreLike(u)) return next();
  return res.status(403).json({ error: 'Store access required' });
}
/* auditors allowed to also do Shipment (they sometimes go for delivery). */
const SHIP_AUDITOR_EMAILS = ['auditor1@company-a.example', 'auditor2@company-a.example'];
function isShipAuditor(u){
  const e = ((u && (u.email || u.username)) || '').toString().toLowerCase().trim();
  return isRetailerAuditor(u) && SHIP_AUDITOR_EMAILS.includes(e);
}
function isDelivery(req, res, next){    // delivery + store + admin + ship-capable auditors
  const u = req.user;
  if (isRetailerRO(req)) return req.method === 'GET' ? next() : res.status(403).json({ error: 'read-only access' });
  if (isDeliveryRole(u) || isStoreLike(u) || isShipAuditor(u)) return next();
  return res.status(403).json({ error: 'Delivery access required' });
}

/* NAV item lookup (name + inventory), full-code then digits-only fallback. */
async function lookupNavItem(code){
  const c = (code || '').toString().trim();
  if(!c) return null;
  const digitsOnly = c.replace(/[^0-9]/g,'');
  const cands = (digitsOnly && digitsOnly !== c) ? [c, digitsOnly] : [c];
  for(const cand of cands){
    try{
      const pool = await getPool();
      const r = await pool.request().input('code', sql.NVarChar(50), cand).query(`
        SELECT TOP 1 I.[Vendor Item No_] AS ItemCode, I.[Description] AS Description,
          ( SELECT ROUND(ISNULL(SUM(ILE2.[Remaining Quantity]),0),0)
            FROM ${NAV_ITEM_LEDGER} ILE2 WHERE ILE2.[Item No_] = I.[No_] ) AS InventoryQty
        FROM ${NAV_ITEM} I WHERE I.[Vendor Item No_] = @code`);
      if(r.recordset && r.recordset.length){
        const row=r.recordset[0];
        return { itemCode:row.ItemCode, description:row.Description, inventoryQty:(row.InventoryQty!=null?row.InventoryQty:0) };
      }
    }catch(e){ console.error('[retailer lookupNavItem]', e.message); }
  }
  return null;
}

/* normalise a code for matching (strip spaces, upper, OCR digit fixes optional) */
function normCode(s){ return (s||'').toString().toUpperCase().replace(/\s+/g,'').trim(); }


/* ===========================================================================
   GET /api/store/retailer/invoices
   Pull Retailer sales-invoice LINES from NAV (read-only). Optional filters:
     ?invoice=INV123     → that invoice no (Document No_)
     ?date=2026-06-24    → that posting date
     ?from=...&to=...    → posting-date range
   Returns rows: { PostingDate, InvoiceNo, CustomerName, ItemCode, ItemName, Qty }
   =========================================================================== */
router.get('/invoices', authenticate, isAuditor, async (req, res) => {
  try{
    const invoice = (req.query.invoice||'').toString().trim();
    const date    = (req.query.date||'').toString().trim();
    const from    = (req.query.from||'').toString().trim();
    const to      = (req.query.to||'').toString().trim();

    const pool = await getPool();   // NAV read-only
    const rq = pool.request();
    const conds = [`SIL.[No_] LIKE '%RETAILER%'`];
    /* default: only recent invoices unless a filter is given (avoids huge pulls) */
    if (invoice){ conds.push('SIL.[Document No_] = @invoice'); rq.input('invoice', sql.NVarChar(50), invoice); }
    if (date){ conds.push('SIL.[Posting Date] = @date'); rq.input('date', sql.Date, new Date(date)); }
    else {
      if (from){ conds.push('SIL.[Posting Date] >= @from'); rq.input('from', sql.Date, new Date(from)); }
      if (to)  { conds.push('SIL.[Posting Date] <= @to');   rq.input('to',   sql.Date, new Date(to)); }
      if (!invoice && !from && !to){
        /* no filter → default to the Retailer go-live window: 24-Jun-2026 → as-on-date.
           (open-ended >= start, so it always runs up to "today" automatically) */
        conds.push(`SIL.[Posting Date] >= '2026-06-24'`);
      }
    }
    const where = 'WHERE ' + conds.join(' AND ');
    const q = `
      SELECT SIL.[Posting Date]   AS PostingDate,
             SIL.[Document No_]   AS InvoiceNo,
             SIH.[Bill-to Name]   AS CustomerName,
             I.[Vendor Item No_]  AS ItemCode,
             I.[Description]      AS ItemName,
             SIL.[Quantity]       AS Qty
      FROM ${NAV_SIH} SIH
      JOIN ${NAV_SIL} SIL ON SIH.[Sell-to Customer No_] = SIL.[Sell-to Customer No_]
                          AND SIH.[No_] = SIL.[Document No_]
      JOIN ${NAV_ITEM} I ON I.[No_] = SIL.[No_]
      ${where}
      ORDER BY SIL.[Posting Date] DESC, SIL.[Document No_], I.[Vendor Item No_]`;
    const r = await rq.query(q);
    return res.json(r.recordset || []);
  }catch(err){
    console.error('[retailer/invoices]', err);
    return res.status(500).json({ error: 'invoice fetch failed', detail: err.message });
  }
});


/* ===========================================================================
   POST /api/store/retailer/pickout
   An auditor captures a pickout for ONE invoice line. The frontend has already
   matched the scanned code to the invoice line's item code; we double-check here.
   Body: { postingDate, invoiceNo, customerName, itemCode, itemName, qty,
           scannedCode, imageBase64 }
   =========================================================================== */
router.post('/pickout', authenticate, isAuditor, async (req, res) => {
  try{
    const b = req.body || {};
    const invItem = normCode(b.itemCode);
    const scanned = normCode(b.scannedCode || b.itemCode);
    const nameOnly = !invItem || b.nameOnly === true;   // no code, or client flagged (e.g. "pipe")
    if(nameOnly && !((b.itemName||'').toString().trim())){
      return res.status(400).json({ error:'itemCode or itemName required' });
    }
    /* coded lines must match the scanned code; name-only lines skip the match */
    if(!nameOnly){
      const invDigits = invItem.replace(/[^0-9]/g,'');
      const scDigits  = scanned.replace(/[^0-9]/g,'');
      const matches = (invItem === scanned) || (invDigits && invDigits === scDigits);
      if(!matches){
        return res.status(409).json({ error:'code mismatch', expected:b.itemCode, got:b.scannedCode });
      }
    }
    /* multiple box-captures per line are allowed now (partial → completed), so no
       duplicate guard — the box quantities accumulate toward the invoice qty. */

    /* save photo if provided */
    let imagePath = null;
    if (b.imageBase64){
      try{
        const fs=require('fs'); const path=require('path');
        const dir = path.join(process.cwd(), 'uploads', 'store');
        fs.mkdirSync(dir, { recursive:true });
        const fname = 'pickout_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + '.jpg';
        const base64 = b.imageBase64.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(path.join(dir, fname), Buffer.from(base64, 'base64'));
        imagePath = 'uploads/store/' + fname;
      }catch(e){ console.error('[pickout image]', e.message); }
    }

    /* resolve name from NAV if not provided */
    let itemName = b.itemName || null;
    if(!itemName && !nameOnly){ const nav=await lookupNavItem(b.itemCode); if(nav&&nav.description) itemName=nav.description; }

    const boxQty     = Math.round(Number(b.qty)||1);                                   // this box's qty
    const invoiceQty = Math.round(Number(b.invoiceQty)||Number(b.qty)||1);             // invoice target (stored in QtyPerBox)
    const pool = await getAppPool();
    const result = await pool.request()
      .input('ModelName',     sql.NVarChar(200), itemName || b.itemCode || 'ITEM')
      .input('QtyPerBox',     sql.Int, invoiceQty)          // repurposed: invoice target qty
      .input('Boxes',         sql.Int, 1)
      .input('Qty',           sql.Int, boxQty)              // this capture's box qty
      .input('Direction',     sql.VarChar(10), 'OUT')          // pickout reduces stock
      .input('Module',        sql.VarChar(20), 'PICKOUT')
      .input('ItemCode',      sql.NVarChar(50), b.itemCode || null)
      .input('ScanStatus',    sql.VarChar(10), 'GREEN')
      .input('OcrSource',     sql.VarChar(20), 'pickout')
      .input('ImagePath',     sql.NVarChar(400), imagePath)
      .input('CapturedAt',    sql.DateTime2, new Date())
      .input('PostingDate',   sql.Date, b.postingDate ? new Date(b.postingDate) : null)
      .input('InvoiceNo',     sql.NVarChar(50), b.invoiceNo || null)
      .input('CustomerName',  sql.NVarChar(200), b.customerName || null)
      .input('CapturedByName',sql.NVarChar(100), userName(req))
      .input('Company',       sql.NVarChar(100), companyOf())
      .input('CreatedBy',     sql.NVarChar(150), userEmail(req))
      .input('Verification',  sql.NVarChar(10), null)   // a pickout is ALWAYS born UNVERIFIED — only the store's Yes/No may set this
      .query(`
        INSERT INTO dbo.BN_StoreScan
          (ModelName, QtyPerBox, Boxes, Qty, Direction, Module, ItemCode, ScanStatus,
           OcrSource, ImagePath, CapturedAt, PostingDate, InvoiceNo, CustomerName,
           CapturedByName, Company, Verification, VerifiedAt, VerifiedBy, IsActive, CreatedAt, CreatedBy)
        OUTPUT INSERTED.Id
        VALUES
          (@ModelName, @QtyPerBox, @Boxes, @Qty, @Direction, @Module, @ItemCode, @ScanStatus,
           @OcrSource, @ImagePath, @CapturedAt, @PostingDate, @InvoiceNo, @CustomerName,
           @CapturedByName, @Company, @Verification, NULL, NULL, 1, SYSUTCDATETIME(), @CreatedBy)`);
    const id = result.recordset && result.recordset[0] && result.recordset[0].Id;
    return res.json({ ok:true, id, itemName, imagePath });
  }catch(err){
    console.error('[retailer/pickout]', err);
    return res.status(500).json({ error:'pickout save failed', detail: err.message });
  }
});


/* ===========================================================================
   GET /api/store/retailer/pickout-list
   Auditor  → only THEIR OWN pickouts (CreatedBy = me).
   Store/admin → ALL pickouts (the review screen).
   Returns rows incl. verification status, capturedByName, image, etc.
   =========================================================================== */
router.get('/pickout-list', authenticate, isAuditor, async (req, res) => {
  try{
    const pool = await getAppPool();
    const rq = pool.request().input('Company', sql.NVarChar(100), companyOf());
    let scope = '';
    /* store/admin sees all; an auditor sees only their own rows */
    const u = req.user;
    const storeSide = isStoreLike(u);
    if (!storeSide){ scope = ' AND CreatedBy = @me'; rq.input('me', sql.NVarChar(150), userEmail(req)); }
    const r = await rq.query(`
      SELECT Id, PostingDate, InvoiceNo, CustomerName, ItemCode, ModelName AS ItemName,
             ABS(Qty) AS Qty, QtyPerBox AS TargetQty, Verification, VerifiedAt, VerifiedBy, CapturedByName,
             ImagePath, CapturedAt, CreatedBy
      FROM dbo.BN_StoreScan
      WHERE Company=@Company AND IsActive=1 AND Module='PICKOUT' ${scope}
      ORDER BY CapturedAt DESC`);
    return res.json(r.recordset || []);
  }catch(err){
    console.error('[retailer/pickout-list]', err);
    return res.status(500).json({ error:'pickout list failed', detail: err.message });
  }
});


/* ===========================================================================
   PUT /api/store/retailer/verify/:id    (store only)
   Body: { decision: 'verified' | 'rejected' | 'reset' }
   - verified → status verified (flows to Shipment)
   - rejected → status rejected
   - reset    → clears verification (and removes any Shipment child)
   =========================================================================== */
router.put('/verify/:id', authenticate, isStoreOnly, async (req, res) => {
  try{
    const id = parseInt(req.params.id, 10);
    const decision = (req.body && req.body.decision || '').toLowerCase().trim();
    if(!['verified','rejected','reset'].includes(decision)){
      return res.status(400).json({ error:'decision must be verified|rejected|reset' });
    }
    const pool = await getAppPool();

    if (decision === 'reset'){
      /* clear verification on the pickout AND soft-delete any shipment child rows */
      await pool.request()
        .input('Id', sql.Int, id).input('Company', sql.NVarChar(100), companyOf())
        .query(`UPDATE dbo.BN_StoreScan
                SET Verification=NULL, VerifiedAt=NULL, VerifiedBy=NULL, UpdatedAt=SYSUTCDATETIME()
                WHERE Id=@Id AND Company=@Company AND Module='PICKOUT'`);
      await pool.request()
        .input('Pid', sql.Int, id).input('Company', sql.NVarChar(100), companyOf())
        .query(`UPDATE dbo.BN_StoreScan
                SET IsActive=0, DeleteRemark='pickout reset', UpdatedAt=SYSUTCDATETIME()
                WHERE ParentId=@Pid AND Company=@Company AND Module='SHIPMENT'`);
      return res.json({ ok:true, decision:'reset' });
    }

    await pool.request()
      .input('Id', sql.Int, id)
      .input('Company', sql.NVarChar(100), companyOf())
      .input('V', sql.VarChar(20), decision)
      .input('VBy', sql.NVarChar(150), userEmail(req))
      .query(`UPDATE dbo.BN_StoreScan
              SET Verification=@V, VerifiedAt=SYSUTCDATETIME(), VerifiedBy=@VBy, UpdatedAt=SYSUTCDATETIME()
              WHERE Id=@Id AND Company=@Company AND Module='PICKOUT'`);

    /* on reject, also remove any existing shipment child (in case it was verified before) */
    if (decision === 'rejected'){
      await pool.request()
        .input('Pid', sql.Int, id).input('Company', sql.NVarChar(100), companyOf())
        .query(`UPDATE dbo.BN_StoreScan SET IsActive=0, DeleteRemark='pickout rejected', UpdatedAt=SYSUTCDATETIME()
                WHERE ParentId=@Pid AND Company=@Company AND Module='SHIPMENT'`);
    }
    return res.json({ ok:true, decision });
  }catch(err){
    console.error('[retailer/verify]', err);
    return res.status(500).json({ error:'verify failed', detail: err.message });
  }
});


/* ===========================================================================
   DELETE /api/store/retailer/pickout/:id   (store + admin)
   Soft-delete a pickout entry (and any shipment child of it) so it disappears
   from every view. Used to clear old DUPLICATE captures that predate the
   double-capture guard. This is a soft delete (IsActive=0) — recoverable in
   the DB, not a hard row deletion.
   =========================================================================== */
router.delete('/pickout/:id', authenticate, isStoreOnly, async (req, res) => {
  try{
    const id = parseInt(req.params.id, 10);
    if(!id){ return res.status(400).json({ error:'invalid id' }); }
    const pool = await getAppPool();
    const r = await pool.request()
      .input('Id', sql.Int, id)
      .input('Company', sql.NVarChar(100), companyOf())
      .query(`UPDATE dbo.BN_StoreScan
              SET IsActive=0, DeleteRemark='deleted by store', UpdatedAt=SYSUTCDATETIME()
              WHERE Id=@Id AND Company=@Company AND Module='PICKOUT'`);
    /* also soft-delete any shipment child so the Shipment view has no orphan */
    await pool.request()
      .input('Pid', sql.Int, id).input('Company', sql.NVarChar(100), companyOf())
      .query(`UPDATE dbo.BN_StoreScan
              SET IsActive=0, DeleteRemark='parent pickout deleted', UpdatedAt=SYSUTCDATETIME()
              WHERE ParentId=@Pid AND Company=@Company AND Module='SHIPMENT'`);
    return res.json({ ok:true, deleted: (r.rowsAffected && r.rowsAffected[0]) || 0 });
  }catch(err){
    console.error('[retailer/pickout delete]', err);
    return res.status(500).json({ error:'delete failed', detail: err.message });
  }
});


/* ===========================================================================
   PUT /api/store/retailer/pickout/:id/reset   (auditor — own capture only)
   Auditor clears their own pickout BEFORE the store verifies. Soft-deletes the
   row so the invoice line returns to "Ready to capture" and stops flowing to
   store/admin until re-captured. Blocked once the store has verified/rejected.
   =========================================================================== */
router.put('/pickout/:id/reset', authenticate, isAuditor, async (req, res) => {
  try{
    const id = parseInt(req.params.id, 10);
    if(!id){ return res.status(400).json({ error:'invalid id' }); }
    const pool = await getAppPool();
    const r = await pool.request()
      .input('Id', sql.Int, id)
      .input('Company', sql.NVarChar(100), companyOf())
      .input('Me', sql.NVarChar(150), userEmail(req))
      .query(`UPDATE dbo.BN_StoreScan
              SET IsActive=0, DeleteRemark='auditor reset', UpdatedAt=SYSUTCDATETIME()
              WHERE Id=@Id AND Company=@Company AND Module='PICKOUT'
                AND CreatedBy=@Me AND Verification IS NULL`);
    const n = (r.rowsAffected && r.rowsAffected[0]) || 0;
    if(!n){
      return res.status(409).json({ error:'cannot reset',
        message:'Cannot reset — it was already verified/rejected by the store (or not your capture).' });
    }
    return res.json({ ok:true, reset:n });
  }catch(err){
    console.error('[retailer/pickout reset]', err);
    return res.status(500).json({ error:'reset failed', detail: err.message });
  }
});


/* ===========================================================================
   PUT /api/store/retailer/shipment/:id/reset   (delivery)
   Delivery clears their own shipment photo (soft-delete the shipment child) so
   the row returns to "Ready to capture".  :id = the ShipmentId from shipment-list.
   =========================================================================== */
router.put('/shipment/:id/reset', authenticate, isDelivery, async (req, res) => {
  try{
    const id = parseInt(req.params.id, 10);
    if(!id){ return res.status(400).json({ error:'invalid id' }); }
    const pool = await getAppPool();
    const r = await pool.request()
      .input('Id', sql.Int, id)
      .input('Company', sql.NVarChar(100), companyOf())
      .query(`UPDATE dbo.BN_StoreScan
              SET IsActive=0, DeleteRemark='delivery reset', UpdatedAt=SYSUTCDATETIME()
              WHERE Id=@Id AND Company=@Company AND Module='SHIPMENT'`);
    return res.json({ ok:true, reset:(r.rowsAffected && r.rowsAffected[0])||0 });
  }catch(err){
    console.error('[retailer/shipment reset]', err);
    return res.status(500).json({ error:'reset failed', detail: err.message });
  }
});


/* ===========================================================================
   GET /api/store/retailer/shipment-list   (store + delivery)
   The rows whose pickout was VERIFIED. Each carries the original invoice
   context + (if delivery has captured) the delivery photo + GPS.
   We surface it as one row per verified pickout, LEFT JOINed to its shipment child.
   =========================================================================== */
router.get('/shipment-list', authenticate, isDelivery, async (req, res) => {
  try{
    const pool = await getAppPool();
    const r = await pool.request()
      .input('Company', sql.NVarChar(100), companyOf())
      .query(`
        SELECT p.Id AS PickoutId,
               p.PostingDate, p.InvoiceNo, p.CustomerName, p.ItemCode,
               p.ModelName AS ItemName, ABS(p.Qty) AS Qty,
               sh.CapturedQty, sh.DeliveryAt, sh.DeliveryBy,
               STUFF((SELECT '|' + CAST(s2.ImagePath AS NVARCHAR(400))
                      FROM dbo.BN_StoreScan s2
                      WHERE s2.ParentId=p.Id AND s2.Module='SHIPMENT' AND s2.IsActive=1
                        AND s2.Company=@Company AND s2.ImagePath IS NOT NULL
                      FOR XML PATH('')),1,1,'') AS Photos,
               STUFF((SELECT ',' + CAST(s3.Id AS NVARCHAR(20))
                      FROM dbo.BN_StoreScan s3
                      WHERE s3.ParentId=p.Id AND s3.Module='SHIPMENT' AND s3.IsActive=1 AND s3.Company=@Company
                      FOR XML PATH('')),1,1,'') AS ShipmentIds
        FROM dbo.BN_StoreScan p
        LEFT JOIN (
          SELECT ParentId,
                 SUM(ABS(Qty)) AS CapturedQty,
                 MAX(CapturedAt) AS DeliveryAt,
                 MAX(CapturedByName) AS DeliveryBy
          FROM dbo.BN_StoreScan
          WHERE Module='SHIPMENT' AND IsActive=1 AND Company=@Company
          GROUP BY ParentId
        ) sh ON sh.ParentId = p.Id
        WHERE p.Company=@Company AND p.IsActive=1 AND p.Module='PICKOUT'
          AND p.Verification='verified'
        ORDER BY p.VerifiedAt DESC, p.CapturedAt DESC`);
    return res.json(r.recordset || []);
  }catch(err){
    console.error('[retailer/shipment-list]', err);
    return res.status(500).json({ error:'shipment list failed', detail: err.message });
  }
});


/* ===========================================================================
   POST /api/store/retailer/shipment   (delivery)
   Delivery captures the item (code must match the pickout's item code) + photo
   with GPS burned in by the client. Body:
     { pickoutId, itemCode, scannedCode, imageBase64, gpsLat, gpsLng, gpsAddress }
   =========================================================================== */
router.post('/shipment', authenticate, isDelivery, async (req, res) => {
  try{
    const b = req.body || {};
    const pid = parseInt(b.pickoutId, 10);
    if(!pid){ return res.status(400).json({ error:'pickoutId required' }); }

    /* load the parent pickout to validate the code + copy invoice context */
    const pool = await getAppPool();
    const pr = await pool.request()
      .input('Id', sql.Int, pid).input('Company', sql.NVarChar(100), companyOf())
      .query(`SELECT TOP 1 Id, ItemCode, ModelName, Qty, PostingDate, InvoiceNo, CustomerName, Verification
              FROM dbo.BN_StoreScan WHERE Id=@Id AND Company=@Company AND Module='PICKOUT'`);
    if(!pr.recordset.length){ return res.status(404).json({ error:'pickout not found' }); }
    const parent = pr.recordset[0];
    if(parent.Verification !== 'verified'){ return res.status(409).json({ error:'pickout not verified' }); }

    /* enforce code match against the parent pickout's item code, unless this is a
       name-only / unscannable line (e.g. "pipe") flagged by the client */
    const nameOnly = b.nameOnly === true || !normCode(parent.ItemCode);
    if(!nameOnly){
      const invItem = normCode(parent.ItemCode);
      const scanned = normCode(b.scannedCode || b.itemCode);
      const matches = (invItem === scanned) ||
        (invItem.replace(/[^0-9]/g,'') && invItem.replace(/[^0-9]/g,'') === scanned.replace(/[^0-9]/g,''));
      if(!matches){ return res.status(409).json({ error:'code mismatch', expected:parent.ItemCode, got:b.scannedCode }); }
    }

    /* save delivery photo (already has GPS overlay burned in by the client) */
    let imagePath = null;
    if (b.imageBase64){
      try{
        const fs=require('fs'); const path=require('path');
        const dir = path.join(process.cwd(), 'uploads', 'store');
        fs.mkdirSync(dir, { recursive:true });
        const fname = 'shipment_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + '.jpg';
        const base64 = b.imageBase64.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(path.join(dir, fname), Buffer.from(base64, 'base64'));
        imagePath = 'uploads/store/' + fname;
      }catch(e){ console.error('[shipment image]', e.message); }
    }

    /* one row per delivered box; box qty accumulates toward the pickout qty. */
    const boxQty = Math.max(1, Math.round(Number(b.qty)||1));
    const target = Math.abs(parent.Qty)||1;
    const ins = await pool.request()
      .input('ModelName',     sql.NVarChar(200), parent.ModelName)
      .input('QtyPerBox',     sql.Int, target)               // repurposed: pickout target qty
      .input('Boxes',         sql.Int, 1)
      .input('Qty',           sql.Int, boxQty)               // this box's qty
      .input('Direction',     sql.VarChar(10), 'OUT')
      .input('Module',        sql.VarChar(20), 'SHIPMENT')
      .input('ItemCode',      sql.NVarChar(50), parent.ItemCode)
      .input('ScanStatus',    sql.VarChar(10), 'GREEN')
      .input('OcrSource',     sql.VarChar(20), 'delivery')
      .input('ImagePath',     sql.NVarChar(400), imagePath)
      .input('CapturedAt',    sql.DateTime2, new Date())
      .input('PostingDate',   sql.Date, parent.PostingDate)
      .input('InvoiceNo',     sql.NVarChar(50), parent.InvoiceNo)
      .input('CustomerName',  sql.NVarChar(200), parent.CustomerName)
      .input('CapturedByName',sql.NVarChar(100), userName(req))
      .input('ParentId',      sql.Int, pid)
      .input('GpsLat',        sql.Decimal(10,6), b.gpsLat!=null?Number(b.gpsLat):null)
      .input('GpsLng',        sql.Decimal(10,6), b.gpsLng!=null?Number(b.gpsLng):null)
      .input('GpsAddress',    sql.NVarChar(400), b.gpsAddress||null)
      .input('Company',       sql.NVarChar(100), companyOf())
      .input('CreatedBy',     sql.NVarChar(150), userEmail(req))
      .query(`
        INSERT INTO dbo.BN_StoreScan
          (ModelName, QtyPerBox, Boxes, Qty, Direction, Module, ItemCode, ScanStatus,
           OcrSource, ImagePath, CapturedAt, PostingDate, InvoiceNo, CustomerName,
           CapturedByName, ParentId, GpsLat, GpsLng, GpsAddress, Company, IsActive, CreatedAt, CreatedBy)
        OUTPUT INSERTED.Id
        VALUES
          (@ModelName, @QtyPerBox, @Boxes, @Qty, @Direction, @Module, @ItemCode, @ScanStatus,
           @OcrSource, @ImagePath, @CapturedAt, @PostingDate, @InvoiceNo, @CustomerName,
           @CapturedByName, @ParentId, @GpsLat, @GpsLng, @GpsAddress, @Company, 1, SYSUTCDATETIME(), @CreatedBy)`);
    const sid = ins.recordset && ins.recordset[0] && ins.recordset[0].Id;
    return res.json({ ok:true, shipmentId:sid, imagePath });
  }catch(err){
    console.error('[retailer/shipment]', err);
    return res.status(500).json({ error:'shipment save failed', detail: err.message });
  }
});


/* ===========================================================================
   GET /api/store/retailer/store-audit   (store + auditors)
   Inward totals per item: System qty (NAV inventory) vs Physical qty (inward),
   last capture, captured-by, photo.
   Rewritten to the SAME robust shape as /item-audit (DISTINCT code list LEFT
   JOINed to a plain GROUP BY aggregate, name/photo via OUTER correlated
   subqueries). The previous version nested a correlated sub-select INSIDE a
   GROUP BY derived table, which threw HTTP 500. This version also lists every
   inward item (so yesterday's full audit shows here, same rows as Item Audit).
   =========================================================================== */
async function buildStoreAuditRows(req, dcondOverride){
  const df = parseDateFilter(req);
  const useOverride = (dcondOverride != null);
  const dcond = useOverride ? dcondOverride : (df.active ? DATE_COND : '');
  const pool = await getAppPool();
  const rq = pool.request().input('Company', sql.NVarChar(100), companyOf());
  if(!useOverride && df.active){ rq.input('dFrom', sql.Date, df.from); rq.input('dTo', sql.Date, df.to); }
  const r = await rq.query(`
        SELECT
          codes.ItemCode,
          ( SELECT TOP 1 s2.ModelName FROM dbo.BN_StoreScan s2
            WHERE s2.ItemCode = codes.ItemCode AND s2.Company = @Company AND s2.IsActive = 1
              AND s2.ModelName IS NOT NULL AND s2.ModelName <> s2.ItemCode
            ORDER BY LEN(s2.ModelName) DESC ) AS ItemName,
          ISNULL(inw.PhysicalQty, 0) AS PhysicalQty,
          inw.LastScan,
          inw.LastBy,
          ( SELECT TOP 1 x.ImagePath FROM dbo.BN_StoreScan x
            WHERE x.ItemCode = codes.ItemCode AND x.Direction = 'IN'
              AND x.Company = @Company AND x.IsActive = 1 AND x.ImagePath IS NOT NULL${dcond}
            ORDER BY x.CapturedAt DESC ) AS LastImage
        FROM (
          SELECT DISTINCT ItemCode FROM dbo.BN_StoreScan
          WHERE Company = @Company AND IsActive = 1 AND Direction = 'IN' AND ItemCode IS NOT NULL${dcond}
        ) codes
        LEFT JOIN (
          SELECT ItemCode,
                 SUM(Qty) AS PhysicalQty,
                 MAX(COALESCE(CapturedAt, CreatedAt)) AS LastScan,
                 MAX(CapturedByName) AS LastBy
          FROM dbo.BN_StoreScan
          WHERE Company = @Company AND IsActive = 1 AND Direction = 'IN'${dcond}
          GROUP BY ItemCode
        ) inw ON inw.ItemCode = codes.ItemCode
        ORDER BY ItemName`);
  const rows = r.recordset || [];
  /* attach NAV system qty + NAME in parallel (cap 3s; NAV down → stays null) */
  const codes = [...new Set(rows.map(x=>(x.ItemCode||'').trim()).filter(Boolean))];
  const navMap = {};
  if(codes.length){
    const jobs = codes.map(c=>lookupNavItem(c).then(n=>{ if(n) navMap[c]={ qty:n.inventoryQty, name:n.description }; }).catch(()=>{}));
    await Promise.race([Promise.all(jobs), new Promise(r=>setTimeout(r,3000))]);
  }
  const toBackfill = [];
  for(const x of rows){
    const code = (x.ItemCode||'').trim();
    const nav = code ? navMap[code] : null;
    /* FROZEN system qty wins: the NAV inventory as it was AT CAPTURE TIME, so an
       audit done on 9 July still compares against 9 July stock. Falls back to live
       NAV only for older rows captured before the snapshot existed. */
    x.SystemQty = (x.FrozenSys!=null) ? Number(x.FrozenSys)
                : ((nav && nav.qty!=null) ? nav.qty : null);
    x.PhysicalQty = Math.round(x.PhysicalQty||0);
    /* LIVE name fallback to NAV Description when the stored name is blank/echoes code. */
    const blank = (!x.ItemName || !String(x.ItemName).trim() || String(x.ItemName).trim() === code);
    if(blank && nav && nav.name){ x.ItemName = nav.name; toBackfill.push({ code, name: nav.name }); }
  }
  if(toBackfill.length){
    (async()=>{ try{
      const wp = await getAppPool();
      for(const b of toBackfill){
        await wp.request()
          .input('code', sql.NVarChar(100), b.code)
          .input('name', sql.NVarChar(200), b.name)
          .input('Company', sql.NVarChar(100), companyOf())
          .query(`UPDATE dbo.BN_StoreScan SET ModelName=@name
                  WHERE ItemCode=@code AND Company=@Company AND IsActive=1
                    AND (ModelName IS NULL OR ModelName='' OR ModelName=ItemCode)`);
      }
    }catch(e){ console.error('[store-audit name backfill]', e.message); } })();
  }
  return rows;
}

router.get('/store-audit', authenticate, isAuditor, async (req, res) => {
  try{
    return res.json(await buildStoreAuditRows(req));
  }catch(err){
    console.error('[retailer/store-audit]', err);
    return res.status(500).json({ error:'store audit failed', detail: err.message });
  }
});

/* ===========================================================================
   TODAY'S AUDITING — only items scanned TODAY (IST). Fresh every day; nothing
   carries over. Also returns PendingQty (today's not-yet-transferred qty) so the
   UI can show a per-item transfer button vs a "already transferred" tick.
   =========================================================================== */
async function buildTodayAuditRows(req){
  const df = parseDateFilter(req);
  const dcond = df.active ? DATE_COND : TODAY_COND;   // filtered date/range, else today (IST)
  /* same window, but applied to when the item was VERIFIED / adjusted */
  const vcond = df.active
    ? " AND CAST(DATEADD(MINUTE,330,VerifiedAt) AS DATE) BETWEEN @dFrom AND @dTo"
    : " AND CAST(DATEADD(MINUTE,330,VerifiedAt) AS DATE) = " + IST_TODAY_SQL;
  const ccond = df.active
    ? " AND CAST(DATEADD(MINUTE,330,CorrectedAt) AS DATE) BETWEEN @dFrom AND @dTo"
    : " AND CAST(DATEADD(MINUTE,330,CorrectedAt) AS DATE) = " + IST_TODAY_SQL;
  /* the last day of the window — a capture is only relevant up to this date */
  const DAY_CAP = df.active ? "@dTo" : IST_TODAY_SQL;
  const pool = await getAppPool();
  const rq = pool.request().input('Company', sql.NVarChar(100), companyOf());
  if(df.active){ rq.input('dFrom', sql.Date, df.from); rq.input('dTo', sql.Date, df.to); }
  const r = await rq.query(`
      SELECT
        codes.ItemCode,
        ( SELECT TOP 1 s2.ModelName FROM dbo.BN_StoreScan s2
          WHERE s2.ItemCode=codes.ItemCode AND s2.Company=@Company AND s2.IsActive=1
            AND s2.ModelName IS NOT NULL AND s2.ModelName<>s2.ItemCode
          ORDER BY LEN(s2.ModelName) DESC ) AS ItemName,
        ISNULL(t.TodayQty, ISNULL(o.OwnQty,0)) AS PhysicalQty,
        CASE WHEN t.ItemCode IS NOT NULL THEN 1 ELSE 0 END AS CapturedOnDate,
        ISNULL(t.PendingQty,0) AS PendingQty,
        COALESCE(t.LastScan, o.LastScan)   AS LastScan,
        COALESCE(t.LastBy,   o.LastBy)     AS LastBy,
        COALESCE(t.FrozenSys,o.FrozenSys)  AS FrozenSys,
        ( SELECT TOP 1 x.ImagePath FROM dbo.BN_StoreScan x
          WHERE x.ItemCode=codes.ItemCode AND x.Direction='IN' AND x.Company=@Company
            AND x.IsActive=1 AND x.ImagePath IS NOT NULL${dcond}
          ORDER BY x.CapturedAt DESC ) AS LastImage
      FROM (
        SELECT DISTINCT ItemCode FROM dbo.BN_StoreScan
        WHERE Company=@Company AND IsActive=1 AND Direction='IN' AND ItemCode IS NOT NULL${dcond}
        UNION
        /* also show items whose VERIFICATION / EDIT was done on this date, so the
           10th and 13th show what was verified or adjusted on those days */
        SELECT ItemCode FROM dbo.BN_StoreAuditVerify
        WHERE Company=@Company AND ItemCode IS NOT NULL
          AND ( (VerifiedAt  IS NOT NULL${vcond})
             OR (CorrectedAt IS NOT NULL${ccond}) )
      ) codes
      LEFT JOIN (
        SELECT ItemCode,
               SUM(Qty) AS TodayQty,
               SUM(CASE WHEN TransferredAt IS NULL THEN Qty ELSE 0 END) AS PendingQty,
               MAX(COALESCE(CapturedAt,CreatedAt)) AS LastScan,
               MAX(CapturedByName) AS LastBy,
               MAX(SystemQtyAtCapture) AS FrozenSys
        FROM dbo.BN_StoreScan
        WHERE Company=@Company AND IsActive=1 AND Direction='IN'${dcond}
        GROUP BY ItemCode
      ) t ON t.ItemCode = codes.ItemCode
      /* An item VERIFIED on this date but captured earlier: use the figures from the
         capture it is verifying — i.e. its latest capture ON OR BEFORE this date.
         The inventory qty therefore always comes from the CAPTURE date, never from
         the verification date. */
      LEFT JOIN (
        SELECT s.ItemCode, SUM(s.Qty) AS OwnQty,
               MAX(COALESCE(s.CapturedAt,s.CreatedAt)) AS LastScan,
               MAX(s.CapturedByName) AS LastBy,
               MAX(s.SystemQtyAtCapture) AS FrozenSys
        FROM dbo.BN_StoreScan s
        JOIN ( SELECT ItemCode,
                      MAX(CAST(DATEADD(MINUTE,330,CreatedAt) AS DATE)) AS LastDay
               FROM dbo.BN_StoreScan
               WHERE Company=@Company AND IsActive=1 AND Direction='IN'
                 AND CAST(DATEADD(MINUTE,330,CreatedAt) AS DATE) <= ${DAY_CAP}
               GROUP BY ItemCode ) L
          ON L.ItemCode = s.ItemCode
         AND CAST(DATEADD(MINUTE,330,s.CreatedAt) AS DATE) = L.LastDay
        WHERE s.Company=@Company AND s.IsActive=1 AND s.Direction='IN'
        GROUP BY s.ItemCode
      ) o ON o.ItemCode = codes.ItemCode
      ORDER BY ItemName`);
  const rows = r.recordset || [];
  const codes = [...new Set(rows.map(x=>(x.ItemCode||'').trim()).filter(Boolean))];
  const navMap = {};
  if(codes.length){
    const jobs = codes.map(c=>lookupNavItem(c).then(n=>{ if(n) navMap[c]={ qty:n.inventoryQty, name:n.description }; }).catch(()=>{}));
    await Promise.race([Promise.all(jobs), new Promise(r=>setTimeout(r,3000))]);
  }
  for(const x of rows){
    const code=(x.ItemCode||'').trim(); const nav = code?navMap[code]:null;
    /* FROZEN system qty wins: the NAV inventory as it was AT CAPTURE TIME, so an
       audit done on 9 July still compares against 9 July stock. Falls back to live
       NAV only for older rows captured before the snapshot existed. */
    x.SystemQty = (x.FrozenSys!=null) ? Number(x.FrozenSys)
                : ((nav && nav.qty!=null) ? nav.qty : null);
    x.PhysicalQty = Math.round(x.PhysicalQty||0);
    x.PendingQty  = Math.round(x.PendingQty||0);
    x.Transferred = (x.PendingQty === 0 && x.PhysicalQty > 0);
    const blank = (!x.ItemName || !String(x.ItemName).trim() || String(x.ItemName).trim()===code);
    if(blank && nav && nav.name) x.ItemName = nav.name;
  }
  return rows;
}
router.get('/audit-today', authenticate, isAuditor, async (req, res) => {
  try{
    return res.json(markVerifiedOnDate(await attachVerify(await buildTodayAuditRows(req)), req));
  }catch(err){
    console.error('[retailer/audit-today]', err);
    return res.status(500).json({ error:'today audit failed', detail: err.message });
  }
});

/* ===========================================================================
   OVERALL AUDITING — the cumulative record, derived live from the transferred
   inward scans (no separate table, so it always reflects deletes/clears).
   =========================================================================== */
async function buildFinalAuditRows(req){
  const df = parseDateFilter(req);
  /* Overall = all TRANSFERRED inward scans, aggregated per item. No separate
     table — so deleting/clearing inward is reflected automatically. Optional date
     filter is on TransferredAt (when it was finalised). */
  const tcond = df.active ? " AND CAST(DATEADD(MINUTE,330,TransferredAt) AS DATE) BETWEEN @dFrom AND @dTo" : '';
  const rq = (await getAppPool()).request().input('Company', sql.NVarChar(100), companyOf());
  if(df.active){ rq.input('dFrom', sql.Date, df.from); rq.input('dTo', sql.Date, df.to); }
  const r = await rq.query(`
      SELECT
        codes.ItemCode,
        ( SELECT TOP 1 s2.ModelName FROM dbo.BN_StoreScan s2
          WHERE s2.ItemCode=codes.ItemCode AND s2.Company=@Company AND s2.IsActive=1
            AND s2.ModelName IS NOT NULL AND s2.ModelName<>s2.ItemCode
          ORDER BY LEN(s2.ModelName) DESC ) AS ItemName,
        ISNULL(t.Qty,0) AS PhysicalQty,
        t.LastScan, t.LastBy, t.FrozenSys,
        ( SELECT TOP 1 x.ImagePath FROM dbo.BN_StoreScan x
          WHERE x.ItemCode=codes.ItemCode AND x.Direction='IN' AND x.Company=@Company
            AND x.IsActive=1 AND x.ImagePath IS NOT NULL AND x.TransferredAt IS NOT NULL
          ORDER BY x.CapturedAt DESC ) AS LastImage
      FROM (
        SELECT DISTINCT ItemCode FROM dbo.BN_StoreScan
        WHERE Company=@Company AND IsActive=1 AND Direction='IN'
          AND TransferredAt IS NOT NULL AND ItemCode IS NOT NULL${tcond}
      ) codes
      LEFT JOIN (
        SELECT ItemCode, SUM(Qty) AS Qty,
               MAX(COALESCE(CapturedAt,CreatedAt)) AS LastScan,
               MAX(CapturedByName) AS LastBy,
               MAX(SystemQtyAtCapture) AS FrozenSys
        FROM dbo.BN_StoreScan
        WHERE Company=@Company AND IsActive=1 AND Direction='IN' AND TransferredAt IS NOT NULL${tcond}
        GROUP BY ItemCode
      ) t ON t.ItemCode = codes.ItemCode
      ORDER BY ItemName`);
  const rows = r.recordset || [];
  const codes = [...new Set(rows.map(x=>(x.ItemCode||'').trim()).filter(Boolean))];
  const navMap = {};
  if(codes.length){
    const jobs = codes.map(c=>lookupNavItem(c).then(n=>{ if(n) navMap[c]={ qty:n.inventoryQty, name:n.description }; }).catch(()=>{}));
    await Promise.race([Promise.all(jobs), new Promise(r=>setTimeout(r,3000))]);
  }
  for(const x of rows){
    const code=(x.ItemCode||'').trim(); const nav = code?navMap[code]:null;
    /* FROZEN system qty wins: the NAV inventory as it was AT CAPTURE TIME, so an
       audit done on 9 July still compares against 9 July stock. Falls back to live
       NAV only for older rows captured before the snapshot existed. */
    x.SystemQty = (x.FrozenSys!=null) ? Number(x.FrozenSys)
                : ((nav && nav.qty!=null) ? nav.qty : null);
    x.PhysicalQty = Math.round(x.PhysicalQty||0);
    const blank = (!x.ItemName || !String(x.ItemName).trim() || String(x.ItemName).trim()===code);
    if(blank && nav && nav.name) x.ItemName = nav.name;
  }
  return rows;
}
router.get('/audit-final', authenticate, isAuditor, async (req, res) => {
  try{
    return res.json(markVerifiedOnDate(await attachVerify(await buildFinalAuditRows(req)), req));
  }catch(err){
    console.error('[retailer/audit-final]', err);
    return res.status(500).json({ error:'final audit failed', detail: err.message });
  }
});


/* Was this item VERIFIED/adjusted inside the date window being viewed?  On the
   verification date the row must show the OUTCOME of the verification (so a
   corrected item that now matches shows GREEN), while on its capture date it
   keeps the original discrepancy. */
function istTodayStr(){ return new Date(Date.now() + 330*60000).toISOString().slice(0,10); }
function dayOf(ts){
  if(!ts) return null;
  try{ const t=new Date(ts);
    return t.getUTCFullYear()+'-'+String(t.getUTCMonth()+1).padStart(2,'0')+'-'+String(t.getUTCDate()).padStart(2,'0');
  }catch(e){ return null; }
}
function markVerifiedOnDate(rows, req){
  const df = parseDateFilter(req);
  const from = df.active ? String(df.from) : istTodayStr();
  const to   = df.active ? String(df.to)   : istTodayStr();
  for(const r of (rows||[])){
    const cd = dayOf(r.CorrectedAt);       // the adjustment moves the physical qty
    const vd = dayOf(r.VerifiedAt);        // the store's yes/no
    r.CorrectedOnDate = !!(cd && cd >= from && cd <= to);
    r.VerifiedOnDate  = !!(vd && vd >= from && vd <= to);
  }
  return rows;
}
/* attach the store's Yes/No verification (per item) onto audit rows */
async function attachVerify(rows){
  if(!rows || !rows.length) return rows;
  try{
    const pool = await getAppPool();
    const r = await pool.request().input('Company', sql.NVarChar(100), companyOf())
      .query(`SELECT ItemCode, Decision, VerifiedBy, CorrectedBy, CorrectedQty,
                     DATEADD(MINUTE,330,VerifiedAt)  AS VerifiedAt,   -- store's yes/no (IST, for display)
                     DATEADD(MINUTE,330,CorrectedAt) AS CorrectedAt,  -- auditor's adjustment (IST, for display)
                     VerifiedAt  AS VerifiedAtRaw,    -- raw UTC, used only for the staleness check
                     CorrectedAt AS CorrectedAtRaw    -- raw UTC, used only for the staleness check
              FROM dbo.BN_StoreAuditVerify WHERE Company=@Company`);
    const map={}; (r.recordset||[]).forEach(x=>{ map[(x.ItemCode||'').trim()]=x; });
    /* IST calendar day for a stored (UTC) timestamp — the module reasons in IST days
       (CreatedAt+330 → IST date), so staleness is judged on the same basis. */
    const istDay = (ts)=>{ if(!ts) return null; const t=new Date(ts); if(isNaN(t.getTime())) return null;
      const d=new Date(t.getTime()+330*60000);
      return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0'); };
    for(const row of rows){ const v=map[(row.ItemCode||'').trim()];
      /* A Yes/No (or edit) belongs to the capture it was made against. Judge by DAY:
         only if the item was CAPTURED on a LATER day than it was verified has it been
         re-counted since — then the old decision is stale and must not carry onto the
         new capture. A decision made on the SAME day (or a later day) as the capture
         stands. This is what keeps a Yes/No you just clicked from disappearing, while
         still dropping last week's decision off this week's fresh count. */
      const capDay = istDay(row.LastScan);
      let verDay=null;
      if(v){ const a=istDay(v.VerifiedAtRaw), b=istDay(v.CorrectedAtRaw); verDay=(a&&b)?(a>b?a:b):(a||b); }
      const use = (v && !(capDay && verDay && capDay>verDay)) ? v : null;   // drop only if the capture is a LATER day
      row.Decision=use?use.Decision:null; row.VerifiedBy=use?use.VerifiedBy:null;
      row.CorrectedBy=use?use.CorrectedBy:null; row.CorrectedQty=use?use.CorrectedQty:null;
      row.VerifiedAt=use?use.VerifiedAt:null; row.CorrectedAt=use?use.CorrectedAt:null; }
  }catch(e){ /* table may not exist yet */ }
  return rows;
}

/* store/admin: mark a short/exceed item Yes/No (or reset) */
router.post('/audit-verify', authenticate, isStoreOnly, async (req, res) => {
  try{
    const code=(req.body.itemCode||'').toString().trim();
    const decision=(req.body.decision||'').toString().trim().toLowerCase();
    if(!code) return res.status(400).json({ error:'itemCode required' });
    const wp=await getAppPool();
    const rq=wp.request().input('Company', sql.NVarChar(100), companyOf()).input('Code', sql.NVarChar(100), code);
    if(decision==='reset'){
      await rq.query(`DELETE FROM dbo.BN_StoreAuditVerify WHERE Company=@Company AND ItemCode=@Code`);
    }else{
      rq.input('Decision', sql.NVarChar(10), decision).input('By', sql.NVarChar(231), userEmail(req));
      /* YES means "the counted quantity stands" — so it accepts the discrepancy and
         voids any adjustment. NO leaves an adjustment in place (or invites one). */
      await rq.query(`
        MERGE dbo.BN_StoreAuditVerify AS t
        USING (SELECT @Company AS Company,@Code AS ItemCode) AS s
          ON t.Company=s.Company AND t.ItemCode=s.ItemCode
        WHEN MATCHED THEN UPDATE SET
             Decision=@Decision, VerifiedBy=@By, VerifiedAt=SYSUTCDATETIME(),
             CorrectedQty = CASE WHEN @Decision='yes' THEN NULL ELSE CorrectedQty END,
             CorrectedBy  = CASE WHEN @Decision='yes' THEN NULL ELSE CorrectedBy  END,
             CorrectedAt  = CASE WHEN @Decision='yes' THEN NULL ELSE CorrectedAt  END
        WHEN NOT MATCHED THEN INSERT (Company,ItemCode,Decision,VerifiedBy,VerifiedAt)
          VALUES (@Company,@Code,@Decision,@By,SYSUTCDATETIME());`);
    }
    return res.json({ ok:true });
  }catch(err){ console.error('[retailer/audit-verify]',err); return res.status(500).json({ error:'verify failed', detail:err.message }); }
});

/* auditors: edit an item's physical qty (for items the store marked "No").
   Replaces today's inward for the item with one corrected scan, and clears the
   verification so the store re-checks. */
router.put('/audit-edit-qty', authenticate, isAuditor, async (req, res) => {
  try{
    const code=(req.body.itemCode||'').toString().trim();
    const qty=Math.max(0, Math.round(Number(req.body.qty)||0));
    if(!code) return res.status(400).json({ error:'itemCode required' });
    /* An edit NEVER touches the captured scans. The capture keeps its own date and
       its ORIGINAL quantity for ever; the adjustment is recorded here, with who did
       it and when. The audit views show it in the "after verification" column. */
    const wp=await getAppPool();
    await wp.request()
      .input('Company', sql.NVarChar(100), companyOf())
      .input('Code',    sql.NVarChar(100), code)
      .input('Qty',     sql.Int, qty)
      .input('By',      sql.NVarChar(231), userName(req))
      .query(`
        MERGE dbo.BN_StoreAuditVerify AS t
        USING (SELECT @Company AS Company, @Code AS ItemCode) AS s
          ON t.Company=s.Company AND t.ItemCode=s.ItemCode
        WHEN MATCHED THEN UPDATE SET
             CorrectedBy=@By, CorrectedQty=@Qty, CorrectedAt=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (Company,ItemCode,Decision,CorrectedBy,CorrectedQty,CorrectedAt)
          VALUES (@Company,@Code,'no',@By,@Qty,SYSUTCDATETIME());`);
    return res.json({ ok:true, itemCode:code, qty });
  }catch(err){ console.error('[retailer/audit-edit-qty]',err); return res.status(500).json({ error:'edit failed', detail:err.message }); }
});

/* ===========================================================================
   PER-PERSON capture stats for Store Audit: how many each person captured and
   the elapsed time from their FIRST to their LAST capture (seconds).
   ?mode=today (default) → today's inward | ?mode=final → transferred inward.
   =========================================================================== */
/* per-person stats: distinct items captured + first->last real capture window */
async function buildPeopleStats(req, mode){
  const df = parseDateFilter(req);
  const rq = (await getAppPool()).request().input('Company', sql.NVarChar(100), companyOf());
  let cond;
  if(mode==='final'){
    cond = ' AND TransferredAt IS NOT NULL';
    if(df.active){ cond += ' AND CAST(DATEADD(MINUTE,330,TransferredAt) AS DATE) BETWEEN @dFrom AND @dTo';
      rq.input('dFrom', sql.Date, df.from); rq.input('dTo', sql.Date, df.to); }
  } else {
    if(df.active){ cond = DATE_COND; rq.input('dFrom', sql.Date, df.from); rq.input('dTo', sql.Date, df.to); }
    else cond = TODAY_COND;
  }
  const r = await rq.query(`
    SELECT CapturedByName AS name,
           COUNT(DISTINCT ItemCode) AS captures,
           /* time = first -> last REAL capture, measured on the actual capture
              timestamp (CapturedAt) shown in the table — never a verification or
              edit time. Edit/restore rows carry an artificial timestamp, so they
              are excluded from the window. */
           DATEDIFF(SECOND,
             MIN(CASE WHEN ISNULL(OcrSource,'') NOT IN ('edit','restored') THEN COALESCE(CapturedAt, CreatedAt) END),
             MAX(CASE WHEN ISNULL(OcrSource,'') NOT IN ('edit','restored') THEN COALESCE(CapturedAt, CreatedAt) END)
           ) AS seconds
    FROM dbo.BN_StoreScan
    WHERE Company=@Company AND IsActive=1 AND Direction='IN'
      AND CapturedByName IS NOT NULL AND LTRIM(RTRIM(CapturedByName))<>''
      AND ItemCode IS NOT NULL${cond}
    GROUP BY CapturedByName
    ORDER BY captures DESC`);
  return r.recordset || [];
}
/* ===========================================================================
   AUDIT PROGRESS — how the audit's discrepancies were resolved over time.

   Base   : the items captured on the audit date (original qty + frozen system qty).
   Rule   : an item's status AS OF date D uses the adjusted qty if it was adjusted
            on or before D, otherwise its original captured qty.
   Result : one row per date in the timeline (audit day, then each verification
            day), with matched / exceed / short — so you can see 9th -> 10th -> 13th.
   =========================================================================== */
async function buildAuditProgress(req){
  const df = parseDateFilter(req);
  const auditDay = df.active ? String(df.from) : istTodayStr();

  /* BASE = the audit day's own view (exactly what the live dashboard shows that
     day), so the running totals can never drift away from it. */
  const baseReq = { query: { date: auditDay } };
  const base = await attachVerify(await buildTodayAuditRows(baseReq));

  /* Days AFTER the audit day on which each item was RE-CAPTURED. A verification or
     edit that lands on/after one of these belongs to that later capture, not to this
     audit — so it must not move this audit's running totals (this was the 15-Jul row
     leaking into the 9-Jul progress). */
  const reCapByCode = {};
  try{
    const pool = await getAppPool();
    const rc = await pool.request()
      .input('Company', sql.NVarChar(100), companyOf())
      .input('ADay', sql.Date, auditDay)
      .query(`
        SELECT ItemCode, CAST(DATEADD(MINUTE,330,COALESCE(CapturedAt,CreatedAt)) AS DATE) AS CapDay
        FROM dbo.BN_StoreScan
        WHERE Company=@Company AND IsActive=1 AND Direction='IN' AND ItemCode IS NOT NULL
          AND CAST(DATEADD(MINUTE,330,COALESCE(CapturedAt,CreatedAt)) AS DATE) > @ADay
        GROUP BY ItemCode, CAST(DATEADD(MINUTE,330,COALESCE(CapturedAt,CreatedAt)) AS DATE)`);
    (rc.recordset||[]).forEach(x=>{
      const c=(x.ItemCode||'').trim(), d=dayOf(x.CapDay);
      if(c && d){ (reCapByCode[c] = reCapByCode[c] || []).push(d); }
    });
  }catch(e){ console.error('[audit-progress recapture]', e.message); }

  const items = base
    .filter(r => r.SystemQty != null)
    .map(r => {
      const orig = Math.round(r.PhysicalQty||0);
      const sys  = Math.round(r.SystemQty);
      let cqty = (r.CorrectedQty!=null ? Math.round(Number(r.CorrectedQty)) : null);
      let cday = dayOf(r.CorrectedAt);      /* the day the qty was adjusted */
      let vday = dayOf(r.VerifiedAt);       /* the day the store said Yes / No */
      /* if this item was re-captured on/before that verify or edit, the verify/edit
         belongs to the LATER capture — drop it so it can't move this audit's totals */
      const recaps = reCapByCode[(r.ItemCode||'').trim()] || [];
      const belongsToLater = (day)=> !!day && recaps.some(rc => rc <= day);
      if(belongsToLater(vday)) vday = null;
      if(belongsToLater(cday)){ cday = null; cqty = null; }
      return {
        orig, sys, cqty, cday, vday,
        /* the store only decides on items WITH a discrepancy, so a verified item
           cannot have been matched on the audit day */
        verified: !!(r.Decision),
        /* tell-tale of an overwritten count: the stored count is identical to the
           quantity the auditor later "adjusted" it to */
        damaged: (cqty!=null && orig===cqty)
      };
    });

  /* Timeline: the audit day, then EVERY later day on which an item from that audit
     was worked on — whether the store gave a Yes/No, or an auditor adjusted the qty.
     So any verification, on any date, gets its own row. */
  const days = new Set([auditDay]);
  items.forEach(it => {
    if(it.cqty!=null && it.cday && it.cday > auditDay) days.add(it.cday);   // adjusted
    if(it.vday && it.vday > auditDay) days.add(it.vday);                    // verified yes/no
  });
  const timeline = [...days].sort();

  const statusOf = (q,sys) => (q===sys ? 'matched' : (q>sys ? 'exceed' : 'short'));

  /* Running state: on each day, every item is judged on the quantity in force —
     its adjusted qty once adjusted, otherwise its original count. So an item that
     is fixed MOVES from exceed/short into matched (and the counts move with it). */
  let prev = null;
  return timeline.map(d => {
    let matched=0, exceed=0, short=0;
    items.forEach(it => {
      const useAdj = (it.cqty!=null && it.cday && it.cday <= d);
      const q  = useAdj ? it.cqty : it.orig;
      const st = statusOf(q, it.sys);
      /* No inference. The status is whatever the data says, so the Progress
         dashboard always agrees with the Live dashboard and with the item rows.
         (The 12 items whose 9-July count was overwritten therefore show no
         movement — that is the data, not the calculation.) */
      if(st==='matched') matched++; else if(st==='exceed') exceed++; else short++;
    });
    const row = { date:d, matched, exceed, short, total: matched+exceed+short,
                  isAuditDay: (d===auditDay),
                  dMatched: prev ? (matched - prev.matched) : 0,
                  dExceed:  prev ? (exceed  - prev.exceed ) : 0,
                  dShort:   prev ? (short   - prev.short  ) : 0 };
    prev = row;
    return row;
  });
}
router.get('/audit-progress', authenticate, isAuditor, async (req, res) => {
  try{
    return res.json(await buildAuditProgress(req));
  }catch(err){
    console.error('[retailer/audit-progress]', err);
    return res.status(500).json({ error:'progress failed', detail: err.message });
  }
});

router.get('/audit-people', authenticate, isAuditor, async (req, res) => {
  try{
    return res.json(await buildPeopleStats(req, (req.query.mode||'today')));
  }catch(err){
    console.error('[retailer/audit-people]', err);
    return res.status(500).json({ error:'people stats failed', detail: err.message });
  }
});

/* Count of RETAILER items that HAD STOCK as of a given audit date.
   ?asOf=YYYY-MM-DD → net movement up to and including that day (the correct way to
   get a PAST on-hand: [Remaining Quantity] is a live per-lot figure and can't give a
   historical balance, so we sum [Quantity] through that date). No date → current
   on-hand via [Remaining Quantity], which matches the app's live system qty. */
router.get('/audit-system-count', authenticate, isAuditor, async (req, res) => {
  try{
    const asOf = (req.query.asOf || req.query.date || '').trim();
    const pool = await getPool();   // NAV read-only
    const rq = pool.request();
    let sumExpr = 'SUM([Remaining Quantity])', dateClause = '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(asOf)){
      rq.input('AsOf', sql.Date, asOf);
      dateClause = 'AND [Posting Date] <= @AsOf';
      sumExpr = 'SUM([Quantity])';
    }
    const r = await rq.query(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT [Item No_]
        FROM ${NAV_ITEM_LEDGER}
        WHERE [Item No_] LIKE 'RETAILER%' ${dateClause}
        GROUP BY [Item No_]
        HAVING ${sumExpr} > 0
      ) t`);
    return res.json({ count: Number((r.recordset && r.recordset[0] && r.recordset[0].cnt) || 0), asOf: asOf || null });
  }catch(err){
    console.error('[retailer/audit-system-count]', err);
    return res.status(500).json({ error:'system count failed', detail: err.message });
  }
});

/* ===========================================================================
   TRANSFER TODAY -> OVERALL  (anyone who audits)
   Marks today's not-yet-transferred inward scans as transferred. Overall is
   derived from transferred scans, so this is all that's needed — no separate
   table, and it can never double-count. ?item=CODE = just that item.
   =========================================================================== */
router.post('/audit-transfer', authenticate, isAuditor, async (req, res) => {
  try{
    const item = (req.query.item || '').trim();
    const wp = await getAppPool();
    const rq = wp.request().input('Company', sql.NVarChar(100), companyOf());
    const itemCond = item ? ' AND ItemCode = @Item' : '';
    if(item) rq.input('Item', sql.NVarChar(100), item);
    const r = await rq.query(`
        UPDATE dbo.BN_StoreScan SET TransferredAt = SYSUTCDATETIME()
        WHERE Company=@Company AND IsActive=1 AND Direction='IN'
          AND TransferredAt IS NULL
          AND ${IST_DATE_EXPR} = ${IST_TODAY_SQL}
          AND ItemCode IS NOT NULL${itemCond};
        SELECT @@ROWCOUNT AS marked;`);
    const marked = (r.recordset && r.recordset[0] && r.recordset[0].marked) || 0;
    return res.json({ transferred: true, item: item || 'all', scansMarked: marked });
  }catch(err){
    console.error('[retailer/audit-transfer]', err);
    return res.status(500).json({ error:'transfer failed', detail: err.message });
  }
});

/* ===========================================================================
   DELETE /api/store/retailer/store-audit/:code   (store + admin)
   Soft-delete ALL active inward scans for one item code — removes that item's
   physical count from Store Audit (and Total Audit's physical column).
   =========================================================================== */
router.delete('/store-audit/:code', authenticate, isStoreOnly, async (req, res) => {
  try{
    const code = decodeURIComponent(req.params.code || '').trim();
    if(!code) return res.status(400).json({ error:'code required' });
    const wp = await getAppPool();
    /* Delete TODAY's inward for this item. Overall is derived from the transferred
       scans, so removing today's rows automatically drops today's transferred qty
       from Overall (and removes the item from Overall if nothing transferred
       remains). Earlier days stay. Pickout/Shipment untouched. */
    const r = await wp.request()
      .input('code', sql.NVarChar(100), code)
      .input('Company', sql.NVarChar(100), companyOf())
      .query(`
        DELETE FROM dbo.BN_StoreScan
          WHERE ItemCode=@code AND Direction='IN' AND Company=@Company
            AND ${IST_DATE_EXPR} = ${IST_TODAY_SQL};
        SELECT @@ROWCOUNT AS inwardRemoved;`);
    const row = (r.recordset && r.recordset[0]) || {};
    return res.json({ code, deleted: true, inwardRemoved: row.inwardRemoved||0 });
  }catch(err){
    console.error('[retailer/store-audit delete]', err);
    return res.status(500).json({ error:'delete failed', detail: err.message });
  }
});

/* ===========================================================================
   DELETE /api/store/retailer/store-audit-all   (store + admin)
   One-click reset: soft-delete ALL inward scans. Honours the date filter
   (?date= | ?from=&to=) so it can clear a single day / range, or everything.
   Pickout data is NOT touched.
   =========================================================================== */
router.delete('/store-audit-all', authenticate, isStoreOnly, async (req, res) => {
  try{
    const df = parseDateFilter(req);
    const todayScope = (req.query.scope||'') === 'today';
    /* date filter wins; else on the Today view default to today; else clear all */
    const dcond = df.active ? DATE_COND : (todayScope ? TODAY_COND : '');
    const wp = await getAppPool();
    const rq = wp.request().input('Company', sql.NVarChar(100), companyOf());
    if(df.active){ rq.input('dFrom', sql.Date, df.from); rq.input('dTo', sql.Date, df.to); }
    /* HARD delete — physically remove the inward rows (not IsActive=0). */
    const r = await rq.query(`DELETE FROM dbo.BN_StoreScan
              WHERE Company = @Company AND Direction = 'IN'${dcond}`);
    return res.json({ deleted: true, rows: (r.rowsAffected && r.rowsAffected[0]) || 0, scope: df.active?df.label:(todayScope?'today':'all') });
  }catch(err){
    console.error('[retailer/store-audit-all]', err);
    return res.status(500).json({ error:'clear failed', detail: err.message });
  }
});

/* ===========================================================================
   DELETE /api/store/retailer/audit-final-clear   (store + admin)
   Clears Overall by un-transferring scans (TransferredAt = NULL) — they leave
   Overall but the inward record stays. Honours the date filter on TransferredAt.
   Does NOT delete inward data.
   =========================================================================== */
router.delete('/audit-final-clear', authenticate, isStoreOnly, async (req, res) => {
  try{
    const df = parseDateFilter(req);
    const dcond = df.active ? " AND CAST(DATEADD(MINUTE,330,TransferredAt) AS DATE) BETWEEN @dFrom AND @dTo" : '';
    const wp = await getAppPool();
    const rq = wp.request().input('Company', sql.NVarChar(100), companyOf());
    if(df.active){ rq.input('dFrom', sql.Date, df.from); rq.input('dTo', sql.Date, df.to); }
    const r = await rq.query(`UPDATE dbo.BN_StoreScan SET TransferredAt = NULL
              WHERE Company = @Company AND Direction = 'IN' AND IsActive = 1
                AND TransferredAt IS NOT NULL${dcond}`);
    return res.json({ deleted: true, rows: (r.rowsAffected && r.rowsAffected[0]) || 0, scope: df.active?df.label:'all' });
  }catch(err){
    console.error('[retailer/audit-final-clear]', err);
    return res.status(500).json({ error:'clear failed', detail: err.message });
  }
});


/* ===========================================================================
   GET /api/store/retailer/item-audit   (store)
   Per item: System qty (NAV), Physical qty (inward) + its capture time,
   Pickout qty + its capture time, and a status comparing physical vs pickout.
   =========================================================================== */
async function buildItemAuditRows(req){
  const df = parseDateFilter(req);
  const dcond = df.active ? DATE_COND : '';
  const pool = await getAppPool();
  const rq = pool.request().input('Company', sql.NVarChar(100), companyOf());
  if(df.active){ rq.input('dFrom', sql.Date, df.from); rq.input('dTo', sql.Date, df.to); }
  const r = await rq.query(`
        SELECT
          codes.ItemCode,
          ( SELECT TOP 1 s2.ModelName FROM dbo.BN_StoreScan s2
            WHERE s2.ItemCode=codes.ItemCode AND s2.Company=@Company AND s2.IsActive=1
              AND s2.ModelName IS NOT NULL AND s2.ModelName<>s2.ItemCode
            ORDER BY LEN(s2.ModelName) DESC ) AS ItemName,
          ISNULL(fin.PhysicalQty,0)  AS PhysicalQty,      -- OVERALL qty (transferred scans)
          fin.PhysicalAt,
          ISNULL(pk.PickoutQty,0)    AS PickoutQty,
          pk.PickoutAt
        FROM (
          SELECT ItemCode FROM dbo.BN_StoreScan
            WHERE Company=@Company AND IsActive=1 AND Direction='IN'
              AND TransferredAt IS NOT NULL AND ItemCode IS NOT NULL
          UNION
          SELECT ItemCode FROM dbo.BN_StoreScan
            WHERE Company=@Company AND IsActive=1 AND Module='PICKOUT' AND ItemCode IS NOT NULL${dcond}
        ) codes
        LEFT JOIN (
          SELECT ItemCode, SUM(Qty) AS PhysicalQty, MAX(TransferredAt) AS PhysicalAt
          FROM dbo.BN_StoreScan
          WHERE Company=@Company AND IsActive=1 AND Direction='IN' AND TransferredAt IS NOT NULL
          GROUP BY ItemCode
        ) fin ON fin.ItemCode = codes.ItemCode
        LEFT JOIN (
          SELECT ItemCode, SUM(ABS(Qty)) AS PickoutQty, MAX(COALESCE(CapturedAt,CreatedAt)) AS PickoutAt
          FROM dbo.BN_StoreScan WHERE Company=@Company AND IsActive=1 AND Module='PICKOUT'${dcond}
          GROUP BY ItemCode
        ) pk ON pk.ItemCode = codes.ItemCode
        ORDER BY ItemName`);
  const rows = r.recordset || [];
  const codes = [...new Set(rows.map(x=>(x.ItemCode||'').trim()).filter(Boolean))];
  const navMap = {};
  if(codes.length){
    const jobs = codes.map(c=>lookupNavItem(c).then(n=>{ if(n) navMap[c]={ qty:n.inventoryQty, name:n.description }; }).catch(()=>{}));
    await Promise.race([Promise.all(jobs), new Promise(r=>setTimeout(r,3000))]);
  }
  for(const x of rows){
    const code=(x.ItemCode||'').trim(); const nav = code?navMap[code]:null;
    /* FROZEN system qty wins: the NAV inventory as it was AT CAPTURE TIME, so an
       audit done on 9 July still compares against 9 July stock. Falls back to live
       NAV only for older rows captured before the snapshot existed. */
    x.SystemQty = (x.FrozenSys!=null) ? Number(x.FrozenSys)
                : ((nav && nav.qty!=null) ? nav.qty : null);
    const blank = (!x.ItemName || !String(x.ItemName).trim() || String(x.ItemName).trim()===code);
    if(blank && nav && nav.name) x.ItemName = nav.name;
    const ph = Math.round(x.PhysicalQty||0), po = Math.round(x.PickoutQty||0);
    x.PhysicalQty = ph; x.PickoutQty = po;
    x.Status = (ph===po) ? 'balanced' : (ph>po ? 'in stock' : 'pickout more than physical');
  }
  return rows;
}

router.get('/item-audit', authenticate, isStoreOnly, async (req, res) => {
  try{
    return res.json(await buildItemAuditRows(req));
  }catch(err){
    console.error('[retailer/item-audit]', err);
    return res.status(500).json({ error:'item audit failed', detail: err.message });
  }
});

/* ===========================================================================
   EXCEL EXPORTS (store + admin only) — styled .xlsx, honour the date filter.
   Mirrors the look of the original /api/store/scan/total-excel.
   =========================================================================== */
function xlsApplyHeader(ws, headerRowIdx){
  const thin = { style:'thin', color:{argb:'FF999999'} };
  const allBorders = { top:thin, bottom:thin, left:thin, right:thin };
  const hr = ws.getRow(headerRowIdx);
  hr.eachCell(c=>{
    c.font = { bold:true, color:{argb:'FFFFFFFF'}, size:11 };
    c.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1F2937'} };
    c.alignment = { horizontal:'center', vertical:'middle' };
    c.border = allBorders;
  });
  hr.height = 22;
  return allBorders;
}
function qtyFill(physical, system){
  if(system==null) return null;
  if(physical===system) return { argb:'FFC6EFCE', font:'FF0F5132' };
  if(physical<system)   return { argb:'FFFFEB9C', font:'FF7F6000' };
  return { argb:'FFFFC7CE', font:'FF9C0006' };
}

router.get('/store-audit-excel', authenticate, isStoreOnly, async (req, res) => {
  try{
    const ExcelJS = require('exceljs');
    const df = parseDateFilter(req);
    const mode = (req.query.mode||'').trim();
    const rows = markVerifiedOnDate(await attachVerify(mode==='final' ? await buildFinalAuditRows(req)
               : mode==='today' ? await buildTodayAuditRows(req)
               : await buildStoreAuditRows(req)), req);
    /* on the verification date the colour follows the OUTCOME; on the capture date
       it keeps the original discrepancy — same rule as the app */
    /* Physical Qty is FROZEN on the capture date — a verification never changes it.
       The adjusted figure is only shown on the date the adjustment was made. */
    /* SAME rule as the UI dashboard (bjEffQty): an adjustment shows on the date it
       was made, even when that is also the capture date — so a corrected-to-match
       item reads Matched here exactly as it does on screen. (Previously this returned
       the raw qty whenever the item was captured on the viewed day, which made the
       sheet still show short/exceed for items the dashboard had moved to Matched.) */
    const effQty = (r)=>{ const phy=Math.round(r.PhysicalQty||0);
      return (r.CorrectedOnDate && r.CorrectedQty!=null) ? Math.round(Number(r.CorrectedQty)) : phy; };
    const modeLabel = mode==='final' ? 'Overall' : mode==='today' ? 'Today' : df.label;
    const dateLabel = df.active ? df.label : (mode==='final' ? 'all dates' : 'today');

    /* ---- per-person live dashboard for THIS date/mode (same figures as the app) ---- */
    const people = await buildPeopleStats(req, mode==='final' ? 'final' : 'today');
    const timeOf = {}; (people||[]).forEach(p=>{ timeOf[((p.name||'').split('@')[0]).trim()] = Number(p.seconds)||0; });
    const dash = {};
    rows.forEach(r=>{
      const nm = ((r.LastBy||'').split('@')[0]).trim() || '—';
      const sys = (r.SystemQty!=null?Math.round(r.SystemQty):null);
      const phy = Math.round(r.PhysicalQty||0);
      const g = dash[nm] || (dash[nm] = {matched:0, exceed:0, short:0});
      if(sys==null) return;
      const e = effQty(r);
      if(e===sys) g.matched++; else if(e>sys) g.exceed++; else g.short++;
    });
    const fmtDur = (sec)=>{ sec=Math.max(0,Math.round(Number(sec)||0));
      const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), x=sec%60;
      return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'); };

    const wb = new ExcelJS.Workbook(); wb.creator = 'ONE App';
    const ws = wb.addWorksheet('Store Audit');

    ws.addRow(['ONE App — Store Retailer Auditing — Store Audit ('+modeLabel+' · '+dateLabel+')']);
    ws.mergeCells('A1:K1'); ws.getCell('A1').font = { bold:true, size:13 }; ws.getRow(1).height = 20;

    /* ================= LIVE AUDIT DASHBOARD ================= */
    ws.addRow([]);
    const dTitle = ws.addRow(['Live audit dashboard — '+dateLabel]);
    dTitle.getCell(1).font = { bold:true, size:12 };
    const dHead = ws.addRow(['Sr.No.','Name','Matched','Exceed','Short','Total','Time']);
    const bd = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
    const tint = (c,argb,font)=>{ c.fill={type:'pattern',pattern:'solid',fgColor:{argb}}; c.font={bold:true,color:{argb:font||'FF000000'}}; };
    dHead.eachCell(c=>{ c.border=bd; c.alignment={horizontal:'center'}; c.font={bold:true}; });
    tint(dHead.getCell(3),'FF16A34A','FFFFFFFF');   // Matched  green
    tint(dHead.getCell(4),'FFDC2626','FFFFFFFF');   // Exceed   red
    tint(dHead.getCell(5),'FFFACC15','FF000000');   // Short    yellow
    tint(dHead.getCell(6),'FF334155','FFFFFFFF');   // Total
    let tm=0,te=0,ts=0,tt=0,tsec=0, sr=0;
    Object.keys(dash).forEach(nm=>{
      const g=dash[nm]; const secs=timeOf[nm]||0; const tot=g.matched+g.exceed+g.short;
      tm+=g.matched; te+=g.exceed; ts+=g.short; tt+=tot; tsec+=secs; sr++;
      const rw = ws.addRow([sr, nm, g.matched, g.exceed, g.short, tot, fmtDur(secs)]);
      rw.eachCell(c=>{ c.border=bd; c.alignment={horizontal:'center'}; });
      rw.getCell(2).alignment={horizontal:'left'}; rw.getCell(2).font={bold:true};
    });
    const dTot = ws.addRow(['', 'Total', tm, te, ts, tt, fmtDur(tsec)]);
    dTot.eachCell(c=>{ c.border=bd; c.font={bold:true}; c.alignment={horizontal:'center'};
      c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF1F5F9'}}; });
    dTot.getCell(2).alignment={horizontal:'left'};

    /* ================= ITEM DETAIL ================= */
    ws.addRow([]);
    ws.addRow(['Physical Qty colour:', 'GREEN = equals System', 'YELLOW = short', 'RED = exceed']);
    const legRow = ws.lastRow; legRow.getCell(1).font = { bold:true };
    [null,'FFC6EFCE','FFFFEB9C','FFFFC7CE'].forEach((argb,idx)=>{ if(!argb) return;
      const c=legRow.getCell(idx+1); c.fill={type:'pattern',pattern:'solid',fgColor:{argb}}; c.font={bold:true}; });
    ws.addRow([]);

    const headRow = ws.addRow(['#','Item Code','Item Name','System Qty','Physical Qty',
                               'Verification','Before Verification','After Verification',
                               'Verification Time','Capture Date & Time','Captured By']);
    headRow.eachCell(c=>{ c.border=bd; c.font={bold:true};
      c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF8FAFC'}}; c.alignment={horizontal:'center'}; });

    /* text builders — identical logic to the app */
    const verifText = (r, phy, sys)=>{
      const dec=(r.Decision||'').toLowerCase();
      const adj=(r.CorrectedQty!=null);
      const by=((r.CorrectedBy||'').split('@')[0])||'auditor';
      if(!dec && !adj) return (sys==null || phy===sys) ? '' : 'Pending with Dutta Sir';
      /* item now matches system with no active correction → stale decision is void */
      if(!adj && sys!=null && phy===sys) return '';
      if(dec==='yes') return 'Verified by Dutta Sir';
      if(dec==='no')  return adj ? ('No by Dutta Sir · Adjusted by '+by) : 'No by Dutta Sir';
      return '';
    };
    const beforeText = (phy, sys)=>{
      if(sys==null) return '';
      if(phy===sys) return 'Matched';
      return (phy>sys) ? ('Exceed by '+(phy-sys)) : ('Short by '+(sys-phy));
    };
    const afterText = (r, phy, sys)=>{
      const dec=(r.Decision||'').toLowerCase();
      const adj=(r.CorrectedQty!=null);
      if(sys==null || (!dec && !adj)) return '';
      if(!adj && phy===sys) return '';   // now matches system, no active correction → nothing outstanding
      if(adj){
        const cq=Math.round(Number(r.CorrectedQty));
        if(cq===sys) return 'Matched by '+cq+' qty';
        return (cq>sys) ? ('Exceed by '+(cq-sys)+' qty') : ('Short by '+(sys-cq)+' qty');
      }
      if(dec==='yes'){
        if(phy===sys) return 'Matched';
        return (phy>sys) ? ('Exceed by '+(phy-sys)) : ('Short by '+(sys-phy));
      }
      if(dec==='no') return 'Pending edit';
      return '';
    };

    rows.forEach((r,i)=>{
      const sys = (r.SystemQty!=null?Math.round(r.SystemQty):null);
      const phy = Math.round(r.PhysicalQty||0);
      const eff = effQty(r);
      const row = ws.addRow([ i+1, r.ItemCode||'', r.ItemName||'', (sys!=null?sys:''), eff,
        verifText(r, phy, sys), beforeText(phy, sys), afterText(r, phy, sys),
        ((r.VerifiedAt && !(r.CorrectedQty==null && sys!=null && phy===sys))?new Date(r.VerifiedAt).toLocaleString():''),
        (r.LastScan?new Date(r.LastScan).toLocaleString():''), r.LastBy||'' ]);
      row.eachCell({includeEmpty:true}, c=>{ c.border = bd; });
      if(i%2===1) row.eachCell({includeEmpty:true}, c=>{ if(!c.fill) c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFAFCFF'}}; });
      const f = qtyFill(eff, sys); const cell = row.getCell(5);
      if(f){ cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:f.argb}}; cell.font={bold:true,color:{argb:f.font}}; }
      cell.alignment={horizontal:'center'}; row.getCell(4).alignment={horizontal:'center'};
      /* colour Before / After the same way the app does */
      const paint=(idx, phyV)=>{ const c=row.getCell(idx);
        if(sys==null || phyV==null) return;
        if(phyV===sys) tint(c,'FFC6EFCE','FF006100');
        else if(phyV>sys) tint(c,'FFFFC7CE','FF9C0006');
        else tint(c,'FFFFEB9C','FF9C6500'); };
      paint(7, phy);
      const verResolved = (r.CorrectedQty==null && sys!=null && phy===sys);   // now matches system → stale decision void, colour nothing
      { const d=(r.Decision||'').toLowerCase();
        if(verResolved) { /* nothing outstanding — leave After uncoloured */ }
        else if(d==='corrected') paint(8, Math.round(Number(r.CorrectedQty!=null?r.CorrectedQty:phy)));
        else if(d==='yes')  paint(8, phy);
        else if(d==='no')   tint(row.getCell(8),'FFFFC7CE','FF9C0006'); }
      { const d=(r.Decision||'').toLowerCase(); const vc=row.getCell(6);
        if(verResolved) { /* leave Verified uncoloured */ }
        else if(d==='yes'||d==='corrected') tint(vc,'FFC6EFCE','FF006100');
        else if(d==='no') tint(vc,'FFFFC7CE','FF9C0006'); }
    });
    ws.columns = [{width:5},{width:14},{width:38},{width:12},{width:12},{width:30},
                  {width:18},{width:34},{width:22},{width:22},{width:22}];
    const buf = await wb.xlsx.writeBuffer();
    const fname = 'Store_Audit_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="'+fname+'"');
    return res.send(Buffer.from(buf));
  }catch(err){ console.error('[retailer/store-audit-excel]', err); return res.status(500).json({ error:'excel failed', detail: err.message }); }
});

router.get('/item-audit-excel', authenticate, isStoreOnly, async (req, res) => {
  try{
    const ExcelJS = require('exceljs');
    const df = parseDateFilter(req);
    const rows = await buildItemAuditRows(req);
    const wb = new ExcelJS.Workbook(); wb.creator = 'ONE App';
    const ws = wb.addWorksheet('Total Audit');
    ws.addRow(['ONE App — Store Retailer Auditing — Total Audit ('+df.label+')']);
    ws.mergeCells('A1:I1'); ws.getCell('A1').font = { bold:true, size:13 }; ws.getRow(1).height = 20;
    ws.addRow(['Physical Qty colour:', 'GREEN = equals System', 'ORANGE = less than System', 'RED = exceeds System']);
    const legRow = ws.getRow(2); legRow.getCell(1).font = { bold:true };
    [null,'FFC6EFCE','FFFFEB9C','FFFFC7CE'].forEach((argb,idx)=>{ if(!argb) return;
      const c=legRow.getCell(idx+1); c.fill={type:'pattern',pattern:'solid',fgColor:{argb}}; c.font={bold:true}; });
    ws.addRow([]);
    ws.addRow(['#','Item Code','Item Name','System Qty','Physical Qty','Physical Capture','Pickout Qty','Pickout Capture','Status']);
    const allBorders = xlsApplyHeader(ws, 4);
    rows.forEach((r,i)=>{
      const sys = (r.SystemQty!=null?Math.round(r.SystemQty):null);
      const phy = Math.round(r.PhysicalQty||0), po = Math.round(r.PickoutQty||0);
      const row = ws.addRow([ i+1, r.ItemCode||'', r.ItemName||'', (sys!=null?sys:''), phy,
        (r.PhysicalAt?new Date(r.PhysicalAt).toLocaleString():''), po,
        (r.PickoutAt?new Date(r.PickoutAt).toLocaleString():''),
        (r.Status||'') ]);
      row.eachCell({includeEmpty:true}, c=>{ c.border = allBorders; });
      if(i%2===1) row.eachCell({includeEmpty:true}, c=>{ if(!c.fill) c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFAFCFF'}}; });
      const f = qtyFill(eff, sys); const cell = row.getCell(5);
      if(f){ cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:f.argb}}; cell.font={bold:true,color:{argb:f.font}}; }
      cell.alignment={horizontal:'center'};
      [4,7].forEach(ci=>row.getCell(ci).alignment={horizontal:'center'});
    });
    ws.columns = [{width:5},{width:14},{width:40},{width:11},{width:11},{width:21},{width:11},{width:21},{width:14}];
    const buf = await wb.xlsx.writeBuffer();
    const fname = 'Total_Audit_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="'+fname+'"');
    return res.send(Buffer.from(buf));
  }catch(err){ console.error('[retailer/item-audit-excel]', err); return res.status(500).json({ error:'excel failed', detail: err.message }); }
});

module.exports = router;
