-- =====================================================================
-- 13_BN_BeatPlan.sql — Electrical vertical weekly beat plan (2026-06-12)
--
-- The Retailer/Electrical team works DMS-style: each outlet is visited on ONE
-- fixed weekday, every week of the month (IvyDMS "Retailer User Visit Day").
-- BN_BeatPlan stores that recurring template; a generator expands it into
-- normal BN_VisitPlan rows each month (Source='beat', BeatId backlink) so
-- Visit Tracker / Punch-In / auto-confirm all work unchanged.
--
-- Also adds BN_VisitPlan.BeatId for idempotent generation.
-- Idempotent. App DB only. Safe to re-run.
-- =====================================================================
USE BizNAV_App;
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRAN;

  ------------------------------------------------------------------
  -- 1. BN_BeatPlan
  ------------------------------------------------------------------
  IF OBJECT_ID('dbo.BN_BeatPlan') IS NULL
  BEGIN
    CREATE TABLE dbo.BN_BeatPlan (
      Id              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_BN_BeatPlan PRIMARY KEY,
      Company         NVARCHAR(20)  NOT NULL CONSTRAINT DF_BN_BeatPlan_Company DEFAULT 'COMPANYA',
      SalespersonCode NVARCHAR(100) NOT NULL,
      SalespersonName NVARCHAR(200) NULL,
      [Weekday]       TINYINT       NOT NULL,   -- 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
      OutletCode      NVARCHAR(40)  NULL,       -- DMS outlet code (Retailer IvyDMS)
      OutletName      NVARCHAR(400) NOT NULL,
      RouteCode       NVARCHAR(60)  NULL,
      RouteName       NVARCHAR(200) NULL,
      Phone           NVARCHAR(40)  NULL,
      Address         NVARCHAR(500) NULL,
      Lat             DECIMAL(10,7) NULL,
      Lng             DECIMAL(10,7) NULL,
      GeofenceId      INT           NULL,       -- HRM_Geofence backlink (punch auto-match)
      WalkSeq         INT           NOT NULL CONSTRAINT DF_BN_BeatPlan_WalkSeq DEFAULT 0,
      IsActive        BIT           NOT NULL CONSTRAINT DF_BN_BeatPlan_IsActive DEFAULT 1,
      CreatedAt       DATETIME2(0)  NOT NULL CONSTRAINT DF_BN_BeatPlan_CreatedAt DEFAULT SYSDATETIME(),
      CreatedBy       NVARCHAR(100) NULL,
      UpdatedAt       DATETIME2(0)  NULL,
      UpdatedBy       NVARCHAR(100) NULL
    );
    CREATE NONCLUSTERED INDEX IX_BN_BeatPlan_Sp_Day
      ON dbo.BN_BeatPlan (SalespersonCode, [Weekday]) INCLUDE (IsActive, OutletName);
    PRINT '[OK] BN_BeatPlan created';
  END
  ELSE PRINT '[SKIP] BN_BeatPlan already exists';

  ------------------------------------------------------------------
  -- 2. BN_VisitPlan.BeatId (idempotent-generation backlink)
  ------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM sys.columns
                 WHERE object_id = OBJECT_ID('dbo.BN_VisitPlan') AND name = 'BeatId')
  BEGIN
    EXEC (N'ALTER TABLE dbo.BN_VisitPlan ADD BeatId INT NULL;');
    PRINT '[OK] BN_VisitPlan.BeatId added';
  END
  ELSE PRINT '[SKIP] BN_VisitPlan.BeatId already exists';

  IF NOT EXISTS (SELECT 1 FROM sys.indexes
                 WHERE object_id = OBJECT_ID('dbo.BN_VisitPlan') AND name = 'IX_BN_VisitPlan_Beat_Date')
  BEGIN
    EXEC (N'CREATE NONCLUSTERED INDEX IX_BN_VisitPlan_Beat_Date
            ON dbo.BN_VisitPlan (BeatId, VisitDate) WHERE BeatId IS NOT NULL;');
    PRINT '[OK] IX_BN_VisitPlan_Beat_Date created';
  END
  ELSE PRINT '[SKIP] IX_BN_VisitPlan_Beat_Date already exists';

  COMMIT;
  PRINT '[DONE] 13_BN_BeatPlan migration complete';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  PRINT '[FAIL] ' + ERROR_MESSAGE();
  THROW;
END CATCH
