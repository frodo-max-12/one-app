// =====================================================================
// services/notificationCron.js — scheduled + polled notification generators
//
// Two node-cron jobs (Asia/Kolkata), both OFF by default (NOTIF_CRON_ENABLED):
//   • DAILY SCAN  (NOTIF_SCAN_CRON, default 08:30) — "due/date" alerts:
//       visit today · overdue AR · PDC lapsed · holiday tomorrow
//   • NAV POLL    (NOTIF_POLL_CRON, default every 20 min) — "it just happened":
//       invoice created · SO line → Ex-Stock · payment received
//
// Every detector is wrapped in its own try/catch so one bad query never stops the
// rest. NAV-poll detectors BASELINE silently on first run (seed state, notify
// nothing) so we never blast history. Owner→user resolution reuses the standard
// CompanyACode/CompanyBCode → User_Login mapping.
//
// SAFETY: default-disabled. Validate with POST /api/notifications/run-scan (admin)
// before setting NOTIF_CRON_ENABLED=true in the server .env.
// =====================================================================
const cron = require('node-cron');
const { getPool, getAppPool, getSmartSysPool, sql } = require('../db');
const { COMPANIES, getCompanyByCode } = require('../shared/company');
const { notify } = require('./notify');

const CRON_ENABLED = String(process.env.NOTIF_CRON_ENABLED || '').toLowerCase() === 'true';
const SCAN_CRON = process.env.NOTIF_SCAN_CRON || '30 8 * * *';     // daily 08:30 IST
const POLL_CRON = process.env.NOTIF_POLL_CRON || '*/20 * * * *';   // every 20 min
const COMPANY_CODES = ['COMPANYA', 'COMPANYB'];

// ── helpers ──────────────────────────────────────────────────────────────────
function prefixOf(code) { return getCompanyByCode(code).prefix; }   // '[dbo].[Company A Pvt_ Ltd_$'
function tbl(code, name) { return `${prefixOf(code)}${name}]`; }

function fmtAmt(n, code) {
  const sym = code === 'COMPANYB' ? '$' : 'INR ';
  const loc = code === 'COMPANYB' ? 'en-US' : 'en-IN';
  return sym + new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
}
const splitCodes = (s) => String(s || '').split('/').map(x => x.trim()).filter(Boolean);

// Build an index of active logins: code→[userId] (per company), username→id, email→id.
async function loadUserIndex(appPool) {
  const r = await appPool.request().query(
    'SELECT Id, Username, Email, CompanyACode, CompanyBCode FROM dbo.User_Login WHERE IsActive=1');
  const idx = { COMPANYA: new Map(), COMPANYB: new Map(), byUser: new Map(), byEmail: new Map(), allIds: [] };
  for (const u of r.recordset) {
    idx.allIds.push(u.Id);
    if (u.Username) idx.byUser.set(String(u.Username).toLowerCase().trim(), u.Id);
    if (u.Email) idx.byEmail.set(String(u.Email).toLowerCase().trim(), u.Id);
    for (const c of splitCodes(u.CompanyACode)) { if (!idx.COMPANYA.has(c)) idx.COMPANYA.set(c, []); idx.COMPANYA.get(c).push(u.Id); }
    for (const c of splitCodes(u.CompanyBCode)) { if (!idx.COMPANYB.has(c)) idx.COMPANYB.set(c, []); idx.COMPANYB.get(c).push(u.Id); }
  }
  return idx;
}

// Resolve an owner key (NAV salesperson code, or an FAE username/email) to user ids.
function resolveOwners(idx, key) {
  if (!key) return [];
  const out = new Set();
  (idx.COMPANYA.get(key) || []).forEach(id => out.add(id));
  (idx.COMPANYB.get(key) || []).forEach(id => out.add(id));
  const byU = idx.byUser.get(String(key).toLowerCase().trim()); if (byU) out.add(byU);
  const byE = idx.byEmail.get(String(key).toLowerCase().trim()); if (byE) out.add(byE);
  return [...out];
}

// Watermark get/set (BN_NotifWatermark).
async function getWatermark(appPool, key) {
  const r = await appPool.request().input('k', sql.NVarChar(60), key)
    .query('SELECT WmValue, WmDateTime FROM dbo.BN_NotifWatermark WHERE WmKey=@k');
  return r.recordset[0] || null;
}
async function setWatermark(appPool, key, value, dateTime) {
  await appPool.request()
    .input('k', sql.NVarChar(60), key)
    .input('v', sql.NVarChar(200), value == null ? null : String(value))
    .input('d', sql.DateTime2, dateTime || null)
    .query(`MERGE dbo.BN_NotifWatermark AS t USING (SELECT @k AS K) s ON t.WmKey=s.K
            WHEN MATCHED THEN UPDATE SET WmValue=@v, WmDateTime=@d, UpdatedAt=SYSDATETIME()
            WHEN NOT MATCHED THEN INSERT (WmKey, WmValue, WmDateTime) VALUES (@k,@v,@d);`);
}

