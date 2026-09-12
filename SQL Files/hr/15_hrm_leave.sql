-- ============================================================================
-- ONE App Lens — Phase 3 — HRM_Leave (applications)
-- File:  SQL Files/hr/15_hrm_leave.sql
-- Date:  2026-05-20
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent. Zero existing data.
--   * SET XACT_ABORT ON.
--
-- WHAT IT CREATES:
--   dbo.HRM_Leave — one row per leave application. Supports half-day via the
--   Session 1 / Session 2 model (matches GreytHR). Stores AppliedTo reviewer
--   + CC list (JSON) so the approval queue knows who to show it to.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Leave]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Leave] (
        LeaveId        INT            IDENTITY(1,1) PRIMARY KEY,
        UserId         INT            NOT NULL,
        UserCode       NVARCHAR(50)   NULL,
        Company        NVARCHAR(10)   NULL,

        LeaveTypeCode  NVARCHAR(10)   NOT NULL,

        FromDate       DATE           NOT NULL,
        FromSession    TINYINT        NOT NULL DEFAULT 1,  -- 1 = full first half / 2 = second half only
        ToDate         DATE           NOT NULL,
        ToSession      TINYINT        NOT NULL DEFAULT 2,  -- 1 = first half only / 2 = full second half
        DaysApplied    DECIMAL(6,2)   NOT NULL DEFAULT 0,

        Reason         NVARCHAR(MAX)  NULL,
        ContactDetails NVARCHAR(200)  NULL,
        AttachmentUrl  NVARCHAR(500)  NULL,

        AppliedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        AppliedToUserId INT           NULL,                -- primary reviewer
        CCList         NVARCHAR(MAX)  NULL,                -- JSON array of UserIds

        Status         NVARCHAR(20)   NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|cancelled|withdrawn

        ApprovedBy     INT            NULL,
        ApprovedAt     DATETIME2(0)   NULL,
        ApprovalNote   NVARCHAR(500)  NULL,

        RejectedBy     INT            NULL,
        RejectedAt     DATETIME2(0)   NULL,
        RejectionReason NVARCHAR(500) NULL,

        CancelledAt    DATETIME2(0)   NULL,

        CreatedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)   NULL,

        INDEX IX_HRM_Leave_User      (UserId, FromDate DESC),
        INDEX IX_HRM_Leave_Status    (Status, AppliedAt DESC),
        INDEX IX_HRM_Leave_AppliedTo (AppliedToUserId, Status, AppliedAt DESC)
    );

    PRINT '[OK] dbo.HRM_Leave created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Leave already exists.';
GO

SELECT TOP 1 *
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'HRM_Leave';
GO
