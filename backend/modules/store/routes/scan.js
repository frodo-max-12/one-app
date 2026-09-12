/* ============================================================================
   backend/modules/store/routes/scan.js
   Retailer — Store Auditing : scan capture + listing + total audit.

   Follows backend/modules/warehouse/routes/stocks.js conventions:
     - auth gating via the shared middleware (authenticate / isStore)
     - NAV reads ONLY through getPool()      (NAV_Live, read-only)
     - app writes through getAppPool()        (BizNAV_App)
     - soft-delete (IsActive = 0), never hard DELETE
     - Company scope taken from the session

   ┌───────────────────────────────────────────────────────────────────────┐
   │ ADJUST THESE 3 IMPORTS to match your actual project paths/names.        │
   │ (Copied the warehouse module's imports as the starting point — if your  │
   │  warehouse stocks.js imports them differently, mirror that exactly.)    │
   └───────────────────────────────────────────────────────────────────────┘
   ============================================================================ */

const express = require('express');
const router = express.Router();

/* ---- shared helpers (use the SAME names your auth.js actually exports) ---- */
const { getAppPool } = require('../../../db');          // BizNAV_App pool (writes)
const { getPool }    = require('../../../db');          // NAV pool (READ-ONLY: NAV_Live)
const { authenticate, isStore: isStoreRole, isFullAccess, isAnyHead, isRetailerAuditor } = require('../../../auth');   // session check + store-role check
const sql = require('mssql');

/* CRITICAL FIX: auth.js exports isStore as a BOOLEAN function (user) => true/false,
   NOT as Express middleware. Using it directly as middleware made requests HANG
   forever (it returned a boolean Express ignored and never called next()). This
   wraps it in real middleware that checks the role and either calls next() or
   responds 403. Store users + admin family + heads get access. */
function isStore(req, res, next){
    const user = req.user;
    if (isStoreRole(user) || isFullAccess(user) || isAnyHead(user)) {
        return next();
    }
    return res.status(403).json({ error: 'Store access required' });
}

/* Access for the shared scan endpoints that the 4 Retailer AUDITORS also use
   (inward scanning, lookup, list, total). Store + admin + heads + auditors. */
function isStoreOrAuditor(req, res, next){
    const user = req.user;
    if (isStoreRole(user) || isFullAccess(user) || isAnyHead(user) ||
        (typeof isRetailerAuditor === 'function' && isRetailerAuditor(user))) {
        return next();
    }
    return res.status(403).json({ error: 'Store/auditor access required' });
}

/* NAV table names (live company DB). READ-ONLY — never insert/update/delete here. */
const NAV_ITEM       = '[dbo].[Company A Pvt_ Ltd_$Item]';
const NAV_ITEM_LEDGER= '[dbo].[Company A Pvt_ Ltd_$Item Ledger Entry]';

/* Look up an item code (Vendor Item No_) in NAV → { itemCode, description, inventoryQty }.
   inventoryQty = SUM of Remaining Quantity across all ledger entries for that item.
   Uses getPool() (NAV, read-only). Returns null if not found. */
async function lookupNavItem(code){
  const c = (code || '').toString().trim();
  if(!c) return null;
  /* Try the FULL code first (with any letter suffix, e.g. 252006EE). If that
     finds nothing, fall back to the digits-only form (252006). This way a REAL
     suffix matches its exact item, but an OCR-noise suffix (a stray letter) still
     resolves to the right numeric item instead of failing. */
  const digitsOnly = c.replace(/[^0-9]/g,'');
  const candidates = (digitsOnly && digitsOnly !== c) ? [c, digitsOnly] : [c];

  let lastErr = null;
  for(const cand of candidates){
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const pool = await getPool();                 // NAV read-only pool
        const r = await pool.request()
          .input('code', sql.NVarChar(50), cand)
          .query(`
            SELECT TOP 1 I.[Vendor Item No_] AS ItemCode,
                   I.[Description]           AS Description,
                   ( SELECT ROUND(ISNULL(SUM(ILE2.[Remaining Quantity]),0), 0)
                     FROM ${NAV_ITEM_LEDGER} ILE2
                     WHERE ILE2.[Item No_] = I.[No_] ) AS InventoryQty
            FROM ${NAV_ITEM} I
            WHERE I.[Vendor Item No_] = @code
          `);
        if(r.recordset && r.recordset.length){
          const row = r.recordset[0];
          return { itemCode: row.ItemCode, description: row.Description, inventoryQty: (row.InventoryQty != null ? row.InventoryQty : 0) };
        }
        break;   // query succeeded but no match for this candidate → try next candidate
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(res => setTimeout(res, 120));  // one short retry
      }
    }
  }
  if(lastErr) console.error('[lookupNavItem] failed for', c, lastErr && lastErr.message);
  return null;   // genuinely not found under either form
  throw lastErr || new Error('NAV lookup failed');
}

