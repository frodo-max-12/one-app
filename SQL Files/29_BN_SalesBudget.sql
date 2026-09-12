-- 29_BN_SalesBudget.sql — Sales Budget vs Actual module (v1.11)
-- App DB (BizNAV_App). Stores the MANUAL annual sales budget/target per salesperson,
-- per company, per fiscal year. Actuals (Booking/Billing) are computed live from NAV.
-- Amounts are in the company's local currency (COMPANYA = INR, COMPANYB = USD), stored RAW.
-- Idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'BN_SalesBudget')
BEGIN
    CREATE TABLE dbo.BN_SalesBudget (
        BudgetId         INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        Company          NVARCHAR(10)  NOT NULL,           -- 'COMPANYA' | 'COMPANYB'
        FiscalYear       INT           NOT NULL,           -- start year: 2026 = Apr-2026 .. Mar-2027
        SalespersonCode  NVARCHAR(20)  NOT NULL,           -- NAV Salesperson Code
        SalespersonName  NVARCHAR(100) NULL,               -- denormalized for display
        BookingAnnual    DECIMAL(18,2) NOT NULL CONSTRAINT DF_BN_SalesBudget_Booking DEFAULT (0),
        BillingAnnual    DECIMAL(18,2) NOT NULL CONSTRAINT DF_BN_SalesBudget_Billing DEFAULT (0),
        ARAnnual         DECIMAL(18,2) NOT NULL CONSTRAINT DF_BN_SalesBudget_AR      DEFAULT (0),  -- annual collection target
        InventoryAnnual  DECIMAL(18,2) NOT NULL CONSTRAINT DF_BN_SalesBudget_Inv    DEFAULT (0),  -- annual Ex-Stock inventory target
        VisitTargetAnnual DECIMAL(18,2) NOT NULL CONSTRAINT DF_BN_SalesBudget_Visit DEFAULT (0),  -- annual visit-COUNT target (COMPANYA only)
        CreatedBy        INT           NULL,
        CreatedAt        DATETIME2     NOT NULL CONSTRAINT DF_BN_SalesBudget_CreatedAt DEFAULT (SYSDATETIME()),
        UpdatedBy        INT           NULL,
        UpdatedAt        DATETIME2     NOT NULL CONSTRAINT DF_BN_SalesBudget_UpdatedAt DEFAULT (SYSDATETIME()),
        CONSTRAINT UQ_BN_SalesBudget UNIQUE (Company, FiscalYear, SalespersonCode)
    );
    PRINT 'Created dbo.BN_SalesBudget';
END
ELSE
    PRINT 'dbo.BN_SalesBudget already exists — no change';
GO

-- AR annual collection target (added 2026-07-15, Phase 2). Idempotent.
IF COL_LENGTH('dbo.BN_SalesBudget', 'ARAnnual') IS NULL
BEGIN
    ALTER TABLE dbo.BN_SalesBudget ADD ARAnnual DECIMAL(18,2) NOT NULL CONSTRAINT DF_BN_SalesBudget_AR DEFAULT (0);
    PRINT 'Added ARAnnual column';
END
ELSE
    PRINT 'ARAnnual already present';
GO

-- Inventory + Visit targets (added 2026-07-16, Phase 4). Idempotent.
IF COL_LENGTH('dbo.BN_SalesBudget', 'InventoryAnnual') IS NULL
    ALTER TABLE dbo.BN_SalesBudget ADD InventoryAnnual DECIMAL(18,2) NOT NULL CONSTRAINT DF_BN_SalesBudget_Inv DEFAULT (0);
GO
IF COL_LENGTH('dbo.BN_SalesBudget', 'VisitTargetAnnual') IS NULL
    ALTER TABLE dbo.BN_SalesBudget ADD VisitTargetAnnual DECIMAL(18,2) NOT NULL CONSTRAINT DF_BN_SalesBudget_Visit DEFAULT (0);
GO
