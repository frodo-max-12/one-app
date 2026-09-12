// =====================================================================
// modules/hr/routes/helpdesk.js — Helpdesk ticket lifecycle (Phase 4C)
// Mounted at /api/hr/helpdesk/* by ../index.js
//
// Endpoints:
//   GET    /options                    — categories + priorities + statuses
//   GET    /assignees                  — list of HR members for assignment
//   GET    /tickets                    — list (scope=mine|assigned|all, status=, priority=)
//   POST   /tickets                    — create new ticket
//   GET    /tickets/:id                — full detail (ticket + comments + attachments)
//   PATCH  /tickets/:id                — update status/assignment/resolution
//   POST   /tickets/:id/comments       — add a comment (public or internal)
//   POST   /tickets/:id/attachments    — upload one or more files (multipart)
//   GET    /tickets/:id/attachments/:attId  — download an attachment
//
// Permissions:
//   - Any logged-in employee can create + view + comment on their own tickets.
//   - The assignee (any user the HR put on the ticket) can also view + comment.
//   - HR / admin (LENS_ADMIN_ROLES) can do everything: list all, assign, set
//     status, write internal comments, see internal comments.
// =====================================================================

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin, HR_ROLES, LENS_ADMIN_ROLES } = require('../../../auth');

// ── Constants ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  'Employee Information',
  'Income Tax',
  'Loans',
  'Leave & Attendance',
  'Payroll',
  'IT / Access',
  'Other',
];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const STATUSES   = ['open', 'in-progress', 'on-hold', 'resolved', 'closed'];

// Friendly ticket-number formatter (HD-2026-0001)
function buildTicketNo(ticketId, when) {
  const y = (when ? new Date(when) : new Date()).getFullYear();
  return 'HD-' + y + '-' + String(ticketId).padStart(4, '0');
}

// ── Storage for attachments ──────────────────────────────────────────────────
const UPLOAD_ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'hr', 'helpdesk');
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch (_) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tid = parseInt(req.params.id);
      const dir = path.join(UPLOAD_ROOT, String(tid));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safe  = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${stamp}_${safe}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Lightweight permission helper ────────────────────────────────────────────
async function loadTicketForUser(pool, ticketId, user) {
  const r = await pool.request()
    .input('id', sql.Int, ticketId)
    .query('SELECT * FROM HRM_Helpdesk_Ticket WHERE TicketId = @id');
  const row = r.recordset[0];
  if (!row) return { row: null, canRead: false, canEditAsHr: false, canActAsOwner: false };
  const canEditAsHr   = isLensAdmin(user);
  const canActAsOwner = user && (row.UserId === user.id);
  const canRead = canEditAsHr || canActAsOwner || (row.AssignedToUserId === user.id);
  return { row, canRead, canEditAsHr, canActAsOwner };
}

// ── GET /options ─────────────────────────────────────────────────────────────
router.get('/options', authenticate, (req, res) => {
  res.json({ categories: CATEGORIES, priorities: PRIORITIES, statuses: STATUSES });
});

// ── GET /assignees ───────────────────────────────────────────────────────────
router.get('/assignees', authenticate, async (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  try {
    const pool = await getAppPool();
    const roles = LENS_ADMIN_ROLES.map(r => `'${r.replace(/'/g,"''")}'`).join(',');
    const result = await pool.request().query(`
      SELECT Id AS UserId, Name, Email, Role
      FROM User_Login
      WHERE IsActive = 1 AND LOWER(Role) IN (${roles})
      ORDER BY Name
    `);
    res.json({ assignees: result.recordset });
  } catch (err) {
    console.error('[helpdesk/assignees]', err);
    res.status(500).json({ message: 'Failed to load assignees', error: err.message });
  }
});

