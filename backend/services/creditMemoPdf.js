// =====================================================================
// services/creditMemoPdf.js — Sales Credit Memo PDF generator
//
// Renders a posted Sales Credit Memo to PDF in the NAV Report 207
// ("Sales - Credit Memo") layout, branching on company:
//   COMPANYA    → India header (GST/PAN/Bank A), Customer GST Reg No., GST split
//   COMPANYB → Singapore header (Bank B), no GST block
//
// Output is two pages:
//   Page 1 → "Sales - Credit Memo"
//   Page 2 → "Sales - Credit Memo COPY"
//
// Public API:
//   fetchCreditMemoData(company, memoNo) → { header, lines, billCustomer, ... }
//   streamCreditMemoPdf(data, res)       → writes PDF to res
//
// Read-only against NAV (Sales Cr_Memo Header + Line + Customer +
// Salesperson_Purchaser + Detailed GST Ledger Entry + State). Writes nothing.
// =====================================================================

const PDFDocument = require('pdfkit');
const { sql, getPool } = require('../db');

// ─── Date → "DD. MonthName YYYY" (matches Report 207 style) ───────────────
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
function fmtLongDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${dt.getDate()}. ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

// ─── Date → "DD-MM-YY" (used for the Posted Return Receipt Date column) ──
function fmtShortDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return [
    String(dt.getDate()).padStart(2, '0'),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getFullYear()).slice(-2),
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
// fetchCreditMemoData(company, memoNo)
// =====================================================================
async function fetchCreditMemoData(company, memoNo) {
  const pool = await getPool();
  const P    = company.prefix;
  const isCompanyA = company.code === 'COMPANYA';

  // ── Header ────────────────────────────────────────────────────────────
  const headerCols = `
    [No_]                          AS MemoNo,
    [Posting Date]                 AS PostingDate,
    [Document Date]                AS DocumentDate,
    [External Document No_]        AS ExtDocNo,
    [Pre-Assigned No_]             AS PreAssignedNo,
    [Applies-to Doc_ No_]          AS AppliesToDocNo,
    [Sell-to Customer No_]         AS SellToCustomerNo,
    [Bill-to Customer No_]         AS BillToCustomerNo,
    [Bill-to Name]                 AS BillToName,
    [Bill-to Name 2]               AS BillToName2,
    [Bill-to Address]              AS BillToAddress1,
    [Bill-to Address 2]            AS BillToAddress2,
    [Bill-to City]                 AS BillToCity,
    [Bill-to Post Code]            AS BillToPostCode,
    [Bill-to County]               AS BillToCounty,
    [Bill-to Country_Region Code]  AS BillToCountryCode,
    [Ship-to Name]                 AS ShipToName,
    [Ship-to Name 2]               AS ShipToName2,
    [Ship-to Address]              AS ShipToAddress1,
    [Ship-to Address 2]            AS ShipToAddress2,
    [Ship-to City]                 AS ShipToCity,
    [Ship-to Post Code]            AS ShipToPostCode,
    [Ship-to County]               AS ShipToCounty,
    [Ship-to Country_Region Code]  AS ShipToCountryCode,
    [Currency Code]                AS CurrencyCode,
    [Salesperson Code]             AS SalespersonCode,
    [Payment Terms Code]           AS PaymentTermsCode,
    CAST([Prices Including VAT] AS bit) AS PricesIncludingVAT,
    [VAT Registration No_]         AS BillToVATRegNo
  `;

  const hRes = await pool.request()
    .input('memo', sql.NVarChar, memoNo)
    .query(`SELECT TOP 1 ${headerCols} FROM ${P}Sales Cr_Memo Header] WHERE [No_] = @memo`);
  const header = hRes.recordset[0] || null;
  if (!header) return null;

  // ── Lines (all types — credit memos can include G/L Account, Item, Charge) ──
  const lRes = await pool.request()
    .input('memo', sql.NVarChar, memoNo)
    .query(`
      SELECT
        [Line No_]              AS LineNo_,
        [Type]                  AS LineType,
        [No_]                   AS ItemNo,
        [Description]           AS Description,
        [Description 2]         AS Description2,
        ISNULL([Quantity], 0)   AS Quantity,
        ISNULL([Unit of Measure], '') AS UoM,
        ISNULL([Unit Price], 0) AS UnitPrice,
        ISNULL([Line Discount _], 0)       AS LineDiscPct,
        ISNULL([Line Discount Amount], 0)  AS LineDiscAmt,
        ISNULL([Line Amount], 0)           AS LineAmount,
        ISNULL([Amount], 0)                AS Amount,
        ISNULL([Amount Including VAT], 0)  AS AmountInclVAT,
        ISNULL([HSN_SAC Code], '')         AS HSN,
        ISNULL([VAT _], 0)                 AS VATPct,
        ISNULL([Shipment Date], NULL)      AS ShipmentDate,
        ISNULL([Return Receipt No_], '')   AS ReturnReceiptNo
      FROM ${P}Sales Cr_Memo Line]
      WHERE [Document No_] = @memo
      ORDER BY [Line No_]
    `);
  const lines = lRes.recordset || [];

  // ── Item master lookup — for Vendor Item No (MPN) shown in "No." column ──
  // NAV's [No_] on Cr_Memo Line is the internal item code (e.g. "RETAILER-A20") which
  // is too long for Report 207's narrow "No." column and not meaningful to the
  // customer. We show the manufacturer part number instead.
  const itemNos = [...new Set(lines.filter(l => l.LineType === 2).map(l => l.ItemNo).filter(Boolean))];
  const itemMap = {};
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

  // ── GST split per line (COMPANYA only) ─────────────────────────────────────
  // Detailed GST Ledger Entry stores CGST/SGST/IGST as separate rows;
  // pivot by [Document Line No_] × [GST Component Code].
  const gstByLine = {};
  if (isCompanyA) {
    try {
      const gRes = await pool.request()
        .input('memo', sql.NVarChar, memoNo)
        .query(`
          SELECT
            [Document Line No_]      AS DocLineNo,
            [GST Component Code]     AS Component,
            [GST _]                  AS Pct,
            [GST Base Amount]        AS BaseAmt,
            [GST Amount]             AS Amt
          FROM ${P}Detailed GST Ledger Entry]
          WHERE [Document No_] = @memo
        `);
      for (const row of gRes.recordset) {
        const ln = row.DocLineNo;
        if (!gstByLine[ln]) gstByLine[ln] = {};
        const c = String(row.Component || '').toUpperCase();
        gstByLine[ln][c] = {
          pct:  Number(row.Pct  || 0),
          amt:  Math.abs(Number(row.Amt  || 0)),
          base: Math.abs(Number(row.BaseAmt || 0)),
        };
      }
    } catch (e) {
      // Detailed GST Ledger Entry may be missing on some setups — totals will show 0 GST.
      console.warn('Credit memo GST lookup failed:', e.message);
    }
  }

  // ── Customer master (Bill-to) — for GST/PAN/Phone/Contact/Email ───────
  const custRes = await pool.request()
    .input('id', sql.NVarChar, header.BillToCustomerNo)
    .query(`
      SELECT TOP 1
        [No_], [Name],
        [Phone No_]  AS Phone,
        [E-Mail]     AS Email,
        [Contact],
        ${isCompanyA ? '[GST Registration No_] AS GSTNo,' : "'' AS GSTNo,"}
        [State Code] AS StateCode,
        ${isCompanyA ? '[P_A_N_ No_] AS PAN,' : "'' AS PAN,"}
        [Country_Region Code] AS CountryCode
      FROM ${P}Customer]
      WHERE [No_] = @id
    `);
  const billCust = custRes.recordset[0] || null;

  // ── Salesperson ───────────────────────────────────────────────────────
  let salesperson = null;
  if (header.SalespersonCode) {
    const spRes = await pool.request()
      .input('c', sql.NVarChar, header.SalespersonCode)
      .query(`SELECT TOP 1 [Code], [Name] FROM ${P}Salesperson_Purchaser] WHERE [Code]=@c`);
    salesperson = spRes.recordset[0] || null;
  }

  // ── Totals ────────────────────────────────────────────────────────────
  let totalAmount = 0;             // sum of line Amount (pre-tax)
  let totalCGST = 0, totalSGST = 0, totalIGST = 0;
  let totalExcise = 0, totalTax = 0;
  for (const line of lines) {
    totalAmount += Number(line.Amount || 0);
    const g = gstByLine[line.LineNo_] || {};
    totalCGST += g.CGST?.amt || 0;
    totalSGST += g.SGST?.amt || 0;
    totalIGST += g.IGST?.amt || 0;
  }
  const totalInclTaxes = totalAmount + totalCGST + totalSGST + totalIGST + totalExcise + totalTax;

  return {
    company,
    header,
    lines,
    itemMap,
    gstByLine,
    billCustomer:  billCust,
    salesperson,
    totals: {
      amount:        totalAmount,
      excise:        totalExcise,
      tax:           totalTax,
      cgst:          totalCGST,
      sgst:          totalSGST,
      igst:          totalIGST,
      inclTaxes:     totalInclTaxes,
    },
  };
}

