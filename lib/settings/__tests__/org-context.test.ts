import { describe, it, expect, vi, beforeEach } from 'vitest';

// requireOrgContext() is the single gate every API route, server action and
// dashboard server component goes through (KEA-2, KUA-14). These tests drive
// the real helper against a stubbed Supabase client and prove:
//   - the session is verified with auth.getClaims() (never trusted blindly);
//   - no session → 401 before any data query; no membership → 403; a failed
//     membership lookup → 500 (never silently "no org");
//   - members get { supabase, userId, orgId, role } from organization_members;
//   - requireEnvIntegration builds on it, keeps the default-org rule and
//     verifies the session STRICTLY with auth.getUser() (Auth round trip), so
//     a revoked session cannot trigger external side effects;
//   - an Auth outage / retryable error answers 503, never 401 (no /login
//     redirect loop, no "you are signed out" for a transient failure).

const DEFAULT_ORG = '5a11e024-0001-4000-8000-000000000001';
const PILOT_ORG = '0b0e6c1e-1111-4222-8333-444455556666';

type Session = 'none' | 'error' | 'throws' | 'retryable' | 'auth5xx' | 'user';
type ServerUser = 'user' | 'revoked' | 'retryable' | 'none';

const state = vi.hoisted(() => ({
    session: 'user' as 'none' | 'error' | 'throws' | 'retryable' | 'auth5xx' | 'user',
    serverUser: 'user' as 'user' | 'revoked' | 'retryable' | 'none',
    membership: null as { org_id: string; role: string } | null,
    membershipError: null as unknown,
    tables: [] as string[],
    serviceTables: [] as string[],
    defaultOrg: '5a11e024-0001-4000-8000-000000000001',
}));

function chain(terminal: () => Promise<unknown>) {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
    q.maybeSingle = terminal;
    return q;
}

const userClient = {
    auth: {
        getClaims: vi.fn(async () => {
            const s: Session = state.session;
            if (s === 'throws') throw new Error('network down');
            if (s === 'error') return { data: null, error: { message: 'invalid JWT' } };
            if (s === 'retryable') return { data: null, error: new AuthRetryableFetchError('fetch failed', 0) };
            if (s === 'auth5xx') return { data: null, error: new AuthApiError('boom', 500, undefined) };
            if (s === 'none') return { data: null, error: null };
            return { data: { claims: { sub: 'user-1' } }, error: null };
        }),
        getUser: vi.fn(async () => {
            const u: ServerUser = state.serverUser;
            if (u === 'revoked') {
                return { data: { user: null }, error: new AuthApiError('Session not found', 403, 'session_not_found') };
            }
            if (u === 'retryable') {
                return { data: { user: null }, error: new AuthRetryableFetchError('Service unavailable', 503) };
            }
            if (u === 'none') return { data: { user: null }, error: new AuthSessionMissingError() };
            return { data: { user: { id: 'user-1' } }, error: null };
        }),
    },
    from: (table: string) => {
        state.tables.push(table);
        return chain(async () => ({
            data: state.membershipError ? null : state.membership,
            error: state.membershipError,
        }));
    },
};

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => userClient) }));
vi.mock('@/lib/supabase/service', () => ({
    createServiceOrServerClient: vi.fn(async () => ({
        from: (table: string) => {
            state.serviceTables.push(table);
            return chain(async () => ({ data: { value: state.defaultOrg }, error: null }));
        },
    })),
}));

import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import {
    accessDeniedResponse,
    isDefaultOrg,
    requireEnvIntegration,
    requireOrgContext,
    requireUserContext,
} from '@/lib/settings/org-context';
import {
    INTEGRATION_NOT_CONFIGURED_MESSAGE,
    NO_ORG_MESSAGE,
    NOT_SIGNED_IN_MESSAGE,
    ORG_LOOKUP_FAILED_MESSAGE,
    SESSION_CHECK_FAILED_MESSAGE,
} from '@/lib/settings/org-access';