// ── GET /tickets ─────────────────────────────────────────────────────────────
router.get('/tickets', authenticate, async (req, res) => {
  const scope    = (req.query.scope    || 'mine').toLowerCase();
  const status   = (req.query.status   || '').toLowerCase();
  const priority = req.query.priority  || '';
  const category = req.query.category  || '';

  if (scope === 'all' && !isLensAdmin(req.user)) {
    return res.status(403).json({ message: 'HR / admin only for scope=all' });
  }

  try {
    const pool = await getAppPool();
    const r = pool.request().input('uid', sql.Int, req.user.id);
    const where = [];
    if (scope === 'mine')     where.push('T.UserId = @uid');
    if (scope === 'assigned') where.push('T.AssignedToUserId = @uid');
    if (status)               { r.input('st', sql.NVarChar(20),  status);   where.push('T.Status = @st'); }
    if (priority)             { r.input('pr', sql.NVarChar(10),  priority); where.push('T.Priority = @pr'); }
    if (category)             { r.input('ct', sql.NVarChar(50),  category); where.push('T.Category = @ct'); }

    const result = await r.query(`
      SELECT
        T.TicketId, T.TicketNo, T.Category, T.Subject, T.Priority, T.Status,
        T.CreatedAt, T.UpdatedAt, T.ResolvedAt, T.ClosedAt,
        T.UserId,    UR.Name AS RaiserName,    UR.Email AS RaiserEmail,
        T.AssignedToUserId, UA.Name AS AssigneeName,
        (SELECT COUNT(*) FROM HRM_Helpdesk_Comment    C WHERE C.TicketId = T.TicketId) AS CommentsCount,
        (SELECT COUNT(*) FROM HRM_Helpdesk_Attachment A WHERE A.TicketId = T.TicketId AND A.IsArchived = 0) AS AttachmentsCount
      FROM HRM_Helpdesk_Ticket T
      LEFT JOIN User_Login UR ON UR.Id = T.UserId
      LEFT JOIN User_Login UA ON UA.Id = T.AssignedToUserId
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY T.CreatedAt DESC
    `);
    res.json({ tickets: result.recordset });
  } catch (err) {
    console.error('[helpdesk/tickets]', err);
    res.status(500).json({ message: 'Failed to list tickets', error: err.message });
  }
});

// ── POST /tickets ────────────────────────────────────────────────────────────
router.post('/tickets', authenticate, async (req, res) => {
  const b = req.body || {};
  const category    = String(b.category    || '').trim();
  const subject     = String(b.subject     || '').trim();
  const description = String(b.description || '').trim();
  const priority    = String(b.priority    || 'Medium').trim();

  if (!category    || !CATEGORIES.includes(category)) return res.status(400).json({ message: 'Invalid category' });
  if (!subject)                                       return res.status(400).json({ message: 'Subject is required' });
  if (!PRIORITIES.includes(priority))                 return res.status(400).json({ message: 'Invalid priority' });

  try {
    const pool = await getAppPool();
    const result = await pool.request()
      .input('uid',  sql.Int,           req.user.id)
      .input('uc',   sql.NVarChar(50),  req.user.username || null)
      .input('cat',  sql.NVarChar(50),  category)
      .input('sub',  sql.NVarChar(200), subject)
      .input('desc', sql.NVarChar(sql.MAX), description || null)
      .input('pri',  sql.NVarChar(10),  priority)
      .query(`
        INSERT INTO HRM_Helpdesk_Ticket (UserId, UserCode, Category, Subject, Description, Priority, Status)
        OUTPUT INSERTED.TicketId, INSERTED.CreatedAt
        VALUES (@uid, @uc, @cat, @sub, @desc, @pri, 'open');
      `);
    const { TicketId, CreatedAt } = result.recordset[0];
    const ticketNo = buildTicketNo(TicketId, CreatedAt);
    await pool.request()
      .input('id', sql.Int, TicketId)
      .input('tn', sql.NVarChar(20), ticketNo)
      .query('UPDATE HRM_Helpdesk_Ticket SET TicketNo = @tn WHERE TicketId = @id');

    res.status(201).json({ ticketId: TicketId, ticketNo });
  } catch (err) {
    console.error('[helpdesk/create]', err);
    res.status(500).json({ message: 'Failed to create ticket', error: err.message });
  }
});

