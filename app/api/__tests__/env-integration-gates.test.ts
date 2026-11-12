import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Route-level guard for KEA-2: every route/action that uses the env-configured
// WhatsApp / Portal / Zoom / Resend credentials, or Sailendra's proposal
// documents (D8, D26), must run requireEnvIntegration()
// BEFORE its external call. If a refactor moves the gate below the Meta / Portal
// / Zoom / Resend call, these tests fail:
//   - denied: the route answers with the gate's status and the external client
//     is never called;
//   - allowed: the gate is invoked before the external client (call order).
// The external mocks reject on the allowed path so the routes stop right after
// the call we care about (no DB writes to stub).

const h = vi.hoisted(() => ({
    requireEnvIntegration: vi.fn(),
    sendWhatsAppMessage: vi.fn(),
    uploadWhatsAppMedia: vi.fn(),
    sendWhatsAppMedia: vi.fn(),
    listApprovedTemplates: vi.fn(),
    sendTemplateMessage: vi.fn(),
    searchPortalClients: vi.fn(),
    postHandoff: vi.fn(),
    sendProposalEmail: vi.fn(),
    buildProposalPreview: vi.fn(),
    generateFnaSummary: vi.fn(),
    storageUpload: vi.fn(),
}));

// Supabase client stub. from() returns a chainable, thenable query builder:
// every builder method returns itself, terminal reads resolve to a lead row and
// awaiting the chain resolves to "no error". (The client itself must NOT be
// thenable, or `await createClient()` would unwrap it.)
function fakeSupabase() {
    const lead = { phone_number: '628111', portal_client_id: null };
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'update', 'upsert', 'insert']) q[m] = () => q;
    q.single = async () => ({ data: lead, error: null });
    q.maybeSingle = async () => ({ data: lead, error: null });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return { from: () => q, storage: { from: () => ({ upload: h.storageUpload }) } };
}

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => fakeSupabase()) }));
vi.mock('@/lib/settings/org-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/settings/org-context')>();
    return {
        accessDeniedResponse: actual.accessDeniedResponse,
        requireEnvIntegration: h.requireEnvIntegration,
    };
});
vi.mock('@/lib/utils/logger', () => ({
    whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/whatsapp/client', () => ({
    sendWhatsAppMessage: h.sendWhatsAppMessage,
    uploadWhatsAppMedia: h.uploadWhatsAppMedia,
    sendWhatsAppMedia: h.sendWhatsAppMedia,
    classifyMedia: () => 'image',
    mediaMaxBytes: () => 5 * 1024 * 1024,
    describeWhatsAppError: () => 'error',
}));
vi.mock('@/lib/whatsapp/templates', () => ({
    listApprovedTemplates: h.listApprovedTemplates,
    sendTemplateMessage: h.sendTemplateMessage,
    renderTemplateBody: () => '',
    extractBodyVariableIndices: () => [],
}));
vi.mock('@/lib/portal/config', () => ({ isPortalConfigured: () => true }));
vi.mock('@/lib/portal/client', () => ({
    searchPortalClients: h.searchPortalClients,
    postHandoff: h.postHandoff,
    PortalError: class PortalError extends Error {},
}));
vi.mock('@/lib/proposals/send', () => ({ sendProposalEmail: h.sendProposalEmail, buildProposalPreview: h.buildProposalPreview }));
vi.mock('@/lib/proposals/fna', () => ({ normalizeFnaSnapshot: (v: unknown) => v, generateFnaSummary: h.generateFnaSummary }));

import { POST as sendPOST } from '@/app/api/chat/send/route';
import { POST as sendMediaPOST } from '@/app/api/chat/send-media/route';
import { POST as sendTemplatePOST } from '@/app/api/chat/send-template/route';
import { GET as templatesGET } from '@/app/api/chat/templates/route';
import { GET as portalClientsGET } from '@/app/api/portal/clients/route';
import { GET as zoomCheckGET } from '@/app/api/meetings/zoom-check/route';
import { POST as proposalPOST } from '@/app/api/proposals/[phone]/route';
import { POST as proposalUploadPOST } from '@/app/api/proposals/[phone]/upload/route';
import { GET as proposalPreviewGET } from '@/app/api/proposals/[phone]/preview/route';
import { POST as proposalFnaPOST } from '@/app/api/proposals/[phone]/fna-summary/route';
import { handoffToPortal } from '@/app/dashboard/pipeline/actions';

