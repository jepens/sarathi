// Client-safe UUID helpers for the Portal handoff.
//
// CLIENT-SAFE: imported by the `'use client'` picker dialog, so it must NOT pull
// in any server-only module (e.g. lib/portal/config.ts, node:crypto).
//
// Why not just crypto.randomUUID()? That API is SECURE-CONTEXT only — it's
// `undefined` over plain HTTP on a non-localhost origin (common for internal LAN
// tools). crypto.getRandomValues() has no such restriction, so it runs anywhere.
// Every helper here emits a v4-shaped UUID (version nibble `4`, variant `8..b`)
// which passes zod's z.uuid() (accepts v1–v8; verified against zod's regex).

/** Format 16 bytes as a v4-shaped UUID string (valid for z.uuid()). */
export function uuidFromBytes(bytes: Uint8Array): string {
    const b = bytes.slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A random UUID — uses crypto.randomUUID when available, else falls back to
 * crypto.getRandomValues (works in a non-secure/plain-HTTP context).
 */
export function safeRandomUUID(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return uuidFromBytes(bytes);
}

/**
 * A DETERMINISTIC UUID from a seed string (synchronous, non-crypto hash — no
 * crypto API, so it runs over plain HTTP too). NOT for security: its only job is
 * to make two identical first-handoff selections collide on ONE idempotency key
 * so the Portal dedups them into a single client instead of creating duplicates.
 */
export function deterministicUuid(seed: string): string {
    return uuidFromBytes(hash128(seed));
}

// cyrb128: a synchronous 128-bit digest (4×32-bit) → 16 bytes.
function hash128(str: string): Uint8Array {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
        const k = str.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    const out = new Uint8Array(16);
    [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0].forEach((h, i) => {
        out[i * 4] = h & 0xff;
        out[i * 4 + 1] = (h >>> 8) & 0xff;
        out[i * 4 + 2] = (h >>> 16) & 0xff;
        out[i * 4 + 3] = (h >>> 24) & 0xff;
    });
    return out;
}
