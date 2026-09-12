// =====================================================================
// modules/hr/routes/letters.js — Letter Generation (Phase 6C)
// Mounted at /api/hr/letters/* by ../index.js
//
// All endpoints HR-only.
//
// Templates:
//   GET    /placeholders                — list of supported {{placeholders}}
//   GET    /templates                   — list active (?archived=true for HR)
//   POST   /templates                   — create
//   GET    /templates/:id               — detail
//   PATCH  /templates/:id               — update
//   DELETE /templates/:id               — soft archive
//
// Generation:
//   POST   /preview                     — { templateId, forUserId, extras? } → resolved body (no DB write)
//   POST   /generate                    — { templateId, forUserId, extras?, notes? } → persists + returns LetterId
//   GET    /issued?forUserId=&fromDate=&toDate=  — list issued letters
//   GET    /issued/:id                  — detail (header + body)
//   GET    /issued/:id/pdf              — stream PDF
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');
const { resolvePlaceholders, resolveSubject, streamLetterPdf } = require('../../../services/letterPdf');

// Placeholders fall into three groups (the frontend picks the right input
// type based on these flags):
//   • DB-resolved only             — pulled from User_Login / HRM_Employee /
//                                    HRM_Employee_Salary; no UI input
//   • overridable: true            — DB-resolved BUT HR can override in the
//                                    UI (useful for new hires whose DOJ isn't
//                                    in DB yet, or for letters that need a
//                                    different CTC than what's stored)
//   • userInput: true              — pure user-supplied (no DB lookup)
// The frontend renders an input for every placeholder that appears in the
// template body AND has either flag. Blank = fall back to DB. Posted as
// `extras` to /preview + /generate; the backend spreads extras over the
// DB-resolved map so non-empty extras win.
const PLACEHOLDERS = [
  { key: 'EmpName',          desc: 'Full name from User_Login' },
  { key: 'EmpCode',          desc: 'HRM_Employee.EmpCode' },
  { key: 'Designation',      desc: 'Current designation',                                  overridable: true, type: 'text' },
  { key: 'Department',       desc: 'Current department',                                   overridable: true, type: 'text' },
  { key: 'Location',         desc: 'Office location',                                      overridable: true, type: 'text' },
  { key: 'DateOfJoining',    desc: 'DD-MM-YYYY',                                           overridable: true, type: 'date' },
  { key: 'ConfirmationDate', desc: 'DD-MM-YYYY',                                           overridable: true, type: 'date' },
  { key: 'LastWorkingDay',   desc: 'DD-MM-YYYY (for experience letters)',                  overridable: true, type: 'date' },
  { key: 'PAN',              desc: 'PAN number' },
  { key: 'Email',            desc: 'Office email' },
  { key: 'Mobile',           desc: 'Mobile number' },
  { key: 'AnnualCTC',        desc: 'Current annual CTC (Indian formatted, no symbol)',    overridable: true, type: 'number' },
  { key: 'MonthlyGross',     desc: 'Current monthly gross',                                overridable: true, type: 'number' },
  { key: 'Today',            desc: 'Generation date (DD-MM-YYYY)' },
  { key: 'TodayLong',        desc: 'Generation date (DD MonthName YYYY)' },
  { key: 'Salutation',       desc: 'Mr. / Ms. derived from Gender' },

  // ── User-supplied (HR types in the value while generating) ─────────────
  { key: 'FromDate',         desc: 'User-supplied start date (DD-MM-YYYY)',                userInput: true, type: 'date' },
  { key: 'ToDate',           desc: 'User-supplied end date (DD-MM-YYYY)',                  userInput: true, type: 'date' },
  { key: 'Reason',           desc: 'User-supplied free text reason',                       userInput: true, type: 'text' },
  { key: 'Amount',           desc: 'User-supplied amount (number, no symbol)',             userInput: true, type: 'number' },
  { key: 'NewDesignation',   desc: 'User-supplied new designation (promotion / increment)', userInput: true, type: 'text' },
  { key: 'NewCTC',           desc: 'User-supplied new annual CTC',                         userInput: true, type: 'number' },
  { key: 'EffectiveDate',    desc: 'User-supplied effective date (DD-MM-YYYY)',            userInput: true, type: 'date' },
  { key: 'Notes',            desc: 'User-supplied free text notes',                        userInput: true, type: 'textarea' },
];

router.use(authenticate);
router.use((req, res, next) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  next();
});

router.get('/placeholders', (req, res) => res.json({ placeholders: PLACEHOLDERS }));

