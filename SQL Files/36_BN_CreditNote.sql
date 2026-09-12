-- ============================================================================
-- ONE App — Credit Notes (CN) "Yet to Approve" (imported from Excel)
-- File:  SQL Files/36_BN_CreditNote.sql
-- Date:  2026-08-11
--
-- Tracks credit notes the electrical team has GIVEN to customers (Cash Discount
-- / FOC) that are NOT yet posted in NAV. They net down the customer's Remaining
-- Outstanding in the Customer Detail modal until Accounts posts the real credit
-- memo in NAV (at which point the row is manually deleted). "Approved CN" (already
-- posted) comes from NAV Cust. Ledger Entry Document Type = 3 (Credit Memo) — this
-- table only holds the "Yet to Approve" ones.
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS guarded. ADDITIVE.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[BN_CreditNote]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BN_CreditNote] (
        CnId           INT             IDENTITY(1,1) PRIMARY KEY,
        Company        NVARCHAR(10)    NULL,           -- COMPANYA / COMPANYB
        CustomerCode   NVARCHAR(50)    NULL,           -- NAV [No_] (NULL if name unmatched)
        CustomerName   NVARCHAR(200)   NOT NULL,       -- as imported from Excel
        BillNo         NVARCHAR(100)   NULL,           -- invoice this CN is against
        BillDate       DATE            NULL,
        Amount         DECIMAL(18, 2)  NOT NULL DEFAULT 0,
        CnType         NVARCHAR(10)    NULL,           -- 'CD' (Cash Discount) | 'FOC' (Free of Cost)
        Reason         NVARCHAR(500)   NULL,           -- free-text reason from Excel
        Status         NVARCHAR(20)    NOT NULL DEFAULT 'yet_to_approve',
        IsActive       BIT             NOT NULL DEFAULT 1,

        CreatedBy      INT             NULL,
        CreatedAt      DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedBy      INT             NULL,
        UpdatedAt      DATETIME2(0)    NULL,

        INDEX IX_BN_CreditNote_Customer (Company, CustomerCode, IsActive),
        INDEX IX_BN_CreditNote_Name     (CustomerName)
    );
    PRINT '[OK] dbo.BN_CreditNote created.';
END
ELSE PRINT '[SKIP] dbo.BN_CreditNote already exists.';
GO
