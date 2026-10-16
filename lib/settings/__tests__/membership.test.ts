import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchMembership } from '@/lib/settings/membership';

// fetchMembership must resolve the org from organization_members for THIS
// user, deterministically (oldest membership, then org_id) — the server routes
// and the dashboard's CurrentOrgProvider rely on picking the same org.

type Call = [string, ...unknown[]];

function fakeClient(
    row: { org_id: string; role?: unknown } | null,
    error: unknown = null,
) {
    const calls: Call[] = [];
    const builder = {
        select: (...a: unknown[]) => (calls.push(['select', ...a]), builder),
        eq: (...a: unknown[]) => (calls.push(['eq', ...a]), builder),
        order: (...a: unknown[]) => (calls.push(['order', ...a]), builder),
        limit: (...a: unknown[]) => (calls.push(['limit', ...a]), builder),
        maybeSingle: async () => ({ data: error ? null : row, error }),
    };
    const client = {
        from: (table: string) => (calls.push(['from', table]), builder),
    } as unknown as SupabaseClient;
    return { client, calls };
}

describe('fetchMembership', () => {
    it('queries the user’s own membership with a deterministic order', async () => {
        const { client, calls } = fakeClient({ org_id: 'org-a', role: 'admin' });
        await expect(fetchMembership(client, 'user-1')).resolves.toEqual({
            ok: true,
            membership: { orgId: 'org-a', role: 'admin' },
        });
        expect(calls).toEqual([
            ['from', 'organization_members'],
            ['select', 'org_id, role'],
            ['eq', 'user_id', 'user-1'],
            ['order', 'created_at', { ascending: true }],
            ['order', 'org_id', { ascending: true }],
            ['limit', 1],
        ]);
    });

    it('returns no membership for a user without any (no default-org fallback)', async () => {
        const { client } = fakeClient(null);
        await expect(fetchMembership(client, 'user-2')).resolves.toEqual({
            ok: true,
            membership: null,
        });
    });

    it('falls back to the least-privileged role for an unknown role value', async () => {
        const { client } = fakeClient({ org_id: 'org-a', role: 'superuser' });
        await expect(fetchMembership(client, 'user-1')).resolves.toEqual({
            ok: true,
            membership: { orgId: 'org-a', role: 'staff' },
        });
    });

    it('reports a failed lookup instead of pretending there is no org', async () => {
        const failure = { message: 'boom' };
        const { client } = fakeClient(null, failure);
        await expect(fetchMembership(client, 'user-1')).resolves.toEqual({
            ok: false,
            error: failure,
        });
    });
});
