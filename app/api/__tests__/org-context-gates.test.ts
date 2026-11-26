import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route-level guard for the central org context (KEA-2, KUA-14). Representative
// API routes and server actions run against the REAL requireOrgContext() with a
// stubbed Supabase client, and must refuse BEFORE doing any work:
//   - no session      → 401 { error: NOT_SIGNED_IN_MESSAGE }, zero queries;
//   - no membership   → 403 { error: NO_ORG_MESSAGE }, only the membership
//                       lookup ran;
// and in both cases the request body is never read and no external call
// (OpenAI, Meta) is made.

const DEFAULT_ORG = '5a11e024-0001-4000-8000-000000000001';

const h = vi.hoisted(() => ({
    session: true,
    // JWT still verifies locally (getClaims) but the Auth server says the
    // session was revoked (sign-out elsewhere / banned user).
    revoked: false,
    tables: [] as string[],
    rpcs: [] as string[],
    storage: 0,
    serviceCalls: [] as string[],
    generateEmbedding: vi.fn(),
    generateRAGResponse: vi.fn(),
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppMedia: vi.fn(),
    uploadWhatsAppMedia: vi.fn(),
    revalidatePath: vi.fn(),
    sendPaymentNotification: vi.fn(),
    sendCancellationNotification: vi.fn(),
    // Per-table stub rows (default: none). `single` answers maybeSingle/single,
    // `list` answers an awaited query.
    rows: {} as Record<string, { single?: unknown; list?: unknown[] }>,
    // The service-role read of a platform setting fails (e.g. a timeout).
    serviceReadFails: false,
}));

// Chainable query builder: unless a test seeds h.rows, every terminal resolves
// to "no row" — the membership lookup therefore says "not a member", and
// nothing else should ever be reached on the refusal paths.
function query(table = '') {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'update', 'upsert', 'delete', 'in', 'not', 'gte', 'lte', 'or', 'is']) {
        q[m] = () => q;
    }
    const seeded = h.rows[table];
    q.maybeSingle = async () => ({ data: seeded?.single ?? null, error: null });
    q.single = async () => ({ data: seeded?.single ?? null, error: null });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: seeded?.list ?? [], error: null });
    return q;
}

const fakeClient = {
    auth: {
        getClaims: vi.fn(async () =>
            h.session
                ? { data: { claims: { sub: 'user-1' } }, error: null }
                : { data: null, error: null }
        ),
        // Strict check (requireEnvIntegration → requireOrgContext({ strict: true })).
        getUser: vi.fn(async () =>
            h.session && !h.revoked
                ? { data: { user: { id: 'user-1' } }, error: null }
                : { data: { user: null }, error: null }
        ),
    },
    from: (table: string) => {
        h.tables.push(table);
        return query(table);
    },
    rpc: (fn: string) => {
        h.rpcs.push(fn);
        return query();
    },
    get storage() {
        h.storage++;
        return { from: () => ({ upload: vi.fn(), download: vi.fn(), remove: vi.fn() }) };
    },
};

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => fakeClient) }));
// Service-role stub: records every call as "method(args)" so tests can prove
// the exact filters of a service-role write (it bypasses RLS).
vi.mock('@/lib/supabase/service', () => ({
    createServiceOrServerClient: vi.fn(async () => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'delete', 'eq']) {
            q[m] = (...args: unknown[]) => {
                h.serviceCalls.push(`${m}(${args.map((a) => JSON.stringify(a)).join(',')})`);
                return q;
            };
        }
        q.maybeSingle = async () =>
            h.serviceReadFails
                ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 }
                : { data: { value: DEFAULT_ORG } };
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
        return {
            from: (table: string) => {
                h.serviceCalls.push(`from(${JSON.stringify(table)})`);
                return q;
            },
        };
    }),
}));
// The credential resolver's own service-role client (Fase 2 task 2.2d): it
// answers wa_org_send_credentials with the default org's number (fake) only.
vi.mock('@/lib/whatsapp/webhook/service-client', () => ({
    serviceRoleClient: () => ({
        rpc: async (name: string, args: { p_org?: string }) => {
            h.serviceCalls.push(`rpc(${JSON.stringify(name)})`);
            if (h.serviceReadFails) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 };
            if (name !== 'wa_org_send_credentials' || args.p_org !== DEFAULT_ORG) return { data: [], error: null, status: 200 };
            return {
                data: [{
                    integration_id: 'eeeeeeee-0000-4000-8000-00000000000e',
                    app_id: 'cccccccc-0000-4000-8000-00000000000c',
                    phone_number_id: '100000000000001',
                    waba_id: '200000000000001',
                    access_token: 'token-palsu',
                    status: 'active',
                    app_status: 'active',
                }],
                error: null,
                status: 200,
            };
        },
    }),
}));
vi.mock('@/lib/ai/embedding', () => ({ generateEmbedding: h.generateEmbedding }));
vi.mock('@/lib/ai/rag', () => ({ generateRAGResponse: h.generateRAGResponse }));
vi.mock('@/lib/ai/parsing', () => ({ chunkText: () => [], parseFile: vi.fn() }));
vi.mock('@/lib/whatsapp/client', () => ({
    sendWhatsAppMessage: h.sendWhatsAppMessage,
    sendWhatsAppMedia: h.sendWhatsAppMedia,
    uploadWhatsAppMedia: h.uploadWhatsAppMedia,
    classifyMedia: () => 'image',
    mediaMaxBytes: () => 5 * 1024 * 1024,
    describeWhatsAppError: () => 'error',
}));
vi.mock('@/lib/utils/logger', () => ({
    whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/lib/notifications/notifications', () => ({
    sendPaymentNotification: h.sendPaymentNotification,
    sendCancellationNotification: h.sendCancellationNotification,
}));

