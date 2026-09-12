// =====================================================================
// modules/hr/routes/dashboard.js — HR Dashboard aggregations (Phase 4A)
// Mounted at /api/hr/dashboard/* by ../index.js
//
// One composite endpoint that runs all widget queries against BizNAV_App
// and returns a single JSON blob. HR / admin only.
//
// Widgets:
//   • KPI strip:   total active, new joiners this month, birthdays this month,
//                  confirmation due in next 30 days, joining anniversary this
//                  month, resigned (LWD pending or in next 30 days),
//                  active field staff right now (signed-in, not yet signed-out)
//   • Years In Service Distribution  (0-1y / 1-3y / 3-5y / 5-10y / 10y+)
//   • Additions & Attrition          (last 12 months)
//   • Employee Count By Location
//   • Employee Count By Department
//   • Age Distribution               (<25 / 25-34 / 35-44 / 45-54 / 55+)
//   • Gender Distribution
//   • Top 5 Leave Takers             (approved leaves in current FY)
//
// FY runs Apr 1 → Mar 31 (COMPANYA convention). For dates ≥ Apr 1, fyStart = Apr 1
// of current calendar year; otherwise Apr 1 of previous year.
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');

// Compute FY start (April 1) for a given Date.
function fyStartFor(date) {
  const y = date.getFullYear();
  const m = date.getMonth();              // 0-based; 3 = April
  return new Date(m >= 3 ? y : y - 1, 3, 1);
}

