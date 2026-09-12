// =====================================================================
// services/form16Pdf.js — Form 16 Part B generator (Phase 5E)
//
// Generates a simplified Form 16 Part B PDF from the employee's payslip
// data + approved IT declaration items for a given FY. NOT a TRACES-
// certified Part B (that requires NSDL filings + digital signing).
// This is the employee-friendly summary used internally + for tax-filing
// reference. Part A from TRACES is uploaded separately by HR and stored
// in HRM_Form16.PartAStoredPath.
//
// Public API:
//   fetchForm16Data(pool, userId, fyYear) → aggregated numbers (also persists
//                                            into HRM_Form16 on first call)
//   streamForm16PartB(data, res)          → writes PDF to res
// =====================================================================

const PDFDocument = require('pdfkit');
const { computeTax, computeHraExemption, STANDARD_DEDUCTION } = require('./taxEngine');

function fmtN(n) {
  if (n == null || isNaN(n)) return '0.00';
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n));
}

async function fetchForm16Data(pool, userId, fyYear) {
  const { sql } = require('../db');
  const fyStart = new Date(fyYear, 3, 1);
  const fyEnd   = new Date(fyYear + 1, 2, 31);

  // YTD payslip aggregates
  const psQ = await pool.request().input('uid', sql.Int, userId).input('ps', sql.Date, fyStart).input('pe', sql.Date, fyEnd).query(`
    SELECT
      ISNULL(SUM(P.MonthlyGross),0)    AS GrossSalary,
      ISNULL(SUM(P.TotalDeductions),0) AS TotalDeductions,
      ISNULL(SUM(P.NetPay),0)          AS NetPaid,
      COUNT(*) AS MonthsPaid
    FROM HRM_Payslip P JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
    WHERE P.UserId = @uid AND P.Status IN ('locked','paid')
      AND R.PeriodStart BETWEEN @ps AND @pe;
  `);

  // Component-level breakdown
  const compQ = await pool.request().input('uid', sql.Int, userId).input('ps', sql.Date, fyStart).input('pe', sql.Date, fyEnd).query(`
    SELECT L.ComponentCode, MAX(L.ComponentName) AS Name, MAX(L.Kind) AS Kind,
           SUM(L.EarnedAmount) AS YTDAmount
    FROM HRM_Payslip_Line L
    JOIN HRM_Payslip P ON P.PayslipId = L.PayslipId
    JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
    WHERE P.UserId = @uid AND P.Status IN ('locked','paid')
      AND R.PeriodStart BETWEEN @ps AND @pe
    GROUP BY L.ComponentCode
    ORDER BY MAX(L.DisplayOrder), L.ComponentCode;
  `);

  // Employee identity
  const eQ = await pool.request().input('uid', sql.Int, userId).query(`
    SELECT TOP 1 EmpCode, EmpName, Designation, Department, PAN, UAN, DateOfJoining
    FROM HRM_Payslip WHERE UserId = @uid ORDER BY CreatedAt DESC;
  `);
  const emp = eQ.recordset[0] || {};

  // IT declaration (approved deductions)
  const dQ = await pool.request().input('uid', sql.Int, userId).input('fy', sql.Int, fyYear).query(`
    SELECT D.Regime, D.Status,
           ISNULL((SELECT SUM(ISNULL(ApprovedAmount, 0))
                   FROM HRM_IT_Declaration_Item
                   WHERE DeclarationId = D.DeclarationId AND Status = 'approved'), 0) AS ApprovedDeductions
    FROM HRM_IT_Declaration D WHERE D.UserId = @uid AND D.FYYear = @fy;
  `);
  const regime = dQ.recordset[0]?.Regime || 'Old';
  const chapterVIA = dQ.recordset[0]?.ApprovedDeductions || 0;

  // Section-wise breakdown
  const sQ = await pool.request().input('uid', sql.Int, userId).input('fy', sql.Int, fyYear).query(`
    SELECT I.SectionCode, SUM(ISNULL(I.ApprovedAmount, 0)) AS ApprovedAmt
    FROM HRM_IT_Declaration_Item I
    JOIN HRM_IT_Declaration D ON D.DeclarationId = I.DeclarationId
    WHERE D.UserId = @uid AND D.FYYear = @fy AND I.Status = 'approved'
    GROUP BY I.SectionCode;
  `);

  // Compute (Phase 6A: route through services/taxEngine for proper surcharge + cess + 87A)
  const grossSalary = Number(psQ.recordset[0].GrossSalary) || 0;
  const ptDeducted  = compQ.recordset.filter(c => c.ComponentCode === 'PT_MH').reduce((s, c) => s + Number(c.YTDAmount), 0);
  const stdDed      = Math.min(grossSalary, STANDARD_DEDUCTION);

  // Pull HRA exemption: declared rent (HRA section in IT decl) + Basic + HRA component + metro flag
  const hraDeclared = (sQ.recordset.find(r => r.SectionCode === 'HRA')?.ApprovedAmt) || 0;
  const basicAnnual = compQ.recordset.filter(c => c.ComponentCode === 'BASIC').reduce((s, c) => s + Number(c.YTDAmount), 0);
  const hraAnnual   = compQ.recordset.filter(c => c.ComponentCode === 'HRA'  ).reduce((s, c) => s + Number(c.YTDAmount), 0);
  const metroQ = await pool.request().input('uid', sql.Int, userId).query(`
    SELECT TOP 1 ISNULL(IsMetroEmployee,0) AS IsMetro FROM HRM_Employee WHERE UserId = @uid;
  `);
  const isMetro = !!(metroQ.recordset[0]?.IsMetro);
  const hra = computeHraExemption({ rentPaid: hraDeclared, basic: basicAnnual, hraComponent: hraAnnual, isMetro });

  // Chapter VI-A: exclude HRA (it's a Section 10 exemption, not VI-A)
  const chapterVIAExcludingHra = sQ.recordset
    .filter(r => r.SectionCode !== 'HRA')
    .reduce((s, r) => s + Number(r.ApprovedAmt), 0);
  const effChapterVIA = regime === 'New' ? 0 : chapterVIAExcludingHra;
  const effHraExempt  = regime === 'New' ? 0 : hra.exempt;

  const taxableIncome = Math.max(0, grossSalary - stdDed - ptDeducted - effChapterVIA - effHraExempt);
  const taxResult     = computeTax({ taxableIncome, regime });
  const taxOnIncome   = taxResult.totalTax;

  // Upsert HRM_Form16 row
  await pool.request()
    .input('uid', sql.Int, userId).input('fy', sql.Int, fyYear)
    .input('gs', sql.Decimal(15,2), grossSalary)
    .input('sd', sql.Decimal(15,2), stdDed)
    .input('pt', sql.Decimal(15,2), ptDeducted)
    .input('via', sql.Decimal(15,2), effChapterVIA)
    .input('ti', sql.Decimal(15,2), taxableIncome)
    .input('toi', sql.Decimal(15,2), taxOnIncome)
    .input('rg', sql.NVarChar(10), regime)
    .query(`
      MERGE INTO HRM_Form16 AS T
      USING (SELECT @uid AS UserId, @fy AS FYYear) AS S
      ON T.UserId = S.UserId AND T.FYYear = S.FYYear
      WHEN MATCHED THEN UPDATE SET
        GrossSalary = @gs, StandardDeduction = @sd, PTDeducted = @pt,
        ChapterVIA = @via, TaxableIncome = @ti, TaxOnIncome = @toi, Regime = @rg,
        PartBGeneratedAt = SYSDATETIME(), UpdatedAt = SYSDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (UserId, FYYear, GrossSalary, StandardDeduction, PTDeducted,
                ChapterVIA, TaxableIncome, TaxOnIncome, Regime, PartBGeneratedAt)
        VALUES (@uid, @fy, @gs, @sd, @pt, @via, @ti, @toi, @rg, SYSDATETIME());
    `);

  return {
    emp, fyYear, regime,
    grossSalary, ptDeducted, stdDed, chapterVIA: effChapterVIA, taxableIncome, taxOnIncome,
    hraExemption: effHraExempt, hraDetails: hra, isMetro,
    taxBreakdown: taxResult,    // baseTax, rebate87A, surcharge, cess, totalTax, slabs
    monthsPaid: psQ.recordset[0].MonthsPaid,
    componentBreakdown: compQ.recordset,
    sectionBreakdown:   sQ.recordset,
    declarationStatus:  dQ.recordset[0]?.Status || 'none',
  };
}

