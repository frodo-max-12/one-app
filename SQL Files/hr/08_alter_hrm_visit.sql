-- ============================================================================
-- ONE App Lens — Phase 2.4 — ALTER HRM_Visit (add Label)
-- File:  SQL Files/hr/08_alter_hrm_visit.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * ADDITIVE ONLY — single nullable column. Existing rows + queries unaffected.
--   * IF NOT EXISTS guard — idempotent.
--   * SET XACT_ABORT ON — auto-rollback on error.
--
-- WHAT IT DOES:
--   Adds HRM_Visit.Label NVARCHAR(50) NULL — used by admins to tag unknown
--   stops as 'personal', 'lunch', 'skip', or any future category. NULL = work
--   stop (default). Hidden labels are filtered out of work-day rollups.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Visit]', 'U') IS NULL
BEGIN
    RAISERROR('HRM_Visit does not exist. Run 04_visit.sql first.', 16, 1);
    RETURN;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[HRM_Visit]') AND name = 'Label'
)
BEGIN
    ALTER TABLE [dbo].[HRM_Visit] ADD Label NVARCHAR(50) NULL;
    PRINT '[OK] Added HRM_Visit.Label';
END
ELSE PRINT '[SKIP] HRM_Visit.Label already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[HRM_Visit]') AND name = 'UpdatedBy'
)
BEGIN
    ALTER TABLE [dbo].[HRM_Visit] ADD UpdatedBy INT NULL;
    PRINT '[OK] Added HRM_Visit.UpdatedBy';
END
ELSE PRINT '[SKIP] HRM_Visit.UpdatedBy already exists';
GO

-- Verify
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'HRM_Visit'
  AND COLUMN_NAME IN ('Label', 'UpdatedBy')
ORDER BY COLUMN_NAME;
GO
