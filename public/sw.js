// Minimal service worker for installability + an offline fallback page.
// Deliberately conservative: it does NOT cache Next.js's hashed assets (which
// would risk serving stale code) — it only intercepts top-level navigations and
// serves a cached offline page when the network is unavailable.
const CACHE = 'sarathi-v2';
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

// Focus (or open) the app on the right conversation when a message notification
// is tapped. Notifications are shown via registration.showNotification() from
// the in-app notifier (see components/notifications), which stamps data.url.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    const url = data.url || '/dashboard/chats';
    event.waitUntil(
        (async () => {
            const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of all) {
                if ('focus' in client) {
                    await client.focus();
                    if ('navigate' in client) {
                        try {
                            await client.navigate(url);
                        } catch {
                            /* navigation not permitted — the focus alone is enough */
                        }
                    }
                    return;
                }
            }
            if (self.clients.openWindow) await self.clients.openWindow(url);
        })()
    );
});

// Tier 2 — Web Push. The server (webhook) sends a push for every new inbound
// message so the operator is alerted even with the app closed. The payload is
// { title, body, phone, url }. We reuse the SAME tag as the in-tab Tier 1
// notification (`wa:<phone>`) so the two collapse into ONE visible notification
// instead of stacking.
//
// Chime dedup: the in-tab Tier 1 realtime path already chimes AND shows its own
// (non-silent) notification whenever a dashboard tab is alive — focused OR merely
// hidden. So we gate on "is a dashboard tab open at all", NOT on "is it focused":
// when one is open, this push is SILENT + no-renotify (it just refreshes the
// shared-tag notification, honouring Chrome's userVisibleOnly without a second
// chime). Only when the app is fully closed (no dashboard client) does it ring.
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }
    const title = payload.title || 'Pesan WhatsApp baru';
    const body = payload.body || 'Ada pesan masuk';
    const phone = payload.phone || '';
    const url =
        payload.url ||
        (phone ? '/dashboard/chats?phone=' + encodeURIComponent(phone) : '/dashboard/chats');

    event.waitUntil(
        (async () => {
            const clients = await self.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
            });
            // A dashboard tab (where Tier 1 runs) being open means the in-app path
            // is already alerting — stay silent to avoid a double chime.
            const dashboardOpen = clients.some((c) => c.url && c.url.indexOf('/dashboard') !== -1);
            await self.registration.showNotification(title, {
                body,
                tag: phone ? 'wa:' + phone : 'wa',
                icon: '/icon-192x192.png',
                badge: '/icon-192x192.png',
                renotify: !dashboardOpen,
                silent: dashboardOpen,
                data: { url },
            });
        })()
    );
});
