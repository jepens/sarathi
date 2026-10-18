import { describe, it, expect, vi, afterEach } from 'vitest';

// The WhatsApp env getters of app-settings (dashboard sends, templates,
// notifications) trim like lib/whatsapp/credentials.ts: a newline or tab pasted
// with a value must not break the Graph calls or the signature check. Fake
// values only.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/settings/platform-settings', () => ({ getPlatformSetting: vi.fn(async () => 'verify-token-palsu') }));

import {
    getWhatsAppAccessToken,
    getWhatsAppAppSecret,
    getWhatsAppBusinessAccountId,
    getWhatsAppPhoneNumberId,
    isWhatsAppConfigured,
} from '@/lib/settings/app-settings';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('WhatsApp env getters', () => {
    it('trim the values', async () => {
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', ' token-palsu\n');
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '100000000000001\r\n');
        vi.stubEnv('WHATSAPP_APP_SECRET', 'secret-palsu\t');
        vi.stubEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', ' 200000000000001 ');
        expect(await getWhatsAppAccessToken()).toBe('token-palsu');
        expect(await getWhatsAppPhoneNumberId()).toBe('100000000000001');
        expect(await getWhatsAppAppSecret()).toBe('secret-palsu');
        expect(await getWhatsAppBusinessAccountId()).toBe('200000000000001');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(await isWhatsAppConfigured({} as any)).toBe(true);
    });

    it('isWhatsAppConfigured checks each value after trimming', async () => {
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token-palsu');
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '\r\n');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(await isWhatsAppConfigured({} as any)).toBe(false);
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', ' ');
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '100000000000001');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(await isWhatsAppConfigured({} as any)).toBe(false);
    });

    it('treat a value of only whitespace as not set', async () => {
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', ' \n');
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '\t');
        vi.stubEnv('WHATSAPP_APP_SECRET', '  ');
        await expect(getWhatsAppAccessToken()).rejects.toThrow('not configured');
        await expect(getWhatsAppPhoneNumberId()).rejects.toThrow('not configured');
        expect(await getWhatsAppAppSecret()).toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(await isWhatsAppConfigured({} as any)).toBe(false);
    });
});