function streamForm16PartB(data, res) {
  const pdf = new PDFDocument({ size: 'A4', margin: 40 });
  pdf.pipe(res);
  const W = pdf.page.width - 2 * pdf.page.margins.left;
  const M = pdf.page.margins.left;

  // ── Title band ───────────────────────────────────────────────────────
  pdf.rect(M, M, W, 56).fillAndStroke('#1e3a8a', '#1e3a8a');
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(15)
     .text('FORM NO. 16 — Part B', M + 14, M + 8);
  pdf.font('Helvetica').fontSize(9)
     .text('Certificate under Section 203 of the Income-tax Act, 1961 (internal summary — refer to TRACES Part A for official figures)',
           M + 14, M + 28, { width: W - 28 });
  pdf.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
     .text(`FY ${data.fyYear}-${String((data.fyYear+1)%100).padStart(2,'0')}`, M + 14, M + 12, { width: W - 28, align: 'right' });
  pdf.font('Helvetica').fontSize(9)
     .text(`Regime: ${data.regime}`, M + 14, M + 28, { width: W - 28, align: 'right' });

  pdf.fillColor('#111');
  let y = M + 70;

  // ── Employer + Employee ──────────────────────────────────────────────
  pdf.font('Helvetica-Bold').fontSize(10).text('Employer', M, y);
  pdf.font('Helvetica').fontSize(9)
     .text('Company A Pvt Ltd', M, y + 14, { width: W * 0.48, lineBreak: false, ellipsis: true })
     .text('No. 64/2A/6NR-Swami Vivekanand Garden, Lane No. 6,', M, y + 26, { width: W * 0.48, lineBreak: false, ellipsis: true })
     .text('Hagawane Nagar, Kondhwa Budruk, Pune - 411048', M, y + 38, { width: W * 0.48, lineBreak: false, ellipsis: true })
     .text('PAN: AAAAA0000A | TAN: PNES12345A', M, y + 50, { width: W * 0.48, lineBreak: false, ellipsis: true });

  pdf.font('Helvetica-Bold').fontSize(10).text('Employee', M + W * 0.5, y);
  pdf.font('Helvetica').fontSize(9)
     .text(data.emp.EmpName || '-', M + W * 0.5, y + 14, { width: W * 0.48, lineBreak: false, ellipsis: true })
     .text(`${data.emp.EmpCode || '-'} | ${data.emp.Designation || ''} | ${data.emp.Department || ''}`, M + W * 0.5, y + 26, { width: W * 0.48, lineBreak: false, ellipsis: true })
     .text(`PAN: ${data.emp.PAN || '-'}`, M + W * 0.5, y + 38, { width: W * 0.48, lineBreak: false, ellipsis: true })
     .text(`UAN: ${data.emp.UAN || '-'}`, M + W * 0.5, y + 50, { width: W * 0.48, lineBreak: false, ellipsis: true });

  y += 70;

  // ── Salary breakdown table ───────────────────────────────────────────
  // pdfkit Helvetica has no ₹ glyph -- use "INR " prefix everywhere.
  function row(label, amount, bold) {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    pdf.rect(M, y, W, 16).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    pdf.fillColor('#111').text(label, M + 8, y + 3, { width: W * 0.7, lineBreak: false, ellipsis: true });
    pdf.text(`INR ${fmtN(amount)}`, M + W * 0.7, y + 3, { width: W * 0.3 - 8, align: 'right', lineBreak: false });
    y += 16;
  }
  function header(label) {
    pdf.rect(M, y, W, 20).fillAndStroke('#eef2ff', '#c7d2fe');
    pdf.fillColor('#1e3a8a').font('Helvetica-Bold').fontSize(10).text(label, M + 8, y + 5, { width: W - 16, lineBreak: false, ellipsis: true });
    y += 20;
  }

  header('A. Gross Salary');
  row('Gross salary credited / paid YTD', data.grossSalary, true);

  header('B. Less: Allowances exempt under Section 10');
  if (data.regime === 'New') {
    pdf.font('Helvetica-Oblique').fontSize(9).fillColor('#888')
       .text('HRA exemption not available under New regime.', M + 8, y + 3, { width: W - 16, lineBreak: false });
    y += 16;
  } else {
    row(`HRA exemption u/s 10(13A)${data.isMetro ? ' (metro 50%)' : ' (non-metro 40%)'}`, data.hraExemption);
  }

  header('C. Less: Deduction under Section 16');
  row('Standard Deduction u/s 16(ia)', data.stdDed);
  row('Professional Tax u/s 16(iii)', data.ptDeducted);
  row('Total Section 16 deductions', Number(data.stdDed) + Number(data.ptDeducted), true);

  header('D. Less: Deductions under Chapter VI-A');
  if (data.regime === 'New') {
    pdf.font('Helvetica-Oblique').fontSize(9).fillColor('#888')
       .text('Chapter VI-A deductions not available under New regime - taking INR 0.', M + 8, y + 3, { width: W - 16, lineBreak: false });
    y += 16;
  } else {
    data.sectionBreakdown.filter(s => s.SectionCode !== 'HRA').forEach(s => row(s.SectionCode, Number(s.ApprovedAmt)));
  }
  row('Total Chapter VI-A', data.chapterVIA, true);

  header('E. Taxable Total Income');
  row('Taxable income (A - B - C - D)', data.taxableIncome, true);

  header('F. Tax on Total Income');
  const tb = data.taxBreakdown || {};
  row(`Base tax (${data.regime} regime slabs)`, tb.baseTax || 0);
  if (tb.rebate87A) row('Less: Section 87A rebate', tb.rebate87A);
  if (tb.surcharge) row(`Add: Surcharge`, tb.surcharge);
  if (tb.cess)      row('Add: Health & Education Cess (4%)', tb.cess);
  row('Total Tax Payable', tb.totalTax || data.taxOnIncome, true);
  pdf.fontSize(8).font('Helvetica-Oblique').fillColor('#888')
     .text('Phase 6A tax engine: FY26-27 slabs + 87A rebate + surcharge bands (10/15/25/37% at 50L/1Cr/2Cr/5Cr) + 4% cess + marginal relief. Refer to TRACES Part A for official tax credits.',
           M + 8, y + 4, { width: W - 16, lineBreak: true });
  y += 30;

  // ── Footer ────────────────────────────────────────────────────────────
  pdf.fillColor('#111').font('Helvetica-Bold').fontSize(9)
     .text('Declaration:', M, y + 10);
  pdf.font('Helvetica').fontSize(9)
     .text('I certify that the information given above is true and correct based on the books of account maintained.',
           M, y + 24, { width: W });
  pdf.text(`For Company A Pvt Ltd`, M + W * 0.6, y + 50, { width: W * 0.4 - 10, align: 'right' });
  pdf.text(`(Authorised Signatory)`, M + W * 0.6, y + 90, { width: W * 0.4 - 10, align: 'right' });

  pdf.fillColor('#888').fontSize(8).font('Helvetica-Oblique')
     .text(`Generated on ${new Date().toLocaleString('en-IN', { hour12: false })} · Payslip months counted: ${data.monthsPaid} of 12`,
           M, pdf.page.height - 50, { width: W, align: 'center' });

  pdf.end();
}

module.exports = { fetchForm16Data, streamForm16PartB };
