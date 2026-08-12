// Client-side Web Push helpers (Tier 2 notifications). Browser-only — imported
// by the notification provider to register/unregister a push subscription with
// the server. Kept free of React so the pure bits (urlBase64ToUint8Array) can be
// unit-tested in the node env.

/** Web Push needs a service worker, the Push API, and the Notifications API. */
export function isPushSupported(): boolean {
    return (
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    );
}

/**
 * Decode a URL-safe base64 VAPID public key into the Uint8Array that
 * PushManager.subscribe() expects as applicationServerKey.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    // Back the view with a concrete ArrayBuffer (not ArrayBufferLike) so the
    // result is a valid BufferSource for PushManager.applicationServerKey.
    const output = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i += 1) {
        output[i] = raw.charCodeAt(i);
    }
    return output;
}

/**
 * Ensure this device has a push subscription and register it with the server.
 * Idempotent: reuses an existing browser subscription when present, and the
 * server upserts on the endpoint. Returns false when unsupported / not configured
 * / the server rejected the subscription.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<boolean> {
    if (!isPushSupported() || !vapidPublicKey) return false;
    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
            });
        }
        const json = sub.toJSON();
        const res = await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                endpoint: sub.endpoint,
                keys: json.keys,
                userAgent: navigator.userAgent,
            }),
        });
        return res.ok;
    } catch {
        // Permission revoked mid-flight, push service unreachable, etc. — the
        // in-tab Tier 1 path still covers the operator, so fail quietly.
        return false;
    }
}

/**
 * Drop this device's push subscription, both in the browser and on the server.
 * Best-effort; safe to call when there's nothing to remove.
 */
export async function unsubscribeFromPush(): Promise<void> {
    if (!isPushSupported()) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        const { endpoint } = sub;
        await sub.unsubscribe().catch(() => {});
        await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint }),
        }).catch(() => {});
    } catch {
        /* no-op */
    }
}
