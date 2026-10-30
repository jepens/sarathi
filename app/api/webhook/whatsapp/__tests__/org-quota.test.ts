import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The org's inbound quota in the WhatsApp webhook (tracker 3.4, migration
// 0071): a text message to a chat with the AI on that would open a new AI
// burst is counted against the org's minute window before it is queued; over
// the limit it is not queued (no AI reply) but still stored, with a note for
// the operators once per chat and minute. A chat in manual mode, a message the
// per-contact rate limit already stopped, a fragment that joins a burst still
// waiting in the queue and a redelivery (queued or stored) are not counted.
// Since 2.2a part 2 the count, the decision and the queue job are made inside
// wa_ingest_inbound (migration 0072), in the transaction that stores the
// message (pgTAP 220 pins them); here the webhook asks for them and acts on
// the outcome: the drain, the note, the alerts, the rate-limit warning.
// Everything around the webhook is stubbed. Fake ids and phones only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';

const h = vi.hoisted(() => ({
    /** Fields over the 'new' row wa_ingest_inbound answers with. */
    reply: {} as Record<string, unknown>,
    rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    consume: vi.fn(),
    logSystem: vi.fn(),
}));

/** wa_ingest_inbound's result row: 'new', queued when AI-eligible, unless h.reply says otherwise. */
function ingestRow(args: Record<string, unknown>) {
    return {
        outcome: 'new',
        contact_key: args.p_from,
        message_id: '00000000-0000-4000-8000-000000000002',
        chat_created: false,
        summary_applied: true,
        contact_name: null,
        ai_enabled: true,
        queue_outcome: args.p_ai_eligible ? 'queued' : null,
        quota_limit: null,
        quota_first_refusal: null,
        quota_error: null,
        rate_first: null,
        rate_error: null,
        bsuid_conflict: false,
        work_id: null,
        work_state: null,
        ...h.reply,
    };
}

function serviceClient() {
    const builder = () => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'in', 'upsert', 'update', 'abortSignal']) q[m] = () => q;
        q.maybeSingle = async () => ({ data: null, error: null });
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
        return q;
    };
    return {
        from: builder,
        rpc: (fn: string, args: Record<string, unknown>) => {
            h.rpcs.push({ fn, args });
            const call = Promise.resolve(fn === 'wa_ingest_inbound' ? { data: [ingestRow(args)], error: null } : { data: null, error: null });
            return Object.assign(call, { abortSignal: () => call });
        },
    };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => serviceClient()) }));
