-- ============================================================================
-- ONE App Lens — Phase 4C — HRM_Helpdesk_Comment
-- File:  SQL Files/hr/30_hrm_helpdesk_comment.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE only.
--
-- WHAT IT CREATES:
--   dbo.HRM_Helpdesk_Comment — conversation thread per ticket. Each row is
--   one message from either the raiser or an HR assignee. IsInternal=1 hides
--   the message from the raiser (HR-side notes / handoff hints).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Helpdesk_Comment]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Helpdesk_Comment] (
        CommentId   BIGINT         IDENTITY(1,1) PRIMARY KEY,
        TicketId    INT            NOT NULL,
        UserId      INT            NOT NULL,             -- author (User_Login.Id)
        Body        NVARCHAR(MAX)  NOT NULL,
        IsInternal  BIT            NOT NULL DEFAULT 0,   -- 1 = HR-only note, hide from raiser
        CreatedAt   DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),

        INDEX IX_HRM_HDC_Ticket (TicketId, CreatedAt)
    );
    PRINT '[OK] dbo.HRM_Helpdesk_Comment created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Helpdesk_Comment already exists.';
GO

SELECT TOP 0 * FROM [dbo].[HRM_Helpdesk_Comment];
GO
