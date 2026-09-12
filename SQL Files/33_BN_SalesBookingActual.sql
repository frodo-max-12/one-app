-- =====================================================================
-- 33_BN_SalesBookingActual.sql
-- Manual Booking ACTUAL — the line-level orders MIS (Rajashree) uploads
-- daily/weekly from the "<Co> Booking Billing Consolidated" Excel.
--
-- WHY: NAV SO-backlog booking includes schedule orders → not a correct
-- "booking" figure. So Booking ACTUAL on the Budget vs Actual page now comes
-- from this uploaded sheet instead of BN_SalesBookingLedger. Booking BUDGET
-- (annual, BN_SalesBudget.BookingAnnual) is UNCHANGED. Billing/AR/Inventory/
-- Visit are all UNCHANGED. One sheet per company (COMPANYA ₹ / CompanyB $).
--
-- App DB (BizNAV_App) — writable. Idempotent. NO NAV database is touched.
-- Follows 30_BN_SalesBookingLedger.sql / 32_MIS_users.sql.
-- =====================================================================

IF OBJECT_ID('dbo.BN_SalesBookingActual', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.BN_SalesBookingActual (
        Id              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_BN_SalesBookingActual PRIMARY KEY,
        Company         NVARCHAR(10)  NOT NULL,      -- 'COMPANYA' / 'COMPANYB'
        BookingDate     DATE          NOT NULL,      -- from the sheet's Date column (day-snapped)
        WeekLabel       NVARCHAR(20)  NULL,          -- 'Week 27' (informational)
        CustomerName    NVARCHAR(200) NULL,          -- Company Name
        PartNo          NVARCHAR(150) NULL,
        Make            NVARCHAR(100) NULL,
        Qty             DECIMAL(18,4) NULL,
        Rate            DECIMAL(18,6) NULL,
        Amount          DECIMAL(18,4) NOT NULL,      -- booking value, RAW company currency
        IsrName         NVARCHAR(150) NULL,          -- raw "ISR NAME" from the sheet
        SalespersonCode NVARCHAR(20)  NULL,          -- resolved from IsrName (NULL if unmatched)
        PoNumber        NVARCHAR(120) NULL,
        Vertical        NVARCHAR(60)  NULL,
        SourceFile      NVARCHAR(260) NULL,
        UploadedBy      NVARCHAR(150) NULL,
        UploadedAt      DATETIME2     NOT NULL CONSTRAINT DF_BN_SalesBookingActual_UploadedAt DEFAULT (SYSUTCDATETIME())
    );
    -- Period aggregation (Company + date range) and per-salesperson roll-up.
    CREATE INDEX IX_BN_SalesBookingActual_Co_Date ON dbo.BN_SalesBookingActual (Company, BookingDate);
    CREATE INDEX IX_BN_SalesBookingActual_Co_Sp   ON dbo.BN_SalesBookingActual (Company, SalespersonCode, BookingDate);
END
GO