/* Company scope + user identity from the session.
   Store / Retailer Auditing is COMPANYA-only by design, so company is fixed to 'COMPANYA'
   (never CompanyB). userOf reads the logged-in user for the audit trail. */
function companyOf(req) {
    return 'COMPANYA';
}
function userOf(req) {
    return (req.user && (req.user.email || req.user.Email || req.user.username || req.user.Username)) || 'unknown';
}
/* Friendly display name for "Captured by" (Raj / Sahil / etc.). The store login
   has no auditor name, so for it this returns the store name — but we only WRITE
   it for auditor roles, leaving store-captured rows blank as requested. */
function userName(req) {
    return (req.user && (req.user.name || req.user.Name)) || null;
}
/* Is the current user one of the 4 named auditors? (so we stamp their name). */
function isAuditorUser(req) {
    const role = (req.user && (req.user.role || req.user.Role) || '').toLowerCase().trim();
    return role === 'retailer auditor';
}

/* ===========================================================================
   GET /api/store/scan/lookup?code=252080
   Resolve an item code via NAV (read-only) → { itemCode, description, inventoryQty }.
   The scanner calls this the moment it reads a code, to show the real name + stock.
   =========================================================================== */
router.get('/lookup', authenticate, isStoreOrAuditor, async (req, res) => {
    try {
        const code = (req.query.code || '').toString().trim();
        if (!code) return res.status(400).json({ error: 'code required' });
        const item = await lookupNavItem(code);
        if (!item) return res.status(404).json({ error: 'item code not found', itemCode: code });
        return res.json(item);
    } catch (err) {
        console.error('[store/scan lookup]', err);
        /* return the real DB error message so we can see WHY (wrong table, db, etc.) */
        return res.status(500).json({ error: 'lookup failed', detail: (err && err.message) ? err.message : String(err) });
    }
});

/* DIAGNOSTIC — confirms which NAV database the app is actually connected to.
   Open in a browser while logged in: /api/store/scan/dbcheck
   Remove this route once everything works. */
router.get('/dbcheck', authenticate, isStore, async (req, res) => {
    try {
        const pool = await getPool();
        const r = await pool.request().query(`SELECT DB_NAME() AS db, @@SERVERNAME AS server`);
        return res.json(r.recordset[0]);
    } catch (err) {
        return res.status(500).json({ error: 'dbcheck failed', detail: (err && err.message) || String(err) });
    }
});

/* ===========================================================================
   POST /api/store/scan
   Save one scan (inward or outward). Body:
     { modelName, qty, direction:'IN'|'OUT', itemCode?, brand?,
       scanStatus:'GREEN'|'YELLOW', ocrSource?, ocrRawText?, imagePath?, capturedAt }
   Outward is stored as a NEGATIVE qty.
   =========================================================================== */
