// =====================================================================
// modules/hr/routes/workflow.js — Workflow admin (Phase 6B)
// Mounted at /api/hr/workflow/* by ../index.js
//
// Endpoints (HR-only):
//   GET    /options                  — reviewer kinds, entity kinds
//   GET    /definitions              — list workflows (?entityKind=&archived=)
//   POST   /definitions              — create workflow + levels in one shot
//   GET    /definitions/:id          — detail with levels
//   PATCH  /definitions/:id          — update header + replace levels
//   DELETE /definitions/:id          — soft archive
//
//   GET    /instances/:entityKind/:entityId  — workflow state for one request (anyone with access)
//   POST   /resolve-reviewer-test    — dry-run: given level def + userId, return who would approve
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');
const wf = require('../../../services/workflowEngine');

const ENTITY_KINDS    = ['Leave', 'Regularization', 'ITDeclaration'];
const REVIEWER_KINDS  = ['ReportingManager', 'DepartmentHead', 'HRHead', 'OperationHead', 'Director', 'NamedUser', 'AnyRole'];

router.use(authenticate);

router.get('/options', (req, res) => {
  res.json({
    entityKinds:   ENTITY_KINDS,
    reviewerKinds: REVIEWER_KINDS,
    conditionsHelp: {
      Leave:          ['daysGT', 'daysGTE', 'departmentIn', 'leaveTypeIn'],
      Regularization: ['departmentIn'],
      ITDeclaration:  ['amountGT', 'departmentIn'],
    },
  });
});

