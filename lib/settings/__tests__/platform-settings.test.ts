import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Platform settings (tracker 1.7, audit KEA-9): getDefaultOrgId reads
// public.platform_settings (service role only) and nothing else: the legacy
// app_settings fallback was removed with the contract migration 0062, so a row
// a tenant creates in app_settings is never read. Since 2.2d the default org
// is the only platform setting: the legacy webhook verify token and URL went
// with the bare webhook URL (every Meta app has its own, in Vault).

const SEED = '5a11e024-0001-4000-8000-000000000001';

interface Call {
    table: string;
    filters: Array<[string, unknown]>;
}

type Answer = { data: unknown; error: unknown; status?: number };

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

import { getPlatformSetting, PLATFORM_SETTING_KEYS } from '@/lib/settings/platform-settings';
import { getDefaultOrgId, getDefaultOrgIdStrict } from '@/lib/settings/org-context';
import { describeErrorForOps } from '@/lib/ops/events';

describe('getPlatformSetting', () => {
    it('knows one key: the default org', () => {
        expect(PLATFORM_SETTING_KEYS).toEqual(['default_org_id']);
    });

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
        expect(await getPlatformSetting(client, 'default_org_id')).toBeNull();
        expect(calls.map((c) => c.table)).toEqual(['platform_settings']);
    });

    it('returns null when platform_settings is not readable (non-service client)', async () => {
        const { client, calls } = fakeClient({
            platform_settings: { data: null, error: { code: '42501', message: 'permission denied' } },
            app_settings: { data: { value: 'legacy' }, error: null },
        });
        expect(await getPlatformSetting(client, 'default_org_id')).toBeNull();
        expect(calls.map((c) => c.table)).toEqual(['platform_settings']);
    });

    it('treats an empty value as missing', async () => {
        const { client } = fakeClient({
            platform_settings: { data: { value: '' }, error: null },
        });
        expect(await getPlatformSetting(client, 'default_org_id')).toBeNull();
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

describe('getDefaultOrgIdStrict (a read error throws, Fase 2 task 2.2a)', () => {
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

    it("refuses an answer that is not PostgREST's 200: an empty 404 (a wrong URL) comes back from postgrest-js as a 204 without an error", async () => {
        const { client } = fakeClient({ platform_settings: { data: null, error: null, status: 204 } });
        const err = await getDefaultOrgIdStrict(client).catch((e: unknown) => e);
        expect(err).toMatchObject({ name: 'PlatformSettingReadError', status: 204 });
        // A real "no row" is a 200: the seed org.
        expect(await getDefaultOrgIdStrict(fakeClient({ platform_settings: { data: null, error: null, status: 200 } }).client)).toBe(SEED);
    });

    it("keeps the HTTP status of a refused read for the alert's hint (a wrong API key or URL shows here first)", async () => {
        const { client } = fakeClient({ platform_settings: { data: null, error: { message: 'Invalid API key' }, status: 401 } });
        const err = await getDefaultOrgIdStrict(client).catch((e: unknown) => e);
        expect(err).toMatchObject({ name: 'PlatformSettingReadError', status: 401 });
        expect((err as { code?: unknown }).code).toBeUndefined();
    });
});