router.post('/', authenticate, isStoreOrAuditor, async (req, res) => {
    try {
        const b = req.body || {};
        let itemCode = (b.itemCode || '').toString().trim().slice(0, 50);
        let modelName = (b.modelName || '').toString().trim().slice(0, 200);
        let qtyPerBox = parseInt(b.qty, 10);          // units per box (field name 'qty' from client)
        let boxes = parseInt(b.boxes, 10);
        const direction = (b.direction || 'IN').toString().toUpperCase() === 'OUT' ? 'OUT' : 'IN';

        /* Look up the real product name + inventory from NAV at save time and store
           the NAME (not the code). The NAV lookup is fast (returns in milliseconds),
           so this does not slow the save. If NAV genuinely has nothing for this code,
           we fall back to storing the code as the name. */
        let navInventory = null;
        if (itemCode) {
            try {
                const nav = await lookupNavItem(itemCode);
                if (nav && nav.description) modelName = nav.description.slice(0, 200);
                if (nav && nav.inventoryQty != null) navInventory = nav.inventoryQty;
            } catch (e) {
                console.error('[store/scan save] NAV lookup failed for', itemCode, e.message);
                /* keep whatever name we have; /list will re-resolve later */
            }
        }

        if (!itemCode && !modelName) return res.status(400).json({ error: 'itemCode or modelName required' });
        if (!modelName) modelName = itemCode;   // fall back to code as the name if NAV had nothing
        if (!Number.isFinite(qtyPerBox) || qtyPerBox <= 0) return res.status(400).json({ error: 'valid qty required' });
        if (!Number.isFinite(boxes) || boxes <= 0) boxes = 1;

        qtyPerBox = Math.abs(qtyPerBox);
        const total = qtyPerBox * boxes;                          // grand total units
        const signedQty = direction === 'OUT' ? -total : total;   // outward stored negative

        /* Save the carton photo (base64 data URL) to disk under uploads/store/ and keep the path.
           uploads/** is git-ignored per team convention. Mirror how other modules store images. */
        let imagePath = null;
        try {
            if (b.photoData && /^data:image\//.test(b.photoData)) {
                const fs = require('fs');
                const path = require('path');
                const dir = path.join(__dirname, '..', '..', '..', 'uploads', 'store');
                fs.mkdirSync(dir, { recursive: true });
                const base64 = b.photoData.replace(/^data:image\/\w+;base64,/, '');
                const fname = 'scan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.jpg';
                fs.writeFileSync(path.join(dir, fname), Buffer.from(base64, 'base64'));
                imagePath = 'uploads/store/' + fname;
            }
        } catch (imgErr) {
            console.error('[store/scan photo save]', imgErr);   // non-fatal — scan still saves
        }

        const pool = await getAppPool();
        const result = await pool.request()
            .input('ModelName',  sql.NVarChar(200), modelName)
            .input('QtyPerBox',  sql.Int,           qtyPerBox)
            .input('Boxes',      sql.Int,           boxes)
            .input('Qty',        sql.Int,           signedQty)
            .input('Direction',  sql.VarChar(10),   direction)
            .input('Module',     sql.VarChar(20),   direction)
            .input('ItemCode',   sql.NVarChar(50),  itemCode || null)
            .input('Brand',      sql.NVarChar(50),  b.brand || null)
            .input('ScanStatus', sql.VarChar(10),   (b.scanStatus || 'GREEN').toUpperCase())
            .input('OcrSource',  sql.VarChar(20),   b.ocrSource || null)
            .input('OcrRawText', sql.NVarChar(sql.MAX), b.ocrRawText || null)
            .input('ImagePath',  sql.NVarChar(400), imagePath || b.imagePath || null)
            .input('CapturedAt', sql.DateTime2,     b.capturedAt ? new Date(b.capturedAt) : new Date())
            /* Only stamp a name for the 4 named auditors. Store-login scans stay blank. */
            .input('CapturedByName', sql.NVarChar(150), isAuditorUser(req) ? userName(req) : null)
            .input('Company',    sql.NVarChar(100), companyOf(req))
            .input('CreatedBy',  sql.NVarChar(150), userOf(req))
            /* freeze NAV inventory AS OF THIS CAPTURE so the audit stays comparable
               later, even after NAV stock moves */
            .input('SysQtyAtCapture', sql.Decimal(18,2), (navInventory != null ? navInventory : null))
            .query(`
                INSERT INTO dbo.BN_StoreScan
                    (ModelName, QtyPerBox, Boxes, Qty, Direction, Module, ItemCode, Brand, ScanStatus,
                     OcrSource, OcrRawText, ImagePath, CapturedAt, CapturedByName,
                     Company, IsActive, CreatedAt, CreatedBy, SystemQtyAtCapture)
                OUTPUT INSERTED.Id
                VALUES
                    (@ModelName, @QtyPerBox, @Boxes, @Qty, @Direction, @Module, @ItemCode, @Brand, @ScanStatus,
                     @OcrSource, @OcrRawText, @ImagePath, @CapturedAt, @CapturedByName,
                     @Company, 1, SYSUTCDATETIME(), @CreatedBy, @SysQtyAtCapture)
            `);

        const id = result.recordset && result.recordset[0] && result.recordset[0].Id;
        return res.status(201).json({ id, modelName, itemCode, qtyPerBox, boxes, qty: signedQty, direction, inventoryQty: navInventory });
    } catch (err) {
        console.error('[store/scan POST]', err);
        return res.status(500).json({ error: 'save failed' });
    }
});

