import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase } from '@/lib/whatsapp/__tests__/fakeSupabase';

// One message of a delivery and its guard (Fase 2 task 2.2a part 2): the
// prelude (key, Meta time, the sender's own contact), then the handler of its
// type. A message is never dropped silently: a payload that cannot be stored
// as it is, or a database answer specific to it that persists POISON_LIMIT
// times, becomes a placeholder row with an alert; only a message without any
// sender, or one whose placeholder fails permanently too, is skipped (with an
// alert). A retryable failure keeps the item retryable (503); a thrown bug
// never counts (D24). Fake ids and phones only.

const h = vi.hoisted(() => ({
    /** The next wa_ingest_inbound answers: a row's fields, an error, or a throw. */
    replies: [] as Array<Record<string, unknown> | { error: Record<string, unknown> } | { throws: unknown }>,
}));

vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: vi.fn(async () => {}) }));
vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn(), downloadWhatsAppMedia: vi.fn() }));
vi.mock('@/lib/whatsapp/recipient', () => ({ resolveSendTarget: vi.fn() }));
vi.mock('@/lib/whatsapp/history', () => ({ logSystemMessage: vi.fn(async () => ({ status: 'stored' })) }));
vi.mock('@/lib/whatsapp/flow-response', () => ({ handleFlowReply: vi.fn(async () => ({ status: 'handled' })) }));
vi.mock('@/lib/utils/logger', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/utils/logger')>()),
    whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleMessageItem, planMessage } from '@/lib/whatsapp/webhook/handlers/messages';
import { BatchOutcome, poisonCount, resetPoison } from '@/lib/whatsapp/webhook/outcome';
import { POISON_LIMIT } from '@/lib/whatsapp/webhook/limits';
import { settleBackground } from '@/lib/whatsapp/webhook/background';
import { resetOpsEventThrottle } from '@/lib/ops/events';
import { resetOtherNumberState } from '@/lib/whatsapp/other-number';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import type { BatchRun } from '@/lib/whatsapp/webhook/types';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';
const PNID = '100000000000001';

let fake: FakeSupabase;
let outcome: BatchOutcome;
let run: BatchRun;

function row(args: Record<string, unknown>, over: Record<string, unknown>) {
    return {
        outcome: 'new',
        contact_key: args.p_from ?? args.p_bsuid,
        message_id: '00000000-0000-4000-8000-000000000004',
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
        ...over,
    };
}

const ingests = () => fake.rpcCalls.filter((c) => c.name === 'wa_ingest_inbound').map((c) => c.args as Record<string, unknown>);
const alerts = () =>
    fake.rpcCalls
        .filter((c) => c.name === 'record_ops_event')
        .map((c) => c.args as { p_kind: string; p_detail: string })
        .map((a) => `${a.p_kind}: ${a.p_detail}`);

/** One messages[] entry of a main-number change, through the guard. */
async function handle(message: unknown, opts: { contacts?: unknown[]; stored?: string[] } = {}) {
    const value = { metadata: { phone_number_id: PNID }, contacts: opts.contacts ?? [{ wa_id: PHONE }], messages: [message] };
    await handleMessageItem(run, planMessage(message, value, null), new Set(opts.stored ?? []));
    await settleBackground();
}

beforeEach(() => {
    vi.clearAllMocks();
    resetPoison();
    resetOpsEventThrottle();
    resetOtherNumberState();
    h.replies = [];
    fake = makeFakeSupabase({
        rpc: (name, args) => {
            if (name !== 'wa_ingest_inbound') return { data: null, error: null };
            const next = h.replies.shift() ?? {};
            if ('throws' in next) return Promise.reject(next.throws);
            if ('error' in next) return { data: null, error: next.error, status: 500 };
            return { data: [row(args as Record<string, unknown>, next)], error: null };
        },
    });
    outcome = new BatchOutcome();
    run = {
        supabase: fake.client,
        outcome,
        org: async () => ({ orgId: ORG, phoneNumberId: PNID, accessToken: 'token-palsu', appSecret: 'rahasia-palsu' }),
        requestDrain: () => {},
        heldBsuids: new Set<string>(),
    };
});

afterEach(async () => {
    await settleBackground();
});

