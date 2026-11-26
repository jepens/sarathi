import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The WhatsApp credential resolver (Fase 2 tasks 2.2b-2.2d): every org's
// number and token come from Vault (wa_org_send_credentials); an org without
// an active number and app, or without a usable token, gets
// WhatsAppNotConfiguredError, never another org's number; a read error stays
// a read error (retryable). No env is read. Fake ids and tokens only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';
const KEY = 'A'.repeat(32);
const APP_ID = 'cccccccc-0000-4000-8000-00000000000c';
const INTEGRATION_ID = 'dddddddd-0000-4000-8000-00000000000d';
const TOKEN = 'token-token-token-token';

const h = vi.hoisted(() => ({
    serviceClient: null as unknown,
    serviceRoleClient: vi.fn(),
}));

vi.mock('@/lib/whatsapp/webhook/service-client', () => ({ serviceRoleClient: h.serviceRoleClient }));

import {
    assertCanSend,
    canSend,
    getOrgWhatsAppCreds,
    orgWhatsAppConnected,
    vaultOrgCreds,
    vaultWebhookApp,
    WhatsAppNotConfiguredError,
} from '@/lib/whatsapp/credentials';
import { GRAPH_API_VERSION } from '@/lib/whatsapp/graph';
import { RpcError } from '@/lib/whatsapp/webhook/errors';

/** A client whose rpc() records the call and answers `reply`. */
function rpcClient(reply: { data?: unknown; error?: unknown; status?: number }) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const fake = {
        rpc: async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            return { data: null, error: null, status: 200, ...reply };
        },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { calls, client: fake as any };
}

/** wa_org_send_credentials' row of an org's number. */
function numberRow(extra: Record<string, unknown> = {}) {
    return {
        integration_id: INTEGRATION_ID,
        app_id: APP_ID,
        phone_number_id: '100000000000003',
        waba_id: '200000000000003',
        access_token: TOKEN,
        status: 'active',
        app_status: 'active',
        ...extra,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    h.serviceRoleClient.mockImplementation(() => h.serviceClient);
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('getOrgWhatsAppCreds', () => {
    it("maps the org's Vault row: its number, WABA, integration and token", async () => {
        const fake = rpcClient({ data: [numberRow()] });
        await expect(getOrgWhatsAppCreds(OTHER_ORG, fake.client)).resolves.toEqual({
            orgId: OTHER_ORG,
            integrationId: INTEGRATION_ID,
            phoneNumberId: '100000000000003',
            wabaId: '200000000000003',
            accessToken: TOKEN,
            graphVersion: GRAPH_API_VERSION,
        });
        expect(fake.calls).toEqual([{ name: 'wa_org_send_credentials', args: { p_org: OTHER_ORG } }]);
        expect(h.serviceRoleClient).not.toHaveBeenCalled();
    });

    it('no row, a paused number or a suspended app is not configured', async () => {
        for (const reply of [{ data: [] }, { data: [numberRow({ status: 'paused' })] }, { data: [numberRow({ app_status: 'suspended' })] }]) {
            await expect(getOrgWhatsAppCreds(ORG, rpcClient(reply).client)).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
        }
    });

    it('a token Vault could not decrypt, or an unusable one, is not configured, without quoting it', async () => {
        for (const access_token of [null, '', 'token\npalsu']) {
            const error = await getOrgWhatsAppCreds(ORG, rpcClient({ data: [numberRow({ access_token })] }).client).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(WhatsAppNotConfiguredError);
            expect(String((error as Error).message)).not.toContain('palsu');
        }
    });

    it('an orgId that is not a UUID is not configured, without a read', async () => {
        const fake = rpcClient({ data: [numberRow()] });
        for (const orgId of ['', 'org-palsu', `${ORG} `]) {
            await expect(getOrgWhatsAppCreds(orgId, fake.client)).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
        }
        expect(fake.calls).toEqual([]);
        expect(h.serviceRoleClient).not.toHaveBeenCalled();
    });

    it('an RPC error is a read error (retryable), not "not configured", and its message holds no token', async () => {
        const error = await getOrgWhatsAppCreds(ORG, rpcClient({ error: { code: '57014', message: TOKEN }, status: 500 }).client).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RpcError);
        expect(error).not.toBeInstanceOf(WhatsAppNotConfiguredError);
        expect(String((error as Error).message)).not.toContain('token');
    });

    it('without a client it reads with a service-role client; with none configured it is a read error', async () => {
        const fake = rpcClient({ data: [numberRow()] });
        h.serviceClient = fake.client;
        await expect(getOrgWhatsAppCreds(ORG)).resolves.toMatchObject({ orgId: ORG, accessToken: TOKEN });
        expect(h.serviceRoleClient).toHaveBeenCalledTimes(1);
        expect(fake.calls).toHaveLength(1);

        h.serviceClient = null;
        const error = await getOrgWhatsAppCreds(ORG).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(WhatsAppNotConfiguredError);
    });

    it('reads no env: the old WhatsApp env values change nothing', async () => {
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '100000000000001');
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token-env-palsu');
        await expect(getOrgWhatsAppCreds(ORG, rpcClient({ data: [] }).client)).rejects.toBeInstanceOf(WhatsAppNotConfiguredError);
        await expect(getOrgWhatsAppCreds(ORG, rpcClient({ data: [numberRow()] }).client)).resolves.toMatchObject({
            phoneNumberId: '100000000000003',
            accessToken: TOKEN,
        });
    });
});

