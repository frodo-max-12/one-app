-- ============================================================================
-- ONE App v1.8 — Warehouse module (Company B, Singapore)
-- File:  SQL Files/13_BN_Warehouse_Tables.sql
-- Date:  2026-06-05
--
-- WHY:
--   Replaces the Singapore warehouse person's manual Excel spreadsheet
--   ('2026-27 Report on 04-Jun-26.xlsx', 5 sheets, ~5,900 rows). The Excel
--   tracks 5 categories: Purchase (open POs + manual import-tracking),
--   Stocks (carton-level inventory), Sales (posted sales + dispatch detail),
--   Cheques (issued-cheque ledger), Expenses (petty expenses).
--
--   Each table holds ONLY the MANUAL fields. NAV-fetched fields (Item Name,
--   Qty, Rate, Supplier Name, Customer Name, etc.) are joined LIVE at query
--   time against `[Company B Pte Ltd_$Purchase Line]`, `[...$Sales
--   Invoice Line]`, etc. — so the warehouse view always reflects the
--   current NAV state and we never have stale snapshots in BizNAV_App.
--
-- AUTH MODEL:
--   New role 'warehouse' — one Singapore user (singapore@company-b.example).
--   Admin / Director / Operation Head get READ-ONLY access for oversight.
--   Backend endpoints enforce: writes only by role='warehouse'; reads by
--   role='warehouse' OR isFullAccess (admin/director/op-head).
--
-- SAFETY:
--   - BizNAV_App only. NAV DB (NAV_Live) is touched READ-only by
--     the live queries (separate pool, NOLOCK auto-applied).
--   - All tables IF NOT EXISTS guarded — re-running is a no-op.
--   - Additive ONLY; no existing rows to lose.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

