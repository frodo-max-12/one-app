-- ============================================================================
-- ONE App Lens — Phase 6B — HRM_Workflow_Definition
-- File:  SQL Files/hr/49_hrm_workflow_definition.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Workflow_Definition — top-level config for a multi-level
--   approval flow. Each row is one named workflow that applies to a
--   specific EntityKind ('Leave' | 'Regularization' | 'ITDeclaration').
--
--   Conditions (JSON) decide if a workflow APPLIES to a given request:
--     { "daysGT": 5 }                — Leave only, days applied > 5
--     { "departmentIn": ["Sales"] }  — applies only to Sales dept
--     { "amountGT": 50000 }          — ITDecl only, declared > 50k
--   Multiple workflow definitions per EntityKind are evaluated in
--   Priority order; the first matching definition is used. Missing
--   conditions = always match.
--
--   If no workflow matches a request, the legacy single-level approval
--   in HRM_Leave.AppliedToUserId / HRM_Regularization.AppliedToUserId /
--   HRM_IT_Declaration HR-approves stays in effect (backward compat).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Workflow_Definition]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Workflow_Definition] (
        WorkflowId    INT             IDENTITY(1,1) PRIMARY KEY,
        Code          NVARCHAR(40)    NOT NULL UNIQUE,        -- 'LEAVE_LONG', 'IT_HIGH_VALUE'
        Name          NVARCHAR(150)   NOT NULL,
        Description   NVARCHAR(500)   NULL,
        EntityKind    NVARCHAR(30)    NOT NULL,                -- Leave | Regularization | ITDeclaration
        Conditions    NVARCHAR(MAX)   NULL,                    -- JSON; NULL = always matches
        Priority      INT             NOT NULL DEFAULT 100,    -- lower number wins on tie
        IsActive      BIT             NOT NULL DEFAULT 1,

        CreatedBy     INT             NOT NULL,
        CreatedAt     DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt     DATETIME2(0)    NULL,

        INDEX IX_HRM_WD_Entity (EntityKind, IsActive, Priority)
    );
    PRINT '[OK] dbo.HRM_Workflow_Definition created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Workflow_Definition already exists.';
GO
