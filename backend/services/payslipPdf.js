// =====================================================================
// services/payslipPdf.js — Salary Payslip PDF generator (Phase 5B)
//
// Extends the pdfkit pattern from invoicePdf.js. Single A4 page.
//
// Public API:
//   fetchPayslipData(pool, payslipId) → { header, lines, earnings, deductions, totals }
//   streamPayslipPdf(data, res)       → writes PDF to res
//   netPayInWords(amount)             → Indian-system number-to-words (reused by routes/payroll.js
//                                        when freezing payslip header)
// =====================================================================

const PDFDocument = require('pdfkit');

// ─── Date → "DD-MM-YYYY" ──────────────────────────────────────────────────
function fmtD(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return [
    String(dt.getDate()).padStart(2, '0'),
    String(dt.getMonth() + 1).padStart(2, '0'),
    dt.getFullYear(),
  ].join('-');
}
function fmtMonthLabel(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  const MONTH = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${MONTH[dt.getMonth()]} ${dt.getFullYear()}`;
}
function fmtN(n) {
  if (n == null || isNaN(n)) return '0.00';
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n));
}

// ─── Number → words (Indian system, used for "Net Pay in Words") ──────────
const ONES = ['', 'ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINE',
              'TEN','ELEVEN','TWELVE','THIRTEEN','FOURTEEN','FIFTEEN','SIXTEEN',
              'SEVENTEEN','EIGHTEEN','NINETEEN'];
const TENS = ['','','TWENTY','THIRTY','FORTY','FIFTY','SIXTY','SEVENTY','EIGHTY','NINETY'];
function _two(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n/10)] + (n%10 ? ' ' + ONES[n%10] : ''); }
function _three(n) {
  if (n === 0) return '';
  const h = Math.floor(n/100), r = n%100;
  return (h ? ONES[h] + ' HUNDRED' + (r ? ' ' : '') : '') + _two(r);
}
function netPayInWords(amount) {
  if (amount == null || isNaN(amount)) return '';
  const num = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - num) * 100);
  const crore = Math.floor(num / 10000000);
  const lakh  = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const remainder = num % 1000;
  const parts = [];
  if (crore)     parts.push(_two(crore) + ' CRORE');
  if (lakh)      parts.push(_two(lakh)  + ' LAKH');
  if (thousand)  parts.push(_two(thousand) + ' THOUSAND');
  if (remainder) parts.push(_three(remainder));
  if (!parts.length) parts.push('ZERO');
  const paiseWords = paise ? _two(paise) : 'ZERO';
  return `INR ${parts.join(' ')} AND ${paiseWords} PAISE ONLY`;
}

// =====================================================================
// fetchPayslipData(pool, payslipId)
// =====================================================================
async function fetchPayslipData(pool, payslipId) {
  const { sql } = require('../db');
  const hQ = await pool.request().input('id', sql.Int, payslipId).query(`
    SELECT P.*,
           R.FYMonthCode, R.PeriodStart, R.PeriodEnd, R.PayDate, R.MonthNo, R.FYYear, R.Status AS RunStatus
    FROM HRM_Payslip P JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
    WHERE P.PayslipId = @id;
  `);
  const header = hQ.recordset[0];
  if (!header) return null;
  const lQ = await pool.request().input('id', sql.Int, payslipId).query(`
    SELECT ComponentCode, ComponentName, Kind, FullMonthlyAmt, EarnedAmount, FormulaSummary, DisplayOrder
    FROM HRM_Payslip_Line WHERE PayslipId = @id ORDER BY DisplayOrder, ComponentCode;
  `);
  const lines = lQ.recordset || [];
  const earnings   = lines.filter(l => l.Kind === 'Earning');
  const deductions = lines.filter(l => l.Kind === 'Deduction');
  const reimbs     = lines.filter(l => l.Kind === 'Reimbursement');
  return { header, lines, earnings, deductions, reimbs };
}

// =====================================================================
// streamPayslipPdf(data, res)
// =====================================================================
function streamPayslipPdf(data, res) {
  const { header: h, earnings, deductions, reimbs } = data;
  const pdf = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
  pdf.pipe(res);

  const W = pdf.page.width  - 2 * pdf.page.margins.left;
  const M = pdf.page.margins.left;

  // ─── Header band (company name + payslip title) ──────────────────────
  // pdfkit Helvetica's WinAnsi encoding has NO glyphs for ₹ (rupee), → (arrow),
  // − (Unicode minus). Use ASCII fallbacks ("INR", "to", "-") everywhere or
  // alignment breaks because tofu glyphs render with unexpected widths.
  // Left and right blocks get explicit `width` so a long company name or long
  // PayslipNo can't bleed into the other side.
  const HEAD_H = 56;
  const LEFT_W = W * 0.55;          // company info column
  const RIGHT_W = W * 0.43;          // title + payslip-no column
  const RIGHT_X = M + LEFT_W + 10;
  pdf.rect(M, M, W, HEAD_H).fillAndStroke('#1e3a8a', '#1e3a8a');

  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(14)
     .text('Company A Pvt Ltd', M + 14, M + 8, { width: LEFT_W - 14, lineBreak: false, ellipsis: true });
  pdf.font('Helvetica').fontSize(8.5)
     .text('64/2A/6NR-Swami Vivekanand Garden, Lane No. 6,',
           M + 14, M + 26, { width: LEFT_W - 14, lineBreak: false, ellipsis: true });
  pdf.text('Kondhwa Budruk, Pune - 411048',
           M + 14, M + 38, { width: LEFT_W - 14, lineBreak: false, ellipsis: true });

  pdf.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff')
     .text(`Payslip for ${fmtMonthLabel(h.PeriodStart)}`,
           RIGHT_X, M + 10, { width: RIGHT_W - 14, align: 'right', lineBreak: false, ellipsis: true });
  pdf.font('Helvetica').fontSize(8.5).fillColor('#ffffff')
     .text(h.PayslipNo || '—',
           RIGHT_X, M + 30, { width: RIGHT_W - 14, align: 'right', lineBreak: false, ellipsis: true });
  pdf.text('Status: ' + (h.Status || '—').toUpperCase(),
           RIGHT_X, M + 42, { width: RIGHT_W - 14, align: 'right', lineBreak: false });

  pdf.fillColor('#111');

  let y = M + HEAD_H + 14;

  // ─── Employee identity block (fixed-row 2-column grid) ────────────────
  // Each row gets a fixed rowH so the left and right columns stay aligned.
  // No `continued: true` / no reliance on pdf.y — every cell positions itself
  // explicitly. Labels are right-aligned in a fixed 90pt column; values get
  // the remaining width and clip via ellipsis if they overflow.
  const ROW_H        = 15;
  const COL_GUTTER   = 16;
  const colW         = (W - COL_GUTTER) / 2;
  const LBL_W        = 88;
  const VAL_GAP      = 6;
  function kvRow(x, yRow, label, value) {
    pdf.font('Helvetica-Bold').fillColor('#555').fontSize(9)
       .text(label + ':', x, yRow + 2, { width: LBL_W, align: 'right', lineBreak: false });
    pdf.font('Helvetica').fillColor('#111').fontSize(9.5)
       .text(value || '-', x + LBL_W + VAL_GAP, yRow + 2,
             { width: colW - LBL_W - VAL_GAP, lineBreak: false, ellipsis: true });
  }
  const leftItems = [
    ['Name',          h.EmpName || '-'],
    ['Emp Code',      h.EmpCode || '-'],
    ['Designation',   h.Designation || '-'],
    ['Department',    h.Department || '-'],
    ['Date of Joining', fmtD(h.DateOfJoining)],
  ];
  const rightItems = [
    ['Pay Period',    `${fmtD(h.PeriodStart)} to ${fmtD(h.PeriodEnd)}`],
    ['Pay Date',      fmtD(h.PayDate)],
    ['PAN',           h.PAN || '-'],
    ['UAN',           h.UAN || '-'],
    ['Bank A/c',      h.BankAccount ? `${h.BankAccount}${h.IFSC ? ' (' + h.IFSC + ')' : ''}` : '-'],
  ];
  for (let i = 0; i < Math.max(leftItems.length, rightItems.length); i++) {
    const yi = y + i * ROW_H;
    if (leftItems[i])  kvRow(M,                      yi, leftItems[i][0],  leftItems[i][1]);
    if (rightItems[i]) kvRow(M + colW + COL_GUTTER,  yi, rightItems[i][0], rightItems[i][1]);
  }
  y += Math.max(leftItems.length, rightItems.length) * ROW_H + 10;

  // ─── Attendance summary strip ─────────────────────────────────────────
  // Inline format: "Days in Month - 30  |  LOP Days - 0.00  |  ...". Keeps
  // label + value on the same baseline so columns line up regardless of
  // value width (a stacked label-over-value layout overflowed the strip box
  // because pdfkit text height was taller than the 22pt rect).
  const ATT_H = 24;
  pdf.fillColor('#f3f4f6').rect(M, y, W, ATT_H).fill();
  const att = [
    ['Days in Month', String(h.DaysInMonth)],
    ['LOP Days',      Number(h.LopDays).toFixed(2)],
    ['Paid Leaves',   Number(h.PaidLeaveDays).toFixed(2)],
    ['Payable Days',  Number(h.PayableDays).toFixed(2)],
  ];
  const colStep = W / att.length;
  att.forEach(([k, v], i) => {
    const cellX = M + colStep * i;
    pdf.font('Helvetica').fontSize(9).fillColor('#555')
       .text(k + ' - ', cellX + 8, y + 8,
             { width: colStep - 16, continued: true, lineBreak: false });
    pdf.font('Helvetica-Bold').fontSize(10).fillColor('#111')
       .text(String(v), { lineBreak: false });
  });
  y += ATT_H + 10;

  // ─── Earnings | Deductions tables side-by-side ────────────────────────
  const tableW    = (W - 12) / 2;
  const colLabelW = tableW - 90;
  const colAmtW   = 90;

  function drawTable(x, yStart, title, rows, sumColor) {
    let cy = yStart;
    // Header
    pdf.rect(x, cy, tableW, 18).fillAndStroke('#eef2ff', '#c7d2fe');
    pdf.fillColor('#1e3a8a').font('Helvetica-Bold').fontSize(9)
       .text(title, x + 6, cy + 4, { width: colLabelW });
    pdf.text('Amount (INR)', x + colLabelW, cy + 4, { width: colAmtW - 6, align: 'right' });
    cy += 18;
    // Rows
    pdf.font('Helvetica').fillColor('#111').fontSize(9);
    let total = 0;
    rows.forEach((r, i) => {
      const rowH = 16;
      if (i % 2 === 1) { pdf.rect(x, cy, tableW, rowH).fill('#fafafa'); pdf.fillColor('#111'); }
      pdf.text(r.ComponentName, x + 6, cy + 3, { width: colLabelW - 4, height: rowH - 2, ellipsis: true, lineBreak: false });
      pdf.text(fmtN(r.EarnedAmount), x + colLabelW, cy + 3, { width: colAmtW - 6, align: 'right' });
      total += Number(r.EarnedAmount || 0);
      cy += rowH;
    });
    // Empty filler if no rows
    if (!rows.length) {
      pdf.fillColor('#888').font('Helvetica-Oblique')
         .text('— none —', x + 6, cy + 4, { width: tableW - 12, align: 'center' });
      cy += 18;
    }
    // Total
    pdf.rect(x, cy, tableW, 20).fillAndStroke(sumColor, sumColor);
    pdf.fillColor('#fff').font('Helvetica-Bold').fontSize(10);
    pdf.text(title === 'Earnings' ? 'Total Earnings' : 'Total Deductions', x + 6, cy + 5, { width: colLabelW });
    pdf.text(fmtN(total), x + colLabelW, cy + 5, { width: colAmtW - 6, align: 'right' });
    cy += 20;
    return { y: cy, total };
  }

  const eRes = drawTable(M,                     y, 'Earnings',   earnings,   '#16a34a');
  const dRes = drawTable(M + tableW + 12,       y, 'Deductions', deductions, '#dc2626');
  y = Math.max(eRes.y, dRes.y) + 12;

  // ─── Reimbursements (if any) — full-width small strip ─────────────────
  if (reimbs && reimbs.length) {
    pdf.rect(M, y, W, 18).fillAndStroke('#fef3c7', '#fde68a');
    pdf.fillColor('#854d0e').font('Helvetica-Bold').fontSize(9)
       .text('Reimbursements', M + 6, y + 4);
    pdf.fillColor('#111').font('Helvetica').fontSize(9);
    let rTotal = 0;
    let rx = M + 110;
    reimbs.forEach(r => {
      const w = 130;
      pdf.text(r.ComponentName + '  INR ' + fmtN(r.EarnedAmount), rx, y + 4, { width: w });
      rTotal += Number(r.EarnedAmount || 0);
      rx += w;
    });
    pdf.font('Helvetica-Bold').text('Total INR ' + fmtN(rTotal), M, y + 4, { width: W - 12, align: 'right' });
    y += 26;
  }

  // ─── Net Pay box ──────────────────────────────────────────────────────
  // pdfkit's built-in Helvetica has no ₹ glyph (renders as a tofu box and
  // throws subsequent text positioning off). Use the literal "INR " prefix
  // — matches the existing invoicePdf.js convention. The minus character in
  // the "Gross − Deductions = Net" math line was also unsupported; replaced
  // with ASCII "-" to keep the line aligned.
  const boxH = 60;
  pdf.rect(M, y, W, boxH).fillAndStroke('#0f172a', '#0f172a');
  // Left half — big amount
  pdf.fillColor('#cbd5e1').font('Helvetica-Bold').fontSize(10)
     .text('NET PAY', M + 14, y + 10);
  pdf.font('Helvetica-Bold').fontSize(22).fillColor('#22c55e')
     .text('INR ' + fmtN(h.NetPay), M + 14, y + 24, { width: W * 0.45, lineBreak: false });
  // Right half — words + math summary
  const rightX = M + W * 0.46;
  const rightW = W * 0.54 - 14;
  pdf.fillColor('#cbd5e1').font('Helvetica').fontSize(9)
     .text('Amount in Words', rightX, y + 8, { width: rightW, align: 'right' });
  pdf.fillColor('#ffffff').font('Helvetica').fontSize(8.5)
     .text((h.NetPayWords || netPayInWords(h.NetPay)),
           rightX, y + 22, { width: rightW, align: 'right' });
  pdf.fillColor('#94a3b8').font('Helvetica-Oblique').fontSize(8)
     .text(`Gross INR ${fmtN(h.MonthlyGross)} - Deductions INR ${fmtN(h.TotalDeductions)} = Net INR ${fmtN(h.NetPay)}`,
           rightX, y + 44, { width: rightW, align: 'right' });
  y += boxH;

  // ─── Footer ───────────────────────────────────────────────────────────
  pdf.fillColor('#888').font('Helvetica-Oblique').fontSize(8)
     .text('This is a computer-generated payslip. No signature required.',
           M, pdf.page.height - 50, { width: W, align: 'center' });
  pdf.text(`Generated on ${new Date().toLocaleString('en-IN', { hour12: false })}`,
           M, pdf.page.height - 38, { width: W, align: 'center' });

  pdf.end();
}

module.exports = { fetchPayslipData, streamPayslipPdf, netPayInWords };
