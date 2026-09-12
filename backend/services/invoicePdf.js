// =====================================================================
// services/invoicePdf.js — Sales Invoice PDF generator
//
// Renders a posted sales invoice to PDF, branching on company:
//   COMPANYA    → Tax Invoice with GST (CGST/SGST/IGST split), IRN box, India bank details
//   COMPANYB → Tax Invoice without GST (export), Singapore bank details
//
// Layout matches the NAV-printed Tax Invoice samples in /Invoices/.
// pdfkit's built-in Helvetica is used (₹ glyph not in PDF — we print "INR" text).
//
// Public API:
//   fetchInvoiceData(company, invoiceNo)  → returns shape { header, billTo, ... }
//   streamInvoicePdf(data, res)           → writes PDF to res
// =====================================================================

const PDFDocument = require('pdfkit');
const { sql, getPool } = require('../db');

// ─── Number → words (Indian system, used for "Amount in Words") ───────────
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
  const num = Math.floor(amount);
  const paise = Math.round((amount - num) * 100);
  const crore = Math.floor(num / 10000000);
  const lakh  = Math.floor((num % 10000000) / 100000);
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

// ─── Date → "DD-MM-YYYY" ──────────────────────────────────────────────────
function fmtD(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return [
    String(dt.getDate()).padStart(2, '0'),
    String(dt.getMonth() + 1).padStart(2, '0'),
    dt.getFullYear(),
  ].join('-');
}
function fmtN(n, dec = 2) {
  if (n == null) return '';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  }).format(Number(n));
}

