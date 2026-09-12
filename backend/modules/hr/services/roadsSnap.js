// =====================================================================
// modules/hr/services/roadsSnap.js
//
// Turns a raw HRM_LocationPing trail into a clean, road-following polyline:
//
//   1. FILTER — drop GPS noise:
//        • Accuracy > 50 m  (jittery fixes that create the "nest" effect)
//        • Implied speed > 200 km/h between kept points (GPS spikes / teleports)
//   2. SNAP   — Google Roads API "Snap to Roads" aligns the filtered points to
//        actual streets and interpolates the gaps so a sparse driving trail
//        becomes a smooth curve instead of straight diagonal jumps.
//   3. BRIDGE — for any consecutive pair still > GAP_BRIDGE_MIN_M apart after
//        snapping (battery tier dropped, app killed, indoor stretch), call
//        Google Directions API for the most-likely driving route between them
//        and splice the decoded polyline into the path. This converts straight
//        diagonal "teleports" into a plausible road-following line. The result
//        is a BEST GUESS, not ground truth — the visit detector still uses the
//        real ping coords so detection accuracy is unaffected.
//   4. CACHE  — keyed by `userId:date:pingCount`. Past days (stable ping count)
//        hit the cache; today's live trail recomputes only when a new ping lands.
//        Gap-bridge calls are additionally cached by quantized origin/dest pair
//        so the same gap (e.g., morning commute) doesn't pay twice.
//
// Reuses GOOGLE_PLACES_API_KEY (same key the Places search already uses) — falls
// back to GOOGLE_ROADS_API_KEY if you prefer a separate key. The Roads API and
// Directions API must both be enabled on that key's Google Cloud project. If
// Directions isn't enabled, gap-bridging silently skips and you get the
// pre-2026-06-03 straight-line behavior — no error surfaces to the user.
//
// GRACEFUL FALLBACK: if there's no key, the API errors, or there are <2 usable
// points, we return the FILTERED raw path so the map still renders — just
// without road-snapping. Never throws to the caller.
// =====================================================================

const { sql, getAppPool } = require('../../../db');

const ACCURACY_MAX_M    = 50;     // drop pings less accurate than this
const MAX_SPEED_KMH     = 200;    // drop points implying impossible ground speed
const SNAP_CHUNK        = 100;    // Roads API hard limit: 100 points per request
const CACHE_MAX         = 300;    // LRU-ish cap on the L1 in-memory cache
const GAP_BRIDGE_MIN_M  = 500;    // gap (m) above which we call Directions API
const GAP_BRIDGE_MAX_M  = 20000;  // gap (m) above which we DON'T bridge — likely
                                  // a real long break (lunch/home), straight line
                                  // is clearer than a guessed 20km path
const DIRECTIONS_TIMEOUT_MS = 4000;  // per-call timeout — fail fast, fall back
const DIRECTIONS_GAP_CACHE_MAX = 500;

// L1 in-memory cache: `${userId}:${date}:${pingCount}` -> { path:[[lat,lng]...], snapped:bool }
// L2 is HRM_DayJourneyCache (survives pm2 restart; caps Roads API spend).
const snapCache = new Map();
// Per-gap Directions cache — key is quantized "lat1,lng1->lat2,lng2" rounded to
// ~10 m grid (4 decimal places). Same morning commute hits the cache after the
// first day. Null values are cached too so repeated 404/non-route gaps don't
// spam the API.
const directionsCache = new Map();

// ── L2 DB cache helpers ─────────────────────────────────────────────────────
async function dbCacheGet(userId, date, pingCount) {
  if (userId == null || !date) return null;
  try {
    const pool = await getAppPool();
    const r = await pool.request()
      .input('uid', sql.Int,  userId)
      .input('dt',  sql.Date, date)
      .query(`
        SELECT PingCount, PointCount, Snapped, SnappedJson
        FROM [dbo].[HRM_DayJourneyCache]
        WHERE UserId = @uid AND JourneyDate = @dt;
      `);
    const row = r.recordset[0];
    if (!row) return null;
    if (Number(row.PingCount) !== Number(pingCount)) return null;   // stale — more pings arrived
    return { path: JSON.parse(row.SnappedJson), snapped: !!row.Snapped, filteredCount: row.PointCount };
  } catch (e) {
    console.error('[roadsSnap] dbCacheGet failed (non-fatal):', e.message);
    return null;   // table may not exist yet → behave as cache miss
  }
}

