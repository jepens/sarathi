import { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

// Org resolution helpers.
//
// This app is SINGLE-TENANT: there is exactly one organization (the Sailendra
// seed org). The org_id columns / RLS are kept as a harmless safety net, but
// both resolvers always return that single org. We never create or switch orgs.

// Matches the seed org in migration 0026. Fallback if app_settings is empty.
const SEED_ORG_ID = '5a11e024-0001-4000-8000-000000000001';

/**
 * The default org for service-role writes/reads (Fase 1). Read from app_settings
 * so it can change without a deploy; falls back to the seed constant.
 * Pass a service-role client (bypasses RLS).
 */
export async function getDefaultOrgId(client: SupabaseClient): Promise<string> {
    const { data } = await client
        .from('app_settings')
        .select('value')
        .eq('key', 'default_org_id')
        .maybeSingle();
    return (data?.value as string) || SEED_ORG_ID;
}

/**
 * The org for the signed-in user. Single-tenant: every authenticated user
 * operates the one org, so this returns the singleton (no membership lookup).
 * Still returns null when not signed in, so callers keep using it as an auth
 * gate exactly as before.
 */
export async function getCurrentOrgId(client?: SupabaseClient): Promise<string | null> {
    const supabase = client ?? (await createClient());
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    return getDefaultOrgId(supabase);
}
