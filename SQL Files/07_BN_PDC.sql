-- ============================================================================
-- ONE App — PDC (Post-Dated Cheques received from customers)
-- File:  SQL Files/07_BN_PDC.sql
-- Date:  2026-05-26
--
-- New table to track post-dated cheques the company has received from
-- customers. Replaces the Excel sheet (CHEQUES IN.xlsx).
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS guarded. ADDITIVE.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[BN_PDC]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BN_PDC] (
        PDCId          INT             IDENTITY(1,1) PRIMARY KEY,
        Company        NVARCHAR(10)    NULL,           -- COMPANYA / CompanyB
        CustomerCode   NVARCHAR(50)    NULL,           -- NAV [No_] (NULL if unmatched)
        CustomerName   NVARCHAR(200)   NOT NULL,       -- as imported
        ChequeNo       NVARCHAR(50)    NULL,
        ChequeDate     DATE            NULL,           -- post-dated cheque date
        ReceivedDate   DATE            NULL,           -- when we received it
        Amount         DECIMAL(18, 2)  NOT NULL DEFAULT 0,
        BankName       NVARCHAR(100)   NULL,
        Vertical       NVARCHAR(50)    NULL,           -- RETAILER / etc.
        BillNo         NVARCHAR(50)    NULL,           -- NAV Document No (invoice this pays for)
        Remark         NVARCHAR(500)   NULL,
        Status         NVARCHAR(20)    NOT NULL DEFAULT 'pending',  -- pending|deposited|cleared|bounced|cancelled
        ClearedDate    DATE            NULL,
        IsActive       BIT             NOT NULL DEFAULT 1,

        CreatedBy      INT             NULL,
        CreatedAt      DATETIME2(0)    NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)    NULL,

        INDEX IX_BN_PDC_Customer  (CustomerCode, Status, ChequeDate),
        INDEX IX_BN_PDC_Status    (Status, ChequeDate),
        INDEX IX_BN_PDC_BillNo    (BillNo),
        INDEX IX_BN_PDC_Company   (Company, IsActive)
    );
    PRINT '[OK] dbo.BN_PDC created.';
END
ELSE PRINT '[SKIP] dbo.BN_PDC already exists.';
GO
