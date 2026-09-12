// =====================================================================
// modules/hr/routes/documents.js — Document Center (Phase 4E)
// Mounted at /api/hr/documents/* by ../index.js
//
// Distinct from /hr/employees/:id/documents (Phase 3D) which holds
// per-employee personal files. This route is the company-wide library
// of policies / forms / handbooks visible to everyone.
//
// Endpoints:
//   GET    /options              — categories list
//   GET    /                     — list (?category=, ?q= search, ?archived=true for HR)
//   POST   /                     — upload (HR-only, multipart field 'file')
//   GET    /:id/download         — auth-gated streaming download (everyone)
//   PATCH  /:id                  — update metadata (HR-only)
//   DELETE /:id                  — soft-archive (HR-only)
// =====================================================================

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');

const CATEGORIES = ['policy', 'form', 'handbook', 'announcement', 'other'];

// ── Storage ──────────────────────────────────────────────────────────────────
const UPLOAD_ROOT = path.join(__dirname, '..', '..', '..', 'uploads', 'hr', 'documents-center');
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch (_) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_ROOT),
    filename:    (req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safe  = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${stamp}_${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },   // 25 MB cap (bigger than personal docs since policy PDFs can be larger)
});

// ── GET /options ─────────────────────────────────────────────────────────────
router.get('/options', authenticate, (req, res) => {
  res.json({ categories: CATEGORIES });
});

// ── GET / — list ─────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const category  = (req.query.category || '').trim().toLowerCase();
    const q         = (req.query.q        || '').trim();
    const archived  = req.query.archived === 'true';

    // Only HR can see archived docs
    if (archived && !isLensAdmin(req.user)) {
      return res.status(403).json({ message: 'HR / admin only for archived docs' });
    }

    const pool = await getAppPool();
    const r = pool.request();
    // Prefix EVERY column with D. — User_Login U also has IsActive, which
    // makes an unprefixed reference ambiguous (SQL error 209).
    const where = [archived ? 'D.IsActive = 0' : 'D.IsActive = 1'];
    if (category && CATEGORIES.includes(category)) {
      r.input('cat', sql.NVarChar(30), category);
      where.push('D.Category = @cat');
    }
    if (q) {
      r.input('q', sql.NVarChar(200), '%' + q + '%');
      where.push('(D.Title LIKE @q OR ISNULL(D.Description, \'\') LIKE @q OR D.FileName LIKE @q)');
    }

    const result = await r.query(`
      SELECT D.DocumentId, D.Category, D.Title, D.Description,
             D.FileName, D.MimeType, D.FileSize,
             D.IsPinned, D.IsActive,
             D.UploadedBy, D.UploadedAt, D.UpdatedAt,
             U.Name AS UploaderName
      FROM HRM_Document D
      LEFT JOIN User_Login U ON U.Id = D.UploadedBy
      WHERE ${where.join(' AND ')}
      ORDER BY D.IsPinned DESC, D.UploadedAt DESC;
    `);
    res.json({ documents: result.recordset, isHr: isLensAdmin(req.user) });
  } catch (err) {
    console.error('[documents/list]', err);
    res.status(500).json({ message: 'Failed to list documents', error: err.message });
  }
});

