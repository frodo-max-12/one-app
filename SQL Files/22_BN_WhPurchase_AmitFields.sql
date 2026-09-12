-- =====================================================================
-- 22_BN_WhPurchase_AmitFields.sql
--
-- Adds the warehouse lead's per-line manual fields to BN_WhPurchase so the v1.9
-- Purchase module mirrors the field set he was using in his Apps Script
-- workbook. Lets the Vendor → PO → Lines wizard capture everything he
-- needs without falling back to the Remark column.
--
-- New columns (all NULL — optional, not retroactively backfilled):
--   Incoterms        NVARCHAR(20)    -- FOB / CIF / EXW / CFR / DDP / DAP / FCA
--   Datecode         NVARCHAR(30)    -- vendor's manufacturing datecode
--   LotNo            NVARCHAR(50)    -- vendor's batch/lot number
--   NetWeightKg      DECIMAL(10,3)   -- per-SKU net weight (sep from WeightKg=gross)
--   GstPaidByUsFlag  BIT             -- override: 1=we pay, 0=supplier pays
--                                       NULL = use VendorCountry rule (SG=supplier, else=us)
--   NoOfCartons      INT             -- info-only count; multi-row split deferred
--                                       to phase 2 (BN_WhPurchaseCarton child table)
--
-- Idempotent — safe to re-run.
-- =====================================================================

USE BizNAV_App;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase') AND name = 'Incoterms')
BEGIN
  ALTER TABLE dbo.BN_WhPurchase ADD Incoterms NVARCHAR(20) NULL;
  PRINT '  → added column dbo.BN_WhPurchase.Incoterms';
END
ELSE PRINT '  · dbo.BN_WhPurchase.Incoterms already exists — skipping';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase') AND name = 'Datecode')
BEGIN
  ALTER TABLE dbo.BN_WhPurchase ADD Datecode NVARCHAR(30) NULL;
  PRINT '  → added column dbo.BN_WhPurchase.Datecode';
END
ELSE PRINT '  · dbo.BN_WhPurchase.Datecode already exists — skipping';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase') AND name = 'LotNo')
BEGIN
  ALTER TABLE dbo.BN_WhPurchase ADD LotNo NVARCHAR(50) NULL;
  PRINT '  → added column dbo.BN_WhPurchase.LotNo';
END
ELSE PRINT '  · dbo.BN_WhPurchase.LotNo already exists — skipping';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase') AND name = 'NetWeightKg')
BEGIN
  ALTER TABLE dbo.BN_WhPurchase ADD NetWeightKg DECIMAL(10,3) NULL;
  PRINT '  → added column dbo.BN_WhPurchase.NetWeightKg';
END
ELSE PRINT '  · dbo.BN_WhPurchase.NetWeightKg already exists — skipping';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase') AND name = 'GstPaidByUsFlag')
BEGIN
  ALTER TABLE dbo.BN_WhPurchase ADD GstPaidByUsFlag BIT NULL;
  PRINT '  → added column dbo.BN_WhPurchase.GstPaidByUsFlag';
END
ELSE PRINT '  · dbo.BN_WhPurchase.GstPaidByUsFlag already exists — skipping';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.BN_WhPurchase') AND name = 'NoOfCartons')
BEGIN
  ALTER TABLE dbo.BN_WhPurchase ADD NoOfCartons INT NULL;
  PRINT '  → added column dbo.BN_WhPurchase.NoOfCartons';
END
ELSE PRINT '  · dbo.BN_WhPurchase.NoOfCartons already exists — skipping';
GO

PRINT 'Migration 22 complete — Amit-field columns ready on dbo.BN_WhPurchase.';
GO
