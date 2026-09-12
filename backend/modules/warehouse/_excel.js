// =====================================================================
// modules/warehouse/_excel.js — shared XLSX helpers for import + export.
// Used by every /import and /export endpoint in the warehouse module.
// Same parsing logic as scripts/import_warehouse_excel.js, kept in sync.
// =====================================================================

const xlsx = require('xlsx');
// xlsx-js-style is a drop-in superset of xlsx that adds cell-style writing
// (alignment / fill / font / border). Used only for the export side so the
// merged-cell rendering matches the home table — vertical-center alignment.
const xlsxStyle = require('xlsx-js-style');

const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Try multiple header candidates; first one that matches (case+punct insensitive) wins.
function cell(row, headers, ...candidates) {
  for (const name of candidates) {
    const target = _norm(name);
    const i = headers.findIndex(h => _norm(h) === target);
    if (i >= 0) return row[i];
  }
  return null;
}

// Auto-detect header row + return data rows below it.
//
// The warehouse Excel has a REMARKS row ABOVE the real headers:
//   row 0 = "Manually Insert | Entry No | Dropdown | Manually Insert | ..."
//   row 1 = "Matrl. Received Date | System No. | Purchase / Expence | ..."
// Real headers are unique, short identifiers. Remark rows have lots of
// duplicate cells ("Manually Insert" 15+ times) and/or sentence-length cells.
function readSheet(wb, sheetName) {
  const sh = wb.Sheets[sheetName];
  if (!sh) return { headers: [], rows: [], headerIdx: -1 };
  const raw = xlsx.utils.sheet_to_json(sh, { header: 1, defval: null, raw: true });

  function looksLikeHeader(rowArr) {
    const strs = (rowArr || []).filter(c => typeof c === 'string' && c.trim()).map(c => c.trim());
    if (strs.length < 3) return false;
    // Reject if too many cells are sentence-length (annotation row).
    const longCount = strs.filter(c => c.length > 30).length;
    if (longCount / strs.length > 0.15) return false;
    // Reject if the row has heavy duplication — remark rows repeat phrases
    // like "Manually Insert" over many columns. Real headers are unique.
    const unique = new Set(strs.map(c => c.toLowerCase().replace(/\s+/g, ' ')));
    if (unique.size / strs.length < 0.6) return false;
    // Reject if the row CONTAINS remark keywords across multiple cells.
    const remarkRx = /^(manually\s+insert|just\s+add|purchase\s+line|vendor\s+table|sum\s+of|dropdown|entry\s+no|take\s+from|from\s+gl|check\s+as\s+per|total|computed)$/i;
    const remarkHits = strs.filter(c => remarkRx.test(c)).length;
    if (remarkHits >= 2) return false;
    return true;
  }

  let headerIdx = -1;
  for (let i = 0; i < Math.min(6, raw.length); i++) {
    if (looksLikeHeader(raw[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return { headers: [], rows: [], headerIdx: -1 };
  const headers = (raw[headerIdx] || []).map(h => h === null ? '' : String(h).trim());
  const rows = raw.slice(headerIdx + 1).filter(r => r.some(c => c !== null && c !== ''));
  return { headers, rows, headerIdx };
}

// Find the sheet whose name contains any of the given keywords (case+punct
// insensitive). Accepts a string or array — useful for the user's typos like
// "Expencess" where 'expense' alone wouldn't match.
function resolveSheet(wb, keywords) {
  const ks = Array.isArray(keywords) ? keywords : [keywords];
  for (const kw of ks) {
    const k = _norm(kw);
    const found = wb.SheetNames.find(s => _norm(s).includes(k));
    if (found) return found;
  }
  return null;
}

// ── Type coercers ──────────────────────────────────────────────────────
function toStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function toInt(v) { const n = toNum(v); return n === null ? null : Math.trunc(n); }
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {                      // Excel serial date
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + v * 86400000);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function toBool(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).toLowerCase().trim();
  if (['yes','y','true','1','received','done'].includes(s)) return true;
  if (['no','n','false','0','pending','not received'].includes(s)) return false;
  return null;
}

// ── Build an XLSX buffer from an array of rows ────────────────────────
// columns: [{ key, label, type? }]  (type used only for date formatting)
// opts:    { mergeKeys?: string[], mergeScopeKey?: string }
//   mergeKeys     — column keys whose consecutive-identical-value runs
//                   should be merged into one cell (rowspan-style).
//   mergeScopeKey — restricts merging to runs where this OTHER key is
//                   also identical (e.g. set 'InvoiceNo' to keep Carton
//                   merges from spanning across different invoices).
//                   Scope only applies to keys OTHER than itself; the
//                   scope key itself merges globally.
function buildXlsx(rows, columns, sheetName, opts) {
  opts = opts || {};
  const mergeKeys     = Array.isArray(opts.mergeKeys) ? opts.mergeKeys : [];
  const mergeScopeKey = opts.mergeScopeKey || null;

  const ws_data = [columns.map(c => c.label)];
  for (const r of rows) {
    ws_data.push(columns.map(c => {
      let v = r[c.key];
      if (v === undefined || v === null) return '';
      if (c.type === 'date' && v) {
        const d = new Date(v);
        if (!isNaN(d)) return d.toISOString().slice(0, 10);
      }
      return v;
    }));
  }
  const ws = xlsxStyle.utils.aoa_to_sheet(ws_data);
  ws['!cols'] = columns.map(c => ({ wch: Math.max(10, c.label.length + 2) }));

  // Build merge ranges + apply vertical-center alignment to merged cells.
  // ws['!merges'] is the SheetJS array of {s:{r,c}, e:{r,c}} ranges.
  if (mergeKeys.length && rows.length) {
    const merges = ws['!merges'] || [];
    const sameStr = (a, b) =>
      a != null && b != null && String(a).trim() !== '' && String(a) === String(b);
    for (const key of mergeKeys) {
      const colIdx = columns.findIndex(c => c.key === key);
      if (colIdx < 0) continue;
      const isScopeKey = key === mergeScopeKey;
      let runStart = 0;
      const closeRun = (endExclusive) => {
        const len = endExclusive - runStart;
        if (len > 1) {
          // +1 for the header row
          const startRow = runStart + 1;
          const endRow   = endExclusive; // endExclusive - 1 + 1 (header offset)
          merges.push({ s: { r: startRow, c: colIdx }, e: { r: endRow, c: colIdx } });
          // Apply vertical-center alignment to the top-left cell of the
          // merged range (Excel renders content of just that cell).
          const cellRef = xlsxStyle.utils.encode_cell({ r: startRow, c: colIdx });
          if (!ws[cellRef]) ws[cellRef] = { t: 's', v: '' };
          ws[cellRef].s = Object.assign({}, ws[cellRef].s, {
            alignment: { vertical: 'center', horizontal: 'center', wrapText: true },
          });
        }
        runStart = endExclusive;
      };
      for (let i = 1; i < rows.length; i++) {
        const eq = sameStr(rows[i - 1][key], rows[i][key]);
        const scopeOK = (!mergeScopeKey || isScopeKey)
          ? true
          : sameStr(rows[i - 1][mergeScopeKey], rows[i][mergeScopeKey]);
        if (!(eq && scopeOK)) closeRun(i);
      }
      closeRun(rows.length);
    }
    if (merges.length) ws['!merges'] = merges;
  }

  const wb = xlsxStyle.utils.book_new();
  xlsxStyle.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
  return xlsxStyle.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  xlsx, _norm, cell, readSheet, resolveSheet,
  toStr, toNum, toInt, toDate, toBool,
  buildXlsx,
};
