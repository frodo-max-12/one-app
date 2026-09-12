-- ============================================================================
-- ONE App Lens — Phase 0 — Table 1/5
-- File:  SQL Files/hr/01_locationping.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * Runs ONLY on BizNAV_App (writable). Does NOT touch NAV_Live/NAV_UAT.
--   * Idempotent — uses IF NOT EXISTS, so re-running is a no-op.
--   * Pure CREATE — zero existing data to lose.
--   * Auto-rollback on any error (transaction-wrapped at SSMS level via SET XACT_ABORT ON).
--
-- WHAT IT CREATES:
--   dbo.HRM_LocationPing — every GPS ping from the mobile app, one row per ping.
--   The headline table behind every Lens feature (live map, Day Journey,
--   replay slider, geofence visit-confirm, distance reimbursement).
--
-- ROUGH VOLUME (40 staff):
--   ~10,000 rows/day = ~3.6M/year @ ~150 B/row ≈ 540 MB/year. Trivial.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_LocationPing]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_LocationPing] (
        PingId        BIGINT         IDENTITY(1,1) PRIMARY KEY,
        UserId        INT            NOT NULL,            -- FK -> User_Login.Id
        UserCode      NVARCHAR(50)   NULL,                -- denormalised CompanyACode/CompanyBCode for fast filtering
        Company       NVARCHAR(10)   NULL,                -- 'COMPANYA' or 'CompanyB' (denormalised at ping time)

        PingTime      DATETIME2(3)   NOT NULL,            -- when the device captured the fix (UTC or local — see Source)
        Lat           DECIMAL(9,6)   NOT NULL,            -- -90.000000 to 90.000000
        Lng           DECIMAL(9,6)   NOT NULL,            -- -180.000000 to 180.000000
        Accuracy      DECIMAL(6,2)   NULL,                -- horizontal accuracy in metres (lower = better)
        SpeedMps      DECIMAL(6,2)   NULL,                -- metres/second from device sensor (NULL if not moving)
        HeadingDeg    DECIMAL(6,2)   NULL,                -- 0..360 compass heading (NULL if stationary)
        Altitude      DECIMAL(8,2)   NULL,                -- metres above sea level (optional)

        BatteryPct    TINYINT        NULL,                -- 0..100 battery % at ping time
        IsMocked      BIT            NOT NULL DEFAULT 0,  -- 1 if Capacitor reports mock-location enabled
        IsOnline      BIT            NOT NULL DEFAULT 1,  -- 0 = stored offline, synced later
        Source        NVARCHAR(20)   NULL,                -- 'gps' | 'network' | 'fused' | 'manual'

        ServerInsertedAt DATETIME2(3) NOT NULL DEFAULT SYSDATETIME(),

        -- Loose FK (no enforced constraint to keep ping inserts fast)
        -- CONSTRAINT FK_HRM_Ping_User FOREIGN KEY (UserId) REFERENCES User_Login(Id),

        INDEX IX_HRM_Ping_User_Time (UserId, PingTime DESC),
        INDEX IX_HRM_Ping_Time      (PingTime DESC),
        INDEX IX_HRM_Ping_Company   (Company, PingTime DESC)
    );

    PRINT '[OK] dbo.HRM_LocationPing created.';
END
ELSE
BEGIN
    PRINT '[SKIP] dbo.HRM_LocationPing already exists.';
END
GO

-- Verify
SELECT TOP 1 *
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'HRM_LocationPing';
GO
