// =====================================================================
// modules/sales/routes/mom.js — MOM (Minutes of Meeting)  [v1.12]
//
// A window into the SmartSys ERP's Project-MOM data. SmartSys is a separate
// (compiled ASP.NET) app on the SAME SQL Server (10.0.0.10); we read AND
// (for create/edit) write its SMARTSYS database via getSmartSysPool().
//
// READS:
//   GET  /                 list (paged) + summary cards
//   GET  /export           full scoped list as .xlsx
//   GET  /meta             projects + MOM types + action-point statuses (form dropdowns)
//   GET  /meta/tasks       tasks for a project
//   GET  /meta/search      type-ahead for employees / customers / vendors
//   GET  /:id              one MOM: header + participants + action points + attachments
// WRITES (create/edit — reuse SmartSys's OWN save procedures, never raw INSERTs):
//   POST /                 create a MOM (header + participants + action points)
//   PUT  /:id              edit a MOM (header + reconcile participants + action points)
//
// Writes go through SmartSys's stored procedures (sp_TMSaveProjectTaskMOM,
// sp_TMSaveMOMParticipant, sp_TMsaveMOMActionPoint, sp_DeleteMOMParticipants) so
// they behave EXACTLY like SmartSys — same audit fields, identity, status flow.
// Every write runs inside a transaction; pass ?dryRun=true to execute + validate
// then ROLL BACK (nothing persists) — used to prove the path before going live.
//
// ── Who can do what ──────────────────────────────────────────────────────────
//   • Salesperson / FAE      → view + create/edit OWN MOMs
//   • Sales head / any head  → view + edit their TEAM's MOMs (hierarchy subtree)
//   • FAE head               → the whole FAE team (by ONE App role membership)
//   • Admin family           → view + edit ALL
//   • MIS Store (sc@)        → view ALL (evaluation) — READ-ONLY, no create/edit
//   • Anyone unmapped        → nothing
// Attachments are VIEW-ONLY (the physical files live on the SmartSys file server).
// =====================================================================

const express = require('express');
const router  = express.Router();
const XLSX    = require('xlsx');
const { sql, getSmartSysPool, getAppPool } = require('../../../db');
const { authenticate, isFullAccess, isFaeHead } = require('../../../auth');
const { sendMail } = require('../../../services/mailer');

// "Pending With" — ONE App-only overlay stored in BizNAV_App.BN_MOMActionPointMeta.
const PENDING_WITH = ['Customer', 'Sales', 'Supplier/Vendor', 'FAE', 'Purchase', 'Product', 'Accounts', 'Logistics', 'Management'];
function normPendingWith(v) { const pw = String(v == null ? '' : v).trim(); if (pw === '' || pw.toLowerCase() === 'none') return null; return PENDING_WITH.includes(pw) ? pw : null; }
// Upsert/clear Pending With for a set of {apId, pendingWith} into the app DB.
async function savePendingWith(apMeta, user) {
  if (!apMeta || !apMeta.length) return;
  const app = await getAppPool();
  for (const m of apMeta) {
    if (!(m.apId > 0)) continue;
    const rq = app.request().input('ap', sql.Int, m.apId);
    if (m.pendingWith) {
      await rq.input('pw', sql.NVarChar(40), m.pendingWith).input('by', sql.NVarChar(100), user.name || user.username || '')
        .query(`MERGE dbo.BN_MOMActionPointMeta AS t USING (SELECT @ap AS ActionPointId) AS s ON t.ActionPointId=s.ActionPointId
                WHEN MATCHED THEN UPDATE SET PendingWith=@pw, UpdatedBy=@by, UpdatedAt=SYSDATETIME()
                WHEN NOT MATCHED THEN INSERT (ActionPointId, PendingWith, UpdatedBy) VALUES (@ap, @pw, @by);`);
    } else {
      await rq.query(`DELETE FROM dbo.BN_MOMActionPointMeta WHERE ActionPointId=@ap;`);
    }
  }
}

const MOM_TYPES  = ['In-Person', 'Conference', 'Telephonic'];
const AP_STATUS  = { 26: 'New', 29: 'Inprogress', 30: 'Complete', 32: 'Cancelled', 33: 'OnHold' };
const PART_TYPES = ['Employee', 'Customer', 'Vendor'];

// See-all set: admin family + MIS Store (evaluation viewer, read-only).
function seesAll(user) {
  return isFullAccess(user) || (user.role || '').toLowerCase().trim() === 'mis store';
}
// Read-only viewer = MIS Store. Everyone else who maps to a SmartSys employee can write.
function isReadOnlyViewer(user) {
  return (user.role || '').toLowerCase().trim() === 'mis store';
}
// Anchor a 'YYYY-MM-DD' date at midday local so it can't drift a day across TZ.
function toSmallDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// ── SmartSys employee resolver (cached) ──────────────────────────────────────
// Map the logged-in ONE App user → their SmartSys identity (GUID + EmpId). Link
// is email: ONE App User_Login.Username/.Email == SmartSys tbl_SysUser.UserName.
const _empCache = new Map();               // key -> { guid, empId, sysUserId, displayName, ts }
const EMP_TTL_MS = 10 * 60 * 1000;

