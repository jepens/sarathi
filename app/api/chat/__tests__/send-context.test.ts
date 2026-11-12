import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/chat/send with a reply context (Fase 2 task 2.2a part 2, PR-C2):
// a real wamid is sent to Meta as the context and stored as reply_to_wamid; a
// syn. key (an inbound message Meta sent without an id) is never Meta's, so it
// is dropped before the send instead of making Meta refuse the whole reply.
// The gate refusals are covered in app/api/__tests__/org-context-gates.test.ts.
// Fake ids and phones only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';

const h = vi.hoisted(() => ({
    writes: [] as Array<{ table: string; op: string; row: Record<string, unknown> }>,
    sendWhatsAppMessage: vi.fn(),
}));

vi.mock('@/lib/settings/org-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/settings/org-context')>();
    const table = (name: string) => ({
        upsert: async (row: Record<string, unknown>) => {
            h.writes.push({ table: name, op: 'upsert', row });
            return { error: null };
        },
        insert: async (row: Record<string, unknown>) => {
            h.writes.push({ table: name, op: 'insert', row });
            return { error: null };
        },
    });
    return {
        accessDeniedResponse: actual.accessDeniedResponse,
        // A default-org member; the cookie-bound client is a stub.
        requireEnvIntegration: vi.fn(async () => ({ ok: true, supabase: { from: table }, userId: 'user-a1', orgId: ORG, role: 'owner' })),
    };
});
vi.mock('@/lib/whatsapp/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/whatsapp/client')>();
    return { ...actual, sendWhatsAppMessage: h.sendWhatsAppMessage };
});
vi.mock('@/lib/utils/logger', () => ({ whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from '@/app/api/chat/send/route';

function sendRequest(body: Record<string, unknown>): Request {
    return { json: async () => body } as unknown as Request;
}

const messageInsert = () => h.writes.find((w) => w.table === 'whatsapp_messages' && w.op === 'insert')?.row;

beforeEach(() => {
    vi.clearAllMocks();
    h.writes = [];
    h.sendWhatsAppMessage.mockResolvedValue({ waMessageId: 'wamid.keluar-1' });
});

describe('POST /api/chat/send: the reply context', () => {
    it("a real wamid goes to Meta as the context and is stored as the reply's reply_to_wamid", async () => {
        const res = await POST(sendRequest({ phone_number: PHONE, message: 'iya', context_message_id: 'wamid.masuk-1' }));
        expect(res.status).toBe(200);
        expect(h.sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, 'iya', undefined, 'wamid.masuk-1');
        expect(messageInsert()).toMatchObject({ org_id: ORG, reply_to_wamid: 'wamid.masuk-1', wa_message_id: 'wamid.keluar-1' });
    });

    it('a syn. key is dropped: the reply is sent and stored without a context', async () => {
        const res = await POST(sendRequest({ phone_number: PHONE, message: 'iya', context_message_id: `syn.${'a'.repeat(64)}` }));
        expect(res.status).toBe(200);
        expect(h.sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, 'iya', undefined, null);
        expect(messageInsert()).toMatchObject({ reply_to_wamid: null });
    });
});
