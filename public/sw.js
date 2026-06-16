// Minimal service worker for installability + an offline fallback page.
// Deliberately conservative: it does NOT cache Next.js's hashed assets (which
// would risk serving stale code) — it only intercepts top-level navigations and
// serves a cached offline page when the network is unavailable.
const CACHE = 'helat-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.mode !== 'navigate') return; // let assets/data hit the network
    event.respondWith(
        fetch(request).catch(async () => {
            const cache = await caches.open(CACHE);
            const cached = await cache.match(OFFLINE_URL);
            return cached ?? Response.error();
        })
    );
});