-- ────────────────────────────────────────────────────────────────────────────
-- BN_WhPurchase
-- One row per NAV Purchase Line. Manual fields keyed by (Company, PoNo, LineNo).
-- At query time JOINed to [...$Purchase Line] for Item/Qty/Rate/Currency,
-- [...$Purchase Header] for Supplier No, [...$Vendor] for Supplier Name +
-- Payment Terms.
-- ────────────────────────────────────────────────────────────────────────────
IF OBJECT_ID('[dbo].[BN_WhPurchase]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BN_WhPurchase] (
        Id                  INT             IDENTITY(1,1) PRIMARY KEY,
        Company             NVARCHAR(10)    NOT NULL DEFAULT 'COMPANYB',

        -- NAV linkage — joined to [...$Purchase Line] (DocType=1 Order)
        PoNo                NVARCHAR(50)    NULL,    -- col G "CompanyB Po No"
        -- NAV Purchase Line.[Line No_] — column renamed from "LineNo" (reserved
        -- T-SQL keyword LINENO conflicts with bare column name) per
        -- [[companya-app]] memory + first run on 2026-06-05.
        LineNumber          INT             NULL,

        -- Manual + identification (Excel cols A-E, H)
        MatlReceivedDate    DATE            NULL,    -- col A
        SystemNo            NVARCHAR(50)    NULL,    -- col B (auto-gen WH-PUR-YYYYMM-####)
        PurchaseType        NVARCHAR(20)    NULL,    -- col C 'Purchase'/'Expenses'
        InvoiceDate         DATE            NULL,    -- col D
        InvoiceNo           NVARCHAR(50)    NULL,    -- col E
        PoReceived          BIT             NULL,    -- col H flag

        -- Money fields (computed on READ from NAV qty*rate — these store the
        -- AS-PER-INVOICE override if accounts entered a different value).
        InvoiceValue        DECIMAL(18, 2)  NULL,    -- col O "As per Invoice Item wise Value"
        BankOtherCharges    DECIMAL(18, 2)  NULL DEFAULT 0,  -- col P

        -- Shipping (Excel cols T-X)
        Dimension           NVARCHAR(50)    NULL,    -- col T
        WeightKg            DECIMAL(10, 3)  NULL,    -- col U
        COO                 NVARCHAR(100)   NULL,    -- col V country of origin
        ReceivedThrough     NVARCHAR(50)    NULL,    -- col W FedEx / DHL / etc.
        AirWaybillNo        NVARCHAR(50)    NULL,    -- col X

        -- Status (Excel cols [, \)
        Status              NVARCHAR(20)    NULL,    -- col [  Paid/Pending/etc.
        PaidDate            DATE            NULL,    -- col \

        -- Freight / GST detail (Excel cols ]-a)
        FreightSGD          DECIMAL(18, 2)  NULL,    -- col ]
        GSTFreightStatus    NVARCHAR(20)    NULL,    -- col _
        FreightSGDPerKg     DECIMAL(18, 4)  NULL,    -- col `
        TotalFFCharges      DECIMAL(18, 2)  NULL,    -- col a
        InvoiceNoFFCourier  NVARCHAR(50)    NULL,    -- col b

        -- Local charges + permit (Excel cols c-f)
        LocalCharges        DECIMAL(18, 2)  NULL,    -- col c
        PermitNo            NVARCHAR(50)    NULL,    -- col d
        ImportPermitType    NVARCHAR(30)    NULL,    -- col e Import/Local/Exempt
        GSTClaimedMonth     NVARCHAR(20)    NULL,    -- col f

        Remark              NVARCHAR(500)   NULL,
        IsActive            BIT             NOT NULL DEFAULT 1,

        CreatedBy           INT             NULL,
        CreatedAt           DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt           DATETIME2(0)    NULL,

        -- Lookup indexes
        INDEX IX_WhPurchase_Po          (Company, PoNo, LineNumber),
        INDEX IX_WhPurchase_Invoice     (Company, InvoiceNo),
        INDEX IX_WhPurchase_MatlDate    (Company, MatlReceivedDate DESC),
        INDEX IX_WhPurchase_Status      (Company, Status)
    );
    PRINT '[OK] dbo.BN_WhPurchase created.';
END
ELSE PRINT '[SKIP] dbo.BN_WhPurchase already exists.';
GO

-- ────────────────────────────────────────────────────────────────────────────
-- BN_WhStock
-- Carton-level inventory ledger. Each row = one carton placement. Links back
-- to BN_WhPurchase.InvoiceNo (the originating purchase) so we can show MPN /
-- Make / Origin from the purchase line at query time.
-- ────────────────────────────────────────────────────────────────────────────
IF OBJECT_ID('[dbo].[BN_WhStock]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BN_WhStock] (
        Id                  INT             IDENTITY(1,1) PRIMARY KEY,
        Company             NVARCHAR(10)    NOT NULL DEFAULT 'COMPANYB',

        SN                  INT             NULL,                -- col A serial
        CartonNo            NVARCHAR(50)    NULL,                -- col B
        InvoiceNo           NVARCHAR(50)    NULL,                -- col C links to BN_WhPurchase.InvoiceNo

        -- Location (cols D, E)
        NewLocation         NVARCHAR(50)    NULL,
        Location            NVARCHAR(50)    NULL,

        -- Item-snapshot fields (cols F-K — initially copied from purchase but
        -- editable so warehouse can correct typos / use overrides).
        MPN                 NVARCHAR(100)   NULL,
        Make                NVARCHAR(100)   NULL,
        QtyPcs              INT             NULL,
        Dimension           NVARCHAR(50)    NULL,
        WeightKg            DECIMAL(10, 3)  NULL,
        Origin              NVARCHAR(100)   NULL,

        DateCode            NVARCHAR(50)    NULL,                -- col L
        InwordDate          DATE            NULL,                -- col M

        -- Price snapshot (cols O, P, Q, R)
        PurchasePrice       DECIMAL(18, 4)  NULL,
        PurchaseAmount      DECIMAL(18, 2)  NULL,                -- col P = H*O (stored, lets accounts override)
        CustResale          DECIMAL(18, 4)  NULL,
        CustResaleAmount    DECIMAL(18, 2)  NULL,

        CustomerName        NVARCHAR(200)   NULL,                -- col S
        FranchiseType       NVARCHAR(10)    NULL,                -- col T 'F'/'NF'

        Status              NVARCHAR(20)    NULL,                -- col U Stock/Dispatched/Reserved
        DispatchedDate      DATE            NULL,                -- col V

        Remark              NVARCHAR(500)   NULL,                -- col W
        Package             NVARCHAR(50)    NULL,                -- col X
        ItemType            NVARCHAR(50)    NULL,                -- col Z
        Legend              NVARCHAR(50)    NULL,                -- col [
        Meaning             NVARCHAR(100)   NULL,                -- col \

        IsActive            BIT             NOT NULL DEFAULT 1,
        CreatedBy           INT             NULL,
        CreatedAt           DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt           DATETIME2(0)    NULL,

        INDEX IX_WhStock_InvoiceNo  (Company, InvoiceNo),
        INDEX IX_WhStock_MPN        (Company, MPN),
        INDEX IX_WhStock_Status     (Company, Status, IsActive),
        INDEX IX_WhStock_Location   (Company, Location)
    );
    PRINT '[OK] dbo.BN_WhStock created.';
END
ELSE PRINT '[SKIP] dbo.BN_WhStock already exists.';
GO

-- ────────────────────────────────────────────────────────────────────────────
-- BN_WhSales
-- Manual fields per Sales Invoice line. NAV-fetched A-M (Date/InvNo/Customer/
-- PO/Item/Qty/Rate/Value/GST/Total) joined live from [...$Sales Invoice Line]
-- + [...$Sales Invoice Header] + [...$Customer].
-- ────────────────────────────────────────────────────────────────────────────
IF OBJECT_ID('[dbo].[BN_WhSales]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BN_WhSales] (
        Id                  INT             IDENTITY(1,1) PRIMARY KEY,
        Company             NVARCHAR(10)    NOT NULL DEFAULT 'COMPANYB',

        -- NAV linkage
        InvoiceNo           NVARCHAR(50)    NOT NULL,           -- NAV Sales Invoice Header.[No_]
        LineNumber          INT             NOT NULL,           -- NAV Sales Invoice Line.[Line No_] (renamed from LineNo — reserved T-SQL keyword)

        -- Cartons / dispatch (cols N-V)
        Cartons             INT             NULL,                -- col N
        DispatchThrough     NVARCHAR(50)    NULL,                -- col Q
        AirWaybillNo        NVARCHAR(50)    NULL,                -- col R
        ShipmentTerms       NVARCHAR(50)    NULL,                -- col S
        FreightCharges      DECIMAL(18, 2)  NULL,                -- col T
        LocalCharges        DECIMAL(18, 2)  NULL,                -- col U
        DispatchDate        DATE            NULL,                -- col V

        -- Status / paperwork (cols X-\)
        Status              NVARCHAR(20)    NULL,                -- col X
        FrightInvoice       NVARCHAR(100)   NULL,                -- col Y
        PermitNo            NVARCHAR(50)    NULL,                -- col Z
        ExportPermitType    NVARCHAR(30)    NULL,                -- col [ Export/Local/Exempt
        GSTClaimedMonth     NVARCHAR(20)    NULL,                -- col \

        Remark              NVARCHAR(500)   NULL,
        IsActive            BIT             NOT NULL DEFAULT 1,

        CreatedBy           INT             NULL,
        CreatedAt           DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt           DATETIME2(0)    NULL,

        INDEX UX_WhSales_Invoice_Line UNIQUE (Company, InvoiceNo, LineNumber),
        INDEX IX_WhSales_DispatchDate (Company, DispatchDate DESC),
        INDEX IX_WhSales_Status       (Company, Status)
    );
    PRINT '[OK] dbo.BN_WhSales created.';
END
ELSE PRINT '[SKIP] dbo.BN_WhSales already exists.';
GO

-- ────────────────────────────────────────────────────────────────────────────
-- BN_WhCheque — pure-manual cheque-issue ledger.
-- ────────────────────────────────────────────────────────────────────────────
IF OBJECT_ID('[dbo].[BN_WhCheque]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BN_WhCheque] (
        Id                  INT             IDENTITY(1,1) PRIMARY KEY,
        Company             NVARCHAR(10)    NOT NULL DEFAULT 'COMPANYB',

        SrNo                INT             NULL,                -- col A
        BlankOrIssued       NVARCHAR(10)    NULL,                -- col B 'Blank'/'Issued'
        IssueDate           DATE            NULL,                -- col C
        BankName            NVARCHAR(50)    NULL,                -- col D Bank B/UOB/DBS
        ChequeNo            NVARCHAR(50)    NULL,                -- col E
        ChequeDate          DATE            NULL,                -- col F
        IssueTo             NVARCHAR(200)   NULL,                -- col G payee
        Currency            NVARCHAR(10)    NULL DEFAULT 'SGD',  -- col H
        Amount              DECIMAL(18, 2)  NULL,                -- col I
        Remark              NVARCHAR(500)   NULL,                -- col J
        ClearingDate        DATE            NULL,                -- col K
        ReceivedDate        DATE            NULL,                -- col L (when cheque returned/received)

        IsActive            BIT             NOT NULL DEFAULT 1,
        CreatedBy           INT             NULL,
        CreatedAt           DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt           DATETIME2(0)    NULL,

        INDEX IX_WhCheque_ChequeNo    (Company, ChequeNo),
        INDEX IX_WhCheque_Status      (Company, BlankOrIssued, IsActive),
        INDEX IX_WhCheque_IssueDate   (Company, IssueDate DESC),
        INDEX IX_WhCheque_Payee       (Company, IssueTo)
    );
    PRINT '[OK] dbo.BN_WhCheque created.';
END
ELSE PRINT '[SKIP] dbo.BN_WhCheque already exists.';
GO

-- ────────────────────────────────────────────────────────────────────────────
-- BN_WhExpense — pure-manual petty expense ledger.
-- ────────────────────────────────────────────────────────────────────────────
IF OBJECT_ID('[dbo].[BN_WhExpense]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BN_WhExpense] (
        Id                  INT             IDENTITY(1,1) PRIMARY KEY,
        Company             NVARCHAR(10)    NOT NULL DEFAULT 'COMPANYB',

        ExpenseDate         DATE            NULL,                -- col A
        Explanation         NVARCHAR(500)   NULL,                -- col B
        Amount              DECIMAL(18, 2)  NULL,                -- col C
        Currency            NVARCHAR(10)    NULL DEFAULT 'SGD',
        Remark              NVARCHAR(500)   NULL,                -- col D

        IsActive            BIT             NOT NULL DEFAULT 1,
        CreatedBy           INT             NULL,
        CreatedAt           DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt           DATETIME2(0)    NULL,

        INDEX IX_WhExpense_Date   (Company, ExpenseDate DESC),
        INDEX IX_WhExpense_Active (Company, IsActive)
    );
    PRINT '[OK] dbo.BN_WhExpense created.';
END
ELSE PRINT '[SKIP] dbo.BN_WhExpense already exists.';
GO
