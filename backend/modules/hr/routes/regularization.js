// =====================================================================
// modules/hr/routes/regularization.js — Attendance regularization (Phase 3B)
// Mounted at /api/hr/regularization/* by ../index.js
//
// Endpoints:
//   POST /apply        — submit a correction request
//   GET  /requests     — scope=mine|pending-mine|team|all + status
//   PUT  /:id/approve  — applies the corrected times to HRM_Attendance
//   PUT  /:id/reject
//   PUT  /:id/cancel   — applicant cancels own pending
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin, isSalesHead } = require('../../../auth');
const wf = require('../../../services/workflowEngine');     // Phase 6B — multi-level workflow integration

function pickCompany(user) {
  if (user.companyaCode && user.companyaCode.trim())       return 'COMPANYA';
  if (user.companybCode && user.companybCode.trim()) return 'CompanyB';
  return null;
}
function pickUserCode(user) {
  if (user.companyaCode && user.companyaCode.trim())       return user.companyaCode.split('/')[0].trim();
  if (user.companybCode && user.companybCode.trim()) return user.companybCode.split('/')[0].trim();
  return null;
}

function canApprove(reqUser, row) {
  if (isLensAdmin(reqUser)) return true;
  if (Number(row.AppliedToUserId) === Number(reqUser.id)) return true;
  return false;
}

async function loadReg(pool, id) {
  const r = await pool.request().input('id', sql.Int, id)
    .query(`SELECT * FROM [dbo].[HRM_Regularization] WHERE RegId = @id;`);
  return r.recordset[0] || null;
}

// Combine 'YYYY-MM-DD' + 'HH:MM' into a Date for HRM_Attendance writes.
function combineDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  // Accept HH:MM or HH:MM:SS
  const [h, m, s] = String(timeStr).split(':').map(x => parseInt(x, 10));
  const d = new Date(dateStr);
  d.setHours(h || 0, m || 0, s || 0, 0);
  return d;
}

// ── POST /apply ──────────────────────────────────────────────────────────────
router.post('/apply', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.attDate)               return res.status(400).json({ message: 'attDate required (YYYY-MM-DD)' });
    if (!b.kind)                  return res.status(400).json({ message: 'kind required (sign-in | sign-out | both)' });
    if (!['sign-in','sign-out','both'].includes(b.kind))
                                  return res.status(400).json({ message: 'invalid kind' });
    if (!b.reason || !b.reason.trim()) return res.status(400).json({ message: 'reason required' });

    if (b.kind === 'sign-in'  || b.kind === 'both') {
      if (!b.requestedSignInTime) return res.status(400).json({ message: 'requestedSignInTime required' });
    }
    if (b.kind === 'sign-out' || b.kind === 'both') {
      if (!b.requestedSignOutTime) return res.status(400).json({ message: 'requestedSignOutTime required' });
    }

    const pool = await getAppPool();
    const r = pool.request();
    r.input('uid',          sql.Int,           req.user.id);
    r.input('uc',           sql.NVarChar(50),  pickUserCode(req.user));
    r.input('co',           sql.NVarChar(10),  pickCompany(req.user));
    r.input('attDate',      sql.Date,          b.attDate);
    r.input('session',      sql.TinyInt,       parseInt(b.session) || 1);
    r.input('kind',         sql.NVarChar(20),  b.kind);
    r.input('inTime',       sql.NVarChar(8),   b.requestedSignInTime  || null);
    r.input('outTime',      sql.NVarChar(8),   b.requestedSignOutTime || null);
    r.input('reason',       sql.NVarChar(sql.MAX), b.reason.trim());
    r.input('attachment',   sql.NVarChar(500), b.attachmentUrl || null);
    r.input('appliedTo',    sql.Int,           b.appliedToUserId ? parseInt(b.appliedToUserId) : null);
    r.input('cc',           sql.NVarChar(sql.MAX), b.ccList ? JSON.stringify(b.ccList) : null);

    const out = await r.query(`
      INSERT INTO [dbo].[HRM_Regularization]
        (UserId, UserCode, Company, AttDate, Session, Kind,
         RequestedSignInTime, RequestedSignOutTime,
         Reason, AttachmentUrl, AppliedToUserId, CCList)
      OUTPUT INSERTED.RegId, INSERTED.AppliedAt
      VALUES
        (@uid, @uc, @co, @attDate, @session, @kind,
         CONVERT(time, @inTime), CONVERT(time, @outTime),
         @reason, @attachment, @appliedTo, @cc);
    `);
    const newRegId = out.recordset[0].RegId;

    // Phase 6B: try to attach a multi-level workflow. Failures must not fail the apply.
    let workflowInfo = null;
    try {
      const empQ = await pool.request().input('uid', sql.Int, req.user.id)
        .query('SELECT Department FROM HRM_Employee WHERE UserId = @uid;');
      const dept = empQ.recordset[0]?.Department || null;
      const wfDef = await wf.selectWorkflow(pool, 'Regularization', { department: dept });
      if (wfDef) {
        const started = await wf.startInstance(pool, 'Regularization', newRegId, req.user.id, wfDef);
        if (started?.currentReviewerUserId) {
          await pool.request().input('id', sql.Int, newRegId).input('to', sql.Int, started.currentReviewerUserId)
            .query('UPDATE HRM_Regularization SET AppliedToUserId = @to, UpdatedAt = SYSDATETIME() WHERE RegId = @id;');
        }
        workflowInfo = { workflowCode: wfDef.Code, workflowName: wfDef.Name, totalLevels: wfDef.levels.length, currentLevel: 1 };
      }
    } catch (wfErr) {
      console.warn('[reg/apply wf-start]', wfErr.message);
    }

    return res.status(201).json({
      ok: true,
      regId:     newRegId,
      appliedAt: out.recordset[0].AppliedAt,
      workflow:  workflowInfo,
    });
  } catch (err) {
    console.error('[POST /api/hr/regularization/apply] failed:', err.message);
    return res.status(500).json({ message: 'Apply failed', detail: err.message });
  }
});

