-- ============================================================================
-- ONE App v1.8 — ALTER HRM_Visit: Punch-In / Punch-Out columns
-- File:  SQL Files/hr/60_alter_hrm_visit_punch.sql
-- Date:  2026-06-03
--
-- WHY:
--   v1.7 ships geofence auto-detect (dwell >= 5 min) + manual "Mark Done" as
--   the visit-confirmation paths. v1.8 introduces explicit Punch-In/Punch-Out
--   at the customer premises with photo evidence. The new flow:
--
--     1. Rep arrives at customer  → taps PUNCH IN
--          - app captures GPS + selfie + premise photo
--          - server opens an HRM_Visit row with PunchIn* set
--     2. Meeting happens (MOM is filled in another software — out of scope)
--     3. Rep leaves                → taps PUNCH OUT
--          - app captures GPS + premise photo (no second selfie)
--          - server closes the HRM_Visit row with PunchOut* set
--
--   We extend HRM_Visit rather than introduce a new table so the existing
--   visit-detector, plan-tracker, day-journey, and reporting queries continue
--   to work unchanged — they just see one row per visit, manual or automatic.
--   `PunchInTime IS NOT NULL` is the test for "rep explicitly punched"; absence
--   means the visit was auto-detected only (geofence dwell, no manual punch).
--
--   Photo columns store the relative URL (e.g. /uploads/visit-punches/123/2026-06-03/45-in-selfie.jpg).
--   Actual files live under backend/uploads/visit-punches/ on the server.
--
-- SAFETY:
--   BizNAV_App.dbo.HRM_Visit only. All 9 columns are additive nullable, guarded
--   by IF NOT EXISTS so re-running is a no-op. Existing v1.7 routes ignore the
--   new columns (they SELECT explicit column lists), so prod stays unaffected.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;

DECLARE @sql NVARCHAR(MAX) = N'';

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchInTime')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchInTime DATETIME2 NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchInLat')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchInLat DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchInLng')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchInLng DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchInSelfieUrl')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchInSelfieUrl NVARCHAR(500) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchInPremisePhotoUrl')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchInPremisePhotoUrl NVARCHAR(500) NULL;' + CHAR(10);

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchOutTime')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchOutTime DATETIME2 NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchOutLat')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchOutLat DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchOutLng')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchOutLng DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'PunchOutPremisePhotoUrl')
  SET @sql += N'ALTER TABLE dbo.HRM_Visit ADD PunchOutPremisePhotoUrl NVARCHAR(500) NULL;' + CHAR(10);

IF LEN(@sql) = 0
  PRINT '[SKIP] HRM_Visit Punch-In/Out columns already present.';
ELSE
BEGIN
  EXEC sp_executesql @sql;
  PRINT '[OK] HRM_Visit extended with Punch-In + Punch-Out columns (GPS, time, photo URLs).';
END
GO

-- ── Helper index (optional, low cost) ──────────────────────────────────────
-- Speeds up "open punch-in visits for a user today" lookups used by the new
-- GET /api/hr/visit/today endpoint.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('dbo.HRM_Visit') AND name = 'IX_HRM_Visit_User_PunchIn_Open'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_HRM_Visit_User_PunchIn_Open
    ON dbo.HRM_Visit (UserId, PunchInTime)
    INCLUDE (CustomerCode, CustomerName, GeofenceId, ExitTime, PunchOutTime)
    WHERE PunchInTime IS NOT NULL;
  PRINT '[OK] Created filtered index IX_HRM_Visit_User_PunchIn_Open.';
END
ELSE
  PRINT '[SKIP] Index IX_HRM_Visit_User_PunchIn_Open already exists.';
GO
