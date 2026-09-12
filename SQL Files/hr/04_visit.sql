-- ============================================================================
-- ONE App Lens — Phase 0 — Table 4/5
-- File:  SQL Files/hr/04_visit.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * BizNAV_App only. NAV DB untouched.
--   * IF NOT EXISTS — idempotent.
--   * SET XACT_ABORT ON.
--
-- WHAT IT CREATES:
--   dbo.HRM_Visit — every geofence entry-exit event (one row per stop). This is
--   the "raw timeline" that feeds Day Journey + replay slider. When a Visit is
--   confirmed (dwell >= geofence.DwellMinForVisit), it can auto-update
--   BN_VisitPlan.VisitDone — that linkage is the ALTER in 06_alter_visitplan.sql.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Visit]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Visit] (
        VisitId        BIGINT         IDENTITY(1,1) PRIMARY KEY,
        UserId         INT            NOT NULL,
        UserCode       NVARCHAR(50)   NULL,
        Company        NVARCHAR(10)   NULL,

        GeofenceId     INT            NULL,                 -- NULL = ad-hoc location not tied to a known geofence
        CustomerCode   NVARCHAR(50)   NULL,                 -- denormalised from geofence
        CustomerName   NVARCHAR(200)  NULL,                 -- denormalised

        EntryTime      DATETIME2(0)   NOT NULL,
        ExitTime       DATETIME2(0)   NULL,                 -- NULL = currently inside geofence
        DurationMin    INT            NULL,                 -- (ExitTime - EntryTime) in minutes, computed on exit

        EntryPingId    BIGINT         NULL,                 -- FK -> HRM_LocationPing.PingId
        ExitPingId     BIGINT         NULL,
        Lat            DECIMAL(9,6)   NULL,                 -- representative point (= EntryPingId lat)
        Lng            DECIMAL(9,6)   NULL,

        IsConfirmedVisit BIT          NOT NULL DEFAULT 0,   -- 1 when DurationMin >= geofence.DwellMinForVisit
        AutoConfirmedAt  DATETIME2(0) NULL,

        Department     NVARCHAR(10)   NULL,                 -- 'SALES' | 'FAE' | 'JOINT' — denormalised from user role at entry
        VisitPlanId    INT            NULL,                 -- FK -> BN_VisitPlan.Id when matched

        MOM            NVARCHAR(MAX)  NULL,                 -- Minutes of meeting if logged on-device
        Notes          NVARCHAR(1000) NULL,

        CreatedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)   NULL,

        INDEX IX_HRM_Visit_User_Entry  (UserId, EntryTime DESC),
        INDEX IX_HRM_Visit_Customer    (CustomerCode, EntryTime DESC),
        INDEX IX_HRM_Visit_Confirmed   (IsConfirmedVisit, EntryTime DESC)
    );

    PRINT '[OK] dbo.HRM_Visit created.';
END
ELSE
BEGIN
    PRINT '[SKIP] dbo.HRM_Visit already exists.';
END
GO

SELECT TOP 1 *
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'HRM_Visit';
GO