// =====================================================================
// streamCreditMemoPdf(data, res)
// =====================================================================
//
// Renders TWO pages:
//   Page 1 → "Sales - Credit Memo"
//   Page 2 → "Sales - Credit Memo COPY"
// Layout strictly follows NAV Report 207. A4 portrait, 50pt margins.
// =====================================================================
function streamCreditMemoPdf(data, res) {
  const pdf = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: false });
  pdf.pipe(res);

  const isCompanyA        = data.company.code === 'COMPANYA';
  const currencyCode = data.header.CurrencyCode && data.header.CurrencyCode.trim()
                         ? data.header.CurrencyCode.trim()
                         : data.company.currency;

  const PW  = pdf.page ? pdf.page.width  : 595;   // A4 width
  const PH  = pdf.page ? pdf.page.height : 842;
  const M   = 50;

  // Helper: short text with no auto-page-break
  function txt(pdf, str, x, y, opts) {
    pdf.text(String(str ?? ''), x, y, { lineBreak: false, ...opts });
  }
  function wrap(pdf, str, x, y, w, opts) {
    pdf.text(String(str ?? ''), x, y, { width: w, lineBreak: true, ...opts });
  }

  // Render one full credit memo page (the title text is parameterized so
  // page 1 prints "Sales - Credit Memo" and page 2 prints "Sales - Credit Memo COPY")
  function drawPage(title) {
    pdf.addPage();
    const W       = pdf.page.width - 2 * M;
    const halfW   = W * 0.47;             // each top column gets ~47% of page; small gutter between
    const rightX  = M + W - halfW;

    // ── Top-left: Bill-to address block (lineBreak:true with auto-Y) ──
    pdf.font('Helvetica').fontSize(10);
    let yL = M;
    const billLines = [
      data.header.BillToName,
      data.header.BillToName2,
      data.header.BillToAddress1,
      data.header.BillToAddress2,
      [data.header.BillToCity, data.header.BillToPostCode].filter(Boolean).join(' '),
      countryName(data.header.BillToCountryCode),
    ].filter(s => s && String(s).trim());
    for (const ln of billLines) {
      pdf.text(ln, M, yL, { width: halfW, lineBreak: true });
      yL = pdf.y + 1;
    }

    // ── Top-right: Title + page indicator + company address ───────────
    pdf.font('Helvetica-Bold').fontSize(16);
    txt(pdf, title, rightX, M, { width: halfW, align: 'right' });

    pdf.font('Helvetica').fontSize(9);
    txt(pdf, 'Page 1 of 1', rightX, M + 22, { width: halfW, align: 'right' });

    let yR = M + 38;
    const companyLines = isCompanyA
      ? [
          'Company A Pvt Ltd',
          'No. 64/2A/6NR-Swami Vivekanand Garden,Lane No.6,',
          'Hagawane Nagar,Example Area, Phase 2',
          '411048 Pune',
          'India',
        ]
      : [
          'Company B Pte Ltd',
          'Blk 3025, UBI Road 3, #03-123,',
          'Singapore',
          '',
          '',
        ];
    pdf.font('Helvetica').fontSize(9);
    for (const ln of companyLines) {
      if (!ln) { yR += 11; continue; }
      pdf.text(ln, rightX, yR, { width: halfW, align: 'right', lineBreak: true });
      yR = pdf.y + 1;
    }

    // ── Begin lower-info section (start a bit below either column) ────
    let y = Math.max(yL, yR) + 18;

    // Right-side info block: Phone/Home/Email/VAT/Giro/Bank/Acc/Salesperson/CompReg/CustGSTReg
    // Two-column right-aligned: [label .... value] right-aligned to page.
    // Value column has to fit "billing@company-b.example" (~145pt at 9pt),
    // so we keep the label narrow and let value claim most of the right block.
    const rightInfoX = M + W * 0.42;       // right info block start
    const rightInfoW = W - W * 0.42;
    const labelW     = rightInfoW * 0.42;
    const valueW     = rightInfoW * 0.58 - 4;
    const valueX     = rightInfoX + labelW + 4;

    const rightInfo = isCompanyA
      ? [
          ['Phone No.',                  '+91 00000 00000'],
          ['Home Page',                  'www.company-b.example'],
          ['E-Mail',                     'billing@company-b.example'],
          ['VAT Registration No.',       '27000000000V'],
          ['Giro No.',                   ''],
          ['Bank',                       'EXAMPLE BANK'],
          ['Account No.',                '000000000000'],
          ['Salesperson',                data.salesperson?.Name || data.header.SalespersonCode || ''],
          ['Company Registration No.',   '27AAAAA0000A1Z5'],
          ['Customer GST Reg No.',       data.billCustomer?.GSTNo || ''],
        ]
      : [
          ['Phone No.',                  '+65 0000 0000'],
          ['Home Page',                  'www.company-b.example'],
          ['E-Mail',                     'sales@company-b.example'],
          ['Bank',                       'Example Bank'],
          ['Account No.',                '000000000000'],
          ['SWIFT Code',                 'EXMPSGSG'],
          ['Salesperson',                data.salesperson?.Name || data.header.SalespersonCode || ''],
        ];

    // Left-side info: Bill-to Customer No / Credit Memo No / Posting Date / Document Date / Prices Including VAT
    const leftInfoX = M;
    const leftInfoW = W * 0.40 - 6;
    const leftLabelW = leftInfoW * 0.50;
    const leftValueX = leftInfoX + leftLabelW + 4;
    const leftValueW = leftInfoW - leftLabelW - 4;

    const leftInfo = [
      ['Bill-to Customer No.', data.header.BillToCustomerNo || ''],
      ['Credit Memo No.',      data.header.MemoNo || ''],
      ['',                     ''],
      ['Posting Date',         fmtLongDate(data.header.PostingDate)],
      ['Document Date',        fmtLongDate(data.header.DocumentDate)],
      ['Prices Including VAT', data.header.PricesIncludingVAT ? 'Yes' : 'No'],
    ];

    // Render both columns row-by-row; height = max(left rows, right rows) × 11
    pdf.fontSize(9);
    const rowH = 11;
    const totalRows = Math.max(leftInfo.length, rightInfo.length);
    for (let i = 0; i < totalRows; i++) {
      const yy = y + i * rowH;
      if (i < leftInfo.length) {
        const [lab, val] = leftInfo[i];
        if (lab) {
          pdf.font('Helvetica-Bold');
          txt(pdf, lab, leftInfoX, yy, { width: leftLabelW });
          pdf.font('Helvetica');
          txt(pdf, val, leftValueX, yy, { width: leftValueW });
        }
      }
      if (i < rightInfo.length) {
        const [lab, val] = rightInfo[i];
        pdf.font('Helvetica-Bold');
        txt(pdf, lab, rightInfoX, yy, { width: labelW });
        pdf.font('Helvetica');
        txt(pdf, val, valueX, yy, { width: valueW, align: 'right' });
      }
    }
    y += totalRows * rowH + 28;

    // ── Lines table ───────────────────────────────────────────────────
    // Columns: # | Description | Quantity | Posted Return Receipt Date |
    //          Unit of Measure | Unit Price | Discount % |
    //          Line Discount Amount | Amount
    // Total width must equal W (495pt on A4 with 50pt margins).
    // "No." is sized to fit typical manufacturer part numbers (Vendor Item No_)
    // like "RETAILER-A20"; longer MPNs are JS-truncated below (pdfkit's ellipsis
    // option does not override the implicit width-wrap, so we have to cap the
    // string ourselves to keep the row aligned with adjacent cells).
    const cols = [
      { label: 'No.',                 w: 65,  align: 'left'  },
      { label: 'Description',         w: 110, align: 'left'  },
      { label: 'Quantity',            w: 40,  align: 'right' },
      { label: 'Posted Return\nReceipt Date', w: 48,  align: 'right' },
      { label: 'Unit of\nMeasure',    w: 36,  align: 'left'  },
      { label: 'Unit Price',          w: 50,  align: 'right' },
      { label: 'Discount\n%',         w: 40,  align: 'right' },
      { label: 'Line\nDiscount\nAmount', w: 50, align: 'right' },
      { label: 'Amount',              w: 0,   align: 'right' },   // 0 = fill rest
    ];
    const fixedW = cols.slice(0, -1).reduce((a, c) => a + c.w, 0);
    cols[cols.length - 1].w = W - fixedW;

    // Header at 7pt — Report 207's narrow columns force multi-line labels;
    // 7pt lets "Quantity" / "Discount" fit on one line instead of wrapping
    // mid-word.
    pdf.font('Helvetica-Bold').fontSize(7);
    let cx = M;
    const headerH = 22;
    for (const col of cols) {
      pdf.text(col.label, cx + 2, y, { width: col.w - 4, align: col.align, lineBreak: true });
      cx += col.w;
    }
    y += headerH;
    pdf.moveTo(M, y - 2).lineTo(M + W, y - 2).lineWidth(0.6).stroke();
    y += 4;

    // Body
    pdf.font('Helvetica').fontSize(9);
    for (const line of data.lines) {
      // Skip placeholder/blank lines (Type=0 with empty Description)
      if (!line.Description && !Number(line.Amount || 0)) continue;

      // Description may include "Description 2" appended on a new line.
      const descParts = [line.Description, line.Description2]
        .map(s => (s || '').toString().trim())
        .filter(Boolean);
      const desc = descParts.join('\n');

      const lineH = Math.max(14, pdf.heightOfString(desc, { width: cols[1].w - 4 }) + 4);

      // "No." column: show Vendor Item No (MPN) for Type=Item rows; G/L
      // and Charge lines render blank to match NAV Report 207's HideValue
      // behavior. Falls back to NAV Item No if MPN is missing.
      // JS-truncate to ~22 chars so long MPNs don't wrap into a 2nd / 3rd
      // line and visually overlap the next row.
      const item = data.itemMap[line.ItemNo] || {};
      let noCell = '';
      if (line.LineType === 2) {
        const mpn = (item.MPN || '').trim();
        const itm = (line.ItemNo || '').trim();
        const candidate = mpn || itm;
        noCell = candidate.length > 22 ? candidate.slice(0, 19) + '...' : candidate;
      }

      const values = [
        noCell,
        desc,
        line.Quantity ? fmtN(line.Quantity, 0) : '',
        fmtShortDate(line.ShipmentDate || data.header.PostingDate),
        line.UoM || '',
        Number(line.UnitPrice) ? fmtN(line.UnitPrice, 2) : '',
        Number(line.LineDiscPct) ? fmtN(line.LineDiscPct, 2) : '',
        fmtN(line.LineDiscAmt || 0, 2),
        fmtN(line.Amount || 0, 2),
      ];
      pdf.font('Helvetica').fontSize(8);    // body font for the line-item row
      cx = M;
      for (let i = 0; i < cols.length; i++) {
        // Only Description wraps. Every other cell is height-clamped to one
        // line so a long value can never push the row taller than the
        // Description-driven lineH (which would visually misalign cells).
        pdf.text(values[i], cx + 2, y, {
          width: cols[i].w - 4,
          height: i === 1 ? undefined : 12,
          align: cols[i].align,
          lineBreak: i === 1,
          ellipsis: true,
        });
        cx += cols[i].w;
      }
      y += lineH;
    }

    // Underline before totals
    y += 4;
    pdf.moveTo(M + W * 0.55, y).lineTo(M + W, y).lineWidth(0.6).stroke();
    y += 6;

    // ── Totals strip (right-aligned) ──────────────────────────────────
    // Component rows are conditional on whether GST split exists.
    const totalsRows = [
      [`Total ${currencyCode}`,        data.totals.amount,    true],
      [`Excise Amount`,                data.totals.excise,    false],
      [`Tax Amount`,                   data.totals.tax,       false],
      ...(isCompanyA && data.totals.cgst ? [['CGST Amount',        data.totals.cgst, false]] : []),
      ...(isCompanyA && data.totals.sgst ? [['SGST Amount',        data.totals.sgst, false]] : []),
      ...(isCompanyA && data.totals.igst ? [['IGST Amount',        data.totals.igst, false]] : []),
      [`Total ${currencyCode} Incl. Taxes`, data.totals.inclTaxes, true],
    ];
    const totalsLabelX = M + W * 0.55;
    const totalsLabelW = W * 0.30;
    const totalsValX   = M + W * 0.85;
    const totalsValW   = W * 0.15;

    for (const [lab, val, bold] of totalsRows) {
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      txt(pdf, lab, totalsLabelX, y, { width: totalsLabelW, align: 'right' });
      txt(pdf, fmtN(val, 2), totalsValX, y, { width: totalsValW, align: 'right' });
      y += 12;
      // Double-underline under the "Total <CCY>" subtotal row
      if (bold && lab.startsWith('Total ') && !lab.includes('Incl.')) {
        pdf.moveTo(totalsLabelX, y - 2).lineTo(M + W, y - 2).lineWidth(0.5).stroke();
        y += 2;
      }
    }
    // Underline above "Total INR Incl. Taxes"
    pdf.moveTo(totalsLabelX, y - 14).lineTo(M + W, y - 14).lineWidth(0.5).stroke();

    // ── Ship-to Address at bottom-left ────────────────────────────────
    const shipToY = pdf.page.height - M - 90;
    pdf.font('Helvetica-Bold').fontSize(10);
    txt(pdf, 'Ship-to Address', M, shipToY);
    pdf.font('Helvetica').fontSize(9);
    let sy = shipToY + 14;
    const shipLines = [
      data.header.ShipToName,
      data.header.ShipToName2,
      data.header.ShipToAddress1,
      data.header.ShipToAddress2,
      [data.header.ShipToCity, data.header.ShipToPostCode].filter(Boolean).join(' '),
      countryName(data.header.ShipToCountryCode),
    ].filter(s => s && String(s).trim());
    for (const ln of shipLines) {
      pdf.text(ln, M, sy, { width: W * 0.5, lineBreak: true });
      sy = pdf.y + 1;
    }
  }

  drawPage('Sales - Credit Memo');
  drawPage('Sales - Credit Memo COPY');

  pdf.end();
}

// ── Country code → readable name (lightweight, only what NAV uses here) ─
// Some NAV setups store the full country name in [Country_Region Code]
// (e.g. "INDIA") instead of the ISO code ("IN") — normalize either to
// title-case "India" so bill-to and ship-to don't render in different cases.
function countryName(code) {
  if (!code) return '';
  const map = { IN: 'India', SG: 'Singapore', US: 'United States', GB: 'United Kingdom', AE: 'United Arab Emirates' };
  const upper = code.toString().trim().toUpperCase();
  if (map[upper]) return map[upper];
  // Title-case the raw string ("INDIA" → "India")
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

module.exports = { fetchCreditMemoData, streamCreditMemoPdf };