async function resolveEmp(pool, user) {
  const uname = (user.username || '').toLowerCase().trim();
  const email = (user.email || '').toLowerCase().trim();
  const key = uname + '|' + email;
  const hit = _empCache.get(key);
  if (hit && (Date.now() - hit.ts) < EMP_TTL_MS) return hit;

  const q = await pool.request()
    .input('u', sql.NVarChar(256), uname)
    .input('e', sql.NVarChar(256), email)
    .query(`
      SELECT TOP 1 su.User_Id AS Guid, su.UserId AS SysUserId, e.EmpId, su.DisplayName
      FROM dbo.tbl_SysUser su
      LEFT JOIN dbo.tbl_SysEmployee e ON e.UserId = su.UserId
      WHERE LOWER(su.UserName) IN (@u, @e) OR LOWER(su.Email) IN (@u, @e)
      ORDER BY CASE WHEN e.EmpId IS NULL THEN 1 ELSE 0 END;
    `);
  const row = q.recordset[0] || null;
  const val = { guid: row ? row.Guid : null, empId: row ? row.EmpId : null,
                sysUserId: row ? row.SysUserId : null, displayName: row ? row.DisplayName : null, ts: Date.now() };
  _empCache.set(key, val);
  return val;
}

// ── FAE team EmpIds (cached) — FAE staff have no SmartSys manager chain, so a FAE
// head's team is resolved by ONE App role membership (cross-DB, same server). ────
let _faeTeam = null, _faeTeamTs = 0;
async function faeTeamEmpIds(pool) {
  if (_faeTeam && (Date.now() - _faeTeamTs) < EMP_TTL_MS) return _faeTeam;
  const q = await pool.request().query(`
    SELECT DISTINCT e.EmpId
    FROM BizNAV_App.dbo.User_Login ul
    JOIN dbo.tbl_SysUser     su ON LOWER(su.UserName) = LOWER(ul.Username) OR LOWER(su.UserName) = LOWER(ul.Email)
    JOIN dbo.tbl_SysEmployee e  ON e.UserId = su.UserId
    WHERE LOWER(ul.Role) IN ('fae', 'fae head') AND e.EmpId IS NOT NULL;
  `);
  _faeTeam = q.recordset.map(r => r.EmpId);
  _faeTeamTs = Date.now();
  return _faeTeam;
}

const SCOPE_CTE = `
  ;WITH cteEmp (EmpId, ManagerId) AS (
     SELECT e.EmpId, CASE WHEN e.ManagerId = e.EmpId THEN 0 ELSE e.ManagerId END
     FROM dbo.tbl_SysEmployee e WHERE e.EmpId = @empId
     UNION ALL
     SELECT e.EmpId, e.ManagerId
     FROM dbo.tbl_SysEmployee e
     INNER JOIN cteEmp c ON c.EmpId = e.ManagerId AND e.EmpId <> e.ManagerId
  )
  SELECT EmpId INTO #scope FROM cteEmp;`;

const MOM_FROM = `
  FROM dbo.TM_ProjectTaskMOM M
  INNER JOIN dbo.TM_ProjectTask PT ON M.ProjectId = PT.ProjectId AND M.TaskId = PT.TaskId
  LEFT  JOIN dbo.TM_Project      P  ON M.ProjectId = P.ProjectId
  LEFT  JOIN dbo.tbl_SysEmployee E  ON M.EmpId = E.EmpId
  LEFT  JOIN dbo.tbl_SysUser     U  ON M.ModifiedBy = U.UserId
  LEFT  JOIN dbo.DW_Customer     C  ON M.CustomerId = C.CustomerId
  LEFT  JOIN dbo.DW_Vendor       V  ON M.VendorId  = V.VendorId`;

const SEARCH_COLS = `(M.Title LIKE @q OR P.ProjectName LIKE @q OR PT.TaskName LIKE @q
   OR C.CustomerName LIKE @q OR V.VendorName LIKE @q
   OR (E.FirstName + ' ' + ISNULL(E.LastName,'')) LIKE @q)`;

// Binds scope params onto `r` and returns { pre, where, drop, label }.
async function buildScope(pool, r, user) {
  if (seesAll(user)) return { pre: '', where: '1=1', drop: '', label: 'all' };
  if (isFaeHead(user)) {
    const ids = await faeTeamEmpIds(pool);
    if (!ids.length) return { pre: '', where: '1=0', drop: '', label: 'none' };
    const ph = ids.map((id, i) => { r.input('f' + i, sql.Int, id); return '@f' + i; });
    return { pre: '', where: `M.EmpId IN (${ph.join(',')})`, drop: '', label: 'fae-team' };
  }
  const empId = (await resolveEmp(pool, user)).empId;
  if (!empId) return { pre: '', where: '1=0', drop: '', label: 'none' };
  r.input('empId', sql.Int, empId);
  return { pre: SCOPE_CTE, where: 'M.EmpId IN (SELECT EmpId FROM #scope)', drop: 'DROP TABLE #scope;', label: 'team' };
}

function filterParts(r, q) {
  const parts = [];
  const search = (q.search || '').trim();
  const from   = (q.from   || '').trim();
  const to     = (q.to     || '').trim();
  if (search) { r.input('q', sql.NVarChar(200), '%' + search + '%'); parts.push(SEARCH_COLS); }
  if (from)   { r.input('from', sql.Date, from); parts.push('M.MOMDate >= @from'); }
  if (to)     { r.input('to',   sql.Date, to);   parts.push('M.MOMDate < DATEADD(DAY, 1, @to)'); }
  return parts;
}

