// =====================================================================
// modules/sales/routes/actionPoints.js — MOM Action Points tracker  [v1.12]
//
// A follow-up tracker over the SmartSys ERP's MOM action points (~4,200 live).
// Grid modelled on SmartSys's ProViews/MOMPendingActionPointList.
//
//   GET   /api/sales/action-points   list + summary  ?view&status&overdue&search
//                                     + column filters: customer,vendor,assignedBy,resource,momId
//   GET   /api/sales/action-points/export            .xlsx in SmartSys's 12-col format
//   PATCH /api/sales/action-points/:id  { status, comment }  inline status change
//         (via SmartSys's own sp_TMsaveMOMActionPoint → the change date/user is
//          recorded in TM_ProjectTaskMOMActionPointsComments). ?dryRun=true = rollback.
//
// ── Relationship model (SmartSys) ────────────────────────────────────────────
//   TM_ProjectTaskMOMActionPoints        one row/AP (Status, DueDate, AssignedBy=creator
//                                        SysUserId, ModifiedBy, ModifiedDate, MOMId)
//   TM_ProjectTaskMOMActionPointsUser    who it's ASSIGNED TO (Resource; Employee→UserId=SysUserId)
//   TM_ProjectTaskMOMActionPointsComments status-change trail (StatusId + CommentDate + CommentedBy)
// Status: 26 New · 29 Inprogress · 33 OnHold (pending) · 30 Complete · 32 Cancelled.
//
// Views: mine (assigned-to/created-by me) · team (subtree; fae-head=FAE team) · all
// (admin + MIS Store). MIS Store is read-only (blocked from PATCH).
// =====================================================================

const express = require('express');
const router  = express.Router();
const XLSX    = require('xlsx');
const { sql, getSmartSysPool, getAppPool } = require('../../../db');
const { authenticate, isFullAccess, isFaeHead, isAnyHead } = require('../../../auth');

const PENDING = '26,29,33';
const DONEISH = '30,32';
const AP_STATUS = { 26: 'New', 29: 'Inprogress', 30: 'Complete', 32: 'Cancelled', 33: 'OnHold' };
// "Pending With" — a ONE-App-only overlay (BizNAV_App.BN_MOMActionPointMeta, keyed
// by ActionPointId). NOT in SmartSys. '' / 'None' clears it.
const PENDING_WITH = ['Customer', 'Sales', 'Supplier/Vendor', 'FAE', 'Purchase', 'Product', 'Accounts', 'Logistics', 'Management'];

function seesAll(user) { return isFullAccess(user) || (user.role || '').toLowerCase().trim() === 'mis store'; }
function isReadOnlyViewer(user) { return (user.role || '').toLowerCase().trim() === 'mis store'; }

// resolve ONE App user → SmartSys SysUserId + EmpId + User_Id GUID (cached)
const _cache = new Map(); const TTL = 10 * 60 * 1000;
async function resolveMe(pool, user) {
  const uname = (user.username || '').toLowerCase().trim();
  const email = (user.email || '').toLowerCase().trim();
  const key = uname + '|' + email;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit;
  const q = await pool.request().input('u', sql.NVarChar(256), uname).input('e', sql.NVarChar(256), email).query(`
    SELECT TOP 1 su.User_Id AS Guid, su.UserId AS SysUserId, e.EmpId
    FROM dbo.tbl_SysUser su LEFT JOIN dbo.tbl_SysEmployee e ON e.UserId = su.UserId
    WHERE LOWER(su.UserName) IN (@u,@e) OR LOWER(su.Email) IN (@u,@e)
    ORDER BY CASE WHEN e.EmpId IS NULL THEN 1 ELSE 0 END;`);
  const row = q.recordset[0] || null;
  const val = { guid: row ? row.Guid : null, sysUserId: row ? row.SysUserId : null, empId: row ? row.EmpId : null, ts: Date.now() };
  _cache.set(key, val);
  return val;
}
let _faeU = null, _faeUts = 0;
async function faeTeamUserIds(pool) {
  if (_faeU && Date.now() - _faeUts < TTL) return _faeU;
  const q = await pool.request().query(`
    SELECT DISTINCT e.UserId
    FROM BizNAV_App.dbo.User_Login ul
    JOIN dbo.tbl_SysUser su ON LOWER(su.UserName)=LOWER(ul.Username) OR LOWER(su.UserName)=LOWER(ul.Email)
    JOIN dbo.tbl_SysEmployee e ON e.UserId = su.UserId
    WHERE LOWER(ul.Role) IN ('fae','fae head') AND e.UserId IS NOT NULL;`);
  _faeU = q.recordset.map(r => r.UserId); _faeUts = Date.now();
  return _faeU;
}

