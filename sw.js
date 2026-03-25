const CACHE_NAME = 'kickzone-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/main.js',
  '/js/game.js',
  '/js/physics.js',
  '/js/renderer.js',
  '/js/entities.js',
  '/js/ai.js',
  '/js/learning-ai.js',
  '/js/network.js',
  '/js/controls.js',
  '/js/ui.js',
  '/js/audio.js',
  '/js/powerups.js',
  '/js/training-worker.js',
  '/models/kickzone-model.json',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
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
