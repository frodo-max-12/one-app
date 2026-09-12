-- ============================================================================
-- ONE App Lens — Phase 4D — HRM_Engage_Poll_Vote
-- File:  SQL Files/hr/35_hrm_engage_poll_vote.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE only.
--
-- WHAT IT CREATES:
--   dbo.HRM_Engage_Poll_Vote — one vote per user per poll. OptionIndex points
--   into the JSON Payload.options array of the parent HRM_Engage_Post (where
--   Kind='poll'). Users can change their vote by updating the row.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Engage_Poll_Vote]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Engage_Poll_Vote] (
        VoteId       BIGINT         IDENTITY(1,1) PRIMARY KEY,
        PostId       INT            NOT NULL,
        UserId       INT            NOT NULL,
        OptionIndex  INT            NOT NULL,
        CreatedAt    DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt    DATETIME2(0)   NULL,

        CONSTRAINT UK_HRM_EPV_Post_User UNIQUE (PostId, UserId),
        INDEX IX_HRM_EPV_Post (PostId, OptionIndex)
    );
    PRINT '[OK] dbo.HRM_Engage_Poll_Vote created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Engage_Poll_Vote already exists.';
GO