async function dbCachePut(userId, date, pingCount, result) {
  if (userId == null || !date) return;
  try {
    const pool = await getAppPool();
    await pool.request()
      .input('uid',  sql.Int,           userId)
      .input('dt',   sql.Date,          date)
      .input('pc',   sql.Int,           pingCount)
      .input('ptc',  sql.Int,           result.path.length)
      .input('snp',  sql.Bit,           result.snapped ? 1 : 0)
      .input('json', sql.NVarChar(sql.MAX), JSON.stringify(result.path))
      .query(`
        MERGE [dbo].[HRM_DayJourneyCache] AS t
        USING (SELECT @uid AS UserId, @dt AS JourneyDate) AS s
          ON t.UserId = s.UserId AND t.JourneyDate = s.JourneyDate
        WHEN MATCHED THEN UPDATE SET
          PingCount = @pc, PointCount = @ptc, Snapped = @snp,
          SnappedJson = @json, BuiltAt = SYSDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (UserId, JourneyDate, PingCount, PointCount, Snapped, SnappedJson)
          VALUES (@uid, @dt, @pc, @ptc, @snp, @json);
      `);
  } catch (e) {
    console.error('[roadsSnap] dbCachePut failed (non-fatal):', e.message);
  }
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Step 1 — noise filter. Returns [{Lat, Lng, PingTime}] cleaned.
function filterPings(pings) {
  const kept = [];
  for (const p of pings) {
    if (p.Lat == null || p.Lng == null) continue;
    const lat = Number(p.Lat), lng = Number(p.Lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (p.Accuracy != null && Number(p.Accuracy) > ACCURACY_MAX_M) continue;
    if (kept.length) {
      const prev = kept[kept.length - 1];
      const dM   = haversineM(prev.Lat, prev.Lng, lat, lng);
      const dtS  = (new Date(p.PingTime) - new Date(prev.PingTime)) / 1000;
      if (dtS > 0) {
        const kmh = (dM / 1000) / (dtS / 3600);
        if (kmh > MAX_SPEED_KMH) continue;   // spike — skip this outlier
      }
    }
    kept.push({ Lat: lat, Lng: lng, PingTime: p.PingTime });
  }
  return kept;
}

async function snapChunk(points, key) {
  const path = points.map(p => `${p.Lat},${p.Lng}`).join('|');
  const url  = `https://roads.googleapis.com/v1/snapToRoads?interpolate=true&key=${key}&path=${encodeURIComponent(path)}`;
  const r    = await fetch(url);
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`Roads API HTTP ${r.status}: ${data && data.error && data.error.message || 'unknown'}`);
  }
  return (data.snappedPoints || []).map(sp => [sp.location.latitude, sp.location.longitude]);
}

// ── Google Directions polyline decoder ──────────────────────────────────────
// Standard Google polyline encoding (precision 5). Returns [[lat, lng], ...].
function decodePolyline(encoded) {
  let index = 0, lat = 0, lng = 0;
  const path = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    path.push([lat / 1e5, lng / 1e5]);
  }
  return path;
}

// ── Directions API fetch with timeout + per-gap cache ──────────────────────
async function fetchDirectionsBridge(a, b, key) {
  // Quantize to a ~10m grid so morning-commute / common segments coalesce.
  const cacheKey = `${a[0].toFixed(4)},${a[1].toFixed(4)}->${b[0].toFixed(4)},${b[1].toFixed(4)}`;
  if (directionsCache.has(cacheKey)) return directionsCache.get(cacheKey);

  const url = `https://maps.googleapis.com/maps/api/directions/json`
    + `?origin=${a[0]},${a[1]}`
    + `&destination=${b[0]},${b[1]}`
    + `&mode=driving`
    + `&key=${encodeURIComponent(key)}`;

  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), DIRECTIONS_TIMEOUT_MS) : null;
  try {
    const r = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (timer) clearTimeout(timer);
    const data = await r.json();
    // status === 'OK' means we got a route. Anything else (NOT_FOUND,
    // ZERO_RESULTS, REQUEST_DENIED if Directions API isn't enabled, OVER_LIMIT)
    // → cache null and fall back to straight line for this gap.
    if (!r.ok || data.status !== 'OK' || !data.routes || !data.routes.length) {
      directionsCache.set(cacheKey, null);
      return null;
    }
    const enc = data.routes[0].overview_polyline && data.routes[0].overview_polyline.points;
    if (!enc) {
      directionsCache.set(cacheKey, null);
      return null;
    }
    const decoded = decodePolyline(enc);
    // Bound the cache so it can't grow unbounded across many users/days.
    if (directionsCache.size >= DIRECTIONS_GAP_CACHE_MAX) {
      directionsCache.delete(directionsCache.keys().next().value);
    }
    directionsCache.set(cacheKey, decoded);
    return decoded;
  } catch (e) {
    if (timer) clearTimeout(timer);
    // Network / abort / parse errors all swallow to null — straight-line fallback.
    directionsCache.set(cacheKey, null);
    return null;
  }
}