import { NO_ORG_MESSAGE, NOT_SIGNED_IN_MESSAGE } from '@/lib/settings/org-access';
import { GET as leadsGET, POST as leadsPOST } from '@/app/api/leads/route';
import { PATCH as leadPATCH, DELETE as leadDELETE } from '@/app/api/leads/[phone]/route';
import { POST as leadsImportPOST } from '@/app/api/leads/import/route';
import { POST as chatPOST } from '@/app/api/chat/route';
import { POST as chatStreamPOST } from '@/app/api/chat/stream/route';
import { POST as chatSendPOST } from '@/app/api/chat/send/route';
import { POST as chatSendMediaPOST } from '@/app/api/chat/send-media/route';
import { POST as ingestPOST } from '@/app/api/ingest/route';
import { POST as knowledgePOST } from '@/app/api/knowledge/text/route';
import { POST as productsPOST } from '@/app/api/products/route';
import { DELETE as documentsDELETE } from '@/app/api/documents/route';
import { GET as statsGET } from '@/app/api/dashboard/stats/route';
import { GET as systemMessageGET } from '@/app/api/system-message/route';
import { POST as vendorsPOST } from '@/app/api/vendors/route';
import { POST as pushSubscribePOST } from '@/app/api/push/subscribe/route';
import { POST as pushUnsubscribePOST } from '@/app/api/push/unsubscribe/route';
import { POST as searchPOST } from '@/app/api/search/route';
import { createBooking, deleteBooking, updateOrderStatus } from '@/app/dashboard/orders/actions';
import { updateBusinessProfile } from '@/app/dashboard/settings/actions';

function jsonReq(url: string, body: unknown, method = 'POST'): Request {
    return new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function mediaReq(): Request {
    const form = new FormData();
    form.set('phone_number', '628111');
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }));
    return new Request('http://localhost/api/chat/send-media', { method: 'POST', body: form });
}

const phoneParams = { params: Promise.resolve({ phone: '628111' }) };

interface RouteCase {
    name: string;
    // A fresh request per run, so the test can check its body was never read.
    request: () => Request;
    call: (req: Request) => Promise<Response>;
}

