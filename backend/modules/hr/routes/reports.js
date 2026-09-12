// =====================================================================
// modules/hr/routes/reports.js — HR Reports (Phase 4B)
// Mounted at /api/hr/reports/* by ../index.js
//
// Registry-based: each entry in REPORTS[] defines one report (name, group,
// columns, params, SQL builder). Two endpoints:
//
//   GET  /list        — metadata for all reports (for the picker UI)
//   POST /run         — body { key, filters, format } executes report and
//                       returns JSON / streams XLSX / streams PDF
//
// HR / admin only. SAFETY: all queries are SELECT against BizNAV_App.
// =====================================================================

const express = require('express');
const router  = express.Router();
const PDFDocument = require('pdfkit');
const XLSX        = require('xlsx');
const { sql, getAppPool } = require('../../../db');
const { authenticate, isLensAdmin } = require('../../../auth');

// ── Helpers ──────────────────────────────────────────────────────────────────
const COL_TYPES = { STRING: 'string', DATE: 'date', DATETIME: 'datetime', NUMBER: 'number', INT: 'int', BOOL: 'bool' };

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return '';
  return [
    String(d.getDate()).padStart(2,'0'),
    String(d.getMonth() + 1).padStart(2,'0'),
    d.getFullYear(),
  ].join('-');
}
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return '';
  return fmtDate(v) + ' ' + [
    String(d.getHours()).padStart(2,'0'),
    String(d.getMinutes()).padStart(2,'0'),
  ].join(':');
}
function fmtCell(value, type) {
  if (value === null || value === undefined) return '';
  if (type === COL_TYPES.DATE)     return fmtDate(value);
  if (type === COL_TYPES.DATETIME) return fmtDateTime(value);
  if (type === COL_TYPES.BOOL)     return value ? 'Yes' : 'No';
  if (type === COL_TYPES.NUMBER)   return Number(value).toFixed(2);
  return String(value);
}