/* DIAGNOSTIC — tests each piece separately so we can see EXACTLY what fails.
   Open while logged in: /api/store/scan/diag
   Returns timing + result for: app DB read, NAV read. Remove once fixed. */
router.get('/diag', authenticate, isStore, async (req, res) => {
    const out = { steps: [] };
    /* Step 1: read from app DB (BizNAV_App) */
    try {
        const t0 = Date.now();
        const pool = await getAppPool();
        const r = await pool.request()
            .input('Company', sql.NVarChar(100), companyOf(req))
            .query(`SELECT COUNT(*) AS n FROM dbo.BN_StoreScan WHERE Company=@Company AND IsActive=1`);
        out.steps.push({ step: 'appDB_read', ok: true, ms: Date.now() - t0, count: r.recordset[0].n });
    } catch (e) {
        out.steps.push({ step: 'appDB_read', ok: false, error: e.message });
    }
    /* Step 2: read from NAV (NAV_Live) */
    try {
        const t0 = Date.now();
        const pool = await getPool();
        const r = await pool.request()
            .input('code', sql.NVarChar(50), '252108')
            .query(`SELECT TOP 1 [Description] AS d FROM ${NAV_ITEM} WHERE [Vendor Item No_]=@code`);
        out.steps.push({ step: 'nav_read', ok: true, ms: Date.now() - t0, found: r.recordset.length ? r.recordset[0].d : null });
    } catch (e) {
        out.steps.push({ step: 'nav_read', ok: false, error: e.message });
    }
    /* Step 3: the full NAV lookup (name + inventory) */
    try {
        const t0 = Date.now();
        const nav = await lookupNavItem('252108');
        out.steps.push({ step: 'full_lookup', ok: true, ms: Date.now() - t0, result: nav });
    } catch (e) {
        out.steps.push({ step: 'full_lookup', ok: false, error: e.message });
    }
    return res.json(out);
});

/* ===========================================================================
   GET /api/store/scan/list?direction=IN|OUT
   List active scans for this company, newest first.
   =========================================================================== */
