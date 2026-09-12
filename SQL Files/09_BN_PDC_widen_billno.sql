-- ============================================================================
-- Widen BN_PDC.BillNo from NVARCHAR(50) to NVARCHAR(500)
-- 2026-05-27 — accounts has cheques that pay against multiple invoices, written
-- comma-separated in the Bill No column, e.g.
--   "COMPANYA/BE-2627/0059, 0196, 0394, 0511, 0528, 0610, 0758, 0759"
-- 70+ chars overflows NVARCHAR(50) and the import skips the row with a string-
-- truncation error.
--
-- SAFETY:
--   - ALTER COLUMN to NVARCHAR(500) is metadata-only widening, no data rewrite,
--     no locking risk, no data loss.
--   - Idempotency-guarded — re-running is a no-op.
--   - Indexes on BillNo are kept intact (none are wider-than-key constrained).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;

IF (
  SELECT max_length FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_PDC') AND name = 'BillNo'
) < 1000
BEGIN
  ALTER TABLE dbo.BN_PDC ALTER COLUMN BillNo NVARCHAR(500) NULL;
  PRINT '[OK] BN_PDC.BillNo widened to NVARCHAR(500).';
END
ELSE
BEGIN
  PRINT '[SKIP] BN_PDC.BillNo already wider than 50 chars.';
END
GO
