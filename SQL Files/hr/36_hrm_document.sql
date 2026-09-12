-- ============================================================================
-- ONE App Lens — Phase 4E — HRM_Document
-- File:  SQL Files/hr/36_hrm_document.sql
-- Date:  2026-05-22
--
-- SAFETY: BizNAV_App only. NAV DB untouched. IF NOT EXISTS — idempotent.
-- ADDITIVE only — nullable columns, soft-archive (IsActive=0).
-- Zero data loss; auto-rollback on any failure.
--
-- WHAT IT CREATES:
--   dbo.HRM_Document — the central Document Center. One row per file
--   uploaded by HR for company-wide consumption.
--
--   Distinct from HRM_EmployeeDocument (Phase 3D, employee-specific PDFs
--   like ID proofs / certificates uploaded under a single employee).
--
-- Categories (NVARCHAR free-form, but the frontend filter chips use a
-- fixed set):
--   policy        — Code of Conduct, Leave Policy, IT Policy, …
--   form          — Resignation Form, Reimbursement Form, …
--   handbook      — Employee Handbook, Onboarding Guide, …
--   announcement  — Holiday calendar PDF, Company Day-Out invite, …
--   other         — anything else
--
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Document]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Document] (
        DocumentId    INT            IDENTITY(1,1) PRIMARY KEY,
        Category      NVARCHAR(30)   NOT NULL DEFAULT 'other',   -- policy|form|handbook|announcement|other
        Title         NVARCHAR(200)  NOT NULL,
        Description   NVARCHAR(MAX)  NULL,                       -- short summary shown on the card

        FileName      NVARCHAR(255)  NOT NULL,                   -- original upload name (shown as download filename)
        StoredName    NVARCHAR(300)  NOT NULL,                   -- on-disk name (timestamp_safeName)
        StoredPath    NVARCHAR(600)  NOT NULL,                   -- absolute path on the server
        MimeType      NVARCHAR(150)  NULL,
        FileSize      BIGINT         NULL,

        IsPinned      BIT            NOT NULL DEFAULT 0,         -- pin to top of feed (HR-only toggle)
        IsActive      BIT            NOT NULL DEFAULT 1,         -- soft-archive

        UploadedBy    INT            NOT NULL,                   -- FK -> User_Login.Id (HR who uploaded)
        UploadedAt    DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt     DATETIME2(0)   NULL,

        INDEX IX_HRM_Doc_Cat_Active  (Category, IsActive, IsPinned DESC, UploadedAt DESC),
        INDEX IX_HRM_Doc_Active      (IsActive, IsPinned DESC, UploadedAt DESC)
    );
    PRINT '[OK] dbo.HRM_Document created.';
END
ELSE PRINT '[SKIP] dbo.HRM_Document already exists.';
GO

SELECT TOP 0 * FROM [dbo].[HRM_Document];
GO