const SUB_CTE = `
  ;WITH cteEmp (EmpId, ManagerId) AS (
     SELECT e.EmpId, CASE WHEN e.ManagerId=e.EmpId THEN 0 ELSE e.ManagerId END FROM dbo.tbl_SysEmployee e WHERE e.EmpId=@empId
     UNION ALL
     SELECT e.EmpId, e.ManagerId FROM dbo.tbl_SysEmployee e INNER JOIN cteEmp c ON c.EmpId=e.ManagerId AND e.EmpId<>e.ManagerId)
  SELECT DISTINCT e.UserId INTO #su FROM cteEmp c JOIN dbo.tbl_SysEmployee e ON e.EmpId=c.EmpId WHERE e.UserId IS NOT NULL;`;

const ASSIGNED_TO = (idsSql) =>
  `EXISTS(SELECT 1 FROM dbo.TM_ProjectTaskMOMActionPointsUser u WHERE u.ActionPointId=AP.ActionPointId AND u.UserType='Employee' AND u.UserId IN (${idsSql}))`;

// Returns { pre, where, drop, view, allowed }
async function buildScope(pool, r, user, reqView) {
  const all = seesAll(user);
  const me = await resolveMe(pool, user);
  const isHead = isAnyHead(user) || isFaeHead(user);
  const allowed = [];
  if (me.sysUserId) allowed.push('mine');
  if (isHead || all) allowed.push('team');
  if (all) allowed.push('all');
  if (!allowed.length) return { pre: '', where: '1=0', drop: '', view: 'mine', allowed: [] };
  let view = (reqView && allowed.includes(reqView)) ? reqView : (all ? 'all' : 'mine');
  if (!allowed.includes(view)) view = allowed[0];

  if (view === 'all') return { pre: '', where: '1=1', drop: '', view, allowed };
  if (view === 'mine') {
    r.input('me', sql.Int, me.sysUserId);
    return { pre: '', view, allowed, drop: '', where: `(AP.CreatedBy=@me OR ${ASSIGNED_TO('@me')})` };
  }
  if (isFaeHead(user)) {
    const ids = await faeTeamUserIds(pool);
    if (!ids.length) return { pre: '', where: '1=0', drop: '', view, allowed };
    const ph = ids.map((id, i) => { r.input('su' + i, sql.Int, id); return '@su' + i; });
    return { pre: '', where: ASSIGNED_TO(ph.join(',')), drop: '', view, allowed };
  }
  if (!me.empId) return { pre: '', where: '1=0', drop: '', view, allowed };
  r.input('empId', sql.Int, me.empId);
  return { pre: SUB_CTE, where: ASSIGNED_TO('SELECT UserId FROM #su'), drop: 'DROP TABLE #su;', view, allowed };
}

// status/overdue/search + per-column filters (customer, vendor, assignedBy, resource=name, momId)
function filters(r, q) {
  const parts = [];
  const s = (q.status || '').toLowerCase();
  if (s === 'pending')   parts.push(`AP.Status IN (${PENDING})`);
  else if (s === 'complete')  parts.push(`AP.Status = 30`);
  else if (s === 'cancelled') parts.push(`AP.Status = 32`);
  else if (s === 'inprogress') parts.push(`AP.Status = 29`);
  else if (s === 'onhold')     parts.push(`AP.Status = 33`);
  if (String(q.overdue || '').toLowerCase() === 'true') parts.push(`AP.DueDate < CAST(GETDATE() AS DATE) AND AP.Status NOT IN (${DONEISH})`);
  if ((q.search || '').trim()) {
    r.input('q', sql.NVarChar(200), '%' + q.search.trim() + '%');
    parts.push(`(AP.ActionDescription LIKE @q OR MOM.Title LIKE @q OR A.UserName LIKE @q OR C.CustomerName LIKE @q
      OR EXISTS(SELECT 1 FROM dbo.TM_ProjectTaskMOMActionPointsUser apu JOIN dbo.tbl_SysEmployee ape ON apu.UserId = ape.UserId
                WHERE apu.ActionPointId = AP.ActionPointId AND apu.UserType='Employee' AND (ape.FirstName + ' ' + ISNULL(ape.LastName,'')) LIKE @q))`);
  }
  if ((q.customer   || '').trim()) { r.input('fCust', sql.NVarChar(200), '%' + q.customer.trim() + '%'); parts.push('C.CustomerName LIKE @fCust'); }
  if ((q.vendor     || '').trim()) { r.input('fVend', sql.NVarChar(200), '%' + q.vendor.trim() + '%'); parts.push('V.VendorName LIKE @fVend'); }
  if ((q.assignedBy || '').trim()) { r.input('fAB',   sql.NVarChar(200), '%' + q.assignedBy.trim() + '%'); parts.push('A.UserName LIKE @fAB'); }
  // resource = the salesperson/FAE NAME filter (heads/admin drill to one person)
  if ((q.resource   || '').trim()) { r.input('fRes',  sql.NVarChar(200), '%' + q.resource.trim() + '%');
    parts.push(`EXISTS(SELECT 1 FROM dbo.TM_ProjectTaskMOMActionPointsUser ru JOIN dbo.tbl_SysEmployee re ON ru.UserId=re.UserId
                WHERE ru.ActionPointId=AP.ActionPointId AND ru.UserType='Employee' AND (re.FirstName+' '+ISNULL(re.LastName,'')) LIKE @fRes)`); }
  if (/^\d+$/.test(String(q.momId || '').trim())) { r.input('fMom', sql.Int, parseInt(q.momId, 10)); parts.push('AP.MOMId = @fMom'); }
  if ((q.pendingWith || '').trim()) { r.input('fPW', sql.NVarChar(40), q.pendingWith.trim()); parts.push('PW.PendingWith = @fPW'); }
  return parts;
}