router.get('/list', authenticate, isStoreOrAuditor, async (req, res) => {
    try {
        const dir = (req.query.direction || '').toString().toUpperCase();
        const pool = await getAppPool();
        const request = pool.request().input('Company', sql.NVarChar(100), companyOf(req));

        let where = 'WHERE Company = @Company AND IsActive = 1';
        if (dir === 'IN' || dir === 'OUT') {
            where += ' AND Direction = @Direction';
            request.input('Direction', sql.VarChar(10), dir);
        }
        /* auditors see ONLY their own captures; store/admin/heads see everyone's */
        const u = req.user;
        const isStoreSide = isStoreRole(u) || isFullAccess(u) || isAnyHead(u);
        if (!isStoreSide && typeof isRetailerAuditor === 'function' && isRetailerAuditor(u)) {
            where += ' AND CreatedBy = @Me';
            request.input('Me', sql.NVarChar(150), userOf(req));
        }

        const result = await request.query(`
            SELECT Id, ModelName, QtyPerBox, Boxes, Qty, Direction, ItemCode, Brand, ScanStatus,
                   OcrSource, ImagePath, CapturedAt, CreatedAt, CreatedBy
            FROM dbo.BN_StoreScan
            ${where}
            ORDER BY CreatedAt DESC
        `);

        /* Re-resolve the real name + inventory from NAV for the displayed rows.
           Run all lookups IN PARALLEL with a total timeout cap so the list is always
           fast and returns even if NAV is slow (a slow list was making data fail to
           load on reopen). If NAV is slow, rows keep their stored name; names/inv
           fill in on a later refresh. */
        const rows = result.recordset || [];
        const codes = [...new Set(rows.filter(r => r.ItemCode).map(r => r.ItemCode.trim()))];
        if (codes.length) {
            const nameMap = {}, invMap = {};
            const lookups = codes.map(code =>
                lookupNavItem(code)
                    .then(nav => { if (nav) { if (nav.description) nameMap[code] = nav.description; invMap[code] = nav.inventoryQty; } })
                    .catch(() => {})
            );
            /* cap the whole batch at 3s — never let NAV stall the list response */
            const cap = new Promise(res => setTimeout(res, 3000));
            await Promise.race([Promise.all(lookups), cap]);
            for (const r of rows) {
                const c = r.ItemCode && r.ItemCode.trim();
                if (c) {
                    if ((!r.ModelName || r.ModelName === r.ItemCode) && nameMap[c]) r.ModelName = nameMap[c];
                    r.InventoryQty = (invMap[c] != null) ? invMap[c] : null;
                }
            }
        }
        return res.json(rows);
    } catch (err) {
        console.error('[store/scan list]', err);
        return res.status(500).json({ error: 'list failed' });
    }
});

/* ===========================================================================
   GET /api/store/scan/total
   Total Audit: net qty per model = sum(inward) + sum(outward).
   =========================================================================== */
/* Shared: run the Total-Audit aggregation (used by both /total JSON and /total-excel). */
async function buildTotalRows(req){
    const q = (req.query.q || '').toString().trim();
    const date = (req.query.date || '').toString().trim();
    const from = (req.query.from || '').toString().trim();
    const to = (req.query.to || '').toString().trim();

    const conds = ['Company = @Company', 'IsActive = 1'];
    const reqst = (await getAppPool()).request();
    reqst.input('Company', sql.NVarChar(100), companyOf(req));

    if (q) { conds.push('(ModelName LIKE @q OR ItemCode LIKE @q)'); reqst.input('q', sql.NVarChar(200), '%' + q + '%'); }

    if (date) {
        conds.push('CAST(COALESCE(CapturedAt, CreatedAt) AS DATE) = @date');
        reqst.input('date', sql.Date, new Date(date));
    } else {
        if (from) { conds.push('CAST(COALESCE(CapturedAt, CreatedAt) AS DATE) >= @from'); reqst.input('from', sql.Date, new Date(from)); }
        if (to)   { conds.push('CAST(COALESCE(CapturedAt, CreatedAt) AS DATE) <= @to');   reqst.input('to',   sql.Date, new Date(to)); }
    }

    const where = 'WHERE ' + conds.join(' AND ');
    const result = await reqst.query(`
        SELECT t.ItemCode,
               t.InwardQty, t.OutwardQty, t.NetQty, t.LastScan,
               ( SELECT TOP 1 s2.ModelName
                 FROM dbo.BN_StoreScan s2
                 WHERE s2.ItemCode = t.ItemCode AND s2.Company = @Company AND s2.IsActive = 1
                   AND s2.ModelName IS NOT NULL AND s2.ModelName <> s2.ItemCode
                 ORDER BY LEN(s2.ModelName) DESC ) AS ModelName
        FROM (
            SELECT ItemCode,
                   SUM(CASE WHEN Direction = 'IN'  THEN Qty ELSE 0 END) AS InwardQty,
                   SUM(CASE WHEN Direction = 'OUT' THEN Qty ELSE 0 END) AS OutwardQty,
                   SUM(Qty) AS NetQty,
                   MAX(COALESCE(CapturedAt, CreatedAt)) AS LastScan
            FROM dbo.BN_StoreScan
            ${where}
            GROUP BY ItemCode
        ) t
        ORDER BY ModelName
    `);

    const rows = result.recordset || [];
    const codes = [...new Set(rows.map(r => (r.ItemCode || '').trim()).filter(Boolean))];
    const invMap = {};
    if (codes.length) {
        const lookups = codes.map(code =>
            lookupNavItem(code).then(nav => { if (nav) invMap[code] = nav.inventoryQty; }).catch(() => {})
        );
        const cap = new Promise(res => setTimeout(res, 3000));
        await Promise.race([Promise.all(lookups), cap]);
    }
    for (const r of rows) {
        r.InventoryQty = (r.ItemCode && invMap[r.ItemCode.trim()] != null) ? invMap[r.ItemCode.trim()] : null;
    }
    return rows;
}