// ── GET /tickets/:id — full detail ───────────────────────────────────────────
router.get('/tickets/:id', authenticate, async (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ message: 'Invalid ticket id' });
  try {
    const pool = await getAppPool();
    const meta = await loadTicketForUser(pool, ticketId, req.user);
    if (!meta.row)    return res.status(404).json({ message: 'Ticket not found' });
    if (!meta.canRead) return res.status(403).json({ message: 'Not allowed to view this ticket' });

    const t = meta.row;

    // Attach raiser + assignee names
    const u = await pool.request()
      .input('uid', sql.Int, t.UserId)
      .input('aid', sql.Int, t.AssignedToUserId || 0)
      .query(`
        SELECT R.Name AS RaiserName, R.Email AS RaiserEmail,
               A.Name AS AssigneeName, A.Email AS AssigneeEmail
        FROM (SELECT 1 AS x) D
        LEFT JOIN User_Login R ON R.Id = @uid
        LEFT JOIN User_Login A ON A.Id = @aid;
      `);
    const ux = u.recordset[0] || {};

    // Comments — hide internal from raiser
    const showInternal = meta.canEditAsHr;
    const cQ = await pool.request()
      .input('id', sql.Int, ticketId)
      .input('hideInt', sql.Bit, showInternal ? 0 : 1)
      .query(`
        SELECT C.CommentId, C.UserId, U.Name AS AuthorName, U.Role AS AuthorRole,
               C.Body, C.IsInternal, C.CreatedAt
        FROM HRM_Helpdesk_Comment C
        LEFT JOIN User_Login U ON U.Id = C.UserId
        WHERE C.TicketId = @id
          AND (@hideInt = 0 OR C.IsInternal = 0)
        ORDER BY C.CreatedAt ASC, C.CommentId ASC;
      `);

    // Attachments
    const aQ = await pool.request()
      .input('id', sql.Int, ticketId)
      .query(`
        SELECT AttachmentId, FileName, MimeType, FileSize, UploadedBy, UploadedAt, IsArchived
        FROM HRM_Helpdesk_Attachment
        WHERE TicketId = @id AND IsArchived = 0
        ORDER BY UploadedAt DESC;
      `);

    res.json({
      ticket: {
        ...t,
        RaiserName:    ux.RaiserName    || null,
        RaiserEmail:   ux.RaiserEmail   || null,
        AssigneeName:  ux.AssigneeName  || null,
        AssigneeEmail: ux.AssigneeEmail || null,
      },
      comments:    cQ.recordset,
      attachments: aQ.recordset,
      viewer: {
        canEditAsHr:   meta.canEditAsHr,
        canActAsOwner: meta.canActAsOwner,
      },
    });
  } catch (err) {
    console.error('[helpdesk/detail]', err);
    res.status(500).json({ message: 'Failed to load ticket', error: err.message });
  }
});