// =====================================================================
// fetchInvoiceData(company, invoiceNo)
// =====================================================================
async function fetchInvoiceData(company, invoiceNo) {
  const pool = await getPool();
  const P = company.prefix;

  // ── Header ────────────────────────────────────────────────────────────
  const isCompanyA = company.code === 'COMPANYA';
  const headerCols = `
    [No_]                          AS InvoiceNo,
    [Posting Date]                 AS PostingDate,
    [Document Date]                AS DocumentDate,
    [External Document No_]        AS ExtDocNo,
    [Order No_]                    AS OrderNo,
    [Sell-to Customer No_]         AS SellToCustomerNo,
    [Bill-to Customer No_]         AS BillToCustomerNo,
    [Bill-to Name]                 AS BillToName,
    [Bill-to Address]              AS BillToAddress1,
    [Bill-to Address 2]            AS BillToAddress2,
    [Bill-to City]                 AS BillToCity,
    [Bill-to Post Code]            AS BillToPostCode,
    [Bill-to County]               AS BillToCounty,
    [Bill-to Country_Region Code]  AS BillToCountryCode,
    [Ship-to Name]                 AS ShipToName,
    [Ship-to Address]              AS ShipToAddress1,
    [Ship-to Address 2]            AS ShipToAddress2,
    [Ship-to City]                 AS ShipToCity,
    [Ship-to Post Code]            AS ShipToPostCode,
    [Ship-to County]               AS ShipToCounty,
    [Ship-to Country_Region Code]  AS ShipToCountryCode,
    [Currency Code]                AS CurrencyCode,
    [Salesperson Code]             AS SalespersonCode,
    [Payment Terms Code]           AS PaymentTermsCode
  `;

  const hRes = await pool.request()
    .input('inv', sql.NVarChar, invoiceNo)
    .query(`SELECT TOP 1 ${headerCols} FROM ${P}Sales Invoice Header] WHERE [No_] = @inv`);
  const header = hRes.recordset[0] || null;
  if (!header) return null;

  // ── Lines (only items: Type=2) ────────────────────────────────────────
  const lRes = await pool.request()
    .input('inv', sql.NVarChar, invoiceNo)
    .query(`
      SELECT
        [Line No_]              AS LineNo_,
        [Type]                  AS LineType,
        [No_]                   AS ItemNo,
        [Description]           AS Description,
        [Description 2]         AS Description2,
        ISNULL([Cross-Reference No_], '') AS CPN,
        ISNULL([Quantity], 0)   AS Quantity,
        ISNULL([Unit of Measure Code], '') AS UoM,
        ISNULL([Unit Price], 0) AS UnitPrice,
        ISNULL([Line Amount], 0) AS LineAmount,
        ISNULL([Amount Including VAT], 0) AS AmountInclVAT,
        ISNULL([HSN_SAC Code], '') AS HSN,
        ISNULL([GST _], 0)         AS GstPct,
        ISNULL([GST Group Code], '') AS GstGroupCode,
        ISNULL([GST Jurisdiction Type], 0) AS GstJurisdiction
      FROM ${P}Sales Invoice Line]
      WHERE [Document No_] = @inv AND ISNULL([Type], 0) = 2
      ORDER BY [Line No_]
    `);
  const lines = lRes.recordset || [];

  // ── Item master for each line — to fetch Vendor Item No (MPN) ─────────
  const itemNos = [...new Set(lines.map(l => l.ItemNo).filter(Boolean))];
  let itemMap = {};
  if (itemNos.length) {
    const r = pool.request();
    itemNos.forEach((no, i) => r.input('it' + i, sql.NVarChar, no));
    const ph = itemNos.map((_, i) => '@it' + i).join(',');
    const ir = await r.query(`
      SELECT [No_] AS ItemNo, ISNULL([Vendor Item No_], '') AS MPN
      FROM ${P}Item]
      WHERE [No_] IN (${ph})
    `);
    for (const row of ir.recordset) itemMap[row.ItemNo] = row;
  }

  // ── GST split per line (COMPANYA only — CompanyB is export, no GST) ──────────
  // From Detailed GST Ledger Entry: pivot by [Document Line No_] × [GST Component Code]
  const gstByLine = {};   // { lineNo: { CGST: {pct, amt}, SGST: {...}, IGST: {...}, base: total }}
  if (isCompanyA) {
    const gRes = await pool.request()
      .input('inv', sql.NVarChar, invoiceNo)
      .query(`
        SELECT
          [Document Line No_]      AS DocLineNo,
          [GST Component Code]     AS Component,
          [GST _]                  AS Pct,
          [GST Base Amount]        AS BaseAmt,
          [GST Amount]             AS Amt,
          [HSN_SAC Code]           AS HSN
        FROM ${P}Detailed GST Ledger Entry]
        WHERE [Document No_] = @inv
      `);
    for (const row of gRes.recordset) {
      const ln = row.DocLineNo;
      if (!gstByLine[ln]) gstByLine[ln] = {};
      const c = String(row.Component || '').toUpperCase();
      // GST Amount stored as negative (credit); take absolute value
      gstByLine[ln][c] = {
        pct:  Number(row.Pct  || 0),
        amt:  Math.abs(Number(row.Amt  || 0)),
        base: Math.abs(Number(row.BaseAmt || 0)),
      };
      gstByLine[ln].HSN = row.HSN || gstByLine[ln].HSN;
    }
  }

  // ── Customer master (Bill-to) — for GST/PAN/Phone/Contact/State ────────
  const custRes = await pool.request()
    .input('id', sql.NVarChar, header.BillToCustomerNo)
    .query(`
      SELECT TOP 1
        [No_], [Name],
        [Phone No_]  AS Phone,
        [Contact],
        ${isCompanyA ? '[GST Registration No_] AS GSTNo,' : "'' AS GSTNo,"}
        [State Code] AS StateCode,
        ${isCompanyA ? '[P_A_N_ No_] AS PAN,' : "'' AS PAN,"}
        [Country_Region Code] AS CountryCode
      FROM ${P}Customer]
      WHERE [No_] = @id
    `);
  const billCust = custRes.recordset[0] || null;

  // ── State name lookup for State Code → "Maharashtra - 27" style label ──
  // NAV India localization stores state in [State] table with code, name, code(GST)
  let billStateLabel = '';
  if (billCust && billCust.StateCode) {
    try {
      const sr = await pool.request()
        .input('sc', sql.NVarChar, billCust.StateCode)
        .query(`SELECT TOP 1 [Description] AS Name, ISNULL([State Code (GST Reg_ No_)],'') AS GstStateCode FROM ${P}State] WHERE [Code]=@sc`);
      if (sr.recordset[0]) {
        billStateLabel = `${sr.recordset[0].Name}${sr.recordset[0].GstStateCode ? ' - ' + sr.recordset[0].GstStateCode : ''}`;
      } else {
        billStateLabel = billCust.StateCode;
      }
    } catch { billStateLabel = billCust.StateCode; }
  }

  // ── Salesperson ───────────────────────────────────────────────────────
  let salesperson = null;
  if (header.SalespersonCode) {
    const spRes = await pool.request()
      .input('c', sql.NVarChar, header.SalespersonCode)
      .query(`SELECT TOP 1 [Code], [Name], ISNULL([Phone No_],'') AS Phone, ISNULL([E-Mail],'') AS Email FROM ${P}Salesperson_Purchaser] WHERE [Code]=@c`);
    salesperson = spRes.recordset[0] || null;
  }

  // ── Totals ────────────────────────────────────────────────────────────
  let totalLineAmt = 0, totalCGST = 0, totalSGST = 0, totalIGST = 0;
  for (const line of lines) {
    totalLineAmt += Number(line.LineAmount || 0);
    const g = gstByLine[line.LineNo_] || {};
    totalCGST += g.CGST?.amt || 0;
    totalSGST += g.SGST?.amt || 0;
    totalIGST += g.IGST?.amt || 0;
  }
  const totalReceivable = totalLineAmt + totalCGST + totalSGST + totalIGST;

  return {
    company,
    header,
    lines,
    itemMap,
    gstByLine,
    billCustomer:  billCust,
    billStateLabel,
    salesperson,
    totals: {
      lineAmount:      totalLineAmt,
      cgst:            totalCGST,
      sgst:            totalSGST,
      igst:            totalIGST,
      amountReceivable: totalReceivable,
    },
  };
}

