-- ============================================================================
-- ONE App Lens — Attendance Compliance (Phase A)
-- File:  SQL Files/hr/56_attendance_compliance.sql
-- Date:  2026-05-27
--
-- WHAT IT DOES:
--   Extends HRM_Attendance with the columns needed to track the 4-time-point
--   day (sign-in → lunch out → lunch in → sign-out) plus rule-based compliance
--   flags. No existing data is touched; every new column is nullable / defaulted
--   so already-recorded attendance rows continue to read fine.
--
-- RULES (driven by these new columns):
--   * ExpectedSignOutTime = SignInTime + 8h30m  (8h work + 30m lunch)
--   * LunchOutTime / LunchInTime — auto-stamped by attendanceCompliance.js on
--     office-geofence exit / re-entry. Lunch start is FLEXIBLE (employees go
--     between 1:00-2:15 PM); must complete by 2:15 PM.
--   * LateSignIn       = SignInTime > 10:30 AM
--   * LateLunchReturn  = LunchInTime > 2:15 PM
--   * ShortDay         = SignOutTime < ExpectedSignOutTime - 10 min
--   * AutoSignOut      = 1 when the system stamped sign-out via geofence exit
--                        (no manual tap). Required because admin asked for
--                        "direct logout when employee crosses 100m boundary".
--   * ComplianceFlags  — comma-separated cache of the booleans above so reports
--                        don't have to re-compute each query.
--
-- SAFETY: ALTER TABLE ADD on additive columns; no rewrite. Re-runnable — each
-- column is guarded by sys.columns lookup.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;

DECLARE @sql NVARCHAR(MAX) = N'';

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'ExpectedSignOutTime')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD ExpectedSignOutTime DATETIME2(0) NULL;' + CHAR(10);

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchOutTime')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchOutTime DATETIME2(0) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchOutLat')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchOutLat DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchOutLng')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchOutLng DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchOutPingId')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchOutPingId BIGINT NULL;' + CHAR(10);

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchInTime')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchInTime DATETIME2(0) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchInLat')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchInLat DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchInLng')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchInLng DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchInPingId')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchInPingId BIGINT NULL;' + CHAR(10);

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LunchDurationMin')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LunchDurationMin INT NULL;' + CHAR(10);

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LateSignIn')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LateSignIn BIT NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'LateLunchReturn')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD LateLunchReturn BIT NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'ShortDay')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD ShortDay BIT NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'AutoSignOut')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD AutoSignOut BIT NOT NULL DEFAULT 0 WITH VALUES;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Attendance') AND name = 'ComplianceFlags')
  SET @sql += N'ALTER TABLE dbo.HRM_Attendance ADD ComplianceFlags NVARCHAR(200) NULL;' + CHAR(10);

IF LEN(@sql) = 0
  PRINT '[SKIP] HRM_Attendance compliance columns already present.';
ELSE
BEGIN
  EXEC sp_executesql @sql;
  PRINT '[OK] HRM_Attendance extended with compliance columns.';
END
GO

-- Helpful covering index for the daily-compliance report
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_HRM_Att_Compliance' AND object_id = OBJECT_ID('dbo.HRM_Attendance')
)
BEGIN
  CREATE INDEX IX_HRM_Att_Compliance
    ON dbo.HRM_Attendance (AttDate, UserId)
    INCLUDE (SignInTime, SignOutTime, LunchOutTime, LunchInTime,
             LateSignIn, LateLunchReturn, ShortDay, AutoSignOut);
  PRINT '[OK] IX_HRM_Att_Compliance created.';
END
ELSE PRINT '[SKIP] IX_HRM_Att_Compliance already exists.';
GO
