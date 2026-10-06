// Service worker — offline app shell + stale-while-revalidate runtime cache.
//
// The precache list mirrors the assets actually loaded by index.html
// (including their ?v= cache-busting query strings) so that cache.match()
// hits while offline. Install uses allSettled rather than cache.addAll() so
// that a single missing/renamed asset can never reject the whole install and
// silently disable offline support (the bug that previously shipped).
const CACHE_NAME = 'kickzone-v5';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css?v=25',
  // Shared simulation core
  '/shared/constants.js?v=1',
  '/shared/physics.js?v=2',
  '/shared/entities.js?v=3',
  '/shared/ai.js?v=3',
  '/shared/powerups.js?v=2',
  // RL subsystem
  '/js/rl/nn.js?v=10',
  '/js/rl/encoder.js?v=10',
  '/js/rl/encoder2v2.js?v=1',
  '/js/rl/policy.js?v=10',
  '/js/rl/league.js?v=10',
  '/js/rl/trainer.js?v=13',
  '/js/rl/runtime.js?v=10',
  '/js/rl/runtime2v2.js?v=1',
  '/js/rl/orchestrator.js?v=18',
  '/js/rl/orchestrator2v2.js?v=2',
  '/js/rl/env.js?v=1',
  '/js/rl/drills.js?v=1',
  '/js/rl/skills.js?v=1',
  // Shipped AI models (fetched by js/ai-models.js)
  '/models/expert.json',
  '/models/skills.json',
  // Client app
  '/js/ai-models.js?v=1',
  '/js/skill-lab.js?v=1',
  '/js/audio.js?v=5',
  '/js/renderer.js?v=23',
  '/js/game.js?v=37',
  '/js/netplay.js?v=2',
  '/js/p2p.js?v=4',
  '/js/controls.js?v=25',
  '/js/ui.js?v=29',
  '/js/main.js?v=23',
  // Icons
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Tolerate individual failures so one stale entry can't brick install.
      Promise.allSettled(ASSETS.map(url => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Only handle same-origin GETs; let cross-origin (CDN, TURN, signaling) pass through.
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetched = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
