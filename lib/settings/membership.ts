import type { SupabaseClient } from '@supabase/supabase-js';
import { toOrgRole, type OrgRole } from '@/lib/settings/org-access';

// Membership lookup behind the server org context (requireOrgContext in
// lib/settings/org-context.ts). The dashboard layout resolves it once and hands
// the org to client components through CurrentOrgProvider, so browser and
// server always pick the SAME org.
//
// Product rule: 1 user = 1 org. Should a user still hold several memberships
// (legacy pilot data, Sarathi staff before the platform-admin role exists), the
// pick is deterministic: the oldest membership, ties broken by org_id.
// organization_members RLS only exposes the caller's own rows ("read own
// memberships"); the explicit user_id filter keeps the query correct with a
// service-role client too.

export interface Membership {
    orgId: string;
    role: OrgRole;
}

export type MembershipLookup =
    | { ok: true; membership: Membership | null }
    | { ok: false; error: unknown };

export async function fetchMembership(
    client: SupabaseClient,
    userId: string,
): Promise<MembershipLookup> {
    const { data, error } = await client
        .from('organization_members')
        .select('org_id, role')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .order('org_id', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (error) return { ok: false, error };
    const orgId = (data?.org_id as string | undefined) ?? null;
    return {
        ok: true,
        membership: orgId ? { orgId, role: toOrgRole(data?.role) } : null,
    };
}
