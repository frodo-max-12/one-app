-- ============================================================================
-- ONE App Lens — Phase 3 — Migrate legacy leave applications to CL
-- File:  SQL Files/hr/19_migrate_disabled_leave_types.sql
-- Date:  2026-05-20
--
-- WHY THIS FILE EXISTS:
--   Before the policy was clarified (single CL pool + separate SHORT), test
--   applications were filed under PL / SL / CO / RH / ML — types that are now
--   disabled. Those applications sat in HRM_Leave but never deducted from the
--   new CL pool, so the balance display showed full 4.7 days even when 2 had
--   been approved.
--
-- WHAT IT DOES:
--   1. Re-points every pending/approved HRM_Leave row that uses a DISABLED
--      type to LeaveTypeCode = 'CL'. Cancelled / rejected rows stay as-is
--      (historical accuracy — not needed for balance math).
--   2. Wipes any HRM_LeaveBalance rows for disabled types (they're noise now).
--   3. Recalculates Consumed + Pending on each user's CL balance row by
--      summing the AUTHORITATIVE source — actual HRM_Leave rows. This makes
--      the balance self-healing for any past drift.
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * Idempotent — running twice is safe. Approved rows already marked CL stay CL.
--   * Wrapped in transaction via SET XACT_ABORT ON. Auto-rollback on error.
--   * SHORT applications are not affected — they're already on the right type.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

-- 1. Re-point legacy applications to CL ───────────────────────────────────────
DECLARE @migrated INT;

UPDATE [dbo].[HRM_Leave]
SET LeaveTypeCode = 'CL', UpdatedAt = SYSDATETIME()
WHERE LeaveTypeCode IN ('PL','SL','CO','RH','ML')
  AND Status IN ('pending','approved');

SET @migrated = @@ROWCOUNT;
PRINT '[OK] Migrated ' + CAST(@migrated AS NVARCHAR(10)) + ' legacy leave applications to CL';
GO

-- 2. Clean up balance rows for disabled types ────────────────────────────────
DELETE FROM [dbo].[HRM_LeaveBalance]
WHERE LeaveTypeCode IN ('PL','SL','CO','RH','ML');
PRINT '[OK] Removed HRM_LeaveBalance rows for disabled types';
GO

-- 3. Recompute Consumed + Pending from authoritative HRM_Leave data ─────────
;WITH leave_rollup AS (
    SELECT
        UserId,
        SUM(CASE WHEN Status = 'approved' THEN DaysApplied ELSE 0 END) AS Consumed,
        SUM(CASE WHEN Status = 'pending'  THEN DaysApplied ELSE 0 END) AS Pending
    FROM [dbo].[HRM_Leave]
    WHERE LeaveTypeCode = 'CL'
      AND YEAR(FromDate) IN (YEAR(GETDATE()), YEAR(GETDATE()) + (CASE WHEN MONTH(GETDATE()) >= 4 THEN 0 ELSE -1 END))
    GROUP BY UserId
)
MERGE INTO [dbo].[HRM_LeaveBalance] AS tgt
USING leave_rollup AS src
ON tgt.UserId = src.UserId
   AND tgt.LeaveTypeCode = 'CL'
   AND tgt.FinancialYear = CASE WHEN MONTH(GETDATE()) >= 4
        THEN 'FY' + CAST(YEAR(GETDATE()) AS NVARCHAR(4)) + '-' + RIGHT(CAST(YEAR(GETDATE()) + 1 AS NVARCHAR(4)), 2)
        ELSE 'FY' + CAST(YEAR(GETDATE()) - 1 AS NVARCHAR(4)) + '-' + RIGHT(CAST(YEAR(GETDATE()) AS NVARCHAR(4)), 2) END
WHEN MATCHED THEN
    UPDATE SET Consumed = src.Consumed,
               Pending  = src.Pending,
               UpdatedAt = SYSDATETIME()
WHEN NOT MATCHED THEN
    INSERT (UserId, LeaveTypeCode, FinancialYear, OpeningBalance, Granted, Consumed, Pending, Lapsed)
    VALUES (src.UserId, 'CL',
            CASE WHEN MONTH(GETDATE()) >= 4
                 THEN 'FY' + CAST(YEAR(GETDATE()) AS NVARCHAR(4)) + '-' + RIGHT(CAST(YEAR(GETDATE()) + 1 AS NVARCHAR(4)), 2)
                 ELSE 'FY' + CAST(YEAR(GETDATE()) - 1 AS NVARCHAR(4)) + '-' + RIGHT(CAST(YEAR(GETDATE()) AS NVARCHAR(4)), 2) END,
            0, 0, src.Consumed, src.Pending, 0);

PRINT '[OK] Recomputed CL Consumed + Pending from HRM_Leave';
GO

-- 4. Verify
SELECT
    UL.Id, UL.Name, UL.Email,
    LB.LeaveTypeCode, LB.FinancialYear,
    LB.Granted, LB.Consumed, LB.Pending,
    (LB.Granted - LB.Consumed - LB.Pending) AS Available
FROM [dbo].[HRM_LeaveBalance] LB
INNER JOIN [dbo].[User_Login] UL ON UL.Id = LB.UserId
WHERE LB.LeaveTypeCode = 'CL'
  AND (LB.Consumed > 0 OR LB.Pending > 0)
ORDER BY UL.Name;
GO
