-- ============================================================================
-- ONE App v1.8 — add IleEntryNo column to BN_WhStock
-- File:  SQL Files/15_BN_WhStock_IleEntryNo.sql
-- Date:  2026-06-06
--
-- WHY:
--   Stocks page is being redesigned to be NAV-first — driven by
--   [Item Ledger Entry] (currently-on-hand purchase entries) joined to manual
--   carton tracking in BN_WhStock. The link key is NAV's Item Ledger Entry
--   primary key, so we add it as a nullable column on BN_WhStock.
--
--   Historical Excel-imported rows leave IleEntryNo = NULL (they keep working
--   through the InvoiceNo + MPN fallback). New entries created via the UI
--   will populate IleEntryNo so the live-NAV JOIN is precise.
--
-- SAFETY: BizNAV_App only. ALTER TABLE is idempotent via column-exists check.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.BN_WhStock')
      AND name = N'IleEntryNo'
)
BEGIN
    ALTER TABLE dbo.BN_WhStock ADD IleEntryNo INT NULL;
    PRINT '[OK] dbo.BN_WhStock.IleEntryNo added.';
END
ELSE
    PRINT '[SKIP] dbo.BN_WhStock.IleEntryNo already exists.';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.BN_WhStock')
      AND name = N'IX_WhStock_Ile'
)
BEGIN
    CREATE INDEX IX_WhStock_Ile ON dbo.BN_WhStock (Company, IleEntryNo)
    WHERE IleEntryNo IS NOT NULL;
    PRINT '[OK] IX_WhStock_Ile index created.';
END
ELSE
    PRINT '[SKIP] IX_WhStock_Ile already exists.';
GO

-- Verify
SELECT TOP 1 IleEntryNo FROM dbo.BN_WhStock;
GO
