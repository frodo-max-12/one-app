-- ============================================================================
-- ONE App Lens — Phase 3B — HRM_Regularization
-- File:  SQL Files/hr/20_hrm_regularization.sql
-- Date:  2026-05-20
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent. Zero existing data.
--   * SET XACT_ABORT ON.
--
-- WHAT IT CREATES:
--   dbo.HRM_Regularization — one row per missed-punch correction request.
--   Reuses the same review workflow as HRM_Leave (AppliedTo / Status / Approved
--   by / etc.). On approval, the backend updates the matching HRM_Attendance
--   row and sets IsRegularized=1 + RegularizedBy + RegularizedAt.
--
-- WHEN AN EMPLOYEE USES IT:
--   - Forgot to sign in (drove straight to a customer, opened app mid-day)
--   - Forgot to sign out (left office in a hurry, app stayed signed in overnight)
--   - Both forgotten (rare; whole day missing)
--   - Wrong time recorded due to bad GPS / network at the moment
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Regularization]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Regularization] (
        RegId           INT            IDENTITY(1,1) PRIMARY KEY,
        UserId          INT            NOT NULL,
        UserCode        NVARCHAR(50)   NULL,
        Company         NVARCHAR(10)   NULL,

        AttDate         DATE           NOT NULL,         -- the day being corrected
        Session         TINYINT        NOT NULL DEFAULT 1,

        Kind            NVARCHAR(20)   NOT NULL,         -- 'sign-in' | 'sign-out' | 'both'
        RequestedSignInTime  TIME      NULL,             -- the time the user SAYS they came in
        RequestedSignOutTime TIME      NULL,             -- the time the user SAYS they left

        Reason          NVARCHAR(MAX)  NOT NULL,         -- HR mandates a reason
        AttachmentUrl   NVARCHAR(500)  NULL,             -- screenshot, email proof, etc.

        AppliedAt       DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        AppliedToUserId INT            NULL,             -- primary reviewer
        CCList          NVARCHAR(MAX)  NULL,             -- JSON array of UserIds

        Status          NVARCHAR(20)   NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|cancelled

        ApprovedBy      INT            NULL,
        ApprovedAt      DATETIME2(0)   NULL,
        ApprovalNote    NVARCHAR(500)  NULL,
        AppliedToAttId  BIGINT         NULL,             -- the HRM_Attendance row that got updated on approval

        RejectedBy      INT            NULL,
        RejectedAt      DATETIME2(0)   NULL,
        RejectionReason NVARCHAR(500)  NULL,

        CancelledAt     DATETIME2(0)   NULL,

        CreatedAt       DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt       DATETIME2(0)   NULL,

        INDEX IX_HRM_Reg_User_Date     (UserId, AttDate DESC),
        INDEX IX_HRM_Reg_Status        (Status, AppliedAt DESC),
        INDEX IX_HRM_Reg_AppliedTo     (AppliedToUserId, Status, AppliedAt DESC)
    );

    PRINT '[OK] dbo.HRM_Regularization created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Regularization already exists.';
GO

SELECT TOP 1 * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'HRM_Regularization';
GO