// ══════════════════════════════ READS ═══════════════════════════════════════

// ── GET /api/sales/mom ───────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const pool  = await getSmartSysPool();
    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const r = pool.request();
    const scope = await buildScope(pool, r, req.user);

    const baseWhere = [scope.where, ...filterParts(r, req.query)].join(' AND ');
    let   pageWhere = baseWhere;
    if ((req.query.type || '').trim()) { r.input('type', sql.VarChar(15), req.query.type.trim()); pageWhere += ' AND M.MOMType = @type'; }
    r.input('off', sql.Int, offset);
    r.input('lim', sql.Int, limit);

    const q = await r.query(`
      ${scope.pre}
      SELECT
        COUNT(*) AS Total,
        SUM(CASE WHEN M.MOMDate >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) THEN 1 ELSE 0 END) AS ThisMonth,
        SUM(CASE WHEN M.MOMType = 'In-Person'  THEN 1 ELSE 0 END) AS InPerson,
        SUM(CASE WHEN M.MOMType = 'Conference' THEN 1 ELSE 0 END) AS Conference,
        SUM(CASE WHEN M.MOMType = 'Telephonic' THEN 1 ELSE 0 END) AS Telephonic
      ${MOM_FROM}
      WHERE ${baseWhere};

      SELECT
        M.MOMId, M.MOMDate, M.MOMType, M.Title,
        E.FirstName + ' ' + ISNULL(E.LastName, '') AS Employee,
        P.ProjectName, PT.TaskName, C.CustomerName, V.VendorName,
        U.UserName AS ModifiedBy, M.ModifiedDate,
        COUNT(*) OVER() AS FilteredTotal
      ${MOM_FROM}
      WHERE ${pageWhere}
      ORDER BY M.MOMDate DESC, M.MOMId DESC     -- latest MOM date first
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY;
      ${scope.drop}
    `);

    const summary = (q.recordsets[0] || [])[0] || { Total: 0, ThisMonth: 0, InPerson: 0, Conference: 0, Telephonic: 0 };
    const rows = q.recordsets[1] || [];
    const total = rows.length ? rows[0].FilteredTotal : 0;
    rows.forEach(x => { delete x.FilteredTotal; });

    res.json({ data: rows, total, page, limit, summary, scope: scope.label, canWrite: !isReadOnlyViewer(req.user) });
  } catch (err) {
    console.error('mom list error:', err.message);
    res.status(500).json({ message: 'Failed to load MOM list', error: err.message });
  }
});

// ── GET /api/sales/mom/meta ──────────────────────────────────────────────────
// Form dropdowns: projects (8), MOM types (3), action-point statuses (5).
router.get('/meta', authenticate, async (req, res) => {
  try {
    const pool = await getSmartSysPool();
    const q = await pool.request().query(`SELECT ProjectId, ProjectName FROM dbo.TM_Project ORDER BY ProjectName;`);
    res.json({
      projects: q.recordset || [],
      momTypes: MOM_TYPES,
      actionStatuses: Object.entries(AP_STATUS).map(([id, label]) => ({ id: Number(id), label })),
    });
  } catch (err) {
    console.error('mom meta error:', err.message);
    res.status(500).json({ message: 'Failed to load form data', error: err.message });
  }
});