const routes: RouteCase[] = [
    { name: 'GET /api/leads', request: () => new Request('http://localhost/api/leads'), call: (r) => leadsGET(r) },
    {
        name: 'POST /api/leads',
        request: () => jsonReq('http://localhost/api/leads', { contact_name: 'A', phone_number: '628111' }),
        call: (r) => leadsPOST(r),
    },
    {
        name: 'PATCH /api/leads/[phone]',
        request: () => jsonReq('http://localhost/api/leads/628111', { lead_stage: 'won' }, 'PATCH'),
        call: (r) => leadPATCH(r, phoneParams),
    },
    {
        name: 'DELETE /api/leads/[phone]',
        request: () => new Request('http://localhost/api/leads/628111', { method: 'DELETE' }),
        call: (r) => leadDELETE(r, phoneParams),
    },
    {
        name: 'POST /api/leads/import',
        request: () => jsonReq('http://localhost/api/leads/import', { rows: [{ phone_number: '628111' }] }),
        call: (r) => leadsImportPOST(r),
    },
    {
        name: 'POST /api/chat',
        request: () => jsonReq('http://localhost/api/chat', { message: 'hi', history: [] }),
        call: (r) => chatPOST(r),
    },
    {
        name: 'POST /api/chat/stream',
        request: () => jsonReq('http://localhost/api/chat/stream', { message: 'hi', history: [] }),
        call: (r) => chatStreamPOST(r),
    },
    {
        name: 'POST /api/chat/send',
        request: () => jsonReq('http://localhost/api/chat/send', { phone_number: '628111', message: 'hi' }),
        call: (r) => chatSendPOST(r),
    },
    { name: 'POST /api/chat/send-media', request: mediaReq, call: (r) => chatSendMediaPOST(r) },
    {
        name: 'POST /api/ingest',
        request: () => jsonReq('http://localhost/api/ingest', { filePath: 'x/a.pdf', fileType: 'application/pdf' }),
        call: (r) => ingestPOST(r),
    },
    {
        name: 'POST /api/knowledge/text',
        request: () => jsonReq('http://localhost/api/knowledge/text', { title: 'T', content: 'C' }),
        call: (r) => knowledgePOST(r),
    },
    {
        name: 'POST /api/products',
        request: () => jsonReq('http://localhost/api/products', { name: 'P', description: 'D', price: 1 }),
        call: (r) => productsPOST(r),
    },
    {
        name: 'DELETE /api/documents',
        request: () => new Request('http://localhost/api/documents?fileName=a.pdf', { method: 'DELETE' }),
        call: (r) => documentsDELETE(r),
    },
    { name: 'GET /api/dashboard/stats', request: () => new Request('http://localhost/api/dashboard/stats'), call: () => statsGET() },
    {
        name: 'GET /api/system-message',
        request: () => new Request('http://localhost/api/system-message'),
        call: (r) => systemMessageGET(r),
    },
    {
        name: 'POST /api/vendors',
        request: () => jsonReq('http://localhost/api/vendors', { name: 'V', category: 'venue' }),
        call: (r) => vendorsPOST(r),
    },
    {
        name: 'POST /api/push/subscribe',
        request: () =>
            jsonReq('http://localhost/api/push/subscribe', {
                endpoint: 'https://push.example/1',
                keys: { p256dh: 'k', auth: 'a' },
            }),
        call: (r) => pushSubscribePOST(r),
    },
    {
        name: 'POST /api/search',
        request: () => jsonReq('http://localhost/api/search', { query: 'q' }),
        call: (r) => searchPOST(r),
    },
];

const externals = () => [
    h.generateEmbedding,
    h.generateRAGResponse,
    h.sendWhatsAppMessage,
    h.sendWhatsAppMedia,
    h.uploadWhatsAppMedia,
    h.revalidatePath,
    h.sendPaymentNotification,
    h.sendCancellationNotification,
];

beforeEach(() => {
    vi.clearAllMocks();
    h.session = true;
    h.revoked = false;
    h.tables = [];
    h.rpcs = [];
    h.storage = 0;
    h.serviceCalls = [];
    h.rows = {};
    h.serviceReadFails = false;
});

