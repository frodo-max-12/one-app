-- ============================================================================
-- ONE App Lens — Phase 3D — HRM_EmployeeFamily
-- File:  SQL Files/hr/23_hrm_employee_family.sql
-- Date:  2026-05-21
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS — idempotent. SET XACT_ABORT ON.
--
-- WHAT IT CREATES:
--   dbo.HRM_EmployeeFamily — multi-row family member list per employee.
--   Used by the Family Details tab on Employee Profile.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_EmployeeFamily]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_EmployeeFamily] (
        FamilyId       INT            IDENTITY(1,1) PRIMARY KEY,
        UserId         INT            NOT NULL,            -- FK -> User_Login.Id
        Name           NVARCHAR(150)  NOT NULL,
        Relationship   NVARCHAR(50)   NOT NULL,            -- Father/Mother/Spouse/Child/Sibling
        Gender         NVARCHAR(10)   NULL,                -- Male/Female/Other
        DOB            DATE           NULL,
        Occupation     NVARCHAR(100)  NULL,
        Mobile         NVARCHAR(20)   NULL,
        IsDependent    BIT            NOT NULL DEFAULT 0,
        IsEmergency    BIT            NOT NULL DEFAULT 0,  -- one of them can also be emergency contact
        Notes          NVARCHAR(500)  NULL,

        CreatedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)   NULL,

        INDEX IX_HRM_Fam_User (UserId)
    );
    PRINT '[OK] dbo.HRM_EmployeeFamily created.';
END
ELSE PRINT '[SKIP] dbo.HRM_EmployeeFamily already exists.';
GO

SELECT TOP 1 * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'HRM_EmployeeFamily';
GO
