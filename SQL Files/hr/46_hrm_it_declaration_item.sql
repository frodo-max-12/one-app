-- ============================================================================
-- ONE App Lens — Phase 5D — HRM_IT_Declaration_Item (lines + proofs)
-- File:  SQL Files/hr/46_hrm_it_declaration_item.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. ADDITIVE.
--
-- WHAT IT CREATES:
--   dbo.HRM_IT_Declaration_Item — one row per declared deduction line.
--   The employee provides: SectionCode (80C, 80D, HRA, HomeLoan, Other),
--   SubCategory (e.g. 'LIC Premium', 'PPF', 'Mediclaim Self'), Amount,
--   and optional ProofPath (uploaded PDF/img under
--   backend/uploads/hr/it-proofs/{DeclarationId}/).
--
--   HR can approve / reject each item independently — ApprovedAmount may
--   be < Amount (partial approval). After all items are decided, HR can
--   approve the parent declaration.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_IT_Declaration_Item]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_IT_Declaration_Item] (
        ItemId          INT             IDENTITY(1,1) PRIMARY KEY,
        DeclarationId   INT             NOT NULL,
        SectionCode     NVARCHAR(20)    NOT NULL,                       -- '80C' | '80D' | 'HRA' | 'HomeLoan' | 'Other'
        SubCategory     NVARCHAR(100)   NULL,                           -- 'LIC' | 'PPF' | 'Mediclaim Self' | ...
        DeclaredAmount  DECIMAL(15,2)   NOT NULL DEFAULT 0,
        ApprovedAmount  DECIMAL(15,2)   NULL,                           -- NULL until HR decides
        Notes           NVARCHAR(MAX)   NULL,

        ProofFileName   NVARCHAR(255)   NULL,                           -- original upload name
        ProofStoredPath NVARCHAR(600)   NULL,                           -- on-disk path
        ProofMimeType   NVARCHAR(150)   NULL,
        ProofFileSize   BIGINT          NULL,

        Status          NVARCHAR(15)    NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
        DecidedBy       INT             NULL,
        DecidedAt       DATETIME2(0)    NULL,
        RejectionReason NVARCHAR(500)   NULL,

        CreatedAt       DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt       DATETIME2(0)    NULL,

        INDEX IX_HRM_ITDI_Dec (DeclarationId, SectionCode)
    );
    PRINT '[OK] dbo.HRM_IT_Declaration_Item created.';
END
ELSE PRINT '[SKIP] dbo.HRM_IT_Declaration_Item already exists.';
GO