// ── GET /api/sales/mom/meta/tasks?projectId= ─────────────────────────────────
router.get('/meta/tasks', authenticate, async (req, res) => {
  try {
    const projectId = parseInt(req.query.projectId, 10);
    if (!(projectId > 0)) return res.json({ data: [] });
    const pool = await getSmartSysPool();
    const q = await pool.request().input('p', sql.Int, projectId)
      .query(`SELECT TaskId, TaskName FROM dbo.TM_ProjectTask WHERE ProjectId = @p ORDER BY TaskName;`);
    res.json({ data: q.recordset || [] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load tasks', error: err.message });
  }
});

// ── GET /api/sales/mom/meta/search?type=employee|customer|vendor&q= ──────────
router.get('/meta/search', authenticate, async (req, res) => {
  try {
    const type = (req.query.type || '').toLowerCase();
    const term = '%' + (req.query.q || '').trim() + '%';
    const pool = await getSmartSysPool();
    const r = pool.request().input('q', sql.NVarChar(200), term);
    let qtext;
    if (type === 'employee')      qtext = `SELECT TOP 20 EmpId AS id, (FirstName + ' ' + ISNULL(LastName,'')) AS name FROM dbo.tbl_SysEmployee WHERE ISNULL(Deleted,0)=0 AND (FirstName + ' ' + ISNULL(LastName,'')) LIKE @q ORDER BY name;`;
    // 'resource' = action-point assignee: keyed by the employee's SysUserId (UserId),
    // because TM_ProjectTaskMOMActionPointsUser.UserId = tbl_SysEmployee.UserId (NOT EmpId).
    else if (type === 'resource') qtext = `SELECT TOP 20 UserId AS id, (FirstName + ' ' + ISNULL(LastName,'')) AS name FROM dbo.tbl_SysEmployee WHERE ISNULL(Deleted,0)=0 AND UserId IS NOT NULL AND (FirstName + ' ' + ISNULL(LastName,'')) LIKE @q ORDER BY name;`;
    else if (type === 'customer') qtext = `SELECT TOP 20 CustomerId AS id, CustomerName AS name FROM dbo.DW_Customer WHERE CustomerName LIKE @q ORDER BY CustomerName;`;
    else if (type === 'vendor')   qtext = `SELECT TOP 20 VendorId AS id, VendorName AS name FROM dbo.DW_Vendor WHERE VendorName LIKE @q ORDER BY VendorName;`;
    else return res.status(400).json({ message: 'type must be employee|resource|customer|vendor' });
    const q = await r.query(qtext);
    res.json({ data: q.recordset || [] });
  } catch (err) {
    res.status(500).json({ message: 'Search failed', error: err.message });
  }
});

// ── GET /api/sales/mom/export ────────────────────────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  try {
    const pool = await getSmartSysPool();
    const r = pool.request();
    const scope = await buildScope(pool, r, req.user);
    const parts = [scope.where, ...filterParts(r, req.query)];
    if ((req.query.type || '').trim()) { r.input('type', sql.VarChar(15), req.query.type.trim()); parts.push('M.MOMType = @type'); }
    const where = parts.join(' AND ');

    const q = await r.query(`
      ${scope.pre}
      SELECT TOP 20000
        M.MOMId, M.MOMDate, M.MOMType, M.Title,
        E.FirstName + ' ' + ISNULL(E.LastName, '') AS Employee,
        P.ProjectName, PT.TaskName, C.CustomerName, V.VendorName,
        U.UserName AS ModifiedBy, M.ModifiedDate
      ${MOM_FROM}
      WHERE ${where}
      ORDER BY M.MOMDate DESC, M.MOMId DESC;
      ${scope.drop}
    `);

    const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '');
    const aoa = (q.recordset || []).map(x => ({
      'MOM ID': x.MOMId, 'MOM Date': fmt(x.MOMDate), 'Type': x.MOMType || '', 'Title': x.Title || '',
      'Employee': x.Employee || '', 'Project': x.ProjectName || '', 'Task': x.TaskName || '',
      'Customer': x.CustomerName || '', 'Vendor': x.VendorName || '', 'Modified By': x.ModifiedBy || '', 'Modified On': fmt(x.ModifiedDate),
    }));
    const ws = XLSX.utils.json_to_sheet(aoa, {
      header: ['MOM ID','MOM Date','Type','Title','Employee','Project','Task','Customer','Vendor','Modified By','Modified On'],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'MOM');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="MOM_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.end(buf);
  } catch (err) {
    console.error('mom export error:', err.message);
    res.status(500).json({ message: 'Failed to export MOM list', error: err.message });
  }
});

// Loads a MOM's header + children, scope-gated. Returns null if out of scope /
// not found. Shared by GET /:id and the edit-permission check in PUT.
async function loadMom(pool, user, id) {
  const hr = pool.request().input('id', sql.Int, id);
  const scope = await buildScope(pool, hr, user);
  const head = await hr.query(`
    ${scope.pre}
    SELECT
      M.MOMId, M.ProjectId, M.TaskId, M.MOMDate, M.MOMType, M.Title,
      M.ManagementView, M.Description, M.LocalDescription, M.CustomerId, M.VendorId,
      E.FirstName + ' ' + ISNULL(E.LastName, '') AS Employee,
      P.ProjectName, PT.TaskName, C.CustomerName, V.VendorName,
      cu.UserName AS CreatedBy, M.CreatedDate, mu.UserName AS ModifiedBy, M.ModifiedDate
    FROM dbo.TM_ProjectTaskMOM M
    INNER JOIN dbo.TM_ProjectTask PT ON M.ProjectId = PT.ProjectId AND M.TaskId = PT.TaskId
    LEFT  JOIN dbo.TM_Project      P  ON M.ProjectId = P.ProjectId
    LEFT  JOIN dbo.tbl_SysEmployee E  ON M.EmpId = E.EmpId
    LEFT  JOIN dbo.DW_Customer     C  ON M.CustomerId = C.CustomerId
    LEFT  JOIN dbo.DW_Vendor       V  ON M.VendorId  = V.VendorId
    LEFT  JOIN dbo.tbl_SysUser     cu ON M.CreatedBy  = cu.UserId
    LEFT  JOIN dbo.tbl_SysUser     mu ON M.ModifiedBy = mu.UserId
    WHERE M.MOMId = @id AND (${scope.where});
    ${scope.drop}
  `);
  if (!head.recordset.length) return null;

  const kids = await pool.request().input('id', sql.Int, id).query(`
    SELECT p.ParticipantType, p.ParticipantId, p.FYI,
      CASE p.ParticipantType
        WHEN 'Employee' THEN e.FirstName + ' ' + ISNULL(e.LastName, '')
        WHEN 'Customer' THEN c.CustomerName
        WHEN 'Vendor'   THEN v.VendorName
        ELSE CAST(p.ParticipantId AS varchar(20)) END AS Name
    FROM dbo.TM_ProjectTaskMOMParticipant p
    LEFT JOIN dbo.tbl_SysEmployee e ON p.ParticipantType = 'Employee' AND p.ParticipantId = e.EmpId
    LEFT JOIN dbo.DW_Customer     c ON p.ParticipantType = 'Customer' AND p.ParticipantId = c.CustomerId
    LEFT JOIN dbo.DW_Vendor       v ON p.ParticipantType = 'Vendor'   AND p.ParticipantId = v.VendorId
    WHERE p.MOMId = @id
    ORDER BY p.ParticipantType, Name;

    SELECT ap.ActionPointId, ap.ActionDescription, ap.Status, ap.DueDate,
      s.Description AS StatusName, s.StatusShortCode,
      au.UserName AS AssignedBy, ap.CreatedDate, pw.PendingWith AS PendingWith
    FROM dbo.TM_ProjectTaskMOMActionPoints ap
    LEFT JOIN dbo.tbl_SysStatusCodes s  ON ap.Status = s.StatusId
    LEFT JOIN dbo.tbl_SysUser        au ON ap.AssignedBy = au.UserId
    LEFT JOIN BizNAV_App.dbo.BN_MOMActionPointMeta pw ON pw.ActionPointId = ap.ActionPointId
    WHERE ap.MOMId = @id
    ORDER BY ap.ActionPointId;

    SELECT FileName, Description FROM dbo.TM_ProjectTaskMOMAttachments WHERE MOMId = @id;

    SELECT au.ActionPointId, au.UserId, e.FirstName + ' ' + ISNULL(e.LastName,'') AS Name
    FROM dbo.TM_ProjectTaskMOMActionPointsUser au
    JOIN dbo.tbl_SysEmployee e ON au.UserId = e.UserId
    WHERE au.UserType = 'Employee'
      AND au.ActionPointId IN (SELECT ActionPointId FROM dbo.TM_ProjectTaskMOMActionPoints WHERE MOMId = @id);
  `);

  // Attach each action point's assigned-to employees (Resource).
  const aps = kids.recordsets[1] || [];
  const byAp = {};
  (kids.recordsets[3] || []).forEach(x => { (byAp[x.ActionPointId] = byAp[x.ActionPointId] || []).push({ id: x.UserId, name: x.Name }); });
  aps.forEach(a => { a.assignees = byAp[a.ActionPointId] || []; a.Resource = a.assignees.map(z => z.name).join(', ') || null; });

  return {
    header:       head.recordset[0],
    participants: kids.recordsets[0] || [],
    actionPoints: aps,
    attachments:  kids.recordsets[2] || [],
  };
}

