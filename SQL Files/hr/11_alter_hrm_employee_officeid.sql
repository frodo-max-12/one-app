-- ============================================================================
-- ONE App Lens — Phase 2.6 — ALTER HRM_Employee (add OfficeId)
-- File:  SQL Files/hr/11_alter_hrm_employee_officeid.sql
-- Date:  2026-05-20
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * ADDITIVE ONLY — single nullable INT column. Existing rows + routes unaffected.
--   * IF NOT EXISTS guard — idempotent.
--   * SET XACT_ABORT ON — auto-rollback on error.
--
-- WHAT IT DOES:
--   Adds HRM_Employee.OfficeId — links an employee to the geofence
--   representing their home office (Pune HQ / Bangalore / Noida). Used by
--   the Office Presence page and the anomaly detector to flag staff who
--   leave their assigned office during work hours.
--
--   Soft "FK" — we do NOT enforce a constraint because HRM_Geofence is in
--   the same DB and assignments can predate fence creation (legacy data
--   pattern matches existing app convention).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Employee]', 'U') IS NULL
BEGIN
    RAISERROR('HRM_Employee does not exist. Run 05_employee.sql first.', 16, 1);
    RETURN;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'OfficeId'
)
BEGIN
    ALTER TABLE [dbo].[HRM_Employee] ADD OfficeId INT NULL;
    PRINT '[OK] Added HRM_Employee.OfficeId';
END
ELSE PRINT '[SKIP] HRM_Employee.OfficeId already exists';
GO

-- Index — every Office Presence page load queries by OfficeId
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'IX_HRM_Emp_OfficeId'
)
BEGIN
    CREATE INDEX IX_HRM_Emp_OfficeId ON [dbo].[HRM_Employee] (OfficeId) WHERE OfficeId IS NOT NULL;
    PRINT '[OK] Created IX_HRM_Emp_OfficeId';
END
ELSE PRINT '[SKIP] IX_HRM_Emp_OfficeId already exists';
GO

-- Verify
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'HRM_Employee' AND COLUMN_NAME = 'OfficeId';
GO
