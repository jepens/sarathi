import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// security.ts takes the app secret from its caller (the webhook passes the env
// app's, lib/whatsapp/credentials.ts) and reads no env itself (Fase 2 task
// 2.2b). The logger is mocked to keep the output quiet.
vi.mock('@/lib/utils/logger', () => ({
    whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';

const SECRET = 'test-app-secret';
const PAYLOAD = '{"object":"whatsapp_business_account","entry":[]}';
const validHex = crypto.createHmac('sha256', SECRET).update(PAYLOAD, 'utf8').digest('hex');

beforeEach(() => {
    vi.clearAllMocks();
});

describe('verifyWhatsAppSignature', () => {
    it('accepts a correct signature, with or without the sha256= prefix', async () => {
        expect(await verifyWhatsAppSignature(PAYLOAD, validHex, SECRET)).toBe(true);
        expect(await verifyWhatsAppSignature(PAYLOAD, `sha256=${validHex}`, SECRET)).toBe(true);
    });

    it('rejects a tampered payload (HMAC no longer matches)', async () => {
        expect(await verifyWhatsAppSignature(`${PAYLOAD} `, validHex, SECRET)).toBe(false);
    });

    it('rejects a signature computed with a different secret', async () => {
        const wrong = crypto.createHmac('sha256', 'other-secret').update(PAYLOAD, 'utf8').digest('hex');
        expect(await verifyWhatsAppSignature(PAYLOAD, wrong, SECRET)).toBe(false);
    });

    it('rejects a missing header or an unconfigured app secret', async () => {
        expect(await verifyWhatsAppSignature(PAYLOAD, null, SECRET)).toBe(false); // no header
        expect(await verifyWhatsAppSignature(PAYLOAD, validHex, null)).toBe(false); // explicit "no secret"
        expect(await verifyWhatsAppSignature(PAYLOAD, validHex, '')).toBe(false); // empty secret
    });

    it('rejects malformed (non-64-hex) signatures without throwing', async () => {
        expect(await verifyWhatsAppSignature(PAYLOAD, 'sha256=not-hex-at-all', SECRET)).toBe(false);
        expect(await verifyWhatsAppSignature(PAYLOAD, 'abc', SECRET)).toBe(false);
        expect(await verifyWhatsAppSignature(PAYLOAD, validHex.slice(0, 63), SECRET)).toBe(false);
        expect(await verifyWhatsAppSignature(PAYLOAD, `${validHex}ab`, SECRET)).toBe(false);
    });

    it('checks the exact raw bytes when given a Buffer (Fase 2 task 2.2a)', async () => {
        // Not valid UTF-8: decoding to a string and re-encoding would change the
        // bytes (0xff becomes U+FFFD), so only an HMAC over the raw bytes matches.
        const raw = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
        const hex = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
        expect(await verifyWhatsAppSignature(raw, hex, SECRET)).toBe(true);
        expect(await verifyWhatsAppSignature(raw.toString('utf8'), hex, SECRET)).toBe(false);
        expect(await verifyWhatsAppSignature(Buffer.from(PAYLOAD, 'utf8'), validHex, SECRET)).toBe(true);
    });

    it('reads no env secret: with none passed, nothing verifies', async () => {
        vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
        try {
            expect(await verifyWhatsAppSignature(PAYLOAD, validHex, null)).toBe(false);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
