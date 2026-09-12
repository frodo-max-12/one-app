-- ============================================================================
-- ONE App Lens — Phase 5A — HRM_Employee_Salary
-- File:  SQL Files/hr/40_hrm_employee_salary.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Employee_Salary — per-employee salary assignment with
--   effective dating. One row per "version" of an employee's salary.
--   When HR assigns a new salary, the previous row's EffectiveTo is
--   set to the day before the new EffectiveFrom; Status flips to
--   'superseded'. The new row has EffectiveTo = NULL + Status='active'.
--
--   CTC is annual; MonthlyGross is convenience = CTC / 12 frozen at
--   assignment time (so future CTC tweaks don't retro-change the
--   month's pay).
--
--   Component-level breakdown lives in HRM_Employee_Salary_Component
--   (SQL 41) — each assignment "freezes" its components so structure
--   changes don't recompute historical pay.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Employee_Salary]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Employee_Salary] (
        SalaryId         INT             IDENTITY(1,1) PRIMARY KEY,
        UserId           INT             NOT NULL,
        StructureId      INT             NOT NULL,
        CTC              DECIMAL(15,2)   NOT NULL,              -- annual
        MonthlyGross     DECIMAL(15,2)   NOT NULL,              -- CTC / 12 at assignment time
        EffectiveFrom    DATE            NOT NULL,
        EffectiveTo      DATE            NULL,                  -- NULL = current
        Status           NVARCHAR(20)    NOT NULL DEFAULT 'active',  -- active | superseded | cancelled
        Remarks          NVARCHAR(500)   NULL,

        AssignedBy       INT             NOT NULL,
        AssignedAt       DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt        DATETIME2(0)    NULL,

        INDEX IX_HRM_ES_User       (UserId, EffectiveFrom DESC),
        INDEX IX_HRM_ES_UserStatus (UserId, Status, EffectiveFrom DESC)
    );
    PRINT '[OK] dbo.HRM_Employee_Salary created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Employee_Salary already exists.';
GO