router.get('/summary', authenticate, async (req, res) => {
  if (!isLensAdmin(req.user)) {
    return res.status(403).json({ message: 'Only HR / admin can view the dashboard' });
  }
  try {
    const pool   = await getAppPool();
    const today  = new Date();
    const fyStrt = fyStartFor(today);

    // ── KPI strip ────────────────────────────────────────────────────────────
    const kpiQ = await pool.request().query(`
      DECLARE @Today DATE = CAST(GETDATE() AS DATE);
      DECLARE @MonthStart DATE = DATEFROMPARTS(YEAR(@Today), MONTH(@Today), 1);
      DECLARE @MonthEnd   DATE = EOMONTH(@Today);
      DECLARE @In30       DATE = DATEADD(DAY, 30, @Today);

      SELECT
        (SELECT COUNT(*) FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
           WHERE U.IsActive = 1)                                                AS TotalActive,
        (SELECT COUNT(*) FROM HRM_Employee
           WHERE DateOfJoining BETWEEN @MonthStart AND @MonthEnd)               AS NewJoinersMonth,
        (SELECT COUNT(*) FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
           WHERE U.IsActive = 1 AND E.DOB IS NOT NULL
             AND MONTH(E.DOB) = MONTH(@Today))                                  AS BirthdaysMonth,
        (SELECT COUNT(*) FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
           WHERE U.IsActive = 1
             AND E.ConfirmationDate IS NOT NULL
             AND E.ConfirmationDate BETWEEN @Today AND @In30)                   AS ConfirmationDue30d,
        (SELECT COUNT(*) FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
           WHERE U.IsActive = 1 AND E.DateOfJoining IS NOT NULL
             AND MONTH(E.DateOfJoining) = MONTH(@Today)
             AND YEAR(E.DateOfJoining) < YEAR(@Today))                          AS AnniversariesMonth,
        (SELECT COUNT(*) FROM HRM_Employee
           WHERE ResignDate IS NOT NULL
             AND (LastWorkingDay IS NULL OR LastWorkingDay >= @Today))          AS ResignationsPending,
        (SELECT COUNT(DISTINCT UserId) FROM HRM_Attendance
           WHERE AttDate = @Today AND SignInTime IS NOT NULL AND SignOutTime IS NULL)
                                                                                AS ActiveFieldStaffNow;
    `);
    const k = kpiQ.recordset[0] || {};
    const kpis = {
      total:                k.TotalActive            || 0,
      newJoinersMonth:      k.NewJoinersMonth        || 0,
      birthdaysMonth:       k.BirthdaysMonth         || 0,
      confirmationDue30d:   k.ConfirmationDue30d     || 0,
      anniversariesMonth:   k.AnniversariesMonth     || 0,
      resignationsPending:  k.ResignationsPending    || 0,
      activeFieldStaffNow:  k.ActiveFieldStaffNow    || 0,
    };

    // ── Years In Service Distribution ────────────────────────────────────────
    const yisQ = await pool.request().query(`
      WITH t AS (
        SELECT
          CASE
            WHEN DateOfJoining IS NULL                                    THEN 'Unknown'
            WHEN DATEDIFF(MONTH, DateOfJoining, GETDATE()) < 12           THEN '0-1y'
            WHEN DATEDIFF(MONTH, DateOfJoining, GETDATE()) < 36           THEN '1-3y'
            WHEN DATEDIFF(MONTH, DateOfJoining, GETDATE()) < 60           THEN '3-5y'
            WHEN DATEDIFF(MONTH, DateOfJoining, GETDATE()) < 120          THEN '5-10y'
            ELSE '10y+'
          END AS Bucket
        FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
        WHERE U.IsActive = 1
      )
      SELECT Bucket, COUNT(*) AS Cnt FROM t GROUP BY Bucket;
    `);
    const yearsInService = ['0-1y','1-3y','3-5y','5-10y','10y+','Unknown'].map(b => ({
      bucket: b,
      count:  (yisQ.recordset.find(r => r.Bucket === b) || {}).Cnt || 0,
    })).filter(x => x.count > 0 || x.bucket !== 'Unknown');

    // ── Additions & Attrition (last 12 months) ───────────────────────────────
    const aaQ = await pool.request().query(`
      DECLARE @Start DATE = DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1);
      SET     @Start = DATEADD(MONTH, -11, @Start);

      ;WITH Months AS (
        SELECT @Start AS M
        UNION ALL
        SELECT DATEADD(MONTH, 1, M) FROM Months WHERE M < DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
      )
      SELECT
        FORMAT(M, 'yyyy-MM') AS Month,
        (SELECT COUNT(*) FROM HRM_Employee
           WHERE DateOfJoining IS NOT NULL
             AND YEAR(DateOfJoining) = YEAR(M) AND MONTH(DateOfJoining) = MONTH(M)) AS Joined,
        (SELECT COUNT(*) FROM HRM_Employee
           WHERE LastWorkingDay IS NOT NULL
             AND YEAR(LastWorkingDay) = YEAR(M) AND MONTH(LastWorkingDay) = MONTH(M)) AS [Left]
      FROM Months
      OPTION (MAXRECURSION 100);
    `);
    const additionsAttrition = aaQ.recordset.map(r => ({
      month:  r.Month,
      joined: r.Joined || 0,
      left:   r.Left   || 0,
    }));

    // ── By Location ──────────────────────────────────────────────────────────
    const locQ = await pool.request().query(`
      SELECT ISNULL(NULLIF(LTRIM(RTRIM(E.Location)), ''), 'Unspecified') AS Location, COUNT(*) AS Cnt
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1
      GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(E.Location)), ''), 'Unspecified')
      ORDER BY Cnt DESC;
    `);
    const byLocation = locQ.recordset.map(r => ({ name: r.Location, count: r.Cnt }));

    // ── By Department ────────────────────────────────────────────────────────
    const deptQ = await pool.request().query(`
      SELECT ISNULL(NULLIF(LTRIM(RTRIM(E.Department)), ''), 'Unspecified') AS Department, COUNT(*) AS Cnt
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1
      GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(E.Department)), ''), 'Unspecified')
      ORDER BY Cnt DESC;
    `);
    const byDepartment = deptQ.recordset.map(r => ({ name: r.Department, count: r.Cnt }));

    // ── Age Distribution ─────────────────────────────────────────────────────
    const ageQ = await pool.request().query(`
      WITH t AS (
        SELECT
          CASE
            WHEN DOB IS NULL                                  THEN 'Unknown'
            WHEN DATEDIFF(YEAR, DOB, GETDATE()) < 25          THEN '<25'
            WHEN DATEDIFF(YEAR, DOB, GETDATE()) < 35          THEN '25-34'
            WHEN DATEDIFF(YEAR, DOB, GETDATE()) < 45          THEN '35-44'
            WHEN DATEDIFF(YEAR, DOB, GETDATE()) < 55          THEN '45-54'
            ELSE '55+'
          END AS Bucket
        FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
        WHERE U.IsActive = 1
      )
      SELECT Bucket, COUNT(*) AS Cnt FROM t GROUP BY Bucket;
    `);
    const ageDistribution = ['<25','25-34','35-44','45-54','55+','Unknown'].map(b => ({
      bucket: b,
      count:  (ageQ.recordset.find(r => r.Bucket === b) || {}).Cnt || 0,
    })).filter(x => x.count > 0 || x.bucket !== 'Unknown');

    // ── Gender Distribution ──────────────────────────────────────────────────
    const genderQ = await pool.request().query(`
      SELECT ISNULL(NULLIF(LTRIM(RTRIM(E.Gender)), ''), 'Unspecified') AS Gender, COUNT(*) AS Cnt
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1
      GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(E.Gender)), ''), 'Unspecified');
    `);
    const genderDistribution = genderQ.recordset.map(r => ({ name: r.Gender, count: r.Cnt }));

    // ── Top 5 Leave Takers (this FY, approved only) ──────────────────────────
    const ltQ = await pool.request()
      .input('fyStart', sql.Date, fyStrt)
      .query(`
        SELECT TOP 5
          L.UserId,
          U.Name        AS Name,
          E.EmpCode     AS EmpCode,
          E.Department  AS Department,
          SUM(L.DaysApplied) AS TotalDays
        FROM HRM_Leave L
        JOIN User_Login U   ON U.Id = L.UserId
        LEFT JOIN HRM_Employee E ON E.UserId = L.UserId
        WHERE L.Status = 'approved'
          AND L.FromDate >= @fyStart
        GROUP BY L.UserId, U.Name, E.EmpCode, E.Department
        ORDER BY SUM(L.DaysApplied) DESC;
      `);
    const topLeaveTakers = ltQ.recordset.map(r => ({
      userId:     r.UserId,
      name:       r.Name,
      empCode:    r.EmpCode,
      department: r.Department,
      days:       Number(r.TotalDays) || 0,
    }));

    // ── FY label for display ─────────────────────────────────────────────────
    const fyEnd = new Date(fyStrt.getFullYear() + 1, 2, 31);
    const fyLabel = `FY${fyStrt.getFullYear()}-${String(fyEnd.getFullYear()).slice(2)}`;

    res.json({
      asOf:               new Date().toISOString(),
      fy:                 fyLabel,
      kpis,
      yearsInService,
      additionsAttrition,
      byLocation,
      byDepartment,
      ageDistribution,
      genderDistribution,
      topLeaveTakers,
    });
  } catch (err) {
    console.error('[dashboard/summary]', err);
    res.status(500).json({ message: 'Failed to load dashboard', error: err.message });
  }
});

module.exports = router;
