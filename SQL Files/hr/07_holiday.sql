-- ============================================================================
-- ONE App Lens — Phase 1 — Table 7 (Holiday master)
-- File:  SQL Files/hr/07_holiday.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent. Zero existing data.
--   * SET XACT_ABORT ON — auto-rollback on error.
--
-- WHAT IT CREATES:
--   dbo.HRM_Holiday — General + Restricted holiday master.
--   Mirrors the GreytHR Holiday List screen (Date / Day / Occasion / Type).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Holiday]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Holiday] (
        HolidayId      INT            IDENTITY(1,1) PRIMARY KEY,
        HolidayDate    DATE           NOT NULL,
        Occasion       NVARCHAR(150)  NOT NULL,
        HolidayType    NVARCHAR(20)   NOT NULL DEFAULT 'General',  -- 'General' | 'Restricted'
        Location       NVARCHAR(100)  NULL,                         -- NULL = all locations
        Company        NVARCHAR(10)   NULL,                         -- NULL = both COMPANYA and CompanyB
        Notes          NVARCHAR(500)  NULL,
        IsActive       BIT            NOT NULL DEFAULT 1,
        CreatedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)   NULL,

        CONSTRAINT UK_HRM_Hol_Date_Occasion UNIQUE (HolidayDate, Occasion),
        INDEX IX_HRM_Hol_Date (HolidayDate),
        INDEX IX_HRM_Hol_Type (HolidayType, IsActive)
    );

    PRINT '[OK] dbo.HRM_Holiday created.';

    -- Seed FY 2026 holidays (Maharashtra-default, matches GreytHR Holiday Calendar SC)
    INSERT INTO [dbo].[HRM_Holiday] (HolidayDate, Occasion, HolidayType) VALUES
    ('2026-01-26','Republic Day','General'),
    ('2026-03-03','Dhoolivandan','General'),
    ('2026-03-19','Gudi Padwa','General'),
    ('2026-05-01','Labour Day / Maharashtra Day','General'),
    ('2026-08-15','Independence Day','General'),
    ('2026-09-14','a colleague Chaturthi','General'),
    ('2026-09-25','a colleague Visarjan','General'),
    ('2026-10-20','Dusshera','General'),
    ('2026-11-09','Diwali Holiday','General'),
    ('2026-11-10','Diwali Padwa','General'),
    ('2026-11-11','Bhaubij','General');

    PRINT '[OK] HRM_Holiday seeded with 11 FY2026 holidays.';
END
ELSE
BEGIN
    PRINT '[SKIP] dbo.HRM_Holiday already exists.';
END
GO

SELECT HolidayDate, Occasion, HolidayType
FROM [dbo].[HRM_Holiday]
ORDER BY HolidayDate;
GO
