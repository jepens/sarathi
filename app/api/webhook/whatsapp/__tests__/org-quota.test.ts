import { describe, it, expect, vi, beforeEach } from 'vitest';

// The org's inbound quota in the WhatsApp webhook (tracker 3.4, migration
// 0071): a text message to a chat with the AI on that would open a new AI
// burst is counted against the org's minute window before it is queued; over
// the limit it is not queued (no AI reply) but still stored, with a note for
// the operators once per chat and minute. A chat in manual mode, a message the
// per-contact rate limit already stopped, a fragment that joins a burst still
// waiting in the queue and a redelivery (queued or stored) are not counted.
// Everything around the webhook is stubbed. Fake ids and phones only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';

const h = vi.hoisted(() => ({
    aiEnabled: true as boolean | null,
    insertError: null as unknown,
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    consume: vi.fn(),
    enqueue: vi.fn(),
    queueState: vi.fn(),
    rateOk: vi.fn(),
    logSystem: vi.fn(),
}));

function serviceClient() {
    const builder = (table: string) => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'upsert', 'update']) q[m] = () => q;
        q.insert = (row: Record<string, unknown>) => {
            h.inserts.push({ table, row });
            return Promise.resolve({ data: null, error: table === 'whatsapp_messages' ? h.insertError : null });
        };
        q.maybeSingle = async () => ({
            data: table === 'whatsapp_chats' ? { ai_enabled: h.aiEnabled, contact_name: null } : null,
            error: null,
        });
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
        return q;
    };
    return { from: builder, rpc: async () => ({ data: null, error: null }) };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => serviceClient()) }));
vi.mock('@/lib/whatsapp/security', () => ({ verifyWhatsAppSignature: vi.fn(async () => true) }));
vi.mock('@/lib/whatsapp/credentials', () => ({
    resolveWhatsAppContext: vi.fn(async () => ({
        orgId: ORG,
        phoneNumberId: 'phone-number-id',
        accessToken: 'access-token',
        appSecret: 'app-secret',
    })),
}));
vi.mock('@/lib/whatsapp/client', () => ({ downloadWhatsAppMedia: vi.fn(), sendWhatsAppMessage: vi.fn() }));
vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: vi.fn() }));
vi.mock('@/lib/whatsapp/rate-limiter-db', () => ({ checkRateLimit: h.rateOk }));
vi.mock('@/lib/whatsapp/queue-db', () => ({
    enqueueMessage: h.enqueue,
    inboundQueueState: h.queueState,
    processQueue: vi.fn(async () => {}),
    getDebounceSeconds: () => 0,
}));
vi.mock('@/lib/quota/org-quota', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/quota/org-quota')>()),
    consumeOrgQuota: h.consume,
}));
vi.mock('@/lib/whatsapp/recipient', () => ({ resolveSendTarget: vi.fn() }));
vi.mock('@/lib/whatsapp/history', () => ({ logSystemMessage: h.logSystem }));
vi.mock('@/lib/whatsapp/flow-response', () => ({ handleFlowReply: vi.fn() }));
vi.mock('@/lib/settings/app-settings', () => ({ checkVerifyToken: vi.fn() }));
vi.mock('@/lib/utils/logger', () => ({ whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { POST } from '@/app/api/webhook/whatsapp/route';
import { inboundQuotaNotice } from '@/lib/quota/org-quota';

let seq = 0;

/** A webhook delivery of one inbound text message from `phone`. */
function inboundText(phone: string): { req: Request; wamid: string } {
    seq += 1;
    const wamid = `wamid.fake-text-${seq}`;
    const body = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: {
            metadata: { phone_number_id: 'phone-number-id' },
            contacts: [{ wa_id: phone }],
            messages: [{ from: phone, id: wamid, type: 'text', text: { body: 'halo, masih buka?' } }],
        } }] }],
    };
    return { req: new Request('http://localhost/api/webhook/whatsapp', { method: 'POST', body: JSON.stringify(body) }), wamid };
}

/** POST, check the fast 200, then wait for the stored inbound message. */
async function deliver(req: Request): Promise<Record<string, unknown>> {
    const before = h.inserts.filter((i) => i.table === 'whatsapp_messages').length;
    const res = await POST(req);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(h.inserts.filter((i) => i.table === 'whatsapp_messages').length).toBe(before + 1));
    return h.inserts.filter((i) => i.table === 'whatsapp_messages')[before].row;
}