// =====================================================================
// streamInvoicePdf(data, res)
// =====================================================================
//
// Layout strategy:
//   • A4 portrait, 25pt margins, 8pt body font (max content area).
//   • Every absolute-positioned text() call is `lineBreak: false` so it
//     never silently flows to a new page; we manage page breaks manually.
//   • Header block (company + bank + invoice meta + bill/ship + contact/sp)
//     is drawn ONCE on page 1.
//   • Line items table draws rows page-by-page; when remaining vertical
//     room is too small for the next row, we add a new page and re-draw
//     just the items-table column header.
//   • Totals + Amount-in-Words + Terms + Signatures land directly under
//     the items table on the last page; if there isn't enough room we
//     break to a fresh page first.
//   • Footer ("Page X of Y" + computer-generated note) is drawn at the
//     end on every page using a final pass.
// =====================================================================
function streamInvoicePdf(data, res) {
  const pdf = new PDFDocument({ size: 'A4', margin: 25, autoFirstPage: false, bufferPages: true });
  pdf.pipe(res);
  pdf.addPage();

  const isCompanyA        = data.company.code === 'COMPANYA';
  const currencyCode = data.company.currency;          // 'INR' | 'USD'
  const currencyName = currencyCode === 'USD' ? 'DOLLARS' : 'RUPEES';
  const subUnitName  = currencyCode === 'USD' ? 'CENTS'   : 'PAISA';

  const PW = pdf.page.width;
  const PH = pdf.page.height;
  const M  = 25;
  const W  = PW - 2 * M;
  const FOOTER_H = 22;
  const SAFE_Y   = PH - M - FOOTER_H;        // bottom-most y a row may end

  // Place an absolutely-positioned text run with no line-flow to next page.
  function txt(str, x, y, opts) {
    pdf.text(String(str ?? ''), x, y, { lineBreak: false, ...opts });
  }

  // Wrapped text inside an explicit box with no auto-page-break.
  function wrap(str, x, y, w, opts) {
    pdf.text(String(str ?? ''), x, y, { width: w, lineBreak: true, ...opts });
  }

  // ── Title ────────────────────────────────────────────────────────────
  pdf.font('Helvetica-Bold').fontSize(15);
  txt('Tax Invoice', M, M, { width: W, align: 'center' });
  pdf.font('Helvetica').fontSize(9);
  txt('Original', PW - M - 60, M + 4, { width: 60, align: 'right' });

  let y = M + 22;

  // ── Top block: company (left) + bank details (right) ────────────────
  const colLW = W * 0.58;
  const colRW = W * 0.42 - 4;
  const colRX = M + colLW + 4;

  pdf.font('Helvetica-Bold').fontSize(11);
  txt(data.company.label, M, y, { width: colLW });
  pdf.font('Helvetica').fontSize(8);
  let yL = y + 14;
  const compAddrLines = isCompanyA
    ? [
        '12 Example Industrial Estate, Lane 1,',
        'Example Area, Phase 2',
        'City - 000000 - ST',
        'GST No.: 27AAAAA0000A1Z5',
        'State Code & State : 27-Maharashtra',
        'PAN No.: AAAAA0000A',
      ]
    : [
        'Blk 1, Example Road, #00-00, Singapore',
        '',
        '',
        '',
        '',
        '',
      ];
  for (const ln of compAddrLines) { txt(ln, M, yL, { width: colLW }); yL += 10; }

  // Bank box on right
  pdf.font('Helvetica-Bold').fontSize(10);
  txt('Bank Details', colRX, y, { width: colRW });
  pdf.font('Helvetica').fontSize(8);
  let yR = y + 14;
  const bankLines = isCompanyA
    ? [
        'EXAMPLE BANK',
        'Example Branch,',
        'City',
        'Bank Account No. : 000000000000',
        'IFSC Code : EXMP0000000',
        'SWIFT Code :',
      ]
    : [
        'Example Bank Ltd',
        'Example Street,',
        '#00-00, Singapore-000000',
        'Bank Account No. : 000000000000',
        'IFSC Code :',
        'SWIFT Code : EXMPSGSG',
      ];
  for (const ln of bankLines) { txt(ln, colRX, yR, { width: colRW }); yR += 10; }

  y = Math.max(yL, yR) + 4;

  // ── Invoice meta row (2x2 grid: Invoice No | Payment Terms / Cust PO | Invoice Date) ──
  drawMetaGrid(pdf, M, y, W, [
    ['Invoice Number',   data.header.InvoiceNo || ''],
    ['Payment Terms',    data.header.PaymentTermsCode || ''],
    ['Customer PO No.',  data.header.ExtDocNo || ''],
    ['Invoice Date',     fmtD(data.header.PostingDate)],
  ]);
  y += 32;

  // ── Bill To / Ship To boxes (compact: title + flowed address + 3 KV) ─
  const halfW = W / 2 - 3;
  const bH = drawAddrBox(pdf, M, y, halfW, 'Bill To Customer', {
    Name:                 data.header.BillToName || '',
    Address:              addrLines(data.header.BillToAddress1, data.header.BillToAddress2, data.header.BillToCity, data.header.BillToPostCode),
    'GST No.':            data.billCustomer?.GSTNo || '',
    'State & State Code': data.billStateLabel || '',
    'PAN No.':            data.billCustomer?.PAN || '',
  });
  const sH = drawAddrBox(pdf, M + halfW + 6, y, halfW, 'Ship To Customer', {
    Name:                 data.header.ShipToName || '',
    Address:              addrLines(data.header.ShipToAddress1, data.header.ShipToAddress2, data.header.ShipToCity, data.header.ShipToPostCode),
    'GST No.':            data.billCustomer?.GSTNo || '',
    'State & State Code': data.billStateLabel || '',
    'PAN No.':            data.billCustomer?.PAN || '',
  });
  y += Math.max(bH, sH) + 4;

  // ── Contact / Salesperson row ────────────────────────────────────────
  const sp = data.salesperson || {};
  const cH = drawAddrBox(pdf, M, y, halfW, '', {
    'Contact Person': data.billCustomer?.Contact || '',
    'Phone No.':      data.billCustomer?.Phone   || '',
  });
  const sH2 = drawAddrBox(pdf, M + halfW + 6, y, halfW, '', {
    'Salesperson Name':    sp.Name  || '',
    'Salesperson Ph. No.': sp.Phone || '',
    'Salesperson E-mail':  sp.Email || '',
  });
  y += Math.max(cH, sH2) + 6;

  // ── Line items table (with manual page-break + repeating header) ────
  const drawHeader = (yy) => drawItemsHeader(pdf, M, yy, W, isCompanyA);
  const colWidths  = isCompanyA
    ? [16, 126, 42, 36, 38, 50, 26, 36, 26, 36, 26, 36, 41]
    : [22, 240, 56, 56, 56, 56, 49];

  y = drawHeader(y);

  for (let idx = 0; idx < data.lines.length; idx++) {
    const line = data.lines[idx];
    const item = data.itemMap[line.ItemNo] || {};
    const g    = data.gstByLine[line.LineNo_] || {};
    const hsn  = g.HSN || line.HSN || item.HSN || '';
    const desc = (line.Description || '') +
                 (line.CPN ? '\nCPN-' + line.CPN : '') +
                 (item.MPN ? '\nMPN- ' + item.MPN : '');

    const lineH = Math.max(22, pdf.heightOfString(desc, { width: colWidths[1] - 4 }) + 4);

    if (y + lineH > SAFE_Y - 110) {       // 110pt reserve for totals + sig on this page
      pdf.addPage();
      y = M;
      y = drawHeader(y);
    }

    drawItemRow(pdf, M, y, colWidths, idx + 1, line, g, hsn, desc, isCompanyA);
    y += lineH;
  }
  y += 2;

  // ── Totals (right-aligned strip; break to new page if too low) ──────
  const totalsRows = [
    ['Total', data.totals.lineAmount],
    ...(isCompanyA && data.totals.cgst ? [['Total CGST Amount', data.totals.cgst]] : []),
    ...(isCompanyA && data.totals.sgst ? [['Total SGST Amount', data.totals.sgst]] : []),
    ...(isCompanyA && data.totals.igst ? [['Total IGST Amount', data.totals.igst]] : []),
    ['Total Amount Receivable', data.totals.amountReceivable],
  ];
  const totalsH = totalsRows.length * 13 + 4;
  if (y + totalsH > SAFE_Y - 70) {
    pdf.addPage();
    y = M;
  }

  pdf.font('Helvetica-Bold').fontSize(9);
  for (const [label, amt] of totalsRows) {
    txt(label, M, y, { width: W - 100, align: 'right' });
    txt(currencyCode + ' ' + fmtN(amt), M + W - 100, y, { width: 100, align: 'right' });
    y += 13;
  }
  y += 4;

  // ── Amount in Words ──────────────────────────────────────────────────
  if (y + 30 > SAFE_Y) { pdf.addPage(); y = M; }
  pdf.font('Helvetica-Bold').fontSize(9);
  txt('Amount in Words: ', M, y, { width: 90 });
  pdf.font('Helvetica').fontSize(9);
  wrap('**** ' + numToWords(data.totals.amountReceivable, currencyName, subUnitName), M + 90, y, W - 90);
  y += 18;

  // ── Terms ────────────────────────────────────────────────────────────
  if (y + 30 > SAFE_Y) { pdf.addPage(); y = M; }
  pdf.font('Helvetica-Bold').fontSize(8);
  txt('Terms :', M, y, { width: 38 });
  pdf.font('Helvetica').fontSize(8);
  wrap('(1) In case of rejection, material should reach with us within 15 days from the date of delivery, otherwise it assumed that material is accepted by you. (2) IF payment not received within agreed terms 2% will be extra charged', M + 38, y, W - 38);
  y = pdf.y + 8;

  // ── Signature block ─────────────────────────────────────────────────
  if (y + 60 > SAFE_Y) { pdf.addPage(); y = M; }
  pdf.rect(M, y, 150, 50).stroke();
  pdf.font('Helvetica-Bold').fontSize(8);
  txt('Receiver Signature With Seal', M + 6, y + 6, { width: 138 });
  pdf.font('Helvetica-Bold').fontSize(9);
  txt('For ' + data.company.label, M + W - 220, y + 24, { width: 220, align: 'right' });
  pdf.font('Helvetica').fontSize(9);
  txt('Authorized Signatory', M + W - 220, y + 42, { width: 220, align: 'right' });

  // ── Footer on every page ─────────────────────────────────────────────
  const total = pdf.bufferedPageRange().count;
  for (let i = 0; i < total; i++) {
    pdf.switchToPage(i);
    pdf.font('Helvetica').fontSize(7);
    txt('This is a computer generated invoice and does not require signature', M, PH - M - 10, { width: W * 0.7 });
    txt(`Page ${i + 1} of ${total}`,                                              PW - M - 80, PH - M - 10, { width: 80, align: 'right' });
  }

  pdf.end();
}