const AP_FROM = `
  FROM dbo.TM_ProjectTaskMOMActionPoints AP
  LEFT JOIN dbo.TM_ProjectTaskMOM MOM ON AP.MOMId = MOM.MOMId
  LEFT JOIN dbo.tbl_SysStatusCodes S  ON AP.Status = S.StatusId
  LEFT JOIN dbo.tbl_SysUser A         ON AP.AssignedBy = A.UserId
  LEFT JOIN dbo.tbl_SysUser MU        ON AP.ModifiedBy = MU.UserId
  LEFT JOIN dbo.DW_Customer C         ON MOM.CustomerId = C.CustomerId
  LEFT JOIN dbo.DW_Vendor   V         ON MOM.VendorId  = V.VendorId
  LEFT JOIN BizNAV_App.dbo.BN_MOMActionPointMeta PW ON PW.ActionPointId = AP.ActionPointId`;

const RESOURCE_SUB = `
  STUFF((SELECT DISTINCT ', ' + RE.FirstName + ' ' + ISNULL(RE.LastName,'')
         FROM dbo.TM_ProjectTaskMOMActionPointsUser Res JOIN dbo.tbl_SysEmployee RE ON Res.UserId = RE.UserId
         WHERE Res.ActionPointId = AP.ActionPointId AND Res.UserType = 'Employee'
         FOR XML PATH(''), TYPE).value('.','NVARCHAR(MAX)'), 1, 2, '') AS Resource`;

const OVERDUE_DAYS = `DATEDIFF(day, CAST(GETDATE() AS DATE), CAST(AP.DueDate AS DATE))`;   // negative = overdue (SmartSys convention)

