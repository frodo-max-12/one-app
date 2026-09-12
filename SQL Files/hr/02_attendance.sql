-- ============================================================================
-- ONE App Lens — Phase 0 — Table 2/5
-- File:  SQL Files/hr/02_attendance.sql
-- Date:  2026-05-19
--
-- SAFETY PROFILE:
--   * Runs on BizNAV_App only. NAV DB untouched.
--   * Idempotent (IF NOT EXISTS). Zero existing data.
--   * SET XACT_ABORT ON — any error rolls back the whole script.
--
-- WHAT IT CREATES:
--   dbo.HRM_Attendance — one row per (UserId, AttDate, Session). Session = 1 or 2
--   so we can model GreytHR's half-day leave / split-shift pattern.
--   Each row stores Sign-In ping FK + Sign-Out ping FK + computed work-hours.
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;
GO

IF OBJECT_ID('[dbo].[HRM_Attendance]', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[HRM_Attendance] (
        AttId          BIGINT         IDENTITY(1,1) PRIMARY KEY,
        UserId         INT            NOT NULL,
        UserCode       NVARCHAR(50)   NULL,
        Company        NVARCHAR(10)   NULL,

        AttDate        DATE           NOT NULL,             -- the work day
        Session        TINYINT        NOT NULL DEFAULT 1,   -- 1 = first half, 2 = second half (split-shift)

        Status         NVARCHAR(10)   NOT NULL DEFAULT 'A', -- 'P'=Present 'A'=Absent 'H'=Holiday 'L'=Leave 'WO'=Weekly Off 'HD'=Half-Day

        SignInTime     DATETIME2(0)   NULL,
        SignInPingId   BIGINT         NULL,                 -- FK -> HRM_LocationPing.PingId
        SignInLat      DECIMAL(9,6)   NULL,                 -- denormalised for quick map render
        SignInLng      DECIMAL(9,6)   NULL,
        SignInRemarks  NVARCHAR(200)  NULL,
        SignInSelfieUrl NVARCHAR(500) NULL,                 -- blob path (cloud later)
        SignInFaceScore DECIMAL(5,4)  NULL,                 -- 0.0000-1.0000 face-api match score

        SignOutTime    DATETIME2(0)   NULL,
        SignOutPingId  BIGINT         NULL,
        SignOutLat     DECIMAL(9,6)   NULL,
        SignOutLng     DECIMAL(9,6)   NULL,
        SignOutRemarks NVARCHAR(200)  NULL,
        SignOutSelfieUrl NVARCHAR(500) NULL,

        TotalWorkMin   INT            NULL,                 -- computed at sign-out: minutes between SignIn and SignOut
        DistanceKm     DECIMAL(8,2)   NULL,                 -- computed at sign-out: Haversine sum of pings
        ShiftCode      NVARCHAR(20)   NULL,                 -- e.g. '09:45-18:15' or shift-master FK later

        IsRegularized  BIT            NOT NULL DEFAULT 0,   -- manually fixed via HRM_Regularization
        RegularizedBy  INT            NULL,                 -- FK -> User_Login.Id
        RegularizedAt  DATETIME2(0)   NULL,

        CreatedAt      DATETIME2(0)   NOT NULL DEFAULT SYSDATETIME(),
        UpdatedAt      DATETIME2(0)   NULL,

        CONSTRAINT UK_HRM_Att_User_Date_Session UNIQUE (UserId, AttDate, Session),

        INDEX IX_HRM_Att_Date_Status   (AttDate, Status),
        INDEX IX_HRM_Att_User_Date     (UserId, AttDate DESC),
        INDEX IX_HRM_Att_Company_Date  (Company, AttDate DESC)
    );

    PRINT '[OK] dbo.HRM_Attendance created.';
END
ELSE
BEGIN
    PRINT '[SKIP] dbo.HRM_Attendance already exists.';
END
GO

SELECT TOP 1 *
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'HRM_Attendance';
GO
