-- =====================================================================
-- 23_BN_WhPurchase_CartonNo.sql
--
-- Adds a CartonNo field to BN_WhPurchase so each tracked PO line can be
-- tagged with which physical carton it ships in.
--
-- The use case (per Amit, 2026-06-17): one PO has multiple items; not all
-- items go in the same carton; warehouse needs to track which carton each
-- item-line is packed into. The dedicated Carton inventory table
-- BN_WhStock.CartonNo already exists for the *received* side. CartonNo on
-- BN_WhPurchase is the *intent* side — what carton the supplier said this
-- line is in (or what carton our team plans to receive it into).
--
-- Multi-carton-per-line is deliberately deferred to phase 2 (would need a
-- BN_WhPurchaseCarton child table to split one PO line across N cartons).
-- For now: one line → one CartonNo, but multiple lines can share a CartonNo.
--
-- Idempotent — safe to re-run.
-- =====================================================================

USE BizNAV_App;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase')
    AND name      = 'CartonNo'
)
BEGIN
  ALTER TABLE dbo.BN_WhPurchase
    ADD CartonNo NVARCHAR(50) NULL;
  PRINT '  → added column dbo.BN_WhPurchase.CartonNo';
END
ELSE
BEGIN
  PRINT '  · dbo.BN_WhPurchase.CartonNo already exists — skipping';
END
GO

PRINT 'Migration 23 complete — CartonNo ready on dbo.BN_WhPurchase.';
GO
