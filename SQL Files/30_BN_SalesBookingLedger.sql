-- =====================================================================
-- 30_BN_SalesBookingLedger.sql  (App DB: BizNAV_App — WRITABLE)
-- Booking "freeze" ledger for Budget vs Actual (v1.11).
--
-- WHY: NAV deletes a Sales Order once it is fully shipped + invoiced, so a
-- live query of [Sales Header] under-reports booking for any past period
-- (completed orders have vanished). This ledger captures every OPEN sales-
-- order line a few times a day and NEVER deletes a row — so once an order is
-- seen, its booked value is preserved forever, keyed by Order Date. Booking
-- for any week/month/quarter/year = SUM(LineValue) over that Order-Date range.
--
-- One row per (Company, OrderNo, LineNo). Populated by the cron in
-- modules/sales/bookingLedger.js (OPENJSON MERGE). Read-only w.r.t. NAV.
-- Idempotent: safe to re-run.
-- =====================================================================

IF OBJECT_ID('dbo.BN_SalesBookingLedger', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.BN_SalesBookingLedger (
    Company          NVARCHAR(10)   NOT NULL,   -- 'COMPANYA' | 'COMPANYB'
    OrderNo          NVARCHAR(20)   NOT NULL,   -- Sales Header [No_]
    LineNum          INT            NOT NULL,   -- Sales Line [Line No_]  (LineNo is a reserved word)
    OrderDate        DATE           NOT NULL,   -- Sales Header [Order Date]
    SalespersonCode  NVARCHAR(20)   NULL,       -- Sales Header [Salesperson Code]
    CustomerName     NVARCHAR(150)  NULL,       -- Sales Header [Sell-to Customer Name]
    LineValue        DECIMAL(18, 4) NOT NULL CONSTRAINT DF_BNSBL_val   DEFAULT (0),  -- Qty x Unit Price (full ordered value)
    FirstSeen        DATETIME2(0)   NOT NULL CONSTRAINT DF_BNSBL_first DEFAULT SYSDATETIME(),
    LastSeen         DATETIME2(0)   NOT NULL CONSTRAINT DF_BNSBL_last  DEFAULT SYSDATETIME(),
    CONSTRAINT PK_BN_SalesBookingLedger PRIMARY KEY (Company, OrderNo, LineNum)
  );
  PRINT 'Created dbo.BN_SalesBookingLedger';
END
ELSE
  PRINT 'dbo.BN_SalesBookingLedger already exists — skipped';
GO

-- Scope/range read index: booking(period) filters Company + Salesperson over an Order-Date range.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BNSBL_scope' AND object_id = OBJECT_ID('dbo.BN_SalesBookingLedger'))
  CREATE INDEX IX_BNSBL_scope ON dbo.BN_SalesBookingLedger (Company, SalespersonCode, OrderDate) INCLUDE (LineValue);
GO