// ── PATCH /tickets/:id ───────────────────────────────────────────────────────
// HR can change anything (status, assignee, priority, category, resolution).
// Raiser can only: close after resolved, or reopen after resolved.
router.patch('/tickets/:id', authenticate, async (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ message: 'Invalid ticket id' });
  const b = req.body || {};

  try {
    const pool = await getAppPool();
    const meta = await loadTicketForUser(pool, ticketId, req.user);
    if (!meta.row)     return res.status(404).json({ message: 'Ticket not found' });
    if (!meta.canRead) return res.status(403).json({ message: 'Not allowed' });

    const isHr    = meta.canEditAsHr;
    const isOwner = meta.canActAsOwner;
    const old     = meta.row;

    // Build patchset based on role
    const sets = [];
    const r = pool.request().input('id', sql.Int, ticketId);

    if (isHr) {
      if (b.category != null) {
        if (!CATEGORIES.includes(b.category)) return res.status(400).json({ message: 'Invalid category' });
        r.input('cat', sql.NVarChar(50), b.category); sets.push('Category = @cat');
      }
      if (b.priority != null) {
        if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ message: 'Invalid priority' });
        r.input('pri', sql.NVarChar(10), b.priority); sets.push('Priority = @pri');
      }
      if (b.subject != null) {
        r.input('sub', sql.NVarChar(200), String(b.subject)); sets.push('Subject = @sub');
      }
      if (b.assignedToUserId !== undefined) {
        const aid = b.assignedToUserId == null || b.assignedToUserId === '' ? null : parseInt(b.assignedToUserId, 10);
        r.input('aid', sql.Int, aid);
        sets.push('AssignedToUserId = @aid');
        sets.push('AssignedAt = CASE WHEN @aid IS NULL THEN NULL ELSE COALESCE(AssignedAt, SYSDATETIME()) END');
      }
      if (b.resolution !== undefined) {
        r.input('res', sql.NVarChar(sql.MAX), b.resolution || null);
        sets.push('Resolution = @res');
      }
    }

    // Status transitions
    if (b.status != null) {
      const ns = String(b.status).toLowerCase();
      if (!STATUSES.includes(ns)) return res.status(400).json({ message: 'Invalid status' });

      const allowed =
        isHr
          ? true                                              // HR can move anywhere
          : (isOwner && (
              (old.Status === 'resolved' && (ns === 'closed' || ns === 'in-progress')) ||
              (old.Status === 'closed'   && ns === 'open')   // reopen a closed ticket
            ));
      if (!allowed) return res.status(403).json({ message: `Not allowed to move from ${old.Status} to ${ns}` });

      r.input('st', sql.NVarChar(20), ns);
      sets.push('Status = @st');

      if (ns === 'resolved') {
        r.input('rsb', sql.Int, req.user.id);
        sets.push('ResolvedByUserId = @rsb', 'ResolvedAt = SYSDATETIME()');
      }
      if (ns === 'closed') {
        r.input('clb', sql.Int, req.user.id);
        sets.push('ClosedByUserId = @clb', 'ClosedAt = SYSDATETIME()');
      }
      if (ns === 'open' || ns === 'in-progress') {
        sets.push('ResolvedAt = NULL', 'ResolvedByUserId = NULL', 'ClosedAt = NULL', 'ClosedByUserId = NULL');
      }
    }

    if (!sets.length) return res.json({ ok: true, noChanges: true });
    sets.push('UpdatedAt = SYSDATETIME()');

    await r.query(`UPDATE HRM_Helpdesk_Ticket SET ${sets.join(', ')} WHERE TicketId = @id`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[helpdesk/patch]', err);
    res.status(500).json({ message: 'Failed to update ticket', error: err.message });
  }
});

// ── POST /tickets/:id/comments ───────────────────────────────────────────────
router.post('/tickets/:id/comments', authenticate, async (req, res) => {
  const ticketId   = parseInt(req.params.id, 10);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ message: 'Invalid ticket id' });
  const body       = String((req.body && req.body.body) || '').trim();
  const isInternal = !!(req.body && req.body.isInternal);
  if (!body) return res.status(400).json({ message: 'Comment body is required' });

  try {
    const pool = await getAppPool();
    const meta = await loadTicketForUser(pool, ticketId, req.user);
    if (!meta.row)     return res.status(404).json({ message: 'Ticket not found' });
    if (!meta.canRead) return res.status(403).json({ message: 'Not allowed' });
    if (isInternal && !meta.canEditAsHr) {
      return res.status(403).json({ message: 'Only HR can post internal comments' });
    }

    const r = await pool.request()
      .input('tid', sql.Int, ticketId)
      .input('uid', sql.Int, req.user.id)
      .input('body', sql.NVarChar(sql.MAX), body)
      .input('intl', sql.Bit, isInternal ? 1 : 0)
      .query(`
        INSERT INTO HRM_Helpdesk_Comment (TicketId, UserId, Body, IsInternal)
        OUTPUT INSERTED.CommentId, INSERTED.CreatedAt
        VALUES (@tid, @uid, @body, @intl);
        UPDATE HRM_Helpdesk_Ticket SET UpdatedAt = SYSDATETIME() WHERE TicketId = @tid;
      `);
    res.status(201).json({ comment: r.recordset[0] });
  } catch (err) {
    console.error('[helpdesk/comment]', err);
    res.status(500).json({ message: 'Failed to add comment', error: err.message });
  }
});