// ── GET /instances/:entityKind/:entityId — anyone who can see the request ───
router.get('/instances/:entityKind/:entityId', async (req, res) => {
  const ek  = req.params.entityKind;
  const eid = parseInt(req.params.entityId, 10);
  if (!ENTITY_KINDS.includes(ek) || !Number.isFinite(eid)) return res.status(400).json({ message: 'Invalid params' });
  try {
    const pool = await getAppPool();
    const inst = await wf.getInstance(pool, ek, eid);
    res.json({ instance: inst });
  } catch (e) { console.error('[wf/instance]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// All write endpoints below are HR-only
router.use((req, res, next) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  next();
});

// ── GET /definitions ────────────────────────────────────────────────────────
router.get('/definitions', async (req, res) => {
  const ek = req.query.entityKind;
  const archived = req.query.archived === 'true';
  try {
    const pool = await getAppPool();
    const r = pool.request();
    let where = archived ? 'IsActive = 0' : 'IsActive = 1';
    if (ek && ENTITY_KINDS.includes(ek)) { r.input('ek', sql.NVarChar(30), ek); where += ' AND EntityKind = @ek'; }
    const result = await r.query(`
      SELECT D.*,
             (SELECT COUNT(*) FROM HRM_Workflow_Level WHERE WorkflowId = D.WorkflowId) AS LevelCount,
             (SELECT COUNT(*) FROM HRM_Workflow_Instance WHERE WorkflowId = D.WorkflowId AND Status = 'in-progress') AS ActiveCount
      FROM HRM_Workflow_Definition D
      WHERE ${where}
      ORDER BY D.EntityKind, D.Priority, D.Name;
    `);
    res.json({ definitions: result.recordset });
  } catch (e) { console.error('[wf/list]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── POST /definitions ───────────────────────────────────────────────────────
router.post('/definitions', async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  const name = String(b.name || '').trim();
  const ek   = String(b.entityKind || '').trim();
  const levels = Array.isArray(b.levels) ? b.levels : [];
  if (!code) return res.status(400).json({ message: 'Code is required' });
  if (!name) return res.status(400).json({ message: 'Name is required' });
  if (!ENTITY_KINDS.includes(ek)) return res.status(400).json({ message: 'Invalid entityKind' });
  if (levels.length < 1 || levels.length > 6) return res.status(400).json({ message: 'Workflow needs 1-6 levels' });
  const cleanedLevels = validateLevels(levels);
  if (cleanedLevels.error) return res.status(400).json({ message: cleanedLevels.error });

  try {
    const pool = await getAppPool();
    const ins = await pool.request()
      .input('cd',   sql.NVarChar(40),  code)
      .input('nm',   sql.NVarChar(150), name)
      .input('desc', sql.NVarChar(500), b.description || null)
      .input('ek',   sql.NVarChar(30),  ek)
      .input('cnd',  sql.NVarChar(sql.MAX), b.conditions ? JSON.stringify(b.conditions) : null)
      .input('pr',   sql.Int,           parseInt(b.priority, 10) || 100)
      .input('cb',   sql.Int,           req.user.id)
      .query(`
        INSERT INTO HRM_Workflow_Definition (Code, Name, Description, EntityKind, Conditions, Priority, CreatedBy)
        OUTPUT INSERTED.WorkflowId
        VALUES (@cd, @nm, @desc, @ek, @cnd, @pr, @cb);
      `);
    const wid = ins.recordset[0].WorkflowId;
    await insertLevels(pool, wid, cleanedLevels.levels);
    res.status(201).json({ workflowId: wid });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE'))
      return res.status(409).json({ message: 'Workflow code already exists' });
    console.error('[wf/create]', e);
    res.status(500).json({ message: 'Failed', error: e.message });
  }
});

// ── GET /definitions/:id ────────────────────────────────────────────────────
router.get('/definitions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const hQ = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM HRM_Workflow_Definition WHERE WorkflowId = @id;');
    if (!hQ.recordset.length) return res.status(404).json({ message: 'Not found' });
    const lQ = await pool.request().input('id', sql.Int, id).query(`
      SELECT * FROM HRM_Workflow_Level WHERE WorkflowId = @id ORDER BY LevelNo;
    `);
    res.json({ definition: hQ.recordset[0], levels: lQ.recordset });
  } catch (e) { console.error('[wf/get]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── PATCH /definitions/:id — replace header + levels ────────────────────────
router.patch('/definitions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const b = req.body || {};
  try {
    const pool = await getAppPool();
    const r = pool.request().input('id', sql.Int, id);
    const sets = [];
    if (b.name        != null) { r.input('nm',   sql.NVarChar(150), String(b.name)); sets.push('Name = @nm'); }
    if (b.description !== undefined) { r.input('desc', sql.NVarChar(500), b.description || null); sets.push('Description = @desc'); }
    if (b.conditions  !== undefined) { r.input('cnd',  sql.NVarChar(sql.MAX), b.conditions ? JSON.stringify(b.conditions) : null); sets.push('Conditions = @cnd'); }
    if (b.priority    != null) { r.input('pr',   sql.Int, parseInt(b.priority, 10) || 100); sets.push('Priority = @pr'); }
    if (b.isActive   !== undefined) { r.input('act',  sql.Bit, b.isActive ? 1 : 0); sets.push('IsActive = @act'); }
    if (sets.length) {
      sets.push('UpdatedAt = SYSDATETIME()');
      await r.query(`UPDATE HRM_Workflow_Definition SET ${sets.join(', ')} WHERE WorkflowId = @id;`);
    }
    if (Array.isArray(b.levels)) {
      const cleaned = validateLevels(b.levels);
      if (cleaned.error) return res.status(400).json({ message: cleaned.error });
      // Replace-all junction
      await pool.request().input('id', sql.Int, id)
        .query('DELETE FROM HRM_Workflow_Level WHERE WorkflowId = @id;');
      await insertLevels(pool, id, cleaned.levels);
    }
    res.json({ ok: true });
  } catch (e) { console.error('[wf/patch]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ── DELETE /definitions/:id ─────────────────────────────────────────────────
router.delete('/definitions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const u = await pool.request().input('id', sql.Int, id)
      .query("SELECT COUNT(*) AS Cnt FROM HRM_Workflow_Instance WHERE WorkflowId = @id AND Status = 'in-progress';");
    if (u.recordset[0].Cnt > 0) return res.status(409).json({ message: 'Workflow has in-progress instances; let them finish before archiving' });
    await pool.request().input('id', sql.Int, id)
      .query('UPDATE HRM_Workflow_Definition SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE WorkflowId = @id;');
    res.json({ ok: true });
  } catch (e) { console.error('[wf/delete]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

function validateLevels(rawLevels) {
  const cleaned = [];
  for (let i = 0; i < rawLevels.length; i++) {
    const lv = rawLevels[i] || {};
    if (!REVIEWER_KINDS.includes(lv.reviewerKind)) return { error: `Level ${i+1}: invalid reviewerKind` };
    if ((lv.reviewerKind === 'NamedUser' || lv.reviewerKind === 'AnyRole') && !lv.reviewerValue) {
      return { error: `Level ${i+1}: reviewerValue required for ${lv.reviewerKind}` };
    }
    cleaned.push({
      levelNo:       i + 1,
      name:          String(lv.name || '').trim() || `Level ${i+1}`,
      reviewerKind:  lv.reviewerKind,
      reviewerValue: lv.reviewerValue == null ? null : String(lv.reviewerValue),
      canReject:     lv.canReject === false ? false : true,
      canDelegate:   lv.canDelegate === false ? false : true,
    });
  }
  return { levels: cleaned };
}

async function insertLevels(pool, workflowId, levels) {
  for (const lv of levels) {
    await pool.request()
      .input('wid',  sql.Int,           workflowId)
      .input('ln',   sql.TinyInt,       lv.levelNo)
      .input('nm',   sql.NVarChar(100), lv.name)
      .input('rk',   sql.NVarChar(30),  lv.reviewerKind)
      .input('rv',   sql.NVarChar(100), lv.reviewerValue)
      .input('cr',   sql.Bit,           lv.canReject ? 1 : 0)
      .input('cd',   sql.Bit,           lv.canDelegate ? 1 : 0)
      .query(`
        INSERT INTO HRM_Workflow_Level (WorkflowId, LevelNo, Name, ReviewerKind, ReviewerValue, CanReject, CanDelegate)
        VALUES (@wid, @ln, @nm, @rk, @rv, @cr, @cd);
      `);
  }
}

module.exports = router;
