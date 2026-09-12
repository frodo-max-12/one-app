-- ============================================================================
-- ONE App Lens — Phase 3D-D2 — ALTER HRM_Employee (Passport + Resignation)
-- File:  SQL Files/hr/25_alter_hrm_employee_passport_resign.sql
-- Date:  2026-05-21
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * ADDITIVE ONLY — nullable columns. Existing rows unaffected.
--   * IF NOT EXISTS guards — idempotent.
--   * SET XACT_ABORT ON.
--
-- WHAT IT ADDS:
--   Passport: PassportNo, PassportIssueDate, PassportExpiryDate, PassportPlaceOfIssue, PassportCountry
--   Visa basics: VisaNo, VisaType, VisaCountry, VisaExpiryDate
--   Resignation extras: ResignationReason, NoticeServed (BIT), NoticePeriodDays,
--                        ExitInterviewDate, ExitInterviewNotes
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'PassportNo')
    ALTER TABLE [dbo].[HRM_Employee] ADD PassportNo NVARCHAR(20) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'PassportIssueDate')
    ALTER TABLE [dbo].[HRM_Employee] ADD PassportIssueDate DATE NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'PassportExpiryDate')
    ALTER TABLE [dbo].[HRM_Employee] ADD PassportExpiryDate DATE NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'PassportPlaceOfIssue')
    ALTER TABLE [dbo].[HRM_Employee] ADD PassportPlaceOfIssue NVARCHAR(100) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'PassportCountry')
    ALTER TABLE [dbo].[HRM_Employee] ADD PassportCountry NVARCHAR(50) NULL DEFAULT 'India';
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'VisaNo')
    ALTER TABLE [dbo].[HRM_Employee] ADD VisaNo NVARCHAR(30) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'VisaType')
    ALTER TABLE [dbo].[HRM_Employee] ADD VisaType NVARCHAR(50) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'VisaCountry')
    ALTER TABLE [dbo].[HRM_Employee] ADD VisaCountry NVARCHAR(50) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'VisaExpiryDate')
    ALTER TABLE [dbo].[HRM_Employee] ADD VisaExpiryDate DATE NULL;
GO

-- Resignation extras (existing: ResignDate, LastWorkingDay, SettledOn, FitToBeRehired, AltEmailOnExit, AltMobileOnExit)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'ResignationReason')
    ALTER TABLE [dbo].[HRM_Employee] ADD ResignationReason NVARCHAR(MAX) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'NoticeServed')
    ALTER TABLE [dbo].[HRM_Employee] ADD NoticeServed BIT NOT NULL DEFAULT 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'NoticePeriodDays')
    ALTER TABLE [dbo].[HRM_Employee] ADD NoticePeriodDays INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'ExitInterviewDate')
    ALTER TABLE [dbo].[HRM_Employee] ADD ExitInterviewDate DATE NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'ExitInterviewNotes')
    ALTER TABLE [dbo].[HRM_Employee] ADD ExitInterviewNotes NVARCHAR(MAX) NULL;
GO

PRINT '[OK] HRM_Employee Passport + Visa + Resignation fields ensured';

SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'HRM_Employee'
  AND COLUMN_NAME IN ('PassportNo','PassportExpiryDate','VisaNo','VisaExpiryDate','ResignationReason','NoticeServed','ExitInterviewDate')
ORDER BY COLUMN_NAME;
GO