router.get('/total', authenticate, isStore, async (req, res) => {
    try {
        const rows = await buildTotalRows(req);
        return res.json(rows);
    } catch (err) {
        console.error('[store/scan total]', err);
        return res.status(500).json({ error: 'total failed' });
    }
});

/* ===========================================================================
   GET /api/store/scan/total-excel  → a REAL, STYLED .xlsx file (server-generated
   via exceljs — no CDN). Dark bold header, borders on every cell, and Inward Qty
   cells colour-coded green/orange/red vs inventory with a legend. Same filters as /total.
   =========================================================================== */
router.get('/total-excel', authenticate, isStore, async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const rows = await buildTotalRows(req);
        const round = v => (v == null ? null : Math.round(v));

        const wb = new ExcelJS.Workbook();
        wb.creator = 'ONE App';
        const ws = wb.addWorksheet('Total Audit');

        const thin = { style:'thin', color:{argb:'FF999999'} };
        const allBorders = { top:thin, bottom:thin, left:thin, right:thin };
        const stamp = new Date().toISOString().slice(0,10);

        /* Title row */
        ws.addRow(['ONE App — Store Retailer Auditing — Total Audit ('+stamp+')']);
        ws.mergeCells('A1:I1');
        ws.getCell('A1').font = { bold:true, size:13 };
        ws.getRow(1).height = 20;

        /* Legend row with colour swatches */
        ws.addRow(['Inward Qty colour:', 'GREEN = equals Inventory', 'ORANGE = less than Inventory', 'RED = exceeds Inventory']);
        const legRow = ws.getRow(2);
        legRow.getCell(1).font = { bold:true };
        const legColors = [null,'FFC6EFCE','FFFFEB9C','FFFFC7CE'];
        legColors.forEach((argb,idx)=>{
            if(!argb) return;
            const c = legRow.getCell(idx+1);
            c.fill = { type:'pattern', pattern:'solid', fgColor:{argb} };
            c.font = { bold:true };
            c.border = allBorders;
        });

        ws.addRow([]);   // spacer

        /* Header row (row 4) — DARK background, BOLD white text, borders */
        const header = ['#','Item Code','Item Name','Inventory Qty','Inward Qty','Outward Qty','Total Qty','Last Capture','Status'];
        ws.addRow(header);
        const headerRowIdx = 4;
        const hr = ws.getRow(headerRowIdx);
        hr.eachCell(c=>{
            c.font = { bold:true, color:{argb:'FFFFFFFF'}, size:11 };
            c.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1F2937'} };   // dark slate
            c.alignment = { horizontal:'center', vertical:'middle' };
            c.border = allBorders;
        });
        hr.height = 22;

        /* Data rows */
        rows.forEach((r,i)=>{
            const inv = round(r.InventoryQty), inw = round(r.InwardQty)||0, out = round(r.OutwardQty)||0, net = round(r.NetQty)||0;
            const row = ws.addRow([ i+1, r.ItemCode||'', r.ModelName||'',
                (inv!=null?inv:''), inw, out, net,
                (r.LastScan ? new Date(r.LastScan).toLocaleString() : ''),
                (net===0?'Balanced':(net>0?'In stock':'Short')) ]);
            /* borders on every cell + zebra striping */
            row.eachCell({includeEmpty:true}, c=>{ c.border = allBorders; });
            if(i % 2 === 1){
                row.eachCell({includeEmpty:true}, c=>{ if(!c.fill) c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFAFCFF'}}; });
            }
            /* colour the Inward Qty cell (column 5) green/orange/red vs inventory */
            const inwCell = row.getCell(5);
            if(inv!=null){
                let argb=null, fontColor=null;
                if(inw===inv){ argb='FFC6EFCE'; fontColor='FF0F5132'; }
                else if(inw<inv){ argb='FFFFEB9C'; fontColor='FF7F6000'; }
                else { argb='FFFFC7CE'; fontColor='FF9C0006'; }
                inwCell.fill = { type:'pattern', pattern:'solid', fgColor:{argb} };
                inwCell.font = { bold:true, color:{argb:fontColor} };
            }
            inwCell.alignment = { horizontal:'center' };
            row.getCell(4).alignment = { horizontal:'center' };
            row.getCell(6).alignment = { horizontal:'center' };
            row.getCell(7).alignment = { horizontal:'center' };
        });

        /* Column widths */
        ws.columns = [
            {width:5},{width:14},{width:42},{width:13},{width:11},{width:12},{width:10},{width:22},{width:11}
        ];

        const buf = await wb.xlsx.writeBuffer();
        const fname = 'Total_Audit_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.xlsx';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
        return res.send(Buffer.from(buf));
    } catch (err) {
        console.error('[store/scan total-excel]', err);
        return res.status(500).json({ error: 'excel failed' });
    }
});

