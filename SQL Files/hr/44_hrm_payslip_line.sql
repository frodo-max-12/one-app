-- ============================================================================
-- ONE App Lens — Phase 5B — HRM_Payslip_Line
-- File:  SQL Files/hr/44_hrm_payslip_line.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Payslip_Line — per-component breakdown of one payslip. One row
--   per (PayslipId, ComponentCode). Stores both the full-month amount
--   (from HRM_Employee_Salary_Component) and the pro-rated paid amount,
--   so the payslip PDF can show "Earned vs Salary" if needed.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Payslip_Line]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Payslip_Line] (
        PayslipLineId   INT             IDENTITY(1,1) PRIMARY KEY,
        PayslipId       INT             NOT NULL,
        ComponentCode   NVARCHAR(20)    NOT NULL,
        ComponentName   NVARCHAR(100)   NOT NULL,
        Kind            NVARCHAR(15)    NOT NULL,                -- Earning | Deduction | Reimbursement
        FullMonthlyAmt  DECIMAL(15,2)   NOT NULL DEFAULT 0,      -- the unprorated MonthlyAmount from HRM_Employee_Salary_Component
        EarnedAmount    DECIMAL(15,2)   NOT NULL DEFAULT 0,      -- pro-rated payable for this payslip
        FormulaSummary  NVARCHAR(100)   NULL,
        DisplayOrder    INT             NOT NULL DEFAULT 50,

        CONSTRAINT UK_HRM_PSL_Slip_Code UNIQUE (PayslipId, ComponentCode),
        INDEX IX_HRM_PSL_Slip (PayslipId, DisplayOrder)
    );
    PRINT '[OK] dbo.HRM_Payslip_Line created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Payslip_Line already exists.';
GO
