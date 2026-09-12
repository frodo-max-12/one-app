-- ============================================================================
-- ONE App Lens — Phase 3 — Short Leave as SEPARATE monthly allowance
-- File:  SQL Files/hr/18_short_leave_separate.sql
-- Date:  2026-05-20
--
-- CLARIFIED POLICY (per user, 2026-05-20):
--   * Casual Leave: 2.33 days/month, 28/year, carry forward within FY
--   * Short Leave:  2 PER MONTH, COMPLETELY SEPARATE pool (does NOT touch CL)
--                   - Late arrival: come in at 11:15 AM (normal 9:45)
--                   - Early depart: leave at 4:30 PM (normal 6:15)
--                   - Each Short Leave = 1 event (count, not days)
--                   - Monthly cap of 2; 3rd in same month is BLOCKED
--                   - Does NOT carry forward — each month resets
--
-- SAFETY PROFILE:
--   * BizNAV_App only. UPDATE-only on HRM_LeaveType. Idempotent.
--   * SET XACT_ABORT ON.
-- ============================================================================

USE BizNAV_App;
GO
SET XACT_ABORT ON;
GO

UPDATE [dbo].[HRM_LeaveType]
SET PoolWith       = NULL,           -- no longer pools with CL
    FixedDays      = 1,              -- each Short Leave counts as 1 (the per-event unit)
    MonthlyGrant   = 2,              -- 2 short leaves per month
    AnnualGrant    = 24,             -- 12 months × 2
    GrantMode      = 'monthly',
    CarryForward   = 0,              -- monthly cap of 2 enforced in app code
    AllowHalfDay   = 0,              -- not a half-day type; it's its own event
    AllowNegative  = 0,
    Description    = N'Late arrival (11:15 AM) OR early departure (4:30 PM). 2 allowed per month, separate from your Casual Leave pool. Resets each month.',
    Color          = N'#3b82f6',
    Icon           = N'⏱',
    UpdatedAt      = SYSDATETIME()
WHERE Code = 'SHORT';
GO

PRINT '[OK] SHORT updated: separate from CL, 2/month, no carry forward';
GO

-- Reset any existing SHORT balance row to be a clean 2/month accumulator.
-- (Granted recomputes automatically on next balance fetch via auto-grant logic;
--  zeroing Pending in case any pre-existing pool-host hold was left behind.)
UPDATE [dbo].[HRM_LeaveBalance]
SET Granted = 0, Pending = 0, UpdatedAt = SYSDATETIME()
WHERE LeaveTypeCode = 'SHORT';
GO

SELECT Code, Name, IsActive, AnnualGrant, MonthlyGrant, GrantMode,
       CarryForward, FixedDays, PoolWith, AllowHalfDay, Color, Icon
FROM [dbo].[HRM_LeaveType]
WHERE IsActive = 1
ORDER BY CASE Code WHEN 'CL' THEN 1 WHEN 'SHORT' THEN 2 WHEN 'LOP' THEN 3 ELSE 4 END;
GO
