// =====================================================================
// services/workflowEngine.js — Multi-level approval workflow (Phase 6B)
//
// Generic engine over HRM_Workflow_Definition / _Level / _Instance, used by
// Leave, Regularization, and IT Declaration approvals.
//
// Backward-compat: if no workflow matches an EntityKind+payload, the engine
// returns null and the calling route should fall back to its legacy
// single-level (AppliedToUserId) flow. Existing leave / reg / IT rows that
// were approved under the old flow are NOT migrated.
//
// Public API:
//   selectWorkflow(pool, entityKind, payload)               → workflow def + levels, or null
//   resolveReviewer(pool, level, requesterUserId, decisionDate)  → { userId, viaDelegation, name }
//   startInstance(pool, entityKind, entityId, requesterUserId, workflow)  → InstanceId
//   advance(pool, instanceId, decision, byUserId, note)     → { status, currentLevel, totalLevels, nextReviewer }
//   getInstance(pool, entityKind, entityId)                 → instance + history (null if no workflow)
// =====================================================================

const HR_ROLES = ['admin','operation head','director','hr','hr head'];

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }

// ── selectWorkflow ──────────────────────────────────────────────────────────
// Pulls all ACTIVE workflows for the given EntityKind, sorted by Priority,
// returns the FIRST one whose Conditions match the payload.
// payload = { daysGT, departmentIn, amountGT, ... } (kind-specific)
async function selectWorkflow(pool, entityKind, payload) {
  const { sql } = require('../db');
  const r = await pool.request().input('ek', sql.NVarChar(30), entityKind).query(`
    SELECT WorkflowId, Code, Name, EntityKind, Conditions, Priority
    FROM HRM_Workflow_Definition
    WHERE EntityKind = @ek AND IsActive = 1
    ORDER BY Priority, WorkflowId;
  `);
  for (const row of r.recordset) {
    const cond = safeJson(row.Conditions) || {};
    if (!matchConditions(cond, payload)) continue;
    // load levels
    const lQ = await pool.request().input('wid', sql.Int, row.WorkflowId).query(`
      SELECT LevelId, LevelNo, Name, ReviewerKind, ReviewerValue, CanReject, CanDelegate
      FROM HRM_Workflow_Level WHERE WorkflowId = @wid ORDER BY LevelNo;
    `);
    if (!lQ.recordset.length) continue;
    return { ...row, levels: lQ.recordset };
  }
  return null;
}

function matchConditions(cond, payload) {
  if (!cond || Object.keys(cond).length === 0) return true;
  if (cond.daysGT != null  && !(Number(payload?.days)  >  Number(cond.daysGT))) return false;
  if (cond.daysGTE != null && !(Number(payload?.days) >= Number(cond.daysGTE))) return false;
  if (cond.amountGT != null  && !(Number(payload?.amount)  >  Number(cond.amountGT))) return false;
  if (cond.amountGTE != null && !(Number(payload?.amount) >= Number(cond.amountGTE))) return false;
  if (Array.isArray(cond.departmentIn) && !cond.departmentIn.map(s => String(s).toLowerCase()).includes(String(payload?.department || '').toLowerCase())) return false;
  if (Array.isArray(cond.leaveTypeIn) && !cond.leaveTypeIn.includes(String(payload?.leaveTypeCode))) return false;
  return true;
}