describe('orgWhatsAppConnected (Settings, onboarding)', () => {
    /** A service client whose whatsapp_integrations select answers `reply`; records the columns and filters. */
    function tableClient(reply: { data?: unknown; error?: unknown } | Error) {
        const seen: unknown[] = [];
        const q = {
            select: (cols: string) => (seen.push(['select', cols]), q),
            eq: (col: string, val: unknown) => (seen.push(['eq', col, val]), q),
            maybeSingle: async () => {
                if (reply instanceof Error) throw reply;
                return { data: null, error: null, ...reply };
            },
        };
        return { seen, client: { from: (table: string) => (seen.push(['from', table]), q) } };
    }

    it('is true for an active number, reading its status only', async () => {
        const fake = tableClient({ data: { status: 'active' } });
        h.serviceClient = fake.client;
        await expect(orgWhatsAppConnected(ORG)).resolves.toBe(true);
        expect(fake.seen).toEqual([['from', 'whatsapp_integrations'], ['select', 'status'], ['eq', 'org_id', ORG]]);
    });

    it('is false for no row, a paused number, a read error, no service client or a non-UUID org', async () => {
        for (const reply of [{ data: null }, { data: { status: 'paused' } }, { error: { code: '57014' } }, new Error('jaringan')]) {
            h.serviceClient = tableClient(reply).client;
            await expect(orgWhatsAppConnected(ORG)).resolves.toBe(false);
        }
        h.serviceClient = null;
        await expect(orgWhatsAppConnected(ORG)).resolves.toBe(false);
        h.serviceClient = tableClient({ data: { status: 'active' } }).client;
        await expect(orgWhatsAppConnected('org-palsu')).resolves.toBe(false);
    });
});

