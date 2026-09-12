-- ============================================================================
-- ONE App Lens — Phase 0 — Table 3/5
-- File:  SQL Files/hr/03_geofence.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent.
--   * SET XACT_ABORT ON.
--
-- WHAT IT CREATES:
--   dbo.HRM_Geofence — circular geofences anchored to NAV customers (or any
--   point of interest). Point-in-circle check happens in JS (Haversine) — no
--   PostGIS / spatial index needed.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Geofence]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Geofence] (
        GeofenceId     INT            IDENTITY(1,1) PRIMARY KEY,
        Name           NVARCHAR(200)  NOT NULL,             -- "ABC Industries — Pune Plant"
        Kind           NVARCHAR(20)   NOT NULL DEFAULT 'customer',  -- 'customer' | 'office' | 'warehouse' | 'site'
        CustomerCode   NVARCHAR(50)   NULL,                 -- NAV customer No (loose link, no FK across DBs)
        Company        NVARCHAR(10)   NULL,                 -- 'COMPANYA' | 'CompanyB' | NULL = both

        CenterLat      DECIMAL(9,6)   NOT NULL,
        CenterLng      DECIMAL(9,6)   NOT NULL,
        RadiusM        INT            NOT NULL DEFAULT 100, -- metres (100m default catches building footprint + parking)

        Address        NVARCHAR(500)  NULL,                 -- human-readable
        City           NVARCHAR(100)  NULL,
        State          NVARCHAR(100)  NULL,
        Pincode        NVARCHAR(10)   NULL,

        DwellMinForVisit INT          NOT NULL DEFAULT 10,  -- override the 10-min global threshold per geofence

        IsActive       BIT            NOT NULL DEFAULT 1,
        CreatedBy      INT            NULL,                 -- FK -> User_Login.Id
        CreatedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)   NULL,

        INDEX IX_HRM_Geo_Customer (CustomerCode, Company),
        INDEX IX_HRM_Geo_Active   (IsActive, Kind)
    );

    PRINT '[OK] dbo.HRM_Geofence created.';
END
ELSE
BEGIN
    PRINT '[SKIP] dbo.HRM_Geofence already exists.';
END
GO

SELECT TOP 1 *
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'HRM_Geofence';
GO
