-- ============================================================
-- Run on: BizNAV_App database
-- ============================================================
USE BizNAV_App;
GO

IF OBJECT_ID('[dbo].[BN_VisitPlan]', 'U') IS NOT NULL
    DROP TABLE [dbo].[BN_VisitPlan];
GO

CREATE TABLE [dbo].[BN_VisitPlan] (
    Id               INT            IDENTITY(1,1) PRIMARY KEY,
    Company          NVARCHAR(10)   NOT NULL,            -- 'COMPANYA' or 'CompanyB'
    Week             NVARCHAR(20)   NULL,                -- e.g. 'Week 1', 'Week 2'
    FSR              NVARCHAR(100)  NULL,                -- Field Sales Rep name
    FAE              NVARCHAR(100)  NULL,                -- Field Application Engineer name
    SalespersonCode  NVARCHAR(50)   NOT NULL,            -- links to JWT companyaCode/companybCode
    SalespersonName  NVARCHAR(100)  NULL,
    VisitDate        DATE           NOT NULL,
    CustomerName     NVARCHAR(200)  NOT NULL,
    Application      NVARCHAR(200)  NULL,                -- e.g. IoT, Automotive, Industrial
    CustomerType     NVARCHAR(50)   NULL,                -- e.g. OEM, EMS, Distributor
    VisitAgenda      NVARCHAR(500)  NULL,
    Location         NVARCHAR(200)  NULL,
    ContactPerson    NVARCHAR(150)  NULL,
    ContactDetails   NVARCHAR(150)  NULL,                -- phone / email
    VisitDone        BIT            NOT NULL DEFAULT 0,  -- 0 = Pending, 1 = Visited
    MOM              NVARCHAR(MAX)  NULL,                -- Minutes of Meeting (filled after visit)
    CreatedAt        DATETIME       NOT NULL DEFAULT GETDATE(),
    UpdatedAt        DATETIME       NULL
);
GO

-- Index for fast filtering by salesperson + company
CREATE INDEX IX_VisitPlan_SP_Company
    ON [dbo].[BN_VisitPlan] (SalespersonCode, Company, VisitDate);
GO

PRINT 'BN_VisitPlan table created successfully.';

-- Verify
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'BN_VisitPlan'
ORDER BY ORDINAL_POSITION;
GO