// ── resolveReviewer ──────────────────────────────────────────────────────────
// Given a level definition + the requester, returns the actual UserId who
// should act on this level. If that user has approved leave on decisionDate
// AND has a WorkflowDelegateUserId set, the delegate is used instead.
async function resolveReviewer(pool, level, requesterUserId, decisionDate) {
  const { sql } = require('../db');
  const d = decisionDate || new Date();

  let candidateUserId = null;

  switch (String(level.ReviewerKind)) {
    case 'NamedUser': {
      const v = parseInt(level.ReviewerValue, 10);
      if (Number.isFinite(v)) candidateUserId = v;
      break;
    }
    case 'ReportingManager': {
      const r = await pool.request().input('uid', sql.Int, requesterUserId)
        .query('SELECT ReportingManagerId FROM HRM_Employee WHERE UserId = @uid;');
      candidateUserId = r.recordset[0]?.ReportingManagerId || null;
      break;
    }
    case 'DepartmentHead': {
      // Department head = first active user whose Role string contains "head"
      // AND matches the requester's department prefix (e.g. "Sales Head" for Sales dept)
      const r = await pool.request().input('uid', sql.Int, requesterUserId).query(`
        DECLARE @dept NVARCHAR(50) = (SELECT TOP 1 Department FROM HRM_Employee WHERE UserId = @uid);
        SELECT TOP 1 U.Id FROM User_Login U
        LEFT JOIN HRM_Employee E ON E.UserId = U.Id
        WHERE U.IsActive = 1
          AND LOWER(U.Role) LIKE '%head%'
          AND (
               LOWER(U.Role) LIKE LOWER(@dept) + '%head%'
            OR LOWER(E.Department) = LOWER(@dept)
          )
        ORDER BY CASE WHEN LOWER(U.Role) LIKE LOWER(@dept) + ' head' THEN 0 ELSE 1 END, U.Id;
      `);
      candidateUserId = r.recordset[0]?.Id || null;
      break;
    }
    case 'HRHead':
    case 'OperationHead':
    case 'Director': {
      const role = level.ReviewerKind === 'HRHead' ? 'hr head'
                 : level.ReviewerKind === 'OperationHead' ? 'operation head'
                 : 'director';
      const r = await pool.request().input('role', sql.NVarChar(50), role)
        .query("SELECT TOP 1 Id FROM User_Login WHERE IsActive = 1 AND LOWER(Role) = @role ORDER BY Id;");
      candidateUserId = r.recordset[0]?.Id || null;
      // Fall back to plain 'hr' if HRHead not found
      if (!candidateUserId && level.ReviewerKind === 'HRHead') {
        const r2 = await pool.request()
          .query("SELECT TOP 1 Id FROM User_Login WHERE IsActive = 1 AND LOWER(Role) = 'hr' ORDER BY Id;");
        candidateUserId = r2.recordset[0]?.Id || null;
      }
      break;
    }
    case 'AnyRole': {
      const r = await pool.request().input('role', sql.NVarChar(50), String(level.ReviewerValue || '').toLowerCase())
        .query("SELECT TOP 1 Id FROM User_Login WHERE IsActive = 1 AND LOWER(Role) = @role ORDER BY Id;");
      candidateUserId = r.recordset[0]?.Id || null;
      break;
    }
  }

  if (!candidateUserId) return { userId: null, viaDelegation: false, name: null };

  // Delegation: if the candidate is on approved leave today AND has a permanent delegate, use that
  let finalUserId = candidateUserId;
  let viaDelegation = false;
  if (level.CanDelegate) {
    const dQ = await pool.request()
      .input('uid', sql.Int, candidateUserId)
      .input('d',   sql.Date, d)
      .query(`
        SELECT E.WorkflowDelegateUserId,
               (SELECT COUNT(*) FROM HRM_Leave L
                 WHERE L.UserId = @uid AND L.Status = 'approved'
                   AND L.FromDate <= @d AND L.ToDate >= @d) AS OnLeave
        FROM HRM_Employee E WHERE E.UserId = @uid;
      `);
    const row = dQ.recordset[0] || {};
    if (row.OnLeave > 0 && row.WorkflowDelegateUserId) {
      finalUserId  = row.WorkflowDelegateUserId;
      viaDelegation = true;
    }
  }

  const nameQ = await pool.request().input('uid', sql.Int, finalUserId)
    .query('SELECT Name FROM User_Login WHERE Id = @uid;');
  return { userId: finalUserId, viaDelegation, name: nameQ.recordset[0]?.Name || null };
}

// ── startInstance ────────────────────────────────────────────────────────────
async function startInstance(pool, entityKind, entityId, requesterUserId, workflow) {
  const { sql } = require('../db');
  if (!workflow || !workflow.levels?.length) return null;

  const level1 = workflow.levels[0];
  const reviewer = await resolveReviewer(pool, level1, requesterUserId, new Date());
  const r = await pool.request()
    .input('ek',  sql.NVarChar(30), entityKind)
    .input('eid', sql.Int,           entityId)
    .input('wid', sql.Int,           workflow.WorkflowId)
    .input('tl',  sql.TinyInt,       workflow.levels.length)
    .input('cur', sql.Int,           reviewer.userId)
    .input('hist',sql.NVarChar(sql.MAX), JSON.stringify([]))
    .query(`
      IF EXISTS (SELECT 1 FROM HRM_Workflow_Instance WHERE EntityKind = @ek AND EntityId = @eid)
        SELECT TOP 1 InstanceId FROM HRM_Workflow_Instance WHERE EntityKind = @ek AND EntityId = @eid;
      ELSE
        INSERT INTO HRM_Workflow_Instance
          (EntityKind, EntityId, WorkflowId, TotalLevels, CurrentLevel, CurrentReviewerUserId, History)
        OUTPUT INSERTED.InstanceId
        VALUES (@ek, @eid, @wid, @tl, 1, @cur, @hist);
    `);
  return { instanceId: r.recordset[0]?.InstanceId, currentReviewerUserId: reviewer.userId, viaDelegation: reviewer.viaDelegation };
}

