import { cache } from 'react';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { fetchMembership } from '@/lib/settings/membership';
import {
    decideEnvIntegrationAccess,
    decideOrgContext,
    NOT_SIGNED_IN_MESSAGE,
    type EnvIntegration,
    type OrgAccessDenied,
    type OrgRole,
} from '@/lib/settings/org-access';

// Central request context (KEA-2, KUA-14).
//
// Every user-facing server entry point — API route handlers, server actions and
// server components — resolves the caller through requireOrgContext():
//   { supabase, userId, orgId, role }  or a typed 401 / 403 / 500 refusal.
// The org is the one the user is a MEMBER of (organization_members; 1 user =
// 1 org) — never an org handed out by default. Answer a refusal with
// accessDeniedResponse() (routes) or its `error` (server actions).
//
// The session is verified with auth.getClaims() (JWT signature + expiry; no
// Auth round-trip when the project uses asymmetric signing keys). Revocation
// is still bounded by the JWT lifetime, and the membership query runs under the
// same JWT, so RLS stays the data boundary.
//
// Memoization: the resolvers are wrapped in React cache(), so the dashboard
// layout and the pages/components below it share ONE lookup per render. React
// cache does not dedupe inside Route Handlers or Server Actions (they are not a
// render pass) — there, call requireOrgContext() once and pass the context on.
//
// Service-role paths without a user (the WhatsApp webhook, queue, digest) still
// use getDefaultOrgId() until inbound routing by phone_number_id lands.
//
// The default org (Sailendra) also owns every env-configured integration
// (WhatsApp, Portal, Zoom, Resend). Routes that use those credentials must gate
// on requireEnvIntegration() so another tenant can never act as Sailendra.

// Matches the seed org in migration 0026. Fallback if app_settings is empty.
const SEED_ORG_ID = '5a11e024-0001-4000-8000-000000000001';

/** The signed-in member's context. `supabase` is the cookie-bound (RLS) client. */
export interface OrgContext {
    supabase: SupabaseClient;
    userId: string;
    orgId: string;
    role: OrgRole;
}

export type OrgAccess = ({ ok: true } & OrgContext) | OrgAccessDenied;

export type UserAccess =
    | { ok: true; supabase: SupabaseClient; userId: string }
    | OrgAccessDenied;

export type { OrgAccessDenied };

/**
 * The default org for service-role writes/reads. Read from app_settings so it
 * can change without a deploy; falls back to the seed constant.
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
 * The default org id, resolved with the service-role client so the answer
 * doesn't depend on the caller's app_settings visibility. Memoized per render.
 */
const getDefaultOrgIdForRequest = cache(async (): Promise<string> => {
    const svc = await createServiceOrServerClient();
    return getDefaultOrgId(svc);
});

/** The verified session user (JWT subject), or null. Memoized per render. */
const getVerifiedSession = cache(
    async (): Promise<{ supabase: SupabaseClient; userId: string | null }> => {
        const supabase = await createClient();
        try {
            const { data, error } = await supabase.auth.getClaims();
            const sub = error ? null : data?.claims?.sub;
            return { supabase, userId: typeof sub === 'string' && sub ? sub : null };
        } catch (err) {
            // Unexpected (non-auth) failure — fail closed as "no session".
            console.error('session verification failed', err);
            return { supabase, userId: null };
        }
    },
);

/**
 * Gate: a verified session AND an org membership. Returns the request context
 * or a typed refusal (401 no session, 403 no membership, 500 lookup failed).
 * Call it FIRST — before parsing the body or touching any data.
 */
export const requireOrgContext = cache(async (): Promise<OrgAccess> => {
    const { supabase, userId } = await getVerifiedSession();
    if (!userId) return { ok: false, status: 401, error: NOT_SIGNED_IN_MESSAGE };

    const lookup = await fetchMembership(supabase, userId);
    if (!lookup.ok) console.error('org membership lookup failed', lookup.error);
    const decision = decideOrgContext({
        userId,
        membership: lookup.ok ? lookup.membership : null,
        lookupFailed: !lookup.ok,
    });
    if (!decision.ok) return decision;
    return { ...decision, supabase };
});

/**
 * Gate for user-scoped endpoints that must keep working WITHOUT a membership
 * (e.g. removing your own push device on logout after leaving an org).
 * Tenant data always goes through requireOrgContext() instead.
 */
export async function requireUserContext(): Promise<UserAccess> {
    const { supabase, userId } = await getVerifiedSession();
    if (!userId) return { ok: false, status: 401, error: NOT_SIGNED_IN_MESSAGE };
    return { ok: true, supabase, userId };
}

/**
 * Gate for env-credential integrations: a member (requireOrgContext) AND the
 * member's org is the default org. Call it BEFORE any external side effect.
 */
export async function requireEnvIntegration(integration: EnvIntegration): Promise<OrgAccess> {
    const access = await requireOrgContext();
    if (!access.ok) return access;
    const decision = decideEnvIntegrationAccess({
        signedIn: true,
        orgId: access.orgId,
        defaultOrgId: await getDefaultOrgIdForRequest(),
        integration,
    });
    if (!decision.ok) return decision;
    return access;
}

/**
 * True when `orgId` is the default org — the org that owns the env-configured
 * WhatsApp / Portal / Zoom / Resend credentials.
 */
export async function isDefaultOrg(orgId: string | null | undefined): Promise<boolean> {
    if (!orgId) return false;
    return orgId === (await getDefaultOrgIdForRequest());
}

/** The JSON answer for a refused gate: `{ error }` with the gate's status. */
export function accessDeniedResponse(denied: OrgAccessDenied): NextResponse {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
}