// ── GET /api/sales/action-points ─────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const pool = await getSmartSysPool();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const r = pool.request();
    const scope = await buildScope(pool, r, req.user, (req.query.view || '').toLowerCase());
    const baseWhere = [scope.where, ...filters(r, req.query)].join(' AND ');
    r.input('off', sql.Int, offset); r.input('lim', sql.Int, limit);

    const q = await r.query(`
      ${scope.pre}
      SELECT
        COUNT(*) AS Total,
        SUM(CASE WHEN AP.Status IN (${PENDING}) THEN 1 ELSE 0 END) AS Pending,
        SUM(CASE WHEN AP.DueDate < CAST(GETDATE() AS DATE) AND AP.Status NOT IN (${DONEISH}) THEN 1 ELSE 0 END) AS Overdue,
        SUM(CASE WHEN AP.Status = 30 THEN 1 ELSE 0 END) AS Completed
      ${AP_FROM}
      WHERE ${baseWhere};

      SELECT
        AP.ActionPointId, AP.MOMId, MOM.Title AS MomTitle, MOM.MOMDate,
        C.CustomerName AS Customer, V.VendorName AS Vendor,
        AP.ActionDescription, AP.Status, S.Description AS StatusName, S.StatusShortCode,
        AP.DueDate, ${OVERDUE_DAYS} AS OverDueDays,
        A.UserName AS AssignedBy, MU.UserName AS ModifiedBy, AP.CreatedDate, AP.ModifiedDate,
        PW.PendingWith AS PendingWith,
        CASE WHEN AP.DueDate < CAST(GETDATE() AS DATE) AND AP.Status NOT IN (${DONEISH}) THEN 1 ELSE 0 END AS Overdue,
        ${RESOURCE_SUB},
        COUNT(*) OVER() AS FilteredTotal
      ${AP_FROM}
      WHERE ${baseWhere}
      ORDER BY CASE WHEN AP.DueDate IS NULL THEN 1 ELSE 0 END, AP.DueDate DESC, AP.ActionPointId DESC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY;
      ${scope.drop}
    `);
    const summary = (q.recordsets[0] || [])[0] || { Total: 0, Pending: 0, Overdue: 0, Completed: 0 };
    const rows = q.recordsets[1] || [];
    const total = rows.length ? rows[0].FilteredTotal : 0;
    rows.forEach(x => { delete x.FilteredTotal; });
    res.json({ data: rows, total, page, limit, summary, view: scope.view, allowedViews: scope.allowed, canWrite: !isReadOnlyViewer(req.user) });
  } catch (err) {
    console.error('action-points list error:', err.message);
    res.status(500).json({ message: 'Failed to load action points', error: err.message });
  }
});

// ── GET /api/sales/action-points/export  (SmartSys MOMPendingActionPointList format) ──
router.get('/export', authenticate, async (req, res) => {
  try {
    const pool = await getSmartSysPool();
    const r = pool.request();
    const scope = await buildScope(pool, r, req.user, (req.query.view || '').toLowerCase());
    const where = [scope.where, ...filters(r, req.query)].join(' AND ');
    const q = await r.query(`
      ${scope.pre}
      SELECT TOP 20000
        AP.ActionPointId AS ID, C.CustomerName AS Customer, V.VendorName AS Vendor,
        AP.ActionDescription AS Descr, S.Description AS Status, AP.MOMId,
        AP.DueDate, ${OVERDUE_DAYS} AS OverDueDays,
        A.UserName AS AssignedBy, ${RESOURCE_SUB}, MU.UserName AS ModifiedBy, AP.ModifiedDate, PW.PendingWith AS PendingWith
      ${AP_FROM}
      WHERE ${where}
      ORDER BY CASE WHEN AP.DueDate IS NULL THEN 1 ELSE 0 END, AP.DueDate DESC, AP.ActionPointId DESC;
      ${scope.drop}
    `);
    const fmt   = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '');
    const fmtDT = (d) => (d ? new Date(d).toLocaleString('en-IN') : '');
    const aoa = (q.recordset || []).map(x => ({
      'ID': x.ID, 'Customer': x.Customer || '', 'Vendor': x.Vendor || '', 'Description': x.Descr || '',
      'Status': x.Status || '', 'MOMId': x.MOMId, 'Due Date': fmt(x.DueDate),
      'OverDue Days': x.OverDueDays == null ? '' : x.OverDueDays, 'Assigned By': x.AssignedBy || '',
      'Resource': x.Resource || '', 'ModifiedBy': x.ModifiedBy || '', 'ModifiedDate': fmtDT(x.ModifiedDate),
      'Pending With': x.PendingWith || '',
    }));
    const ws = XLSX.utils.json_to_sheet(aoa, { header: ['ID','Customer','Vendor','Description','Status','MOMId','Due Date','OverDue Days','Assigned By','Resource','ModifiedBy','ModifiedDate','Pending With'] });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'MOMPendingActionPointList');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="MOMPendingActionPointList_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.end(buf);
  } catch (err) {
    console.error('action-points export error:', err.message);
    res.status(500).json({ message: 'Failed to export action points', error: err.message });
  }
});

