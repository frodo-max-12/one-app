// ============================================================================
// ONE App Lens — Universal location tracker (Phase 2.1)
//
// Continuously pings /api/hr/location/ping while the user is signed in for
// the day. Auto-stops on sign-out, session expiry, or auth loss.
//
// Two backends, transparent to callers:
//   1. Capacitor (Android APK): uses @capacitor-community/background-geolocation
//      with a persistent foreground service so the OS won't kill it.
//   2. Browser  (desktop dev) : navigator.geolocation.watchPosition (foreground
//      only — useful for testing the pipeline before APK rebuild).
//
// BATTERY-ADAPTIVE tracking (2026-05-28, tightened 2026-06-15 for road-grade
// route quality + a fresh live-location map) — field staff often have no
// charger, so the tracker auto-coarsens as the battery drops:
//   battery > 30%  → NORMAL   : 15 m  / 25 s  (road-quality track, fresh live dot)
//   battery 15-30% → ECO      : 50 m  / 60 s  (balanced)
//   battery < 15%  → SURVIVAL : 150 m / 180 s (rough location, max uptime)
//   charging       → forced NORMAL (no need to conserve)
// distanceM is the native GPS distanceFilter (drives route resolution while
// moving); minIntervalMs is the stationary heartbeat (keeps the live map fresh
// when the rep is parked at a shop). Lowered from 25 m/60 s so turns are
// captured and the live view updates ~every 25 s instead of every minute.
// Battery is re-checked every 2 min; when the tier changes the Capacitor watcher
// is restarted with the new distanceFilter. Browser mode just adopts the new
// send thresholds.
//
// Usage:
//   • Auto-starts on every page load if the user has an OPEN HRM_Attendance
//     session (verified via GET /api/hr/attendance/today).
//   • Explicit control: window.LensTracker.start() / .stop()
// ============================================================================