// ════════════════════════════ DAILY SCAN DETECTORS ═══════════════════════════

// Visits planned for today (BN_VisitPlan; COMPANYA manual plans). One digest per rep.
async function detectVisitsToday(appPool, idx, stats) {
  const r = await appPool.request().query(`
    SELECT SalespersonCode, COUNT(*) AS Cnt
    FROM dbo.BN_VisitPlan
    WHERE ISNULL(BeatId,0)=0 AND ISNULL(VisitDone,0)=0
      AND CONVERT(VARCHAR(10),VisitDate,23)=CONVERT(VARCHAR(10),GETDATE(),23)
    GROUP BY SalespersonCode`);
  const today = new Date().toISOString().slice(0, 10);
  for (const row of r.recordset) {
    for (const uid of resolveOwners(idx, row.SalespersonCode)) {
      const res = await notify({
        userId: uid, category: 'sales', type: 'visit_today', severity: 'info',
        title: `${row.Cnt} visit${row.Cnt > 1 ? 's' : ''} planned today`,
        body: 'Open Visit Plan to see your customers for today.',
        deepLink: '/modules/sales/visitplan.html',
        refKey: `visit_today:${today}:${uid}`,
      });
      if (res.created) stats.created++;
    }
  }
}

// Overdue receivables per salesperson (NAV Cust. Ledger). One digest per rep per day.
async function detectOverdueAR(navPool, idx, code, stats) {
  const P = prefixOf(code);
  const r = await navPool.request().query(`
    WITH D AS (SELECT [Cust_ Ledger Entry No_] E, SUM([Amount (LCY)]) A
               FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_])
    SELECT ISNULL(NULLIF(cle.[Salesperson Code],''), c.[Salesperson Code]) AS Sp,
           COUNT(*) AS Cnt, SUM(ISNULL(d.A,0)) AS Amt
    FROM ${P}Cust_ Ledger Entry] cle
    LEFT JOIN D d ON d.E = cle.[Entry No_]
    LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
    WHERE cle.[Open]=1 AND ISNULL(d.A,0)>0 AND cle.[Document Type]=2
      AND DATEDIFF(DAY, cle.[Due Date], CAST(GETDATE() AS DATE)) > 0
    GROUP BY ISNULL(NULLIF(cle.[Salesperson Code],''), c.[Salesperson Code])`);
  const today = new Date().toISOString().slice(0, 10);
  for (const row of r.recordset) {
    if (!row.Sp) continue;
    for (const uid of resolveOwners(idx, row.Sp)) {
      const res = await notify({
        userId: uid, category: 'sales', type: 'payment_overdue', severity: 'warning', company: code,
        title: `${row.Cnt} overdue invoice${row.Cnt > 1 ? 's' : ''} — ${fmtAmt(row.Amt, code)}`,
        body: 'Customers have crossed their due date. Open Outstanding to follow up.',
        deepLink: '/modules/sales/outstanding.html',
        refKey: `overdue:${code}:${today}:${uid}`,
      });
      if (res.created) stats.created++;
    }
  }
}

