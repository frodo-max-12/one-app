-- ============================================================================
-- ONE App Lens — Phase 3D-D2 — HRM_PreviousEmployment
-- File:  SQL Files/hr/27_hrm_previous_employment.sql
-- Date:  2026-05-21
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent.
--
-- WHAT IT CREATES:
--   dbo.HRM_PreviousEmployment — companies the employee worked at before
--   joining COMPANYA / CompanyB. One row per prior job.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_PreviousEmployment]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_PreviousEmployment] (
        PrevId          INT            IDENTITY(1,1) PRIMARY KEY,
        UserId          INT            NOT NULL,
        CompanyName     NVARCHAR(200)  NOT NULL,
        Designation     NVARCHAR(150)  NULL,
        FromDate        DATE           NULL,
        ToDate          DATE           NULL,
        LastSalary      DECIMAL(12,2)  NULL,
        ReasonForLeaving NVARCHAR(500) NULL,
        Notes           NVARCHAR(MAX)  NULL,

        CreatedAt       DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt       DATETIME2(0)   NULL,

        INDEX IX_HRM_Prev_User (UserId, FromDate DESC)
    );
    PRINT '[OK] dbo.HRM_PreviousEmployment created.';
END
ELSE PRINT '[SKIP] dbo.HRM_PreviousEmployment already exists.';
GO
