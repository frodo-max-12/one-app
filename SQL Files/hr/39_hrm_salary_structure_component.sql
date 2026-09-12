-- ============================================================================
-- ONE App Lens — Phase 5A — HRM_Salary_Structure_Component (junction + seed)
-- File:  SQL Files/hr/39_hrm_salary_structure_component.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_Salary_Structure_Component — junction between a structure
--   template and the components it pays out. OverrideValue lets a specific
--   structure override the component's DefaultValue (e.g. a structure where
--   HRA = 50% instead of the master default 40%).
--
-- ALSO: seeds the 9 standard components into the 'STD_COMPANYA' structure.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Salary_Structure_Component]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Salary_Structure_Component] (
        StructureCompId   INT             IDENTITY(1,1) PRIMARY KEY,
        StructureId       INT             NOT NULL,
        ComponentId       INT             NOT NULL,
        OverrideValue     DECIMAL(15,2)   NULL,             -- NULL = use the component's master DefaultValue
        DisplayOrder      INT             NOT NULL DEFAULT 50,

        CreatedAt         DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),

        CONSTRAINT UK_HRM_SSC_Struct_Comp UNIQUE (StructureId, ComponentId),
        INDEX IX_HRM_SSC_Struct (StructureId, DisplayOrder)
    );
    PRINT '[OK] dbo.HRM_Salary_Structure_Component created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Salary_Structure_Component already exists.';
GO

-- ────────────────────────────────────────────────────────────────────────────
-- Seed: link all 9 standard components into the STD_COMPANYA structure
-- ────────────────────────────────────────────────────────────────────────────
DECLARE @sid INT = (SELECT StructureId FROM HRM_Salary_Structure WHERE Code = 'STD_COMPANYA');

IF @sid IS NOT NULL
BEGIN
    MERGE INTO [dbo].[HRM_Salary_Structure_Component] AS T
    USING (
        SELECT SC.ComponentId, SC.DisplayOrder
        FROM HRM_Salary_Component SC
        WHERE SC.IsActive = 1
          AND SC.Code IN ('BASIC','HRA','CONV','MED','SPL','PF_EE','ESI_EE','PT_MH','TDS')
    ) AS S
    ON T.StructureId = @sid AND T.ComponentId = S.ComponentId
    WHEN NOT MATCHED THEN
        INSERT (StructureId, ComponentId, DisplayOrder)
        VALUES (@sid, S.ComponentId, S.DisplayOrder);
    PRINT '[OK] STD_COMPANYA structure linked to standard components.';
END
ELSE PRINT '[SKIP] STD_COMPANYA structure not found; run SQL 38 first.';
GO