// ── GET /api/sales/mom/:id ───────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const pool = await getSmartSysPool();
    const data = await loadMom(pool, req.user, parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ message: 'MOM not found (or outside your team)' });
    data.canEdit = !isReadOnlyViewer(req.user);   // scope already proven above
    res.json(data);
  } catch (err) {
    console.error('mom detail error:', err.message);
    res.status(500).json({ message: 'Failed to load MOM', error: err.message });
  }
});

// ══════════════════════════════ WRITES ══════════════════════════════════════

// Validate + normalise a create/edit body. Returns { ok, error, data }.
function parseBody(body) {
  const b = body || {};
  const projectId = parseInt(b.projectId, 10);
  const taskId    = parseInt(b.taskId, 10);
  const title     = String(b.title || '').trim();
  const momType   = String(b.momType || '').trim();
  const momDate   = toSmallDate(b.momDate);
  if (!(projectId > 0)) return { ok: false, error: 'Project is required' };
  if (!(taskId > 0))    return { ok: false, error: 'Task is required' };
  if (!title)           return { ok: false, error: 'Title is required' };
  if (title.length > 50) return { ok: false, error: 'Title must be 50 characters or fewer' };
  if (!MOM_TYPES.includes(momType)) return { ok: false, error: 'Invalid MOM type' };
  if (!momDate)         return { ok: false, error: 'MOM date is required' };

  const participants = Array.isArray(b.participants) ? b.participants.map(p => ({
    type: PART_TYPES.find(t => t.toLowerCase() === String(p.type || '').toLowerCase()),
    id:   parseInt(p.id, 10),
    fyi:  !!p.fyi,
  })).filter(p => p.type && p.id > 0) : [];

  const actionPoints = Array.isArray(b.actionPoints) ? b.actionPoints.map(a => ({
    actionPointId: parseInt(a.actionPointId, 10) || 0,
    description:   String(a.description || '').trim().slice(0, 1000),
    status:        AP_STATUS[parseInt(a.status, 10)] ? parseInt(a.status, 10) : 26,
    dueDate:       toSmallDate(a.dueDate),
    comment:       String(a.comment || '').trim().slice(0, 500),
    assignees:     Array.isArray(a.assignees) ? [...new Set(a.assignees.map(x => parseInt(x, 10)).filter(x => x > 0))] : [],
    pendingWith:   normPendingWith(a.pendingWith),
  })).filter(a => a.description) : [];

  return { ok: true, data: {
    projectId, taskId, title, momType, momDate,
    description:      String(b.description || ''),
    localDescription: String(b.localDescription || ''),
    managementView:   String(b.managementView || ''),
    customerId: parseInt(b.customerId, 10) > 0 ? parseInt(b.customerId, 10) : null,
    vendorId:   parseInt(b.vendorId, 10)   > 0 ? parseInt(b.vendorId, 10)   : null,
    participants, actionPoints,
  } };
}