describe.each(routes)('$name', ({ request, call }) => {
    it('401 without a session — before any query, body read or external call', async () => {
        h.session = false;
        const req = request();

        const res = await call(req);

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: NOT_SIGNED_IN_MESSAGE });
        expect(req.bodyUsed).toBe(false);
        expect(h.tables).toEqual([]);
        expect(h.rpcs).toEqual([]);
        expect(h.storage).toBe(0);
        for (const ext of externals()) expect(ext).not.toHaveBeenCalled();
    });

    it('403 without an org membership — only the membership lookup ran', async () => {
        const req = request();

        const res = await call(req);

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: NO_ORG_MESSAGE });
        expect(req.bodyUsed).toBe(false);
        expect(h.tables).toEqual(['organization_members']);
        expect(h.rpcs).toEqual([]);
        expect(h.storage).toBe(0);
        for (const ext of externals()) expect(ext).not.toHaveBeenCalled();
    });
});

describe('env-integration routes verify the session with the Auth server', () => {
    const sideEffectRoutes = routes.filter((r) => r.name.startsWith('POST /api/chat/send'));

    it('covers the WhatsApp send routes', () => {
        expect(sideEffectRoutes.map((r) => r.name)).toEqual(['POST /api/chat/send', 'POST /api/chat/send-media']);
    });

    describe.each(sideEffectRoutes)('$name', ({ request, call }) => {
        it('401 for a revoked session whose JWT still verifies locally — nothing is sent', async () => {
            h.revoked = true;
            const req = request();

            const res = await call(req);

            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: NOT_SIGNED_IN_MESSAGE });
            expect(fakeClient.auth.getUser).toHaveBeenCalled();
            expect(req.bodyUsed).toBe(false);
            expect(h.tables).toEqual([]);
            for (const ext of externals()) expect(ext).not.toHaveBeenCalled();
        });
    });

    it('non-integration routes keep the local getClaims check (no Auth round trip)', async () => {
        h.revoked = true;
        const res = await leadsGET(new Request('http://localhost/api/leads'));
        expect(res.status).toBe(403); // signed in per JWT, no membership in the stub
        expect(fakeClient.auth.getUser).not.toHaveBeenCalled();
    });
});

describe('POST /api/push/unsubscribe (session-only gate)', () => {
    const req = () => jsonReq('http://localhost/api/push/unsubscribe', { endpoint: 'https://push.example/1' });

    it('401 without a session, before touching push_subscriptions', async () => {
        h.session = false;
        const res = await pushUnsubscribePOST(req());
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: NOT_SIGNED_IN_MESSAGE });
        expect(h.tables).toEqual([]);
        expect(h.serviceCalls).toEqual([]);
    });

    it('lets a signed-in user without membership remove their own device (service role, own rows only)', async () => {
        const res = await pushUnsubscribePOST(req());
        expect(res.status).toBe(200);
        // RLS on push_subscriptions requires membership, so the delete runs with
        // the service-role client — strictly scoped to this endpoint AND the
        // verified user. Nothing goes through the RLS client.
        expect(h.tables).toEqual([]);
        expect(h.serviceCalls).toEqual([
            'from("push_subscriptions")',
            'delete()',
            'eq("endpoint","https://push.example/1")',
            'eq("user_id","user-1")',
        ]);
    });

    it('never runs an unscoped service-role delete on a bad body', async () => {
        const res = await pushUnsubscribePOST(jsonReq('http://localhost/api/push/unsubscribe', { endpoint: 42 }));
        expect(res.status).toBe(400);
        expect(h.serviceCalls).toEqual([]);
    });
});

describe('server actions', () => {
    const booking = {
        customer_name: 'Budi',
        total_amount: 1000,
        dp_amount: 0,
        status: 'pending',
        order_type: 'service',
    };

    const actions = [
        { name: 'createBooking', run: () => createBooking(booking) },
        { name: 'deleteBooking', run: () => deleteBooking('0b0e6c1e-1111-4222-8333-444455556666') },
    ];

    describe.each(actions)('$name', ({ run }) => {
        it('refuses without a session before any query', async () => {
            h.session = false;
            await expect(run()).resolves.toEqual({ success: false, message: NOT_SIGNED_IN_MESSAGE });
            expect(h.tables).toEqual([]);
        });

        it('refuses without a membership before any tenant query', async () => {
            await expect(run()).resolves.toEqual({ success: false, message: NO_ORG_MESSAGE });
            expect(h.tables).toEqual(['organization_members']);
        });
    });

    it('updateBusinessProfile refuses a non-member before saving', async () => {
        await expect(updateBusinessProfile({} as never)).resolves.toEqual({
            ok: false,
            error: NO_ORG_MESSAGE,
        });
        expect(h.tables).toEqual(['organization_members']);
        expect(h.revalidatePath).not.toHaveBeenCalled();
    });
});

