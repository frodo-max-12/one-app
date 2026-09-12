-- ============================================================================
-- ONE App Lens — Phase 3C — Leave Granter
-- File:  SQL Files/hr/21_hrm_leave_grant.sql
-- Date:  2026-05-21
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * ADDITIVE ALTER + new table. Idempotent. Zero data loss.
--   * SET XACT_ABORT ON.
--
-- WHAT IT DOES:
--   1. Adds HRM_LeaveBalance.ManualGrant — HR-issued additions kept SEPARATE
--      from the auto-monthly `Granted` so they survive future ensureMonthlyGrant
--      top-ups. Without this split, granting 5 extra days in May gets eaten
--      when the auto-accrual catches up in August (Granted=11.65 overrides 9.66).
--
--   2. Creates HRM_LeaveGrant — audit row per HR action. Each row is one
--      employee + one type + one delta (can be positive bonus or negative
--      correction). Linked back to HRM_LeaveBalance via UserId+Code+FY.
--
--   3. Available = OpeningBalance + Granted + ManualGrant − Consumed − Pending − Lapsed
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

-- ── 1. Add ManualGrant column ───────────────────────────────────────────────
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('[dbo].[HRM_LeaveBalance]') AND name = 'ManualGrant'
)
BEGIN
    ALTER TABLE [dbo].[HRM_LeaveBalance] ADD ManualGrant DECIMAL(6,2) NOT NULL DEFAULT 0;
    PRINT '[OK] Added HRM_LeaveBalance.ManualGrant';
END
ELSE PRINT '[SKIP] HRM_LeaveBalance.ManualGrant already exists';
GO

-- ── 2. Create HRM_LeaveGrant audit table ────────────────────────────────────
IF OBJECT_ID('[dbo].[HRM_LeaveGrant]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_LeaveGrant] (
        GrantId         INT            IDENTITY(1,1) PRIMARY KEY,
        UserId          INT            NOT NULL,
        UserCode        NVARCHAR(50)   NULL,
        Company         NVARCHAR(10)   NULL,

        LeaveTypeCode   NVARCHAR(10)   NOT NULL,
        FinancialYear   NVARCHAR(10)   NOT NULL,
        Days            DECIMAL(6,2)   NOT NULL,        -- positive = grant, negative = correction/clawback

        Kind            NVARCHAR(30)   NULL,            -- 'bonus' | 'comp-off' | 'joiner-adjust' | 'correction' | 'year-end-reset'
        Reason          NVARCHAR(MAX)  NOT NULL,        -- audit trail — HR must explain

        GrantedBy       INT            NOT NULL,        -- FK -> User_Login.Id
        GrantedAt       DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),

        IsRevoked       BIT            NOT NULL DEFAULT 0,
        RevokedBy       INT            NULL,
        RevokedAt       DATETIME2(0)   NULL,
        RevokeReason    NVARCHAR(500)  NULL,

        CreatedAt       DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt       DATETIME2(0)   NULL,

        INDEX IX_HRM_LG_User_Type_FY (UserId, LeaveTypeCode, FinancialYear),
        INDEX IX_HRM_LG_GrantedBy    (GrantedBy, GrantedAt DESC),
        INDEX IX_HRM_LG_Open         (IsRevoked, GrantedAt DESC) WHERE IsRevoked = 0
    );
    PRINT '[OK] dbo.HRM_LeaveGrant created.';
END
ELSE PRINT '[SKIP] dbo.HRM_LeaveGrant already exists.';
GO

SELECT TOP 1 * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'HRM_LeaveGrant';
GO

SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'HRM_LeaveBalance' AND COLUMN_NAME = 'ManualGrant';
GO
