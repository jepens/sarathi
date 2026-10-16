import { cache } from 'react';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { isSessionCheckUnavailable } from '@/lib/supabase/session-errors';
import { fetchMembership } from '@/lib/settings/membership';
import { getPlatformSetting, SEED_ORG_ID } from '@/lib/settings/platform-settings';
import {
    decideEnvIntegrationAccess,
    decideOrgContext,
    NOT_SIGNED_IN_MESSAGE,
    SESSION_CHECK_FAILED_MESSAGE,
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
// is then bounded by the JWT lifetime, and the membership query runs under the
// same JWT, so RLS stays the data boundary. Routes with EXTERNAL side effects
// (requireEnvIntegration) use requireOrgContext({ strict: true }) instead,
// which asks the Auth server (auth.getUser()) so a revoked session is refused
// immediately. A session that cannot be verified right now answers 503 — never
// 401 — so an Auth outage is not mistaken for a sign-out.
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
 * The default org for service-role writes/reads. A platform setting read
 * from platform_settings only (service role only — tenants cannot change it;
 * app_settings is not consulted), so it can change without a deploy; the seed
 * org constant (migration 0026) is the last resort when the row is missing.
 * Pass a service-role client.
 */
export async function getDefaultOrgId(client: SupabaseClient): Promise<string> {
    return (await getPlatformSetting(client, 'default_org_id')) || SEED_ORG_ID;
}

/**
 * The default org id, resolved with the service-role client so the answer
 * doesn't depend on the caller's visibility of platform settings. Memoized per render.
 */
const getDefaultOrgIdForRequest = cache(async (): Promise<string> => {
    const svc = await createServiceOrServerClient();
    return getDefaultOrgId(svc);
});

type VerifiedSession =
    | { supabase: SupabaseClient; userId: string; unavailable?: undefined }
    | { supabase: SupabaseClient; userId: null; unavailable: boolean };

const SESSION_UNAVAILABLE: OrgAccessDenied = {
    ok: false,
    status: 503,
    error: SESSION_CHECK_FAILED_MESSAGE,
};
const NOT_SIGNED_IN: OrgAccessDenied = { ok: false, status: 401, error: NOT_SIGNED_IN_MESSAGE };

/**
 * The verified session user, or null. Memoized per render (per `strict`).
 *
 * - default: auth.getClaims() — JWT signature + expiry, verified locally with
 *   the project's asymmetric keys (no Auth round trip). A signed-out or banned
 *   user's token keeps working until it expires.
 * - strict:  auth.getUser() — asks the Auth server, so a revoked session /
 *   banned user is refused immediately. Used for external side effects.
 *
 * `unavailable` separates "could not verify right now" (Auth unreachable, a
 * retryable fetch error, an unexpected throw) from "genuinely no session", so
 * callers never treat an outage as a sign-out (no /login redirect loops).
 */
const getVerifiedSession = cache(async (strict: boolean): Promise<VerifiedSession> => {
    const supabase = await createClient();
    try {
        let sub: unknown;
        let error: unknown;
        if (strict) {
            const res = await supabase.auth.getUser();
            sub = res.data?.user?.id;
            error = res.error;
        } else {
            const res = await supabase.auth.getClaims();
            sub = res.data?.claims?.sub;
            error = res.error;
        }
        if (error) {
            if (isSessionCheckUnavailable(error)) {
                console.error('session verification unavailable', error);
                return { supabase, userId: null, unavailable: true };
            }
            return { supabase, userId: null, unavailable: false };
        }
        if (typeof sub === 'string' && sub) return { supabase, userId: sub };
        return { supabase, userId: null, unavailable: false };
    } catch (err) {
        // Unexpected (non-auth) failure — fail closed, but as "unavailable",
        // not as "signed out".
        console.error('session verification failed', err);
        return { supabase, userId: null, unavailable: true };
    }
});

function sessionRefusal(session: VerifiedSession): OrgAccessDenied {
    return session.unavailable ? SESSION_UNAVAILABLE : NOT_SIGNED_IN;
}

export interface RequireOrgContextOptions {
    /**
     * Verify the session with the Auth server (auth.getUser()) instead of the
     * local JWT check, so a revoked session is refused before its JWT expires.
     * Use for routes with external side effects (see requireEnvIntegration).
     */
    strict?: boolean;
}

const resolveOrgContext = cache(async (strict: boolean): Promise<OrgAccess> => {
    const session = await getVerifiedSession(strict);
    if (!session.userId) return sessionRefusal(session);
    const { supabase, userId } = session;

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
 * Gate: a verified session AND an org membership. Returns the request context
 * or a typed refusal (401 no session, 403 no membership, 500 lookup failed,
 * 503 session could not be verified right now).
 * Call it FIRST — before parsing the body or touching any data.
 */
export async function requireOrgContext(options: RequireOrgContextOptions = {}): Promise<OrgAccess> {
    return resolveOrgContext(options.strict === true);
}

/**
 * Gate for user-scoped endpoints that must keep working WITHOUT a membership
 * (e.g. removing your own push device on logout after leaving an org).
 * Tenant data always goes through requireOrgContext() instead.
 */
export async function requireUserContext(): Promise<UserAccess> {
    const session = await getVerifiedSession(false);
    if (!session.userId) return sessionRefusal(session);
    return { ok: true, supabase: session.supabase, userId: session.userId };
}

/**
 * Gate for env-credential integrations: a member AND the member's org is the
 * default org. Call it BEFORE any external side effect. The session is checked
 * strictly (Auth-server round trip), so a signed-out / banned user cannot send
 * WhatsApp messages, call Portal / Zoom or email proposals with a still-valid JWT.
 */
export async function requireEnvIntegration(integration: EnvIntegration): Promise<OrgAccess> {
    const access = await requireOrgContext({ strict: true });
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