vi.mock('@/lib/whatsapp/security', () => ({ verifyWhatsAppSignature: vi.fn(async () => true) }));
vi.mock('@/lib/whatsapp/credentials', () => ({
    envWebhookApp: () => ({ appSecret: 'app-secret', phoneNumberId: 'phone-number-id' }),
    resolveWhatsAppContext: vi.fn(async () => ({
        orgId: ORG,
        phoneNumberId: 'phone-number-id',
        accessToken: 'access-token',
        appSecret: 'app-secret',
    })),
}));
vi.mock('@/lib/whatsapp/client', () => ({ downloadWhatsAppMedia: vi.fn(), sendWhatsAppMessage: vi.fn() }));
vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: vi.fn() }));
vi.mock('@/lib/whatsapp/queue-db', () => ({
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
vi.mock('@/lib/utils/logger', async (importOriginal) => ({
    // Keep redactPII (the ops event writer uses it).
    ...(await importOriginal<typeof import('@/lib/utils/logger')>()),
    whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from '@/app/api/webhook/whatsapp/route';
import { inboundQuotaNotice, QUOTA_DEFAULTS } from '@/lib/quota/org-quota';
import { processQueue } from '@/lib/whatsapp/queue-db';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { resetOpsEventThrottle } from '@/lib/ops/events';
import { settleBackground } from '@/lib/whatsapp/webhook/background';
import { resetPoison } from '@/lib/whatsapp/webhook/outcome';

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

const ingests = () => h.rpcs.filter((c) => c.fn === 'wa_ingest_inbound').map((c) => c.args);
const opsEvents = () => h.rpcs.filter((c) => c.fn === 'record_ops_event').map((c) => c.args);

/** POST, check the fast 200, let the effects after the commit finish; the ingest call's parameters. */
async function deliver(req: Request): Promise<Record<string, unknown>> {
    const before = ingests().length;
    const res = await POST(req);
    expect(res.status).toBe(200);
    await settleBackground();
    expect(ingests()).toHaveLength(before + 1);
    return ingests()[before];
}

beforeEach(() => {
    vi.clearAllMocks();
    resetOpsEventThrottle();
    resetPoison();
    // The webhook only works with the service-role client.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
    h.reply = {};
    h.rpcs = [];
    h.logSystem.mockResolvedValue({ status: 'stored' });
    h.consume.mockResolvedValue({ allowed: true, used: 3, refused: 0, limit: 30, firstRefusal: false });
});

afterEach(async () => {
    await settleBackground();
    vi.unstubAllEnvs();
});

describe('webhook text message: the org inbound quota', () => {
    it('a message that opens a new AI burst is counted against the minute window, then queued', async () => {
        const { req, wamid } = inboundText('620000000001');
        const args = await deliver(req);
        // Counted and queued by wa_ingest_inbound with the org's default limit
        // (an org override applies inside consume_org_quota).
        expect(args).toMatchObject({
            p_org: ORG,
            p_from: '620000000001',
            p_wamid: wamid,
            p_ai_eligible: true,
            p_queue_text: 'halo, masih buka?',
            p_inbound_limit: QUOTA_DEFAULTS.inbound_minute,
        });
        expect(h.consume).not.toHaveBeenCalled(); // never counted a second time in TS
        expect(processQueue).toHaveBeenCalledTimes(1); // queued: the queue is drained
        expect(h.logSystem).not.toHaveBeenCalled();
    });

    it("over the quota: not queued (no AI reply), stored, and a note with the org's own limit after the message", async () => {
        h.reply = { queue_outcome: 'refused', quota_limit: 12, quota_first_refusal: true };
        let storedWhenNoted = -1;
        h.logSystem.mockImplementation(async () => {
            storedWhenNoted = ingests().length;
            return { status: 'stored' };
        });
        const { req, wamid } = inboundText('620000000002');
        const args = await deliver(req);
        expect(args).toMatchObject({ p_org: ORG, p_from: '620000000002', p_wamid: wamid, p_ai_eligible: true });
        expect(processQueue).not.toHaveBeenCalled();
        // touchChat: false: the chat stays "Belum dibalas" for the operators.
        expect(h.logSystem).toHaveBeenCalledWith(ORG, '620000000002', inboundQuotaNotice(12), { touchChat: false });
        expect(storedWhenNoted).toBe(1); // the message was stored before the note
        // The first refusal is alerted, with the org's own limit.
        expect(opsEvents()).toContainEqual(
            expect.objectContaining({ p_kind: 'quota_inbound_exceeded', p_org: ORG, p_detail: 'batas 12 percakapan AI baru per menit tercapai' }),
        );
    });

    it('no note when the refused message turns out to be a redelivery (a duplicate)', async () => {
        // The redelivery gate comes before the quota in the function: a
        // duplicate is neither counted nor refused, and nothing follows.
        h.reply = { outcome: 'duplicate', queue_outcome: null };
        await deliver(inboundText('620000000008').req);
        expect(h.logSystem).not.toHaveBeenCalled();
        expect(opsEvents()).toEqual([]);
    });

    it('the note comes once per chat and minute, not for every refused fragment', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 10_000);
        try {
            h.reply = { queue_outcome: 'refused', quota_limit: 30, quota_first_refusal: false };
            await deliver(inboundText('620000000003').req);
            await deliver(inboundText('620000000003').req);
            expect(h.logSystem).toHaveBeenCalledTimes(1);
        } finally {
            now.mockRestore();
        }
    });

    it("a fragment that joins this chat's burst still waiting in the queue is not counted, and is queued", async () => {
        // 'joined': queued without a quota unit (the function checks the
        // waiting burst before it counts).
        h.reply = { queue_outcome: 'joined' };
        await deliver(inboundText('620000000004').req);
        expect(h.consume).not.toHaveBeenCalled();
        expect(processQueue).toHaveBeenCalledTimes(1); // drained like any queued message
        expect(opsEvents()).toEqual([]);
    });

    it('a redelivery (already queued or stored) is neither counted nor queued again', async () => {
        for (const reply of [{ queue_outcome: 'already_queued' }, { outcome: 'duplicate', queue_outcome: null }]) {
            h.reply = reply;
            await deliver(inboundText('620000000005').req);
        }
        expect(h.consume).not.toHaveBeenCalled();
        expect(processQueue).not.toHaveBeenCalled();
        expect(h.logSystem).not.toHaveBeenCalled();
    });

    it('a message the per-contact rate limit stopped is not counted and not queued', async () => {
        // Refused by the function's rate limit before the quota: nothing
        // stored, counted or queued. Only the first refusal of the window
        // warns the customer and notes the chat (D23-1).
        h.reply = { outcome: 'rate_limited', rate_first: true, message_id: null, queue_outcome: null };
        const args = await deliver(inboundText('620000000006').req);
        expect(args).toMatchObject({ p_rate_scope: 'main', p_rate_max: 10 });
        h.reply = { outcome: 'rate_limited', rate_first: false, message_id: null, queue_outcome: null };
        await deliver(inboundText('620000000006').req);
        expect(h.consume).not.toHaveBeenCalled();
        expect(processQueue).not.toHaveBeenCalled();
        expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toBe('Mohon tunggu sebentar sebelum mengirim pesan lagi.');
        // The note keeps the chat "Belum dibalas" (the dropped message got no answer).
        expect(h.logSystem).toHaveBeenCalledTimes(1);
        expect(h.logSystem).toHaveBeenCalledWith(expect.anything(), '620000000006', 'Rate limit exceeded. User warned.', { touchChat: false });
    });

    it('a shared contact card is noted without marking the chat answered', async () => {
        const body = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: {
                metadata: { phone_number_id: 'phone-number-id' },
                contacts: [{ wa_id: '620000000007' }],
                messages: [{ from: '620000000007', id: 'wamid.fake-card-1', type: 'contacts',
                    contacts: [{ name: { formatted_name: 'Pelanggan Palsu' }, phones: [{ wa_id: '620000000007' }] }] }],
            } }] }],
        };
        const res = await POST(new Request('http://localhost/api/webhook/whatsapp', { method: 'POST', body: JSON.stringify(body) }));
        expect(res.status).toBe(200);
        // Keyed by the card's wamid: a resend writes no second note (D23-3).
        expect(h.logSystem).toHaveBeenCalledWith(expect.anything(), '620000000007', expect.stringContaining('Customer shared contact info'), {
            touchChat: false,
            waMessageId: 'wamid.fake-card-1',
        });
        expect(ingests()).toEqual([]); // a note, not an inbox message, and no AI
    });

    it('a chat in manual mode is not counted', async () => {
        h.reply = { queue_outcome: 'manual', ai_enabled: false };
        await deliver(inboundText('620000000007').req);
        expect(h.consume).not.toHaveBeenCalled();
        expect(processQueue).not.toHaveBeenCalled();
    });
});