// ─── Templates ───────────────────────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  const archived = req.query.archived === 'true';
  try {
    const pool = await getAppPool();
    // BodyTemplate is included so the Generate UI can scan it client-side
    // for {{X}} user-input placeholders and render the matching inputs.
    const r = await pool.request().query(`
      SELECT TemplateId, Code, Name, Category, Subject, BodyTemplate,
             IsActive, CreatedAt, UpdatedAt,
             (SELECT COUNT(*) FROM HRM_Letter_Issued WHERE TemplateId = T.TemplateId) AS IssuedCount
      FROM HRM_Letter_Template T
      WHERE IsActive = ${archived ? 0 : 1}
      ORDER BY Category, Name;
    `);
    res.json({ templates: r.recordset });
  } catch (e) { console.error('[letters/templates]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.post('/templates', async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  const name = String(b.name || '').trim();
  if (!code) return res.status(400).json({ message: 'Code is required' });
  if (!name) return res.status(400).json({ message: 'Name is required' });
  if (!b.bodyTemplate || !String(b.bodyTemplate).trim()) return res.status(400).json({ message: 'Body is required' });
  try {
    const pool = await getAppPool();
    const r = await pool.request()
      .input('cd',   sql.NVarChar(40),  code)
      .input('nm',   sql.NVarChar(150), name)
      .input('cat',  sql.NVarChar(30),  (b.category || 'general').toLowerCase())
      .input('subj', sql.NVarChar(200), b.subject || null)
      .input('body', sql.NVarChar(sql.MAX), b.bodyTemplate)
      .input('sig',  sql.NVarChar(sql.MAX), b.signatureBlock || null)
      .input('cb',   sql.Int,           req.user.id)
      .query(`
        INSERT INTO HRM_Letter_Template (Code, Name, Category, Subject, BodyTemplate, SignatureBlock, CreatedBy)
        OUTPUT INSERTED.TemplateId
        VALUES (@cd, @nm, @cat, @subj, @body, @sig, @cb);
      `);
    res.status(201).json({ templateId: r.recordset[0].TemplateId });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE'))
      return res.status(409).json({ message: 'Template code already exists' });
    console.error('[letters/create]', e);
    res.status(500).json({ message: 'Failed', error: e.message });
  }
});

