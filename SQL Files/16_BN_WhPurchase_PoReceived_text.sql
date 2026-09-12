-- ============================================================================
-- ONE App v1.8 — relax BN_WhPurchase.PoReceived from BIT to NVARCHAR(50)
-- File:  SQL Files/16_BN_WhPurchase_PoReceived_text.sql
-- Date:  2026-06-06
--
-- WHY:
--   User requested PoReceived be a free-text input ("just give input form"),
--   not a dropdown / boolean. We widen the column to NVARCHAR(50) so Amit
--   can write things like "Yes", "Pending", or "Received on 14-Jun".
--
-- SAFETY: BizNAV_App only. Idempotent (checks current type first).
--   Existing 0/1 values get auto-cast to '0'/'1' strings, which Amit can
--   overwrite as he edits each row.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;

DECLARE @current NVARCHAR(50) = (
  SELECT TOP 1 t.name
  FROM sys.columns c
  JOIN sys.types  t ON t.user_type_id = c.user_type_id
  WHERE c.object_id = OBJECT_ID(N'dbo.BN_WhPurchase')
    AND c.name = N'PoReceived'
);

IF @current = 'bit'
BEGIN
    ALTER TABLE dbo.BN_WhPurchase ALTER COLUMN PoReceived NVARCHAR(50) NULL;
    PRINT '[OK] PoReceived widened to NVARCHAR(50).';
END
ELSE
    PRINT '[SKIP] PoReceived already NVARCHAR (current type: ' + ISNULL(@current, 'NULL') + ').';
GO

-- Verify
SELECT TOP 5 Id, PoNo, LineNumber, PoReceived
FROM dbo.BN_WhPurchase
ORDER BY Id DESC;
GO