// ── POST / — upload (HR-only) ────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  upload.single('file')(req, res, async (err) => {
    if (err)         return res.status(400).json({ message: 'Upload failed', error: err.message });
    if (!req.file)   return res.status(400).json({ message: 'No file provided' });
    const f = req.file;
    const category    = (req.body.category    || 'other').trim().toLowerCase();
    const title       = (req.body.title       || '').trim() || f.originalname;
    const description = (req.body.description || '').trim();
    const pinned      = req.body.isPinned === 'true' || req.body.isPinned === true;

    if (!CATEGORIES.includes(category)) {
      try { fs.unlinkSync(f.path); } catch (_) {}
      return res.status(400).json({ message: 'Invalid category' });
    }

    try {
      const pool = await getAppPool();
      const r = await pool.request()
        .input('cat',  sql.NVarChar(30),     category)
        .input('tt',   sql.NVarChar(200),    title.slice(0, 200))
        .input('desc', sql.NVarChar(sql.MAX), description || null)
        .input('fn',   sql.NVarChar(255),    f.originalname)
        .input('sn',   sql.NVarChar(300),    f.filename)
        .input('sp',   sql.NVarChar(600),    f.path)
        .input('mt',   sql.NVarChar(150),    f.mimetype || null)
        .input('sz',   sql.BigInt,           f.size || 0)
        .input('pin',  sql.Bit,              pinned ? 1 : 0)
        .input('uby',  sql.Int,              req.user.id)
        .query(`
          INSERT INTO HRM_Document
            (Category, Title, Description, FileName, StoredName, StoredPath, MimeType, FileSize, IsPinned, UploadedBy)
          OUTPUT INSERTED.DocumentId, INSERTED.UploadedAt
          VALUES (@cat, @tt, @desc, @fn, @sn, @sp, @mt, @sz, @pin, @uby);
        `);
      res.status(201).json({ document: r.recordset[0] });
    } catch (e) {
      // Try to clean up the orphan file if DB write failed
      try { fs.unlinkSync(f.path); } catch (_) {}
      console.error('[documents/upload]', e);
      res.status(500).json({ message: 'Failed to save document', error: e.message });
    }
  });
});

// ── GET /:id/download — stream file (everyone) ───────────────────────────────
router.get('/:id/download', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id).query(`
      SELECT Title, FileName, StoredPath, MimeType, IsActive
      FROM HRM_Document WHERE DocumentId = @id;
    `);
    const d = r.recordset[0];
    if (!d)                                            return res.status(404).json({ message: 'Document not found' });
    if (!d.IsActive && !isLensAdmin(req.user))         return res.status(404).json({ message: 'Document not found' });
    if (!fs.existsSync(d.StoredPath))                  return res.status(410).json({ message: 'File missing on disk' });
    if (d.MimeType) res.setHeader('Content-Type', d.MimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${(d.FileName || 'document').replace(/"/g, '')}"`);
    fs.createReadStream(d.StoredPath).pipe(res);
  } catch (err) {
    console.error('[documents/download]', err);
    res.status(500).json({ message: 'Download failed', error: err.message });
  }
});

// ── PATCH /:id — metadata update (HR-only) ───────────────────────────────────
router.patch('/:id', authenticate, async (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const b = req.body || {};

  try {
    const pool = await getAppPool();
    const r = pool.request().input('id', sql.Int, id);
    const sets = [];
    if (b.title != null) {
      r.input('tt', sql.NVarChar(200), String(b.title).slice(0, 200));
      sets.push('Title = @tt');
    }
    if (b.description !== undefined) {
      r.input('desc', sql.NVarChar(sql.MAX), b.description || null);
      sets.push('Description = @desc');
    }
    if (b.category != null) {
      const c = String(b.category).toLowerCase();
      if (!CATEGORIES.includes(c)) return res.status(400).json({ message: 'Invalid category' });
      r.input('cat', sql.NVarChar(30), c);
      sets.push('Category = @cat');
    }
    if (b.isPinned !== undefined) {
      r.input('pin', sql.Bit, b.isPinned ? 1 : 0);
      sets.push('IsPinned = @pin');
    }
    if (b.isActive !== undefined) {
      r.input('act', sql.Bit, b.isActive ? 1 : 0);
      sets.push('IsActive = @act');
    }
    if (!sets.length) return res.json({ ok: true, noChanges: true });
    sets.push('UpdatedAt = SYSDATETIME()');
    await r.query(`UPDATE HRM_Document SET ${sets.join(', ')} WHERE DocumentId = @id;`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[documents/patch]', err);
    res.status(500).json({ message: 'Failed to update', error: err.message });
  }
});

// ── DELETE /:id — soft-archive (HR-only) ─────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, id)
      .query('UPDATE HRM_Document SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE DocumentId = @id;');
    res.json({ ok: true });
  } catch (err) {
    console.error('[documents/delete]', err);
    res.status(500).json({ message: 'Failed to archive', error: err.message });
  }
});

module.exports = router;
