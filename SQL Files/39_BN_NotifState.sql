-- =====================================================================
-- 39_BN_NotifState.sql  —  change-detection state for NAV-polled events (v1.13)
-- App DB: BizNAV_App (writable). ADDITIVE — safe to run on live prod.
--
-- NAV does NOT retain previous field values, so to fire a notification only on a
-- CHANGE (not on every scan) the poller must remember what it last saw. Two bits
-- of state:
--   • BN_NotifWatermark  — generic "last seen" marker (e.g. last invoice Created
--     DateTime already processed) so invoice-created fires once per new invoice.
--   • BN_NotifSoState    — last-seen [Remarks] per open SO line, so we can detect
--     the transition INTO "Ex-Stock" (material received in store for that SO).
-- On the FIRST run each is BASELINED silently (seed current state, notify nothing)
-- so we never blast history.
-- =====================================================================
IF OBJECT_ID('dbo.BN_NotifWatermark', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.BN_NotifWatermark (
    WmKey       NVARCHAR(60)  NOT NULL PRIMARY KEY,  -- e.g. 'invoice_created:COMPANYA'
    WmValue     NVARCHAR(200) NULL,                  -- e.g. last invoice No_
    WmDateTime  DATETIME2     NULL,                  -- e.g. last Created DateTime processed
    UpdatedAt   DATETIME2     NOT NULL DEFAULT SYSDATETIME()
  );
END
GO

IF OBJECT_ID('dbo.BN_NotifSoState', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.BN_NotifSoState (
    Company     NVARCHAR(10)  NOT NULL,
    DocNo       NVARCHAR(20)  NOT NULL,     -- Sales Order No_
    [LineNo]    INT           NOT NULL,     -- Sales Line [Line No_]  (LINENO is a reserved T-SQL word)
    LastRemark  NVARCHAR(250) NULL,         -- last-seen [Remarks]
    UpdatedAt   DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT PK_BN_NotifSoState PRIMARY KEY (Company, DocNo, [LineNo])
  );
END
GO
