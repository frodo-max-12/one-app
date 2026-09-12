-- ============================================================================
-- ONE App Lens — Phase 3D-D2 — HRM_PositionHistory
-- File:  SQL Files/hr/26_hrm_position_history.sql
-- Date:  2026-05-21
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent.
--
-- WHAT IT CREATES:
--   dbo.HRM_PositionHistory — designation / department / location changes over
--   time. Each promotion / transfer / move adds a new row; the CURRENT row
--   has EffectiveTo = NULL.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_PositionHistory]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_PositionHistory] (
        HistoryId       INT            IDENTITY(1,1) PRIMARY KEY,
        UserId          INT            NOT NULL,
        Designation     NVARCHAR(150)  NOT NULL,
        Department      NVARCHAR(50)   NULL,
        Location        NVARCHAR(100)  NULL,
        ReportingManagerId INT         NULL,
        EmployeeType    NVARCHAR(20)   NULL,            -- Permanent / Probation / Contract / Intern
        EffectiveFrom   DATE           NOT NULL,
        EffectiveTo     DATE           NULL,            -- NULL = current
        ReasonForChange NVARCHAR(50)   NULL,            -- 'promotion' | 'transfer' | 'role-change' | 'initial' | 'reorg'
        Notes           NVARCHAR(500)  NULL,

        CreatedBy       INT            NULL,
        CreatedAt       DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),

        INDEX IX_HRM_PH_User (UserId, EffectiveFrom DESC),
        INDEX IX_HRM_PH_Current (UserId) WHERE EffectiveTo IS NULL
    );
    PRINT '[OK] dbo.HRM_PositionHistory created.';
END
ELSE PRINT '[SKIP] dbo.HRM_PositionHistory already exists.';
GO
