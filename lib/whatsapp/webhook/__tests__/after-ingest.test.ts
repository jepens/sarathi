import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase } from '@/lib/whatsapp/__tests__/fakeSupabase';

// A text through wa_ingest_inbound and what follows its commit (Fase 2 task
// 2.2a part 2): the AI only for a main-number text younger than 20 hours by
// Meta's time (D23-2; an older one gets a note instead); the queue drained
// for a queued or joined message; one "Mohon tunggu" and one note per rate
// window (D23-1); the minute quota's note and alerts; the push for a new row
// only; nothing at all for a duplicate. Fake ids and phones only.

const h = vi.hoisted(() => ({ reply: {} as Record<string, unknown> }));

vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: vi.fn(async () => {}) }));
vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn(async () => ({ waMessageId: 'wamid.fake-out', raw: {} })) }));
vi.mock('@/lib/whatsapp/recipient', () => ({ resolveSendTarget: vi.fn(async (_c: unknown, _o: string, key: string) => key) }));
vi.mock('@/lib/whatsapp/history', () => ({ logSystemMessage: vi.fn(async () => ({ status: 'stored' })) }));
vi.mock('@/lib/utils/logger', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/utils/logger')>()),
    whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleTextMessage } from '@/lib/whatsapp/webhook/handlers/text';
import {
    RATE_LIMIT_NOTE,
    RATE_LIMIT_WARNING,
    RATE_LIMIT_WARNING_FAILED_NOTE,
    lateMessageNotice,
    resetAfterIngestState,
} from '@/lib/whatsapp/webhook/after-ingest';
import { settleBackground } from '@/lib/whatsapp/webhook/background';
import { MalformedPayloadError } from '@/lib/whatsapp/webhook/errors';
import { inboundQuotaNotice } from '@/lib/quota/org-quota';
import { resetOpsEventThrottle } from '@/lib/ops/events';
import { resetOtherNumberState } from '@/lib/whatsapp/other-number';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { logSystemMessage } from '@/lib/whatsapp/history';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';
const HOUR = 60 * 60 * 1000;

let fake: FakeSupabase;
let drains = 0;
let seq = 0;

function ctx(over: Partial<MessageContext> = {}): MessageContext {
    seq += 1;
    return {
        supabase: fake.client,
        waCtx: { orgId: ORG, phoneNumberId: '100000000000001', accessToken: 'token-palsu', appSecret: 'rahasia-palsu' },
        message: { from: PHONE, id: `wamid.fake-${seq}`, type: 'text', text: { body: 'halo, masih buka?' } },
        type: 'text',
        key: `wamid.fake-${seq}`,
        replyTo: null,
        waTs: null,
        identity: { from: PHONE, bsuid: null, waId: PHONE },
        storeOnly: null,
        signal: new AbortController().signal,
        batch: { requestDrain: () => void (drains += 1) },
        ...over,
    };
}

const ingests = () => fake.rpcCalls.filter((c) => c.name === 'wa_ingest_inbound').map((c) => c.args as Record<string, unknown>);
const opsEvents = () => fake.rpcCalls.filter((c) => c.name === 'record_ops_event').map((c) => c.args as Record<string, unknown>);
const notes = () => vi.mocked(logSystemMessage).mock.calls;

async function text(over: Partial<MessageContext> = {}, reply: Record<string, unknown> = {}) {
    h.reply = reply;
    const result = await handleTextMessage(ctx(over));
    await settleBackground();
    return result;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetAfterIngestState();
    resetOpsEventThrottle();
    resetOtherNumberState();
    drains = 0;
    fake = makeFakeSupabase({
        rpc: (name, args) => {
            if (name !== 'wa_ingest_inbound') return { data: null, error: null };
            const a = args as Record<string, unknown>;
            return {
                data: [{
                    outcome: 'new',
                    contact_key: a.p_from,
                    message_id: '00000000-0000-4000-8000-000000000003',
                    chat_created: false,
                    summary_applied: true,
                    contact_name: null,
                    ai_enabled: true,
                    queue_outcome: a.p_ai_eligible ? 'queued' : null,
                    quota_limit: null,
                    quota_first_refusal: null,
                    quota_error: null,
                    rate_first: null,
                    rate_error: null,
                    bsuid_conflict: false,
                    work_id: null,
                    work_state: null,
                    ...h.reply,
                }],
                error: null,
            };
        },
    });
});

afterEach(async () => {
    await settleBackground();
});

