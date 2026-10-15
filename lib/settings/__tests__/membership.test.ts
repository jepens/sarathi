import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchMembershipOrgId } from '@/lib/settings/membership';

// fetchMembershipOrgId must resolve the org from organization_members for THIS
// user, deterministically (oldest membership, then org_id) — the server routes
// and the dashboard's CurrentOrgProvider rely on picking the same org.

type Call = [string, ...unknown[]];

function fakeClient(row: { org_id: string } | null) {
    const calls: Call[] = [];
    const builder = {
        select: (...a: unknown[]) => (calls.push(['select', ...a]), builder),
        eq: (...a: unknown[]) => (calls.push(['eq', ...a]), builder),
        order: (...a: unknown[]) => (calls.push(['order', ...a]), builder),
        limit: (...a: unknown[]) => (calls.push(['limit', ...a]), builder),
        maybeSingle: async () => ({ data: row, error: null }),
    };
    const client = {
        from: (table: string) => (calls.push(['from', table]), builder),
    } as unknown as SupabaseClient;
    return { client, calls };
}

describe('fetchMembershipOrgId', () => {
    it('queries the user’s own membership with a deterministic order', async () => {
        const { client, calls } = fakeClient({ org_id: 'org-a' });
        await expect(fetchMembershipOrgId(client, 'user-1')).resolves.toBe('org-a');
        expect(calls).toEqual([
            ['from', 'organization_members'],
            ['select', 'org_id'],
            ['eq', 'user_id', 'user-1'],
            ['order', 'created_at', { ascending: true }],
            ['order', 'org_id', { ascending: true }],
            ['limit', 1],
        ]);
    });

    it('returns null for a user without any membership (no default-org fallback)', async () => {
        const { client } = fakeClient(null);
        await expect(fetchMembershipOrgId(client, 'user-2')).resolves.toBeNull();
    });
});
