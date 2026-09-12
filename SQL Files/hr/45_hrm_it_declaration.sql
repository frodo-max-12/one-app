-- ============================================================================
-- ONE App Lens — Phase 5D — HRM_IT_Declaration (header)
-- File:  SQL Files/hr/45_hrm_it_declaration.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_IT_Declaration — one row per (UserId, FYYear). Employee picks
--   regime, declares 80C / 80D / HRA / Home Loan / Other-Income, then
--   submits → HR reviews each item via HRM_IT_Declaration_Item and
--   approves / rejects. Status flow:
--     draft     → employee editing
--     submitted → HR sees in review queue
--     approved  → all items decided; locked
--     rejected  → HR sent back; employee can resubmit
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_IT_Declaration]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_IT_Declaration] (
        DeclarationId   INT             IDENTITY(1,1) PRIMARY KEY,
        UserId          INT             NOT NULL,
        FYYear          INT             NOT NULL,                       -- 2026 for FY2026-27
        Regime          NVARCHAR(10)    NOT NULL DEFAULT 'Old',         -- 'Old' | 'New'
        Status          NVARCHAR(15)    NOT NULL DEFAULT 'draft',       -- draft | submitted | approved | rejected
        TotalDeclared   DECIMAL(15,2)   NOT NULL DEFAULT 0,             -- computed at submit time

        SubmittedAt     DATETIME2(0)    NULL,
        DecidedBy       INT             NULL,
        DecidedAt       DATETIME2(0)    NULL,
        RejectionReason NVARCHAR(500)   NULL,

        CreatedAt       DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt       DATETIME2(0)    NULL,

        CONSTRAINT UK_HRM_ITD_User_FY UNIQUE (UserId, FYYear),
        INDEX IX_HRM_ITD_Status (Status, FYYear, UserId)
    );
    PRINT '[OK] dbo.HRM_IT_Declaration created.';
END
ELSE PRINT '[SKIP] dbo.HRM_IT_Declaration already exists.';
GO