describe('canSend / assertCanSend', () => {
    it('a token with a line break, a tab or a space inside is not usable (fetch would quote it in its error)', () => {
        for (const token of ['token\npalsu', 'token\tpalsu', 'token palsu', 'token\u0000palsu']) {
            expect(canSend({ phoneNumberId: '100000000000001', accessToken: token }), JSON.stringify(token)).toBe(false);
        }
        expect(canSend({ phoneNumberId: '100000000000001', accessToken: 'tokenPalsu123-_.~' })).toBe(true);
        expect(canSend({ phoneNumberId: '', accessToken: 'tokenPalsu123' })).toBe(false);
        // Missing values (an untyped database row): never usable.
        for (const missing of [undefined, null]) {
            expect(canSend({ phoneNumberId: missing as never, accessToken: 'tokenPalsu123' })).toBe(false);
            expect(canSend({ phoneNumberId: '100000000000001', accessToken: missing as never })).toBe(false);
        }
    });

    it('assertCanSend accepts complete credentials only', () => {
        const creds = {
            orgId: ORG,
            integrationId: INTEGRATION_ID,
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

// The Vault readers of the per-app webhook (Fase 2 task 2.2c): one RPC each
// on the caller's client, rows mapped as they are (the webhook checks the
// statuses), null for no row, an RpcError with the code only on a failure.

describe('vaultWebhookApp', () => {
    it('maps the app row of the key', async () => {
        const fake = rpcClient({
            data: [{ app_id: APP_ID, org_id: OTHER_ORG, status: 'active', app_secret: 'rahasia-rahasia-rahasia', verify_token_sha256: 'ab'.repeat(32) }],
        });
        await expect(vaultWebhookApp(fake.client, KEY)).resolves.toEqual({
            appId: APP_ID,
            orgId: OTHER_ORG,
            status: 'active',
            appSecret: 'rahasia-rahasia-rahasia',
            verifyTokenSha256: 'ab'.repeat(32),
        });
        expect(fake.calls).toEqual([{ name: 'wa_webhook_app', args: { p_key: KEY } }]);
    });

    it('an unknown key is null; a secret Vault could not decrypt is null', async () => {
        await expect(vaultWebhookApp(rpcClient({ data: [] }).client, KEY)).resolves.toBeNull();
        const undecrypted = rpcClient({ data: [{ app_id: APP_ID, org_id: OTHER_ORG, status: 'active', app_secret: null, verify_token_sha256: 'ab'.repeat(32) }] });
        await expect(vaultWebhookApp(undecrypted.client, KEY)).resolves.toMatchObject({ appSecret: null });
    });

    it('an RPC error throws RpcError with the code only, never the message', async () => {
        const error = await vaultWebhookApp(rpcClient({ error: { code: 'PGRST301', message: 'rahasia-rahasia-rahasia' }, status: 401 }).client, KEY).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RpcError);
        expect(error).toMatchObject({ code: 'PGRST301', status: 401 });
        expect(String((error as Error).message)).not.toContain('rahasia');
    });
});

describe('vaultOrgCreds', () => {
    it("maps the org's number and its app's token", async () => {
        const fake = rpcClient({ data: [numberRow()] });
        await expect(vaultOrgCreds(fake.client, OTHER_ORG)).resolves.toEqual({
            creds: {
                orgId: OTHER_ORG,
                integrationId: INTEGRATION_ID,
                phoneNumberId: '100000000000003',
                wabaId: '200000000000003',
                accessToken: TOKEN,
                graphVersion: GRAPH_API_VERSION,
            },
            status: 'active',
            appStatus: 'active',
        });
        expect(fake.calls).toEqual([{ name: 'wa_org_send_credentials', args: { p_org: OTHER_ORG } }]);
    });

    it('an org without a number is null; a token Vault could not decrypt is empty (canSend refuses it)', async () => {
        await expect(vaultOrgCreds(rpcClient({ data: [] }).client, OTHER_ORG)).resolves.toBeNull();
        const undecrypted = rpcClient({ data: [numberRow({ access_token: null, status: 'paused', app_status: 'suspended' })] });
        const read = await vaultOrgCreds(undecrypted.client, OTHER_ORG);
        expect(read).toMatchObject({ status: 'paused', appStatus: 'suspended' });
        expect(read?.creds.accessToken).toBe('');
        expect(canSend(read!.creds)).toBe(false);
    });

    it('an RPC error throws RpcError with the code only, never the message', async () => {
        const error = await vaultOrgCreds(rpcClient({ error: { code: '57014', message: TOKEN }, status: 500 }).client, OTHER_ORG).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RpcError);
        expect(String((error as Error).message)).toBe('wa_org_send_credentials failed (HTTP 500, 57014)');
    });

    it('neither reader creates a client of its own', async () => {
        const fake = rpcClient({ data: [] });
        await vaultWebhookApp(fake.client, KEY);
        await vaultOrgCreds(fake.client, OTHER_ORG);
        expect(h.serviceRoleClient).not.toHaveBeenCalled();
    });
});
