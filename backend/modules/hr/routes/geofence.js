// =====================================================================
// modules/hr/routes/geofence.js — Geofence CRUD (Phase 2.3)
//
// Mounted at /api/hr/geofence/* by ../index.js.
//
// Endpoints:
//   GET    /                    — list geofences (filters: search, kind, active)
//   GET    /:id                 — single geofence
//   POST   /                    — create
//   PUT    /:id                 — update
//   DELETE /:id                 — soft delete (sets IsActive=0)
//   GET    /customer-suggest?q= — NAV Customer master autocomplete (read-only)
//
// Permission model (Phase 2.3 — open to all logged-in users so any sales head
// can drop a geofence on their customers; tighten in Phase 3 admin polish):
//   - Anyone can read
//   - Anyone can create
//   - Anyone can edit/delete (we keep CreatedBy for audit; revisit in Phase 3)
// =====================================================================

const express = require('express');
const router  = express.Router();
const { sql, getPool, getAppPool } = require('../../../db');
const { authenticate } = require('../../../auth');
const { getCompany }   = require('../../../shared/company');
const visitDetector    = require('../services/visitDetector');
const anomalyDetector  = require('../services/anomalyDetector');

// ── helpers ──────────────────────────────────────────────────────────────────
function parseBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true || v === 'true' || v === '1' || v === 1) return true;
  return false;
}
function clampLat(n) { return (typeof n === 'number' && n >= -90  && n <= 90)  ? n : null; }
function clampLng(n) { return (typeof n === 'number' && n >= -180 && n <= 180) ? n : null; }

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const q       = (req.query.search || '').trim();
    const kind    = (req.query.kind || '').trim();          // '' | 'customer' | 'office' | 'warehouse' | 'site'
    const active  = parseBool(req.query.active, true);
    const company = (req.query.company || '').trim();        // optional filter

    const pool = await getAppPool();
    const r = pool.request();
    const where = ['1=1'];
    if (active) where.push('IsActive = 1');
    if (kind)   { where.push('Kind = @kind');               r.input('kind', sql.NVarChar(20), kind); }
    if (company){ where.push('(Company IS NULL OR Company = @co)'); r.input('co', sql.NVarChar(10), company); }
    if (q) {
      where.push('(Name LIKE @q OR ISNULL(CustomerCode,\'\') LIKE @q OR ISNULL(City,\'\') LIKE @q)');
      r.input('q', sql.NVarChar(200), '%' + q + '%');
    }
    const result = await r.query(`
      SELECT GeofenceId, Name, Kind, CustomerCode, Company,
             CenterLat, CenterLng, RadiusM,
             Address, City, State, Pincode,
             DwellMinForVisit, IsActive,
             CreatedBy, CreatedAt, UpdatedAt
      FROM [dbo].[HRM_Geofence]
      WHERE ${where.join(' AND ')}
      ORDER BY Name;
    `);
    return res.json({ ok: true, geofences: result.recordset });
  } catch (err) {
    console.error('[/api/hr/geofence] failed:', err.message);
    return res.status(500).json({ message: 'Geofence list failed', detail: err.message });
  }
});

// ── GET /:id ─────────────────────────────────────────────────────────────────
// Pass-through when :id isn't numeric so named routes (/places-suggest, /places-detail,
// /customer-suggest) match further down the stack. Without this, "/places-suggest"
// hits this handler with params.id='places-suggest' → parseInt → NaN → 400.
router.get('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    const r = await pool.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM [dbo].[HRM_Geofence] WHERE GeofenceId = @id;`);
    if (r.recordset.length === 0) return res.status(404).json({ message: 'Not found' });
    return res.json({ ok: true, geofence: r.recordset[0] });
  } catch (err) {
    return res.status(500).json({ message: 'Geofence fetch failed', detail: err.message });
  }
});

// ── POST / ───────────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || typeof b.name !== 'string')             return res.status(400).json({ message: 'name required' });
    if (clampLat(Number(b.centerLat)) === null)             return res.status(400).json({ message: 'centerLat invalid' });
    if (clampLng(Number(b.centerLng)) === null)             return res.status(400).json({ message: 'centerLng invalid' });

    const pool = await getAppPool();
    const r = pool.request();
    r.input('name',     sql.NVarChar(200), b.name.trim());
    r.input('kind',     sql.NVarChar(20),  (b.kind || 'customer').trim());
    r.input('custCode', sql.NVarChar(50),  (b.customerCode || '').trim() || null);
    r.input('company',  sql.NVarChar(10),  (b.company || '').trim() || null);
    r.input('lat',      sql.Decimal(9, 6), Number(b.centerLat));
    r.input('lng',      sql.Decimal(9, 6), Number(b.centerLng));
    r.input('radius',   sql.Int,           Math.max(10, Math.min(5000, parseInt(b.radiusM) || 100)));
    r.input('address',  sql.NVarChar(500), b.address || null);
    r.input('city',     sql.NVarChar(100), b.city    || null);
    r.input('state',    sql.NVarChar(100), b.state   || null);
    r.input('pincode',  sql.NVarChar(10),  b.pincode || null);
    r.input('dwell',    sql.Int,           Math.max(1, Math.min(240, parseInt(b.dwellMinForVisit) || 10)));
    r.input('createdBy',sql.Int,           req.user.id);

    const out = await r.query(`
      INSERT INTO [dbo].[HRM_Geofence]
        (Name, Kind, CustomerCode, Company, CenterLat, CenterLng, RadiusM,
         Address, City, State, Pincode, DwellMinForVisit, CreatedBy)
      OUTPUT INSERTED.GeofenceId, INSERTED.CreatedAt
      VALUES
        (@name, @kind, @custCode, @company, @lat, @lng, @radius,
         @address, @city, @state, @pincode, @dwell, @createdBy);
    `);
    visitDetector.invalidateGeofenceCache();
    anomalyDetector.invalidateCaches();
    return res.status(201).json({ ok: true, geofenceId: out.recordset[0].GeofenceId, createdAt: out.recordset[0].CreatedAt });
  } catch (err) {
    console.error('[POST /api/hr/geofence] failed:', err.message);
    return res.status(500).json({ message: 'Create failed', detail: err.message });
  }
});