// ── advance ─────────────────────────────────────────────────────────────────
// Records a decision. decision = 'approved' | 'rejected'.
// On approve at last level → instance Status='approved'.
// On reject at any level   → instance Status='rejected' (stops the chain).
// Returns the new state + next reviewer (if not finished).
async function advance(pool, instanceId, decision, byUserId, note) {
  const { sql } = require('../db');
  const iQ = await pool.request().input('id', sql.Int, instanceId).query(`
    SELECT I.*, D.Code AS WorkflowCode FROM HRM_Workflow_Instance I
    LEFT JOIN HRM_Workflow_Definition D ON D.WorkflowId = I.WorkflowId
    WHERE I.InstanceId = @id;
  `);
  const inst = iQ.recordset[0];
  if (!inst) throw new Error('Workflow instance not found');
  if (inst.Status !== 'in-progress') throw new Error('Workflow is ' + inst.Status + ' — cannot advance');

  const nameQ = await pool.request().input('uid', sql.Int, byUserId)
    .query('SELECT Name FROM User_Login WHERE Id = @uid;');
  const byName = nameQ.recordset[0]?.Name || ('User ' + byUserId);

  const history = safeJson(inst.History) || [];
  history.push({
    level:        inst.CurrentLevel,
    decidedBy:    byUserId,
    decidedByName: byName,
    decision,
    at:           new Date().toISOString(),
    note:         note || null,
  });

  let newStatus = inst.Status;
  let newLevel  = inst.CurrentLevel;
  let nextReviewer = null;

  if (decision === 'rejected') {
    newStatus = 'rejected';
  } else if (decision === 'approved') {
    if (inst.CurrentLevel >= inst.TotalLevels) {
      newStatus = 'approved';
    } else {
      newLevel = inst.CurrentLevel + 1;
      // Resolve next reviewer
      const lvlQ = await pool.request().input('wid', sql.Int, inst.WorkflowId).input('ln', sql.TinyInt, newLevel)
        .query('SELECT TOP 1 * FROM HRM_Workflow_Level WHERE WorkflowId = @wid AND LevelNo = @ln;');
      const nextLevelDef = lvlQ.recordset[0];
      if (nextLevelDef) {
        // Get the original requester to resolve manager / dept head etc.
        // From the entity table — Leave / Reg / IT
        const requesterId = await fetchRequesterUserId(pool, inst.EntityKind, inst.EntityId);
        nextReviewer = await resolveReviewer(pool, nextLevelDef, requesterId, new Date());
      }
    }
  }

  await pool.request()
    .input('id',    sql.Int,           instanceId)
    .input('st',    sql.NVarChar(20),  newStatus)
    .input('cl',    sql.TinyInt,       newLevel)
    .input('cr',    sql.Int,           nextReviewer?.userId || null)
    .input('hist',  sql.NVarChar(sql.MAX), JSON.stringify(history))
    .query(`
      UPDATE HRM_Workflow_Instance
      SET Status = @st, CurrentLevel = @cl, CurrentReviewerUserId = @cr,
          History = @hist, UpdatedAt = SYSDATETIME(),
          FinishedAt = CASE WHEN @st IN ('approved','rejected','cancelled') THEN SYSDATETIME() ELSE NULL END
      WHERE InstanceId = @id;
    `);

  return { status: newStatus, currentLevel: newLevel, totalLevels: inst.TotalLevels, nextReviewer };
}

async function fetchRequesterUserId(pool, entityKind, entityId) {
  const { sql } = require('../db');
  let table, idCol;
  if (entityKind === 'Leave')          { table = 'HRM_Leave';          idCol = 'LeaveId'; }
  else if (entityKind === 'Regularization') { table = 'HRM_Regularization'; idCol = 'RegId'; }
  else if (entityKind === 'ITDeclaration')  { table = 'HRM_IT_Declaration'; idCol = 'DeclarationId'; }
  else return null;
  const r = await pool.request().input('id', sql.Int, entityId)
    .query(`SELECT UserId FROM ${table} WHERE ${idCol} = @id;`);
  return r.recordset[0]?.UserId || null;
}

// ── getInstance ─────────────────────────────────────────────────────────────
async function getInstance(pool, entityKind, entityId) {
  const { sql } = require('../db');
  const r = await pool.request().input('ek', sql.NVarChar(30), entityKind).input('eid', sql.Int, entityId).query(`
    SELECT I.*, D.Code AS WorkflowCode, D.Name AS WorkflowName,
           U.Name AS CurrentReviewerName
    FROM HRM_Workflow_Instance I
    LEFT JOIN HRM_Workflow_Definition D ON D.WorkflowId = I.WorkflowId
    LEFT JOIN User_Login U ON U.Id = I.CurrentReviewerUserId
    WHERE I.EntityKind = @ek AND I.EntityId = @eid;
  `);
  if (!r.recordset.length) return null;
  const inst = r.recordset[0];
  inst.History = safeJson(inst.History) || [];
  return inst;
}

module.exports = {
  selectWorkflow,
  resolveReviewer,
  startInstance,
  advance,
  getInstance,
};