describe('a text on the main number', () => {
    it('is stored, rate-limited and queued for the AI by one call; a queued message drains the queue', async () => {
        expect(await text()).toBe('new');
        expect(ingests()[0]).toMatchObject({
            p_org: ORG,
            p_from: PHONE,
            p_content: 'halo, masih buka?',
            p_preview: 'halo, masih buka?',
            p_verified_phone: PHONE,
            p_metadata: {},
            p_unread: true,
            p_rate_scope: 'main',
            p_rate_max: 10,
            p_ai_eligible: true,
            p_queue_text: 'halo, masih buka?',
            p_inbound_limit: 30,
            p_wa_ts: null,
            p_work_kind: null,
        });
        expect(drains).toBe(1);
        expect(sendPushToOrg).toHaveBeenCalledWith(fake.client, ORG, {
            title: PHONE,
            body: 'halo, masih buka?',
            phone: PHONE,
            url: `/dashboard/chats?phone=${PHONE}`,
        });
        expect(notes()).toEqual([]);
    });

    it('a fragment that joined a waiting burst drains too; manual mode and an earlier queue job do not', async () => {
        await text({}, { queue_outcome: 'joined' });
        expect(drains).toBe(1);
        await text({}, { queue_outcome: 'manual', ai_enabled: false });
        await text({}, { queue_outcome: 'already_queued' });
        expect(drains).toBe(1);
    });

    it("the push is titled with the contact's name when there is one", async () => {
        await text({}, { contact_name: 'Budi Palsu' });
        expect(vi.mocked(sendPushToOrg).mock.calls[0][2]).toMatchObject({ title: 'Budi Palsu' });
    });

    it('every text parameter reaches the database clean: content, preview and the AI queue text', async () => {
        // U+0000 or a lone surrogate would fail the whole call (class 22) and lose the message.
        const body = 'halo\u0000 kak \uD83D';
        await text({ message: { type: 'text', text: { body } }, identity: { from: `${PHONE}\u0000`, bsuid: null, waId: PHONE } });
        expect(ingests()[0]).toMatchObject({
            p_from: PHONE,
            p_content: 'halo kak �',
            p_preview: 'halo kak �',
            p_queue_text: 'halo kak �',
        });
    });

    it('sends Meta time when it is known', async () => {
        const waTs = new Date(Date.now() - 60_000);
        await text({ waTs });
        expect(ingests()[0].p_wa_ts).toBe(waTs.toISOString());
    });

    it('a text without a string body is malformed (stored as a placeholder by the caller)', async () => {
        await expect(handleTextMessage(ctx({ message: { type: 'text', text: {} } }))).rejects.toBeInstanceOf(MalformedPayloadError);
        await expect(handleTextMessage(ctx({ message: { type: 'text' } }))).rejects.toBeInstanceOf(MalformedPayloadError);
        expect(ingests()).toEqual([]);
    });
});

describe('a late text (D23-2)', () => {
    it('20 hours or more after it was sent: stored and pushed without the AI, with a note giving its age', async () => {
        expect(await text({ waTs: new Date(Date.now() - 21 * HOUR) })).toBe('new');
        expect(ingests()[0]).toMatchObject({ p_ai_eligible: false, p_queue_text: null, p_inbound_limit: null, p_unread: true });
        expect(drains).toBe(0);
        expect(sendPushToOrg).toHaveBeenCalledTimes(1);
        expect(notes()).toEqual([[ORG, PHONE, lateMessageNotice(21 * HOUR), { touchChat: false }]]);
        expect(lateMessageNotice(21 * HOUR)).toContain('21 jam');
        expect(lateMessageNotice(21 * HOUR)).not.toContain('template');
    });

    it('past 24 hours the note says a reply needs a template', async () => {
        await text({ waTs: new Date(Date.now() - 30 * HOUR) });
        expect(notes()[0][2]).toContain('30 jam');
        expect(notes()[0][2]).toContain('kirim template');
    });

    it('just under 20 hours: the AI answers as usual', async () => {
        await text({ waTs: new Date(Date.now() - 20 * HOUR + 60_000) });
        expect(ingests()[0]).toMatchObject({ p_ai_eligible: true, p_queue_text: 'halo, masih buka?' });
        expect(notes()).toEqual([]);
    });

    it('one note per chat and hour, and none in a chat in manual mode', async () => {
        await text({ waTs: new Date(Date.now() - 22 * HOUR) });
        await text({ waTs: new Date(Date.now() - 22 * HOUR) });
        expect(notes()).toHaveLength(1);
        await text({ waTs: new Date(Date.now() - 22 * HOUR), identity: { from: '620000000001', bsuid: null, waId: '620000000001' } }, { ai_enabled: false });
        expect(notes()).toHaveLength(1);
    });
});