/* ===========================================================================
   DELETE /api/store/scan/:id   (HARD delete — physically removes the row)
   =========================================================================== */
router.delete('/:id', authenticate, isStoreOrAuditor, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });

        const pool = await getAppPool();
        const r = await pool.request()
            .input('Id', sql.Int, id)
            .input('Company', sql.NVarChar(100), companyOf(req))
            .query(`
                DELETE FROM dbo.BN_StoreScan
                WHERE Id = @Id AND Company = @Company
            `);
        return res.json({ id, deleted: true, rows: (r.rowsAffected && r.rowsAffected[0]) || 0 });
    } catch (err) {
        console.error('[store/scan DELETE]', err);
        return res.status(500).json({ error: 'delete failed' });
    }
});

/* UPDATE — edit qty per box and/or boxes of an existing scan (e.g. partial outwards).
   Recomputes the signed grand total. Writes only to BN_StoreScan in BizNAV_App. */
router.put('/:id', authenticate, isStoreOrAuditor, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });

        const b = req.body || {};
        let qtyPerBox = parseInt(b.qty, 10);
        let boxes = parseInt(b.boxes, 10);
        if (!Number.isFinite(qtyPerBox) || qtyPerBox <= 0) return res.status(400).json({ error: 'valid qty required' });
        if (!Number.isFinite(boxes) || boxes <= 0) boxes = 1;

        const pool = await getAppPool();

        /* read the row's direction so the sign stays correct */
        const cur = await pool.request()
            .input('Id', sql.Int, id)
            .input('Company', sql.NVarChar(100), companyOf(req))
            .query(`SELECT Direction FROM dbo.BN_StoreScan WHERE Id=@Id AND Company=@Company AND IsActive=1`);
        if (!cur.recordset.length) return res.status(404).json({ error: 'not found' });

        const direction = cur.recordset[0].Direction === 'OUT' ? 'OUT' : 'IN';
        qtyPerBox = Math.abs(qtyPerBox);
        const total = qtyPerBox * boxes;
        const signedQty = direction === 'OUT' ? -total : total;

        await pool.request()
            .input('Id',        sql.Int, id)
            .input('QtyPerBox', sql.Int, qtyPerBox)
            .input('Boxes',     sql.Int, boxes)
            .input('Qty',       sql.Int, signedQty)
            .input('UpdatedBy', sql.NVarChar(150), userOf(req))
            .input('Company',   sql.NVarChar(100), companyOf(req))
            .query(`
                UPDATE dbo.BN_StoreScan
                SET QtyPerBox=@QtyPerBox, Boxes=@Boxes, Qty=@Qty, UpdatedAt=SYSUTCDATETIME()
                WHERE Id=@Id AND Company=@Company AND IsActive=1
            `);
        return res.json({ id, qtyPerBox, boxes, qty: signedQty, direction });
    } catch (err) {
        console.error('[store/scan PUT]', err);
        return res.status(500).json({ error: 'update failed' });
    }
});

module.exports = router;
