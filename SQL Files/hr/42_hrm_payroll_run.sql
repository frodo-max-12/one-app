-- ============================================================================
-- ONE App Lens — Phase 5B — HRM_Payroll_Run
-- File:  SQL Files/hr/42_hrm_payroll_run.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Payroll_Run — one row per (FYYear, MonthNo). Status flows:
--     draft   → run exists, payslips not yet finalised, HR can keep
--               re-processing (recompute replaces all child payslips)
--     locked  → payslips frozen; visible to employees; no more recompute
--     paid    → marked-as-disbursed; cannot be unlocked
--
--   FYMonthCode = 'FY2026-27-M01' (Apr=M01, May=M02, …, Mar=M12) so the
--   key sorts naturally and survives FY rollovers.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Payroll_Run]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Payroll_Run] (
        RunId           INT             IDENTITY(1,1) PRIMARY KEY,
        FYYear          INT             NOT NULL,        -- the start calendar year of the FY (2026 for FY2026-27)
        MonthNo         TINYINT         NOT NULL,        -- 1..12 calendar (Jan=1, Apr=4, …, Dec=12)
        PeriodStart     DATE            NOT NULL,        -- first day of the month
        PeriodEnd       DATE            NOT NULL,        -- last day of the month (EOMONTH)
        DaysInMonth     TINYINT         NOT NULL,        -- denorm for pro-rata
        FYMonthCode     NVARCHAR(15)    NOT NULL,        -- 'FY2026-27-M02' (FY-month within Apr-Mar)
        PayDate         DATE            NULL,            -- typically last working day; set at lock time

        Status          NVARCHAR(15)    NOT NULL DEFAULT 'draft',  -- draft | locked | paid

        TotalGross      DECIMAL(15,2)   NOT NULL DEFAULT 0,        -- sum of all payslip MonthlyGross at last process
        TotalDeductions DECIMAL(15,2)   NOT NULL DEFAULT 0,
        TotalNet        DECIMAL(15,2)   NOT NULL DEFAULT 0,
        EmployeeCount   INT             NOT NULL DEFAULT 0,

        CreatedBy       INT             NOT NULL,
        CreatedAt       DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        ProcessedBy     INT             NULL,
        ProcessedAt     DATETIME2(0)    NULL,
        LockedBy        INT             NULL,
        LockedAt        DATETIME2(0)    NULL,
        PaidBy          INT             NULL,
        PaidAt          DATETIME2(0)    NULL,

        Notes           NVARCHAR(MAX)   NULL,

        CONSTRAINT UK_HRM_PR_Period UNIQUE (FYYear, MonthNo),
        INDEX IX_HRM_PR_Status (Status, PeriodStart DESC)
    );
    PRINT '[OK] dbo.HRM_Payroll_Run created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Payroll_Run already exists.';
GO