// Walks the snapped path and bridges any consecutive pair > GAP_BRIDGE_MIN_M
// apart with a Directions API route. Returns the augmented polyline. Awaits
// gaps sequentially — typical day has 0-3 gaps, parallelism not worth the
// complexity. Bounded by GAP_BRIDGE_MAX_M so a real long break (lunch / home
// run) stays a clean straight line.
async function bridgeLongGaps(points, key) {
  if (!Array.isArray(points) || points.length < 2 || !key) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dM = haversineM(a[0], a[1], b[0], b[1]);
    if (dM >= GAP_BRIDGE_MIN_M && dM <= GAP_BRIDGE_MAX_M) {
      const bridge = await fetchDirectionsBridge(a, b, key);
      if (Array.isArray(bridge) && bridge.length >= 2) {
        // Drop first + last bridge points (they're the gap endpoints, already
        // in `out` and about-to-be-added). Push only the in-between points.
        for (let j = 1; j < bridge.length - 1; j++) out.push(bridge[j]);
      }
    }
    out.push(b);
  }
  return out;
}

// Main entry. pings = HRM_LocationPing recordset (Lat/Lng/Accuracy/PingTime).
// Returns { path: [[lat,lng]...], snapped: bool, filteredCount, cached? }.
async function snapToRoads(pings, { userId, date } = {}) {
  const filtered = filterPings(pings || []);
  const rawPath  = filtered.map(p => [p.Lat, p.Lng]);
  if (filtered.length < 2) return { path: rawPath, snapped: false, filteredCount: filtered.length };

  const key = process.env.GOOGLE_ROADS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { path: rawPath, snapped: false, filteredCount: filtered.length };

  const pingCount = (pings || []).length;
  const cacheKey  = `${userId}:${date}:${pingCount}`;

  // L1 — in-memory (fastest, per-process)
  if (snapCache.has(cacheKey)) return { ...snapCache.get(cacheKey), cached: 'mem' };

  // L2 — DB (survives pm2 restart; this is what caps the Roads API spend)
  const fromDb = await dbCacheGet(userId, date, pingCount);
  if (fromDb) {
    if (snapCache.size >= CACHE_MAX) snapCache.delete(snapCache.keys().next().value);
    snapCache.set(cacheKey, fromDb);
    return { ...fromDb, cached: 'db' };
  }

  try {
    const out = [];
    for (let i = 0; i < filtered.length; i += SNAP_CHUNK) {
      const snapped = await snapChunk(filtered.slice(i, i + SNAP_CHUNK), key);
      out.push(...snapped);
    }
    if (out.length < 2) {
      const fallback = { path: rawPath, snapped: false, filteredCount: filtered.length };
      if (snapCache.size >= CACHE_MAX) snapCache.delete(snapCache.keys().next().value);
      snapCache.set(cacheKey, fallback);
      await dbCachePut(userId, date, pingCount, fallback);
      return fallback;
    }
    // Bridge tracking-gap "teleports" with Directions API routes. Silently
    // skipped if Directions isn't enabled on the key — the snapped path falls
    // through unchanged, which matches the pre-2026-06-03 behavior.
    const bridged = await bridgeLongGaps(out, key).catch(e => {
      console.error('[roadsSnap] bridgeLongGaps failed (non-fatal):', e.message);
      return out;
    });
    const result = { path: bridged, snapped: true, filteredCount: filtered.length, bridged: bridged.length > out.length };
    // Write through to both cache layers
    if (snapCache.size >= CACHE_MAX) snapCache.delete(snapCache.keys().next().value);
    snapCache.set(cacheKey, result);
    await dbCachePut(userId, date, pingCount, result);
    return result;
  } catch (e) {
    console.error('[roadsSnap] snap failed, falling back to filtered raw path:', e.message);
    return { path: rawPath, snapped: false, filteredCount: filtered.length, error: e.message };
  }
}

module.exports = { snapToRoads, filterPings };