// Save the header via SmartSys's own proc. Returns the (new or same) MOMId.
async function saveHeader(txReq, d, guid, empId, momId) {
  txReq.output('MOMId', sql.Int, momId);
  txReq.input('ProjectId', sql.Int, d.projectId);
  txReq.input('TaskId', sql.Int, d.taskId);
  txReq.input('MOMDate', sql.SmallDateTime, d.momDate);
  txReq.input('EmpId', sql.Int, empId);           // ignored by the proc on insert (uses caller's emp)
  txReq.input('MOMType', sql.VarChar(15), d.momType);
  txReq.input('LocalDescription', sql.VarChar(sql.MAX), d.localDescription);
  txReq.input('ManagementView', sql.VarChar(sql.MAX), d.managementView);
  txReq.input('Title', sql.VarChar(50), d.title);
  txReq.input('Description', sql.VarChar(sql.MAX), d.description);
  txReq.input('User_Id', sql.NVarChar(128), guid);
  txReq.output('ErrorCode', sql.Int);
  txReq.input('CustomerId', sql.Int, d.customerId);
  txReq.input('VendorId', sql.Int, d.vendorId);
  const rs = await txReq.execute('dbo.sp_TMSaveProjectTaskMOM');
  return rs.output.MOMId;
}

async function addParticipant(tx, momId, p, guid) {
  await new sql.Request(tx)
    .input('MOMId', sql.Int, momId)
    .input('ParticipantId', sql.Int, p.id)
    .input('ParticipantType', sql.VarChar(10), p.type)
    .input('User_Id', sql.NVarChar(128), guid)
    .input('FYI', sql.Bit, p.fyi)
    .output('ErrorCode', sql.Int)
    .execute('dbo.sp_TMSaveMOMParticipant');
}
async function delParticipant(tx, momId, p) {
  await new sql.Request(tx)
    .input('MOMId', sql.Int, momId)
    .input('ParticipantId', sql.Int, p.ParticipantId)
    .input('ParticipantsType', sql.VarChar(10), p.ParticipantType)
    .output('ErrorCode', sql.Int)
    .execute('dbo.sp_DeleteMOMParticipants');
}
async function saveActionPoint(tx, momId, a, guid) {
  const rs = await new sql.Request(tx)
    .input('MOMId', sql.Int, momId)
    .output('ActionPointId', sql.Int, a.actionPointId || 0)
    .input('ActionDescription', sql.VarChar(1000), a.description)
    .input('Comment', sql.VarChar(500), a.comment || '')
    .input('Status', sql.Int, a.status)
    .input('DueDate', sql.SmallDateTime, a.dueDate)
    .input('user_Id', sql.NVarChar(128), guid)
    .input('ErrorCode', sql.Int, 0)
    .execute('dbo.sp_TMsaveMOMActionPoint');
  return rs.output.ActionPointId;
}
// Set an action point's ASSIGNED-TO employees (Resource). userIds = SysUserIds.
// SmartSys's sp_TMsaveMOMActionPointUser deletes-all-then-inserts when @Delete=1,
// so the first call clears existing employee assignees and each call inserts one.
async function saveAssignees(tx, actionPointId, userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter(x => x > 0))];
  if (!ids.length) {
    await new sql.Request(tx).input('ap', sql.Int, actionPointId)
      .query(`DELETE FROM dbo.TM_ProjectTaskMOMActionPointsUser WHERE ActionPointId=@ap AND UserType='Employee';`);
    return;
  }
  for (let i = 0; i < ids.length; i++) {
    await new sql.Request(tx)
      .input('UserId', sql.Int, ids[i])
      .input('ActionPointId', sql.Int, actionPointId)
      .input('Delete', sql.Int, i === 0 ? 1 : 0)    // first call clears existing employee assignees
      .input('UserType', sql.VarChar(10), 'Employee')
      .output('ErrorCode', sql.Int)
      .execute('dbo.sp_TMsaveMOMActionPointUser');
  }
}

// Runs `work(tx)` in a transaction; ?dryRun=true rolls back (nothing persists).
async function inTx(pool, dryRun, work) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  let result;
  try {
    result = await work(tx);
    if (dryRun) await tx.rollback(); else await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch (_) { /* already rolled back */ }
    throw e;
  }
  return result;
}

// ── POST /api/sales/mom  — create ────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    if (isReadOnlyViewer(req.user)) return res.status(403).json({ message: 'Your role is read-only for MOM.' });
    const pool = await getSmartSysPool();
    const me = await resolveEmp(pool, req.user);
    if (!me.guid || !me.empId) return res.status(403).json({ message: 'No SmartSys account is linked to your login, so you cannot create MOMs. Ask IT to map your account.' });

    const parsed = parseBody(req.body);
    if (!parsed.ok) return res.status(400).json({ message: parsed.error });
    const d = parsed.data;

    // Task must belong to the project, else the MOM would be invisible in the list.
    const chk = await pool.request().input('p', sql.Int, d.projectId).input('t', sql.Int, d.taskId)
      .query(`SELECT 1 FROM dbo.TM_ProjectTask WHERE ProjectId=@p AND TaskId=@t;`);
    if (!chk.recordset.length) return res.status(400).json({ message: 'That task does not belong to the selected project' });

    const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';
    const out = await inTx(pool, dryRun, async (tx) => {
      const id = await saveHeader(new sql.Request(tx), d, me.guid, me.empId, 0);
      for (const p of d.participants) await addParticipant(tx, id, p, me.guid);
      const apMeta = [];
      for (const a of d.actionPoints) { const apId = await saveActionPoint(tx, id, a, me.guid); await saveAssignees(tx, apId, a.assignees); apMeta.push({ apId, pendingWith: a.pendingWith }); }
      return { id, apMeta };
    });
    if (!dryRun) await savePendingWith(out.apMeta, req.user);   // Pending With → app DB (post-commit)

    res.json({ message: dryRun ? 'Validated (rolled back — nothing saved)' : 'MOM created', momId: out.id, dryRun,
               participants: d.participants.length, actionPoints: d.actionPoints.length });
  } catch (err) {
    console.error('mom create error:', err.message);
    res.status(500).json({ message: 'Failed to create MOM', error: err.message });
  }
});

