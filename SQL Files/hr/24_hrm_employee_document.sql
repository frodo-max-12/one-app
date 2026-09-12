-- ============================================================================
-- ONE App Lens — Phase 3D — HRM_EmployeeDocument
-- File:  SQL Files/hr/24_hrm_employee_document.sql
-- Date:  2026-05-21
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. SET XACT_ABORT ON.
--
-- WHAT IT CREATES:
--   dbo.HRM_EmployeeDocument — file metadata per employee.
--   The actual files live on disk under backend/uploads/hr/documents/{userId}/
--   (and will move to Cloudflare R2 in Phase 4 with the selfies).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_EmployeeDocument]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_EmployeeDocument] (
        DocId          INT            IDENTITY(1,1) PRIMARY KEY,
        UserId         INT            NOT NULL,
        DocType        NVARCHAR(50)   NOT NULL,            -- 'aadhaar' | 'pan' | 'passport' | 'resume' | 'offer-letter' | 'experience-letter' | 'other'
        DocName        NVARCHAR(200)  NOT NULL,            -- friendly name shown to user
        FileUrl        NVARCHAR(500)  NOT NULL,            -- /uploads/hr/documents/{userId}/{file}
        FileSize       INT            NULL,
        MimeType       NVARCHAR(100)  NULL,

        UploadedBy     INT            NOT NULL,            -- FK -> User_Login.Id
        UploadedAt     DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),

        IsActive       BIT            NOT NULL DEFAULT 1,
        ArchivedAt     DATETIME2(0)   NULL,
        Notes          NVARCHAR(500)  NULL,

        INDEX IX_HRM_Doc_User_Type (UserId, DocType, IsActive)
    );
    PRINT '[OK] dbo.HRM_EmployeeDocument created.';
END
ELSE PRINT '[SKIP] dbo.HRM_EmployeeDocument already exists.';
GO

SELECT TOP 1 * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'HRM_EmployeeDocument';
GO
