-- ============================================================================
-- ONE App Lens — Phase 3 — HRM_LeaveType
-- File:  SQL Files/hr/13_leave_types.sql
-- Date:  2026-05-20
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent. Seed inserts also idempotent via WHERE NOT EXISTS.
--   * SET XACT_ABORT ON — auto-rollback.
--
-- WHAT IT CREATES:
--   dbo.HRM_LeaveType — master list of leave categories the company offers.
--   Seeded with the 4 standard COMPANYA leave types matching the existing GreytHR setup.
--
-- HOW IT'S USED:
--   - HRM_LeaveBalance row per (User, LeaveTypeCode, FY)
--   - HRM_Leave application points back via LeaveTypeCode
--   - Frontend Apply Leave dropdown reads from /api/hr/leave/types
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_LeaveType]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_LeaveType] (
        LeaveTypeId    INT            IDENTITY(1,1) PRIMARY KEY,
        Code           NVARCHAR(10)   NOT NULL UNIQUE,    -- 'PL','CL','SL','CO','LOP','RH','ML'
        Name           NVARCHAR(100)  NOT NULL,
        ShortLabel     NVARCHAR(30)   NULL,
        Description    NVARCHAR(500)  NULL,
        IsPaid         BIT            NOT NULL DEFAULT 1,
        IsActive       BIT            NOT NULL DEFAULT 1,
        AnnualGrant    DECIMAL(5,2)   NOT NULL DEFAULT 0, -- days granted per FY (used by Leave Granter)
        MaxConsecutive DECIMAL(5,2)   NULL,               -- optional cap on consecutive days
        AllowHalfDay   BIT            NOT NULL DEFAULT 1,
        AllowNegative  BIT            NOT NULL DEFAULT 0, -- LOP doesn't have a balance check
        Color          NVARCHAR(20)   NULL,               -- hex for UI pill, e.g. '#22c55e'
        Icon           NVARCHAR(20)   NULL,               -- emoji
        CreatedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)   NULL
    );

    PRINT '[OK] dbo.HRM_LeaveType created.';
END
ELSE PRINT '[SKIP] dbo.HRM_LeaveType already exists.';
GO

-- Seed standard COMPANYA leave types (matches existing GreytHR setup)
-- NOTE: Icon column requires N'' Unicode prefix to preserve emoji bytes,
-- otherwise SQL Server collapses them to '?' on insert. See 16_fix_leave_icons.sql.
MERGE INTO [dbo].[HRM_LeaveType] AS target
USING (VALUES
    ('PL',  N'Paid Leave',          N'Paid Leave',          N'Annual privilege leave — earned, carried forward subject to cap', 1, 1, 12.00, 1, 0, N'#22c55e', N'🌴'),
    ('CL',  N'Casual Leave',        N'Casual Leave',        N'Short-notice casual leave — typically 1–2 days at a time',         1, 1,  6.00, 1, 0, N'#3b82f6', N'☕'),
    ('SL',  N'Sick Leave',          N'Sick Leave',          N'Medical / sick leave — may require doctor''s note for >3 days',    1, 1,  6.00, 1, 0, N'#ef4444', N'🤒'),
    ('CO',  N'Comp-Off',            N'Comp-Off',            N'Compensatory off for working on weekly off / holiday',             1, 1,  0.00, 1, 0, N'#8b5cf6', N'🔄'),
    ('LOP', N'Loss of Pay',         N'LOP',                 N'Unpaid leave — salary deducted',                                  0, 1,  0.00, 1, 1, N'#94a3b8', N'💸'),
    ('RH',  N'Restricted Holiday',  N'Restricted Holiday',  N'Optional regional / religious holiday',                            1, 1,  2.00, 0, 0, N'#f59e0b', N'🪔'),
    ('ML',  N'Maternity Leave',     N'Maternity Leave',     N'Statutory maternity leave per Maternity Benefit Act',              1, 1, 26.00, 0, 0, N'#ec4899', N'🤱')
) AS src (Code, Name, ShortLabel, Description, IsPaid, IsActive, AnnualGrant, AllowHalfDay, AllowNegative, Color, Icon)
ON target.Code = src.Code
WHEN NOT MATCHED THEN
  INSERT (Code, Name, ShortLabel, Description, IsPaid, IsActive, AnnualGrant, AllowHalfDay, AllowNegative, Color, Icon)
  VALUES (src.Code, src.Name, src.ShortLabel, src.Description, src.IsPaid, src.IsActive, src.AnnualGrant, src.AllowHalfDay, src.AllowNegative, src.Color, src.Icon);

PRINT '[OK] HRM_LeaveType seeded with 7 standard leave categories.';
GO

SELECT Code, Name, AnnualGrant, IsPaid, AllowHalfDay, Color, Icon
FROM [dbo].[HRM_LeaveType]
WHERE IsActive = 1
ORDER BY Code;
GO
