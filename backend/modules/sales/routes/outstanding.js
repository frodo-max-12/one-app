// =====================================================================
// modules/sales/routes/outstanding.js — UNIFIED COMPANYA + CompanyB
// Replaces backend/routes/outstanding.js + backend/routes/CompanyBOutstanding.js
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
    const isCompanyA   = company.code === 'COMPANYA';

    const pool    = await getPool();
    // Full access = admin / operation head / director only. Heads (sales head /
    // north sales head / Sales Head Electrical / Electrical Head, etc.) and
    // sales/* roles all get codes-based scoping; head's User_Login.CompanyACode
    // already contains the team's union, so heads naturally see team data.
    const role    = (req.user.role || '').toLowerCase();
    const isAdmin = isFullAccess(req.user);
    const codes   = (req.user[codeCol] || '').split('/').map(s => s.trim()).filter(Boolean);

    const { search = '', aging = 'all', page = 1, limit = 15 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const addSP = (r) => { codes.forEach((c, i) => r.input(`spCode${i}`, sql.NVarChar, c)); return r; };
    const spWhere = codes.map((_, i) => `c.[Salesperson Code] = @spCode${i}`).join(' OR ');
    const spAnd   = !isAdmin && codes.length ? `AND (${spWhere})` : '';

    const agingMap = {
      'overdue': 'AND DATEDIFF(DAY,oe.DueDate,GETDATE()) > 0',
      '0-30':    'AND DATEDIFF(DAY,oe.DueDate,GETDATE()) BETWEEN 0  AND 30',
      '31-60':   'AND DATEDIFF(DAY,oe.DueDate,GETDATE()) BETWEEN 31 AND 60',
      '61-90':   'AND DATEDIFF(DAY,oe.DueDate,GETDATE()) BETWEEN 61 AND 90',
      '90+':     'AND DATEDIFF(DAY,oe.DueDate,GETDATE()) > 90',
    };
    const agingAnd = agingMap[aging] || '';

    const searchAnd = search ? `AND (
      oe.CustomerName COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
      OR oe.CustomerNo COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
      OR oe.DocNo COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
      OR ISNULL(oe.ExtDocNo,'') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
      OR ISNULL(oe.Salesperson,'') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @search
    )` : '';

    const baseCTE = `
      WITH D AS (
        SELECT [Cust_ Ledger Entry No_] E, SUM([Amount (LCY)]) A
        FROM ${P}Detailed Cust_ Ledg_ Entry] GROUP BY [Cust_ Ledger Entry No_]
      ),
      OpenEntries AS (
        SELECT
          cle.[Customer No_]          AS CustomerNo,
          c.[Name]                    AS CustomerName,
          ${isCompanyA ? 'c.[GST Registration No_]' : "''"} AS GSTNo,
          c.[State Code]              AS State,
          c.[E-Mail]                  AS CustomerEmail,
          c.[Phone No_]               AS CustomerPhone,
          ISNULL(sp.[Name], c.[Salesperson Code]) AS Salesperson,
          cle.[Document No_]          AS DocNo,
          cle.[External Document No_] AS ExtDocNo,
          cle.[Posting Date]          AS PostingDate,
          cle.[Due Date]              AS DueDate,
          cle.[Sales (LCY)]           AS OriginalAmount,
          ISNULL(d.A,0)               AS RemainingAmount,
          DATEDIFF(DAY,cle.[Due Date],GETDATE()) AS OverdueDays
        FROM ${P}Cust_ Ledger Entry] cle
        LEFT JOIN D d ON d.E = cle.[Entry No_]
        LEFT JOIN ${P}Customer] c ON c.[No_] = cle.[Customer No_]
        LEFT JOIN ${P}Salesperson_Purchaser] sp ON sp.[Code] = c.[Salesperson Code]
        WHERE cle.[Open] = 1 AND ISNULL(d.A,0) > 0 ${spAnd}
      )`;

    /* Summary */
    const sumR = addSP(pool.request());
    if (search) sumR.input('search', sql.NVarChar, `%${search}%`);
    const sumRes = await sumR.query(`${baseCTE}
      SELECT COUNT(*) AS TotalRecords,
        SUM(RemainingAmount) AS TotalOutstanding,
        SUM(CASE WHEN DATEDIFF(DAY,DueDate,GETDATE()) BETWEEN 0  AND 30 THEN RemainingAmount ELSE 0 END) AS Age0_30,
        SUM(CASE WHEN DATEDIFF(DAY,DueDate,GETDATE()) BETWEEN 31 AND 60 THEN RemainingAmount ELSE 0 END) AS Age31_60,
        SUM(CASE WHEN DATEDIFF(DAY,DueDate,GETDATE()) BETWEEN 61 AND 90 THEN RemainingAmount ELSE 0 END) AS Age61_90,
        SUM(CASE WHEN DATEDIFF(DAY,DueDate,GETDATE()) > 90              THEN RemainingAmount ELSE 0 END) AS Age90Plus
      FROM OpenEntries oe WHERE 1=1 ${agingAnd} ${searchAnd}
    `);

    /* Data */
    const dataR = addSP(pool.request());
    dataR.input('lim', sql.Int, parseInt(limit));
    dataR.input('off', sql.Int, offset);
    if (search) dataR.input('search', sql.NVarChar, `%${search}%`);
    const dataRes = await dataR.query(`${baseCTE}
      SELECT CustomerNo, CustomerName, GSTNo, State, CustomerEmail, CustomerPhone, Salesperson,
             DocNo, ExtDocNo, PostingDate, DueDate, OriginalAmount, RemainingAmount, OverdueDays
      FROM OpenEntries oe WHERE 1=1 ${agingAnd} ${searchAnd}
      ORDER BY DueDate ASC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY
    `);

    res.json({
      summary:  sumRes.recordset[0] || {},
      data:     dataRes.recordset || [],
      currency: company.currency,
      symbol:   company.symbol,
      company:  company.code,
    });

  } catch (err) {
    console.error('Outstanding error:', err.message);
    res.status(500).json({ message: 'Failed to load outstanding', error: err.message });
  }
});

module.exports = router;
