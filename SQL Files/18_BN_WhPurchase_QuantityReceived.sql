-- =====================================================================
-- 18_BN_WhPurchase_QuantityReceived.sql
-- Adds a manual `QuantityReceived` column to BN_WhPurchase so the warehouse lead
-- (warehouse role, no NAV access) can record how many pcs the vendor
-- has physically delivered against each open PO line.
--
-- Why manual:
--   NAV's Purchase Line.[Quantity Received] only updates after the Pune
--   team posts a Purchase Receipt in NAV — which happens AFTER Amit tells
--   them the material has arrived. So pulling from NAV gives a stale or
--   zero value for the in-transit window we care about. Amit is the
--   ground-truth source while material is en route / partially received.
--
-- Outstanding Qty stays computed at query time:
--   OutstandingQuantity = NAV.[Quantity] - ISNULL(bn.QuantityReceived, 0)
-- so it auto-updates as Amit edits the Received field.
--
-- Idempotent — safe to re-run.
-- =====================================================================

USE BizNAV_App;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase')
    AND name      = 'QuantityReceived'
)
BEGIN
  ALTER TABLE dbo.BN_WhPurchase
    ADD QuantityReceived DECIMAL(18,4) NULL;
  PRINT '  → added column dbo.BN_WhPurchase.QuantityReceived';
END
ELSE
BEGIN
  PRINT '  · dbo.BN_WhPurchase.QuantityReceived already exists — skipping';
END
GO
