-- ============================================================================
-- ONE App — add PM (Product Manager) column to BN_DCFile
-- File:  SQL Files/27_BN_DCFile_PM.sql        Date: 2026-06-27
--
-- The Product team enters a PM name (PM1 / PM2 / PM3) on each DC row so
-- the Authorized lines can be segregated by who manages them. Scoping (in
-- routes/dc.js): a Product ASSISTANT sees only rows where PM = their first name;
-- the Product HEAD + admin see all. an assistant's lines sit under the head.
--
-- SAFETY: BizNAV_App only. Idempotent (adds the column only if missing). Additive.
-- ============================================================================

USE BizNAV_App;
GO

IF COL_LENGTH('dbo.BN_DCFile', 'PM') IS NULL
BEGIN
    ALTER TABLE dbo.BN_DCFile ADD PM NVARCHAR(60) NULL;
    PRINT '[OK] BN_DCFile.PM added.';
END
ELSE
    PRINT '[skip] BN_DCFile.PM already exists.';
GO
