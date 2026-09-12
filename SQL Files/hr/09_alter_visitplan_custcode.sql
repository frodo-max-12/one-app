-- ============================================================================
-- ONE App Lens — Phase 2.4 — ALTER BN_VisitPlan (add CustomerCode)
-- File:  SQL Files/hr/09_alter_visitplan_custcode.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * BizNAV_App.dbo.BN_VisitPlan ONLY. NAV DB untouched.
--   * ADDITIVE ONLY — single nullable column. Existing data + Visit Plan routes
--     unaffected; they currently match by CustomerName only.
--   * IF NOT EXISTS guard — idempotent. SET XACT_ABORT ON — auto-rollback.
--
-- WHAT IT DOES:
--   Adds BN_VisitPlan.CustomerCode NVARCHAR(50) NULL so Phase 2.4 auto
--   visit-confirm can do an EXACT customer match against HRM_Geofence (which
--   carries the same NAV customer code). Falls back to CustomerName fuzzy
--   match for legacy rows where CustomerCode is still NULL.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[BN_VisitPlan]', 'U') IS NULL
BEGIN
    RAISERROR('BN_VisitPlan does not exist.', 16, 1);
    RETURN;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[BN_VisitPlan]') AND name = 'CustomerCode'
)
BEGIN
    ALTER TABLE [dbo].[BN_VisitPlan] ADD CustomerCode NVARCHAR(50) NULL;
    PRINT '[OK] Added BN_VisitPlan.CustomerCode';
END
ELSE PRINT '[SKIP] BN_VisitPlan.CustomerCode already exists';
GO

-- Verify
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'BN_VisitPlan'
  AND COLUMN_NAME = 'CustomerCode';
GO
