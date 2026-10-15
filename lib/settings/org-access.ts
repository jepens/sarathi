// Pure org-access decisions (no I/O, client-safe) shared by the server helpers in
// lib/settings/org-context.ts and their unit tests.
//
// Two kinds of gates exist during Fase 0:
//   1. org membership — the caller must belong to an organization (every
//      tenant-scoped route);
//   2. env-credential integrations — WhatsApp, Portal, Zoom and Resend
//      credentials live in the server environment and belong to the DEFAULT org
//      (Sailendra). Until per-tenant credentials exist, only members of that org
//      may trigger them; everyone else gets a clear "not configured" error
//      BEFORE any external call is made.

/** Integrations whose credentials come from the server env (default org only). */
export type EnvIntegration = 'whatsapp' | 'portal' | 'zoom' | 'email';

export const NOT_SIGNED_IN_MESSAGE = 'Unauthorized';
export const NO_ORG_MESSAGE = 'Akun Anda belum terdaftar di organisasi mana pun.';

export const INTEGRATION_NOT_CONFIGURED_MESSAGE: Record<EnvIntegration, string> = {
    whatsapp: 'Integrasi WhatsApp belum dikonfigurasi untuk organisasi ini.',
    portal: 'Integrasi Portal belum dikonfigurasi untuk organisasi ini.',
    zoom: 'Integrasi Zoom belum dikonfigurasi untuk organisasi ini.',
    email: 'Integrasi email belum dikonfigurasi untuk organisasi ini.',
};

export type OrgGateResult =
    | { ok: true; orgId: string }
    | { ok: false; status: 401 | 403; error: string };

/** Membership gate: signed in AND a member of some org. */
export function decideOrgMembership(input: {
    signedIn: boolean;
    orgId: string | null;
}): OrgGateResult {
    if (!input.signedIn) return { ok: false, status: 401, error: NOT_SIGNED_IN_MESSAGE };
    if (!input.orgId) return { ok: false, status: 403, error: NO_ORG_MESSAGE };
    return { ok: true, orgId: input.orgId };
}

/**
 * Env-credential gate: membership first, then the caller's org must be the
 * default org (the one that owns the env credentials).
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
