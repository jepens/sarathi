// Pure org-access decisions (no I/O, client-safe) shared by the server helpers in
// lib/settings/org-context.ts and their unit tests.
//
// Every user-facing server entry point (API route, server action, server
// component) resolves ONE org context: the signed-in user + the org they are a
// member of (1 user = 1 org; no org switcher). The gates are:
//   1. session — no verified session → 401;
//   2. org membership — signed in but not a member of any org → 403 (a failed
//      membership lookup is a 500, never silently "no org");
//   3. env-credential integrations — Zoom and Resend credentials live in the
//      server environment and belong to the DEFAULT org (Sailendra). Until
//      per-tenant credentials exist, only members of that org may trigger them;
//      everyone else gets a clear "not configured" error BEFORE any external
//      call is made. WhatsApp has its own gate, which resolves the org's
//      credentials (lib/whatsapp/integration.ts, Fase 2 task 2.2b).

/**
 * Integrations that belong to the default org only: their credentials come
 * from the server env, or (proposals) the documents carry Sailendra's identity
 * (owner decisions D8, D26: Sailendra-only until opened per tenant in Fase 4).
 */
export type EnvIntegration = 'zoom' | 'email' | 'proposals';

/** organization_members.role (public.org_role). Enforcement lands in Fase 3. */
export type OrgRole = 'owner' | 'admin' | 'staff';

export const NOT_SIGNED_IN_MESSAGE = 'Sesi tidak valid — silakan login ulang.';
export const NO_ORG_MESSAGE = 'Akun Anda belum terdaftar di organisasi mana pun.';
export const ORG_LOOKUP_FAILED_MESSAGE = 'Gagal memuat data organisasi. Silakan coba lagi.';
export const SESSION_CHECK_FAILED_MESSAGE = 'Gagal memverifikasi sesi. Silakan coba lagi.';

export const INTEGRATION_NOT_CONFIGURED_MESSAGE: Record<EnvIntegration | 'whatsapp', string> = {
    whatsapp: 'Integrasi WhatsApp belum dikonfigurasi untuk organisasi ini.',
    zoom: 'Integrasi Zoom belum dikonfigurasi untuk organisasi ini.',
    email: 'Integrasi email belum dikonfigurasi untuk organisasi ini.',
    proposals: 'Fitur proposal belum tersedia untuk organisasi ini.',
};

export const WHATSAPP_SETTINGS_UNAVAILABLE_MESSAGE = 'Pengaturan WhatsApp organisasi tidak bisa dibaca saat ini. Silakan coba lagi.';

/**
 * A refused gate — routes answer it verbatim as `{ error }` with `status`.
 * 401 = genuinely no valid session; 503 = the session could not be verified
 * right now (Auth unreachable / retryable failure) — NOT a sign-out.
 */
export type OrgAccessDenied = { ok: false; status: 401 | 403 | 500 | 503; error: string };

export type OrgGateResult = { ok: true; orgId: string } | OrgAccessDenied;

export type OrgContextDecision =
    | { ok: true; userId: string; orgId: string; role: OrgRole }
    | OrgAccessDenied;

/** Membership gate: signed in AND a member of some org. */
export function decideOrgMembership(input: {
    signedIn: boolean;
    orgId: string | null;
}): OrgGateResult {
    if (!input.signedIn) return { ok: false, status: 401, error: NOT_SIGNED_IN_MESSAGE };
    if (!input.orgId) return { ok: false, status: 403, error: NO_ORG_MESSAGE };
    return { ok: true, orgId: input.orgId };
}

const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'staff'];

/**
 * Narrow a membership row's role. Unknown/missing values fall to the LEAST
 * privileged role, so a schema drift can never escalate anyone.
 */
export function toOrgRole(value: unknown): OrgRole {
    return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value)
        ? (value as OrgRole)
        : 'staff';
}

/**
 * The full org-context decision: session (401) → membership lookup (500 on
 * failure) → membership (403). `userId` is the verified JWT subject (null when
 * there is no valid session); `membership` is the user's org row, if any.
 */
export function decideOrgContext(input: {
    userId: string | null;
    membership: { orgId: string; role: OrgRole } | null;
    lookupFailed?: boolean;
}): OrgContextDecision {
    if (!input.userId) return { ok: false, status: 401, error: NOT_SIGNED_IN_MESSAGE };
    if (input.lookupFailed) return { ok: false, status: 500, error: ORG_LOOKUP_FAILED_MESSAGE };
    const gate = decideOrgMembership({
        signedIn: true,
        orgId: input.membership?.orgId ?? null,
    });
    if (!gate.ok) return gate;
    return {
        ok: true,
        userId: input.userId,
        orgId: gate.orgId,
        role: input.membership?.role ?? 'staff',
    };
}

/**
 * Env-credential gate: membership first, then the caller's org must be the
 * default org.
 */
export function decideEnvIntegrationAccess(input: {
    signedIn: boolean;
    orgId: string | null;
    defaultOrgId: string;
    integration: EnvIntegration;
}): OrgGateResult {
    const membership = decideOrgMembership(input);
    if (!membership.ok) return membership;
    if (membership.orgId !== input.defaultOrgId) {
        return {
            ok: false,
            status: 403,
            error: INTEGRATION_NOT_CONFIGURED_MESSAGE[input.integration],
        };
    }
    return membership;
}
