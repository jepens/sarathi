// Pure helpers for the Web Push fan-out + subscription endpoint (no I/O), kept
// out of web-push.ts (server-only) so they can be unit-tested.

export interface OwnedSubscriptionRow {
    endpoint: string;
    p256dh: string;
    auth: string;
    user_id: string;
}

/**
 * Keep only subscriptions whose owner is CURRENTLY a member of the org. A user
 * removed from the org (or whose row predates their removal) must stop
 * receiving that org's message previews (KEA-3 / KEA-23).
 */
export function filterSubscriptionsToMembers<T extends { user_id: string }>(
    subs: readonly T[],
    memberUserIds: Iterable<string>,
): T[] {
    const members = new Set(memberUserIds);
    return subs.filter((s) => members.has(s.user_id));
}

/**
 * True for Postgres "undefined_column" (42703) — e.g. selecting
 * push_subscriptions.user_id while migration 0058 is not applied yet.
 */
export function isUndefinedColumn(error: { code?: string | null } | null | undefined): boolean {
    return error?.code === '42703';
}

/** Max lengths we accept from the browser — generous vs. real-world values. */
const MAX_ENDPOINT_LEN = 2048;
const MAX_KEY_LEN = 256;

/**
 * Validate a PushSubscription posted by the browser. The endpoint must be an
 * https URL (every push service uses https); the keys are opaque base64url
 * strings. Returns null when anything is missing or malformed.
 */
export function parsePushSubscriptionBody(
    payload: unknown,
): { endpoint: string; p256dh: string; auth: string } | null {
    if (!payload || typeof payload !== 'object') return null;
    const body = payload as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
    const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
    const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
    if (!endpoint || !p256dh || !auth) return null;
    if (endpoint.length > MAX_ENDPOINT_LEN || p256dh.length > MAX_KEY_LEN || auth.length > MAX_KEY_LEN) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    return { endpoint, p256dh, auth };
}
