-- ============================================================================
-- ONE App Lens — Phase 5B — HRM_Payslip
-- File:  SQL Files/hr/43_hrm_payslip.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Payslip — one row per (RunId, UserId). Frozen at process-time:
--   when HR re-runs a draft run, existing rows for that run are deleted +
--   reinserted. Once the parent HRM_Payroll_Run.Status flips to 'locked',
--   no more recomputation is allowed (enforced in code).
--
--   Pro-rata math (computed in the backend, frozen here):
--     PayableDays = DaysInMonth - LopDays
--     EachMonthlyAmount × (PayableDays / DaysInMonth) → ProRatedAmount
--
--   FrozenSnapshot columns (PayslipNo, BankAccount, IFSC, …) make payslip
--   PDF rendering a single-row read; we don't re-join HRM_Employee at
--   render time so post-run bank changes don't retro-corrupt old payslips.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Payslip]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Payslip] (
        PayslipId        INT             IDENTITY(1,1) PRIMARY KEY,
        PayslipNo        NVARCHAR(30)    NULL,                    -- 'PS-FY2026-27-M02-EMP0007'
        RunId            INT             NOT NULL,
        UserId           INT             NOT NULL,
        SalaryId         INT             NOT NULL,                -- the HRM_Employee_Salary used at process time

        -- Frozen employee identity / bank (denorm so PDF doesn't re-join)
        EmpCode          NVARCHAR(50)    NULL,
        EmpName          NVARCHAR(150)   NULL,
        Designation      NVARCHAR(150)   NULL,
        Department       NVARCHAR(50)    NULL,
        DateOfJoining    DATE            NULL,
        PAN              NVARCHAR(20)    NULL,
        UAN              NVARCHAR(20)    NULL,
        PFNo             NVARCHAR(30)    NULL,
        ESINumber        NVARCHAR(30)    NULL,
        BankName         NVARCHAR(80)    NULL,
        BankAccount      NVARCHAR(40)    NULL,
        IFSC             NVARCHAR(20)    NULL,

        -- Pay period attendance summary
        DaysInMonth      TINYINT         NOT NULL,
        LopDays          DECIMAL(6,2)    NOT NULL DEFAULT 0,
        PayableDays      DECIMAL(6,2)    NOT NULL DEFAULT 0,
        PaidLeaveDays    DECIMAL(6,2)    NOT NULL DEFAULT 0,      -- approved non-LOP leaves (info only)

        -- Frozen totals
        MonthlyGross     DECIMAL(15,2)   NOT NULL DEFAULT 0,       -- pro-rated sum of Earning rows
        TotalDeductions  DECIMAL(15,2)   NOT NULL DEFAULT 0,
        NetPay           DECIMAL(15,2)   NOT NULL DEFAULT 0,
        NetPayWords      NVARCHAR(500)   NULL,                     -- generated at process time

        Status           NVARCHAR(15)    NOT NULL DEFAULT 'draft', -- mirrors parent Run.Status

        CreatedAt        DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt        DATETIME2(0)    NULL,

        CONSTRAINT UK_HRM_PS_Run_User UNIQUE (RunId, UserId),
        INDEX IX_HRM_PS_User_Status (UserId, Status, CreatedAt DESC)
    );
    PRINT '[OK] dbo.HRM_Payslip created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Payslip already exists.';
GO
