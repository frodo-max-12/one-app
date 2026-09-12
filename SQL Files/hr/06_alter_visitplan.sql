-- ============================================================================
-- ONE App Lens — Phase 0 — Table 6/6 (ALTER, not CREATE)
-- File:  SQL Files/hr/06_alter_visitplan.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * BizNAV_App.dbo.BN_VisitPlan ONLY. NAV DB untouched.
--   * ADDITIVE ONLY — new nullable columns. Existing rows + queries unaffected.
--   * Each ADD wrapped in IF NOT EXISTS — idempotent.
--   * Zero data loss: no DROP, no ALTER on existing columns, no type change.
--   * SET XACT_ABORT ON — rolls back on error.
--
-- WHAT IT DOES:
--   Adds 6 columns to BN_VisitPlan so Lens can:
--     1. Mark a visit as ad-hoc (walk-in / urgent / unplanned)
--     2. Track WHERE the visit originated (planned / ad-hoc / auto-detected from geofence)
--     3. Tag the department (SALES / FAE / JOINT) so a single table serves both depts
--     4. Capture the moment geofence dwell auto-confirmed the visit
--     5. Link to the entry/exit pings that proved the visit happened
--
-- COMPATIBILITY:
--   Existing visitPlan.js routes do NOT reference these columns and won't break.
--   New Lens routes will read/write them.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[BN_VisitPlan]', 'U') IS NULL
BEGIN
    RAISERROR('BN_VisitPlan does not exist. Run BN_VisitPlan.sql first.', 16, 1);
    RETURN;
END
GO

-- 1. IsAdHoc -----------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[BN_VisitPlan]') AND name = 'IsAdHoc'
)
BEGIN
    ALTER TABLE [dbo].[BN_VisitPlan] ADD IsAdHoc BIT NOT NULL DEFAULT 0;
    PRINT '[OK] Added BN_VisitPlan.IsAdHoc';
END ELSE PRINT '[SKIP] BN_VisitPlan.IsAdHoc already exists';
GO

-- 2. Source ------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[BN_VisitPlan]') AND name = 'Source'
)
BEGIN
    ALTER TABLE [dbo].[BN_VisitPlan] ADD Source NVARCHAR(20) NULL;  -- 'planned' | 'ad-hoc' | 'auto-geofence' | 'walk-in'
    PRINT '[OK] Added BN_VisitPlan.Source';
END ELSE PRINT '[SKIP] BN_VisitPlan.Source already exists';
GO

-- 3. Department --------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[BN_VisitPlan]') AND name = 'Department'
)
BEGIN
    ALTER TABLE [dbo].[BN_VisitPlan] ADD Department NVARCHAR(10) NULL DEFAULT 'SALES';  -- 'SALES' | 'FAE' | 'JOINT'
    PRINT '[OK] Added BN_VisitPlan.Department';
END ELSE PRINT '[SKIP] BN_VisitPlan.Department already exists';
GO

-- 4. AutoConfirmedAt ---------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[BN_VisitPlan]') AND name = 'AutoConfirmedAt'
)
BEGIN
    ALTER TABLE [dbo].[BN_VisitPlan] ADD AutoConfirmedAt DATETIME2(0) NULL;
    PRINT '[OK] Added BN_VisitPlan.AutoConfirmedAt';
END ELSE PRINT '[SKIP] BN_VisitPlan.AutoConfirmedAt already exists';
GO

-- 5. EntryPingId -------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[BN_VisitPlan]') AND name = 'EntryPingId'
)
BEGIN
    ALTER TABLE [dbo].[BN_VisitPlan] ADD EntryPingId BIGINT NULL;
    PRINT '[OK] Added BN_VisitPlan.EntryPingId';
END ELSE PRINT '[SKIP] BN_VisitPlan.EntryPingId already exists';
GO

-- 6. ExitPingId --------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[BN_VisitPlan]') AND name = 'ExitPingId'
)
BEGIN
    ALTER TABLE [dbo].[BN_VisitPlan] ADD ExitPingId BIGINT NULL;
    PRINT '[OK] Added BN_VisitPlan.ExitPingId';
END ELSE PRINT '[SKIP] BN_VisitPlan.ExitPingId already exists';
GO

-- Verify
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'BN_VisitPlan'
  AND COLUMN_NAME IN ('IsAdHoc','Source','Department','AutoConfirmedAt','EntryPingId','ExitPingId')
ORDER BY ORDINAL_POSITION;
GO
