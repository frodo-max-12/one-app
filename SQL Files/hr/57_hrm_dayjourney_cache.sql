-- ============================================================================
-- ONE App Lens — Day Journey snap cache
-- File:  SQL Files/hr/57_hrm_dayjourney_cache.sql
-- Date:  2026-05-28
--
-- Persists the Google Roads API "snap to roads" result for a given employee-day
-- so we call the (paid) Roads API at most ONCE per employee per day — even
-- across pm2 restarts. The in-memory cache alone reset on every deploy and
-- would re-bill; this table caps the cost near the free tier.
--
-- One row per (UserId, JourneyDate). PingCount lets us detect when more pings
-- have arrived (today's live trail) and re-snap; past days have a stable count
-- and always hit the cache.
--
-- SAFETY: BizNAV_App only. IF NOT EXISTS guarded. Additive.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_DayJourneyCache]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_DayJourneyCache] (
        CacheId      INT            IDENTITY(1,1) PRIMARY KEY,
        UserId       INT            NOT NULL,
        JourneyDate  DATE           NOT NULL,
        PingCount    INT            NOT NULL,           -- # raw pings the snap was built from
        PointCount   INT            NOT NULL,           -- # points in the snapped path
        Snapped      BIT            NOT NULL DEFAULT 1, -- 0 = stored a filtered-raw fallback (no road snap)
        SnappedJson  NVARCHAR(MAX)  NOT NULL,           -- JSON: [[lat,lng],[lat,lng],...]
        BuiltAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),

        CONSTRAINT UK_HRM_DJCache_User_Date UNIQUE (UserId, JourneyDate)
    );
    PRINT '[OK] dbo.HRM_DayJourneyCache created.';
END
ELSE PRINT '[SKIP] dbo.HRM_DayJourneyCache already exists.';
GO