beforeEach(() => {
    vi.clearAllMocks();
    state.session = 'user';
    state.serverUser = 'user';
    state.membership = null;
    state.membershipError = null;
    state.tables = [];
    state.serviceTables = [];
    state.defaultOrg = DEFAULT_ORG;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('requireOrgContext', () => {
    it.each(['none', 'error'] as const)(
        'answers 401 without a verified session (%s) and queries nothing',
        async (session) => {
            state.session = session;
            await expect(requireOrgContext()).resolves.toEqual({
                ok: false,
                status: 401,
                error: NOT_SIGNED_IN_MESSAGE,
            });
            expect(state.tables).toEqual([]);
        }
    );

    it.each(['retryable', 'auth5xx', 'throws'] as const)(
        'answers 503 (not 401) when the session cannot be verified right now (%s)',
        async (session) => {
            state.session = session;
            await expect(requireOrgContext()).resolves.toEqual({
                ok: false,
                status: 503,
                error: SESSION_CHECK_FAILED_MESSAGE,
            });
            expect(state.tables).toEqual([]);
        }
    );

    it('verifies the session with getClaims(), not getUser()', async () => {
        state.membership = { org_id: PILOT_ORG, role: 'owner' };
        await requireOrgContext();
        expect(userClient.auth.getClaims).toHaveBeenCalledTimes(1);
        expect(userClient.auth.getUser).not.toHaveBeenCalled();
    });

    it('answers 403 for a signed-in user without a membership', async () => {
        await expect(requireOrgContext()).resolves.toEqual({
            ok: false,
            status: 403,
            error: NO_ORG_MESSAGE,
        });
        expect(state.tables).toEqual(['organization_members']);
    });

    it('answers 500 when the membership lookup fails', async () => {
        state.membershipError = { message: 'db down' };
        await expect(requireOrgContext()).resolves.toEqual({
            ok: false,
            status: 500,
            error: ORG_LOOKUP_FAILED_MESSAGE,
        });
    });

    it('returns the RLS client, user, org and role for a member', async () => {
        state.membership = { org_id: PILOT_ORG, role: 'staff' };
        const access = await requireOrgContext();
        expect(access).toEqual({
            ok: true,
            supabase: userClient,
            userId: 'user-1',
            orgId: PILOT_ORG,
            role: 'staff',
        });
    });
});

describe('requireOrgContext({ strict: true })', () => {
    it('verifies the session with the Auth server (getUser), not getClaims', async () => {
        state.membership = { org_id: PILOT_ORG, role: 'owner' };
        await expect(requireOrgContext({ strict: true })).resolves.toMatchObject({ ok: true, userId: 'user-1' });
        expect(userClient.auth.getUser).toHaveBeenCalledTimes(1);
        expect(userClient.auth.getClaims).not.toHaveBeenCalled();
    });

    it.each(['revoked', 'none'] as const)(
        'answers 401 for a %s session even though the JWT still verifies locally',
        async (serverUser) => {
            state.serverUser = serverUser;
            state.membership = { org_id: DEFAULT_ORG, role: 'owner' };
            await expect(requireOrgContext({ strict: true })).resolves.toEqual({
                ok: false,
                status: 401,
                error: NOT_SIGNED_IN_MESSAGE,
            });
            expect(state.tables).toEqual([]);
        }
    );

    it('answers 503 when the Auth server is unreachable', async () => {
        state.serverUser = 'retryable';
        await expect(requireOrgContext({ strict: true })).resolves.toMatchObject({ ok: false, status: 503 });
        expect(state.tables).toEqual([]);
    });
});

describe('requireEnvIntegration', () => {
    it('checks the session strictly — a revoked session cannot reach the integration', async () => {
        state.membership = { org_id: DEFAULT_ORG, role: 'owner' };
        state.serverUser = 'revoked';
        await expect(requireEnvIntegration('whatsapp')).resolves.toMatchObject({ ok: false, status: 401 });
        expect(userClient.auth.getUser).toHaveBeenCalledTimes(1);
        expect(userClient.auth.getClaims).not.toHaveBeenCalled();
        expect(state.tables).toEqual([]);
        expect(state.serviceTables).toEqual([]);
    });

    it('lets default-org members through (no Sailendra regression)', async () => {
        state.membership = { org_id: DEFAULT_ORG, role: 'owner' };
        await expect(requireEnvIntegration('whatsapp')).resolves.toMatchObject({
            ok: true,
            orgId: DEFAULT_ORG,
            userId: 'user-1',
            supabase: userClient,
        });
    });

    it('refuses another tenant with the integration message', async () => {
        state.membership = { org_id: PILOT_ORG, role: 'owner' };
        await expect(requireEnvIntegration('portal')).resolves.toEqual({
            ok: false,
            status: 403,
            error: INTEGRATION_NOT_CONFIGURED_MESSAGE.portal,
        });
    });

    it('never resolves the default org for a caller without a session or org', async () => {
        state.serverUser = 'none';
        await expect(requireEnvIntegration('zoom')).resolves.toMatchObject({ status: 401 });
        state.serverUser = 'user';
        await expect(requireEnvIntegration('zoom')).resolves.toMatchObject({ status: 403 });
        expect(state.serviceTables).toEqual([]);
    });
});

describe('requireUserContext', () => {
    it('only needs a session — a non-member still gets their own context', async () => {
        await expect(requireUserContext()).resolves.toEqual({
            ok: true,
            supabase: userClient,
            userId: 'user-1',
        });
        expect(state.tables).toEqual([]);
    });

    it('answers 401 without a session', async () => {
        state.session = 'none';
        await expect(requireUserContext()).resolves.toMatchObject({ ok: false, status: 401 });
    });

    it('answers 503 when the session cannot be verified right now', async () => {
        state.session = 'retryable';
        await expect(requireUserContext()).resolves.toMatchObject({ ok: false, status: 503 });
    });
});

describe('isDefaultOrg', () => {
    it('compares against the default org from app_settings', async () => {
        await expect(isDefaultOrg(DEFAULT_ORG)).resolves.toBe(true);
        await expect(isDefaultOrg(PILOT_ORG)).resolves.toBe(false);
        await expect(isDefaultOrg(null)).resolves.toBe(false);
    });
});

describe('accessDeniedResponse', () => {
    it('renders the refusal as { error } JSON with the gate status', async () => {
        const res = accessDeniedResponse({ ok: false, status: 403, error: NO_ORG_MESSAGE });
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: NO_ORG_MESSAGE });
    });
});