// ── POST /tickets/:id/attachments ────────────────────────────────────────────
router.post('/tickets/:id/attachments', authenticate, (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  if (!Number.isFinite(ticketId)) return res.status(400).json({ message: 'Invalid ticket id' });

  upload.array('files', 5)(req, res, async (err) => {
    if (err) return res.status(400).json({ message: 'Upload failed', error: err.message });
    try {
      const pool = await getAppPool();
      const meta = await loadTicketForUser(pool, ticketId, req.user);
      if (!meta.row) {
        // best-effort cleanup
        (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
        return res.status(404).json({ message: 'Ticket not found' });
      }
      if (!meta.canRead) {
        (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
        return res.status(403).json({ message: 'Not allowed' });
      }

      const files = req.files || [];
      const saved = [];
      for (const f of files) {
        const r = await pool.request()
          .input('tid',  sql.Int, ticketId)
          .input('name', sql.NVarChar(255), f.originalname)
          .input('stn',  sql.NVarChar(300), f.filename)
          .input('stp',  sql.NVarChar(600), f.path)
          .input('mime', sql.NVarChar(150), f.mimetype || null)
          .input('size', sql.BigInt, f.size || 0)
          .input('uby',  sql.Int, req.user.id)
          .query(`
            INSERT INTO HRM_Helpdesk_Attachment (TicketId, FileName, StoredName, StoredPath, MimeType, FileSize, UploadedBy)
            OUTPUT INSERTED.AttachmentId, INSERTED.FileName, INSERTED.MimeType, INSERTED.FileSize, INSERTED.UploadedAt
            VALUES (@tid, @name, @stn, @stp, @mime, @size, @uby);
          `);
        saved.push(r.recordset[0]);
      }
      await pool.request().input('id', sql.Int, ticketId)
        .query('UPDATE HRM_Helpdesk_Ticket SET UpdatedAt = SYSDATETIME() WHERE TicketId = @id');
      res.status(201).json({ attachments: saved });
    } catch (e) {
      console.error('[helpdesk/attachments]', e);
      res.status(500).json({ message: 'Failed to save attachments', error: e.message });
    }
  });
});

// ── GET /tickets/:id/attachments/:attId — download ───────────────────────────
router.get('/tickets/:id/attachments/:attId', authenticate, async (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  const attId    = parseInt(req.params.attId, 10);
  if (!Number.isFinite(ticketId) || !Number.isFinite(attId)) {
    return res.status(400).json({ message: 'Invalid ids' });
  }
  try {
    const pool = await getAppPool();
    const meta = await loadTicketForUser(pool, ticketId, req.user);
    if (!meta.row)     return res.status(404).json({ message: 'Ticket not found' });
    if (!meta.canRead) return res.status(403).json({ message: 'Not allowed' });

    const a = await pool.request()
      .input('id', sql.Int, attId)
      .input('tid', sql.Int, ticketId)
      .query(`
        SELECT FileName, StoredPath, MimeType, IsArchived
        FROM HRM_Helpdesk_Attachment
        WHERE AttachmentId = @id AND TicketId = @tid;
      `);
    const att = a.recordset[0];
    if (!att || att.IsArchived) return res.status(404).json({ message: 'File not found' });
    if (!fs.existsSync(att.StoredPath)) return res.status(410).json({ message: 'File missing on disk' });
    if (att.MimeType) res.setHeader('Content-Type', att.MimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${att.FileName.replace(/"/g,'')}"`);
    fs.createReadStream(att.StoredPath).pipe(res);
  } catch (err) {
    console.error('[helpdesk/download]', err);
    res.status(500).json({ message: 'Download failed', error: err.message });
  }
});

module.exports = router;
