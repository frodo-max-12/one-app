// =====================================================================
// modules/sales/exStock.js — the ONE definition of "Ex-Stock inventory".
//
// Ex-Stock is a STOCK figure, not a period flow: it is EVERY open Ex-Stock sales-order line
// as of a date (Posting Date <= @asof, cumulative) — not just the lines ordered inside a
// period. Sales Line [Remarks] carries the Pune ex-stock tag; observed values include
// 'EX', 'BPJL-26 EX COMPANYA', 'BPD-26 EX-COMPANYA', 'EX-STOCK WITH VENDOR' — hence LIKE '%EX%'.
//
// This mirrors `routes/inventory.js` → handleSOInventory (the Inventory page, mode=soInventory)
// so Budget vs Actual and the Inventory page can never disagree. If the Inventory page's rule
// changes, change it HERE and there together.
// =====================================================================

// Line-level filters (charge/round-off lines and item-less lines are excluded, exactly as
// the Inventory page does; the Item INNER JOIN below does the rest).
const EX_STOCK_WHERE = `
        AND ISNULL(h.[Salesperson Code],'') <> ''
        AND TRY_CAST(l.[Quantity] AS DECIMAL(18,4)) IS NOT NULL
        AND ISNULL(l.[Quantity],0) <> 0
        AND ISNULL(l.[No_],'') <> ''
        AND ISNULL(l.[Remarks],'') LIKE '%EX%'
        AND ISNULL(l.[Description],'') NOT IN ('Invoice Round Account','Freight,Transport and Courier charges Indirect')`;

// Value = [Amount] (net of line discount) falling back to Qty × Unit Price when Amount is 0.
const EX_STOCK_VALUE = `CAST(CASE WHEN ISNULL(l.[Amount],0) <> 0 THEN l.[Amount]
                                  ELSE ISNULL(l.[Quantity],0) * ISNULL(l.[Unit Price],0) END AS DECIMAL(18,4))`;

// Build an Ex-Stock aggregate. `select`/`groupBy` are caller-supplied; the caller MUST bind
// @asof (sql.Date) and any parameters referenced by `scope`.
function exStockSQL(P, { select, groupBy, orderBy, scope = '' }) {
  return `
      SELECT ${select}
      FROM ${P}Sales Header] h
      INNER JOIN ${P}Sales Line] l ON l.[Document No_] = h.[No_]
      INNER JOIN ${P}Item] itm ON itm.[No_] = UPPER(LTRIM(RTRIM(l.[No_])))
      WHERE CAST(h.[Posting Date] AS DATE) <= @asof ${EX_STOCK_WHERE} ${scope}
      GROUP BY ${groupBy}${orderBy ? `\n      ORDER BY ${orderBy}` : ''};`;
}

module.exports = { EX_STOCK_WHERE, EX_STOCK_VALUE, exStockSQL };
