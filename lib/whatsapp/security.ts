import crypto from 'crypto';
import { getWhatsAppAppSecret } from '@/lib/settings/app-settings';
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
 * @param payload   Raw request body as string. MUST be the exact bytes Meta
 *                  signed — do not re-stringify a parsed JSON object.
 * @param signature Value of the `X-Hub-Signature-256` header (with or without
 *                  the `sha256=` prefix).
 */
export async function verifyWhatsAppSignature(
    payload: string,
    signature: string | null,
    appSecretOverride?: string | null
): Promise<boolean> {
    if (!signature) {
        whatsappLogger.warn('Webhook signature header missing');
        return false;
    }

    // `undefined` → fall back to the env app secret (legacy/single-tenant
    // callers). An explicit `null` means "this org has no app_secret configured"
    // → we can't verify, so reject. A string is the resolved per-tenant secret.
    const appSecret =
        appSecretOverride === undefined
            ? await getWhatsAppAppSecret()
            : appSecretOverride;
    if (!appSecret) {
        whatsappLogger.warn(
            'WHATSAPP_APP_SECRET env var is not set — cannot verify webhook. ' +
                'Set it (from Meta App Settings → Basic → App Secret) or, for local dev only, ' +
                'set WHATSAPP_WEBHOOK_SKIP_SIGNATURE=true to bypass verification.'
        );
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
        expectedBuf = crypto
            .createHmac('sha256', appSecret)
            .update(payload, 'utf8')
            .digest();
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
