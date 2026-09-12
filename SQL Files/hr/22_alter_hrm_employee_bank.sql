-- ============================================================================
-- ONE App Lens — Phase 3D — ALTER HRM_Employee (Bank/PF/ESI/Statutory)
-- File:  SQL Files/hr/22_alter_hrm_employee_bank.sql
-- Date:  2026-05-21
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * ADDITIVE ONLY — new nullable columns. Existing rows unaffected.
--   * Each ADD wrapped in IF NOT EXISTS — idempotent.
--   * SET XACT_ABORT ON.
--
-- WHAT IT ADDS:
--   Bank: BankName, BankAccountNo, IFSC, BankBranch
--   PF:   PFNo, PFUAN
--   ESI:  ESINo
--   Statutory toggles: IncludePF / IncludeESI / IncludeLWF
--   Payroll: PaymentMode (Bank Transfer / Cheque / Cash)
--   Other: Title was already on HRM_Employee; this just fills the bank/payroll gap.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

DECLARE @added INT = 0;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'BankName')
BEGIN ALTER TABLE [dbo].[HRM_Employee] ADD BankName NVARCHAR(200) NULL; SET @added = @added + 1; END
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'BankAccountNo')
    ALTER TABLE [dbo].[HRM_Employee] ADD BankAccountNo NVARCHAR(50) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'IFSC')
    ALTER TABLE [dbo].[HRM_Employee] ADD IFSC NVARCHAR(20) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'BankBranch')
    ALTER TABLE [dbo].[HRM_Employee] ADD BankBranch NVARCHAR(150) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'PFNo')
    ALTER TABLE [dbo].[HRM_Employee] ADD PFNo NVARCHAR(50) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'PFUAN')
    ALTER TABLE [dbo].[HRM_Employee] ADD PFUAN NVARCHAR(20) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'ESINo')
    ALTER TABLE [dbo].[HRM_Employee] ADD ESINo NVARCHAR(30) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'IncludePF')
    ALTER TABLE [dbo].[HRM_Employee] ADD IncludePF BIT NOT NULL DEFAULT 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'IncludeESI')
    ALTER TABLE [dbo].[HRM_Employee] ADD IncludeESI BIT NOT NULL DEFAULT 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'IncludeLWF')
    ALTER TABLE [dbo].[HRM_Employee] ADD IncludeLWF BIT NOT NULL DEFAULT 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_Employee]') AND name = 'PaymentMode')
    ALTER TABLE [dbo].[HRM_Employee] ADD PaymentMode NVARCHAR(30) NULL DEFAULT 'Bank Transfer';
GO

PRINT '[OK] HRM_Employee bank/PF/ESI columns ensured';

SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'HRM_Employee'
  AND COLUMN_NAME IN ('BankName','BankAccountNo','IFSC','BankBranch','PFNo','PFUAN','ESINo','IncludePF','IncludeESI','IncludeLWF','PaymentMode')
ORDER BY COLUMN_NAME;
GO
