-- ============================================================================
-- ONE App Lens — Phase 6B — HRM_Workflow_Level
-- File:  SQL Files/hr/50_hrm_workflow_level.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Workflow_Level — ordered approval levels for a workflow.
--   When a request enters a workflow, level 1 reviewer sees it first.
--   On their Approve → moves to level 2. On Reject → workflow ends.
--
--   ReviewerKind decides how to resolve "who approves this level":
--     ReportingManager    — pulls from HRM_Employee.ReportingManagerId of the requester
--     DepartmentHead      — finds the user with role matching the department's head (e.g. "Sales Head" for Sales dept)
--     HRHead              — any user with role 'hr head' (or 'hr' if no head)
--     OperationHead       — any user with role 'operation head'
--     Director            — any user with role 'director'
--     NamedUser           — ReviewerValue is the UserId (FK)
--     AnyRole             — ReviewerValue is a role string; any active user with that role
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Workflow_Level]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Workflow_Level] (
        LevelId         INT             IDENTITY(1,1) PRIMARY KEY,
        WorkflowId      INT             NOT NULL,
        LevelNo         TINYINT         NOT NULL,                -- 1, 2, 3, …
        Name            NVARCHAR(100)   NOT NULL,                -- "Reporting Manager", "HR Head", etc.
        ReviewerKind    NVARCHAR(30)    NOT NULL,                -- see above
        ReviewerValue   NVARCHAR(100)   NULL,                    -- UserId for NamedUser, role string for AnyRole
        CanReject       BIT             NOT NULL DEFAULT 1,      -- can this level reject (vs only approve)?
        CanDelegate     BIT             NOT NULL DEFAULT 1,      -- if reviewer is on leave, route to delegate

        CreatedAt       DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),

        CONSTRAINT UK_HRM_WL_WF_Level UNIQUE (WorkflowId, LevelNo),
        INDEX IX_HRM_WL_WF (WorkflowId, LevelNo)
    );
    PRINT '[OK] dbo.HRM_Workflow_Level created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Workflow_Level already exists.';
GO
