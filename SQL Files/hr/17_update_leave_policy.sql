-- ============================================================================
-- ONE App Lens — Phase 3 — Update leave policy to COMPANYA + CompanyB rules
-- File:  SQL Files/hr/17_update_leave_policy.sql
-- Date:  2026-05-20
--
-- ACTUAL COMPANY POLICY (per user, 2026-05-20):
--   * Both COMPANYA + CompanyB: 28 leaves per year, granted monthly (2.33 days/month)
--   * Unused balance carries forward MONTH to MONTH within the FY
--     (Jan: 2.33 granted, take 1 → carry 1.33; Feb: 1.33+2.33 = 3.66 available)
--   * Excess use → LOP (salary deducted)
--   * Single Casual Leave pool — no separate PL/SL/CO/RH/ML
--   * Short Leave = 0.5-day half-day variant (late arrival OR early departure);
--     draws from the same Casual Leave pool
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * ADDITIVE column adds + IDEMPOTENT data updates. Existing leave applications
--     and balance rows are NOT touched — only the LeaveType master changes.
--   * SET XACT_ABORT ON.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

-- ── 1. Add policy columns on HRM_LeaveType ──────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_LeaveType]') AND name = 'MonthlyGrant')
    ALTER TABLE [dbo].[HRM_LeaveType] ADD MonthlyGrant DECIMAL(5,2) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_LeaveType]') AND name = 'GrantMode')
    ALTER TABLE [dbo].[HRM_LeaveType] ADD GrantMode NVARCHAR(20) NOT NULL DEFAULT 'annual';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_LeaveType]') AND name = 'CarryForward')
    ALTER TABLE [dbo].[HRM_LeaveType] ADD CarryForward BIT NOT NULL DEFAULT 0;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_LeaveType]') AND name = 'FixedDays')
    ALTER TABLE [dbo].[HRM_LeaveType] ADD FixedDays DECIMAL(5,2) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[dbo].[HRM_LeaveType]') AND name = 'PoolWith')
    ALTER TABLE [dbo].[HRM_LeaveType] ADD PoolWith NVARCHAR(10) NULL;   -- 'CL' → SHORT shares balance with CL
GO

PRINT '[OK] HRM_LeaveType policy columns added';
GO

-- ── 2. Disable unused leave types ───────────────────────────────────────────
UPDATE [dbo].[HRM_LeaveType] SET IsActive = 0, UpdatedAt = SYSDATETIME()
WHERE Code IN ('PL','SL','CO','RH','ML');
GO
PRINT '[OK] Disabled PL/SL/CO/RH/ML (not used in COMPANYA policy)';
GO

-- ── 3. Update CL to be THE annual casual-leave pool ─────────────────────────
UPDATE [dbo].[HRM_LeaveType]
SET Name          = N'Casual Leave',
    ShortLabel    = N'Casual Leave',
    Description   = N'Single annual leave pool — 28 days/year granted at 2.33 days/month, unused balance carries forward. Use this for any planned absence.',
    IsActive      = 1,
    IsPaid        = 1,
    AnnualGrant   = 28.00,
    MonthlyGrant  = 2.33,
    GrantMode     = 'monthly',
    CarryForward  = 1,
    AllowHalfDay  = 1,
    AllowNegative = 0,
    Color         = N'#22c55e',
    Icon          = N'🌴',
    PoolWith      = NULL,
    FixedDays     = NULL,
    UpdatedAt     = SYSDATETIME()
WHERE Code = 'CL';
GO
PRINT '[OK] CL updated to 28/yr, 2.33/month, carry forward';
GO

-- ── 4. Make sure SHORT exists — separate monthly allowance of 2 events ─────
MERGE INTO [dbo].[HRM_LeaveType] AS target
USING (VALUES (N'SHORT')) AS src(Code)
ON target.Code = src.Code
WHEN NOT MATCHED THEN
  INSERT (Code, Name, ShortLabel, Description, IsPaid, IsActive,
          AnnualGrant, MonthlyGrant, GrantMode, CarryForward,
          AllowHalfDay, AllowNegative, Color, Icon, FixedDays, PoolWith)
  VALUES (N'SHORT', N'Short Leave', N'Short Leave',
          N'Late arrival (11:15 AM) or early departure (4:30 PM). 2 allowed per month, separate from Casual Leave. Resets each month.',
          1, 1, 24.00, 2.00, 'monthly', 0, 0, 0,
          N'#3b82f6', N'⏱', 1.00, NULL);
GO

-- If SHORT already existed from an earlier run, also update its fields to the right policy
UPDATE [dbo].[HRM_LeaveType]
SET Name          = N'Short Leave',
    ShortLabel    = N'Short Leave',
    Description   = N'Late arrival (11:15 AM) or early departure (4:30 PM). 2 allowed per month, separate from Casual Leave. Resets each month.',
    IsActive      = 1,
    IsPaid        = 1,
    AnnualGrant   = 24.00,
    MonthlyGrant  = 2.00,
    GrantMode     = 'monthly',
    CarryForward  = 0,
    AllowHalfDay  = 0,
    AllowNegative = 0,
    FixedDays     = 1.00,
    PoolWith      = NULL,
    Color         = N'#3b82f6',
    Icon          = N'⏱',
    UpdatedAt     = SYSDATETIME()
WHERE Code = 'SHORT';
GO
PRINT '[OK] SHORT (Short Leave) configured as separate 2/month allowance';
GO

-- ── 5. Make sure LOP stays available for overruns ───────────────────────────
UPDATE [dbo].[HRM_LeaveType]
SET IsActive = 1, AllowNegative = 1, AllowHalfDay = 1, UpdatedAt = SYSDATETIME()
WHERE Code = 'LOP';
GO

-- ── 6. Verify
SELECT Code, Name, IsActive, IsPaid, AnnualGrant, MonthlyGrant, GrantMode,
       CarryForward, AllowHalfDay, FixedDays, PoolWith, Icon, Color
FROM [dbo].[HRM_LeaveType]
ORDER BY IsActive DESC, Code;
GO
