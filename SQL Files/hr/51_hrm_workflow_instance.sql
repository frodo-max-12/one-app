-- ============================================================================
-- ONE App Lens — Phase 6B — HRM_Workflow_Instance
-- File:  SQL Files/hr/51_hrm_workflow_instance.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Workflow_Instance — one row per (EntityKind + EntityId).
--   Tracks where the request is in the workflow (CurrentLevel) plus
--   the full audit trail of decisions (History JSON array).
--
--   History format (appended on each decision):
--     [{"level":1,"decidedBy":7,"decidedByName":"Manager A","decision":"approved","at":"2026-05-22T10:00:00Z","note":"OK"}, …]
--
--   Status:
--     in-progress → currently waiting on CurrentLevel reviewer
--     approved    → all levels approved
--     rejected    → some level rejected (workflow ends; entity status set to rejected too)
--     cancelled   → requester withdrew (entity-driven, not workflow)
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Workflow_Instance]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Workflow_Instance] (
        InstanceId      INT             IDENTITY(1,1) PRIMARY KEY,
        EntityKind      NVARCHAR(30)    NOT NULL,                -- Leave | Regularization | ITDeclaration
        EntityId        INT             NOT NULL,                -- FK -> HRM_Leave.LeaveId / HRM_Regularization.RegId / HRM_IT_Declaration.DeclarationId
        WorkflowId      INT             NOT NULL,
        TotalLevels     TINYINT         NOT NULL,
        CurrentLevel    TINYINT         NOT NULL DEFAULT 1,
        CurrentReviewerUserId INT       NULL,                    -- snapshot of who's expected to act (resolved at level start)
        Status          NVARCHAR(20)    NOT NULL DEFAULT 'in-progress',  -- in-progress | approved | rejected | cancelled
        History         NVARCHAR(MAX)   NULL,                    -- JSON array

        StartedAt       DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        FinishedAt      DATETIME2(0)    NULL,
        UpdatedAt       DATETIME2(0)    NULL,

        CONSTRAINT UK_HRM_WI_Entity UNIQUE (EntityKind, EntityId),
        INDEX IX_HRM_WI_Status   (Status, CurrentLevel),
        INDEX IX_HRM_WI_Reviewer (CurrentReviewerUserId, Status)
    );
    PRINT '[OK] dbo.HRM_Workflow_Instance created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Workflow_Instance already exists.';
GO
