-- =====================================================================
-- 34_BN_MOMActionPointMeta.sql  —  ONE App overlay for MOM action points
-- Run on BizNAV_App (the COMPANYA app DB, writable). SmartSys (SMARTSYS DB) has NO
-- "Pending With" column; this is a ONE-App-only overlay keyed by the SmartSys
-- ActionPointId, joined back at query time. Additive + idempotent (zero-data-loss).
-- =====================================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'BN_MOMActionPointMeta')
BEGIN
  CREATE TABLE dbo.BN_MOMActionPointMeta (
    ActionPointId INT           NOT NULL PRIMARY KEY,   -- = SMARTSYS.TM_ProjectTaskMOMActionPoints.ActionPointId
    PendingWith   NVARCHAR(40)  NULL,                   -- Customer/Sales/Supplier-Vendor/FAE/Purchase/Product/Accounts/Logistics/Management (NULL = None)
    UpdatedBy     NVARCHAR(100) NULL,
    UpdatedAt     DATETIME2     NOT NULL CONSTRAINT DF_BN_MOMActionPointMeta_UpdatedAt DEFAULT SYSDATETIME()
  );
END
