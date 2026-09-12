-- ============================================================================
-- ONE App Lens — Phase 5E — HRM_Form16
-- File:  SQL Files/hr/47_hrm_form16.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Form16 — one row per (UserId, FYYear). Form 16 has two parts:
--     Part A — Generated externally by TRACES (NSDL); HR uploads the PDF
--              + stores TDS deducted + 24Q acknowledgement.
--     Part B — Generated locally from the employee's payslip data via
--              services/form16Pdf.js: gross salary, deductions u/s 16
--              (standard deduction, PT), Chapter VI-A deductions (80C/80D/…
--              from the approved HRM_IT_Declaration_Item rows), tax
--              computation.
--
--   Either part can exist independently; both are downloadable.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Form16]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Form16] (
        Form16Id          INT             IDENTITY(1,1) PRIMARY KEY,
        UserId            INT             NOT NULL,
        FYYear            INT             NOT NULL,                   -- 2026 for FY2026-27

        -- Part A (TRACES uploaded)
        PartAFileName     NVARCHAR(255)   NULL,
        PartAStoredPath   NVARCHAR(600)   NULL,
        PartAUploadedAt   DATETIME2(0)    NULL,
        PartAUploadedBy   INT             NULL,
        TANNumber         NVARCHAR(20)    NULL,                       -- employer's TAN shown on Part A
        Form24QAckNo      NVARCHAR(30)    NULL,                       -- TDS Q4 ack number

        -- Part B (generated locally) — store the aggregated numbers used in PDF
        PartBGeneratedAt  DATETIME2(0)    NULL,
        PartBGeneratedBy  INT             NULL,
        GrossSalary       DECIMAL(15,2)   NULL,
        StandardDeduction DECIMAL(15,2)   NULL,                       -- ₹50,000 by default
        PTDeducted        DECIMAL(15,2)   NULL,
        ChapterVIA        DECIMAL(15,2)   NULL,                       -- sum of approved 80C/80D/…
        TaxableIncome     DECIMAL(15,2)   NULL,
        TaxOnIncome       DECIMAL(15,2)   NULL,
        TDSDeposited      DECIMAL(15,2)   NULL,
        Regime            NVARCHAR(10)    NULL,                       -- Old | New (from declaration)

        CreatedAt         DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt         DATETIME2(0)    NULL,

        CONSTRAINT UK_HRM_F16_User_FY UNIQUE (UserId, FYYear),
        INDEX IX_HRM_F16_FY (FYYear, UserId)
    );
    PRINT '[OK] dbo.HRM_Form16 created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Form16 already exists.';
GO
