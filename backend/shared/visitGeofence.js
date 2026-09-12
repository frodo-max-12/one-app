// =====================================================================
// shared/visitGeofence.js — resolve (reuse or auto-create) a customer geofence
//
// Extracted 2026-06-03 from modules/sales/routes/visitPlan.js so both
//   - Visit Plan creation (Sales)
//   - Visit Punch-In (HR — v1.8)
// share one geofence-resolution path. The dedup + creation rules are
// authoritative here; do NOT duplicate them in route files.
//
// Dedup rules (same as v1.7 visitPlan):
//   1. NAV customer with code → match exact CustomerCode (one fence per NAV code).
//   2. Prospect (no code)     → match exact Name (case-insensitive, trimmed).
//
// Create rules:
//   - Only when lat/lng coordinates are supplied (no anchor = no fence).
//   - RadiusM             = 100 (meters)
//   - DwellMinForVisit    = 5   (minutes — 2026-06-03 Option C, was 10)
//   - Kind                = 'customer'
//   - IsActive            = (table default — 1)
//
// Side-effects:
//   - Calls visitDetector.invalidateGeofenceCache() after CREATE so the auto-
//     detector sees the new fence on the next ping, not 5 min later.
//
// Returns: { geofenceId: number|null, created: boolean }
//   - geofenceId === null when no fence could be resolved AND coordinates were
//     missing (caller decides if that's fatal). Errors swallowed → null + log.
// =====================================================================

const { sql } = require('../db');
const visitDetector = require('../modules/hr/services/visitDetector');

async function resolveGeofence(pool, opts) {
  const { customerCode, customerName, lat, lng, address, city, state, pincode, company, userId } = opts;
  try {
    // 1. Reuse existing — by exact NAV code, else by exact prospect name.
    const findReq = pool.request();
    let findWhere;
    if (customerCode) {
      findReq.input('cc', sql.NVarChar(50), customerCode);
      findWhere = 'CustomerCode = @cc';
    } else {
      findReq.input('nm', sql.NVarChar(200), customerName);
      findWhere = "ISNULL(CustomerCode,'') = '' AND LTRIM(RTRIM(Name)) = LTRIM(RTRIM(@nm))";
    }
    const found = await findReq.query(`
      SELECT TOP 1 GeofenceId FROM [dbo].[HRM_Geofence]
      WHERE Kind = 'customer' AND IsActive = 1 AND ${findWhere}
      ORDER BY GeofenceId;
    `);
    if (found.recordset.length) {
      return { geofenceId: found.recordset[0].GeofenceId, created: false };
    }

    // 2. Create — only when we actually have coordinates to anchor it.
    if (lat == null || lng == null || isNaN(Number(lat)) || isNaN(Number(lng))) {
      return { geofenceId: null, created: false };
    }
    const ins = await pool.request()
      .input('name',     sql.NVarChar(200), (customerName || 'Customer').slice(0, 200))
      .input('cc',       sql.NVarChar(50),  customerCode || null)
      .input('company',  sql.NVarChar(10),  company || null)
      .input('lat',      sql.Decimal(9, 6), Number(lat))
      .input('lng',      sql.Decimal(9, 6), Number(lng))
      .input('address',  sql.NVarChar(500), address || null)
      .input('city',     sql.NVarChar(100), city || null)
      .input('state',    sql.NVarChar(100), state || null)
      .input('pincode',  sql.NVarChar(10),  (pincode || '').slice(0, 10) || null)
      .input('createdBy',sql.Int,           userId)
      .query(`
        INSERT INTO [dbo].[HRM_Geofence]
          (Name, Kind, CustomerCode, Company, CenterLat, CenterLng, RadiusM,
           Address, City, State, Pincode, DwellMinForVisit, CreatedBy)
        OUTPUT INSERTED.GeofenceId
        VALUES
          (@name, 'customer', @cc, @company, @lat, @lng, 100,
           @address, @city, @state, @pincode, 5, @createdBy);
      `);
    const gid = ins.recordset[0].GeofenceId;
    try { visitDetector.invalidateGeofenceCache(); } catch (_) { /* non-fatal */ }
    return { geofenceId: gid, created: true };
  } catch (e) {
    console.error('[visitGeofence] resolveGeofence failed (non-fatal):', e.message);
    return { geofenceId: null, created: false };
  }
}

module.exports = { resolveGeofence };
