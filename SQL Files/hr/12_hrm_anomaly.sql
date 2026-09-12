-- ============================================================================
-- ONE App Lens — Phase 2.6 — HRM_Anomaly table
-- File:  SQL Files/hr/12_hrm_anomaly.sql
-- Date:  2026-05-20
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent. Zero existing data.
--   * SET XACT_ABORT ON — auto-rollback.
--
-- WHAT IT CREATES:
--   dbo.HRM_Anomaly — audit log of every "something looks off" event the
--   anomaly detector catches. Each row is one open item HR reviews; the
--   detector dedupes by (UserId, AttId, Kind) so the same session never
--   raises the same anomaly twice.
--
-- KINDS:
--   - office_exit       — signed in + left assigned office geofence w/o sign-out
--   - stale_session     — sign-in older than 14h, still no sign-out
--   - no_show           — assigned + no sign-in by shift-start + 1h
--   - mock_gps          — IsMocked=1 detected on a ping
--   - prolonged_absence — outside office > 60 min during work hours w/ no customer visit
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Anomaly]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Anomaly] (
        AnomalyId         BIGINT         IDENTITY(1,1) PRIMARY KEY,
        UserId            INT            NOT NULL,
        UserCode          NVARCHAR(50)   NULL,
        Company           NVARCHAR(10)   NULL,

        Kind              NVARCHAR(30)   NOT NULL,
        Severity          NVARCHAR(10)   NOT NULL DEFAULT 'warning',  -- info | warning | critical

        DetectedAt        DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        AnomalyDate       DATE           NOT NULL DEFAULT CAST(GETDATE() AS DATE),

        AttId             BIGINT         NULL,    -- soft FK -> HRM_Attendance
        OfficeGeofenceId  INT            NULL,    -- soft FK -> HRM_Geofence
        TriggerPingId     BIGINT         NULL,    -- soft FK -> HRM_LocationPing

        Title             NVARCHAR(200)  NOT NULL,
        Detail            NVARCHAR(MAX)  NULL,
        LastSeenLat       DECIMAL(9, 6)  NULL,
        LastSeenLng       DECIMAL(9, 6)  NULL,

        IsResolved        BIT            NOT NULL DEFAULT 0,
        ResolvedBy        INT            NULL,
        ResolvedAt        DATETIME2(0)   NULL,
        ResolutionNote    NVARCHAR(500)  NULL,

        NotifiedAt        DATETIME2(0)   NULL,    -- when WhatsApp / email alert fired (future)
        NotifyChannel     NVARCHAR(20)   NULL,

        CreatedAt         DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt         DATETIME2(0)   NULL,

        INDEX IX_HRM_Anom_Date_Kind (AnomalyDate, Kind, IsResolved),
        INDEX IX_HRM_Anom_User      (UserId, AnomalyDate DESC),
        INDEX IX_HRM_Anom_Open      (IsResolved, DetectedAt DESC) WHERE IsResolved = 0
    );

    PRINT '[OK] dbo.HRM_Anomaly created.';
END
ELSE
BEGIN
    PRINT '[SKIP] dbo.HRM_Anomaly already exists.';
END
GO

SELECT TOP 1 *
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'HRM_Anomaly';
GO
