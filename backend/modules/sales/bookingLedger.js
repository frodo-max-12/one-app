// =====================================================================
// modules/sales/bookingLedger.js — Booking "freeze" capture (v1.11)
//
// NAV deletes a Sales Order once it is fully shipped + invoiced, so a live
// query of [Sales Header] under-reports booking for any PAST period. This
// module snapshots every OPEN sales-order line a few times a day into the App
// DB (dbo.BN_SalesBookingLedger) and NEVER deletes a row — so a completed
// order's booked value survives, keyed by Order Date. Budget-vs-Actual reads
// Booking from this ledger instead of the live table.
//
// NAV is READ-ONLY here (SELECT only); all writes go to BizNAV_App.
// captureBooking() is idempotent (MERGE upsert) — safe to run any time.
// =====================================================================

const cron = require('node-cron');
const { sql, getPool, getAppPool } = require('../../db');
const { COMPANIES } = require('../../shared/company');

const CHUNK = 2000;   // OPENJSON MERGE batch size

// Capture all currently-OPEN sales-order item lines for one company into the ledger.
async function captureCompany(company) {
  const P = company.prefix;
  const navPool = await getPool();
  const appPool = await getAppPool();

  const rs = await navPool.request().query(`
    SELECT SH.[No_] AS o, SL.[Line No_] AS l,
           CONVERT(VARCHAR(10), SH.[Order Date], 23) AS d,
           ISNULL(SH.[Salesperson Code], '')      AS s,
           ISNULL(SH.[Sell-to Customer Name], '') AS c,
           ISNULL(SL.[Unit Price], 0) * ISNULL(SL.[Quantity], 0) AS v
    FROM ${P}Sales Header] SH
    JOIN ${P}Sales Line] SL
      ON SL.[Document Type] = SH.[Document Type] AND SL.[Document No_] = SH.[No_]
    WHERE SH.[Document Type] = 1 AND ISNULL(SL.[Type], 0) = 2
      AND SH.[Order Date] >= '2020-01-01';`);

  const rows = rs.recordset;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    await appPool.request()
      .input('company', sql.NVarChar(10), company.code)
      .input('json', sql.NVarChar(sql.MAX), JSON.stringify(batch))
      .query(`
        MERGE dbo.BN_SalesBookingLedger AS t
        USING (
          SELECT o AS OrderNo, l AS LineNum, d AS OrderDate,
                 s AS SalespersonCode, c AS CustomerName, v AS LineValue
          FROM OPENJSON(@json) WITH (
            o NVARCHAR(20) '$.o', l INT '$.l', d DATE '$.d',
            s NVARCHAR(20) '$.s', c NVARCHAR(150) '$.c', v DECIMAL(18,4) '$.v'
          )
        ) AS src
        ON (t.Company = @company AND t.OrderNo = src.OrderNo AND t.LineNum = src.LineNum)
        WHEN MATCHED THEN UPDATE SET
          t.OrderDate = src.OrderDate, t.SalespersonCode = src.SalespersonCode,
          t.CustomerName = src.CustomerName, t.LineValue = src.LineValue, t.LastSeen = SYSDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (Company, OrderNo, LineNum, OrderDate, SalespersonCode, CustomerName, LineValue)
          VALUES (@company, src.OrderNo, src.LineNum, src.OrderDate, src.SalespersonCode, src.CustomerName, src.LineValue);`);
    upserted += batch.length;
  }
  return { company: company.code, seen: rows.length, upserted };
}

// Snapshot every company. Guarded so overlapping runs can't stack.
async function captureBooking() {
  if (global.__bookingCaptureRunning) { console.warn('[bookingLedger] capture skipped — already running'); return; }
  global.__bookingCaptureRunning = true;
  const results = [];
  try {
    for (const company of Object.values(COMPANIES)) {
      try { results.push(await captureCompany(company)); }
      catch (e) { console.error(`[bookingLedger] capture ${company.code} failed:`, e.message); }
    }
    console.log('[bookingLedger] captured', results.map(r => `${r.company}:${r.upserted}`).join(' '));
  } finally {
    global.__bookingCaptureRunning = false;
  }
  return results;
}

// Register the cron once (module is require()'d a single time at boot).
if (!global.__bookingLedgerCronRegistered) {
  global.__bookingLedgerCronRegistered = true;
  try {
    // Every 3 hours — keeps the current period fresh; open orders are captured
    // near their booked value long before they can complete + vanish.
    cron.schedule('15 */3 * * *', () => { captureBooking().catch(e => console.error('[bookingLedger] cron error:', e.message)); },
      { timezone: 'Asia/Kolkata' });
    // Backfill shortly after boot so booking isn't empty on a fresh start.
    setTimeout(() => { captureBooking().catch(e => console.error('[bookingLedger] startup capture error:', e.message)); }, 15000);
    console.log('[bookingLedger] capture cron registered (every 3h) + startup backfill in 15s');
  } catch (e) {
    console.error('[bookingLedger] cron registration failed:', e.message);
  }
}

module.exports = { captureBooking };
