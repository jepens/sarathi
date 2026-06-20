import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// security.ts imports getWhatsAppAppSecret (app-settings) + the logger. Mock both
// so the node test doesn't pull a server-only chain, and so we can drive the
// env-fallback path. Most tests pass an explicit appSecretOverride and never
// touch the mock.
vi.mock('@/lib/settings/app-settings', () => ({ getWhatsAppAppSecret: vi.fn() }));
vi.mock('@/lib/utils/logger', () => ({
    whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';
import { getWhatsAppAppSecret } from '@/lib/settings/app-settings';

const getSecretMock = vi.mocked(getWhatsAppAppSecret);

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

    it('falls back to the env app secret when no override is given', async () => {
        getSecretMock.mockResolvedValue(SECRET);
        expect(await verifyWhatsAppSignature(PAYLOAD, validHex)).toBe(true);

        getSecretMock.mockResolvedValue(null); // env var not set
        expect(await verifyWhatsAppSignature(PAYLOAD, validHex)).toBe(false);
    });
});
