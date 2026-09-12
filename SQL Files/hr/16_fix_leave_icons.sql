-- ============================================================================
-- ONE App Lens — HOTFIX — restore emoji icons on HRM_LeaveType
-- File:  SQL Files/hr/16_fix_leave_icons.sql
-- Date:  2026-05-20
--
-- WHY THIS FILE EXISTS:
--   13_leave_types.sql seeded the Icon column with plain (non-N'') string
--   literals like '🌴'. SQL Server treated those as varchar — which cannot
--   represent emoji characters — so they were collapsed to '?' on storage.
--   This script restores the correct emoji icons using N'' Unicode prefix.
--
-- SAFETY PROFILE:
--   * BizNAV_App.dbo.HRM_LeaveType ONLY. NAV DB untouched.
--   * UPDATE-only — no schema changes. Idempotent — running twice gives same result.
--   * No data loss — only the Icon column gets rewritten.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

UPDATE [dbo].[HRM_LeaveType] SET Icon = N'🌴' WHERE Code = 'PL';
UPDATE [dbo].[HRM_LeaveType] SET Icon = N'☕' WHERE Code = 'CL';
UPDATE [dbo].[HRM_LeaveType] SET Icon = N'🤒' WHERE Code = 'SL';
UPDATE [dbo].[HRM_LeaveType] SET Icon = N'🔄' WHERE Code = 'CO';
UPDATE [dbo].[HRM_LeaveType] SET Icon = N'💸' WHERE Code = 'LOP';
UPDATE [dbo].[HRM_LeaveType] SET Icon = N'🪔' WHERE Code = 'RH';
UPDATE [dbo].[HRM_LeaveType] SET Icon = N'🤱' WHERE Code = 'ML';

PRINT '[OK] HRM_LeaveType.Icon restored for 7 categories';
GO

-- Verify — Icon column should now show proper emojis
SELECT Code, Name, Icon, Color FROM [dbo].[HRM_LeaveType] ORDER BY Code;
GO