// ── GET /requests ────────────────────────────────────────────────────────────
router.get('/requests', authenticate, async (req, res) => {
  try {
    const scope = (req.query.scope || 'mine').toLowerCase();
    const status = (req.query.status || '').toLowerCase();
    const pool = await getAppPool();
    const r = pool.request();
    const where = ['1=1'];

    if (scope === 'mine') {
      where.push('R.UserId = @selfId');
      r.input('selfId', sql.Int, req.user.id);
    } else if (scope === 'pending-mine') {
      where.push('(R.AppliedToUserId = @selfId OR (R.AppliedToUserId IS NULL AND @isAdmin = 1))');
      r.input('selfId',  sql.Int, req.user.id);
      r.input('isAdmin', sql.Bit, isLensAdmin(req.user) ? 1 : 0);
    } else if (scope === 'team') {
      const codes = ((req.user.companyaCode || '') + '/' + (req.user.companybCode || ''))
        .split('/').map(s => s.trim()).filter(Boolean);
      if (codes.length === 0 || !isSalesHead(req.user)) return res.json({ ok: true, requests: [] });
      codes.forEach((c, i) => r.input('tc' + i, sql.NVarChar(50), c));
      where.push(`(R.UserId = @selfId OR EXISTS (
        SELECT 1 FROM [dbo].[User_Login] UL
        WHERE UL.Id = R.UserId AND (
          EXISTS (SELECT 1 FROM string_split(UL.CompanyACode,    '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@tc'+i).join(',')}))
          OR EXISTS (SELECT 1 FROM string_split(UL.CompanyBCode, '/') s WHERE LTRIM(RTRIM(s.value)) IN (${codes.map((_,i)=>'@tc'+i).join(',')}))
        )
      ))`);
      r.input('selfId', sql.Int, req.user.id);
    } else if (scope === 'all') {
      if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'Only HR / admin' });
    }
    if (status) { where.push('R.Status = @st'); r.input('st', sql.NVarChar(20), status); }

    const result = await r.query(`
      SELECT
        R.RegId, R.UserId, UL.Name AS UserName, UL.Email AS Email, UL.CompanyACode AS CompanyACode,
        R.AttDate, R.Session, R.Kind, R.RequestedSignInTime, R.RequestedSignOutTime,
        R.Reason, R.AttachmentUrl,
        R.AppliedAt, R.AppliedToUserId, AT.Name AS AppliedToName,
        R.Status,
        R.ApprovedBy, AB.Name AS ApprovedByName, R.ApprovedAt, R.ApprovalNote, R.AppliedToAttId,
        R.RejectedBy, RB.Name AS RejectedByName, R.RejectedAt, R.RejectionReason,
        R.CancelledAt,
        WI.CurrentLevel  AS WfCurrentLevel,
        WI.TotalLevels   AS WfTotalLevels,
        WD.Code          AS WfCode,
        WD.Name          AS WfName
      FROM [dbo].[HRM_Regularization] R
      LEFT JOIN [dbo].[User_Login] UL ON UL.Id = R.UserId
      LEFT JOIN [dbo].[User_Login] AT ON AT.Id = R.AppliedToUserId
      LEFT JOIN [dbo].[User_Login] AB ON AB.Id = R.ApprovedBy
      LEFT JOIN [dbo].[User_Login] RB ON RB.Id = R.RejectedBy
      LEFT JOIN [dbo].[HRM_Workflow_Instance] WI ON WI.EntityKind = 'Regularization' AND WI.EntityId = R.RegId
      LEFT JOIN [dbo].[HRM_Workflow_Definition] WD ON WD.WorkflowId = WI.WorkflowId
      WHERE ${where.join(' AND ')}
      ORDER BY R.AppliedAt DESC;
    `);
    return res.json({ ok: true, requests: result.recordset });
  } catch (err) {
    console.error('[/api/hr/regularization/requests] failed:', err.message);
    return res.status(500).json({ message: 'Fetch failed', detail: err.message });
  }
});

