// =====================================================================
// services/letterPdf.js — Letter template rendering + PDF gen (Phase 6C)
//
// Public API:
//   resolvePlaceholders(pool, templateBody, forUserId, extras?)
//       → { renderedBody, employeeContext, unresolved[] }
//   resolveSubject(pool, templateSubject, forUserId)  → string
//   streamLetterPdf(data, res)                        → writes PDF to res
//
// Placeholder syntax: {{Name}}. Unknown placeholders are left intact
// (visible in the rendered output as `{{Unknown}}`) so HR notices and
// can either remove them from the template or add the mapping here.
//
// pdfkit Helvetica is used (no ₹ glyph — use "INR" prefix).
// =====================================================================

const PDFDocument = require('pdfkit');

const MONTHS_LONG = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

function fmtD(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return [String(dt.getDate()).padStart(2,'0'), String(dt.getMonth()+1).padStart(2,'0'), dt.getFullYear()].join('-');
}
function fmtLongDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${dt.getDate()} ${MONTHS_LONG[dt.getMonth()]} ${dt.getFullYear()}`;
}
function fmtN(n) {
  if (n == null || isNaN(n)) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Number(n));
}

// ── Placeholder resolver ─────────────────────────────────────────────────────
async function loadEmployeeContext(pool, forUserId) {
  const { sql } = require('../db');
  const r = await pool.request().input('uid', sql.Int, forUserId).query(`
    SELECT TOP 1
      U.Id      AS UserId,
      U.Name    AS UserName,
      U.Email   AS Email,
      E.EmpCode, E.Designation, E.Department, E.Location, E.Gender,
      E.DateOfJoining, E.ConfirmationDate, E.LastWorkingDay, E.PAN,
      E.Mobile,
      ES.CTC          AS AnnualCTC,
      ES.MonthlyGross AS MonthlyGross
    FROM User_Login U
    LEFT JOIN HRM_Employee E ON E.UserId = U.Id
    OUTER APPLY (
      SELECT TOP 1 CTC, MonthlyGross FROM HRM_Employee_Salary
      WHERE UserId = U.Id AND Status = 'active'
      ORDER BY EffectiveFrom DESC
    ) ES
    WHERE U.Id = @uid;
  `);
  return r.recordset[0] || null;
}

function buildPlaceholderMap(ctx, extras) {
  const today = new Date();
  const salutation = (() => {
    const g = String(ctx?.Gender || '').toLowerCase();
    if (g.startsWith('f')) return 'Ms.';
    return 'Mr.';   // default Mr. for Male / Other / blank
  })();
  return {
    EmpName:          ctx?.UserName       || '',
    EmpCode:          ctx?.EmpCode        || '',
    Designation:      ctx?.Designation    || '',
    Department:       ctx?.Department     || '',
    Location:         ctx?.Location       || '',
    DateOfJoining:    fmtD(ctx?.DateOfJoining),
    ConfirmationDate: fmtD(ctx?.ConfirmationDate),
    LastWorkingDay:   fmtD(ctx?.LastWorkingDay),
    PAN:              ctx?.PAN            || '',
    Email:            ctx?.Email          || '',
    Mobile:           ctx?.Mobile         || '',
    AnnualCTC:        fmtN(ctx?.AnnualCTC),
    MonthlyGross:     fmtN(ctx?.MonthlyGross),
    Today:            fmtD(today),
    TodayLong:        fmtLongDate(today),
    Salutation:       salutation,
    ...(extras || {}),
  };
}

function substitute(template, map) {
  if (template == null) return { out: '', unresolved: [] };
  const unresolved = new Set();
  const out = String(template).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(map, key)) return String(map[key] ?? '');
    unresolved.add(key);
    return full;   // leave as-is so HR can spot it
  });
  return { out, unresolved: Array.from(unresolved) };
}

async function resolvePlaceholders(pool, templateBody, forUserId, extras) {
  const ctx = await loadEmployeeContext(pool, forUserId);
  const map = buildPlaceholderMap(ctx, extras);
  const { out, unresolved } = substitute(templateBody, map);
  return { renderedBody: out, employeeContext: ctx, unresolved };
}

async function resolveSubject(pool, templateSubject, forUserId, extras) {
  const ctx = await loadEmployeeContext(pool, forUserId);
  const map = buildPlaceholderMap(ctx, extras);
  return substitute(templateSubject || '', map).out;
}

// ── PDF renderer ─────────────────────────────────────────────────────────────
function streamLetterPdf(data, res) {
  const pdf = new PDFDocument({ size: 'A4', margin: 60 });
  pdf.pipe(res);
  const W = pdf.page.width - 2 * pdf.page.margins.left;
  const M = pdf.page.margins.left;

  // ── Letterhead band ──────────────────────────────────────────────────
  pdf.rect(M, M, W, 70).fillAndStroke('#1e3a8a', '#1e3a8a');
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18)
     .text('Company A Pvt Ltd', M + 14, M + 14, { width: W - 28, lineBreak: false });
  pdf.font('Helvetica').fontSize(9)
     .text('12 Example Industrial Estate, Lane 1, Example Area, City - 000000', M + 14, M + 38, { width: W - 28, lineBreak: false, ellipsis: true });
  pdf.text('PAN: AAAAA0000A | GSTIN: 27AAAAA0000A1Z5 | www.company-a.example', M + 14, M + 52, { width: W - 28, lineBreak: false, ellipsis: true });

  pdf.fillColor('#111');
  let y = M + 86;

  // ── Letter number + Subject ──────────────────────────────────────────
  if (data.letterNo) {
    pdf.font('Helvetica').fontSize(9).fillColor('#555')
       .text(`Ref: ${data.letterNo}`, M, y, { width: W, lineBreak: false });
    y += 16;
  }

  if (data.subject) {
    pdf.font('Helvetica-Bold').fontSize(13).fillColor('#111')
       .text(data.subject, M, y, { width: W, align: 'center', lineBreak: true });
    y = pdf.y + 10;
    // Underline
    pdf.moveTo(M + W * 0.2, y).lineTo(M + W * 0.8, y).lineWidth(0.5).strokeColor('#999').stroke();
    y += 14;
  }

  // ── Body ──────────────────────────────────────────────────────────────
  pdf.font('Helvetica').fontSize(11).fillColor('#111')
     .text(data.body || '', M, y, { width: W, align: 'justify', lineBreak: true });
  y = pdf.y + 30;

  // ── Signature block ──────────────────────────────────────────────────
  if (data.signatureBlock) {
    pdf.font('Helvetica').fontSize(11).fillColor('#111')
       .text(data.signatureBlock, M, y, { width: W, lineBreak: true });
  }

  // ── Footer ────────────────────────────────────────────────────────────
  pdf.fillColor('#888').fontSize(8).font('Helvetica-Oblique')
     .text(`Generated by ${data.issuedByName || 'HR'} on ${new Date().toLocaleString('en-IN', { hour12: false })}`,
           M, pdf.page.height - 40, { width: W, align: 'center' });

  pdf.end();
}

module.exports = {
  loadEmployeeContext,
  resolvePlaceholders,
  resolveSubject,
  streamLetterPdf,
};
