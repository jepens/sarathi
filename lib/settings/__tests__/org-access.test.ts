import { describe, it, expect } from 'vitest';
import {
    decideEnvIntegrationAccess,
    decideOrgContext,
    decideOrgMembership,
    INTEGRATION_NOT_CONFIGURED_MESSAGE,
    NO_ORG_MESSAGE,
    NOT_SIGNED_IN_MESSAGE,
    ORG_LOOKUP_FAILED_MESSAGE,
    toOrgRole,
} from '@/lib/settings/org-access';

// The Fase 0 containment rules (KEA-2): a signed-in user operates only the org
// they are a member of, and the env-credential integrations (Zoom, Resend)
// and Sailendra's proposal documents are reserved for members of the default
// org. WhatsApp has its own gate (lib/whatsapp/integration.ts, 2.2b).

const DEFAULT_ORG = '5a11e024-0001-4000-8000-000000000001';
const PILOT_ORG = '0b0e6c1e-1111-4222-8333-444455556666';

describe('decideOrgMembership', () => {
    it('401 when not signed in', () => {
        expect(decideOrgMembership({ signedIn: false, orgId: null })).toEqual({
            ok: false,
            status: 401,
            error: NOT_SIGNED_IN_MESSAGE,
        });
        // User-facing copy is Bahasa Indonesia, not a bare English status.
        expect(NOT_SIGNED_IN_MESSAGE).toBe('Sesi tidak valid — silakan login ulang.');
    });

    it('403 when signed in but not a member of any org', () => {
        expect(decideOrgMembership({ signedIn: true, orgId: null })).toEqual({
            ok: false,
            status: 403,
            error: NO_ORG_MESSAGE,
        });
    });

    it('passes the member org through', () => {
        expect(decideOrgMembership({ signedIn: true, orgId: PILOT_ORG })).toEqual({
            ok: true,
            orgId: PILOT_ORG,
        });
    });
});

describe('decideOrgContext', () => {
    const member = { orgId: PILOT_ORG, role: 'admin' as const };

    it('401 without a verified session — membership is never consulted', () => {
        expect(decideOrgContext({ userId: null, membership: member })).toEqual({
            ok: false,
            status: 401,
            error: NOT_SIGNED_IN_MESSAGE,
        });
        expect(
            decideOrgContext({ userId: null, membership: null, lookupFailed: true })
        ).toMatchObject({ ok: false, status: 401 });
    });

    it('403 when signed in without any membership (no default-org fallback)', () => {
        expect(decideOrgContext({ userId: 'user-1', membership: null })).toEqual({
            ok: false,
            status: 403,
            error: NO_ORG_MESSAGE,
        });
    });

    it('500 when the membership lookup itself failed (never "no org")', () => {
        expect(
            decideOrgContext({ userId: 'user-1', membership: null, lookupFailed: true })
        ).toEqual({ ok: false, status: 500, error: ORG_LOOKUP_FAILED_MESSAGE });
    });

    it('returns user, org and role for a member', () => {
        expect(decideOrgContext({ userId: 'user-1', membership: member })).toEqual({
            ok: true,
            userId: 'user-1',
            orgId: PILOT_ORG,
            role: 'admin',
        });
    });
});

describe('toOrgRole', () => {
    it('keeps known roles and downgrades anything else to staff', () => {
        expect(toOrgRole('owner')).toBe('owner');
        expect(toOrgRole('admin')).toBe('admin');
        expect(toOrgRole('staff')).toBe('staff');
        expect(toOrgRole('superuser')).toBe('staff');
        expect(toOrgRole(null)).toBe('staff');
    });
});

describe('decideEnvIntegrationAccess', () => {
    it('lets default-org members use the env integrations (no Sailendra regression)', () => {
        for (const integration of ['zoom', 'email', 'proposals'] as const) {
            expect(
                decideEnvIntegrationAccess({
                    signedIn: true,
                    orgId: DEFAULT_ORG,
                    defaultOrgId: DEFAULT_ORG,
                    integration,
                })
            ).toEqual({ ok: true, orgId: DEFAULT_ORG });
        }
    });

    it('refuses another org with an Indonesian "not configured" error', () => {
        const res = decideEnvIntegrationAccess({
            signedIn: true,
            orgId: PILOT_ORG,
            defaultOrgId: DEFAULT_ORG,
            integration: 'email',
        });
        expect(res).toEqual({
            ok: false,
            status: 403,
            error: INTEGRATION_NOT_CONFIGURED_MESSAGE.email,
        });
        expect(INTEGRATION_NOT_CONFIGURED_MESSAGE.whatsapp).toBe(
            'Integrasi WhatsApp belum dikonfigurasi untuk organisasi ini.'
        );
    });

    it('checks membership before the default-org comparison', () => {
        expect(
            decideEnvIntegrationAccess({
                signedIn: false,
                orgId: null,
                defaultOrgId: DEFAULT_ORG,
                integration: 'proposals',
            })
        ).toMatchObject({ ok: false, status: 401 });
        expect(
            decideEnvIntegrationAccess({
                signedIn: true,
                orgId: null,
                defaultOrgId: DEFAULT_ORG,
                integration: 'zoom',
            })
        ).toMatchObject({ ok: false, status: 403, error: NO_ORG_MESSAGE });
    });

    it('never treats an empty default org id as a match', () => {
        expect(
            decideEnvIntegrationAccess({
                signedIn: true,
                orgId: PILOT_ORG,
                defaultOrgId: '',
                integration: 'email',
            })
        ).toMatchObject({ ok: false, status: 403 });
    });
});