(function () {
  // Battery-adaptive tiers — pick the first (top-down) whose threshold the
  // current battery meets. distanceM drives the native GPS wake frequency
  // (the main battery cost); minIntervalMs caps how often we send.
  const TIERS = [
    { name: 'normal',   minPct: 30, distanceM: 15,  minIntervalMs: 25  * 1000 },
    { name: 'eco',      minPct: 15, distanceM: 50,  minIntervalMs: 60  * 1000 },
    { name: 'survival', minPct: 0,  distanceM: 150, minIntervalMs: 180 * 1000 },
  ];
  const BATTERY_POLL_MS = 120 * 1000;   // re-check battery every 2 min
  const TRACKER_VERSION = 4;
  const STORAGE_KEY     = 'lens_tracker_state';

  let watcherId       = null;     // Capacitor watcher UUID
  let browserWatchId  = null;     // browser watchPosition handle
  let lastPingTime    = 0;
  let lastPingLat     = null;
  let lastPingLng     = null;
  let isActive        = false;
  let isStarting      = false;
  let currentTier     = TIERS[0]; // start optimistic; first battery read corrects it
  let lastBatteryPct  = null;
  let batteryTimer    = null;

  const log  = (...a) => console.log('[LensTracker]', ...a);
  const warn = (...a) => console.warn('[LensTracker]', ...a);

  function isCapacitor() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }
  function getToken() {
    return localStorage.getItem('nav_token') || sessionStorage.getItem('nav_token');
  }
  function getCompany() {
    return sessionStorage.getItem('nav_company') || 'COMPANYA';
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (x) => (Number(x) * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function shouldSendPing(lat, lng) {
    const now = Date.now();
    if (lastPingTime === 0) return true;
    if (now - lastPingTime >= currentTier.minIntervalMs) return true;
    if (lastPingLat != null && haversineM(lastPingLat, lastPingLng, lat, lng) >= currentTier.distanceM) return true;
    return false;
  }

  // ── Battery-adaptive logic ─────────────────────────────────────────────────
  async function readBattery() {
    try {
      if (isCapacitor() && window.Capacitor.Plugins && window.Capacitor.Plugins.Device) {
        const info = await window.Capacitor.Plugins.Device.getBatteryInfo();
        return {
          pct:      info.batteryLevel != null ? Math.round(info.batteryLevel * 100) : null,
          charging: !!info.isCharging,
        };
      }
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        return { pct: Math.round(b.level * 100), charging: !!b.charging };
      }
    } catch (_) { /* fall through */ }
    return { pct: null, charging: false };
  }

  function pickTier(pct, charging) {
    if (pct == null || charging) return TIERS[0];   // unknown battery or charging → full quality
    return TIERS.find(t => pct >= t.minPct) || TIERS[TIERS.length - 1];
  }

  async function applyTierFromBattery() {
    const { pct, charging } = await readBattery();
    lastBatteryPct = pct;
    const target = pickTier(pct, charging);
    if (target.name === currentTier.name) return;
    const prev = currentTier;
    currentTier = target;
    log(`battery ${pct == null ? '?' : pct + '%'}${charging ? ' (charging)' : ''} → mode ${target.name} (${target.distanceM}m / ${target.minIntervalMs / 1000}s)`);
    // Capacitor must restart the watcher to change distanceFilter; browser mode
    // picks up the new thresholds in shouldSendPing automatically.
    if (isActive && isCapacitor() && target.distanceM !== prev.distanceM) {
      await restartCapacitorWatcher();
    }
  }

  async function sendPing(payload) {
    const token = getToken();
    if (!token) { stop(); return; }
    try {
      const res = await fetch('/api/hr/location/ping?company=' + encodeURIComponent(getCompany()), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Company': getCompany(),
          'Authorization': token,
        },
        body: JSON.stringify(payload),
      });
      if (res.status === 401 || res.status === 403) {
        warn('auth lost — stopping');
        stop();
        return;
      }
      if (res.ok) {
        lastPingTime = Date.now();
        lastPingLat  = payload.lat;
        lastPingLng  = payload.lng;
      }
    } catch (err) {
      warn('ping failed:', err.message);
    }
  }

  // ── Capacitor path ───────────────────────────────────────────────────────
  async function startCapacitorWatcher() {
    const plugin = window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation;
    if (!plugin) {
      warn('BackgroundGeolocation plugin not bundled in this APK — falling back to browser mode');
      return startBrowser();
    }
    // Clean up any pre-existing watcher (previous page-load OR a tier restart)
    const prev = sessionStorage.getItem(STORAGE_KEY);
    if (prev) {
      try { await plugin.removeWatcher({ id: prev }); } catch (_) {}
      sessionStorage.removeItem(STORAGE_KEY);
    }
    watcherId = await plugin.addWatcher({
      backgroundMessage: 'ONE App Lens is tracking your location while you are signed in.',
      backgroundTitle:   'ONE App Lens · Active',
      requestPermissions: true,
      stale: false,
      distanceFilter: currentTier.distanceM,
    }, (location, error) => {
      if (error) { warn('geo error:', error.code, error.message); return; }
      if (!location) return;
      if (!shouldSendPing(location.latitude, location.longitude)) return;
      sendPing({
        lat:        location.latitude,
        lng:        location.longitude,
        accuracy:   location.accuracy,
        speedMps:   location.speed,
        headingDeg: location.bearing,
        altitude:   location.altitude,
        isMocked:   location.simulated || false,
        batteryPct: lastBatteryPct,
        // REAL GPS fix time. The background plugin buffers fixes while the app is
        // backgrounded and then delivers them in a burst; without this the server
        // stamps them all with arrival-time, collapsing a whole drive into one
        // second and scrambling the journey order. location.time = epoch ms.
        pingTime:   location.time ? new Date(location.time).toISOString() : undefined,
        source:     'gps',
      });
    });
    sessionStorage.setItem(STORAGE_KEY, watcherId);
    log('Capacitor watcher started:', watcherId, '· mode', currentTier.name);
  }

  async function restartCapacitorWatcher() {
    try {
      if (watcherId !== null) {
        try { await window.Capacitor.Plugins.BackgroundGeolocation.removeWatcher({ id: watcherId }); } catch (_) {}
        watcherId = null;
      }
      await startCapacitorWatcher();
    } catch (e) {
      warn('restart watcher failed:', e && e.message);
    }
  }

  // ── Browser fallback ─────────────────────────────────────────────────────
  function startBrowser() {
    if (!navigator.geolocation) { warn('Geolocation unsupported'); return; }
    browserWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!shouldSendPing(pos.coords.latitude, pos.coords.longitude)) return;
        sendPing({
          lat:        pos.coords.latitude,
          lng:        pos.coords.longitude,
          accuracy:   pos.coords.accuracy,
          speedMps:   pos.coords.speed,
          headingDeg: pos.coords.heading,
          altitude:   pos.coords.altitude,
          batteryPct: lastBatteryPct,
          pingTime:   pos.timestamp ? new Date(pos.timestamp).toISOString() : undefined,
          source:     'gps',
        });
      },
      (err) => warn('browser geo error:', err.message),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 }
    );
    log('browser watcher started:', browserWatchId, '· mode', currentTier.name);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  async function start() {
    if (isActive || isStarting) return;
    isStarting = true;
    try {
      // Set the right tier from current battery BEFORE starting the watcher,
      // so a low phone starts in eco/survival rather than full-rate.
      await applyTierFromBattery();
      if (isCapacitor()) await startCapacitorWatcher();
      else               startBrowser();
      isActive = true;
      // Begin periodic battery re-checks (re-tunes the tier as charge drops).
      if (batteryTimer) clearInterval(batteryTimer);
      batteryTimer = setInterval(() => { applyTierFromBattery().catch(() => {}); }, BATTERY_POLL_MS);
    } finally {
      isStarting = false;
    }
  }

  async function stop() {
    if (!isActive) return;
    isActive = false;
    if (batteryTimer) { clearInterval(batteryTimer); batteryTimer = null; }
    if (watcherId !== null && isCapacitor()) {
      try {
        await window.Capacitor.Plugins.BackgroundGeolocation.removeWatcher({ id: watcherId });
      } catch (_) {}
      watcherId = null;
      sessionStorage.removeItem(STORAGE_KEY);
    }
    if (browserWatchId !== null) {
      navigator.geolocation.clearWatch(browserWatchId);
      browserWatchId = null;
    }
    log('stopped');
  }

  // Continuous background tracking is for FIELD staff only (Sales / FAE) — the
  // people who go out on customer visits. Office roles (Product, HR, Account, CSR,
  // IT, MIS, Store, Warehouse, admin) are NOT continuously tracked. Their
  // login/logout location IS still captured by the Home sign-in/out (one-time GPS
  // + selfie, incl. WFH) — only the intra-day trail is skipped. (2026-06-27)
  const FIELD_TRACK_ROLES = [
    'sales', 'international sales', 'north sales', 'south sales',
    'sales head', 'north sales head', 'sales head electrical', 'electrical head',
    'fae', 'fae head',
  ];
  function currentRole() {
    try { return (JSON.parse(localStorage.getItem('nav_user') || sessionStorage.getItem('nav_user') || '{}').role || '').toLowerCase().trim(); }
    catch (_) { return ''; }
  }

  // Auto-start on page load if today's attendance session is OPEN
  async function autoStart() {
    const token = getToken();
    if (!token) return;
    const role = currentRole();
    if (!FIELD_TRACK_ROLES.includes(role)) { log('continuous tracking skipped — office role: ' + (role || '(none)')); return; }
    try {
      const res = await fetch('/api/hr/attendance/today?company=' + encodeURIComponent(getCompany()), {
        headers: { 'Authorization': token, 'X-Company': getCompany() },
      });
      if (!res.ok) return;
      const data = await res.json();
      const today = data && data.today;
      if (today && today.SignInTime && !today.SignOutTime) {
        await start();
      }
    } catch (_) { /* silent */ }
  }

  window.LensTracker = {
    start, stop, autoStart,
    isActive:  () => isActive,
    version:   TRACKER_VERSION,
    backend:   () => isCapacitor() ? 'capacitor' : 'browser',
    mode:      () => currentTier.name,
    battery:   () => lastBatteryPct,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart);
  } else {
    setTimeout(autoStart, 200);
  }
})();
