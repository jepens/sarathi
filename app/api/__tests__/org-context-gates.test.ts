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
    tables: [] as string[],
    rpcs: [] as string[],
    storage: 0,
    generateEmbedding: vi.fn(),
    generateRAGResponse: vi.fn(),
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppMedia: vi.fn(),
    uploadWhatsAppMedia: vi.fn(),
    revalidatePath: vi.fn(),
}));

// Chainable query builder: every terminal resolves to "no row" — the
// membership lookup therefore says "not a member", and nothing else should ever
// be reached on the refusal paths.
function query() {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'update', 'upsert', 'delete', 'in', 'not', 'gte', 'lte', 'or', 'is']) {
        q[m] = () => q;
    }
    q.maybeSingle = async () => ({ data: null, error: null });
    q.single = async () => ({ data: null, error: null });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return q;
}

const fakeClient = {
    auth: {
        getClaims: vi.fn(async () =>
            h.session
                ? { data: { claims: { sub: 'user-1' } }, error: null }
                : { data: null, error: null }
        ),
    },
    from: (table: string) => {
        h.tables.push(table);
        return query();
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
vi.mock('@/lib/supabase/service', () => ({
    createServiceOrServerClient: vi.fn(async () => ({
        from: () => ({
            select: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: { value: DEFAULT_ORG } }) }),
            }),
        }),
    })),
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
import { createBooking, deleteBooking } from '@/app/dashboard/orders/actions';
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
];

beforeEach(() => {
    vi.clearAllMocks();
    h.session = true;
    h.tables = [];
    h.rpcs = [];
    h.storage = 0;
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

describe('POST /api/push/unsubscribe (session-only gate)', () => {
    const req = () => jsonReq('http://localhost/api/push/unsubscribe', { endpoint: 'https://push.example/1' });

    it('401 without a session, before touching push_subscriptions', async () => {
        h.session = false;
        const res = await pushUnsubscribePOST(req());
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: NOT_SIGNED_IN_MESSAGE });
        expect(h.tables).toEqual([]);
    });

    it('lets a signed-in user without membership remove their own device', async () => {
        const res = await pushUnsubscribePOST(req());
        expect(res.status).toBe(200);
        expect(h.tables).toEqual(['push_subscriptions']);
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