describe('another number of the WABA (store-only)', () => {
    const other = { ref: 'h0123456789', last4: '1234' };

    it('never goes to the AI, has its own rate bucket and is marked; the operators get a note once a day', async () => {
        await text({ storeOnly: other });
        await text({ storeOnly: other });
        expect(ingests()[0]).toMatchObject({
            p_ai_eligible: false,
            p_queue_text: null,
            p_rate_scope: 'other',
            p_metadata: { other_number: 'h0123456789' },
        });
        expect(drains).toBe(0);
        expect(notes()).toHaveLength(1);
        expect(notes()[0][2]).toContain('nomor berakhiran 1234');
        expect(notes()[0][3]).toEqual({ touchChat: false });
    });

    it('over its own rate limit: no warning (it would come from the main number), one note', async () => {
        await text({ storeOnly: other }, { outcome: 'rate_limited', rate_first: true, message_id: null, queue_outcome: null });
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(notes()).toHaveLength(1);
        expect(notes()[0][2]).toContain('melebihi batas per menit');
    });
});

describe('the rate limit of the main number (D23-1)', () => {
    const limited = { outcome: 'rate_limited', message_id: null, queue_outcome: null };

    it('the first refusal of the window warns the customer once and notes the chat; the others do nothing', async () => {
        expect(await text({}, { ...limited, rate_first: true })).toBe('rate_limited');
        expect(await text({}, { ...limited, rate_first: false })).toBe('rate_limited');
        expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sendWhatsAppMessage).mock.calls[0]).toEqual([
            PHONE,
            RATE_LIMIT_WARNING,
            { phoneNumberId: '100000000000001', accessToken: 'token-palsu' },
        ]);
        expect(notes()).toEqual([[ORG, PHONE, RATE_LIMIT_NOTE, { touchChat: false }]]);
        expect(sendPushToOrg).not.toHaveBeenCalled();
        expect(drains).toBe(0);
    });

    it('a warning that cannot be sent leaves a note saying so; an invalid token (Meta 190) is alerted', async () => {
        vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(Object.assign(new Error('Meta WhatsApp 190'), { code: 190 }));
        await text({}, { ...limited, rate_first: true });
        expect(notes()).toEqual([[ORG, PHONE, RATE_LIMIT_WARNING_FAILED_NOTE, { touchChat: false }]]);
        expect(opsEvents()).toEqual([
            expect.objectContaining({ p_kind: 'whatsapp_token_invalid', p_org: ORG, p_detail: 'saat mengirim peringatan batas pesan per menit' }),
        ]);
    });
});

describe("the org's minute quota", () => {
    it("refused: a note with the org's limit once per chat and minute, and the first refusal alerted", async () => {
        await text({}, { queue_outcome: 'refused', quota_limit: 12, quota_first_refusal: true });
        await text({}, { queue_outcome: 'refused', quota_limit: 12, quota_first_refusal: false });
        expect(drains).toBe(0);
        expect(notes()).toEqual([[ORG, PHONE, inboundQuotaNotice(12), { touchChat: false }]]);
        expect(opsEvents()).toEqual([
            expect.objectContaining({ p_kind: 'quota_inbound_exceeded', p_detail: 'batas 12 percakapan AI baru per menit tercapai' }),
        ]);
        expect(sendPushToOrg).toHaveBeenCalledTimes(2); // stored like any message
    });

    it('a counter that failed lets the message through and is alerted with its SQLSTATE', async () => {
        await text({}, { quota_error: '57014' });
        expect(drains).toBe(1);
        expect(opsEvents()).toEqual([expect.objectContaining({ p_kind: 'quota_check_failed', p_detail: 'inbound_minute: 57014' })]);
    });
});

describe('a duplicate', () => {
    it('does nothing at all: no push, no note, no warning, no drain', async () => {
        expect(await text({}, { outcome: 'duplicate', queue_outcome: null })).toBe('duplicate');
        expect(sendPushToOrg).not.toHaveBeenCalled();
        expect(notes()).toEqual([]);
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(drains).toBe(0);
        expect(opsEvents()).toEqual([]);
    });
});
