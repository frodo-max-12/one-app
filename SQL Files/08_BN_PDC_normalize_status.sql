-- ============================================================================
-- One-time normalization of BN_PDC.Status values
-- 2026-05-27 — accounts imported CHEQUES IN & OUT LIST 9.xlsx where Status held
-- human-readable labels ("Cleared", "Not Deposited", "Cheque Bounce", etc.).
-- The import path then lower-cased them ("not deposited") but didn't snap to
-- the canonical internal keys ("not_deposited"), so the stat cards bucketed
-- everything as Pending. This one-shot fixes the existing rows.
--
-- SAFETY: read-only target check first, then ADDITIVE UPDATE only. Re-running
-- is safe — each UPDATE filters on the un-normalized values so a second run
-- is a no-op. Wrapped in an explicit transaction with rollback-on-error.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- Quick before-snapshot so the dev can verify
PRINT '--- BEFORE ---';
SELECT LOWER(LTRIM(RTRIM(ISNULL(Status, '(null)')))) AS Status, COUNT(*) AS Rows
FROM dbo.BN_PDC
WHERE IsActive = 1
GROUP BY LOWER(LTRIM(RTRIM(ISNULL(Status, '(null)'))))
ORDER BY 2 DESC;

-- Cleared
UPDATE dbo.BN_PDC SET Status = 'cleared'
WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) = 'cleared'
  AND Status <> 'cleared' COLLATE Latin1_General_BIN2;

-- Not Deposited
UPDATE dbo.BN_PDC SET Status = 'not_deposited'
WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) = 'not deposited';

-- Deposited
UPDATE dbo.BN_PDC SET Status = 'deposited'
WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) = 'deposited'
  AND Status <> 'deposited' COLLATE Latin1_General_BIN2;

-- Cheque Bounce / Bounce / Bounced
UPDATE dbo.BN_PDC SET Status = 'bounced'
WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) IN ('cheque bounce', 'bounce')
   OR (IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) = 'bounced'
       AND Status <> 'bounced' COLLATE Latin1_General_BIN2);

-- Online Received / NEFT Done / NEFT Received / Online Transfer
UPDATE dbo.BN_PDC SET Status = 'online'
WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) IN (
  'online received', 'neft received', 'neft done', 'online transfer'
);

-- Hold
UPDATE dbo.BN_PDC SET Status = 'hold'
WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) = 'hold'
  AND Status <> 'hold' COLLATE Latin1_General_BIN2;

-- Cancelled / Canceled
UPDATE dbo.BN_PDC SET Status = 'cancelled'
WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) IN ('cancelled', 'canceled')
  AND Status <> 'cancelled' COLLATE Latin1_General_BIN2;

-- PDC With Salesperson
UPDATE dbo.BN_PDC SET Status = 'with_salesperson'
WHERE IsActive = 1 AND LOWER(LTRIM(RTRIM(Status))) IN ('with salesperson', 'pdc with salesperson');

-- The placeholder rows ("-") and blanks → leave as 'pending' default
UPDATE dbo.BN_PDC SET Status = 'pending'
WHERE IsActive = 1 AND (Status IS NULL OR LTRIM(RTRIM(Status)) IN ('', '-'));

PRINT '--- AFTER ---';
SELECT Status, COUNT(*) AS Rows
FROM dbo.BN_PDC
WHERE IsActive = 1
GROUP BY Status
ORDER BY 2 DESC;

COMMIT TRANSACTION;
PRINT '[OK] BN_PDC.Status normalized.';
GO
