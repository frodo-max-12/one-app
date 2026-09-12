

-- ── 1. Create database ───────────────────────────────────────
IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'BizNAV_App')
BEGIN
    CREATE DATABASE BizNAV_App;
    PRINT 'BizNAV_App database created.';
END
ELSE
BEGIN
    PRINT 'BizNAV_App already exists, skipping create.';
END
GO

USE BizNAV_App;
GO

-- ── 2. Drop & recreate User_Login ────────────────────────────
IF OBJECT_ID('[dbo].[User_Login]', 'U') IS NOT NULL
    DROP TABLE [dbo].[User_Login];
GO

CREATE TABLE [dbo].[User_Login] (
    Id          INT            IDENTITY(1,1) PRIMARY KEY,
    Username    NVARCHAR(100)  NOT NULL UNIQUE,
    Password    NVARCHAR(100)  NOT NULL,
    Role        NVARCHAR(20)   NOT NULL,
    Name        NVARCHAR(100)  NULL,
    CompanyACode     NVARCHAR(200)  NULL,
    CompanyBCode  NVARCHAR(200)  NULL,
    Email       NVARCHAR(100)  NULL,
    IsActive    BIT            NOT NULL DEFAULT 1,
    CreatedAt   DATETIME       NOT NULL DEFAULT GETDATE()
);
GO

-- ── 3. Insert all users ──────────────────────────────────────
-- ROLE NOTES:
--   admin          → full access (all data, all salespersons)
--   operation head → full access (same as admin)
--   director       → full access (same as admin)
--   sales head     → sees own + team salesperson codes
--   sales          → sees own salesperson code only

-- Seed users are not included. Insert your own before first run.