// ── PUT /api/sales/mom/:id  — edit ───────────────────────────────────────────
router.put('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    if (isReadOnlyViewer(req.user)) return res.status(403).json({ message: 'Your role is read-only for MOM.' });
    const pool = await getSmartSysPool();
    const me = await resolveEmp(pool, req.user);
    if (!me.guid) return res.status(403).json({ message: 'No SmartSys account is linked to your login.' });

    const id = parseInt(req.params.id, 10);
    const existing = await loadMom(pool, req.user, id);   // enforces scope: own/team/all
    if (!existing) return res.status(404).json({ message: 'MOM not found (or outside your team)' });

    const parsed = parseBody(req.body);
    if (!parsed.ok) return res.status(400).json({ message: parsed.error });
    const d = parsed.data;

    const chk = await pool.request().input('p', sql.Int, d.projectId).input('t', sql.Int, d.taskId)
      .query(`SELECT 1 FROM dbo.TM_ProjectTask WHERE ProjectId=@p AND TaskId=@t;`);
    if (!chk.recordset.length) return res.status(400).json({ message: 'That task does not belong to the selected project' });

    // Reconcile participants against what's already there (key = type + id).
    const key = (t, i) => `${String(t).toLowerCase()}:${i}`;
    const existingParts = existing.participants;
    const wantKeys = new Set(d.participants.map(p => key(p.type, p.id)));
    const haveKeys = new Set(existingParts.map(p => key(p.ParticipantType, p.ParticipantId)));
    const toAdd    = d.participants.filter(p => !haveKeys.has(key(p.type, p.id)));
    const toRemove = existingParts.filter(p => !wantKeys.has(key(p.ParticipantType, p.ParticipantId)));

    const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';
    const apMeta = await inTx(pool, dryRun, async (tx) => {
      await saveHeader(new sql.Request(tx), d, me.guid, existing.header.EmpId || me.empId, id);   // update
      for (const p of toRemove) await delParticipant(tx, id, p);
      for (const p of toAdd)    await addParticipant(tx, id, p, me.guid);
      // Action points: update existing (id>0) + add new (id=0). SmartSys has no
      // action-point delete, so removals aren't supported (cancel via status).
      const meta = [];
      for (const a of d.actionPoints) { const apId = await saveActionPoint(tx, id, a, me.guid); await saveAssignees(tx, apId, a.assignees); meta.push({ apId, pendingWith: a.pendingWith }); }
      return meta;
    });
    if (!dryRun) await savePendingWith(apMeta, req.user);   // Pending With → app DB (post-commit)

    res.json({ message: dryRun ? 'Validated (rolled back — nothing saved)' : 'MOM updated', momId: id, dryRun,
               added: toAdd.length, removed: toRemove.length, actionPoints: d.actionPoints.length });
  } catch (err) {
    console.error('mom edit error:', err.message);
    res.status(500).json({ message: 'Failed to update MOM', error: err.message });
  }
});

