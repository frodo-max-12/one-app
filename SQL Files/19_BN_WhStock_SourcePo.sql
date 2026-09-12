-- =====================================================================
-- 19_BN_WhStock_SourcePo.sql
-- Adds (SourcePoNo, SourcePoLine) columns to BN_WhStock so cartons created
-- by the Purchase page's "Received Material" auto-link flow carry a
-- reference back to the originating Purchase Order line.
--
-- Lets the Stocks UI render a lineage badge "↳ from PO ADV.PO.2627.01.0162
-- L30000" and lets us later reconcile Amit-confirmed cartons against NAV
-- once Pune posts the Purchase Receipt (via the planned ILE linker script).
--
-- Companion to migration 18 (BN_WhPurchase.QuantityReceived) — together
-- they implement the [[nav-post-cycle-vs-physical-truth]] pattern for
-- the warehouse lead's PO-to-Stock receive flow.
--
-- Idempotent — safe to re-run.
-- =====================================================================

USE BizNAV_App;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhStock') AND name = 'SourcePoNo'
)
BEGIN
  ALTER TABLE dbo.BN_WhStock ADD SourcePoNo NVARCHAR(50) NULL;
  PRINT '  → added dbo.BN_WhStock.SourcePoNo';
END
ELSE PRINT '  · dbo.BN_WhStock.SourcePoNo already exists';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhStock') AND name = 'SourcePoLine'
)
BEGIN
  ALTER TABLE dbo.BN_WhStock ADD SourcePoLine INT NULL;
  PRINT '  → added dbo.BN_WhStock.SourcePoLine';
END
ELSE PRINT '  · dbo.BN_WhStock.SourcePoLine already exists';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.BN_WhStock') AND name = 'IX_WhStock_SourcePo'
)
BEGIN
  CREATE INDEX IX_WhStock_SourcePo
    ON dbo.BN_WhStock (Company, SourcePoNo, SourcePoLine)
    WHERE SourcePoNo IS NOT NULL;
  PRINT '  → created index IX_WhStock_SourcePo';
END
ELSE PRINT '  · IX_WhStock_SourcePo already exists';
GO