// ── REPORT REGISTRY ──────────────────────────────────────────────────────────
const REPORTS = [
  // ── Workforce ──────────────────────────────────────────────────────────────
  {
    key: 'employee-master',
    name: 'Employee Master',
    group: 'Workforce',
    description: 'Full list of active employees with personal + position fields.',
    params: [],
    columns: [
      { key: 'EmpCode',         label: 'Emp Code',     width: 14 },
      { key: 'Name',            label: 'Name',         width: 28 },
      { key: 'Email',           label: 'Email',        width: 28 },
      { key: 'Mobile',          label: 'Mobile',       width: 14 },
      { key: 'Gender',          label: 'Gender',       width: 10 },
      { key: 'DOB',             label: 'DOB',          width: 12, type: COL_TYPES.DATE },
      { key: 'DateOfJoining',   label: 'DOJ',          width: 12, type: COL_TYPES.DATE },
      { key: 'Department',      label: 'Department',   width: 14 },
      { key: 'Designation',     label: 'Designation',  width: 18 },
      { key: 'Location',        label: 'Location',     width: 14 },
    ],
    sql: () => ({ query: `
      SELECT E.EmpCode, U.Name, U.Email, E.Mobile, E.Gender, E.DOB,
             E.DateOfJoining, E.Department, E.Designation, E.Location
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1
      ORDER BY U.Name;`,
      inputs: {},
    }),
  },

  {
    key: 'headcount-snapshot',
    name: 'Headcount Snapshot',
    group: 'Workforce',
    description: 'Point-in-time list of active employees with years-of-service.',
    params: [],
    columns: [
      { key: 'EmpCode',         label: 'Emp Code',     width: 14 },
      { key: 'Name',            label: 'Name',         width: 28 },
      { key: 'Department',      label: 'Department',   width: 14 },
      { key: 'Location',        label: 'Location',     width: 14 },
      { key: 'Designation',     label: 'Designation',  width: 18 },
      { key: 'DateOfJoining',   label: 'DOJ',          width: 12, type: COL_TYPES.DATE },
      { key: 'YearsService',    label: 'Years',        width: 8,  type: COL_TYPES.INT },
      { key: 'EmployeeType',    label: 'Type',         width: 12 },
      { key: 'Role',            label: 'App Role',     width: 14 },
    ],
    sql: () => ({ query: `
      SELECT E.EmpCode, U.Name, E.Department, E.Location, E.Designation,
             E.DateOfJoining,
             DATEDIFF(YEAR, E.DateOfJoining, GETDATE()) AS YearsService,
             E.EmployeeType, U.Role
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1
      ORDER BY E.DateOfJoining;`,
      inputs: {},
    }),
  },

  {
    key: 'joining-history',
    name: 'Joining History',
    group: 'Workforce',
    description: 'Employees who joined within a date range.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'EmpCode',       label: 'Emp Code',    width: 14 },
      { key: 'Name',          label: 'Name',        width: 28 },
      { key: 'Department',    label: 'Department',  width: 14 },
      { key: 'Location',      label: 'Location',    width: 14 },
      { key: 'Designation',   label: 'Designation', width: 18 },
      { key: 'DateOfJoining', label: 'DOJ',         width: 12, type: COL_TYPES.DATE },
      { key: 'EmployeeType',  label: 'Type',        width: 12 },
    ],
    sql: (p) => ({ query: `
      SELECT E.EmpCode, U.Name, E.Department, E.Location, E.Designation,
             E.DateOfJoining, E.EmployeeType
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE E.DateOfJoining BETWEEN @from AND @to
      ORDER BY E.DateOfJoining DESC;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  {
    key: 'separations',
    name: 'Separations / Exits',
    group: 'Workforce',
    description: 'Employees whose ResignDate or LastWorkingDay falls within the range.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'EmpCode',         label: 'Emp Code',    width: 14 },
      { key: 'Name',            label: 'Name',        width: 26 },
      { key: 'Department',      label: 'Department',  width: 14 },
      { key: 'ResignDate',      label: 'Resign Date', width: 12, type: COL_TYPES.DATE },
      { key: 'LastWorkingDay',  label: 'LWD',         width: 12, type: COL_TYPES.DATE },
      { key: 'SettledOn',       label: 'Settled On',  width: 12, type: COL_TYPES.DATE },
      { key: 'NoticeServed',    label: 'Notice',      width: 8,  type: COL_TYPES.BOOL },
      { key: 'FitToBeRehired',  label: 'Rehire?',     width: 9,  type: COL_TYPES.BOOL },
      { key: 'ResignationReason', label: 'Reason',    width: 30 },
    ],
    sql: (p) => ({ query: `
      SELECT E.EmpCode, U.Name, E.Department,
             E.ResignDate, E.LastWorkingDay, E.SettledOn,
             E.NoticeServed, E.FitToBeRehired, E.ResignationReason
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE (E.ResignDate     BETWEEN @from AND @to)
         OR (E.LastWorkingDay BETWEEN @from AND @to)
      ORDER BY COALESCE(E.LastWorkingDay, E.ResignDate) DESC;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  {
    key: 'confirmation-due',
    name: 'Confirmation Due',
    group: 'Workforce',
    description: 'Employees whose ConfirmationDate falls in the given window.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'EmpCode',          label: 'Emp Code',     width: 14 },
      { key: 'Name',             label: 'Name',         width: 28 },
      { key: 'Department',       label: 'Department',   width: 14 },
      { key: 'DateOfJoining',    label: 'DOJ',          width: 12, type: COL_TYPES.DATE },
      { key: 'ConfirmationDate', label: 'Confirm Date', width: 12, type: COL_TYPES.DATE },
      { key: 'DaysToConfirm',    label: 'Days Left',    width: 10, type: COL_TYPES.INT },
    ],
    sql: (p) => ({ query: `
      SELECT E.EmpCode, U.Name, E.Department, E.DateOfJoining, E.ConfirmationDate,
             DATEDIFF(DAY, GETDATE(), E.ConfirmationDate) AS DaysToConfirm
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1 AND E.ConfirmationDate BETWEEN @from AND @to
      ORDER BY E.ConfirmationDate;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  {
    key: 'birthdays-anniversaries',
    name: 'Birthdays & Anniversaries',
    group: 'Workforce',
    description: 'Active employees with a birthday or joining anniversary in a given month.',
    params: [
      { key: 'month', label: 'Month (1-12)', type: 'int', required: true, default: () => new Date().getMonth() + 1 },
    ],
    columns: [
      { key: 'EmpCode',       label: 'Emp Code',     width: 14 },
      { key: 'Name',          label: 'Name',         width: 28 },
      { key: 'Department',    label: 'Department',   width: 14 },
      { key: 'BirthdayOn',    label: 'Birthday',     width: 12, type: COL_TYPES.DATE },
      { key: 'AnniversaryOn', label: 'Anniversary',  width: 12, type: COL_TYPES.DATE },
      { key: 'YearsService',  label: 'Years',        width: 8,  type: COL_TYPES.INT },
    ],
    sql: (p) => ({ query: `
      SELECT E.EmpCode, U.Name, E.Department,
             CASE WHEN MONTH(E.DOB) = @month THEN E.DOB END AS BirthdayOn,
             CASE WHEN MONTH(E.DateOfJoining) = @month AND YEAR(E.DateOfJoining) < YEAR(GETDATE())
                  THEN E.DateOfJoining END AS AnniversaryOn,
             DATEDIFF(YEAR, E.DateOfJoining, GETDATE()) AS YearsService
      FROM HRM_Employee E JOIN User_Login U ON U.Id = E.UserId
      WHERE U.IsActive = 1
        AND (MONTH(E.DOB) = @month
             OR (MONTH(E.DateOfJoining) = @month AND YEAR(E.DateOfJoining) < YEAR(GETDATE())))
      ORDER BY DAY(COALESCE(E.DOB, E.DateOfJoining));`,
      inputs: { month: [sql.Int, p.month] },
    }),
  },

  // ── Attendance ─────────────────────────────────────────────────────────────
  {
    key: 'attendance-register',
    name: 'Attendance Register',
    group: 'Attendance',
    description: 'Per-day attendance rows in the given range. Includes regularized rows.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'AttDate',      label: 'Date',         width: 12, type: COL_TYPES.DATE },
      { key: 'EmpCode',      label: 'Emp Code',     width: 12 },
      { key: 'Name',         label: 'Name',         width: 24 },
      { key: 'Department',   label: 'Department',   width: 14 },
      { key: 'Status',       label: 'Status',       width: 8 },
      { key: 'SignInTime',   label: 'Sign In',      width: 16, type: COL_TYPES.DATETIME },
      { key: 'SignOutTime',  label: 'Sign Out',     width: 16, type: COL_TYPES.DATETIME },
      { key: 'TotalWorkMin', label: 'Work (min)',   width: 10, type: COL_TYPES.INT },
      { key: 'DistanceKm',   label: 'Distance (km)',width: 12, type: COL_TYPES.NUMBER },
      { key: 'IsRegularized',label: 'Regularized',  width: 12, type: COL_TYPES.BOOL },
    ],
    sql: (p) => ({ query: `
      SELECT A.AttDate, E.EmpCode, U.Name, E.Department,
             A.Status, A.SignInTime, A.SignOutTime, A.TotalWorkMin, A.DistanceKm, A.IsRegularized
      FROM HRM_Attendance A
      JOIN User_Login U   ON U.Id = A.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = A.UserId
      WHERE A.AttDate BETWEEN @from AND @to
      ORDER BY A.AttDate DESC, U.Name;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  // ── Compliance (4-time-point tracking — built 2026-05-27) ──────────────────
  // Shows every attendance row's compliance breakdown in the chosen window:
  // when each of the 4 time-points was hit, plus the rule-based flags.
  {
    key: 'daily-compliance',
    name: 'Daily Compliance',
    group: 'Attendance',
    description: '4-time-point breakdown per employee per day, with late / short-day / no-lunch flags. Use to spot daily violations.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'AttDate',          label: 'Date',          width: 12, type: COL_TYPES.DATE },
      { key: 'EmpCode',          label: 'Emp Code',      width: 12 },
      { key: 'Name',             label: 'Name',          width: 24 },
      { key: 'Department',       label: 'Department',    width: 14 },
      { key: 'SignInTime',       label: 'Sign In',       width: 16, type: COL_TYPES.DATETIME },
      { key: 'LunchOutTime',     label: 'Lunch Out',     width: 16, type: COL_TYPES.DATETIME },
      { key: 'LunchInTime',      label: 'Lunch In',      width: 16, type: COL_TYPES.DATETIME },
      { key: 'LunchDurationMin', label: 'Lunch (min)',   width: 10, type: COL_TYPES.INT },
      { key: 'SignOutTime',      label: 'Sign Out',      width: 16, type: COL_TYPES.DATETIME },
      { key: 'TotalWorkMin',     label: 'Work (min)',    width: 10, type: COL_TYPES.INT },
      { key: 'LateSignIn',       label: 'Late In',       width: 9,  type: COL_TYPES.BOOL },
      { key: 'LateLunchReturn',  label: 'Late Lunch',    width: 11, type: COL_TYPES.BOOL },
      { key: 'ShortDay',         label: 'Short Day',     width: 10, type: COL_TYPES.BOOL },
      { key: 'AutoSignOut',      label: 'Auto Out',      width: 9,  type: COL_TYPES.BOOL },
      { key: 'ComplianceFlags',  label: 'Flags',         width: 28 },
    ],
    sql: (p) => ({ query: `
      SELECT A.AttDate, E.EmpCode, U.Name, E.Department,
             A.SignInTime, A.LunchOutTime, A.LunchInTime, A.LunchDurationMin,
             A.SignOutTime, A.TotalWorkMin,
             A.LateSignIn, A.LateLunchReturn, A.ShortDay, A.AutoSignOut,
             A.ComplianceFlags
      FROM HRM_Attendance A
      JOIN User_Login U   ON U.Id = A.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = A.UserId
      WHERE A.AttDate BETWEEN @from AND @to
        AND A.SignInTime IS NOT NULL
      ORDER BY A.AttDate DESC, U.Name;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  // Monthly aggregate — counts of each violation per employee. Drives HR's
  // monthly review cycle (warn / fine / appreciate based on counts).
  {
    key: 'monthly-compliance',
    name: 'Monthly Compliance Summary',
    group: 'Attendance',
    description: 'Per-employee counts of late sign-ins, late lunches, short days, no-lunch days, auto sign-outs, and total work hours.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'EmpCode',         label: 'Emp Code',       width: 12 },
      { key: 'Name',            label: 'Name',           width: 26 },
      { key: 'Department',      label: 'Department',     width: 14 },
      { key: 'DaysPresent',     label: 'Days Present',   width: 12, type: COL_TYPES.INT },
      { key: 'LateSignInDays',  label: 'Late In',        width: 10, type: COL_TYPES.INT },
      { key: 'LateLunchDays',   label: 'Late Lunch',     width: 11, type: COL_TYPES.INT },
      { key: 'ShortDays',       label: 'Short Days',     width: 11, type: COL_TYPES.INT },
      { key: 'NoLunchDays',     label: 'No-Lunch Days',  width: 14, type: COL_TYPES.INT },
      { key: 'AutoSignOutDays', label: 'Auto Sign-Outs', width: 14, type: COL_TYPES.INT },
      { key: 'TotalWorkHours',  label: 'Work (hrs)',     width: 11, type: COL_TYPES.NUMBER },
      { key: 'AvgLunchMin',     label: 'Avg Lunch (min)',width: 14, type: COL_TYPES.INT },
    ],
    sql: (p) => ({ query: `
      SELECT
        E.EmpCode,
        U.Name,
        E.Department,
        COUNT(DISTINCT CASE WHEN A.SignInTime IS NOT NULL THEN A.AttDate END) AS DaysPresent,
        SUM(CASE WHEN A.LateSignIn      = 1 THEN 1 ELSE 0 END)               AS LateSignInDays,
        SUM(CASE WHEN A.LateLunchReturn = 1 THEN 1 ELSE 0 END)               AS LateLunchDays,
        SUM(CASE WHEN A.ShortDay        = 1 THEN 1 ELSE 0 END)               AS ShortDays,
        SUM(CASE WHEN A.SignInTime IS NOT NULL AND A.LunchOutTime IS NULL THEN 1 ELSE 0 END) AS NoLunchDays,
        SUM(CASE WHEN A.AutoSignOut     = 1 THEN 1 ELSE 0 END)               AS AutoSignOutDays,
        CAST(ISNULL(SUM(A.TotalWorkMin), 0) / 60.0 AS DECIMAL(8,2))          AS TotalWorkHours,
        CAST(AVG(CAST(A.LunchDurationMin AS DECIMAL(8,2))) AS INT)           AS AvgLunchMin
      FROM HRM_Attendance A
      JOIN User_Login U   ON U.Id = A.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = A.UserId
      WHERE A.AttDate BETWEEN @from AND @to
      GROUP BY E.EmpCode, U.Name, E.Department
      ORDER BY LateSignInDays DESC, ShortDays DESC, U.Name;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  // ── Attendance + Visits (office sign-in/out + field visits, per day) ────────
  // Fills the gap between attendance (HRM_Attendance) and field activity
  // (HRM_Visit): one row per employee per day with login/logout, work hours,
  // and the visits done that day (count, time on site, customers). A matrix
  // month-grid of the same data streams from GET /attendance-matrix below.
  {
    key: 'attendance-visits',
    name: 'Attendance + Visits (Daily)',
    group: 'Attendance',
    description: 'Per employee per day: sign in / sign out, work hours, plus the field visits done that day (count, time on site, customers).',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'AttDate',     label: 'Date',            width: 12, type: COL_TYPES.DATE },
      { key: 'EmpCode',     label: 'Emp Code',        width: 12 },
      { key: 'Name',        label: 'Name',            width: 22 },
      { key: 'Department',  label: 'Department',      width: 14 },
      { key: 'Status',      label: 'Status',          width: 8 },
      { key: 'SignInTime',  label: 'Sign In',         width: 16, type: COL_TYPES.DATETIME },
      { key: 'SignOutTime', label: 'Sign Out',        width: 16, type: COL_TYPES.DATETIME },
      { key: 'WorkHrs',     label: 'Work (hrs)',      width: 10, type: COL_TYPES.NUMBER },
      { key: 'LateSignIn',  label: 'Late In',         width: 9,  type: COL_TYPES.BOOL },
      { key: 'ShortDay',    label: 'Short Day',       width: 10, type: COL_TYPES.BOOL },
      { key: 'Visits',      label: 'Visits',          width: 8,  type: COL_TYPES.INT },
      { key: 'VisitMin',    label: 'On-Visit (min)',  width: 13, type: COL_TYPES.INT },
      { key: 'Customers',   label: 'Customers Visited', width: 44 },
    ],
    sql: (p) => ({ query: `
      SELECT A.AttDate, E.EmpCode, U.Name, E.Department, A.Status,
             A.SignInTime, A.SignOutTime,
             CAST(ISNULL(A.TotalWorkMin,0) / 60.0 AS DECIMAL(6,2)) AS WorkHrs,
             A.LateSignIn, A.ShortDay,
             ISNULL(V.Visits, 0)   AS Visits,
             ISNULL(V.VisitMin, 0) AS VisitMin,
             V.Customers
      FROM HRM_Attendance A
      JOIN User_Login U        ON U.Id = A.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = A.UserId
      OUTER APPLY (
        SELECT COUNT(*) AS Visits,
               SUM(ISNULL(HV.DurationMin, 0))         AS VisitMin,
               STRING_AGG(HV.CustomerName, ', ')      AS Customers
        FROM HRM_Visit HV
        WHERE HV.UserId = A.UserId
          AND CAST(HV.EntryTime AS DATE) = A.AttDate
          AND ISNULL(HV.CustomerName, '') <> ''
      ) V
      WHERE A.AttDate BETWEEN @from AND @to
      ORDER BY A.AttDate DESC, U.Name;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  // ── Leave ──────────────────────────────────────────────────────────────────
  {
    key: 'leave-register',
    name: 'Leave Register',
    group: 'Leave',
    description: 'All leave applications with overlap in the given range.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'LeaveId',      label: '#',           width: 6,  type: COL_TYPES.INT },
      { key: 'EmpCode',      label: 'Emp Code',    width: 12 },
      { key: 'Name',         label: 'Name',        width: 24 },
      { key: 'LeaveTypeCode',label: 'Type',        width: 8 },
      { key: 'FromDate',     label: 'From',        width: 12, type: COL_TYPES.DATE },
      { key: 'ToDate',       label: 'To',          width: 12, type: COL_TYPES.DATE },
      { key: 'DaysApplied',  label: 'Days',        width: 8,  type: COL_TYPES.NUMBER },
      { key: 'Status',       label: 'Status',      width: 10 },
      { key: 'Reason',       label: 'Reason',      width: 30 },
      { key: 'AppliedAt',    label: 'Applied At',  width: 16, type: COL_TYPES.DATETIME },
    ],
    sql: (p) => ({ query: `
      SELECT L.LeaveId, E.EmpCode, U.Name, L.LeaveTypeCode,
             L.FromDate, L.ToDate, L.DaysApplied, L.Status, L.Reason, L.AppliedAt
      FROM HRM_Leave L
      JOIN User_Login U ON U.Id = L.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = L.UserId
      WHERE NOT (L.ToDate < @from OR L.FromDate > @to)
      ORDER BY L.AppliedAt DESC;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  {
    key: 'regularization-log',
    name: 'Regularization Log',
    group: 'Leave',
    description: 'Regularization requests applied within the range, with current status.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'RegId',         label: '#',           width: 6, type: COL_TYPES.INT },
      { key: 'EmpCode',       label: 'Emp Code',    width: 12 },
      { key: 'Name',          label: 'Name',        width: 22 },
      { key: 'AttDate',       label: 'For Date',    width: 12, type: COL_TYPES.DATE },
      { key: 'RequestedSignInTime',  label: 'Req In',  width: 10 },
      { key: 'RequestedSignOutTime', label: 'Req Out', width: 10 },
      { key: 'Reason',        label: 'Reason',      width: 26 },
      { key: 'Status',        label: 'Status',      width: 10 },
      { key: 'AppliedAt',     label: 'Applied At',  width: 16, type: COL_TYPES.DATETIME },
      { key: 'DecidedAt',     label: 'Decided At',  width: 16, type: COL_TYPES.DATETIME },
      { key: 'DecidedBy',     label: 'Decided By',  width: 18 },
    ],
    sql: (p) => ({ query: `
      SELECT R.RegId, E.EmpCode, U.Name, R.AttDate,
             CAST(R.RequestedSignInTime  AS NVARCHAR(8)) AS RequestedSignInTime,
             CAST(R.RequestedSignOutTime AS NVARCHAR(8)) AS RequestedSignOutTime,
             R.Reason, R.Status, R.AppliedAt,
             COALESCE(R.ApprovedAt, R.RejectedAt, R.CancelledAt) AS DecidedAt,
             COALESCE(UD1.Name, UD2.Name) AS DecidedBy
      FROM HRM_Regularization R
      JOIN User_Login U ON U.Id = R.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = R.UserId
      LEFT JOIN User_Login UD1 ON UD1.Id = R.ApprovedBy
      LEFT JOIN User_Login UD2 ON UD2.Id = R.RejectedBy
      WHERE R.AppliedAt BETWEEN @from AND DATEADD(DAY, 1, @to)
      ORDER BY R.AppliedAt DESC;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  // ── Geo / Anomaly ──────────────────────────────────────────────────────────
  {
    key: 'anomaly-report',
    name: 'Anomaly Report',
    group: 'Geo',
    description: 'Sign-in / sign-out anomalies detected within the range.',
    params: [
      { key: 'from', label: 'From', type: 'date', required: true },
      { key: 'to',   label: 'To',   type: 'date', required: true },
    ],
    columns: [
      { key: 'AnomalyId',   label: '#',          width: 7,  type: COL_TYPES.INT },
      { key: 'AnomalyDate', label: 'Date',       width: 12, type: COL_TYPES.DATE },
      { key: 'EmpCode',     label: 'Emp Code',   width: 12 },
      { key: 'Name',        label: 'Name',       width: 22 },
      { key: 'Kind',        label: 'Kind',       width: 18 },
      { key: 'Severity',    label: 'Severity',   width: 10 },
      { key: 'IsResolved',  label: 'Resolved?',  width: 10, type: COL_TYPES.BOOL },
      { key: 'ResolvedAt',  label: 'Resolved At',width: 16, type: COL_TYPES.DATETIME },
    ],
    sql: (p) => ({ query: `
      SELECT A.AnomalyId, A.AnomalyDate, E.EmpCode, U.Name, A.Kind, A.Severity,
             A.IsResolved, A.ResolvedAt
      FROM HRM_Anomaly A
      JOIN User_Login U ON U.Id = A.UserId
      LEFT JOIN HRM_Employee E ON E.UserId = A.UserId
      WHERE A.AnomalyDate BETWEEN @from AND @to
      ORDER BY A.AnomalyDate DESC, A.AnomalyId DESC;`,
      inputs: { from: [sql.Date, p.from], to: [sql.Date, p.to] },
    }),
  },

  // ── Statutory (Phase 5F) — driven by payslip data ─────────────────────────
  {
    key: 'wage-register-mh',
    name: 'Wage Register (Form XVII — Maharashtra)',
    group: 'Statutory',
    description: 'Per-employee monthly pay breakdown for a chosen month. Used for Maharashtra Minimum Wages Act compliance.',
    params: [
      { key: 'year',    label: 'Year (calendar)', type: 'int', required: true },
      { key: 'monthNo', label: 'Month (1-12)',    type: 'int', required: true, default: () => new Date().getMonth() + 1 },
    ],
    columns: [
      { key: 'EmpCode',         label: 'Emp Code',     width: 12 },
      { key: 'Name',            label: 'Name',         width: 24 },
      { key: 'Designation',     label: 'Designation',  width: 18 },
      { key: 'DateOfJoining',   label: 'DOJ',          width: 12, type: COL_TYPES.DATE },
      { key: 'DaysInMonth',     label: 'Days',         width: 6,  type: COL_TYPES.INT },
      { key: 'LopDays',         label: 'LOP',          width: 6,  type: COL_TYPES.NUMBER },
      { key: 'PayableDays',     label: 'Payable',      width: 8,  type: COL_TYPES.NUMBER },
      { key: 'MonthlyGross',    label: 'Gross',        width: 14, type: COL_TYPES.NUMBER },
      { key: 'TotalDeductions', label: 'Deductions',   width: 14, type: COL_TYPES.NUMBER },
      { key: 'NetPay',          label: 'Net Pay',      width: 14, type: COL_TYPES.NUMBER },
      { key: 'PFNo',            label: 'PF No',        width: 14 },
      { key: 'ESINumber',       label: 'ESI No',       width: 14 },
    ],
    sql: (p) => ({ query: `
      DECLARE @ps DATE = DATEFROMPARTS(@year, @monthNo, 1);
      DECLARE @pe DATE = EOMONTH(@ps);
      SELECT P.EmpCode, P.EmpName AS Name, P.Designation, P.DateOfJoining,
             P.DaysInMonth, P.LopDays, P.PayableDays,
             P.MonthlyGross, P.TotalDeductions, P.NetPay, P.PFNo, P.ESINumber
      FROM HRM_Payslip P
      JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
      WHERE R.PeriodStart = @ps AND R.PeriodEnd = @pe
        AND P.Status IN ('locked','paid')
      ORDER BY P.EmpCode;`,
      inputs: { year: [sql.Int, p.year], monthNo: [sql.Int, p.monthNo] },
    }),
  },
  {
    key: 'register-of-deductions',
    name: 'Register of Deductions (Form XII)',
    group: 'Statutory',
    description: 'Component-wise deduction breakdown per employee for a chosen month. Required under Payment of Wages Act.',
    params: [
      { key: 'year',    label: 'Year (calendar)', type: 'int', required: true },
      { key: 'monthNo', label: 'Month (1-12)',    type: 'int', required: true, default: () => new Date().getMonth() + 1 },
    ],
    columns: [
      { key: 'EmpCode',       label: 'Emp Code',  width: 12 },
      { key: 'EmpName',       label: 'Name',      width: 24 },
      { key: 'ComponentCode', label: 'Code',      width: 10 },
      { key: 'ComponentName', label: 'Component', width: 22 },
      { key: 'EarnedAmount',  label: 'Amount',    width: 14, type: COL_TYPES.NUMBER },
    ],
    sql: (p) => ({ query: `
      DECLARE @ps DATE = DATEFROMPARTS(@year, @monthNo, 1);
      DECLARE @pe DATE = EOMONTH(@ps);
      SELECT P.EmpCode, P.EmpName, L.ComponentCode, L.ComponentName, L.EarnedAmount
      FROM HRM_Payslip_Line L
      JOIN HRM_Payslip P ON P.PayslipId = L.PayslipId
      JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
      WHERE L.Kind = 'Deduction'
        AND R.PeriodStart = @ps AND R.PeriodEnd = @pe
        AND P.Status IN ('locked','paid')
      ORDER BY P.EmpCode, L.DisplayOrder, L.ComponentCode;`,
      inputs: { year: [sql.Int, p.year], monthNo: [sql.Int, p.monthNo] },
    }),
  },
  {
    key: 'pf-contribution-register',
    name: 'PF Contribution Register',
    group: 'Statutory',
    description: 'Per-employee Basic + PF Employee Contribution for a chosen month (for EPFO ECR upload).',
    params: [
      { key: 'year',    label: 'Year (calendar)', type: 'int', required: true },
      { key: 'monthNo', label: 'Month (1-12)',    type: 'int', required: true, default: () => new Date().getMonth() + 1 },
    ],
    columns: [
      { key: 'EmpCode',     label: 'Emp Code',      width: 12 },
      { key: 'EmpName',     label: 'Name',          width: 24 },
      { key: 'UAN',         label: 'UAN',           width: 16 },
      { key: 'PFNo',        label: 'PF No',         width: 16 },
      { key: 'BasicEarned', label: 'Basic Earned',  width: 14, type: COL_TYPES.NUMBER },
      { key: 'PFEmployee',  label: 'PF Employee',   width: 14, type: COL_TYPES.NUMBER },
    ],
    sql: (p) => ({ query: `
      DECLARE @ps DATE = DATEFROMPARTS(@year, @monthNo, 1);
      DECLARE @pe DATE = EOMONTH(@ps);
      SELECT P.EmpCode, P.EmpName, P.UAN, P.PFNo,
             ISNULL((SELECT EarnedAmount FROM HRM_Payslip_Line WHERE PayslipId = P.PayslipId AND ComponentCode = 'BASIC'),  0) AS BasicEarned,
             ISNULL((SELECT EarnedAmount FROM HRM_Payslip_Line WHERE PayslipId = P.PayslipId AND ComponentCode = 'PF_EE'),  0) AS PFEmployee
      FROM HRM_Payslip P JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
      WHERE R.PeriodStart = @ps AND R.PeriodEnd = @pe AND P.Status IN ('locked','paid')
      ORDER BY P.EmpCode;`,
      inputs: { year: [sql.Int, p.year], monthNo: [sql.Int, p.monthNo] },
    }),
  },
  {
    key: 'pt-register-mh',
    name: 'Professional Tax Register (Maharashtra)',
    group: 'Statutory',
    description: 'Per-employee PT deduction for a chosen month — for monthly PT challan / annual Form III-B.',
    params: [
      { key: 'year',    label: 'Year (calendar)', type: 'int', required: true },
      { key: 'monthNo', label: 'Month (1-12)',    type: 'int', required: true, default: () => new Date().getMonth() + 1 },
    ],
    columns: [
      { key: 'EmpCode',      label: 'Emp Code',     width: 12 },
      { key: 'EmpName',      label: 'Name',         width: 24 },
      { key: 'Designation',  label: 'Designation',  width: 18 },
      { key: 'PAN',          label: 'PAN',          width: 14 },
      { key: 'MonthlyGross', label: 'Gross',        width: 14, type: COL_TYPES.NUMBER },
      { key: 'PTAmount',     label: 'PT',           width: 10, type: COL_TYPES.NUMBER },
    ],
    sql: (p) => ({ query: `
      DECLARE @ps DATE = DATEFROMPARTS(@year, @monthNo, 1);
      DECLARE @pe DATE = EOMONTH(@ps);
      SELECT P.EmpCode, P.EmpName, P.Designation, P.PAN, P.MonthlyGross,
             ISNULL((SELECT EarnedAmount FROM HRM_Payslip_Line WHERE PayslipId = P.PayslipId AND ComponentCode = 'PT_MH'), 0) AS PTAmount
      FROM HRM_Payslip P JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
      WHERE R.PeriodStart = @ps AND R.PeriodEnd = @pe AND P.Status IN ('locked','paid')
      ORDER BY P.EmpCode;`,
      inputs: { year: [sql.Int, p.year], monthNo: [sql.Int, p.monthNo] },
    }),
  },
  {
    key: 'esi-contribution-register',
    name: 'ESI Contribution Register',
    group: 'Statutory',
    description: 'Per-employee ESI deduction for a chosen month (gross-eligible employees only). For ESIC return upload.',
    params: [
      { key: 'year',    label: 'Year (calendar)', type: 'int', required: true },
      { key: 'monthNo', label: 'Month (1-12)',    type: 'int', required: true, default: () => new Date().getMonth() + 1 },
    ],
    columns: [
      { key: 'EmpCode',      label: 'Emp Code',     width: 12 },
      { key: 'EmpName',      label: 'Name',         width: 24 },
      { key: 'ESINumber',    label: 'ESI No',       width: 14 },
      { key: 'MonthlyGross', label: 'Gross',        width: 14, type: COL_TYPES.NUMBER },
      { key: 'ESIAmount',    label: 'ESI Deducted', width: 14, type: COL_TYPES.NUMBER },
    ],
    sql: (p) => ({ query: `
      DECLARE @ps DATE = DATEFROMPARTS(@year, @monthNo, 1);
      DECLARE @pe DATE = EOMONTH(@ps);
      SELECT P.EmpCode, P.EmpName, P.ESINumber, P.MonthlyGross,
             ISNULL((SELECT EarnedAmount FROM HRM_Payslip_Line WHERE PayslipId = P.PayslipId AND ComponentCode = 'ESI_EE'), 0) AS ESIAmount
      FROM HRM_Payslip P JOIN HRM_Payroll_Run R ON R.RunId = P.RunId
      WHERE R.PeriodStart = @ps AND R.PeriodEnd = @pe AND P.Status IN ('locked','paid')
      ORDER BY P.EmpCode;`,
      inputs: { year: [sql.Int, p.year], monthNo: [sql.Int, p.monthNo] },
    }),
  },
];

// Lookup by key
function reportByKey(key) { return REPORTS.find(r => r.key === key); }

// ── GET /list — for the picker UI ────────────────────────────────────────────
router.get('/list', authenticate, (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  res.json({
    reports: REPORTS.map(r => ({
      key:         r.key,
      name:        r.name,
      group:       r.group,
      description: r.description,
      params:      (r.params || []).map(p => ({
        key:      p.key,
        label:    p.label,
        type:     p.type,
        required: !!p.required,
        default:  typeof p.default === 'function' ? p.default() : (p.default ?? null),
      })),
      columns: r.columns.map(c => ({ key: c.key, label: c.label, type: c.type || COL_TYPES.STRING })),
    })),
  });
});

// ── Validate filters and coerce types ───────────────────────────────────────
function coerceFilters(def, raw) {
  const out = {};
  for (const p of (def.params || [])) {
    let v = raw && Object.prototype.hasOwnProperty.call(raw, p.key) ? raw[p.key] : null;
    if (v === '' || v === undefined) v = null;
    if (v == null) {
      if (p.required) throw new Error(`Missing required filter: ${p.label}`);
      if (typeof p.default === 'function') v = p.default();
      else if (p.default !== undefined)    v = p.default;
    }
    if (v != null) {
      if (p.type === 'date') {
        const d = new Date(v);
        if (isNaN(d)) throw new Error(`Invalid date for ${p.label}`);
        out[p.key] = d;
      } else if (p.type === 'int') {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n)) throw new Error(`Invalid number for ${p.label}`);
        out[p.key] = n;
      } else {
        out[p.key] = String(v);
      }
    }
  }
  return out;
}

// ── POST /run ────────────────────────────────────────────────────────────────
router.post('/run', authenticate, async (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  const { key, filters, format } = req.body || {};
  const def = reportByKey(key);
  if (!def) return res.status(404).json({ message: 'Unknown report: ' + key });
  const fmt = (format || 'json').toLowerCase();
  if (!['json', 'xlsx', 'pdf'].includes(fmt)) {
    return res.status(400).json({ message: 'format must be json|xlsx|pdf' });
  }

  let coerced;
  try { coerced = coerceFilters(def, filters || {}); }
  catch (err) { return res.status(400).json({ message: err.message }); }

  // Build + run SQL
  let rows = [];
  try {
    const pool = await getAppPool();
    const r = pool.request();
    const { query, inputs } = def.sql(coerced);
    for (const [k, [type, val]] of Object.entries(inputs || {})) r.input(k, type, val);
    const result = await r.query(query);
    rows = result.recordset || [];
  } catch (err) {
    console.error('[reports/run]', def.key, err);
    return res.status(500).json({ message: 'Query failed', error: err.message });
  }

  // Dispatch by format
  if (fmt === 'json') {
    return res.json({
      key:     def.key,
      name:    def.name,
      group:   def.group,
      filters: coerced,
      runAt:   new Date().toISOString(),
      runBy:   req.user && (req.user.name || req.user.username),
      columns: def.columns.map(c => ({ key: c.key, label: c.label, type: c.type || COL_TYPES.STRING })),
      rows,
    });
  }

  const fileBase = `${def.key}_${new Date().toISOString().slice(0,10)}`;

  if (fmt === 'xlsx') return streamXlsx(res, def, rows, coerced, fileBase);
  if (fmt === 'pdf')  return streamPdf(res, def, rows, coerced, fileBase, req.user);
});

// ── XLSX export ──────────────────────────────────────────────────────────────
function streamXlsx(res, def, rows, filters, fileBase) {
  // Build arrays-of-arrays: title row, blank, filter line (if any), blank, header, then data
  const aoa = [];
  aoa.push([def.name]);
  aoa.push([def.description || '']);
  const filterParts = Object.entries(filters || {}).map(([k, v]) => {
    const p = (def.params || []).find(pp => pp.key === k);
    return `${p ? p.label : k}: ${v instanceof Date ? fmtDate(v) : v}`;
  });
  if (filterParts.length) aoa.push(['Filters: ' + filterParts.join(' · ')]);
  aoa.push([`Generated: ${fmtDateTime(new Date())}`]);
  aoa.push([]);
  aoa.push(def.columns.map(c => c.label));
  for (const row of rows) {
    aoa.push(def.columns.map(c => {
      const v = row[c.key];
      if (v == null) return '';
      // Native types for Excel: keep dates as Date so Excel formats them
      if (c.type === COL_TYPES.DATE || c.type === COL_TYPES.DATETIME) {
        const d = new Date(v);
        return isNaN(d) ? String(v) : d;
      }
      if (c.type === COL_TYPES.BOOL) return v ? 'Yes' : 'No';
      if (c.type === COL_TYPES.NUMBER || c.type === COL_TYPES.INT) {
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
      }
      return v;
    }));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = def.columns.map(c => ({ wch: Math.max(8, (c.width || 16)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, def.name.slice(0, 31).replace(/[^a-z0-9 _-]/gi, '_'));
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
  res.send(buf);
}

// ── PDF export (landscape table) ─────────────────────────────────────────────
function streamPdf(res, def, rows, filters, fileBase, user) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`);
  doc.pipe(res);

  // Header
  doc.fontSize(16).fillColor('#111').text('ONE App Lens — ' + def.name);
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor('#555').text(def.description || '');
  const filterParts = Object.entries(filters || {}).map(([k, v]) => {
    const p = (def.params || []).find(pp => pp.key === k);
    return `${p ? p.label : k}: ${v instanceof Date ? fmtDate(v) : v}`;
  });
  if (filterParts.length) doc.text('Filters · ' + filterParts.join(' · '));
  doc.text(`Generated: ${fmtDateTime(new Date())} by ${user ? (user.name || user.username) : '—'}    Rows: ${rows.length}`);
  doc.moveDown(0.6);

  // Compute column widths to fit page width
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalW = def.columns.reduce((s, c) => s + (c.width || 14), 0);
  const colW = def.columns.map(c => Math.floor(((c.width || 14) / totalW) * pageWidth));

  const headerH = 18;
  const rowH    = 14;
  let y = doc.y;

  function drawHeader() {
    const x0 = doc.page.margins.left;
    doc.rect(x0, y, pageWidth, headerH).fillAndStroke('#eef2ff', '#c7d2fe');
    doc.fillColor('#1e3a8a').fontSize(8.5).font('Helvetica-Bold');
    let x = x0;
    def.columns.forEach((c, i) => {
      doc.text(c.label, x + 4, y + 4, { width: colW[i] - 6, height: headerH - 4, ellipsis: true });
      x += colW[i];
    });
    y += headerH;
    doc.font('Helvetica').fillColor('#222');
  }

  function drawRow(row, alt) {
    if (y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }
    const x0 = doc.page.margins.left;
    if (alt) doc.rect(x0, y, pageWidth, rowH).fillAndStroke('#fafafa', '#fafafa');
    doc.fillColor('#222').fontSize(8).font('Helvetica');
    let x = x0;
    def.columns.forEach((c, i) => {
      const v = fmtCell(row[c.key], c.type);
      doc.text(v, x + 4, y + 3, { width: colW[i] - 6, height: rowH - 2, ellipsis: true, lineBreak: false });
      x += colW[i];
    });
    y += rowH;
  }

  drawHeader();
  rows.forEach((row, idx) => drawRow(row, idx % 2 === 1));

  if (!rows.length) {
    doc.fillColor('#888').fontSize(11).font('Helvetica-Oblique')
       .text('No rows matched the filters.', doc.page.margins.left, y + 10);
  }

  doc.end();
}

// ── GET /attendance-matrix?month=YYYY-MM — monthly per-employee grid (xlsx) ────
// Days-as-columns matrix like the Matrix Comsec register: one block per employee
// with rows IN / OUT / Work Hrs / Visits / Status across the month. HR/admin only.
// (The report engine only builds flat tables, so this is a dedicated export.)
router.get('/attendance-matrix', authenticate, async (req, res) => {
  if (!isLensAdmin(req.user)) return res.status(403).json({ message: 'HR / admin only' });
  const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || ''));
  const now   = new Date();
  const year  = m ? parseInt(m[1], 10) : now.getFullYear();
  const month = m ? parseInt(m[2], 10) : now.getMonth() + 1;   // 1-12
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart  = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth   = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  try {
    const pool = await getAppPool();
    const result = await pool.request()
      .input('ms', sql.Date, monthStart)
      .input('me', sql.Date, nextMonth)
      .query(`
        SELECT A.UserId, U.Name, E.EmpCode, E.Department,
               DAY(A.AttDate) AS D,
               CONVERT(varchar(5), A.SignInTime,  108) AS InHM,
               CONVERT(varchar(5), A.SignOutTime, 108) AS OutHM,
               ISNULL(A.TotalWorkMin, 0) AS WorkMin,
               A.Status,
               (SELECT COUNT(*) FROM HRM_Visit HV
                  WHERE HV.UserId = A.UserId AND CAST(HV.EntryTime AS DATE) = A.AttDate
                    AND ISNULL(HV.CustomerName, '') <> '') AS Visits
        FROM HRM_Attendance A
        JOIN User_Login U        ON U.Id = A.UserId
        LEFT JOIN HRM_Employee E ON E.UserId = A.UserId
        WHERE A.AttDate >= @ms AND A.AttDate < @me
        ORDER BY U.Name, A.AttDate;`);

    // group by employee → { code, dept, days: { <dayNo>: row } }
    const emps = new Map();
    for (const row of result.recordset) {
      let e = emps.get(row.UserId);
      if (!e) { e = { name: row.Name, code: row.EmpCode, dept: row.Department, days: {} }; emps.set(row.UserId, e); }
      e.days[row.D] = row;
    }

    const hm = (min) => Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
    const dayCols = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const aoa = [];
    aoa.push([`Attendance + Visits — ${MONTHS[month - 1]} ${year}`]);
    aoa.push([`Generated ${fmtDateTime(new Date())} by ${(req.user && (req.user.name || req.user.username)) || ''}`]);
    aoa.push([]);

    const sorted = [...emps.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!sorted.length) aoa.push(['No attendance found for this month.']);
    for (const e of sorted) {
      aoa.push([`${e.name || ''}${e.code ? ' (' + e.code + ')' : ''}${e.dept ? ' - ' + e.dept : ''}`]);
      aoa.push(['', 'Day', ...dayCols, 'Total']);
      aoa.push(['', 'IN',  ...dayCols.map(d => (e.days[d] && e.days[d].InHM)  || '')]);
      aoa.push(['', 'OUT', ...dayCols.map(d => (e.days[d] && e.days[d].OutHM) || '')]);
      let totMin = 0;
      const hrsRow = dayCols.map(d => { const w = e.days[d] ? e.days[d].WorkMin : 0; totMin += w; return w ? hm(w) : ''; });
      aoa.push(['', 'Work Hrs', ...hrsRow, hm(totMin)]);
      let totVis = 0;
      const visRow = dayCols.map(d => { const v = e.days[d] ? e.days[d].Visits : 0; totVis += v; return v || ''; });
      aoa.push(['', 'Visits', ...visRow, totVis || '']);
      aoa.push(['', 'Status', ...dayCols.map(d => (e.days[d] ? (e.days[d].Status || (e.days[d].InHM ? 'P' : '')) : ''))]);
      aoa.push([]);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 4 }, { wch: 10 }, ...dayCols.map(() => ({ wch: 6 })), { wch: 7 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance Matrix');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-matrix_${year}-${String(month).padStart(2, '0')}.xlsx"`);
    return res.end(buf);
  } catch (err) {
    console.error('[reports/attendance-matrix]', err);
    return res.status(500).json({ message: 'Matrix export failed', error: err.message });
  }
});

module.exports = router;