beforeEach(() => {
    vi.clearAllMocks();
    h.inserts = [];
    h.insertError = null;
    h.aiEnabled = true;
    h.enqueue.mockResolvedValue(null);
    h.rateOk.mockResolvedValue(true);
    h.queueState.mockResolvedValue({ duplicate: false, joinsBurst: false });
    h.consume.mockResolvedValue({ allowed: true, used: 3, refused: 0, limit: 30, firstRefusal: false });
});

describe('webhook text message: the org inbound quota', () => {
    it('a message that opens a new AI burst is counted against the minute window, then queued', async () => {
        const { req, wamid } = inboundText('620000000001');
        await deliver(req);
        expect(h.queueState).toHaveBeenCalledWith(expect.anything(), ORG, '620000000001', wamid);
        expect(h.consume).toHaveBeenCalledWith(expect.anything(), ORG, 'inbound_minute');
        expect(h.enqueue).toHaveBeenCalledWith(ORG, '620000000001', 'halo, masih buka?', expect.anything(), wamid);
        expect(h.logSystem).not.toHaveBeenCalled();
    });

    it("over the quota: not queued (no AI reply), stored, and a note with the org's own limit after the message", async () => {
        h.consume.mockResolvedValue({ allowed: false, used: 12, refused: 1, limit: 12, firstRefusal: true });
        let insertsWhenNoted = -1;
        h.logSystem.mockImplementation(async () => {
            insertsWhenNoted = h.inserts.filter((i) => i.table === 'whatsapp_messages').length;
        });
        const { req, wamid } = inboundText('620000000002');
        const row = await deliver(req);
        expect(h.enqueue).not.toHaveBeenCalled();
        expect(row).toMatchObject({ org_id: ORG, phone_number: '620000000002', role: 'user', wa_message_id: wamid });
        await vi.waitFor(() => expect(h.logSystem).toHaveBeenCalledWith(ORG, '620000000002', inboundQuotaNotice(12)));
        expect(insertsWhenNoted).toBe(1); // the message was stored before the note
    });

    it('no note when the refused message turns out to be a redelivery (insert 23505)', async () => {
        h.consume.mockResolvedValue({ allowed: false, used: 30, refused: 1, limit: 30, firstRefusal: true });
        h.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
        await deliver(inboundText('620000000008').req);
        await new Promise((r) => setTimeout(r, 20));
        expect(h.logSystem).not.toHaveBeenCalled();
    });

    it('the note comes once per chat and minute, not for every refused fragment', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 10_000);
        try {
            h.consume.mockResolvedValue({ allowed: false, used: 30, refused: 2, limit: 30, firstRefusal: false });
            await deliver(inboundText('620000000003').req);
            await deliver(inboundText('620000000003').req);
            await vi.waitFor(() => expect(h.logSystem).toHaveBeenCalledTimes(1));
        } finally {
            now.mockRestore();
        }
    });

    it("a fragment that joins this chat's burst still waiting in the queue is not counted, and is queued", async () => {
        h.queueState.mockResolvedValue({ duplicate: false, joinsBurst: true });
        await deliver(inboundText('620000000004').req);
        expect(h.consume).not.toHaveBeenCalled();
        expect(h.enqueue).toHaveBeenCalledTimes(1);
    });

    it('a redelivery (already queued or stored) is neither counted nor queued again', async () => {
        h.queueState.mockResolvedValue({ duplicate: true, joinsBurst: false });
        await deliver(inboundText('620000000005').req);
        expect(h.consume).not.toHaveBeenCalled();
        expect(h.enqueue).not.toHaveBeenCalled();
    });

    it('a message the per-contact rate limit stopped is not counted and not queued', async () => {
        h.rateOk.mockResolvedValue(false);
        const res = await POST(inboundText('620000000006').req);
        expect(res.status).toBe(200);
        expect(h.queueState).not.toHaveBeenCalled();
        expect(h.consume).not.toHaveBeenCalled();
        expect(h.enqueue).not.toHaveBeenCalled();
    });

    it('a chat in manual mode is not counted', async () => {
        h.aiEnabled = false;
        await deliver(inboundText('620000000007').req);
        expect(h.consume).not.toHaveBeenCalled();
        expect(h.enqueue).not.toHaveBeenCalled();
    });
});