// ── PUT /:id ────────────────────────────────────────────────────────────────
router.put('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const b = req.body || {};
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();

    // Build dynamic SET clause from supplied fields
    const sets = [];
    const r = pool.request().input('id', sql.Int, id);
    function add(field, value, type) {
      if (value === undefined) return;
      sets.push(`${field} = @${field}`);
      r.input(field, type, value === null ? null : value);
    }
    if (b.name !== undefined)             add('Name',             b.name && b.name.trim(),                 sql.NVarChar(200));
    if (b.kind !== undefined)             add('Kind',             (b.kind || 'customer').trim(),           sql.NVarChar(20));
    if (b.customerCode !== undefined)     add('CustomerCode',     b.customerCode ? b.customerCode.trim() : null, sql.NVarChar(50));
    if (b.company !== undefined)          add('Company',          b.company ? b.company.trim() : null,     sql.NVarChar(10));
    if (b.centerLat !== undefined)        add('CenterLat',        Number(b.centerLat),                     sql.Decimal(9, 6));
    if (b.centerLng !== undefined)        add('CenterLng',        Number(b.centerLng),                     sql.Decimal(9, 6));
    if (b.radiusM !== undefined)          add('RadiusM',          Math.max(10, Math.min(5000, parseInt(b.radiusM) || 100)), sql.Int);
    if (b.address !== undefined)          add('Address',          b.address || null,                       sql.NVarChar(500));
    if (b.city !== undefined)             add('City',             b.city    || null,                       sql.NVarChar(100));
    if (b.state !== undefined)            add('State',            b.state   || null,                       sql.NVarChar(100));
    if (b.pincode !== undefined)          add('Pincode',          b.pincode || null,                       sql.NVarChar(10));
    if (b.dwellMinForVisit !== undefined) add('DwellMinForVisit', Math.max(1, Math.min(240, parseInt(b.dwellMinForVisit) || 10)), sql.Int);
    if (b.isActive !== undefined)         add('IsActive',         parseBool(b.isActive, true) ? 1 : 0,    sql.Bit);

    if (sets.length === 0) return res.status(400).json({ message: 'no fields to update' });
    sets.push('UpdatedAt = SYSDATETIME()');
    await r.query(`UPDATE [dbo].[HRM_Geofence] SET ${sets.join(', ')} WHERE GeofenceId = @id;`);
    visitDetector.invalidateGeofenceCache();
    anomalyDetector.invalidateCaches();
    return res.json({ ok: true, updated: sets.length - 1 });
  } catch (err) {
    console.error('[PUT /api/hr/geofence] failed:', err.message);
    return res.status(500).json({ message: 'Update failed', detail: err.message });
  }
});

// ── DELETE /:id (soft) ──────────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
    const pool = await getAppPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query(`UPDATE [dbo].[HRM_Geofence] SET IsActive = 0, UpdatedAt = SYSDATETIME() WHERE GeofenceId = @id;`);
    visitDetector.invalidateGeofenceCache();
    anomalyDetector.invalidateCaches();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Delete failed', detail: err.message });
  }
});

