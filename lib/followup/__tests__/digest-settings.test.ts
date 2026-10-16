import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// The digest's last-sent date is a tenant setting (tracker 1.5 / 1.7): every
// read/write is scoped to the org, and the upsert targets the org-scoped key
// app_settings (org_id, key) from migration 0061 — never the global 'key'.

vi.mock('@/lib/whatsapp/templates', () => ({ sendTemplateMessage: vi.fn() }));
vi.mock('@/lib/settings/org-context', () => ({ getDefaultOrgId: vi.fn() }));

import { claimToday, getLastSent } from '@/lib/followup/digest';

const ORG = '0b0e6c1e-1111-4222-8333-444455556666';

function recorder(result: { data: unknown; error: unknown }) {
    const log: Array<[string, ...unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'update', 'upsert']) {
        q[m] = (...args: unknown[]) => {
            log.push([m, ...args]);
            return q;
        };
    }
    q.maybeSingle = async () => result;
    q.then = (resolve: (v: unknown) => unknown) => resolve(result);
    const client = { from: (t: string) => (log.push(['from', t]), q) } as unknown as SupabaseClient;
    return { client, log };
}

describe('digest last-sent setting', () => {
    it('getLastSent reads the org-scoped row', async () => {
        const { client, log } = recorder({ data: { value: '2026-10-16' }, error: null });
        expect(await getLastSent(client, ORG)).toBe('2026-10-16');
        expect(log).toContainEqual(['eq', 'org_id', ORG]);
        expect(log).toContainEqual(['eq', 'key', 'followup_digest_last_sent']);
    });

    it('claimToday upserts on (org_id, key) and flips only this org\'s row', async () => {
        const { client, log } = recorder({ data: [{ id: 'x' }], error: null });
        expect(await claimToday(client, ORG, '2026-10-16')).toBe(true);
        const upsert = log.find((c) => c[0] === 'upsert');
        expect(upsert?.[1]).toMatchObject({ org_id: ORG, key: 'followup_digest_last_sent' });
        expect(upsert?.[2]).toEqual({ onConflict: 'org_id,key', ignoreDuplicates: true });
        expect(log.filter((c) => c[0] === 'eq' && c[1] === 'org_id')).toHaveLength(1);
        expect(log).toContainEqual(['neq', 'value', '2026-10-16']);
    });

    it('claimToday returns false when another tick already claimed the day', async () => {
        const { client } = recorder({ data: [], error: null });
        expect(await claimToday(client, ORG, '2026-10-16')).toBe(false);
    });
});
