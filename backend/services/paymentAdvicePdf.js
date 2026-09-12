// =====================================================================
// services/paymentAdvicePdf.js — Payment Advice PDF generator (v1.8)
//
// Renders a "Payment Advice" PDF when a customer pays us. The advice
// confirms receipt of the payment, shows the payment mode + reference,
// lists the applied Sales Invoices, and gives a brief account summary.
//
// LAYOUT (A4 portrait, 25pt margins, 8pt body):
//   1. Company header (logo text + address + GSTIN)
//   2. "PAYMENT ADVICE" title + Receipt No. + Receipt Date
//   3. Customer block (name, address, GSTIN, phone)
//   4. Payment details (amount, mode, reference, bank)
//   5. Applied to Invoices table
//   6. Total Applied + On Account
//   7. Account Summary (Previous / This Payment / Closing)
//   8. Thank-you + Authorised Signatory
//   9. Computer-generated footer + Page X of Y
//
// All data fetched via services/paymentAdvice.js — this file only handles
// rendering. Mirrors services/invoicePdf.js conventions: bufferPages,
// manual page breaks, ASCII fallbacks for the rupee glyph (Helvetica's
// built-in WinAnsi encoding has no ₹).
//
// Public API:
//   fetchPaymentAdviceData(companyCode, docNo) → data shape
//   streamPaymentAdvicePdf(data, res)          → writes PDF to HTTP response
//   bufferPaymentAdvicePdf(data) → Promise<Buffer> (for cron Meta upload)
// =====================================================================

const PDFDocument = require('pdfkit');
const { getCompanyByCode } = require('../shared/company');
const pa = require('./paymentAdvice');

// ── Number → words (Indian system) — duplicated from invoicePdf.js so the
// two services don't cross-depend. Same algorithm, same output. ─────────
const ONES = ['', 'ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINE',
              'TEN','ELEVEN','TWELVE','THIRTEEN','FOURTEEN','FIFTEEN','SIXTEEN',
              'SEVENTEEN','EIGHTEEN','NINETEEN'];
const TENS = ['','','TWENTY','THIRTY','FORTY','FIFTY','SIXTY','SEVENTY','EIGHTY','NINETY'];
function _twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n/10)] + (n%10 ? ' ' + ONES[n%10] : '');
}
function _threeDigits(n) {
  if (n === 0) return '';
  const h = Math.floor(n/100); const r = n%100;
  return (h ? ONES[h] + ' HUNDRED' + (r ? ' ' : '') : '') + _twoDigits(r);
}
function numToWords(amount, currencyName = 'RUPEES', subUnit = 'PAISA') {
  if (amount == null) return '';
  const num   = Math.floor(amount);
  const paise = Math.round((amount - num) * 100);
  const crore    = Math.floor(num / 10000000);
  const lakh     = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const remainder = num % 1000;
  const parts = [];
  if (crore)     parts.push(_twoDigits(crore) + ' CRORE');
  if (lakh)      parts.push(_twoDigits(lakh)  + ' LAKH');
  if (thousand)  parts.push(_twoDigits(thousand) + ' THOUSAND');
  if (remainder) parts.push(_threeDigits(remainder));
  if (!parts.length) parts.push('ZERO');
  const paiseWords = paise ? _twoDigits(paise) : 'ZERO';
  return `${parts.join(' ')} ${currencyName} AND ${paiseWords} ${subUnit} ONLY`;
}

