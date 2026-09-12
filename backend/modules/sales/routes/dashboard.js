// =====================================================================
// modules/sales/routes/dashboard.js — UNIFIED COMPANYA + CompanyB
// Replaces backend/routes/dashboard.js + backend/routes/CompanyBDashboard.js
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getPool } = require('../../../db');
const { authenticate, isFullAccess } = require('../../../auth');
const { getCompany }   = require('../../../shared/company');

router.get('/', authenticate, async (req, res) => {
  try {
    const company = getCompany(req);
    const P       = company.prefix;
    const codeCol = company.code === 'COMPANYA' ? 'companyaCode' : 'companybCode';

    const pool    = await getPool();
    // Full access = admin / operation head / director only. Heads (sales head /
    // north sales head / Sales Head Electrical / Electrical Head, etc.) and
    // sales/* roles all get codes-based scoping; head's User_Login.CompanyACode
    // already contains the team's union, so heads naturally see team data.
    const role    = (req.user.role || '').toLowerCase();
    const isAdmin = isFullAccess(req.user);
    const codes   = (req.user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);

    const addSP   = (r) => { codes.forEach((c, i) => r.input(`spCode${i}`, sql.NVarChar, c)); return r; };
    const spWhere = codes.map((_, i) => `c.[Salesperson Code] = @spCode${i}`).join(' OR ');
    const spAnd   = !isAdmin && codes.length ? `AND (${spWhere})` : '';

    /* ── Summary ── */
    const sumR = addSP(pool.request());
    const sumRes = await sumR.query(`
      WITH D AS (
        SELECT [Cust_ Ledger Entry No_] AS E, SUM([Amount (LCY)]) AS A
        FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_]
      ),
      OpenEntries AS (
        SELECT
          cle.[Entry No_],
          cle.[Customer No_],
          cle.[Due Date],
          DATEDIFF(DAY, cle.[Due Date], CAST(GETDATE() AS DATE)) AS AgeDays,
          CAST(ISNULL(d.A, 0) AS DECIMAL(18,2)) AS RemainingAmount
        FROM ${P}Cust_ Ledger Entry] cle
        LEFT JOIN D d ON d.E = cle.[Entry No_]
        LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
        WHERE cle.[Open] = 1 AND ISNULL(d.A, 0) > 0 ${spAnd}
      )
      SELECT
        COUNT(DISTINCT [Customer No_]) AS TotalCustomers,
        COUNT(*)                       AS TotalEntries,
        SUM(RemainingAmount)           AS TotalAR,
        SUM(RemainingAmount)           AS TotalOutstanding,
        SUM(CASE WHEN AgeDays >  0 THEN RemainingAmount ELSE 0 END) AS Overdue,
        SUM(CASE WHEN AgeDays <= 0 THEN RemainingAmount ELSE 0 END) AS Current_,
        SUM(CASE WHEN AgeDays <= 0 THEN RemainingAmount ELSE 0 END) AS NotDue,
        SUM(CASE WHEN AgeDays BETWEEN 1  AND 30 THEN RemainingAmount ELSE 0 END) AS Age0_30,
        SUM(CASE WHEN AgeDays BETWEEN 31 AND 60 THEN RemainingAmount ELSE 0 END) AS Age31_60,
        SUM(CASE WHEN AgeDays BETWEEN 61 AND 90 THEN RemainingAmount ELSE 0 END) AS Age61_90,
        SUM(CASE WHEN AgeDays > 90 THEN RemainingAmount ELSE 0 END) AS Age90Plus
      FROM OpenEntries
    `);

    /* ── Customer counts ── */
    const cntR = addSP(pool.request());
    const cntRes = await cntR.query(`
      SELECT COUNT(*) AS Total,
        SUM(CASE WHEN ISNULL([Blocked],'')='' THEN 1 ELSE 0 END) AS Active
      FROM ${P}Customer] c
      ${!isAdmin && codes.length ? `WHERE (${spWhere})` : ''}
    `);

    /* ── Top 7 Debtors ── */
    const debR = addSP(pool.request());
    const debRes = await debR.query(`
      WITH D AS (SELECT [Cust_ Ledger Entry No_] E, SUM([Amount (LCY)]) A
                 FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_])
      SELECT TOP 7 cle.[Customer No_] AS CustomerNo, c.[Name] AS CustomerName,
        SUM(ISNULL(d.A,0)) AS Outstanding
      FROM ${P}Cust_ Ledger Entry] cle
      LEFT JOIN D d ON d.E = cle.[Entry No_]
      LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
      WHERE cle.[Open] = 1 ${spAnd}
      GROUP BY cle.[Customer No_], c.[Name]
      ORDER BY Outstanding DESC
    `);

    /* ── SO Backlog ── */
    const soR = addSP(pool.request());
    const soRes = await soR.query(`
      SELECT ISNULL(SUM(sl.[Outstanding Amount (LCY)]),0) AS TotalSOValue,
             COUNT(DISTINCT sl.[Document No_]) AS TotalSOCount
      FROM ${P}Sales Line] sl
      LEFT JOIN ${P}Sales Header] sh ON sh.[No_] = sl.[Document No_]
      LEFT JOIN ${P}Customer] c ON c.[No_] = sh.[Sell-to Customer No_]
      WHERE sl.[Document Type] = 1
        AND sl.[Outstanding Quantity] > 0
        ${spAnd}
    `);

    /* ── Billing Value (last 30 days) ── */
    const bilR = addSP(pool.request());
    const bilRes = await bilR.query(`
      SELECT ISNULL(SUM(il.[Amount]),0) AS TotalBillingValue,
             COUNT(DISTINCT il.[Document No_]) AS TotalInvoiceCount
      FROM ${P}Sales Invoice Line] il
      LEFT JOIN ${P}Sales Invoice Header] ih ON ih.[No_] = il.[Document No_]
      LEFT JOIN ${P}Customer] c ON c.[No_] = ih.[Sell-to Customer No_]
      WHERE ih.[Posting Date] >= DATEADD(DAY,-30,GETDATE())
        ${spAnd}
    `);

    /* ── By Salesperson (admin) OR By Customer (sales) ── */
    let bySalesperson = [], byCustomer = [];
    if (isAdmin) {
      const spRes = await pool.request().query(`
        WITH D AS (SELECT [Cust_ Ledger Entry No_] E, SUM([Amount (LCY)]) A
                   FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_])
        SELECT TOP 8
          ISNULL(sp.[Name], c.[Salesperson Code]) AS Salesperson,
          COUNT(DISTINCT cle.[Customer No_]) AS Customers,
          SUM(ISNULL(d.A,0)) AS Outstanding
        FROM ${P}Cust_ Ledger Entry] cle
        LEFT JOIN D d ON d.E = cle.[Entry No_]
        LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
        LEFT JOIN ${P}Salesperson_Purchaser] sp ON sp.[Code] = c.[Salesperson Code]
        WHERE cle.[Open] = 1 AND ISNULL(c.[Salesperson Code],'') != ''
        GROUP BY c.[Salesperson Code], sp.[Name]
        ORDER BY Outstanding DESC
      `);
      bySalesperson = spRes.recordset || [];
    } else {
      const cR = addSP(pool.request());
      const cRes = await cR.query(`
        WITH D AS (SELECT [Cust_ Ledger Entry No_] E, SUM([Amount (LCY)]) A
                   FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_])
        SELECT TOP 10 cle.[Customer No_] AS CustomerNo, c.[Name] AS CustomerName,
          SUM(ISNULL(d.A,0)) AS Outstanding
        FROM ${P}Cust_ Ledger Entry] cle
        LEFT JOIN D d ON d.E = cle.[Entry No_]
        LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
        WHERE cle.[Open] = 1 AND (${spWhere})
        GROUP BY cle.[Customer No_], c.[Name]
        ORDER BY Outstanding DESC
      `);
      byCustomer = cRes.recordset || [];
    }

    res.json({
      outstanding:   sumRes.recordset[0]  || {},
      customers:     cntRes.recordset[0]  || {},
      topDebtors:    debRes.recordset     || [],
      soStats:       soRes.recordset[0]   || {},
      billingStats:  bilRes.recordset[0]  || {},
      bySalesperson,
      byCustomer,
      isAdmin,
      currency: company.currency,
      symbol:   company.symbol,
      company:  company.code,
    });

  } catch (err) {
    console.error('Sales Dashboard error:', err.message);
    res.status(500).json({ message: 'Failed to load dashboard', error: err.message });
  }
});

module.exports = router;
