import crypto from 'crypto';

// The webhook body as Meta signed it, read up to Meta's size limit (anyone
// can POST to the URL), and the shape checks of a per-app URL (Fase 2 task
// 2.2c) that run before any database call.

// Meta's largest webhook payload (developers.facebook.com, set-up-webhooks).
export const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024;

/** The key of a per-app webhook URL: whatsapp_apps.webhook_key (migration 0073). */
export const WEBHOOK_KEY = /^[A-Za-z0-9_-]{32}$/;

/** X-Hub-Signature-256 as Meta always sends it. */
export const SIGNATURE_HEADER = /^sha256=[0-9a-fA-F]{64}$/;

/**
 * Whether the verify token Meta sent hashes to the stored sha256 (hex, as
 * wa_webhook_app returns it), compared in constant time.
 */
export function verifyTokenMatches(token: string, sha256Hex: string): boolean {
    const expected = Buffer.from(sha256Hex, 'hex');
    const actual = crypto.createHash('sha256').update(token, 'utf8').digest();
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

// The request body, or null when it is over MAX_WEBHOOK_BYTES: by the declared
// length before reading, else while reading (a chunked body is cancelled as
// soon as it passes the limit).
export async function readBodyCapped(request: Request): Promise<Buffer | null> {
    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
    if (!request.body) return Buffer.alloc(0);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_WEBHOOK_BYTES) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}