// ─── Google Places API proxy ────────────────────────────────────────────────
// Why proxy? Keeps the API key off the browser. Also lets us bias results to
// India and reuse session tokens for cheaper billing (autocomplete + details
// sharing a token = one billed session).
//
// Required env var: GOOGLE_PLACES_API_KEY
//   Get one at console.cloud.google.com → Places API → Credentials → API key
//   Restrict to HTTP referrer app.example.com/* and Places API only.
//
// Endpoints:
//   GET /places-suggest?q=text&sessionToken=uuid   → predictions array
//   GET /places-detail?placeId=ChIJ...&sessionToken=uuid → lat/lng + parts
// ────────────────────────────────────────────────────────────────────────────
// ── Places API (New) — places.googleapis.com/v1/* ─────────────────────────
// Switched from legacy maps.googleapis.com on 2026-05-25 because Google now
// disables the legacy API on new projects ("dpsApiNotActivatedMapError").
//
// New API differences:
//   • Endpoint: places.googleapis.com/v1/places:autocomplete (POST + JSON body)
//   • API key in header: X-Goog-Api-Key (not URL)
//   • Field mask in header: X-Goog-FieldMask  (controls billing — only pay for what we ask for)
//   • Response shape: { suggestions: [{ placePrediction: { placeId, text, structuredFormat } }] }
//
// We normalise the response to the legacy shape so the frontend stays unchanged:
//   { predictions: [{ place_id, description, structured_formatting: { main_text, secondary_text } }] }
router.get('/places-suggest', authenticate, async (req, res) => {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.json({ ok: false, predictions: [], message: 'GOOGLE_PLACES_API_KEY not configured on server' });
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ ok: true, predictions: [] });
  const sessionToken = (req.query.sessionToken || '').trim() || undefined;
  try {
    const body = {
      input: q,
      includedRegionCodes: ['in'],   // bias to India
    };
    if (sessionToken) body.sessionToken = sessionToken;
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Goog-Api-Key': key,
        // Only ask for the fields we render — minimises cost
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[places-suggest] Google HTTP', r.status, JSON.stringify(data));
      return res.status(502).json({ ok: false, message: `Google API HTTP ${r.status}`, detail: data && (data.error && data.error.message) });
    }
    // Normalise to legacy shape
    const predictions = (data.suggestions || []).map(s => {
      const p = s.placePrediction || {};
      return {
        place_id:    p.placeId || '',
        description: (p.text && p.text.text) || '',
        structured_formatting: {
          main_text:      (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text)      || '',
          secondary_text: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || '',
        },
      };
    });
    return res.json({ ok: true, predictions });
  } catch (err) {
    console.error('[places-suggest]', err.message);
    return res.status(500).json({ message: 'Places suggest failed', detail: err.message });
  }
});

router.get('/places-detail', authenticate, async (req, res) => {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(400).json({ message: 'GOOGLE_PLACES_API_KEY not configured on server' });
  const placeId = (req.query.placeId || '').trim();
  if (!placeId) return res.status(400).json({ message: 'placeId required' });
  const sessionToken = (req.query.sessionToken || '').trim() || undefined;
  try {
    const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
    if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
    const r = await fetch(url.toString(), {
      headers: {
        'X-Goog-Api-Key':    key,
        // Only ask for the fields we use — billing depends on the field mask
        'X-Goog-FieldMask': 'displayName,formattedAddress,location,addressComponents',
      },
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[places-detail] Google HTTP', r.status, JSON.stringify(data));
      return res.status(502).json({ ok: false, message: `Google API HTTP ${r.status}`, detail: data && (data.error && data.error.message) });
    }
    const comp = data.addressComponents || [];
    const findType = (t) => {
      const c = comp.find(c => (c.types || []).includes(t));
      return c ? (c.longText || c.shortText || '') : '';
    };
    return res.json({
      ok: true,
      name:    (data.displayName && data.displayName.text) || '',
      address: data.formattedAddress || '',
      lat:     data.location && data.location.latitude,
      lng:     data.location && data.location.longitude,
      city:    findType('locality') || findType('administrative_area_level_2') || '',
      state:   findType('administrative_area_level_1') || '',
      pincode: findType('postal_code') || '',
      country: findType('country') || '',
    });
  } catch (err) {
    console.error('[places-detail]', err.message);
    return res.status(500).json({ message: 'Places detail failed', detail: err.message });
  }
});

// ── GET /customer-suggest?q=...&company=COMPANYA ─────────────────────────────────
// NAV-side autocomplete. Read-only via getPool (NAV pool is wrapped READ UNCOMMITTED).
router.get('/customer-suggest', authenticate, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ ok: true, customers: [] });

    const company = getCompany(req);
    const P = company.prefix;
    const pool = await getPool();
    const r = await pool.request()
      .input('q', sql.NVarChar(200), '%' + q + '%')
      .query(`
        SELECT TOP 20
          c.[No_]       AS CustomerCode,
          c.[Name]      AS CustomerName,
          c.[Address]   AS Address,
          c.[City]      AS City,
          c.[Post Code] AS Pincode,
          c.[County]    AS State
        FROM ${P}Customer] c
        WHERE ISNULL(LTRIM(RTRIM(c.[Name])),'') <> ''
          AND (
            c.[Name] COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @q
            OR c.[No_] COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @q
            OR ISNULL(c.[City],'') COLLATE SQL_Latin1_General_CP1_CI_AS LIKE @q
          )
        ORDER BY c.[Name];
      `);
    return res.json({ ok: true, customers: r.recordset, company: company.code });
  } catch (err) {
    console.error('[/api/hr/geofence/customer-suggest] failed:', err.message);
    return res.status(500).json({ message: 'Customer suggest failed', detail: err.message });
  }
});

module.exports = router;