describe('planMessage (the prelude)', () => {
    it("takes the sender's own contact entry, never the first of several", () => {
        const a = { wa_id: '620000000001', user_id: 'ID.0000000001' };
        const b = { wa_id: '620000000002', user_id: 'ID.0000000002' };
        const value = { metadata: { phone_number_id: PNID }, contacts: [a, b] };
        expect(planMessage({ from: '620000000002', id: 'wamid.b', type: 'text' }, value, null).identity).toEqual({
            from: '620000000002',
            bsuid: 'ID.0000000002',
            waId: '620000000002',
        });
        expect(planMessage({ from: '620000000009', id: 'wamid.c', type: 'text' }, value, null).identity).toEqual({
            from: '620000000009',
            bsuid: null,
            waId: '620000000009',
        });
    });

    it('an id or a reply context is cleaned before it is judged empty: one made only of U+0000 gets a syn. key (no reply context), never an empty key', () => {
        const value = { metadata: { phone_number_id: PNID } };
        const nulOnly = planMessage({ from: PHONE, id: '\u0000\u0000', type: 'text', text: { body: 'halo' }, context: { id: '\u0000' } }, value, null);
        expect(nulOnly.synthetic).toBe(true);
        expect(nulOnly.key).toMatch(/^syn\.[0-9a-f]{64}$/);
        expect(nulOnly.replyTo).toBeNull();
        const withNul = planMessage({ from: PHONE, id: 'wamid.a\u0000b', type: 'text', text: { body: 'halo' }, context: { id: 'wamid.q\u0000' } }, value, null);
        expect([withNul.key, withNul.synthetic, withNul.replyTo]).toEqual(['wamid.ab', false, 'wamid.q']);
    });

    it('a message without an id gets a stable synthetic key; reply context and Meta time are read', () => {
        const ts = Math.floor(Date.now() / 1000) - 30;
        const message = { from: PHONE, type: 'text', timestamp: String(ts), text: { body: 'halo' }, context: { id: 'wamid.quoted' } };
        const plan = planMessage(message, { metadata: { phone_number_id: PNID } }, null);
        expect(plan.synthetic).toBe(true);
        expect(plan.key).toMatch(/^syn\.[0-9a-f]{64}$/);
        expect(planMessage({ ...message }, { metadata: { phone_number_id: PNID } }, null).key).toBe(plan.key);
        expect(plan.replyTo).toBe('wamid.quoted');
        expect(plan.waTs?.getTime()).toBe(ts * 1000);
    });
});

