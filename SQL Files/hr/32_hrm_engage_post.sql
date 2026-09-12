-- ============================================================================
-- ONE App Lens — Phase 4D — HRM_Engage_Post
-- File:  SQL Files/hr/32_hrm_engage_post.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE only.
--
-- WHAT IT CREATES:
--   dbo.HRM_Engage_Post — unified feed item. Kind decides which card the
--   frontend draws:
--     'post'     → general announcement
--     'kudos'    → recognition for TargetUserId
--     'poll'     → question + options (in Payload JSON)
--     'birthday' → wish TargetUserId on their birthday
--     'joiner'   → welcome TargetUserId
--   Payload is free-form JSON used for kind-specific fields (e.g. poll
--   options, kudos badge code).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Engage_Post]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Engage_Post] (
        PostId         INT            IDENTITY(1,1) PRIMARY KEY,
        Kind           NVARCHAR(20)   NOT NULL,          -- post | kudos | poll | birthday | joiner
        AuthorUserId   INT            NOT NULL,
        TargetUserId   INT            NULL,              -- person being recognised / wished (kudos/birthday/joiner)
        Title          NVARCHAR(200)  NULL,
        Body           NVARCHAR(MAX)  NULL,
        Payload        NVARCHAR(MAX)  NULL,              -- JSON: { options: [...], badge: 'team-player', ... }
        PinnedUntil    DATETIME2(0)   NULL,              -- pinned to top of feed
        IsActive       BIT            NOT NULL DEFAULT 1,

        CreatedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)   NULL,

        INDEX IX_HRM_EP_Active_Created (IsActive, CreatedAt DESC),
        INDEX IX_HRM_EP_Kind           (Kind, IsActive, CreatedAt DESC),
        INDEX IX_HRM_EP_Author         (AuthorUserId, CreatedAt DESC),
        INDEX IX_HRM_EP_Target         (TargetUserId, CreatedAt DESC)
    );
    PRINT '[OK] dbo.HRM_Engage_Post created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Engage_Post already exists.';
GO

SELECT TOP 0 * FROM [dbo].[HRM_Engage_Post];
GO
