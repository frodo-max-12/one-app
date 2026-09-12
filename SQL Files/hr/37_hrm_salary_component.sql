-- ============================================================================
-- ONE App Lens — Phase 5A — HRM_Salary_Component (+ default seeds)
-- File:  SQL Files/hr/37_hrm_salary_component.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. NAV DB untouched. IF NOT EXISTS — idempotent.
-- ADDITIVE only. Zero data loss; auto-rollback on any failure.
--
-- WHAT IT CREATES:
--   dbo.HRM_Salary_Component — master list of payroll components.
--   Each row defines ONE component (Basic, HRA, PF Employee, etc.) with
--   its kind (Earning/Deduction/Reimbursement), tax/statutory flags, and
--   default formula. Structures reference these components via the
--   junction table HRM_Salary_Structure_Component.
--
--   Formula types:
--     Fixed       — flat amount (e.g. Conveyance ₹1600/mo)
--     PctOfBasic  — % of Basic (e.g. HRA 40% of Basic)
--     PctOfCTC    — % of CTC   (e.g. Basic 50% of CTC)
--     PctOfGross  — % of monthly gross (e.g. ESI 0.75%)
--     Slab        — slab-based (e.g. PT Maharashtra)
--     Balancer    — CTC minus sum of all other Earning components (residual goes to Special Allowance)
--     Manual      — entered per employee (e.g. TDS withheld)
--
--   DefaultValue meaning depends on FormulaType:
--     Fixed       → amount in rupees per month
--     Pct*        → percentage as decimal (12 = 12 %)
--     Slab / Balancer / Manual → ignored
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Salary_Component]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Salary_Component] (
        ComponentId       INT             IDENTITY(1,1) PRIMARY KEY,
        Code              NVARCHAR(20)    NOT NULL UNIQUE,
        Name              NVARCHAR(100)   NOT NULL,
        Kind              NVARCHAR(15)    NOT NULL,                       -- Earning | Deduction | Reimbursement
        Taxability        NVARCHAR(20)    NOT NULL DEFAULT 'Taxable',     -- Taxable | NonTaxable | PartialExempt
        IsStatutoryPF     BIT             NOT NULL DEFAULT 0,             -- counted in PF wages
        IsStatutoryESI    BIT             NOT NULL DEFAULT 0,             -- counted in ESI wages
        IsStatutoryPT     BIT             NOT NULL DEFAULT 0,             -- counted in PT-eligible gross
        FormulaType       NVARCHAR(20)    NOT NULL DEFAULT 'Fixed',       -- Fixed|PctOfBasic|PctOfCTC|PctOfGross|Slab|Balancer|Manual
        DefaultValue      DECIMAL(15,2)   NULL,                           -- fixed amount or % depending on FormulaType
        DisplayOrder      INT             NOT NULL DEFAULT 50,
        IsActive          BIT             NOT NULL DEFAULT 1,

        CreatedAt         DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt         DATETIME2(0)    NULL,

        INDEX IX_HRM_SC_Active (IsActive, Kind, DisplayOrder)
    );
    PRINT '[OK] dbo.HRM_Salary_Component created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Salary_Component already exists.';
GO

-- ────────────────────────────────────────────────────────────────────────────
-- Seed the standard COMPANYA salary components (idempotent via MERGE)
-- ────────────────────────────────────────────────────────────────────────────
MERGE INTO [dbo].[HRM_Salary_Component] AS T
USING (VALUES
    -- Code,    Name,                       Kind,           Taxability,       PF, ESI, PT, FormulaType,   Default, Order
    ('BASIC',   N'Basic',                   N'Earning',     N'Taxable',        1,  1,  1, N'PctOfCTC',     50.00, 10),
    ('HRA',     N'House Rent Allowance',    N'Earning',     N'PartialExempt',  0,  1,  1, N'PctOfBasic',   40.00, 20),
    ('CONV',    N'Conveyance Allowance',    N'Earning',     N'NonTaxable',     0,  1,  1, N'Fixed',      1600.00, 30),
    ('MED',     N'Medical Allowance',       N'Earning',     N'NonTaxable',     0,  1,  1, N'Fixed',      1250.00, 40),
    ('SPL',     N'Special Allowance',       N'Earning',     N'Taxable',        0,  1,  1, N'Balancer',     NULL,  50),
    ('PF_EE',   N'PF — Employee',           N'Deduction',   N'NonTaxable',     0,  0,  0, N'PctOfBasic',   12.00, 100),
    ('ESI_EE',  N'ESI — Employee',          N'Deduction',   N'NonTaxable',     0,  0,  0, N'PctOfGross',    0.75, 110),
    ('PT_MH',   N'Professional Tax (MH)',   N'Deduction',   N'NonTaxable',     0,  0,  0, N'Slab',         NULL,  120),
    ('TDS',     N'TDS / Income Tax',        N'Deduction',   N'NonTaxable',     0,  0,  0, N'Manual',       NULL,  130)
) AS S (Code, Name, Kind, Taxability, IsStatutoryPF, IsStatutoryESI, IsStatutoryPT, FormulaType, DefaultValue, DisplayOrder)
ON T.Code = S.Code
WHEN NOT MATCHED THEN
    INSERT (Code, Name, Kind, Taxability, IsStatutoryPF, IsStatutoryESI, IsStatutoryPT, FormulaType, DefaultValue, DisplayOrder)
    VALUES (S.Code, S.Name, S.Kind, S.Taxability, S.IsStatutoryPF, S.IsStatutoryESI, S.IsStatutoryPT, S.FormulaType, S.DefaultValue, S.DisplayOrder);
GO

PRINT '[OK] Standard COMPANYA components ensured.';
SELECT Code, Name, Kind, Taxability, FormulaType, DefaultValue, IsActive
FROM [dbo].[HRM_Salary_Component] ORDER BY DisplayOrder;
GO