// ── Compose customer-address lines ───────────────────────────────────
function addrLines(a1, a2, city, post) {
  const cityLine = [city, post].filter(Boolean).join('-');
  return [a1, a2, cityLine].filter(Boolean).join('\n');
}

// ── 2-row × 2-column meta grid: 4 KVs in one box ─────────────────────
function drawMetaGrid(pdf, x, y, w, kvs) {
  const colW = w / 2;
  const rowH = 16;
  pdf.rect(x, y, w, rowH * 2).stroke();
  pdf.moveTo(x + colW, y).lineTo(x + colW, y + rowH * 2).stroke();
  pdf.moveTo(x, y + rowH).lineTo(x + w, y + rowH).stroke();
  for (let i = 0; i < kvs.length; i++) {
    const [label, val] = kvs[i];
    const cx = x + (i % 2) * colW;
    const cy = y + Math.floor(i / 2) * rowH;
    pdf.font('Helvetica-Bold').fontSize(8);
    pdf.text(label, cx + 4, cy + 4, { width: colW * 0.4 - 4, lineBreak: false });
    pdf.font('Helvetica').fontSize(8);
    pdf.text(String(val || ''), cx + colW * 0.4, cy + 4, { width: colW * 0.6 - 6, lineBreak: false });
  }
}

