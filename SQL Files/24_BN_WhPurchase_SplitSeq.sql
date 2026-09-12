/* ====================================================================
   24_BN_WhPurchase_SplitSeq.sql

   Adds SplitSeq INT NULL to BN_WhPurchase so the same NAV PO line can
   be tracked across MULTIPLE BN_WhPurchase rows when split across
   physical cartons.

   Pre-2026-06-24 design: composite key = (Company, PoNo, LineNumber).
   That broke the moment a NAV line of 920,000 qty got split into 2
   physical cartons (CTN-26-0008 + CTN-26-0009) — both POSTed to
   /warehouse/purchase with same PoNo+LineNumber, MERGE matched the
   same row and the second save overwrote the first → first carton lost.

   Post-2026-06-24 design: composite key = (Company, PoNo, LineNumber,
   ISNULL(SplitSeq, 0)). SplitSeq = 0 (or NULL) for the base entry;
   1, 2, ... for split clones. MERGE now treats each split as its own
   row.

   IDEMPOTENT — safe to re-run.
   ==================================================================== */

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase') AND name = 'SplitSeq'
)
BEGIN
  ALTER TABLE dbo.BN_WhPurchase
    ADD SplitSeq INT NULL;
END
GO

-- Helper index to keep the MERGE / UPDATE fast on the new composite key.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_WhPurchase_CompanyPoLineSplit'
    AND object_id = OBJECT_ID('dbo.BN_WhPurchase')
)
BEGIN
  CREATE INDEX IX_WhPurchase_CompanyPoLineSplit
    ON dbo.BN_WhPurchase (Company, PoNo, LineNumber, SplitSeq)
    WHERE IsActive = 1;
END
GO

PRINT '✓ 24_BN_WhPurchase_SplitSeq applied — split-carton tracking enabled.';