// PDC cheques whose date has passed but are still Hold / Not-Deposited.
async function detectPdcLapsed(navPool, appPool, idx, code, stats) {
  const pdc = await appPool.request().input('co', sql.NVarChar(10), code).query(`
    SELECT CustomerCode, COUNT(*) Cnt, SUM(ISNULL(Amount,0)) Amt
    FROM dbo.BN_PDC
    WHERE IsActive=1 AND (Company IS NULL OR Company=@co)
      AND ChequeDate < CAST(GETDATE() AS DATE)
      AND LOWER(ISNULL(Status,'')) IN ('hold','pending','not_deposited','with_salesperson','')
    GROUP BY CustomerCode`);
  if (!pdc.recordset.length) return;

  // Map each customer code → its NAV salesperson.
  const custCodes = pdc.recordset.map(r => r.CustomerCode).filter(Boolean);
  const spByCust = new Map();
  if (custCodes.length) {
    const P = prefixOf(code);
    const inList = custCodes.map((_, i) => `@c${i}`).join(',');
    const rq = navPool.request();
    custCodes.forEach((c, i) => rq.input('c' + i, sql.NVarChar(40), c));
    const cs = await rq.query(`SELECT [No_] Code, [Salesperson Code] Sp FROM ${P}Customer] WHERE [No_] IN (${inList})`);
    cs.recordset.forEach(x => spByCust.set(x.Code, x.Sp));
  }
  // Aggregate per user.
  const per = new Map();   // uid → {cnt, amt}
  for (const row of pdc.recordset) {
    const sp = spByCust.get(row.CustomerCode);
    for (const uid of resolveOwners(idx, sp)) {
      const cur = per.get(uid) || { cnt: 0, amt: 0 };
      cur.cnt += row.Cnt; cur.amt += Number(row.Amt) || 0;
      per.set(uid, cur);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const [uid, v] of per) {
    const res = await notify({
      userId: uid, category: 'sales', type: 'pdc_lapsed', severity: 'warning', company: code,
      title: `${v.cnt} PDC cheque${v.cnt > 1 ? 's' : ''} lapsed — ${fmtAmt(v.amt, code)}`,
      body: 'Post-dated cheque date has passed but it is still on Hold / Not Deposited.',
      deepLink: '/modules/sales/pdc.html',
      refKey: `pdc_lapsed:${code}:${today}:${uid}`,
    });
    if (res.created) stats.created++;
  }
}

// Holiday tomorrow → remind everyone.
async function detectHolidayTomorrow(appPool, idx, stats) {
  let rows;
  try {
    const r = await appPool.request().query(`
      SELECT HolidayId, Occasion, CONVERT(VARCHAR(10),HolidayDate,23) AS D
      FROM dbo.HRM_Holiday
      WHERE IsActive=1 AND ISNULL(HolidayType,'General')='General'
        AND CONVERT(VARCHAR(10),HolidayDate,23)=CONVERT(VARCHAR(10),DATEADD(DAY,1,GETDATE()),23)`);
    rows = r.recordset;
  } catch (e) { console.warn('[notif] holiday scan skipped:', e.message); return; }
  for (const h of rows) {
    for (const uid of idx.allIds) {
      const res = await notify({
        userId: uid, category: 'hr', type: 'holiday_tomorrow', severity: 'info',
        title: `Holiday tomorrow — ${h.Occasion || 'Holiday'}`,
        body: `The office is closed tomorrow (${h.D}) for ${h.Occasion || 'a holiday'}.`,
        deepLink: '/modules/hr/home.html',
        refKey: `holiday:${h.HolidayId}`,
      });
      if (res.created) stats.created++;
    }
  }
}

// MOM Action Points due soon (SmartSys) → notify the assignee + the meeting owner.
// Tiers by DaysToDue: 3 / 2 / 1 (tomorrow) / 0 (today) / -1 (just overdue). Each tier
// is a distinct RefKey so it escalates once per day as the date approaches.
async function detectMomApDue(smartPool, appPool, stats) {
  // Reverse map: SmartSys EmpId → ONE App User_Login.Id (cross-DB, same server;
  // mirrors mom.js faeTeamEmpIds join). Email/username is the link.
  const mapRows = await smartPool.request().query(`
    SELECT ul.Id AS UserLoginId, e.EmpId
    FROM BizNAV_App.dbo.User_Login ul
    JOIN dbo.tbl_SysUser     su ON LOWER(su.UserName)=LOWER(ul.Username) OR LOWER(su.UserName)=LOWER(ul.Email)
                                OR LOWER(su.Email)=LOWER(ul.Username)   OR LOWER(su.Email)=LOWER(ul.Email)
    JOIN dbo.tbl_SysEmployee e  ON e.UserId = su.UserId
    WHERE ul.IsActive=1 AND e.EmpId IS NOT NULL`);
  const empToUser = new Map();
  for (const r of mapRows.recordset) {
    if (!empToUser.has(r.EmpId)) empToUser.set(r.EmpId, []);
    empToUser.get(r.EmpId).push(r.UserLoginId);
  }
  if (!empToUser.size) return;

  const ap = await smartPool.request().query(`
    SELECT ap.ActionPointId, ap.ActionDescription,
           DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(ap.DueDate AS DATE)) AS DaysToDue,
           m.EmpId AS OwnerEmpId, e.EmpId AS AssigneeEmpId
    FROM dbo.TM_ProjectTaskMOMActionPoints ap
    INNER JOIN dbo.TM_ProjectTaskMOM m ON m.MOMId = ap.MOMId
    LEFT  JOIN dbo.TM_ProjectTaskMOMActionPointsUser apu ON apu.ActionPointId = ap.ActionPointId AND apu.UserType = 'Employee'
    LEFT  JOIN dbo.tbl_SysEmployee e ON e.UserId = apu.UserId
    WHERE ISNULL(ap.Status,0) NOT IN (30,32)          -- exclude Complete + Cancelled
      AND ap.DueDate IS NOT NULL
      AND CAST(ap.DueDate AS DATE) BETWEEN DATEADD(DAY,-1,CAST(GETDATE() AS DATE)) AND DATEADD(DAY,3,CAST(GETDATE() AS DATE))`);

  const tierLabel = (d) => d >= 2 ? `due in ${d} days` : d === 1 ? 'due tomorrow' : d === 0 ? 'due today' : 'overdue';
  for (const row of ap.recordset) {
    const targets = new Set();
    for (const uid of (empToUser.get(row.AssigneeEmpId) || [])) targets.add(uid);
    for (const uid of (empToUser.get(row.OwnerEmpId) || [])) targets.add(uid);
    if (!targets.size) continue;
    const d = row.DaysToDue;
    for (const uid of targets) {
      const res = await notify({
        userId: uid, category: 'sales', type: 'mom_ap_due',
        severity: d < 0 ? 'critical' : d === 0 ? 'warning' : 'info',
        title: `Action point ${tierLabel(d)}`,
        body: String(row.ActionDescription || 'A MOM action point needs attention.').slice(0, 180),
        deepLink: '/modules/sales/mom.html',
        refKey: `mom_ap:${row.ActionPointId}:${d}`,
      });
      if (res.created) stats.created++;
    }
  }
}

// ════════════════════════════ NAV POLL DETECTORS ═════════════════════════════

// New posted sales invoices → notify the salesperson (watermark on Created DateTime).
async function detectInvoiceCreated(navPool, appPool, idx, code, stats) {
  const P = prefixOf(code);
  const wmKey = `invoice_created:${code}`;
  const wm = await getWatermark(appPool, wmKey);

  if (!wm || !wm.WmDateTime) {
    // BASELINE: record the latest invoice datetime, notify nothing.
    const mx = await navPool.request().query(`SELECT MAX([Created DateTime]) AS M FROM ${P}Sales Invoice Header]`);
    await setWatermark(appPool, wmKey, null, mx.recordset[0].M || new Date());
    return;
  }

  const r = await navPool.request().input('since', sql.DateTime2, wm.WmDateTime).query(`
    SELECT TOP (300) SIH.[No_] InvoiceNo, SIH.[Created DateTime] CreatedDT,
      SIH.[Bill-to Name] CustName, SIH.[Salesperson Code] Sp,
      (SELECT SUM(CAST(ISNULL(sil.[Amount Including VAT],0) AS DECIMAL(18,2)))
         FROM ${P}Sales Invoice Line] sil WHERE sil.[Document No_]=SIH.[No_]) AS Amt
    FROM ${P}Sales Invoice Header] SIH
    WHERE SIH.[Created DateTime] > @since
    ORDER BY SIH.[Created DateTime] ASC`);

  let maxDt = wm.WmDateTime;
  for (const inv of r.recordset) {
    if (inv.CreatedDT && inv.CreatedDT > maxDt) maxDt = inv.CreatedDT;
    for (const uid of resolveOwners(idx, inv.Sp)) {
      const res = await notify({
        userId: uid, category: 'sales', type: 'invoice_created', severity: 'success', company: code,
        title: `Invoice ${inv.InvoiceNo} created`,
        body: `${inv.CustName || 'Customer'} — ${fmtAmt(inv.Amt, code)}`,
        deepLink: '/modules/sales/billing.html',
        refKey: `invoice:${inv.InvoiceNo}`,
      });
      if (res.created) stats.created++;
    }
  }
  await setWatermark(appPool, wmKey, null, maxDt);
}

// Customer payments received → notify the salesperson (watermark on Entry No_).
async function detectPaymentReceived(navPool, appPool, idx, code, stats) {
  const P = prefixOf(code);
  const wmKey = `payment_recd:${code}`;
  const wm = await getWatermark(appPool, wmKey);

  if (!wm || !wm.WmValue) {
    const mx = await navPool.request().query(
      `SELECT ISNULL(MAX([Entry No_]),0) AS M FROM ${P}Cust_ Ledger Entry] WHERE [Document Type]=1`);
    await setWatermark(appPool, wmKey, String(mx.recordset[0].M || 0), null);
    return;
  }

  const since = parseInt(wm.WmValue, 10) || 0;
  const r = await navPool.request().input('since', sql.Int, since).query(`
    SELECT TOP (300) cle.[Entry No_] EntryNo, cle.[Customer No_] CustNo, c.[Name] CustName,
      c.[Salesperson Code] Sp,
      (SELECT TOP 1 ABS(d.[Amount (LCY)]) FROM ${P}Detailed Cust_ Ledg_ Entry] d
        WHERE d.[Cust_ Ledger Entry No_]=cle.[Entry No_] ORDER BY d.[Entry No_]) AS Amt
    FROM ${P}Cust_ Ledger Entry] cle
    LEFT JOIN ${P}Customer] c ON c.[No_]=cle.[Customer No_]
    WHERE cle.[Document Type]=1 AND cle.[Entry No_] > @since
    ORDER BY cle.[Entry No_] ASC`);

  let maxEntry = since;
  for (const p of r.recordset) {
    if (p.EntryNo > maxEntry) maxEntry = p.EntryNo;
    for (const uid of resolveOwners(idx, p.Sp)) {
      const res = await notify({
        userId: uid, category: 'sales', type: 'payment_received', severity: 'success', company: code,
        title: `Payment received — ${fmtAmt(p.Amt, code)}`,
        body: `From ${p.CustName || 'customer'}.`,
        deepLink: '/modules/sales/customers.html',
        refKey: `payment_recd:${code}:${p.EntryNo}`,
      });
      if (res.created) stats.created++;
    }
  }
  await setWatermark(appPool, wmKey, String(maxEntry), null);
}

// SO line remark transitions INTO Ex-Stock (material received in store for the SO).
async function detectSoExStock(navPool, appPool, idx, code, stats) {
  const P = prefixOf(code);
  const isEx = (s) => /EX/i.test(String(s || ''));
  const wmKey = `so_baseline:${code}`;
  const wm = await getWatermark(appPool, wmKey);
  const baselining = !wm;

  const r = await navPool.request().query(`
    SELECT SH.[No_] DocNo, SL.[Line No_] AS [LineNo], ISNULL(SL.[Remarks],'') Remarks,
           SH.[Salesperson Code] Sp, ISNULL(C.[Name],'') CustName
    FROM ${P}Sales Header] SH
    INNER JOIN ${P}Sales Line] SL ON SL.[Document Type]=SH.[Document Type] AND SL.[Document No_]=SH.[No_]
    LEFT JOIN ${P}Customer] C ON C.[No_]=SH.[Sell-to Customer No_]
    WHERE SH.[Document Type]=1 AND SL.[Type]=2 AND ISNULL(SL.[Outstanding Quantity],0)>0`);

  // Load prior state for these keys.
  const prior = new Map();
  const stRows = await appPool.request().input('co', sql.NVarChar(10), code)
    .query('SELECT DocNo, [LineNo] AS [LineNo], LastRemark FROM dbo.BN_NotifSoState WHERE Company=@co');
  stRows.recordset.forEach(x => prior.set(x.DocNo + '|' + x.LineNo, x.LastRemark));

  for (const line of r.recordset) {
    const key = line.DocNo + '|' + line.LineNo;
    const prev = prior.has(key) ? prior.get(key) : undefined;
    const nowEx = isEx(line.Remarks);

    // Notify only on a genuine transition non-Ex → Ex (never during baseline, never for
    // brand-new lines that appear already-Ex — we can't prove a transition there).
    if (!baselining && prev !== undefined && !isEx(prev) && nowEx) {
      for (const uid of resolveOwners(idx, line.Sp)) {
        const res = await notify({
          userId: uid, category: 'sales', type: 'so_ex_stock', severity: 'success', company: code,
          title: `Ex-Stock ready — SO ${line.DocNo}`,
          body: `${line.CustName || 'Customer'}: material is in store for this order.`,
          deepLink: '/modules/sales/so-backlog.html',
          refKey: `so_ex:${code}:${line.DocNo}:${line.LineNo}`,
        });
        if (res.created) stats.created++;
      }
    }

    // Upsert state only when it changed (keeps writes small).
    if (prev === undefined || prev !== line.Remarks) {
      await appPool.request()
        .input('co', sql.NVarChar(10), code)
        .input('doc', sql.NVarChar(20), line.DocNo)
        .input('ln', sql.Int, line.LineNo)
        .input('rm', sql.NVarChar(250), String(line.Remarks).slice(0, 250))
        .query(`MERGE dbo.BN_NotifSoState AS t
                USING (SELECT @co C, @doc D, @ln L) s ON t.Company=s.C AND t.DocNo=s.D AND t.[LineNo]=s.L
                WHEN MATCHED THEN UPDATE SET LastRemark=@rm, UpdatedAt=SYSDATETIME()
                WHEN NOT MATCHED THEN INSERT (Company, DocNo, [LineNo], LastRemark) VALUES (@co,@doc,@ln,@rm);`)
        .catch(() => {});
    }
  }
  if (baselining) await setWatermark(appPool, wmKey, 'done', new Date());
}

// ════════════════════════════ ORCHESTRATION ══════════════════════════════════
async function runDailyScan() {
  const stats = { created: 0, errors: [] };
  const appPool = await getAppPool();
  const navPool = await getPool();
  const idx = await loadUserIndex(appPool);
  const wrap = async (name, fn) => { try { await fn(); } catch (e) { stats.errors.push(`${name}: ${e.message}`); console.error(`[notif scan] ${name}:`, e.message); } };

  await wrap('visitsToday', () => detectVisitsToday(appPool, idx, stats));
  await wrap('holidayTomorrow', () => detectHolidayTomorrow(appPool, idx, stats));
  await wrap('momApDue', async () => { const sp = await getSmartSysPool(); await detectMomApDue(sp, appPool, stats); });
  for (const code of COMPANY_CODES) {
    await wrap(`overdueAR:${code}`, () => detectOverdueAR(navPool, idx, code, stats));
    await wrap(`pdcLapsed:${code}`, () => detectPdcLapsed(navPool, appPool, idx, code, stats));
  }
  return stats;
}

async function runNavPoll() {
  const stats = { created: 0, errors: [] };
  const appPool = await getAppPool();
  const navPool = await getPool();
  const idx = await loadUserIndex(appPool);
  const wrap = async (name, fn) => { try { await fn(); } catch (e) { stats.errors.push(`${name}: ${e.message}`); console.error(`[notif poll] ${name}:`, e.message); } };

  for (const code of COMPANY_CODES) {
    await wrap(`invoiceCreated:${code}`, () => detectInvoiceCreated(navPool, appPool, idx, code, stats));
    await wrap(`paymentReceived:${code}`, () => detectPaymentReceived(navPool, appPool, idx, code, stats));
    await wrap(`soExStock:${code}`, () => detectSoExStock(navPool, appPool, idx, code, stats));
  }
  return stats;
}

// Manual trigger (admin POST /run-scan) — runs both once.
async function runAllNow() {
  if (global.__notifRunning) return { skipped: true, reason: 'already running' };
  global.__notifRunning = true;
  try {
    const scan = await runDailyScan();
    const poll = await runNavPoll();
    return { scan, poll };
  } finally { global.__notifRunning = false; }
}

function start() {
  if (global.__notifCronRegistered) return;
  global.__notifCronRegistered = true;
  if (!CRON_ENABLED) {
    console.log('🔕 Notification cron DISABLED (set NOTIF_CRON_ENABLED=true to enable). Use POST /api/notifications/run-scan to test.');
    return;
  }
  if (cron.validate(SCAN_CRON)) {
    cron.schedule(SCAN_CRON, async () => {
      if (global.__notifScanRunning) return; global.__notifScanRunning = true;
      try { const s = await runDailyScan(); console.log(`[notif] daily scan → ${s.created} created`, s.errors.length ? s.errors : ''); }
      finally { global.__notifScanRunning = false; }
    }, { timezone: 'Asia/Kolkata' });
    console.log(`🔔 Notification daily scan scheduled: ${SCAN_CRON} (Asia/Kolkata)`);
  }
  if (cron.validate(POLL_CRON)) {
    cron.schedule(POLL_CRON, async () => {
      if (global.__notifPollRunning) return; global.__notifPollRunning = true;
      try { const s = await runNavPoll(); if (s.created) console.log(`[notif] nav poll → ${s.created} created`, s.errors.length ? s.errors : ''); }
      finally { global.__notifPollRunning = false; }
    }, { timezone: 'Asia/Kolkata' });
    console.log(`🔔 Notification NAV poll scheduled: ${POLL_CRON} (Asia/Kolkata)`);
  }
}

module.exports = { start, runDailyScan, runNavPoll, runAllNow };