// ── Compact address-style labelled box (returns its height) ──────────
function drawAddrBox(pdf, x, y, w, title, kv) {
  let cur = y + 4;
  if (title) {
    pdf.font('Helvetica-Bold').fontSize(9).text(title, x + 5, cur, { width: w - 10, underline: true, lineBreak: false });
    cur += 12;
  }
  for (const [k, v] of Object.entries(kv)) {
    if (k === 'Address') {
      pdf.font('Helvetica-Bold').fontSize(8);
      pdf.text('Address', x + 5, cur, { width: w * 0.22, lineBreak: false });
      pdf.font('Helvetica').fontSize(8);
      pdf.text(': ' + (v || ''), x + 5 + w * 0.22, cur, { width: w * 0.78 - 10, lineBreak: true });
      cur = pdf.y + 1;
    } else {
      pdf.font('Helvetica-Bold').fontSize(8);
      pdf.text(k, x + 5, cur, { width: w * 0.32, lineBreak: false });
      pdf.font('Helvetica').fontSize(8);
      pdf.text(': ' + (v || ''), x + 5 + w * 0.32, cur, { width: w * 0.68 - 10, lineBreak: false });
      cur += 10;
    }
  }
  cur += 2;
  const h = cur - y;
  pdf.rect(x, y, w, h).stroke();
  return h;
}

