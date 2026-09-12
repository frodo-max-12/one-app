-- =====================================================================
-- 31_store_audit_verify_and_scan_cols.sql
-- Store Auditing (Retailer) — the App-DB objects added on the live server
-- for the Store-Audit "Today / Final" workflow (merged into v1.11 on 2026-07-20).
--
-- These ALREADY EXIST on the production BizNAV_App (verified 2026-07-20 — the live
-- store module has been writing to them). This script is IDEMPOTENT and is kept
-- only so a fresh DB / the GitHub archive can recreate them. Running it on the
-- live DB is a safe no-op.
--
-- App DB (BizNAV_App) — writable. NO NAV database is touched.
-- Follows 21_BN_StoreScan.sql.
-- =====================================================================

-- 1) Freeze the NAV system qty at scan time, and mark a scan row as moved into
--    the Final (frozen) audit set.
IF COL_LENGTH('dbo.BN_StoreScan', 'SystemQtyAtCapture') IS NULL
    ALTER TABLE dbo.BN_StoreScan ADD SystemQtyAtCapture DECIMAL(18,2) NULL;
GO
IF COL_LENGTH('dbo.BN_StoreScan', 'TransferredAt') IS NULL
    ALTER TABLE dbo.BN_StoreScan ADD TransferredAt DATETIME2 NULL;
GO

-- 2) Per-item verification / qty-correction decisions (store-side sign-off during
--    the Final audit). Keyed unique on (Company, ItemCode).
IF OBJECT_ID('dbo.BN_StoreAuditVerify', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.BN_StoreAuditVerify (
        Id           INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_BN_StoreAuditVerify PRIMARY KEY,
        Company      NVARCHAR(100) NOT NULL,
        ItemCode     NVARCHAR(100) NOT NULL,
        Decision     NVARCHAR(10)  NULL,       -- 'yes' / 'no'
        VerifiedBy   NVARCHAR(231) NULL,
        VerifiedAt   DATETIME2     NULL,
        CorrectedBy  NVARCHAR(231) NULL,
        CorrectedQty DECIMAL(18,2) NULL,
        CorrectedAt  DATETIME2     NULL
    );
    CREATE UNIQUE INDEX UX_BN_StoreAuditVerify
        ON dbo.BN_StoreAuditVerify (Company, ItemCode);
END
GO
