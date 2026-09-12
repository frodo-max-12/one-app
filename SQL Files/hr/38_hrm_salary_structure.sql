-- ============================================================================
-- ONE App Lens — Phase 5A — HRM_Salary_Structure (+ default seed)
-- File:  SQL Files/hr/38_hrm_salary_structure.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Salary_Structure — named templates that bundle a set of
--   components into a payable salary recipe (e.g. "Standard COMPANYA").
--   The actual component list per structure lives in the junction table
--   HRM_Salary_Structure_Component (SQL 39).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Salary_Structure]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Salary_Structure] (
        StructureId  INT             IDENTITY(1,1) PRIMARY KEY,
        Code         NVARCHAR(30)    NOT NULL UNIQUE,
        Name         NVARCHAR(150)   NOT NULL,
        Description  NVARCHAR(500)   NULL,
        IsActive     BIT             NOT NULL DEFAULT 1,

        CreatedAt    DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt    DATETIME2(0)    NULL,

        INDEX IX_HRM_SS_Active (IsActive)
    );
    PRINT '[OK] dbo.HRM_Salary_Structure created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Salary_Structure already exists.';
GO

-- Seed one default structure (idempotent)
IF NOT EXISTS (SELECT 1 FROM [dbo].[HRM_Salary_Structure] WHERE Code = 'STD_COMPANYA')
BEGIN
    INSERT INTO [dbo].[HRM_Salary_Structure] (Code, Name, Description)
    VALUES ('STD_COMPANYA', N'Standard COMPANYA',
            N'Default salary structure: Basic 50% of CTC, HRA 40% of Basic, Conv ₹1600, Med ₹1250, SPL balancer, PF/ESI/PT statutory deductions.');
    PRINT '[OK] Standard COMPANYA structure seeded.';
END
GO
