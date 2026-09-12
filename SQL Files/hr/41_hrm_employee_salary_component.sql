-- ============================================================================
-- ONE App Lens — Phase 5A — HRM_Employee_Salary_Component
-- File:  SQL Files/hr/41_hrm_employee_salary_component.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Employee_Salary_Component — frozen per-employee component
--   breakdown for one HRM_Employee_Salary row. When HR assigns a new
--   salary the backend resolves each structure component's formula
--   against the CTC and inserts one row per component here. Future
--   structure or component-master changes do NOT update these rows —
--   they're a permanent snapshot of what was paid.
--
--   Denormalised columns (ComponentCode/Name/Kind) make payslip
--   rendering a single-table read without joining the component master.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Employee_Salary_Component]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Employee_Salary_Component] (
        EmpSalCompId    INT             IDENTITY(1,1) PRIMARY KEY,
        SalaryId        INT             NOT NULL,
        ComponentId     INT             NOT NULL,
        ComponentCode   NVARCHAR(20)    NOT NULL,    -- denorm for fast read
        ComponentName   NVARCHAR(100)   NOT NULL,    -- denorm
        Kind            NVARCHAR(15)    NOT NULL,    -- denorm (Earning|Deduction|Reimbursement)
        FormulaSummary  NVARCHAR(100)   NULL,        -- e.g. "PctOfBasic 40 %" or "Fixed ₹1600" — audit trail
        MonthlyAmount   DECIMAL(15,2)   NOT NULL DEFAULT 0,
        AnnualAmount    DECIMAL(15,2)   NOT NULL DEFAULT 0,
        DisplayOrder    INT             NOT NULL DEFAULT 50,

        CONSTRAINT UK_HRM_ESC_Sal_Comp UNIQUE (SalaryId, ComponentId),
        INDEX IX_HRM_ESC_Sal (SalaryId, DisplayOrder)
    );
    PRINT '[OK] dbo.HRM_Employee_Salary_Component created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Employee_Salary_Component already exists.';
GO