// ══════════════════════════ EMAIL PARTICIPANTS ══════════════════════════════
// Mirrors SmartSys's "Send Mail" on a MOM — emails the minutes to the MOM's
// participant employees. Manual (button on the detail view), never automatic.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function htmlToText(s) {
  if (!s) return '';
  return String(s).replace(/&nbsp;/gi, ' ').replace(/<\s*(br|\/div|\/p|\/li|\/tr)\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function buildMomEmail(mom) {
  const h = mom.header;
  const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
  const subject = `MOM : ${h.Title || 'Minutes of Meeting'}`;   // matches SmartSys's "MOM : <Title>" subject
  const disc = htmlToText(h.Description);
  const intern = htmlToText(h.LocalDescription);
  const mgmt = htmlToText(h.ManagementView);
  const sec = (t, body) => body ? `<h3 style="color:#12325a;font-size:14px;margin:14px 0 4px;">${t}</h3><div style="white-space:pre-wrap;">${esc(body).replace(/\n/g, '<br>')}</div>` : '';
  const apRows = (mom.actionPoints || []).map((a, i) =>
    `<tr><td>${i + 1}</td><td>${esc(a.ActionDescription || '')}</td><td>${esc(a.Resource || '—')}</td><td style="white-space:nowrap;">${fmt(a.DueDate)}</td><td>${esc(a.StatusName || '')}</td></tr>`).join('');
  const parts = (mom.participants || []).map(p => esc(p.Name) + (p.FYI ? ' (FYI)' : '')).join(', ');
  const html = `
    <div style="font-family:Arial,sans-serif;color:#222;font-size:14px;line-height:1.5;">
      <h2 style="color:#12325a;margin:0 0 4px;">${esc(h.Title || 'Minutes of Meeting')}</h2>
      <div style="color:#666;font-size:12px;margin-bottom:14px;">MOM #${h.MOMId} &middot; ${esc(h.MOMType || '')} &middot; ${fmt(h.MOMDate)}</div>
      <table style="font-size:13px;margin-bottom:14px;">
        <tr><td style="color:#666;padding:2px 12px 2px 0;">Employee</td><td>${esc(h.Employee || '—')}</td></tr>
        <tr><td style="color:#666;padding:2px 12px 2px 0;">Project / Task</td><td>${esc(h.ProjectName || '—')} / ${esc(h.TaskName || '—')}</td></tr>
        ${h.CustomerName ? `<tr><td style="color:#666;padding:2px 12px 2px 0;">Customer</td><td>${esc(h.CustomerName)}</td></tr>` : ''}
      </table>
      ${sec('Description', disc)}${sec('Internal Description', intern)}${sec('Management View', mgmt)}
      ${apRows ? `<h3 style="color:#12325a;font-size:14px;margin:16px 0 6px;">Action Points</h3><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12.5px;border-color:#ddd;"><thead><tr style="background:#f3f4f6;"><th>#</th><th>Action</th><th>Assigned To</th><th>Due</th><th>Status</th></tr></thead><tbody>${apRows}</tbody></table>` : ''}
      <h3 style="color:#12325a;font-size:14px;margin:16px 0 4px;">Participants</h3><div>${parts || '—'}</div>`;
  const text = `MOM : ${h.Title}\n${h.MOMType} · ${fmt(h.MOMDate)}\nEmployee: ${h.Employee}\nProject/Task: ${h.ProjectName} / ${h.TaskName}\n\n`
    + [disc && ('Description:\n' + disc), intern && ('Internal Description:\n' + intern), mgmt && ('Management View:\n' + mgmt)].filter(Boolean).join('\n\n')
    + `\n\nParticipants: ${parts}`;
  return { subject, html: html + '</div>', text };
}

// ── POST /api/sales/mom/:id/send-mail  (?preview=true → don't send) ──────────
router.post('/:id/send-mail', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    if (isReadOnlyViewer(req.user)) return res.status(403).json({ message: 'Your role is read-only for MOM.' });
    const pool = await getSmartSysPool();
    const id = parseInt(req.params.id, 10);
    const mom = await loadMom(pool, req.user, id);            // scope-gated
    if (!mom) return res.status(404).json({ message: 'MOM not found (or outside your team)' });

    // Recipients = participant EMPLOYEES with an email (customers/vendors excluded;
    // only 2 non-employee participants exist across all MOMs).
    // Participant employees with email + their FYI flag. Grouped by email so a
    // person listed twice collapses; MIN(FYI) means "if ever a non-FYI participant, treat as To".
    const er = await pool.request().input('id', sql.Int, id).query(`
      SELECT LTRIM(RTRIM(e.emailId)) AS Email, MAX(e.FirstName + ' ' + ISNULL(e.LastName,'')) AS Name, MIN(CAST(p.FYI AS int)) AS FYI
      FROM dbo.TM_ProjectTaskMOMParticipant p
      JOIN dbo.tbl_SysEmployee e ON p.ParticipantType = 'Employee' AND p.ParticipantId = e.EmpId
      WHERE p.MOMId = @id AND e.emailId IS NOT NULL AND LTRIM(RTRIM(e.emailId)) <> ''
      GROUP BY LTRIM(RTRIM(e.emailId));`);
    const rows = er.recordset || [];
    if (!rows.length) return res.status(400).json({ message: 'This MOM has no participants with an email address.' });
    // Scrub stray whitespace / zero-width chars from stored emails (valid emails
    // have none) so a dirty address can't break the send.
    rows.forEach(x => { x.Email = String(x.Email || '').replace(/[\s​‌‍﻿]/g, ''); });
    // Non-FYI participants → To; FYI participants → Cc (matches SmartSys).
    let toRows = rows.filter(r => !r.FYI);
    let ccRows = rows.filter(r => r.FYI);
    if (!toRows.length) { toRows = ccRows; ccRows = []; }   // an email needs at least one To

    const { subject, html, text } = buildMomEmail(mom);
    // Dedicated MOM sender (same address SmartSys uses: noreply@company-b.example).
    const momFromEmail = process.env.SMTP_MOM_FROM_EMAIL;
    const from = momFromEmail ? `"${process.env.SMTP_MOM_FROM_NAME || 'MOM'}" <${momFromEmail}>` : undefined;
    if (String(req.query.preview || '').toLowerCase() === 'true') {
      return res.json({ preview: true, subject, from: from || '(company default)', bodyText: text,
        to: toRows.map(r => ({ name: r.Name, email: r.Email })),
        cc: ccRows.map(r => ({ name: r.Name, email: r.Email })) });
    }
    const company = req.headers['x-company'] || req.query.company || 'COMPANYA';
    const r = await sendMail({ to: toRows.map(x => x.Email), cc: ccRows.length ? ccRows.map(x => x.Email) : undefined, subject, html, text, company, from, noAutoFooter: true });
    if (!r.ok) return res.status(502).json({ message: 'Email could not be sent: ' + (r.error || 'unknown') });
    res.json({ sent: toRows.length + ccRows.length, to: toRows.map(x => x.Name), cc: ccRows.map(x => x.Name), messageId: r.messageId });
  } catch (err) {
    console.error('mom send-mail error:', err.message);
    res.status(500).json({ message: 'Failed to send MOM email', error: err.message });
  }
});

module.exports = router;