// ── PUT /:id/approve ────────────────────────────────────────────────────────
router.put('/:id/approve', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const note = (req.body && req.body.note) || null;

    const pool = await getAppPool();
    const row = await loadReg(pool, id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    if (row.Status !== 'pending') return res.status(409).json({ message: 'Already ' + row.Status });
    if (!canApprove(req.user, row)) return res.status(403).json({ message: 'Not allowed' });

    // Phase 6B: advance workflow if attached. Intermediate levels return without
    // applying the attendance correction — that happens only when the workflow finishes.
    const inst = await wf.getInstance(pool, 'Regularization', id);
    if (inst && inst.Status === 'in-progress') {
      if (Number(inst.CurrentReviewerUserId) !== Number(req.user.id) && !isLensAdmin(req.user)) {
        return res.status(403).json({
          message: `Not your turn — waiting on ${inst.CurrentReviewerName || ('user ' + inst.CurrentReviewerUserId)} at level ${inst.CurrentLevel}/${inst.TotalLevels}`,
        });
      }
      const r = await wf.advance(pool, inst.InstanceId, 'approved', req.user.id, note);
      if (r.status === 'in-progress') {
        await pool.request().input('id', sql.Int, id).input('to', sql.Int, r.nextReviewer?.userId || null)
          .query('UPDATE HRM_Regularization SET AppliedToUserId = @to, UpdatedAt = SYSDATETIME() WHERE RegId = @id;');
        return res.json({ ok: true, workflowAdvanced: true, currentLevel: r.currentLevel, totalLevels: r.totalLevels, nextReviewer: r.nextReviewer });
      }
      // Final approval — fall through to the legacy "apply attendance correction" block
    }

    // Find existing HRM_Attendance row for that date+session (if any)
    const attRes = await pool.request()
      .input('uid', sql.Int, row.UserId)
      .input('dt',  sql.Date, row.AttDate)
      .input('ses', sql.TinyInt, row.Session)
      .query(`
        SELECT TOP 1 AttId, SignInTime, SignOutTime
        FROM [dbo].[HRM_Attendance]
        WHERE UserId = @uid AND AttDate = @dt AND Session = @ses;
      `);

    const signInDT  = combineDateTime(row.AttDate, row.RequestedSignInTime);
    const signOutDT = combineDateTime(row.AttDate, row.RequestedSignOutTime);
    let totalMin = null;
    if (signInDT && signOutDT) totalMin = Math.max(0, Math.round((signOutDT - signInDT) / 60000));

    let attId;
    if (attRes.recordset.length > 0) {
      attId = attRes.recordset[0].AttId;
      const upd = pool.request().input('attId', sql.BigInt, attId).input('uid', sql.Int, req.user.id);
      const sets = ['Status = \'P\'', 'IsRegularized = 1', 'RegularizedBy = @uid', 'RegularizedAt = SYSDATETIME()', 'UpdatedAt = SYSDATETIME()'];
      if (signInDT)  { sets.push('SignInTime = @signIn');   upd.input('signIn',  sql.DateTime2, signInDT); }
      if (signOutDT) { sets.push('SignOutTime = @signOut'); upd.input('signOut', sql.DateTime2, signOutDT); }
      if (totalMin != null) { sets.push('TotalWorkMin = @t'); upd.input('t', sql.Int, totalMin); }
      await upd.query(`UPDATE [dbo].[HRM_Attendance] SET ${sets.join(', ')} WHERE AttId = @attId;`);
    } else {
      // No existing attendance row — create one
      const ins = pool.request();
      ins.input('uid',     sql.Int,           row.UserId);
      ins.input('uc',      sql.NVarChar(50),  row.UserCode);
      ins.input('co',      sql.NVarChar(10),  row.Company);
      ins.input('dt',      sql.Date,          row.AttDate);
      ins.input('ses',     sql.TinyInt,       row.Session);
      ins.input('signIn',  sql.DateTime2,     signInDT);
      ins.input('signOut', sql.DateTime2,     signOutDT);
      ins.input('total',   sql.Int,           totalMin);
      ins.input('uidApprover', sql.Int,       req.user.id);
      const insOut = await ins.query(`
        INSERT INTO [dbo].[HRM_Attendance]
          (UserId, UserCode, Company, AttDate, Session, Status,
           SignInTime, SignOutTime, TotalWorkMin,
           IsRegularized, RegularizedBy, RegularizedAt, ShiftCode)
        OUTPUT INSERTED.AttId
        VALUES
          (@uid, @uc, @co, @dt, @ses, 'P',
           @signIn, @signOut, @total,
           1, @uidApprover, SYSDATETIME(), '09:45-18:15');
      `);
      attId = insOut.recordset[0].AttId;
    }

    // Mark regularization approved + link to the att row
    await pool.request()
      .input('id',   sql.Int,           id)
      .input('uid',  sql.Int,           req.user.id)
      .input('note', sql.NVarChar(500), note)
      .input('att',  sql.BigInt,        attId)
      .query(`
        UPDATE [dbo].[HRM_Regularization]
        SET Status = 'approved', ApprovedBy = @uid, ApprovedAt = SYSDATETIME(),
            ApprovalNote = @note, AppliedToAttId = @att, UpdatedAt = SYSDATETIME()
        WHERE RegId = @id;
      `);
    return res.json({ ok: true, attId });
  } catch (err) {
    console.error('[approve] failed:', err.message);
    return res.status(500).json({ message: 'Approve failed', detail: err.message });
  }
});

