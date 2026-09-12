-- ============================================================================
-- ONE App — BN_DCFile : Product team's DC (Design-Conversion) tracker
-- File:  SQL Files/25_BN_DCFile.sql        Date: 2026-06-27
--
-- Replaces the Product team's Excel "CRM Funnel stage DC file" (DC file sheet).
-- App-owned data in BizNAV_App (NAV stays strictly read-only). One row per
-- (inquiry OP + suggested/authorized part) line the Product team is tracking.
-- Columns mirror the Excel 1:1 + audit. Authorized-line inquiries only
-- (Authorized = Product; Sourcing = Purchase, tracked elsewhere).
--
-- SAFETY: BizNAV_App only. Idempotent (IF NOT EXISTS). Additive. No data loss.
-- ============================================================================

USE BizNAV_App;
GO

IF OBJECT_ID('[dbo].[BN_DCFile]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[BN_DCFile] (
        DcId                INT            IDENTITY(1,1) PRIMARY KEY,
        Company             NVARCHAR(10)   NULL,           -- 'COMPANYA' | 'COMPANYB'
        OpNo                NVARCHAR(30)   NULL,           -- NAV Opportunity No_ (OP-####), links to the inquiry
        DcDate              DATE           NULL,           -- inquiry / entry date
        CustomerName        NVARCHAR(200)  NULL,
        Vertical            NVARCHAR(60)   NULL,
        CustomerCategory    NVARCHAR(60)   NULL,           -- OEM / EMS / Distributor …
        Region              NVARCHAR(40)   NULL,
        SalesPerson         NVARCHAR(100)  NULL,           -- name as the Product team records it
        FaePerson           NVARCHAR(100)  NULL,
        Segment             NVARCHAR(100)  NULL,
        Project             NVARCHAR(200)  NULL,
        ExistingMpn         NVARCHAR(100)  NULL,           -- customer's current part
        ExistingMake        NVARCHAR(100)  NULL,
        SuggestedMpn        NVARCHAR(100)  NULL,           -- our authorized-line alternate
        SuggestedMake       NVARCHAR(100)  NULL,
        ProjectStatus       NVARCHAR(100)  NULL,           -- DIN / NBO / Win / Lost / … (funnel)
        SampleQty           DECIMAL(18,2)  NULL,
        SamplesStage        NVARCHAR(120)  NULL,           -- Samples Submitted / PCB Under Testing / …
        StatusMonth         DATE           NULL,
        EauQty              DECIMAL(18,2)  NULL,           -- Estimated Annual Usage
        Qps                 DECIMAL(18,2)  NULL,           -- Qty per System
        UnitPriceUsd        DECIMAL(18,4)  NULL,
        Currency            NVARCHAR(20)   NULL,
        Potential           DECIMAL(18,2)  NULL,           -- potential annual value
        PpDateFae           DATE           NULL,           -- pilot-production date (FAE)
        MpDateSales         DATE           NULL,           -- mass-production date (Sales)
        ProductTeamRemarks  NVARCHAR(MAX)  NULL,
        CurrentStatus       NVARCHAR(MAX)  NULL,           -- Current status - FAE/Sales
        ActionItem          NVARCHAR(MAX)  NULL,           -- Action Item - Sales/FAE/PM
        Remarks             NVARCHAR(MAX)  NULL,
        IsActive            BIT            NOT NULL DEFAULT 1,
        CreatedBy           INT            NULL,
        CreatedAt           DATETIME       NOT NULL DEFAULT SYSDATETIME(),
        UpdatedBy           INT            NULL,
        UpdatedAt           DATETIME       NULL
    );

    CREATE INDEX IX_BN_DCFile_Company_Active ON [dbo].[BN_DCFile](Company, IsActive);
    CREATE INDEX IX_BN_DCFile_OpNo           ON [dbo].[BN_DCFile](OpNo);

    PRINT '[OK] BN_DCFile created.';
END
ELSE
    PRINT '[skip] BN_DCFile already exists.';
GO
