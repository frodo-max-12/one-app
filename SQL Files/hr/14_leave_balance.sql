-- ============================================================================
-- ONE App Lens — Phase 3 — HRM_LeaveBalance
-- File:  SQL Files/hr/14_leave_balance.sql
-- Date:  2026-05-20
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent. Zero existing data.
--   * SET XACT_ABORT ON.
--
-- WHAT IT CREATES:
--   dbo.HRM_LeaveBalance — one row per (User, LeaveTypeCode, FinancialYear).
--   The detector / approver updates Consumed on each approved leave; the
--   Leave Granter (Phase 3 slice B) writes Opening/Granted at year-start.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_LeaveBalance]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_LeaveBalance] (
        BalanceId       INT            IDENTITY(1,1) PRIMARY KEY,
        UserId          INT            NOT NULL,
        LeaveTypeCode   NVARCHAR(10)   NOT NULL,
        FinancialYear   NVARCHAR(10)   NOT NULL,        -- 'FY2026-27' = Apr 2026 - Mar 2027

        OpeningBalance  DECIMAL(6,2)   NOT NULL DEFAULT 0,
        Granted         DECIMAL(6,2)   NOT NULL DEFAULT 0,   -- granted this FY
        Consumed        DECIMAL(6,2)   NOT NULL DEFAULT 0,   -- used (approved + completed)
        Pending         DECIMAL(6,2)   NOT NULL DEFAULT 0,   -- in pending applications (provisional)
        Lapsed          DECIMAL(6,2)   NOT NULL DEFAULT 0,   -- expired unused at year-end carry

        LastGrantedAt   DATETIME2(0)   NULL,
        Notes           NVARCHAR(500)  NULL,

        CreatedAt       DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt       DATETIME2(0)   NULL,

        CONSTRAINT UK_HRM_LB_User_Type_FY UNIQUE (UserId, LeaveTypeCode, FinancialYear),
        INDEX IX_HRM_LB_User_FY (UserId, FinancialYear)
    );

    PRINT '[OK] dbo.HRM_LeaveBalance created.';
END
ELSE PRINT '[SKIP] dbo.HRM_LeaveBalance already exists.';
GO

SELECT TOP 1 *
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'HRM_LeaveBalance';
GO