// ── PUT /:id/reject ─────────────────────────────────────────────────────────
router.put('/:id/reject', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const reason = (req.body && req.body.reason) || null;
    if (!reason || !reason.trim()) return res.status(400).json({ message: 'reason required' });

    const pool = await getAppPool();
    const row = await loadReg(pool, id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    if (row.Status !== 'pending') return res.status(409).json({ message: 'Already ' + row.Status });
    if (!canApprove(req.user, row)) return res.status(403).json({ message: 'Not allowed' });

    // Phase 6B: workflow short-circuit on reject. Any level rejection ends the chain.
    const inst = await wf.getInstance(pool, 'Regularization', id);
    if (inst && inst.Status === 'in-progress') {
      if (Number(inst.CurrentReviewerUserId) !== Number(req.user.id) && !isLensAdmin(req.user)) {
        return res.status(403).json({
          message: `Not your turn — waiting on ${inst.CurrentReviewerName || ('user ' + inst.CurrentReviewerUserId)} at level ${inst.CurrentLevel}/${inst.TotalLevels}`,
        });
      }
      await wf.advance(pool, inst.InstanceId, 'rejected', req.user.id, reason);
      // Fall through to legacy reject — flips HRM_Regularization.Status='rejected'
    }

    await pool.request()
      .input('id', sql.Int, id).input('uid', sql.Int, req.user.id).input('reason', sql.NVarChar(500), reason)
      .query(`
        UPDATE [dbo].[HRM_Regularization]
        SET Status = 'rejected', RejectedBy = @uid, RejectedAt = SYSDATETIME(),
            RejectionReason = @reason, UpdatedAt = SYSDATETIME()
        WHERE RegId = @id;
      `);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Reject failed', detail: err.message });
  }
});

// ── PUT /:id/cancel ─────────────────────────────────────────────────────────
router.put('/:id/cancel', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    const row = await loadReg(pool, id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    if (Number(row.UserId) !== Number(req.user.id)) return res.status(403).json({ message: 'Only the applicant can cancel' });
    if (row.Status !== 'pending') return res.status(409).json({ message: 'Only pending requests can be cancelled' });

    await pool.request().input('id', sql.Int, id).query(`
      UPDATE [dbo].[HRM_Regularization]
      SET Status = 'cancelled', CancelledAt = SYSDATETIME(), UpdatedAt = SYSDATETIME()
      WHERE RegId = @id;
    `);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Cancel failed', detail: err.message });
  }
});

module.exports = router;