router.get('/templates/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM HRM_Letter_Template WHERE TemplateId = @id;');
    if (!r.recordset.length) return res.status(404).json({ message: 'Not found' });
    res.json({ template: r.recordset[0] });
  } catch (e) { console.error('[letters/get]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.patch('/templates/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  const b = req.body || {};
  try {
    const pool = await getAppPool();
    const r = pool.request().input('id', sql.Int, id);
    const sets = [];
    if (b.name        != null) { r.input('nm',   sql.NVarChar(150), String(b.name)); sets.push('Name = @nm'); }
    if (b.category    != null) { r.input('cat',  sql.NVarChar(30),  String(b.category).toLowerCase()); sets.push('Category = @cat'); }
    if (b.subject     !== undefined) { r.input('subj', sql.NVarChar(200), b.subject || null); sets.push('Subject = @subj'); }
    if (b.bodyTemplate != null) { r.input('body', sql.NVarChar(sql.MAX), String(b.bodyTemplate)); sets.push('BodyTemplate = @body'); }
    if (b.signatureBlock !== undefined) { r.input('sig',  sql.NVarChar(sql.MAX), b.signatureBlock || null); sets.push('SignatureBlock = @sig'); }
    if (b.isActive    !== undefined) { r.input('act',  sql.Bit, b.isActive ? 1 : 0); sets.push('IsActive = @act'); }
    if (!sets.length) return res.json({ ok: true, noChanges: true });
    sets.push('UpdatedAt = SYSDATETIME()');
    await r.query(`UPDATE HRM_Letter_Template SET ${sets.join(', ')} WHERE TemplateId = @id;`);
    res.json({ ok: true });
  } catch (e) { console.error('[letters/patch]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.delete('/templates/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    await pool.request().input('id', sql.Int, id)
      .query('UPDATE HRM_Letter_Template SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE TemplateId = @id;');
    res.json({ ok: true });
  } catch (e) { console.error('[letters/delete]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ─── Preview + Generate ──────────────────────────────────────────────────────
async function loadTemplate(pool, templateId) {
  const r = await pool.request().input('id', sql.Int, templateId)
    .query('SELECT * FROM HRM_Letter_Template WHERE TemplateId = @id AND IsActive = 1;');
  return r.recordset[0];
}

router.post('/preview', async (req, res) => {
  const b = req.body || {};
  const templateId = parseInt(b.templateId, 10);
  const forUserId  = parseInt(b.forUserId, 10);
  if (!Number.isFinite(templateId) || !Number.isFinite(forUserId))
    return res.status(400).json({ message: 'templateId + forUserId required' });
  try {
    const pool = await getAppPool();
    const tmpl = await loadTemplate(pool, templateId);
    if (!tmpl) return res.status(404).json({ message: 'Template not found' });
    const { renderedBody, employeeContext, unresolved } = await resolvePlaceholders(pool, tmpl.BodyTemplate, forUserId, b.extras || {});
    const subject = await resolveSubject(pool, tmpl.Subject, forUserId, b.extras || {});
    res.json({
      subject,
      renderedBody,
      signatureBlock: tmpl.SignatureBlock,
      employeeContext,
      unresolved,
    });
  } catch (e) { console.error('[letters/preview]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.post('/generate', async (req, res) => {
  const b = req.body || {};
  const templateId = parseInt(b.templateId, 10);
  const forUserId  = parseInt(b.forUserId, 10);
  if (!Number.isFinite(templateId) || !Number.isFinite(forUserId))
    return res.status(400).json({ message: 'templateId + forUserId required' });
  try {
    const pool = await getAppPool();
    const tmpl = await loadTemplate(pool, templateId);
    if (!tmpl) return res.status(404).json({ message: 'Template not found' });
    const { renderedBody, employeeContext } = await resolvePlaceholders(pool, tmpl.BodyTemplate, forUserId, b.extras || {});
    const subject = await resolveSubject(pool, tmpl.Subject, forUserId, b.extras || {});
    if (!employeeContext) return res.status(404).json({ message: 'Target employee not found' });

    // Insert audit row first (so we have LetterId for the LetterNo)
    const ins = await pool.request()
      .input('tid',  sql.Int,           templateId)
      .input('tcd',  sql.NVarChar(40),  tmpl.Code)
      .input('tnm',  sql.NVarChar(150), tmpl.Name)
      .input('fid',  sql.Int,           forUserId)
      .input('fec',  sql.NVarChar(50),  employeeContext.EmpCode || null)
      .input('fen',  sql.NVarChar(150), employeeContext.UserName || null)
      .input('sub',  sql.NVarChar(300), subject || null)
      .input('body', sql.NVarChar(sql.MAX), renderedBody)
      .input('sig',  sql.NVarChar(sql.MAX), tmpl.SignatureBlock || null)
      .input('nt',   sql.NVarChar(500), b.notes || null)
      .input('ib',   sql.Int,           req.user.id)
      .input('ibn',  sql.NVarChar(150), req.user.name || null)
      .query(`
        INSERT INTO HRM_Letter_Issued
          (TemplateId, TemplateCode, TemplateName, ForUserId, ForEmpCode, ForEmpName,
           Subject, RenderedBody, SignatureBlock, ExtraNotes, IssuedBy, IssuedByName)
        OUTPUT INSERTED.LetterId, INSERTED.IssuedAt
        VALUES (@tid, @tcd, @tnm, @fid, @fec, @fen, @sub, @body, @sig, @nt, @ib, @ibn);
      `);
    const { LetterId, IssuedAt } = ins.recordset[0];
    const letterNo = `LTR-${new Date(IssuedAt).getFullYear()}-${String(LetterId).padStart(4, '0')}`;
    await pool.request().input('id', sql.Int, LetterId).input('no', sql.NVarChar(30), letterNo)
      .query('UPDATE HRM_Letter_Issued SET LetterNo = @no WHERE LetterId = @id;');

    res.status(201).json({ letterId: LetterId, letterNo });
  } catch (e) { console.error('[letters/generate]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

// ─── Issued (history) ────────────────────────────────────────────────────────
router.get('/issued', async (req, res) => {
  const forUserId = parseInt(req.query.forUserId, 10);
  const from      = req.query.fromDate;
  const to        = req.query.toDate;
  try {
    const pool = await getAppPool();
    const r = pool.request();
    const where = ['1=1'];
    if (Number.isFinite(forUserId)) { r.input('uid', sql.Int, forUserId); where.push('ForUserId = @uid'); }
    if (from) { r.input('from', sql.Date, new Date(from)); where.push('IssuedAt >= @from'); }
    if (to)   { r.input('to',   sql.Date, new Date(to));   where.push('IssuedAt <= DATEADD(DAY, 1, @to)'); }
    const result = await r.query(`
      SELECT LetterId, LetterNo, TemplateCode, TemplateName, ForUserId, ForEmpCode, ForEmpName,
             Subject, IssuedBy, IssuedByName, IssuedAt, ExtraNotes
      FROM HRM_Letter_Issued
      WHERE ${where.join(' AND ')}
      ORDER BY IssuedAt DESC;
    `);
    res.json({ letters: result.recordset });
  } catch (e) { console.error('[letters/issued]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.get('/issued/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM HRM_Letter_Issued WHERE LetterId = @id;');
    if (!r.recordset.length) return res.status(404).json({ message: 'Not found' });
    res.json({ letter: r.recordset[0] });
  } catch (e) { console.error('[letters/issued-get]', e); res.status(500).json({ message: 'Failed', error: e.message }); }
});

router.get('/issued/:id/pdf', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const pool = await getAppPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM HRM_Letter_Issued WHERE LetterId = @id;');
    if (!r.recordset.length) return res.status(404).json({ message: 'Not found' });
    const ltr = r.recordset[0];
    const safe = (ltr.LetterNo || ('LTR' + id)).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safe}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    streamLetterPdf({
      letterNo:       ltr.LetterNo,
      subject:        ltr.Subject,
      body:           ltr.RenderedBody,
      signatureBlock: ltr.SignatureBlock,
      issuedByName:   ltr.IssuedByName,
    }, res);
  } catch (e) {
    console.error('[letters/pdf]', e);
    if (!res.headersSent) res.status(500).json({ message: 'Failed', error: e.message });
    else res.end();
  }
});

module.exports = router;
