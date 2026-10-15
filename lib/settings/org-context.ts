import { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { fetchMembershipOrgId } from '@/lib/settings/membership';
import {
    decideEnvIntegrationAccess,
    decideOrgMembership,
    NOT_SIGNED_IN_MESSAGE,
    type EnvIntegration,
} from '@/lib/settings/org-access';

// Org resolution helpers.
//
// Signed-in users operate the org they are a MEMBER of (organization_members) —
// never an org handed out by default. Service-role paths without a user (the
// WhatsApp webhook, queue, digest) still use the default org until inbound
// routing by phone_number_id lands (Fase 1/2).
//
// The default org (Sailendra) also owns every env-configured integration
// (WhatsApp, Portal, Zoom, Resend). Routes that use those credentials must gate
// on requireEnvIntegration() so another tenant can never act as Sailendra.

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
 * The signed-in user + the org they belong to. null when not signed in;
 * orgId null when signed in but not a member of any org.
 */
export async function getCurrentOrgContext(
    client?: SupabaseClient,
): Promise<{ userId: string; orgId: string | null } | null> {
    const supabase = client ?? (await createClient());
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    return { userId: user.id, orgId: await fetchMembershipOrgId(supabase, user.id) };
}

/**
 * The current user's org, resolved from organization_members. Returns null if
 * not signed in OR not a member of any org — callers answer 401/403.
 */
export async function getCurrentOrgId(client?: SupabaseClient): Promise<string | null> {
    const ctx = await getCurrentOrgContext(client);
    return ctx?.orgId ?? null;
}

/**
 * True when `orgId` is the default org — the org that owns the env-configured
 * WhatsApp / Portal / Zoom / Resend credentials. Resolved with the service-role
 * client so the answer doesn't depend on the caller's app_settings visibility.
 */
export async function isDefaultOrg(orgId: string | null | undefined): Promise<boolean> {
    if (!orgId) return false;
    const svc = await createServiceOrServerClient();
    return orgId === (await getDefaultOrgId(svc));
}

export type OrgAccess =
    | { ok: true; userId: string; orgId: string }
    | { ok: false; status: 401 | 403; error: string };

/** Gate: signed in AND a member of an org. */
export async function requireOrgMember(client?: SupabaseClient): Promise<OrgAccess> {
    const ctx = await getCurrentOrgContext(client);
    if (!ctx) return { ok: false, status: 401, error: NOT_SIGNED_IN_MESSAGE };
    const decision = decideOrgMembership({ signedIn: true, orgId: ctx.orgId });
    if (!decision.ok) return decision;
    return { ok: true, userId: ctx.userId, orgId: decision.orgId };
}

/**
 * Gate for env-credential integrations: signed in, a member, AND the member's
 * org is the default org. Call it BEFORE any external side effect.
 */
export async function requireEnvIntegration(
    integration: EnvIntegration,
    client?: SupabaseClient,
): Promise<OrgAccess> {
    const ctx = await getCurrentOrgContext(client);
    if (!ctx) return { ok: false, status: 401, error: NOT_SIGNED_IN_MESSAGE };
    // Only resolve the default org when there is a membership to compare.
    const defaultOrgId = ctx.orgId
        ? await getDefaultOrgId(await createServiceOrServerClient())
        : '';
    const decision = decideEnvIntegrationAccess({
        signedIn: true,
        orgId: ctx.orgId,
        defaultOrgId,
        integration,
    });
    if (!decision.ok) return decision;
    return { ok: true, userId: ctx.userId, orgId: decision.orgId };
}