describe('handleMessageItem', () => {
    it('stores a text and counts it', async () => {
        await handle({ from: PHONE, id: 'wamid.ok', type: 'text', text: { body: 'halo' } });
        expect(ingests()).toHaveLength(1);
        expect(outcome.counts.new).toBe(1);
        expect(alerts()).toEqual([]);
    });

    it('a message the pre-dedup found stored is a duplicate with no side effect', async () => {
        await handle({ from: PHONE, id: 'wamid.dup', type: 'text', text: { body: 'halo' } }, { stored: ['wamid.dup'] });
        expect(ingests()).toEqual([]);
        expect(sendPushToOrg).not.toHaveBeenCalled();
        expect(outcome.counts.duplicate).toBe(1);
    });

    it('a reaction is only acknowledged', async () => {
        await handle({ from: PHONE, id: 'wamid.r', type: 'reaction', reaction: { emoji: '👍' } });
        expect(ingests()).toEqual([]);
        expect(outcome.counts.acked).toBe(1);
    });

    it('a malformed payload is stored as a placeholder, unread and pushed, with an alert', async () => {
        await handle({ from: PHONE, id: 'wamid.no-body', type: 'text', text: {} });
        expect(ingests()).toEqual([
            expect.objectContaining({
                p_wamid: 'wamid.no-body',
                p_content: 'Pesan jenis "text" tidak bisa diproses otomatis (isinya tidak ditampilkan di Sarathi)',
                p_metadata: { unprocessable: 'text' },
                p_unread: true,
                p_rate_scope: null,
                p_ai_eligible: false,
            }),
        ]);
        expect(sendPushToOrg).toHaveBeenCalledTimes(1);
        expect(alerts()).toEqual(['webhook_payload_invalid: pesan "text": teks tanpa isi; disimpan sebagai pengganti']);
        expect(outcome.counts.degraded).toBe(1);
        expect(outcome.firstError()).toBeNull(); // 200
    });

    it('media without an id is a placeholder too', async () => {
        await handle({ from: PHONE, id: 'wamid.no-media', type: 'image', image: {} });
        expect(ingests()[0]).toMatchObject({ p_metadata: { unprocessable: 'image' } });
        expect(outcome.counts.degraded).toBe(1);
    });

    it('a permanent database error (class 22) also falls back to a placeholder', async () => {
        h.replies.push({ error: { code: '22P05' } });
        await handle({ from: PHONE, id: 'wamid.22', type: 'text', text: { body: 'halo' } });
        expect(ingests()).toHaveLength(2);
        expect(ingests()[1].p_metadata).toEqual({ unprocessable: 'text' });
        expect(alerts()).toEqual(['webhook_payload_invalid: pesan "text": database 22P05; disimpan sebagai pengganti']);
    });

    it(`a database answer specific to the message stays retryable ${POISON_LIMIT - 1} times; the ${POISON_LIMIT}th time a placeholder is stored`, async () => {
        const message = { from: PHONE, id: 'wamid.flaky', type: 'text', text: { body: 'halo' } };
        // Each attempt is a new delivery of the batch (Meta resending after a 503).
        const redeliver = async () => {
            outcome = new BatchOutcome();
            run.outcome = outcome;
            h.replies.push({ error: { code: 'P0002' } });
            await handle(message);
        };
        for (let i = 1; i < POISON_LIMIT; i++) {
            await redeliver();
            expect(outcome.counts.retryable).toBe(1);
            expect(poisonCount('wamid.flaky')).toBe(i);
        }
        expect(alerts()).toEqual([]);
        await redeliver();
        expect(ingests().at(-1)!.p_metadata).toEqual({ unprocessable: 'text' });
        expect(outcome.counts.degraded).toBe(1);
        expect(alerts()).toEqual(['webhook_payload_invalid: pesan "text": database P0002; disimpan sebagai pengganti']);
        expect(poisonCount('wamid.flaky')).toBe(0);
    });

    it('a thrown bug stays retryable however often it happens, and is never counted (D24)', async () => {
        const message = { from: PHONE, id: 'wamid.bug', type: 'text', text: { body: 'halo' } };
        for (let i = 0; i < POISON_LIMIT + 2; i++) {
            outcome = new BatchOutcome();
            run.outcome = outcome;
            h.replies.push({ throws: new Error('boom') });
            await handle(message);
            expect(outcome.counts.retryable).toBe(1);
        }
        expect(poisonCount('wamid.bug')).toBe(0);
        expect(ingests().every((a) => (a.p_metadata as Record<string, unknown>).unprocessable === undefined)).toBe(true);
        expect(alerts()).toEqual([]);
    });

    it('a placeholder that fails retryably keeps the item retryable (503)', async () => {
        h.replies.push({ error: { code: '22P05' } }, { error: { code: '40001' } });
        await handle({ from: PHONE, id: 'wamid.x', type: 'text', text: { body: 'halo' } });
        expect(outcome.counts.retryable).toBe(1);
        expect(outcome.counts.degraded).toBe(0);
        expect(alerts()).toEqual([]);
    });

    it('a placeholder that fails permanently too is skipped, with an alert', async () => {
        h.replies.push({ error: { code: '22P05' } }, { error: { code: '23514' } });
        await handle({ from: PHONE, id: 'wamid.y', type: 'text', text: { body: 'halo' } });
        expect(outcome.counts.skipped).toBe(1);
        expect(outcome.firstError()).toBeNull();
        expect(alerts()).toEqual(['webhook_payload_invalid: pesan "text": database 22P05; dilewati']);
    });

    it('without a phone or a BSUID nothing can key the chat: skipped with an alert, no placeholder', async () => {
        await handle({ id: 'wamid.anon', type: 'text', text: { body: 'halo' } }, { contacts: [] });
        expect(ingests()).toEqual([]);
        expect(outcome.counts.skipped).toBe(1);
        expect(alerts()).toEqual(['webhook_payload_invalid: pesan "text" tanpa identitas pengirim; dilewati']);
    });

    it('an entry that is not an object is skipped with an alert, even with a single contact', async () => {
        await handle(42, { contacts: [{ wa_id: PHONE, user_id: 'ID.0000000005' }] });
        expect(ingests()).toEqual([]);
        expect(outcome.counts.skipped).toBe(1);
        expect(alerts()).toEqual(['webhook_payload_invalid: entri pesan tanpa isi terbaca; dilewati']);
    });

    it('an org that cannot be read makes the item retryable without counting it as the message\'s failure', async () => {
        run.org = async () => {
            throw Object.assign(new Error('platform setting default_org_id could not be read (57014)'), { name: 'PlatformSettingReadError', code: '57014' });
        };
        await handle({ from: PHONE, id: 'wamid.org', type: 'text', text: { body: 'halo' } });
        expect(outcome.counts.retryable).toBe(1);
        expect(poisonCount('wamid.org')).toBe(0);
        expect(ingests()).toEqual([]);
    });

    it('once the budget is used up the item is deferred without being tried', async () => {
        outcome = new BatchOutcome(Date.now() - 60_000);
        run.outcome = outcome;
        await handle({ from: PHONE, id: 'wamid.late', type: 'text', text: { body: 'halo' } });
        expect(ingests()).toEqual([]);
        expect(outcome.counts.deferred).toBe(1);
    });

    it('a call cut off by the budget is deferred, not counted as a failure', async () => {
        h.replies.push({ throws: new Error('AbortError') });
        outcome = new BatchOutcome();
        run.outcome = outcome;
        vi.spyOn(outcome, 'signal').mockReturnValue(AbortSignal.abort());
        await handle({ from: PHONE, id: 'wamid.cut', type: 'text', text: { body: 'halo' } });
        expect(outcome.counts.deferred).toBe(1);
        expect(outcome.counts.retryable).toBe(0);
        expect(poisonCount('wamid.cut')).toBe(0);
    });
});
