// =====================================================================
// service-worker.js — ONE App PWA offline shell + smart caching
//
// Strategy (Phase 2.6 — switched 2026-05-20 from cache-first to network-first):
//   - On install: pre-cache the shell so the UI can open offline as a fallback.
//   - On fetch:
//       /api/*           → network-only (data must always be fresh).
//       cross-origin     → network-only (fonts, CDN libs handled by browser).
//       same-origin GET  → NETWORK-FIRST. Try the network; on success update
//                          the cache silently; on network failure fall back
//                          to the cached copy; final fallback is /index.html.
//   - On activate: purge old cache versions.
//
// Why network-first:
//   The previous cache-first strategy meant code changes (CSS/JS/HTML/sidebar
//   modules.js) only reached users after a hard refresh, because the SW
//   returned stale cached files before talking to the network. Network-first
//   gives every page load the freshest content; cache exists only for
//   offline support. Cost: one extra network round-trip per asset (already
//   trivial on broadband; negligible vs the dev/UX win).
//
// To force a refresh of cached files: bump CACHE_VERSION below.
// =====================================================================

const CACHE_VERSION = 'oneapp-v155-1.13-2026-08-25'; // DC: Line FAE in Add form + PM & Line FAE chart-assign buttons. dc.js?v=24.

const SHELL = [
  '/',
  '/index.html',
  '/select-company.html',
  '/manifest.json',
  '/images/app-icon.svg',
  '/images/company-a-logo.png',
  '/images/company-b-logo.png',
  '/shared/common.css',
  '/shared/common.js',
  '/shared/login.css',
  '/shared/login.js',
  '/shared/responsive.css',
  '/shared/theme.css',
  '/shared/select-company.css',
  '/shared/select-company.js',
  '/shared/modules.js',
  '/shared/mobile-menu.js',
  '/shared/lens-tracker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      for (const url of SHELL) {
        try { await cache.add(url); } catch (e) {
          console.warn('[SW] could not cache', url, e.message);
        }
      }
    })
  );
  // Take over immediately so the new strategy kicks in on next navigation
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept API responses — data freshness matters more than offline.
  if (url.pathname.startsWith('/api/')) return;
  // Cross-origin (fonts, CDN libs) — let the browser handle normally.
  if (url.origin !== self.location.origin) return;

  // ── NETWORK-FIRST ────────────────────────────────────────────────────────
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only mirror to cache when the response is a clean basic 200 — skip
        // partial / opaque / redirected ones to avoid serving broken assets offline.
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match('/index.html'))
      )
  );
});
