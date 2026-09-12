-- ============================================================================
-- ONE App v1.8 — add SplitFromId column + filtered index to BN_WhStock
-- File:  SQL Files/17_BN_WhStock_SplitFromId.sql
-- Date:  2026-06-09
--
-- WHY:
--   Amit needs to split a single carton row into N pieces (e.g. a 10K-qty
--   row → 3334 + 3333 + 3333). Each derived row records its lineage by
--   storing the original row's Id in SplitFromId, so the UI can render
--   a "↳ split from C-XXXX" badge and we have an audit trail of physical
--   carton subdivisions.
--
-- SAFETY: BizNAV_App only. Both ALTER + CREATE INDEX are idempotent via
--   sys.columns / sys.indexes existence checks. Nothing destructive.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.BN_WhStock')
      AND name = N'SplitFromId'
)
BEGIN
    ALTER TABLE dbo.BN_WhStock ADD SplitFromId INT NULL;
    PRINT '[OK] dbo.BN_WhStock.SplitFromId added.';
END
ELSE
    PRINT '[SKIP] dbo.BN_WhStock.SplitFromId already exists.';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.BN_WhStock')
      AND name = N'IX_WhStock_SplitFrom'
)
BEGIN
    CREATE INDEX IX_WhStock_SplitFrom ON dbo.BN_WhStock (Company, SplitFromId)
    WHERE SplitFromId IS NOT NULL;
    PRINT '[OK] IX_WhStock_SplitFrom (filtered) created.';
END
ELSE
    PRINT '[SKIP] IX_WhStock_SplitFrom already exists.';
GO

-- Verify
SELECT TOP 1 SplitFromId FROM dbo.BN_WhStock;
GO

select * FROM dbo.BN_WhStock
DELETE FROM dbo.BN_WhStock WHERE Id = 1548;
