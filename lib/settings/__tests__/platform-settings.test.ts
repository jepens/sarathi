import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Platform settings (tracker 1.7, audit KEA-9): getDefaultOrgId and the
// verify-token helpers read public.platform_settings (service role only) and
// nothing else: the legacy app_settings fallback was removed with the contract
// migration 0062, so a row a tenant creates in app_settings is never read.

const SEED = '5a11e024-0001-4000-8000-000000000001';

interface Call {
    table: string;
    filters: Array<[string, unknown]>;
}

type Answer = { data: unknown; error: unknown };

function fakeClient(answers: Record<string, Answer>) {
    const calls: Call[] = [];
    const client = {
        from(table: string) {
            const call: Call = { table, filters: [] };
            calls.push(call);
            const q: Record<string, unknown> = {};
            q.select = () => q;
            q.eq = (col: string, val: unknown) => {
                call.filters.push([col, val]);
                return q;
            };
            q.maybeSingle = async () => answers[table] ?? { data: null, error: null };
            return q;
        },
        rpc: vi.fn(async () => ({ data: null, error: { message: 'missing' } })),
    };
    return { client: client as unknown as SupabaseClient & { rpc: typeof client.rpc }, calls };
}

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceOrServerClient: vi.fn() }));

import { getPlatformSetting } from '@/lib/settings/platform-settings';
import { getDefaultOrgId, getDefaultOrgIdStrict } from '@/lib/settings/org-context';
import { describeErrorForOps } from '@/lib/ops/events';
import { checkVerifyToken, getVerifyToken, getWebhookUrl } from '@/lib/settings/app-settings';

beforeEach(() => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
});

describe('getPlatformSetting', () => {
    it('reads platform_settings first and stops there', async () => {
        const { client, calls } = fakeClient({
            platform_settings: { data: { value: 'org-x' }, error: null },
        });
        expect(await getPlatformSetting(client, 'default_org_id')).toBe('org-x');
        expect(calls).toEqual([{ table: 'platform_settings', filters: [['key', 'default_org_id']] }]);
    });

    it('never falls back to app_settings when the platform row is missing', async () => {
        const { client, calls } = fakeClient({
            app_settings: { data: { value: 'legacy' }, error: null },
        });
        expect(await getPlatformSetting(client, 'whatsapp_verify_token')).toBeNull();
        expect(calls.map((c) => c.table)).toEqual(['platform_settings']);
    });

    it('returns null when platform_settings is not readable (non-service client)', async () => {
        const { client, calls } = fakeClient({
            platform_settings: { data: null, error: { code: '42501', message: 'permission denied' } },
            app_settings: { data: { value: 'legacy' }, error: null },
        });
        expect(await getPlatformSetting(client, 'whatsapp_webhook_url')).toBeNull();
        expect(calls.map((c) => c.table)).toEqual(['platform_settings']);
    });

    it('treats an empty value as missing', async () => {
        const { client } = fakeClient({
            platform_settings: { data: { value: '' }, error: null },
        });
        expect(await getPlatformSetting(client, 'whatsapp_verify_token')).toBeNull();
    });
});

describe('getDefaultOrgId', () => {
    it('returns the platform default org', async () => {
        const { client } = fakeClient({ platform_settings: { data: { value: 'org-x' }, error: null } });
        expect(await getDefaultOrgId(client)).toBe('org-x');
    });

    it('falls back to the seed org when nothing is configured', async () => {
        const { client } = fakeClient({});
        expect(await getDefaultOrgId(client)).toBe(SEED);
    });
});

describe('getDefaultOrgIdStrict (the WhatsApp webhook, Fase 2 task 2.2a)', () => {
    it('returns the platform default org, and the seed org only when no row exists', async () => {
        expect(await getDefaultOrgIdStrict(fakeClient({ platform_settings: { data: { value: 'org-x' }, error: null } }).client)).toBe('org-x');
        expect(await getDefaultOrgIdStrict(fakeClient({}).client)).toBe(SEED);
    });

    it('throws on a read error instead of falling back to the seed org, keeping the code for the alert', async () => {
        const { client } = fakeClient({ platform_settings: { data: null, error: { code: '57014', message: 'canceling statement' } } });
        const err = await getDefaultOrgIdStrict(client).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/default_org_id could not be read \(57014\)/);
        expect(describeErrorForOps(err)).toBe('database 57014');
    });
});

describe('verify token + webhook URL helpers', () => {
    it('getVerifyToken reads the platform token, then env, then fails closed', async () => {
        const withRow = fakeClient({ platform_settings: { data: { value: 'tok' }, error: null } });
        expect(await getVerifyToken(withRow.client)).toBe('tok');

        process.env.WHATSAPP_VERIFY_TOKEN = 'env-tok';
        expect(await getVerifyToken(fakeClient({}).client)).toBe('env-tok');

        delete process.env.WHATSAPP_VERIFY_TOKEN;
        expect(await getVerifyToken(fakeClient({}).client)).toBe('');
    });

    it('getWebhookUrl reads the platform URL with a localhost default', async () => {
        const withRow = fakeClient({ platform_settings: { data: { value: 'https://x/api' }, error: null } });
        expect(await getWebhookUrl(withRow.client)).toBe('https://x/api');
        expect(await getWebhookUrl(fakeClient({}).client)).toBe('http://localhost:3000/api/webhook/whatsapp');
    });

    it('checkVerifyToken uses the RPC answer when available', async () => {
        const { client, calls } = fakeClient({});
        client.rpc.mockResolvedValueOnce({ data: true, error: null } as never);
        expect(await checkVerifyToken('abc', client)).toBe(true);
        expect(client.rpc).toHaveBeenCalledWith('verify_webhook_token', { input_token: 'abc' });
        expect(calls).toEqual([]);
    });

    it('checkVerifyToken falls back to the platform token and never accepts an empty one', async () => {
        const { client } = fakeClient({ platform_settings: { data: { value: 'tok' }, error: null } });
        expect(await checkVerifyToken('tok', client)).toBe(true);
        expect(await checkVerifyToken('nope', client)).toBe(false);
        expect(await checkVerifyToken('', fakeClient({}).client)).toBe(false);
    });
});
