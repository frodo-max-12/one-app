-- ============================================================================
-- ONE App Lens — Phase 4D — HRM_Engage_Comment
-- File:  SQL Files/hr/34_hrm_engage_comment.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE only.
--
-- WHAT IT CREATES:
--   dbo.HRM_Engage_Comment — comments under any engage post. Author can soft-
--   delete their own (IsDeleted=1). HR can also delete.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Engage_Comment]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Engage_Comment] (
        CommentId  BIGINT         IDENTITY(1,1) PRIMARY KEY,
        PostId     INT            NOT NULL,
        UserId     INT            NOT NULL,
        Body       NVARCHAR(MAX)  NOT NULL,
        IsDeleted  BIT            NOT NULL DEFAULT 0,
        CreatedAt  DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),

        INDEX IX_HRM_EC_Post (PostId, IsDeleted, CreatedAt)
    );
    PRINT '[OK] dbo.HRM_Engage_Comment created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Engage_Comment already exists.';
GO
