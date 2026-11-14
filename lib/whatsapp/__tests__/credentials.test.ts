import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The WhatsApp credential resolver (Fase 2 task 2.2b), Phase 0: the env
// credentials serve the default org only, read strictly; every other org gets
// WhatsAppNotConfiguredError, never the default org's number. The env values
// are trimmed (a newline or tab pasted with a value must not break the Graph
// calls or the signature check). Fake ids and tokens only.

const DEFAULT_ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';

const h = vi.hoisted(() => ({
    defaultOrg: vi.fn(),
    serviceClient: { tag: 'service-client' },
    createService: vi.fn(),
}));

vi.mock('@/lib/settings/org-context', () => ({ getDefaultOrgIdStrict: h.defaultOrg }));
vi.mock('@/lib/supabase/service', () => ({ createServiceOrServerClient: h.createService }));

import {
    assertCanSend,
    canSend,
    envWebhookApp,
    envWhatsAppSendConfigured,
    getOrgWhatsAppCreds,
    resolveWhatsAppContext,
    WhatsAppNotConfiguredError,
} from '@/lib/whatsapp/credentials';
import { GRAPH_API_VERSION } from '@/lib/whatsapp/graph';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = { tag: 'caller-client' } as any;

beforeEach(() => {
    vi.clearAllMocks();
    h.defaultOrg.mockResolvedValue(DEFAULT_ORG);
    h.createService.mockResolvedValue(h.serviceClient);
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', ' 100000000000001\r\n');
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token-palsu\n');
    vi.stubEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', ' 200000000000001 ');
    vi.stubEnv('WHATSAPP_APP_SECRET', 'secret-palsu\t');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('getOrgWhatsAppCreds', () => {
    it('the default org gets the env credentials, trimmed', async () => {
        await expect(getOrgWhatsAppCreds(DEFAULT_ORG, client)).resolves.toEqual({
            orgId: DEFAULT_ORG,
            integrationId: null,
            phoneNumberId: '100000000000001',
            wabaId: '200000000000001',
            accessToken: 'token-palsu',
            graphVersion: GRAPH_API_VERSION,
        });
        expect(h.defaultOrg).toHaveBeenCalledWith(client);
        expect(h.createService).not.toHaveBeenCalled();
    });

    it('any other org gets WhatsAppNotConfiguredError, never the default org number', async () => {
        await expect(getOrgWhatsAppCreds(OTHER_ORG, client)).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
        await expect(getOrgWhatsAppCreds('', client)).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
    });

    it('the default org without a number or a token (or only whitespace) is not configured', async () => {
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', ' \n');
        await expect(getOrgWhatsAppCreds(DEFAULT_ORG, client)).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token-palsu');
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '\t');
        await expect(getOrgWhatsAppCreds(DEFAULT_ORG, client)).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
    });

    it('a WABA that is not set is null (text sends need none; templates refuse it)', async () => {
        vi.stubEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', '  ');
        await expect(getOrgWhatsAppCreds(DEFAULT_ORG, client)).resolves.toMatchObject({ wabaId: null });
    });

    it('a default-org read error is thrown as it is (retryable), not as "not configured"', async () => {
        const readError = Object.assign(new Error('platform setting default_org_id could not be read (HTTP 503)'), {
            name: 'PlatformSettingReadError',
        });
        h.defaultOrg.mockRejectedValue(readError);
        await expect(getOrgWhatsAppCreds(DEFAULT_ORG, client)).rejects.toBe(readError);
    });

    it('without a client it reads the default org with a service-role client', async () => {
        await expect(getOrgWhatsAppCreds(DEFAULT_ORG)).resolves.toMatchObject({ orgId: DEFAULT_ORG });
        expect(h.createService).toHaveBeenCalledTimes(1);
        expect(h.defaultOrg).toHaveBeenCalledWith(h.serviceClient);
    });
});

describe('resolveWhatsAppContext (the number a webhook delivery arrived on)', () => {
    it('is the default org with the env credentials', async () => {
        await expect(resolveWhatsAppContext(client)).resolves.toEqual({
            orgId: DEFAULT_ORG,
            integrationId: null,
            phoneNumberId: '100000000000001',
            wabaId: '200000000000001',
            accessToken: 'token-palsu',
            graphVersion: GRAPH_API_VERSION,
        });
        expect(h.defaultOrg).toHaveBeenCalledWith(client);
    });

    it('does not refuse a missing token: storing needs none, each send checks', async () => {
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', '');
        const ctx = await resolveWhatsAppContext(client);
        expect(ctx.accessToken).toBe('');
        expect(() => assertCanSend(ctx)).toThrow(WhatsAppNotConfiguredError);
    });
});

describe('env checks', () => {
    it('envWhatsAppSendConfigured needs a number and a token, after trimming', () => {
        expect(envWhatsAppSendConfigured()).toBe(true);
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '\r\n');
        expect(envWhatsAppSendConfigured()).toBe(false);
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '100000000000001');
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', ' ');
        expect(envWhatsAppSendConfigured()).toBe(false);
    });

    it('envWebhookApp trims the app secret; only whitespace is no secret', () => {
        expect(envWebhookApp()).toEqual({ appSecret: 'secret-palsu', phoneNumberId: '100000000000001' });
        vi.stubEnv('WHATSAPP_APP_SECRET', '  ');
        expect(envWebhookApp().appSecret).toBeNull();
    });

    it('a token with a line break, a tab or a space inside is not usable (fetch would quote it in its error)', () => {
        for (const token of ['token\npalsu', 'token\tpalsu', 'token palsu']) {
            vi.stubEnv('WHATSAPP_ACCESS_TOKEN', token);
            expect(envWhatsAppSendConfigured(), JSON.stringify(token)).toBe(false);
        }
        expect(canSend({ phoneNumberId: '100000000000001', accessToken: 'token\u0000palsu' })).toBe(false);
        expect(canSend({ phoneNumberId: '100000000000001', accessToken: 'tokenPalsu123-_.~' })).toBe(true);
        expect(canSend({ phoneNumberId: '', accessToken: 'tokenPalsu123' })).toBe(false);
        // Missing values (an untyped database row): never usable.
        for (const missing of [undefined, null]) {
            expect(canSend({ phoneNumberId: missing as never, accessToken: 'tokenPalsu123' })).toBe(false);
            expect(canSend({ phoneNumberId: '100000000000001', accessToken: missing as never })).toBe(false);
        }
    });

    it('getOrgWhatsAppCreds refuses an unusable token as not configured, without quoting it', async () => {
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token\npalsu');
        const error = await getOrgWhatsAppCreds(DEFAULT_ORG, client).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(WhatsAppNotConfiguredError);
        expect(String((error as Error).message)).not.toContain('palsu');
    });

    it('assertCanSend accepts complete credentials only', () => {
        const creds = {
            orgId: DEFAULT_ORG,
            integrationId: null,
            phoneNumberId: '100000000000001',
            wabaId: null,
            accessToken: 'token-palsu',
            graphVersion: GRAPH_API_VERSION,
        };
        expect(() => assertCanSend(creds)).not.toThrow();
        expect(() => assertCanSend({ ...creds, phoneNumberId: '' })).toThrow(WhatsAppNotConfiguredError);
        expect(() => assertCanSend({ ...creds, accessToken: '' })).toThrow(WhatsAppNotConfiguredError);
    });
});