describe("updateOrderStatus (customer WhatsApp from the org's own number)", () => {
    const ORDER_ID = '0b0e6c1e-1111-4222-8333-444455556666';

    // Only the default org has a number (its Vault row, answered by the
    // service-client stub above).
    // A member of `orgId` (default: the default org) and a pending order with a
    // customer phone, so a pending → cancelled change would notify the customer.
    function seedDefaultOrgOrder(orgId = DEFAULT_ORG) {
        h.rows = {
            organization_members: { single: { org_id: orgId, role: 'owner' } },
            orders: {
                single: {
                    id: ORDER_ID,
                    status: 'pending',
                    customer_name: 'Budi',
                    customer_phone: '628111',
                    items: [],
                    total_amount: 1000,
                    delivery_info: '',
                    order_type: 'service',
                },
                list: [{ id: ORDER_ID }],
            },
        };
    }

    it("notifies the customer for a live session (control), with the org's credentials", async () => {
        seedDefaultOrgOrder();
        await expect(updateOrderStatus(ORDER_ID, 'cancelled')).resolves.toMatchObject({ success: true });
        expect(h.sendCancellationNotification).toHaveBeenCalledTimes(1);
        expect(h.sendCancellationNotification.mock.calls[0][0]).toMatchObject({
            orgId: DEFAULT_ORG,
            phoneNumberId: '100000000000001',
            accessToken: 'token-palsu',
        });
        expect(fakeClient.auth.getUser).toHaveBeenCalled();
    });

    it('a phone-hidden customer (BSUID key) is notified at the recovered phone, as AI replies are', async () => {
        seedDefaultOrgOrder();
        h.rows.orders = { ...h.rows.orders, single: { ...(h.rows.orders.single as Record<string, unknown>), customer_phone: 'ID.palsu' } };
        h.rows.whatsapp_chats = { single: { verified_phone: '628222000333' } };
        await expect(updateOrderStatus(ORDER_ID, 'cancelled')).resolves.toMatchObject({ success: true });
        expect(h.sendCancellationNotification).toHaveBeenCalledTimes(1);
        expect(h.sendCancellationNotification.mock.calls[0][1]).toMatchObject({ customer_phone: '628222000333' });
    });

    it('credentials that cannot be read: the status still changes (success), nothing is sent', async () => {
        seedDefaultOrgOrder();
        h.serviceReadFails = true;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await expect(updateOrderStatus(ORDER_ID, 'cancelled')).resolves.toMatchObject({ success: true });
        } finally {
            errorSpy.mockRestore();
        }
        expect(h.sendCancellationNotification).not.toHaveBeenCalled();
        expect(h.sendPaymentNotification).not.toHaveBeenCalled();
    });

    it('an org without a WhatsApp number of its own: the status changes, nothing is sent', async () => {
        seedDefaultOrgOrder('5a11e024-0002-4000-8000-000000000002');
        await expect(updateOrderStatus(ORDER_ID, 'cancelled')).resolves.toMatchObject({ success: true });
        expect(h.sendCancellationNotification).not.toHaveBeenCalled();
        expect(h.sendPaymentNotification).not.toHaveBeenCalled();
    });

    it.each(['paid', 'cancelled'])(
        'refuses a revoked session whose JWT still verifies locally — no %s notification, no query',
        async (status) => {
            seedDefaultOrgOrder();
            h.revoked = true;
            await expect(updateOrderStatus(ORDER_ID, status)).resolves.toEqual({
                success: false,
                message: NOT_SIGNED_IN_MESSAGE,
            });
            expect(fakeClient.auth.getUser).toHaveBeenCalled();
            expect(h.tables).toEqual([]);
            expect(h.sendPaymentNotification).not.toHaveBeenCalled();
            expect(h.sendCancellationNotification).not.toHaveBeenCalled();
        }
    );
});
