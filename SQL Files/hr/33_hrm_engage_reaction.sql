-- ============================================================================
-- ONE App Lens — Phase 4D — HRM_Engage_Reaction
-- File:  SQL Files/hr/33_hrm_engage_reaction.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE only.
--
-- WHAT IT CREATES:
--   dbo.HRM_Engage_Reaction — one row per (PostId, UserId, Kind). A user can
--   add multiple kinds (like + celebrate) but only one of each. Toggle by
--   delete+insert.
--
-- Reaction kinds: like | celebrate | support | thanks | clap | rocket
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Engage_Reaction]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Engage_Reaction] (
        ReactionId  BIGINT         IDENTITY(1,1) PRIMARY KEY,
        PostId      INT            NOT NULL,
        UserId      INT            NOT NULL,
        Kind        NVARCHAR(20)   NOT NULL,            -- like|celebrate|support|thanks|clap|rocket
        CreatedAt   DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),

        CONSTRAINT UK_HRM_ER_Post_User_Kind UNIQUE (PostId, UserId, Kind),
        INDEX IX_HRM_ER_Post (PostId, Kind)
    );
    PRINT '[OK] dbo.HRM_Engage_Reaction created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Engage_Reaction already exists.';
GO
