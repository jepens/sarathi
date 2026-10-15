import type { SupabaseClient } from '@supabase/supabase-js';

// Client-safe membership lookup shared by the server resolver
// (getCurrentOrgId in lib/settings/org-context.ts) and the dashboard's
// CurrentOrgProvider, so browser and server always pick the SAME org.
//
// A user may belong to several orgs (e.g. the Sarathi team). There is no
// "active org" switcher yet, so the pick is deterministic: the oldest
// membership, ties broken by org_id. organization_members RLS only exposes the
// caller's own rows ("read own memberships"); the explicit user_id filter keeps
// the query correct with a service-role client too.
export async function fetchMembershipOrgId(
    client: SupabaseClient,
    userId: string,
): Promise<string | null> {
    const { data } = await client
        .from('organization_members')
        .select('org_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .order('org_id', { ascending: true })
        .limit(1)
        .maybeSingle();
    return (data?.org_id as string | undefined) ?? null;
}
