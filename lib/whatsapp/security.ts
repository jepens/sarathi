import crypto from 'crypto';
import { whatsappLogger } from '@/lib/utils/logger';

/**
 * Verify WhatsApp webhook signature.
 *
 * Meta sends `X-Hub-Signature-256: sha256=<hmac>` where the HMAC is computed
 * over the *raw* request body using the App Secret. See:
 *   https://developers.facebook.com/docs/business-messaging/whatsapp/webhooks/create-webhook-endpoint
 *
 * Returns `true` only when the signature matches. All other paths (missing
 * header, no configured app secret, malformed hex, length mismatch) return
 * `false` so callers can simply reject with 403 on a falsy result.
 *
 * @param payload   The raw request body: the exact bytes Meta signed (a
 *                  Buffer, as the webhook passes it), or a string, which is
 *                  hashed as UTF-8. Never a re-stringified parsed object.
 * @param signature Value of the `X-Hub-Signature-256` header (with or without
 *                  the `sha256=` prefix).
 * @param appSecret The secret of the Meta app the request claims to come from
 *                  (read from Vault, lib/whatsapp/credentials.ts); null
 *                  when none is configured, which rejects every request.
 */
export async function verifyWhatsAppSignature(
    payload: Buffer | string,
    signature: string | null,
    appSecret: string | null
): Promise<boolean> {
    if (!signature) {
        whatsappLogger.warn('Webhook signature header missing');
        return false;
    }

    // No secret resolved (Vault could not read the app's secret): nothing can
    // be verified, so reject.
    if (!appSecret) {
        whatsappLogger.warn('No app secret for this webhook app — cannot verify webhook');
        return false;
    }

    // Strip the optional `sha256=` prefix
    const signatureHash = signature.startsWith('sha256=')
        ? signature.slice(7)
        : signature;

    // Reject anything that isn't a 64-char lowercase-hex string up-front.
    // This also prevents `Buffer.from(..., 'hex')` from silently truncating
    // on invalid characters (it stops parsing at the first non-hex byte).
    if (!/^[0-9a-f]{64}$/i.test(signatureHash)) {
        whatsappLogger.warn('Webhook signature is not a valid 64-char hex string');
        return false;
    }

    let expectedBuf: Buffer;
    let providedBuf: Buffer;
    try {
        const hmac = crypto.createHmac('sha256', appSecret);
        if (typeof payload === 'string') hmac.update(payload, 'utf8');
        else hmac.update(payload);
        expectedBuf = hmac.digest();
        providedBuf = Buffer.from(signatureHash, 'hex');
    } catch (error) {
        whatsappLogger.error('Failed to compute webhook HMAC', error);
        return false;
    }

    // Length mismatch would throw inside timingSafeEqual; guard explicitly.
    if (providedBuf.length !== expectedBuf.length) {
        whatsappLogger.warn('Webhook signature length mismatch');
        return false;
    }

    return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
