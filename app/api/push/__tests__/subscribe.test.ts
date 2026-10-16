import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/push/subscribe (KUA-5, owner decision D19, migration 0065): the
// device is registered through the register_push_subscription RPC in the
// member's own session. The org always comes from the server-side context,
// never from the body, and no service-role client is involved. The gate
// refusals (401 / 403 before any work) are covered in
// app/api/__tests__/org-context-gates.test.ts.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';

const h = vi.hoisted(() => ({
    rpc: vi.fn(),
    from: vi.fn(),
    createServiceOrServerClient: vi.fn(),
}));

vi.mock('@/lib/settings/org-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/settings/org-context')>();
    return {
        accessDeniedResponse: actual.accessDeniedResponse,
        // A signed-in member of ORG; the cookie-bound client is a stub.
        requireOrgContext: vi.fn(async () => ({
            ok: true,
            supabase: { rpc: h.rpc, from: h.from },
            userId: 'user-a1',
            orgId: ORG,
            role: 'owner',
        })),
    };
});
vi.mock('@/lib/supabase/service', () => ({
    createServiceOrServerClient: h.createServiceOrServerClient,
}));

import { POST } from '@/app/api/push/subscribe/route';
import { NO_ORG_MESSAGE } from '@/lib/settings/org-access';

function req(body: unknown): Request {
    return new Request('http://localhost/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/perangkat-1',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    userAgent: 'Browser A',
};

beforeEach(() => {
    vi.clearAllMocks();
    h.rpc.mockResolvedValue({ data: null, error: null });
});

describe('POST /api/push/subscribe', () => {
    it('registers through the RPC with the context org, even when the body names another org', async () => {
        const res = await POST(
            req({ ...subscription, org_id: OTHER_ORG, orgId: OTHER_ORG, p_org: OTHER_ORG, user_id: 'user-b1' })
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(h.rpc).toHaveBeenCalledTimes(1);
        expect(h.rpc).toHaveBeenCalledWith('register_push_subscription', {
            p_org: ORG,
            p_endpoint: subscription.endpoint,
            p_p256dh: 'p256dh-key',
            p_auth: 'auth-key',
            p_user_agent: 'Browser A',
        });
        // No direct table write and no service-role client.
        expect(h.from).not.toHaveBeenCalled();
        expect(h.createServiceOrServerClient).not.toHaveBeenCalled();
    });

    it('cuts the user agent to 400 characters and sends null without one', async () => {
        await POST(req({ ...subscription, userAgent: 'x'.repeat(500) }));
        await POST(req({ endpoint: subscription.endpoint, keys: subscription.keys }));

        expect(h.rpc.mock.calls.map(([, args]) => args.p_user_agent)).toEqual(['x'.repeat(400), null]);
    });

    it.each([
        ['a body that is not JSON', '{', 'Invalid JSON'],
        ['missing keys', { endpoint: subscription.endpoint }, 'Missing subscription fields'],
        ['an http:// endpoint', { ...subscription, endpoint: 'http://push.example/1' }, 'Missing subscription fields'],
        ['a non-string endpoint', { ...subscription, endpoint: 42 }, 'Missing subscription fields'],
    ])('400 for %s, before any RPC', async (_label, body, error) => {
        const res = await POST(req(body));

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error });
        expect(h.rpc).not.toHaveBeenCalled();
        expect(h.createServiceOrServerClient).not.toHaveBeenCalled();
    });

    it('answers 403 when the RPC refuses the membership (42501)', async () => {
        h.rpc.mockResolvedValue({
            data: null,
            error: { code: '42501', message: 'not authorized to register push devices for this org' },
        });

        const res = await POST(req(subscription));

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: NO_ORG_MESSAGE });
    });

    it('answers 400 when the RPC refuses the input (22023)', async () => {
        h.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'invalid push subscription' } });

        const res = await POST(req(subscription));

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Missing subscription fields' });
    });

    it('keeps 500 for any other RPC error', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        h.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'internal error' } });

        const res = await POST(req(subscription));

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Gagal menyimpan langganan notifikasi' });
        log.mockRestore();
    });
});