// ── PATCH /api/sales/action-points/:id  — inline status change ───────────────
// Uses SmartSys's own sp_TMsaveMOMActionPoint (update path) which stamps
// ModifiedBy/ModifiedDate AND inserts a status-change row into
// TM_ProjectTaskMOMActionPointsComments (StatusId + CommentDate + CommentedBy).
router.patch('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    if (isReadOnlyViewer(req.user)) return res.status(403).json({ message: 'Your role is read-only.' });
    const pool = await getSmartSysPool();
    const me = await resolveMe(pool, req.user);
    if (!me.guid) return res.status(403).json({ message: 'No SmartSys account is linked to your login.' });

    const id = parseInt(req.params.id, 10);

    // Which fields are we changing? status → SmartSys; pendingWith → ONE App overlay.
    const hasStatus  = req.body?.status !== undefined && req.body.status !== null && String(req.body.status) !== '';
    const hasPending = req.body?.pendingWith !== undefined;   // '' / 'None' clears it
    const newStatus  = hasStatus ? parseInt(req.body.status, 10) : null;
    if (hasStatus && !AP_STATUS[newStatus]) return res.status(400).json({ message: 'Invalid status' });
    let pendingWith = null;
    if (hasPending) {
      const pw = String(req.body.pendingWith || '').trim();
      pendingWith = (pw === '' || pw.toLowerCase() === 'none') ? null : pw;
      if (pendingWith && !PENDING_WITH.includes(pendingWith)) return res.status(400).json({ message: 'Invalid Pending With value' });
    }
    if (!hasStatus && !hasPending) return res.status(400).json({ message: 'Nothing to update' });

    // Authorize + fetch existing values (SP overwrites desc/due → preserve them).
    // Broadest scope the user has, so a head can change their team's, admin all.
    const probe = pool.request();
    const s0 = await buildScope(pool, probe, req.user);
    const broadest = s0.allowed.includes('all') ? 'all' : s0.allowed.includes('team') ? 'team' : 'mine';
    const cr = pool.request().input('id', sql.Int, id);
    const scope = await buildScope(pool, cr, req.user, broadest);
    const chk = await cr.query(`
      ${scope.pre}
      SELECT TOP 1 AP.MOMId, AP.ActionDescription, AP.DueDate, AP.Status
      FROM dbo.TM_ProjectTaskMOMActionPoints AP
      LEFT JOIN dbo.TM_ProjectTaskMOM MOM ON AP.MOMId = MOM.MOMId
      WHERE AP.ActionPointId = @id AND (${scope.where});
      ${scope.drop}
    `);
    if (!chk.recordset.length) return res.status(404).json({ message: 'Action point not found (or outside your scope)' });
    const ex = chk.recordset[0];
    const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';

    // 1) Status → SmartSys's own save proc (records the change date in the comments trail)
    if (hasStatus) {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        await new sql.Request(tx)
          .input('MOMId', sql.Int, ex.MOMId)
          .output('ActionPointId', sql.Int, id)                  // existing id → update path
          .input('ActionDescription', sql.VarChar(1000), ex.ActionDescription)
          .input('Comment', sql.VarChar(500), (req.body?.comment ? String(req.body.comment) : ('Status → ' + AP_STATUS[newStatus])).slice(0, 500))
          .input('Status', sql.Int, newStatus)
          .input('DueDate', sql.SmallDateTime, ex.DueDate)
          .input('user_Id', sql.NVarChar(128), me.guid)
          .input('ErrorCode', sql.Int, 0)
          .execute('dbo.sp_TMsaveMOMActionPoint');
        if (dryRun) await tx.rollback(); else await tx.commit();
      } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
    }

    // 2) Pending With → ONE App overlay table (BizNAV_App). Upsert; NULL = None.
    if (hasPending && !dryRun) {
      const app = await getAppPool();
      if (pendingWith) {
        await app.request()
          .input('ap', sql.Int, id).input('pw', sql.NVarChar(40), pendingWith).input('by', sql.NVarChar(100), req.user.name || req.user.username || '')
          .query(`MERGE dbo.BN_MOMActionPointMeta AS t USING (SELECT @ap AS ActionPointId) AS s ON t.ActionPointId = s.ActionPointId
                  WHEN MATCHED THEN UPDATE SET PendingWith=@pw, UpdatedBy=@by, UpdatedAt=SYSDATETIME()
                  WHEN NOT MATCHED THEN INSERT (ActionPointId, PendingWith, UpdatedBy) VALUES (@ap, @pw, @by);`);
      } else {
        await app.request().input('ap', sql.Int, id).query(`DELETE FROM dbo.BN_MOMActionPointMeta WHERE ActionPointId=@ap;`);
      }
    }

    res.json({ ok: true, dryRun, actionPointId: id,
      status: hasStatus ? newStatus : undefined, statusName: hasStatus ? AP_STATUS[newStatus] : undefined,
      pendingWith: hasPending ? pendingWith : undefined, changedBy: req.user.name || req.user.username });
  } catch (err) {
    console.error('action-points patch error:', err.message);
    res.status(500).json({ message: 'Failed to update action point', error: err.message });
  }
});

module.exports = router;
