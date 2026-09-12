-- ============================================================================
-- ONE App — ALTER BN_VisitPlan: visit location + geofence link
-- File:  SQL Files/hr/58_alter_visitplan_geofence.sql
-- Date:  2026-05-29
--
-- WHY:
--   Visit creation now lets the salesperson pick the exact location via the
--   Google Places API. We store those coordinates on the visit and link it to
--   the HRM_Geofence that gets auto-created (or reused) for that customer, so
--   the GPS visit-detector can auto-confirm the visit when the rep arrives.
--
--   VisitLat/VisitLng  — picked coordinates (Places API)
--   PlaceId            — Google place id (for re-lookup / dedup)
--   GeofenceId         — FK-ish link to HRM_Geofence row used for this customer
--
-- SAFETY: BizNAV_App.dbo.BN_VisitPlan only. Additive nullable columns, guarded,
--   idempotent. Existing rows + routes unaffected (they ignore these columns).
-- ============================================================================

USE BizNAV_App;
GO

SET XACT_ABORT ON;

DECLARE @sql NVARCHAR(MAX) = N'';

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.BN_VisitPlan') AND name = 'VisitLat')
  SET @sql += N'ALTER TABLE dbo.BN_VisitPlan ADD VisitLat DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.BN_VisitPlan') AND name = 'VisitLng')
  SET @sql += N'ALTER TABLE dbo.BN_VisitPlan ADD VisitLng DECIMAL(9,6) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.BN_VisitPlan') AND name = 'PlaceId')
  SET @sql += N'ALTER TABLE dbo.BN_VisitPlan ADD PlaceId NVARCHAR(300) NULL;' + CHAR(10);
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.BN_VisitPlan') AND name = 'GeofenceId')
  SET @sql += N'ALTER TABLE dbo.BN_VisitPlan ADD GeofenceId INT NULL;' + CHAR(10);

IF LEN(@sql) = 0
  PRINT '[SKIP] BN_VisitPlan location/geofence columns already present.';
ELSE
BEGIN
  EXEC sp_executesql @sql;
  PRINT '[OK] BN_VisitPlan extended with VisitLat/VisitLng/PlaceId/GeofenceId.';
END
GO
