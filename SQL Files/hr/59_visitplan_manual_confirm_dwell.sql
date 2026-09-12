-- ============================================================================
-- ONE App — Option C: manual visit confirm + relaxed geofence dwell
-- File:  SQL Files/hr/59_visitplan_manual_confirm_dwell.sql
-- Date:  2026-06-03
--
-- WHY:
--   The geofence auto-detector only confirms a planned visit after the rep
--   stays inside the 100m fence for >=10 minutes (DwellMinForVisit). Field
--   reality: many genuine on-site stops are 5-9 min, and tracking gaps (battery
--   tier dropped, app backgrounded, indoor GPS) sometimes mean no ping ever
--   lands inside the fence at all. Reps need a manual override; auto-detect
--   stays running as belt-and-braces.
--
-- TWO CHANGES (both idempotent / safe):
--   1. BN_VisitPlan: add ManualConfirmedAt + ManualConfirmedByUserId columns
--      so we can distinguish manual-mark from geofence-auto-confirm in reports.
--      Additive nullable. Existing rows + routes unaffected.
--   2. HRM_Geofence: lower DwellMinForVisit 10 -> 5 for existing customer
--      geofences that are still at the old default. Customer-set per-fence
--      overrides (anything not equal to 10) are left alone.
--
-- SAFETY: BizNAV_App only. Wrapped in SET XACT_ABORT ON; guarded; idempotent.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;

-- ── 1. BN_VisitPlan: add ManualConfirmedAt + ManualConfirmedByUserId ─────────
DECLARE @sql NVARCHAR(MAX) = N'';

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.BN_VisitPlan') AND name = 'ManualConfirmedAt')
  SET @sql += N'ALTER TABLE dbo.BN_VisitPlan ADD ManualConfirmedAt DATETIME2 NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.BN_VisitPlan') AND name = 'ManualConfirmedByUserId')
  SET @sql += N'ALTER TABLE dbo.BN_VisitPlan ADD ManualConfirmedByUserId INT NULL;' + CHAR(10);

IF LEN(@sql) = 0
  PRINT '[SKIP] BN_VisitPlan manual-confirm columns already present.';
ELSE
BEGIN
  EXEC sp_executesql @sql;
  PRINT '[OK] BN_VisitPlan extended with ManualConfirmedAt + ManualConfirmedByUserId.';
END
GO

-- ── 2. HRM_Geofence: relax default dwell 10 -> 5 for customer fences ─────────
DECLARE @rows INT;

UPDATE dbo.HRM_Geofence
SET    DwellMinForVisit = 5
WHERE  Kind = 'customer'
  AND  DwellMinForVisit = 10;

SET @rows = @@ROWCOUNT;

IF @rows = 0
  PRINT '[SKIP] No customer geofences at the old default of 10 min — nothing to relax.';
ELSE
  PRINT '[OK] Relaxed DwellMinForVisit from 10 -> 5 on ' + CAST(@rows AS VARCHAR(10)) + ' customer geofence(s).';
GO