// ── Date → "DD-Mon-YYYY" (e.g. 03-Jun-2026) ─────────────────────────────
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtD(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${String(dt.getDate()).padStart(2,'0')}-${MON[dt.getMonth()]}-${dt.getFullYear()}`;
}

// ── Amount → "1,23,456.78" (Indian grouping) ─────────────────────────────
function fmtAmt(n) {
  if (n == null || isNaN(Number(n))) return '0.00';
  const num   = Number(n);
  const fixed = Math.abs(num).toFixed(2);
  const parts = fixed.split('.');
  let int = parts[0];
  const last3 = int.slice(-3);
  const rest  = int.slice(0, -3);
  if (rest) int = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  return (num < 0 ? '-' : '') + int + '.' + parts[1];
}

// =====================================================================
// fetchPaymentAdviceData(companyCode, docNo)
//
// Orchestrates the data layer (paymentAdvice.js) into the single shape
// the PDF builder consumes. Returns null if the payment isn't found.
// =====================================================================
async function fetchPaymentAdviceData(companyCode, docNo) {
  const company = getCompanyByCode(companyCode);
  const payment = await pa.getPaymentByDocNo(companyCode, docNo);
  if (!payment) return null;

  const [applied, bank, customer, summary] = await Promise.all([
    pa.getAppliedInvoices(companyCode, payment.PaymentEntryNo),
    pa.getPaymentBankDetails(companyCode, payment.PaymentEntryNo),
    pa.getCustomerDetails(companyCode, payment.CustomerCode),
    pa.getAccountSummary(companyCode, payment.CustomerCode, payment.Amount),
  ]);

  const totalApplied = applied.reduce((s, x) => s + Number(x.AppliedAmount || 0), 0);
  const onAccount    = Math.max(0, Number(payment.Amount) - totalApplied);

  return {
    company,
    payment,
    customer,
    bank,
    applied,
    totalApplied,
    onAccount,
    summary,
  };
}

// =====================================================================
// renderPdf(data, doc) — internal builder. Writes the full document to
// the supplied PDFDocument. Used by both streamPaymentAdvicePdf and
// bufferPaymentAdvicePdf so the layout is identical for both callers.
// =====================================================================
function renderPdf(data, pdf) {
  const isCompanyA        = data.company.code === 'COMPANYA';
  const currencyCode = data.company.currency;            // 'INR' | 'USD'
  const currencyName = currencyCode === 'USD' ? 'DOLLARS' : 'RUPEES';
  const subUnitName  = currencyCode === 'USD' ? 'CENTS'   : 'PAISA';
  // Helvetica's WinAnsi encoding has no ₹ glyph, so we print the ISO code.
  const curLabel     = currencyCode;                     // 'INR' / 'USD'

  pdf.addPage();
  const PW = pdf.page.width;
  const PH = pdf.page.height;
  const M  = 25;
  const W  = PW - 2 * M;
  const FOOTER_H = 22;

  function txt(str, x, y, opts) {
    pdf.text(String(str ?? ''), x, y, { lineBreak: false, ...opts });
  }
  function wrap(str, x, y, w, opts) {
    pdf.text(String(str ?? ''), x, y, { width: w, lineBreak: true, ...opts });
  }
  function hLine(y) {
    pdf.save().lineWidth(0.5).strokeColor('#999999')
       .moveTo(M, y).lineTo(M + W, y).stroke().restore();
  }
  function box(x, y, w, h) {
    pdf.save().lineWidth(0.5).strokeColor('#888888').rect(x, y, w, h).stroke().restore();
  }

  // ════════════════════════════════════════════════════════════════════
  // 1. Company header
  // ════════════════════════════════════════════════════════════════════
  pdf.font('Helvetica-Bold').fontSize(14);
  txt(data.company.label, M, M, { width: W, align: 'center' });

  pdf.font('Helvetica').fontSize(8);
  const compLines = isCompanyA
    ? [
        '12 Example Industrial Estate, Lane 1,',
        'Example Area, Phase 2, City - 000000, State, India',
        'GSTIN: 27AAAAA0000A1Z5   ·   State Code: 27-Maharashtra',
        'Email: accounts@company-a.example',
      ]
    : [
        'Blk 1, Example Road, #00-00, Singapore',
        'Email: accounts@company-b.example',
      ];
  let cy = M + 18;
  for (const ln of compLines) { txt(ln, M, cy, { width: W, align: 'center' }); cy += 10; }

  hLine(cy + 4);
  let y = cy + 12;

  // ════════════════════════════════════════════════════════════════════
  // 2. Title + Receipt No. + Date
  // ════════════════════════════════════════════════════════════════════
  pdf.font('Helvetica-Bold').fontSize(13);
  txt('PAYMENT  ADVICE', M, y, { width: W, align: 'center' });
  y += 22;

  pdf.font('Helvetica-Bold').fontSize(9);
  txt('Receipt No.:', M, y);
  pdf.font('Helvetica');
  txt(data.payment.PaymentDocNo || '—', M + 70, y);

  // Receipt Date right-aligned to the page edge — measured width of the value
  // so the bold "Receipt Date: " label sits immediately to its left, mirroring
  // the left-side No.+value spacing.
  const dateValue = fmtD(data.payment.PaymentDate);
  pdf.font('Helvetica').fontSize(9);
  const dateValW  = pdf.widthOfString(dateValue);
  pdf.font('Helvetica-Bold').fontSize(9);
  const labelText = 'Receipt Date: ';
  const labelW    = pdf.widthOfString(labelText);
  txt(labelText, M + W - dateValW - labelW, y);
  pdf.font('Helvetica').fontSize(9);
  txt(dateValue, M + W - dateValW, y);
  y += 16;
  hLine(y);
  y += 10;

  // ════════════════════════════════════════════════════════════════════
  // 3. Customer block
  // ════════════════════════════════════════════════════════════════════
  pdf.font('Helvetica-Bold').fontSize(9);
  txt('Received From:', M, y);
  y += 12;

  const c = data.customer || {};
  pdf.font('Helvetica-Bold').fontSize(10);
  txt(`${c.Name || data.payment.CustomerName || '—'}` +
      (c.CustomerCode ? `   (${c.CustomerCode})` : ''), M, y, { width: W });
  y += 13;

  pdf.font('Helvetica').fontSize(8);
  const addrLines = [
    c.Address1,
    c.Address2,
    [c.City, c.State, c.Pincode].filter(Boolean).join(' - '),
  ].filter(s => s && String(s).trim());
  for (const ln of addrLines) { txt(ln, M, y, { width: W }); y += 10; }

  if (c.GSTIN || c.Phone || c.Email) {
    pdf.font('Helvetica').fontSize(8);
    const gstLine = c.GSTIN ? `GSTIN: ${c.GSTIN}` : '';
    const phoneLine = c.Phone ? `Phone: ${c.Phone}` : '';
    const emailLine = c.Email ? `Email: ${c.Email}` : '';
    if (gstLine)   { txt(gstLine,   M, y); y += 10; }
    if (phoneLine || emailLine) {
      const both = [phoneLine, emailLine].filter(Boolean).join('   ·   ');
      txt(both, M, y, { width: W }); y += 10;
    }
  }
  y += 4;
  hLine(y);
  y += 12;

  // ════════════════════════════════════════════════════════════════════
  // 4. Payment details — AMOUNT prominent, then mode/reference/bank
  // ════════════════════════════════════════════════════════════════════
  pdf.font('Helvetica-Bold').fontSize(10);
  txt('AMOUNT RECEIVED', M, y);
  pdf.font('Helvetica-Bold').fontSize(16);
  txt(`${curLabel}  ${fmtAmt(data.payment.Amount)}`, M, y + 14, { width: W });
  y += 38;

  pdf.font('Helvetica').fontSize(8);
  const detailRows = [
    ['Payment Mode',  data.bank.PaymentMode || 'Bank Transfer'],
    ['Reference No.', data.bank.Reference || '—'],
    ['Bank / Branch', data.bank.BankName || '—'],
    ['Value Date',    fmtD(data.payment.PaymentDate)],
  ];
  for (const [k, v] of detailRows) {
    pdf.font('Helvetica-Bold').fontSize(8);
    txt(k + ':', M + 10, y, { width: 100 });
    pdf.font('Helvetica').fontSize(8);
    txt(v, M + 110, y, { width: W - 110 });
    y += 11;
  }
  // Amount in words — useful for finance reconciliation.
  pdf.font('Helvetica-Oblique').fontSize(8);
  wrap(
    `(In words: ${numToWords(Number(data.payment.Amount), currencyName, subUnitName)})`,
    M + 10, y, W - 20
  );
  y += 12;
  hLine(y);
  y += 12;

  // ════════════════════════════════════════════════════════════════════
  // 5. Applied to Invoices table
  // ════════════════════════════════════════════════════════════════════
  pdf.font('Helvetica-Bold').fontSize(10);
  txt('APPLIED TO INVOICES', M, y);
  y += 14;

  // Column layout: # | Sales Invoice No. | Date | Order Ref | Inv Amount | Applied
  const colW = {
    n:    24,
    inv:  130,
    date: 64,
    ord:  120,
    amt:  78,
    app:  78,
  };
  const colX = {
    n:    M,
    inv:  M + colW.n,
    date: M + colW.n + colW.inv,
    ord:  M + colW.n + colW.inv + colW.date,
    amt:  M + colW.n + colW.inv + colW.date + colW.ord,
    app:  M + colW.n + colW.inv + colW.date + colW.ord + colW.amt,
  };

  // Header row
  pdf.save().fillColor('#f1f5f9').rect(M, y - 2, W, 14).fill().restore();
  pdf.font('Helvetica-Bold').fontSize(8).fillColor('#111');
  txt('#',                colX.n,    y + 1, { width: colW.n,    align: 'center' });
  txt('Sales Invoice No.',colX.inv,  y + 1, { width: colW.inv });
  txt('Inv. Date',        colX.date, y + 1, { width: colW.date });
  txt('Order Ref.',       colX.ord,  y + 1, { width: colW.ord });
  txt('Inv. Amount',      colX.amt,  y + 1, { width: colW.amt,  align: 'right' });
  txt('Applied',          colX.app,  y + 1, { width: colW.app,  align: 'right' });
  y += 14;
  pdf.save().strokeColor('#cbd5e1').lineWidth(0.5).moveTo(M, y).lineTo(M + W, y).stroke().restore();
  y += 2;

  // Body rows
  pdf.font('Helvetica').fontSize(8).fillColor('#222');
  (data.applied || []).forEach((inv, i) => {
    txt(String(i + 1),                       colX.n,    y + 1, { width: colW.n,    align: 'center' });
    txt(inv.InvoiceNo  || '—',               colX.inv,  y + 1, { width: colW.inv });
    txt(fmtD(inv.InvoiceDate),               colX.date, y + 1, { width: colW.date });
    txt(inv.OrderRef   || '—',               colX.ord,  y + 1, { width: colW.ord });
    txt(fmtAmt(inv.OriginalAmount),          colX.amt,  y + 1, { width: colW.amt,  align: 'right' });
    txt(fmtAmt(inv.AppliedAmount),           colX.app,  y + 1, { width: colW.app,  align: 'right' });
    y += 13;
  });

  if (!data.applied || data.applied.length === 0) {
    pdf.font('Helvetica-Oblique').fontSize(8).fillColor('#888');
    txt('Payment received as advance — to be adjusted against future invoices.',
        M + 4, y + 2, { width: W - 8 });
    y += 16;
  }

  pdf.fillColor('#000');
  pdf.save().strokeColor('#cbd5e1').lineWidth(0.5).moveTo(M, y).lineTo(M + W, y).stroke().restore();
  y += 4;

  // Total + On Account
  pdf.font('Helvetica-Bold').fontSize(9);
  txt('Total Applied:', colX.amt - 60, y, { width: colW.amt + 56, align: 'right' });
  txt(`${curLabel}  ${fmtAmt(data.totalApplied || 0)}`, colX.app, y, { width: colW.app, align: 'right' });
  y += 12;
  pdf.font('Helvetica').fontSize(9);
  txt('On Account:',    colX.amt - 60, y, { width: colW.amt + 56, align: 'right' });
  txt(`${curLabel}  ${fmtAmt(data.onAccount || 0)}`,    colX.app, y, { width: colW.app, align: 'right' });
  y += 14;
  hLine(y);
  y += 12;

  // ════════════════════════════════════════════════════════════════════
  // 6. Account Summary
  // ════════════════════════════════════════════════════════════════════
  if (data.summary) {
    pdf.font('Helvetica-Bold').fontSize(10);
    txt('ACCOUNT SUMMARY', M, y);
    y += 14;

    pdf.font('Helvetica').fontSize(8);
    const summaryRows = [
      ['Previous Outstanding:', `${curLabel}  ${fmtAmt(data.summary.PreviousOutstanding)}`],
      ['This Payment (Cr):',    `${curLabel}  ${fmtAmt(data.summary.ThisPayment)}`],
      ['Closing Outstanding:',  `${curLabel}  ${fmtAmt(data.summary.ClosingOutstanding)}`],
    ];
    for (const [k, v] of summaryRows) {
      pdf.font('Helvetica').fontSize(8);
      txt(k, M + 10, y, { width: 200 });
      const isClosing = k.startsWith('Closing');
      if (isClosing) pdf.font('Helvetica-Bold');
      txt(v, M + 220, y, { width: 160, align: 'right' });
      y += 11;
    }
    y += 6;
    hLine(y);
    y += 12;
  }

  // ════════════════════════════════════════════════════════════════════
  // 7. Thank-you message + Signature block
  // ════════════════════════════════════════════════════════════════════
  pdf.font('Helvetica').fontSize(9);
  wrap(
    'Thank you for your payment. We acknowledge receipt of the above amount and have applied it to the invoices listed.',
    M, y, W
  );
  y += 28;

  pdf.font('Helvetica').fontSize(9);
  txt(`For ${data.company.label}`, M + W - 220, y, { width: 220, align: 'right' });
  y += 36;
  pdf.save().strokeColor('#222').lineWidth(0.5)
     .moveTo(M + W - 180, y).lineTo(M + W, y).stroke().restore();
  pdf.font('Helvetica').fontSize(8);
  txt('Authorised Signatory', M + W - 220, y + 2, { width: 220, align: 'right' });
  y += 22;

  pdf.font('Helvetica-Oblique').fontSize(7).fillColor('#555');
  wrap(
    'This is a computer-generated payment advice. No physical signature required.',
    M, y, W, { align: 'center' }
  );
  pdf.fillColor('#000');

  // ════════════════════════════════════════════════════════════════════
  // 8. Footer (page X of Y) — applied via bufferPages range at the end.
  // ════════════════════════════════════════════════════════════════════
  const range = pdf.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    pdf.switchToPage(range.start + i);
    pdf.font('Helvetica').fontSize(7).fillColor('#555');
    const footY = PH - M - 14;
    txt(`${data.company.label}   ·   GSTIN: ${isCompanyA ? '27AAAAA0000A1Z5' : '—'}`,
        M, footY, { width: W * 0.7 });
    txt(`Page ${i + 1} of ${total}`,
        M + W * 0.7, footY, { width: W * 0.3, align: 'right' });
    pdf.fillColor('#000');
  }
}

// =====================================================================
// streamPaymentAdvicePdf(data, res) — pipes the PDF to an HTTP response.
// Used by GET /api/sales/payments/:docNo/pdf (Phase 2d).
// =====================================================================
function streamPaymentAdvicePdf(data, res) {
  const pdf = new PDFDocument({
    size: 'A4',
    margin: 25,
    autoFirstPage: false,
    bufferPages: true,
  });
  pdf.pipe(res);
  renderPdf(data, pdf);
  pdf.end();
}

// =====================================================================
// bufferPaymentAdvicePdf(data) — resolves to a Buffer. Used by the cron
// when uploading the PDF to Meta as a document-message header.
// =====================================================================
function bufferPaymentAdvicePdf(data) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margin: 25,
      autoFirstPage: false,
      bufferPages: true,
    });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end',  () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    try {
      renderPdf(data, pdf);
      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  fetchPaymentAdviceData,
  streamPaymentAdvicePdf,
  bufferPaymentAdvicePdf,
};
