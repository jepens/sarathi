import { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

// Org resolution helpers.
//
// Fase 1 is single-tenant: service-role paths (WhatsApp webhook, RAG) don't yet
// resolve an org per receiving number — that's Fase 2. Until then they use the
// default org. Authenticated UI paths resolve the org from the logged-in user's
// membership (1 user = 1 org for now).

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
 * The current user's org (1 user = 1 org). For authenticated UI/server paths.
 * Returns null if not signed in or not a member of any org.
 */
export async function getCurrentOrgId(client?: SupabaseClient): Promise<string | null> {
    const supabase = client ?? (await createClient());
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data } = await supabase
        .from('organization_members')
        .select('org_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();
    return (data?.org_id as string) ?? null;
}