// ── Items table column header (returns Y after) ──────────────────────
function drawItemsHeader(pdf, x, y, w, isCompanyA) {
  const cols = isCompanyA
    ? ['#', 'Description', 'HSN/SAC', 'Qty', 'Rate', 'Amount', 'CGST%', 'CGST', 'SGST%', 'SGST', 'IGST%', 'IGST', 'Total']
    : ['#', 'Description', 'HSN/SAC', 'Qty', 'Rate', 'Amount', 'Total'];
  const widths = isCompanyA
    ? [16, 126, 42, 36, 38, 50, 26, 36, 26, 36, 26, 36, 41]
    : [22, 240, 56, 56, 56, 56, 49];

  pdf.rect(x, y, w, 16).fillAndStroke('#eeeeee', '#666');
  pdf.fillColor('#000').font('Helvetica-Bold').fontSize(7);
  let cx = x;
  for (let i = 0; i < cols.length; i++) {
    pdf.text(cols[i], cx + 2, y + 4, { width: widths[i] - 4, align: i >= 3 ? 'right' : 'left', lineBreak: false });
    cx += widths[i];
  }
  return y + 16;
}

// ── Single items-row drawer ──────────────────────────────────────────
function drawItemRow(pdf, x, y, widths, idx, line, g, hsn, desc, isCompanyA) {
  const lineH = Math.max(22, pdf.heightOfString(desc, { width: widths[1] - 4 }) + 4);
  pdf.rect(x, y, widths.reduce((a,b)=>a+b,0), lineH).stroke();
  pdf.fillColor('#000').font('Helvetica').fontSize(7);

  let cx = x;
  const cell = (i, val, align = 'right') => {
    pdf.text(String(val ?? ''), cx + 2, y + 3, { width: widths[i] - 4, align, lineBreak: align === 'left' });
    cx += widths[i];
  };

  cell(0, idx, 'left');
  cell(1, desc, 'left');
  cell(2, hsn || '', 'left');
  cell(3, fmtN(line.Quantity, 0) + ' ' + (line.UoM || 'PCS'), 'right');
  cell(4, fmtN(line.UnitPrice, 4), 'right');
  cell(5, fmtN(line.LineAmount, 2), 'right');
  if (isCompanyA) {
    cell(6, fmtN(g.CGST?.pct || 0, 0), 'right');
    cell(7, fmtN(g.CGST?.amt || 0, 2), 'right');
    cell(8, fmtN(g.SGST?.pct || 0, 0), 'right');
    cell(9, fmtN(g.SGST?.amt || 0, 2), 'right');
    cell(10, fmtN(g.IGST?.pct || 0, 0), 'right');
    cell(11, fmtN(g.IGST?.amt || 0, 2), 'right');
    cell(12, fmtN(Number(line.LineAmount) + (g.CGST?.amt||0) + (g.SGST?.amt||0) + (g.IGST?.amt||0), 2), 'right');
  } else {
    cell(6, fmtN(line.LineAmount, 2), 'right');
  }
}

module.exports = { fetchInvoiceData, streamInvoicePdf };