const DENIED = {
    ok: false as const,
    status: 403 as const,
    error: 'Integrasi belum dikonfigurasi untuk organisasi ini.',
};
const ALLOWED = {
    ok: true as const,
    supabase: fakeSupabase(),
    userId: 'user-1',
    orgId: '5a11e024-0001-4000-8000-000000000001',
    role: 'owner' as const,
};

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockRejectedValue(new Error('stop'));
    for (const fn of [
        h.sendWhatsAppMessage,
        h.uploadWhatsAppMedia,
        h.sendWhatsAppMedia,
        h.listApprovedTemplates,
        h.sendTemplateMessage,
        h.searchPortalClients,
        h.postHandoff,
        h.sendProposalEmail,
        h.buildProposalPreview,
        h.generateFnaSummary,
        h.storageUpload,
    ]) {
        fn.mockRejectedValue(new Error('stop'));
    }
    vi.stubEnv('ZOOM_ACCOUNT_ID', 'acct-1234');
    vi.stubEnv('ZOOM_CLIENT_ID', 'cid');
    vi.stubEnv('ZOOM_CLIENT_SECRET', 'secret');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

function jsonReq(url: string, body: unknown): Request {
    return new Request(url, {
        method: 'POST',
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

function pdfReq(): Request {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([37, 80, 68, 70])], 'proposal.pdf', { type: 'application/pdf' }));
    return new Request('http://localhost/api/proposals/628111/upload', { method: 'POST', body: form });
}

const handoffInput = {
    phone: '628111',
    idempotencyKey: '0b0e6c1e-1111-4222-8333-444455556666',
    title: 'Proposal',
    client: { mode: 'new', name: 'PT Contoh' },
};

interface Case {
    name: string;
    run: () => Promise<Response | { ok: boolean; error?: string }>;
    externals: ReturnType<typeof vi.fn>[];
}

const cases: Case[] = [
    {
        name: 'POST /api/chat/send',
        run: () => sendPOST(jsonReq('http://localhost/api/chat/send', { phone_number: '628111', message: 'hi' })),
        externals: [h.sendWhatsAppMessage],
    },
    {
        name: 'POST /api/chat/send-media',
        run: () => sendMediaPOST(mediaReq()),
        externals: [h.uploadWhatsAppMedia, h.sendWhatsAppMedia],
    },
    {
        name: 'POST /api/chat/send-template',
        run: () =>
            sendTemplatePOST(
                jsonReq('http://localhost/api/chat/send-template', {
                    phone_number: '628111',
                    template_name: 'hello',
                    language: 'id',
                }),
            ),
        externals: [h.listApprovedTemplates, h.sendTemplateMessage],
    },
    {
        name: 'GET /api/chat/templates',
        run: () => templatesGET(),
        externals: [h.listApprovedTemplates],
    },
    {
        name: 'GET /api/portal/clients',
        run: () => portalClientsGET(new Request('http://localhost/api/portal/clients?q=astra')),
        externals: [h.searchPortalClients],
    },
    {
        name: 'GET /api/meetings/zoom-check',
        run: () => zoomCheckGET(new Request('http://localhost/api/meetings/zoom-check?create=1')),
        externals: [fetchMock],
    },
    {
        name: 'POST /api/proposals/[phone]',
        run: () => proposalPOST(jsonReq('http://localhost/api/proposals/628111', {}), phoneParams),
        externals: [h.sendProposalEmail],
    },
    {
        name: 'POST /api/proposals/[phone]/upload',
        // The upload validates the phone (8-15 digits) before Storage.
        run: () => proposalUploadPOST(pdfReq(), { params: Promise.resolve({ phone: '6281112223' }) }),
        externals: [h.storageUpload],
    },
    {
        name: 'GET /api/proposals/[phone]/preview',
        run: () => proposalPreviewGET(new Request('http://localhost/api/proposals/628111/preview'), phoneParams),
        externals: [h.buildProposalPreview],
    },
    {
        name: 'POST /api/proposals/[phone]/fna-summary',
        run: () => proposalFnaPOST(new Request('http://localhost/api/proposals/628111/fna-summary', { method: 'POST' }), phoneParams),
        externals: [h.generateFnaSummary],
    },
    {
        name: 'handoffToPortal (server action)',
        run: () => handoffToPortal(handoffInput),
        externals: [h.postHandoff],
    },
];

describe.each(cases)('$name', ({ run, externals }) => {
    it('denied by the env-integration gate → no external call', async () => {
        h.requireEnvIntegration.mockResolvedValue(DENIED);

        const res = await run();

        expect(h.requireEnvIntegration).toHaveBeenCalledTimes(1);
        for (const ext of externals) expect(ext).not.toHaveBeenCalled();
        if (res instanceof Response) {
            expect(res.status).toBe(403);
            expect(await res.json()).toEqual({ error: DENIED.error });
        } else {
            expect(res).toEqual({ ok: false, error: DENIED.error });
        }
    });

    it('allowed → the gate runs before the first external call', async () => {
        h.requireEnvIntegration.mockResolvedValue(ALLOWED);

        // Some routes let the external rejection propagate — only the order matters.
        await run().catch(() => undefined);

        const gateOrder = h.requireEnvIntegration.mock.invocationCallOrder[0];
        const firstExternal = externals[0].mock.invocationCallOrder[0];
        expect(gateOrder).toBeDefined();
        expect(firstExternal).toBeDefined();
        expect(gateOrder).toBeLessThan(firstExternal);
    });
});
