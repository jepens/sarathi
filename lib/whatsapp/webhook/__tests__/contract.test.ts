import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    ORG,
    OTHER_ORG,
    OTHER_PNID,
    PNID,
    SECRET,
    WaModel,
    change,
    contactOf,
    delivery,
    macrotask,
    metaTs,
    signedPost,
    textMsg,
} from '@/lib/whatsapp/webhook/__tests__/wa-model';

// The contract harness of the webhook (Fase 2 task 2.2a part 2, C2_SPEC
// section 9; synthesis section 8 items 10-20 and owner decisions D23-1..4).
// It runs the real route, pipeline, router, handlers, after-ingest, outcome,
// history notes and processQueue against a small stateful model of the
// database (wa-model.ts): wa_ingest_inbound answers 'new' the first time and
// 'duplicate' after, with the spec's rate, AI and quota decisions; failures
// are injected per call; claim_queue_jobs hands out the queued jobs. Every
// model call settles after a macrotask, so what must be committed before the
// answer is checked right when POST returns (C1 verification MUT-1/MUT-2).
// Only Meta (send, download), the AI, Web Push and the default org are
// stubbed. Timers and Date are faked (setImmediate is not), so the delayed
// queue drain and the status re-apply run only when a test moves the clock.
// Fake ids, phones and texts only.

const h = vi.hoisted(() => ({
    db: null as unknown as WaModel,
    logs: [] as unknown[][],
    orgReads: 0,
    orgError: null as unknown,
    outSeq: 0,
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => h.db.client) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/settings/org-context', () => ({
    getDefaultOrgIdStrict: vi.fn(async () => {
        h.orgReads += 1;
        if (h.orgError) throw h.orgError;
        return 'aaaaaaaa-0000-4000-8000-00000000000a';
    }),
}));
vi.mock('@/lib/settings/app-settings', () => ({ checkVerifyToken: vi.fn(), getWhatsAppAppSecret: vi.fn() }));
vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn(), downloadWhatsAppMedia: vi.fn() }));
vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: vi.fn() }));
vi.mock('@/lib/ai/rag', () => ({ generateRAGResponse: vi.fn() }));
vi.mock('@/lib/whatsapp/flow-response', () => ({ handleFlowReply: vi.fn(async () => ({ status: 'handled' })) }));
vi.mock('@/lib/utils/logger', async (importOriginal) => {
    const record = (...args: unknown[]) => void h.logs.push(args);
    return {
        ...(await importOriginal<typeof import('@/lib/utils/logger')>()),
        whatsappLogger: { info: record, warn: record, error: record, debug: record },
    };
});

import { POST } from '@/app/api/webhook/whatsapp/route';
import { sendWhatsAppMessage, downloadWhatsAppMedia } from '@/lib/whatsapp/client';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { generateRAGResponse } from '@/lib/ai/rag';
import { handleFlowReply } from '@/lib/whatsapp/flow-response';
import { settleBackground } from '@/lib/whatsapp/webhook/background';
import { poisonCount, resetPoison } from '@/lib/whatsapp/webhook/outcome';
import { POISON_LIMIT } from '@/lib/whatsapp/webhook/limits';
import {
    RATE_LIMIT_NOTE,
    RATE_LIMIT_WARNING,
    RATE_LIMIT_WARNING_FAILED_NOTE,
    lateMessageNotice,
    resetAfterIngestState,
} from '@/lib/whatsapp/webhook/after-ingest';
import { resetOpsEventThrottle } from '@/lib/ops/events';
import { resetOtherNumberState } from '@/lib/whatsapp/other-number';
import { getDefaultOrgIdStrict } from '@/lib/settings/org-context';

const A = '620000000001';
const B = '620000000002';
const C = '620000000003';
const D = '620000000004';
const HOUR = 60 * 60 * 1000;
const AI_REPLY = 'Balasan AI palsu';
const PLACEHOLDER = 'Pesan jenis "text" tidak bisa diproses otomatis (isinya tidak ditampilkan di Sarathi)';

// Each test starts on its own fake day: the minute throttle of the quota note
// (lib/quota/org-quota.ts) has no reset and must not carry over.
let day = 0;

async function deliver(body: unknown): Promise<number> {
    return (await POST(signedPost(body))).status;
}

/** Waits for the work after the answer: pushes, notes, the warning, the queue drain. */
const settle = () => settleBackground();
const sends = () => vi.mocked(sendWhatsAppMessage).mock.calls;
// Every send is (credentials, to, text): the credentials of the number the
// customer wrote to (the env number of the default org, Fase 2 task 2.2b).
const replies = () => sends().filter((c) => c[2] === AI_REPLY);
const warnings = () => sends().filter((c) => c[2] === RATE_LIMIT_WARNING);
const SENT_FROM = () => expect.objectContaining({ orgId: ORG, phoneNumberId: PNID, accessToken: 'token-palsu' });
const pushes = () => vi.mocked(sendPushToOrg).mock.calls.map((c) => c[2]);
const details = (kind: string) => h.db.events(kind).map((e) => e.detail);
const noteTexts = () => h.db.notes().map((n) => n.content);
const batchLines = () => h.logs.map((l) => String(l[0])).filter((l) => l.startsWith('Webhook batch:'));

/** What the real handleFlowReply can read: response_json holding a JSON object. */
function readableAnswers(raw: unknown): boolean {
    if (typeof raw !== 'string' || raw === '') return false;
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
        return false;
    }
}

/**
 * POST's status, or 'blocked' when it has not answered after a few hundred
 * macrotasks (a whole delivery here takes a few dozen): an effect that must
 * run after the answer would otherwise hold it until the test times out.
 */
async function answerWithin(body: unknown): Promise<number | 'blocked'> {
    const box: { status: number | null } = { status: null };
    void POST(signedPost(body)).then((res) => {
        box.status = res.status;
    });
    for (let i = 0; i < 500 && box.status === null; i++) await macrotask();
    return box.status ?? 'blocked';
}

/** A promise the test resolves itself: a background effect that hangs until then. */
function gate(): { wait: Promise<void>; open: () => void } {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { wait, open };
}

beforeEach(() => {
    day += 1;
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        now: Date.UTC(2026, 9, 1, 3, 0, 0) + day * 24 * HOUR,
    });
    h.db = new WaModel();
    h.logs = [];
    h.orgReads = 0;
    h.orgError = null;
    h.outSeq = 0;
    resetOpsEventThrottle();
    resetOtherNumberState();
    resetPoison();
    resetAfterIngestState();
    vi.mocked(sendWhatsAppMessage).mockReset().mockImplementation(async () => ({ waMessageId: `wamid.keluar-${++h.outSeq}`, raw: {} }));
    vi.mocked(downloadWhatsAppMedia).mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', size: 3 });
    vi.mocked(sendPushToOrg).mockReset().mockResolvedValue(undefined);
    vi.mocked(generateRAGResponse).mockReset().mockResolvedValue({ message: AI_REPLY, sources: [] });
    vi.mocked(handleFlowReply).mockReset().mockImplementation(async (p) => {
        // Like the real one: answers that cannot be read are reported before
        // any write, and its own insert of the submission is its gate.
        if (!readableAnswers(p.nfmReply.response_json)) return { status: 'unreadable' };
        const { error, status } = await p.supabase.from('whatsapp_messages').insert({
            org_id: p.orgId,
            phone_number: p.contactKey,
            role: 'user',
            content: '📋 Brief Acara (via form WhatsApp)',
            wa_message_id: p.inboundWamid,
        });
        if (error) return error.code === '23505' ? { status: 'duplicate' } : { status: 'gate_failed', error, httpStatus: status };
        return { status: 'handled' };
    });
    vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', PNID);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token-palsu');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
    vi.stubEnv('WHATSAPP_DEBOUNCE_SECONDS', '0');
    vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', '');
});

afterEach(async () => {
    await settleBackground();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('contract harness (synthesis section 8, items 10-20)', () => {
    it('10. a 40001 on the ingest answers 503 with one webhook_error; the same bytes again are stored, pushed, drained and answered once', async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.c10', 'halo, masih buka?')] })]);
        h.db.fail({ target: 'rpc:wa_ingest_inbound', error: { code: '40001' } });

        expect(await deliver(body)).toBe(503);
        expect(h.db.events()).toEqual([{ kind: 'webhook_error', org: ORG, detail: 'database 40001 — bentrok transaksi, aman bila jarang (1 dari 1 item)', count: 1 }]);
        await settle();
        // The call rolled back as a whole: no chat, no row, no job, nothing after it.
        expect(h.db.chats).toEqual([]);
        expect(h.db.userRows()).toEqual([]);
        expect(h.db.queue).toEqual([]);
        expect(pushes()).toEqual([]);

        // Meta resends the same signed bytes.
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.c10']);
        expect(pushes()).toEqual([{ title: A, body: 'halo, masih buka?', phone: A, url: `/dashboard/chats?phone=${A}` }]);
        expect(h.db.rpcCalls('claim_queue_jobs')).toHaveLength(1); // the drain right after the batch
        expect(replies()).toEqual([[SENT_FROM(), A, AI_REPLY]]);
        expect(h.db.queue.map((j) => j.status)).toEqual(['completed']);
        expect(h.db.events()).toHaveLength(1); // still only the first delivery's alert

        // The delayed drain (debounce + 5 s) finds nothing left to answer.
        await vi.advanceTimersByTimeAsync(5_000);
        await settle();
        expect(h.db.rpcCalls('claim_queue_jobs')).toHaveLength(2);
        expect(replies()).toHaveLength(1);
        expect(h.db.messages.filter((m) => m.role === 'assistant').map((m) => m.wa_message_id)).toEqual(['wamid.keluar-1']);
    });

    it('11. 2 entries x 2 changes x 2 messages: Meta-time order across the batch, one status call per change, a dropped change in the middle, one org read, one drain, the user_id_update first', async () => {
        // D is a returning customer whose BSUID changes in this batch (the
        // last change); its messages carry only the new BSUID (phone hidden).
        h.db.seedChat({ phone_number: D, bsuid: 'ID.lama-d' });
        h.db.seedAssistant('wamid.keluar-a', A, 'sent');
        h.db.seedAssistant('wamid.keluar-b', B, 'delivered');
        const hidden = (id: string, ago: number) => ({ from_user_id: 'ID.baru-d', id, timestamp: metaTs(ago), type: 'text', text: { body: `pesan ${id}` } });
        const t = (from: string, id: string, ago: number) => textMsg(from, id, `pesan ${id}`, { timestamp: metaTs(ago) });
        const body = delivery(
            [
                change({
                    contacts: [contactOf(A), contactOf(B)],
                    messages: [t(A, 'wamid.a1', 50_000), t(B, 'wamid.b1', 70_000)],
                    statuses: [{ id: 'wamid.keluar-a', status: 'delivered', timestamp: metaTs(1_000), recipient_id: A }],
                }),
                change({ contacts: [contactOf(B)], messages: [t(B, 'wamid.drop', 90_000)] }, OTHER_PNID),
                change({ contacts: [contactOf(C), { user_id: 'ID.baru-d' }], messages: [t(C, 'wamid.c1', 30_000), hidden('wamid.d1', 80_000)] }),
            ],
            [
                change({
                    contacts: [contactOf(A), contactOf(B)],
                    messages: [t(A, 'wamid.a2', 20_000), t(B, 'wamid.b2', 60_000)],
                    statuses: [{ id: 'wamid.keluar-b', status: 'read', timestamp: metaTs(1_000), recipient_id: B }],
                }),
                change({ contacts: [contactOf(C), { user_id: 'ID.baru-d' }], messages: [t(C, 'wamid.c2', 10_000), hidden('wamid.d2', 40_000)] }),
                { field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.lama-d', current: 'ID.baru-d' }, timestamp: metaTs(5_000) }] } },
            ],
        );

        expect(await deliver(body)).toBe(200);
        // Every message of the routed changes, oldest first by Meta's time.
        expect(h.db.ingests().map((a) => a.p_wamid)).toEqual([
            'wamid.d1',
            'wamid.b1',
            'wamid.b2',
            'wamid.a1',
            'wamid.d2',
            'wamid.c1',
            'wamid.a2',
            'wamid.c2',
        ]);
        // The BSUID moved before any message was stored, so D's messages found D's chat.
        expect(h.db.commits.indexOf('whatsapp_chats.update:1')).toBeLessThan(h.db.commits.findIndex((c) => c.startsWith('ingest:')));
        expect(h.db.userRows().filter((m) => m.wa_message_id?.startsWith('wamid.d')).map((m) => m.phone_number)).toEqual([D, D]);
        expect(h.db.chats.map((c) => c.phone_number).sort()).toEqual([A, B, C, D]);
        // The dropped change stored nothing and did not stop the rest.
        expect(h.db.userRows().some((m) => m.wa_message_id === 'wamid.drop')).toBe(false);
        expect(h.db.events('webhook_unrouted')).toHaveLength(1);
        // One statuses call per change that has statuses, both applied.
        expect(h.db.rpcCalls('wa_apply_statuses').map((a) => (a.p_statuses as Array<{ id: string }>).map((s) => s.id))).toEqual([
            ['wamid.keluar-a'],
            ['wamid.keluar-b'],
        ]);
        expect(['wamid.keluar-a', 'wamid.keluar-b'].map((id) => h.db.messages.find((m) => m.wa_message_id === id)?.status)).toEqual(['delivered', 'read']);
        expect(h.orgReads).toBe(1);
        await settle();
        expect(h.db.rpcCalls('claim_queue_jobs')).toHaveLength(1);
        expect(replies()).toHaveLength(4); // one per conversation
    });

    it("12. each message takes its own contact: [A, B] with messages from B then A; contacts that do not match lend nothing; a single contact is used", async () => {
        const body = delivery([
            change({
                contacts: [contactOf(A, 'ID.a'), contactOf(B, 'ID.b')],
                messages: [textMsg(B, 'wamid.dari-b', 'dari B'), textMsg(A, 'wamid.dari-a', 'dari A')],
            }),
            change({ contacts: [contactOf(A, 'ID.a'), contactOf(B, 'ID.b')], messages: [textMsg(C, 'wamid.dari-c', 'dari C')] }),
            change({ contacts: [contactOf(D, 'ID.d')], messages: [textMsg(D, 'wamid.dari-d', 'dari D')] }),
        ]);
        expect(await deliver(body)).toBe(200);
        const byWamid = Object.fromEntries(h.db.ingests().map((a) => [a.p_wamid, [a.p_from, a.p_bsuid, a.p_verified_phone]]));
        expect(byWamid).toEqual({
            'wamid.dari-b': [B, 'ID.b', B],
            'wamid.dari-a': [A, 'ID.a', A],
            'wamid.dari-c': [C, null, C],
            'wamid.dari-d': [D, 'ID.d', D],
        });
        // No customer's message or BSUID ended up in another customer's chat.
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.phone_number])).toEqual([
            ['wamid.dari-b', B],
            ['wamid.dari-a', A],
            ['wamid.dari-c', C],
            ['wamid.dari-d', D],
        ]);
        expect(Object.fromEntries(h.db.chats.map((c) => [c.phone_number, c.bsuid]))).toEqual({ [A]: 'ID.a', [B]: 'ID.b', [C]: null, [D]: 'ID.d' });
    });

    it('13a. message 2 of 3 fails: 503 after 1 and 3 are stored; the resend skips 1 and 3 in the pre-dedup with no side effect', async () => {
        const body = delivery([
            change({
                contacts: [contactOf(A), contactOf(B), contactOf(C)],
                messages: [textMsg(A, 'wamid.p1', 'satu'), textMsg(B, 'wamid.p2', 'dua'), textMsg(C, 'wamid.p3', 'tiga')],
            }),
        ]);
        h.db.fail({ target: 'rpc:wa_ingest_inbound', match: (a) => a.p_wamid === 'wamid.p2', error: { code: '40001' } });
        expect(await deliver(body)).toBe(503);
        expect(details('webhook_error')).toEqual(['database 40001 — bentrok transaksi, aman bila jarang (1 dari 3 item)']);
        await settle();
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.p1', 'wamid.p3']);
        expect(pushes()).toHaveLength(2);
        const unread = () => h.db.chats.map((c) => [c.phone_number, c.unread_count]);
        expect(unread()).toEqual([[A, 1], [C, 1]]);
        const callsBefore = h.db.ingests().length;

        expect(await deliver(body)).toBe(200);
        await settle();
        // One pre-dedup query found 1 and 3: only 2 reached the database function.
        expect(h.db.ingests().slice(callsBefore).map((a) => a.p_wamid)).toEqual(['wamid.p2']);
        expect(h.db.prededups()).toHaveLength(2);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.p1', 'wamid.p3', 'wamid.p2']);
        expect(pushes().map((p) => p.body)).toEqual(['satu', 'tiga', 'dua']);
        expect(unread()).toEqual([[A, 1], [C, 1], [B, 1]]);
        expect(replies()).toHaveLength(3); // one per conversation, none twice
    });

    it('13b. three retryable failures in a row stop the walk: the rest is deferred without being tried', async () => {
        const ids = ['wamid.s1', 'wamid.s2', 'wamid.s3', 'wamid.s4', 'wamid.s5'];
        const phones = ['620000000011', '620000000012', '620000000013', '620000000014', '620000000015'];
        const body = delivery([change({ contacts: phones.map((p) => contactOf(p)), messages: ids.map((id, i) => textMsg(phones[i], id, `pesan ${i}`)) })]);
        h.db.fail({ target: 'rpc:wa_ingest_inbound', match: (a) => ids.slice(0, 3).includes(String(a.p_wamid)), error: { code: '57014' }, times: 3 });
        expect(await deliver(body)).toBe(503);
        expect(h.db.ingests().map((a) => a.p_wamid)).toEqual(ids.slice(0, 3));
        // One alert, the real failure (not webhook_deferred), counting the failed items.
        expect(h.db.events().map((e) => [e.kind, e.detail])).toEqual([['webhook_error', 'database 57014 — query database dibatalkan karena terlalu lama (3 dari 5 item)']]);
        expect(h.logs.map((l) => String(l[0])).find((l) => l.startsWith('Webhook batch:'))).toContain('retryable=3 deferred=2 (stop_rule)');
    });

    it('14. malformed signed items answer 200: a text without a body becomes a placeholder; a string value, statuses [null] and messages [42] are skipped; each is alerted', async () => {
        const body = delivery([
            change({
                contacts: [contactOf(A)],
                messages: [
                    { from: A, id: 'wamid.tanpa-isi', timestamp: metaTs(), type: 'text', text: {} },
                    { from: A, id: 'wamid.tanpa-text', timestamp: metaTs(), type: 'text' },
                ],
            }),
            { field: 'messages', value: 'bukan objek' },
            change({ statuses: [null] }),
            change({ contacts: [contactOf(B)], messages: [42] }),
        ]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.content, m.metadata])).toEqual([
            ['wamid.tanpa-isi', PLACEHOLDER, { unprocessable: 'text' }],
            ['wamid.tanpa-text', PLACEHOLDER, { unprocessable: 'text' }],
        ]);
        expect(h.db.chat(A)).toMatchObject({ unread_count: 2, last_message: PLACEHOLDER });
        expect(pushes().map((p) => p.body)).toEqual([PLACEHOLDER, PLACEHOLDER]);
        expect(h.db.queue).toEqual([]); // never to the AI
        expect(details('webhook_payload_invalid').sort()).toEqual(
            [
                'pesan "text": teks tanpa isi; disimpan sebagai pengganti',
                'pesan "text": teks tanpa isi; disimpan sebagai pengganti',
                'perubahan "messages" tanpa isi terbaca; dilewati',
                '1 status tanpa id; dilewati',
                'entri pesan tanpa isi terbaca; dilewati',
            ].sort(),
        );
        expect(h.db.events('webhook_error')).toEqual([]);
    });

    it('15a. a database answer specific to the message (P0002) answers 503 four times; the fifth delivery stores a placeholder with an alert', async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.racun', 'halo')] })]);
        const notPlaceholder = (a: Record<string, unknown>) => !(a.p_metadata as Record<string, unknown>).unprocessable;
        h.db.fail({ target: 'rpc:wa_ingest_inbound', match: notPlaceholder, error: { code: 'P0002' }, times: Infinity });
        const answers: number[] = [];
        for (let i = 0; i < 5; i++) answers.push(await deliver(body));
        await settle();
        expect(answers).toEqual([503, 503, 503, 503, 200]);
        expect(details('webhook_error')).toEqual(Array(4).fill('database P0002 (1 dari 1 item)'));
        expect(details('webhook_payload_invalid')).toEqual(['pesan "text": database P0002; disimpan sebagai pengganti']);
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.metadata])).toEqual([['wamid.racun', { unprocessable: 'text' }]]);
        expect(pushes()).toHaveLength(1);
    });

    it('15c. a thrown bug never turns a text into a placeholder (D24): 503 past the poison bound, and once it is fixed the text is stored with its content', async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.bug', 'tolong dibalas')] })]);
        h.db.fail({ target: 'rpc:wa_ingest_inbound', throws: new TypeError('x is not a function'), times: 7 });
        const answers: number[] = [];
        for (let i = 0; i < 8; i++) answers.push(await deliver(body));
        await settle();
        expect(answers).toEqual([503, 503, 503, 503, 503, 503, 503, 200]);
        expect(details('webhook_error')).toEqual(Array(7).fill('TypeError (1 dari 1 item)'));
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.content, m.metadata])).toEqual([['wamid.bug', 'tolong dibalas', {}]]);
    });

    it('15b. a placeholder that fails retryably keeps the answer 503; the next delivery stores it', async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.racun-2', 'halo')] })]);
        const isPlaceholder = (a: Record<string, unknown>) => !!(a.p_metadata as Record<string, unknown>).unprocessable;
        h.db.fail({ target: 'rpc:wa_ingest_inbound', match: (a) => !isPlaceholder(a), error: { code: 'P0002' }, times: Infinity });
        h.db.fail({ target: 'rpc:wa_ingest_inbound', match: isPlaceholder, error: { code: '40001' } });
        const answers: number[] = [];
        for (let i = 0; i < 6; i++) answers.push(await deliver(body));
        expect(answers).toEqual([503, 503, 503, 503, 503, 200]);
        expect(details('webhook_error').at(-1)).toBe('database 40001 — bentrok transaksi, aman bila jarang (1 dari 1 item)');
        expect(h.db.userRows().map((m) => m.metadata)).toEqual([{ unprocessable: 'text' }]);
    });

    it('16. 20 messages against a slow database: 503 + webhook_deferred; each resend makes one pre-dedup query and progresses until 200', async () => {
        h.db.ingestMs = 1_000; // each call takes a second of the 8 s budget
        const phones = Array.from({ length: 20 }, (_, i) => `6200000010${String(i).padStart(2, '0')}`);
        const body = delivery([change({ contacts: phones.map((p) => contactOf(p)), messages: phones.map((p, i) => textMsg(p, `wamid.lambat-${i}`, `pesan ${i}`)) })]);

        expect(await deliver(body)).toBe(503);
        expect(h.db.userRows()).toHaveLength(8);
        expect(h.db.events().map((e) => [e.kind, e.detail])).toEqual([
            ['webhook_deferred', '12 dari 20 item ditunda: batas waktu 8 detik habis; webhook menjawab 503, Meta mengirim ulang'],
        ]);
        await settle();

        expect(await deliver(body)).toBe(503);
        expect(h.db.userRows()).toHaveLength(16);
        expect(h.db.prededups()).toHaveLength(2);
        await settle();

        expect(await deliver(body)).toBe(200);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(phones.map((_, i) => `wamid.lambat-${i}`));
        expect(h.db.prededups()).toHaveLength(3); // one query per delivery (20 keys, one chunk)
        expect(h.db.ingests()).toHaveLength(20); // nothing went to the function twice
        expect(h.db.events('webhook_error')).toEqual([]);
    });

    it('17a. over the rate limit: one "Mohon tunggu" and one note for the window (D23-1); the next refusal does nothing; over-limit messages are not stored', async () => {
        // Manual mode: no AI reply moves the summary, so the note's is visible.
        h.db.seedChat({ phone_number: A, ai_enabled: false });
        const messages = Array.from({ length: 12 }, (_, i) => textMsg(A, `wamid.banjir-${i}`, `pesan ${i}`));
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages })]))).toBe(200);
        await settle();
        expect(h.db.userRows()).toHaveLength(10);
        expect(warnings()).toEqual([[SENT_FROM(), A, RATE_LIMIT_WARNING]]);
        expect(noteTexts()).toEqual([RATE_LIMIT_NOTE]);
        // The note left the chat unanswered: its summary is the customer's last stored message.
        expect(h.db.chat(A)).toMatchObject({ last_message: 'pesan 9', unread_count: 10 });
        expect(h.db.chat(A)!.last_message_at).toBe(h.db.chat(A)!.last_inbound_at);
        expect(pushes()).toHaveLength(10);
        expect(replies()).toEqual([]);
        // A new window: the limit counts again from 1.
        vi.setSystemTime(Date.now() + 61_000);
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.banjir-baru', 'lagi')] })]))).toBe(200);
        await settle();
        expect(h.db.userRows()).toHaveLength(11);
        expect(warnings()).toHaveLength(1);
    });

    it('17b. a warning that fails with Meta 190 answers 200, notes that it failed and records whatsapp_token_invalid', async () => {
        vi.mocked(sendWhatsAppMessage).mockImplementation(async (_creds, _to, text) => {
            if (text === RATE_LIMIT_WARNING) throw Object.assign(new Error('Meta WhatsApp 190'), { code: 190 });
            return { waMessageId: `wamid.keluar-${++h.outSeq}`, raw: {} };
        });
        const messages = Array.from({ length: 11 }, (_, i) => textMsg(A, `wamid.banjir-${i}`, `pesan ${i}`));
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages })]))).toBe(200);
        await settle();
        expect(noteTexts()).toEqual([RATE_LIMIT_WARNING_FAILED_NOTE]);
        expect(h.db.events('whatsapp_token_invalid')).toEqual([
            { kind: 'whatsapp_token_invalid', org: ORG, detail: 'saat mengirim peringatan batas pesan per menit', count: 1 },
        ]);
    });

    it('18a. a message without an id is stored under a syn. key; its resend is skipped as a duplicate', async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, null, 'tanpa id')] })]);
        expect(await deliver(body)).toBe(200);
        await settle();
        const [row] = h.db.userRows();
        expect(row.wa_message_id).toMatch(/^syn\.[0-9a-f]{64}$/);
        expect(pushes()).toHaveLength(1);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows()).toHaveLength(1);
        expect(h.db.ingests()).toHaveLength(1);
        expect(pushes()).toHaveLength(1);
        expect(replies()).toHaveLength(1);
    });

    it('18b. an empty access token: one webhook_unconfigured for the batch, the messages are still stored', async () => {
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', '');
        const body = delivery([change({ contacts: [contactOf(A), contactOf(B)], messages: [textMsg(A, 'wamid.t1', 'satu'), textMsg(B, 'wamid.t2', 'dua')] })]);
        expect(await deliver(body)).toBe(200);
        expect(h.db.events()).toEqual([
            {
                kind: 'webhook_unconfigured',
                org: ORG,
                detail: 'WHATSAPP_ACCESS_TOKEN tidak diset di server: pesan masuk tetap disimpan, tetapi balasan AI dan peringatan tidak terkirim',
                count: 1,
            },
        ]);
        expect(h.db.userRows()).toHaveLength(2);
    });

    it('19. an unknown young failed status is applied again once, 15 s later; sent and old ones are not', async () => {
        const failed = {
            id: 'wamid.keluar-muda',
            status: 'failed',
            timestamp: metaTs(5_000),
            recipient_id: A,
            errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'lewat 24 jam' } }],
        };
        const body = delivery([
            change({
                statuses: [
                    failed,
                    { id: 'wamid.keluar-sent', status: 'sent', timestamp: metaTs(5_000), recipient_id: A },
                    { id: 'wamid.keluar-tua', status: 'delivered', timestamp: metaTs(3 * 60_000), recipient_id: A },
                ],
            }),
        ]);
        expect(await deliver(body)).toBe(200);
        expect(h.db.rpcCalls('wa_apply_statuses')).toHaveLength(1);
        // The queue stores our sent messages after Meta accepted them.
        for (const id of ['wamid.keluar-muda', 'wamid.keluar-sent', 'wamid.keluar-tua']) h.db.seedAssistant(id, A, 'sent');

        await vi.advanceTimersByTimeAsync(14_999);
        expect(h.db.rpcCalls('wa_apply_statuses')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        const calls = h.db.rpcCalls('wa_apply_statuses');
        expect(calls).toHaveLength(2);
        expect((calls[1].p_statuses as Array<{ id: string }>).map((s) => s.id)).toEqual(['wamid.keluar-muda']);
        expect(h.db.messages.find((m) => m.wa_message_id === 'wamid.keluar-muda')).toMatchObject({
            status: 'failed',
            error_code: 131047,
            error_title: 'Re-engagement message',
            error_detail: 'lewat 24 jam',
        });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await settle();
        expect(h.db.rpcCalls('wa_apply_statuses')).toHaveLength(2);
    });

    it('20a. a resent contact card writes no second note, also when the pre-dedup cannot read (D23-3)', async () => {
        const card = {
            from: A,
            id: 'wamid.kartu-1',
            timestamp: metaTs(),
            type: 'contacts',
            contacts: [{ name: { formatted_name: 'Teman Palsu' }, phones: [{ phone: '+62 800-0000-0099', wa_id: '6280000000099' }] }],
        };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [card] })]);
        const note = 'Customer shared contact info — phone tersimpan: 6280000000099';
        expect(await deliver(body)).toBe(200);
        expect(noteTexts()).toEqual([note]);
        expect(h.db.chat(A)).toMatchObject({ verified_phone: '6280000000099', last_message_at: null });
        // A resend: the pre-dedup finds the note's wamid (any role).
        expect(await deliver(body)).toBe(200);
        // A resend while the pre-dedup query fails: the note's own key decides.
        h.db.fail({ target: 'whatsapp_messages.select', match: (a) => JSON.stringify(a.filters).includes('"in"') });
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(noteTexts()).toEqual([note]);
        expect(h.db.ingests()).toEqual([]); // a note, not an inbox message
        expect(h.db.queue).toEqual([]); // no AI
        expect(h.db.events()).toEqual([]);
    });

    it("20b. a retryable error of the card's chat write answers 503; the resend stores the note", async () => {
        const card = { from: A, id: 'wamid.kartu-2', timestamp: metaTs(), type: 'contacts', contacts: [{ phones: [{ wa_id: '6280000000098' }] }] };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [card] })]);
        h.db.fail({ target: 'whatsapp_chats.upsert', error: { code: '40001' } });
        expect(await deliver(body)).toBe(503);
        expect(details('webhook_error')).toEqual(['database 40001 — bentrok transaksi, aman bila jarang (1 dari 1 item)']);
        expect(h.db.notes()).toEqual([]);
        expect(await deliver(body)).toBe(200);
        expect(noteTexts()).toEqual(['Customer shared contact info — phone tersimpan: 6280000000098']);
    });
});

describe('owner decisions D23', () => {
    it('D23-2: a text 20 h or more old is stored and pushed without an AI reply, with one note per chat and hour; past 24 h the note says a template is needed', async () => {
        const late = (id: string, ageMs: number) => delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, id, `pesan ${id}`, { timestamp: metaTs(ageMs) })] })]);
        expect(await deliver(late('wamid.telat-1', 21 * HOUR))).toBe(200);
        await settle();
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.telat-1']);
        expect(h.db.queue).toEqual([]);
        expect(replies()).toEqual([]);
        expect(pushes()).toHaveLength(1);
        expect(noteTexts()).toEqual([lateMessageNotice(21 * HOUR)]);
        expect(noteTexts()[0]).toContain('21 jam');
        expect(noteTexts()[0]).not.toContain('template');
        // The summary moved to Meta's time of the message, not to now.
        expect(h.db.chat(A)!.last_inbound_at).toBe(new Date(Number(metaTs(21 * HOUR)) * 1000).toISOString());

        // The same chat within the hour: stored, no second note.
        expect(await deliver(late('wamid.telat-2', 30 * HOUR))).toBe(200);
        await settle();
        expect(h.db.notes()).toHaveLength(1);
        // An hour later, past 24 h: a note again, pointing to a template.
        vi.setSystemTime(Date.now() + HOUR);
        expect(await deliver(late('wamid.telat-3', 30 * HOUR))).toBe(200);
        await settle();
        expect(noteTexts()).toHaveLength(2);
        expect(noteTexts()[1]).toContain('30 jam');
        expect(noteTexts()[1]).toContain('kirim template');
        expect(replies()).toEqual([]);

        // Just under 20 h: the AI answers as usual.
        expect(await deliver(late('wamid.hampir', 20 * HOUR - 60_000))).toBe(200);
        await settle();
        expect(h.db.queue.map((j) => j.wa_message_id)).toEqual(['wamid.hampir']);
        expect(replies()).toHaveLength(1);

        // A chat in manual mode: the AI would not have answered anyway, no note.
        h.db.seedChat({ phone_number: B, ai_enabled: false });
        const lateB = delivery([change({ contacts: [contactOf(B)], messages: [textMsg(B, 'wamid.telat-b', 'pesan telat', { timestamp: metaTs(22 * HOUR) })] })]);
        expect(await deliver(lateB)).toBe(200);
        await settle();
        expect(h.db.userRows().some((m) => m.wa_message_id === 'wamid.telat-b')).toBe(true);
        expect(h.db.notes().filter((n) => n.phone_number === B)).toEqual([]);
    });

    it('D23-4: button, button_reply, list_reply, location, order, unsupported and unknown types on the main number are stored as one line without AI; reaction, system and request_welcome only acknowledged', async () => {
        const m = (id: string, type: string, extra: Record<string, unknown>) => ({ from: A, id, timestamp: metaTs(), type, ...extra });
        const body = delivery([
            change({
                contacts: [contactOf(A)],
                messages: [
                    m('wamid.o1', 'button', { button: { text: 'Ya, saya tertarik', payload: 'YA' } }),
                    m('wamid.o2', 'interactive', { interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Setuju' } } }),
                    m('wamid.o3', 'interactive', { interactive: { type: 'list_reply', list_reply: { id: 'p2', title: 'Paket B' } } }),
                    m('wamid.o4', 'location', { location: { name: 'Kantor', latitude: -6.2, longitude: 106.8 } }),
                    m('wamid.o5', 'order', { order: { catalog_id: 'katalog-palsu', product_items: [] } }),
                    m('wamid.o6', 'unsupported', {}),
                    m('wamid.o7', 'tipe_baru', {}),
                    m('wamid.o8', 'reaction', { reaction: { message_id: 'wamid.o1', emoji: '👍' } }),
                    m('wamid.o9', 'system', { system: { type: 'user_changed_number', body: 'nomor berubah' } }),
                    m('wamid.o10', 'request_welcome', {}),
                ],
            }),
        ]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows().map((r) => r.content)).toEqual([
            '🔘 Tombol: Ya, saya tertarik',
            '🔘 Pilihan: Setuju',
            '🔘 Pilihan: Paket B',
            '📍 Lokasi: Kantor',
            'Pesan jenis "order" (isinya tidak ditampilkan di Sarathi)',
            'Pesan jenis "unsupported" (isinya tidak ditampilkan di Sarathi)',
            'Pesan jenis "tipe_baru" (isinya tidak ditampilkan di Sarathi)',
        ]);
        // Readable lines join the AI history; the rest stay out of it.
        expect(h.db.userRows().map((r) => r.metadata)).toEqual([
            {},
            {},
            {},
            {},
            { unprocessable: 'order' },
            { unprocessable: 'unsupported' },
            { unprocessable: 'tipe_baru' },
        ]);
        expect(h.db.ingests().every((a) => a.p_ai_eligible === false && a.p_rate_scope === 'main')).toBe(true);
        expect(h.db.queue).toEqual([]);
        expect(replies()).toEqual([]);
        // Unread, pushed, "Belum dibalas" (the summary is the customer's).
        expect(h.db.chat(A)).toMatchObject({ unread_count: 7 });
        expect(h.db.chat(A)!.last_message_at).toBe(h.db.chat(A)!.last_inbound_at);
        expect(pushes().map((p) => p.body)[3]).toBe('📍 Lokasi'); // the place stays off the lock screen
        expect(pushes()).toHaveLength(7);
    });
});

describe('committed before the answer, effects after it (C1 verification MUT-1/MUT-2)', () => {
    it("a text's ingest (row, job, summary) is committed when POST returns", async () => {
        const res = await POST(signedPost(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.segera', 'halo')] })])));
        expect(res.status).toBe(200);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.segera']);
        expect(h.db.queue.map((j) => j.wa_message_id)).toEqual(['wamid.segera']);
        expect(h.db.chat(A)).toMatchObject({ unread_count: 1, last_message: 'halo' });
    });

    it('the main-number card note is committed when POST returns', async () => {
        const card = { from: A, id: 'wamid.kartu-segera', timestamp: metaTs(), type: 'contacts', contacts: [{ phones: [{ wa_id: '6280000000097' }] }] };
        expect((await POST(signedPost(delivery([change({ contacts: [contactOf(A)], messages: [card] })])))).status).toBe(200);
        expect(h.db.notes().map((n) => n.wa_message_id)).toEqual(['wamid.kartu-segera']);
    });

    it('the statuses call is committed when POST returns', async () => {
        h.db.seedAssistant('wamid.keluar-segera', A, 'sent');
        const body = delivery([change({ statuses: [{ id: 'wamid.keluar-segera', status: 'read', timestamp: metaTs(), recipient_id: A }] })]);
        expect((await POST(signedPost(body))).status).toBe(200);
        expect(h.db.messages[0].status).toBe('read');
    });

    it('the user_id_update move is committed when POST returns', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.lama' });
        const body = delivery([{ field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.lama', current: 'ID.baru' } }] } }]);
        expect((await POST(signedPost(body))).status).toBe(200);
        expect(h.db.chat(A)!.bsuid).toBe('ID.baru');
    });

    it('a push that never settles does not hold the 200', async () => {
        const held = gate();
        vi.mocked(sendPushToOrg).mockImplementation(() => held.wait);
        try {
            expect(await answerWithin(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.push-lambat', 'halo')] })]))).toBe(200);
            expect(sendPushToOrg).toHaveBeenCalledTimes(1); // started, still waiting
        } finally {
            held.open();
        }
        await settle();
    });

    it('a rate-limit warning send that never settles does not hold the 200', async () => {
        const held = gate();
        vi.mocked(sendWhatsAppMessage).mockImplementation(async (_creds, _to, text) => {
            if (text === RATE_LIMIT_WARNING) await held.wait;
            return { waMessageId: `wamid.keluar-${++h.outSeq}`, raw: {} };
        });
        const messages = Array.from({ length: 11 }, (_, i) => textMsg(A, `wamid.tahan-${i}`, `pesan ${i}`));
        try {
            expect(await answerWithin(delivery([change({ contacts: [contactOf(A)], messages })]))).toBe(200);
            expect(warnings()).toHaveLength(1);
            expect(h.db.notes()).toEqual([]); // the note waits for the send
        } finally {
            held.open();
        }
        await settle();
        expect(noteTexts()).toEqual([RATE_LIMIT_NOTE]);
    });

    it('a note that never settles does not hold the 200', async () => {
        h.db.hang = (target, args) => target === 'whatsapp_messages.insert' && (args.payload as Record<string, unknown>).role === 'system';
        const late = textMsg(A, 'wamid.catatan-lambat', 'halo', { timestamp: metaTs(22 * HOUR) });
        try {
            expect(await answerWithin(delivery([change({ contacts: [contactOf(A)], messages: [late] })]))).toBe(200);
            expect(h.db.userRows()).toHaveLength(1);
            expect(h.db.notes()).toEqual([]);
        } finally {
            h.db.release();
        }
        await settle();
        expect(h.db.notes()).toHaveLength(1);
    });
});

describe('the queue drain and the AI', () => {
    it('three quick fragments are answered once, after the debounce, by the drain the batch scheduled', async () => {
        vi.stubEnv('WHATSAPP_DEBOUNCE_SECONDS', '2');
        for (const [i, text] of ['satu', 'dua', 'tiga'].entries()) {
            expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, `wamid.fragmen-${i}`, text)] })]))).toBe(200);
            await settle();
            vi.setSystemTime(Date.now() + 500);
        }
        // Each delivery drained at once: the burst had not settled yet.
        expect(h.db.rpcCalls('claim_queue_jobs')).toHaveLength(3);
        expect(replies()).toEqual([]);
        expect(h.db.queue.map((j) => j.status)).toEqual(['pending', 'pending', 'pending']);
        await vi.advanceTimersByTimeAsync(7_000);
        await settle();
        expect(generateRAGResponse).toHaveBeenCalledTimes(1);
        expect(vi.mocked(generateRAGResponse).mock.calls[0][0]).toBe('satu\ndua\ntiga');
        expect(replies()).toHaveLength(1);
        expect(h.db.queue.map((j) => j.status)).toEqual(['completed', 'completed', 'completed']);
    });

    it('a batch drains the queue once, however many of its messages were queued', async () => {
        const body = delivery([change({ contacts: [contactOf(A), contactOf(B), contactOf(C)], messages: [textMsg(A, 'wamid.q1', 'a'), textMsg(B, 'wamid.q2', 'b'), textMsg(C, 'wamid.q3', 'c')] })]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.rpcCalls('claim_queue_jobs')).toHaveLength(1);
        expect(replies()).toHaveLength(3);
    });

    it('a placeholder and a message to another number stay out of the AI history; the burst itself is not in it twice', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.lain', 'ke nomor lain')] }, OTHER_PNID)]))).toBe(200);
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [{ from: A, id: 'wamid.rusak', timestamp: metaTs(), type: 'text', text: { body: 7 } }] })]))).toBe(200);
        await settle();
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.utama', 'pertanyaan')] })]))).toBe(200);
        await settle();
        expect(vi.mocked(generateRAGResponse).mock.calls).toEqual([['pertanyaan', [], A, { orgId: ORG }]]);
    });

    it('a text with U+0000 and a lone surrogate is stored and queued clean (every parameter sanitised)', async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.kotor', 'halo\u0000 kak \uD83D')] })]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows().map((m) => [m.content, m.metadata])).toEqual([['halo kak �', {}]]);
        expect(h.db.queue.map((j) => j.message_text)).toEqual(['halo kak �']);
        expect(vi.mocked(generateRAGResponse).mock.calls[0][0]).toBe('halo kak �');
        expect(h.db.events()).toEqual([]);
    });
});

describe('the rest of the batch walk (C2_SPEC sections 6 and 7)', () => {
    it('an unreadable default org answers 503 with webhook_error without an org, and is read once', async () => {
        h.orgError = Object.assign(new Error('platform setting default_org_id could not be read (57014)'), { name: 'PlatformSettingReadError', code: '57014' });
        const body = delivery([change({ contacts: [contactOf(A), contactOf(B)], messages: [textMsg(A, 'wamid.o-1', 'a'), textMsg(B, 'wamid.o-2', 'b')], statuses: [{ id: 'wamid.x', status: 'read' }] })]);
        expect(await deliver(body)).toBe(503);
        expect(h.orgReads).toBe(1);
        expect(h.db.ingests()).toEqual([]);
        expect(h.db.events()).toEqual([{ kind: 'webhook_error', org: null, detail: 'database 57014 — org default tidak terbaca, periksa Supabase (3 dari 3 item)', count: 1 }]);
    });

    it('user_id_update: a database error answers 503; a 23505 is only logged (200, no alert)', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.lama' });
        const body = delivery([{ field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.lama', current: 'ID.baru' } }] } }]);
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: '08006' } });
        expect(await deliver(body)).toBe(503);
        expect(details('webhook_error')).toEqual(['database 08006 — Supabase tidak terjangkau atau sedang gangguan (1 dari 1 item)']);
        expect(h.db.chat(A)!.bsuid).toBe('ID.lama');
        // Another chat of the org already holds the new id: cannot succeed on a retry.
        h.db.seedChat({ phone_number: B, bsuid: 'ID.baru' });
        expect(await deliver(body)).toBe(200);
        expect(h.db.chat(A)!.bsuid).toBe('ID.lama');
        expect(h.db.events()).toHaveLength(1);
    });

    it('a call cut off by the time budget is deferred, not counted as a failure of the message; with no item done at all it is alerted as a slow database (webhook_error)', async () => {
        // The pre-dedup query takes 7.99 s of the 8 s budget; the ingest then
        // hangs until its signal (the 10 ms left) aborts it.
        h.db.clockStep = (target) => (target === 'whatsapp_messages.select' ? 7_990 : 0);
        h.db.hang = (target) => target === 'rpc:wa_ingest_inbound';
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.terpotong', 'halo')] })]);
        expect(await deliver(body)).toBe(503);
        expect(h.db.ingests()).toHaveLength(1);
        expect(h.db.events().map((e) => [e.kind, e.detail])).toEqual([
            ['webhook_error', 'database lambat atau tidak menjawab: 1 dari 1 item ditunda tanpa satu pun selesai dalam 8 detik; webhook menjawab 503, Meta mengirim ulang'],
        ]);
        expect(poisonCount('wamid.terpotong')).toBe(0);
        expect(h.db.userRows()).toEqual([]);
    });

    it('a status change that keeps failing answers 503 four times, then is skipped with an alert; a permanent error skips it at once (C2_SPEC 6.9)', async () => {
        h.db.seedAssistant('wamid.keluar-racun', A, 'sent');
        const body = delivery([change({ statuses: [{ id: 'wamid.keluar-racun', status: 'read', timestamp: metaTs(), recipient_id: A }] })]);
        // P0002 (a STRICT select found no row): a database answer specific to the item's call, which counts.
        h.db.fail({ target: 'rpc:wa_apply_statuses', error: { code: 'P0002' }, times: Infinity });
        const answers: number[] = [];
        for (let i = 0; i < 5; i++) answers.push(await deliver(body));
        expect(answers).toEqual([503, 503, 503, 503, 200]);
        expect(details('webhook_error')).toEqual(Array(4).fill('database P0002 (1 dari 1 item)'));
        expect(details('webhook_payload_invalid')).toEqual(['1 status: database P0002; dilewati']);
        h.db.failures = [];
        h.db.fail({ target: 'rpc:wa_apply_statuses', error: { code: '22P02' } });
        const other = delivery([change({ statuses: [{ id: 'wamid.keluar-lain', status: 'read', timestamp: metaTs(), recipient_id: A }] })]);
        expect(await deliver(other)).toBe(200);
        expect(details('webhook_payload_invalid')).toEqual(['1 status: database P0002; dilewati', '1 status: database 22P02; dilewati']);
        expect(h.db.events('webhook_error')).toHaveLength(4);
    });

    it('a slow or contended database (57014, 55P03, 40P01) never skips a status: it stays 503 past the poison bound and applies once the database recovers', async () => {
        const row = h.db.seedAssistant('wamid.keluar-lambat-db', A, 'sent');
        const body = delivery([change({ statuses: [{ id: 'wamid.keluar-lambat-db', status: 'read', timestamp: metaTs(), recipient_id: A }] })]);
        // Each code alone reaches the bound (it would skip the status if it
        // counted); then one failure that counts, which must still answer 503.
        for (const code of ['57014', '55P03', '40P01']) h.db.fail({ target: 'rpc:wa_apply_statuses', error: { code }, times: POISON_LIMIT });
        h.db.fail({ target: 'rpc:wa_apply_statuses', error: { code: 'P0002' } });
        const answers: number[] = [];
        for (let i = 0; i < 3 * POISON_LIMIT + 2; i++) answers.push(await deliver(body));
        expect(answers).toEqual([...Array(3 * POISON_LIMIT + 1).fill(503), 200]);
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
        expect(row.status).toBe('read');
    });

    it("user_id_update entries apply oldest first by Meta's timestamp, across changes: a chain of number changes ends on the newest BSUID", async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.satu' });
        const entry = (previous: string, current: string, ago: number) => ({ user_id: { previous, current }, timestamp: metaTs(ago) });
        const body = delivery(
            [{ field: 'user_id_update', value: { user_id_update: [entry('ID.dua', 'ID.tiga', 10_000)] } }],
            [{ field: 'user_id_update', value: { user_id_update: [entry('ID.satu', 'ID.dua', 60_000)] } }],
        );
        expect(await deliver(body)).toBe(200);
        expect(h.db.chat(A)!.bsuid).toBe('ID.tiga');
    });

    it('a user_id_update the database keeps refusing (P0002) answers 503 four times, then is skipped with an alert (C2_SPEC 6.9)', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.lama' });
        const body = delivery([{ field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.lama', current: 'ID.baru' } }] } }]);
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: 'P0002' }, times: Infinity });
        const answers: number[] = [];
        for (let i = 0; i < 5; i++) answers.push(await deliver(body));
        expect(answers).toEqual([503, 503, 503, 503, 200]);
        expect(details('webhook_payload_invalid')).toEqual(['user_id_update: database P0002; dilewati']);
        expect(h.db.chat(A)!.bsuid).toBe('ID.lama');
    });

    it('a thrown bug never skips a user_id_update or a status (D24): both stay 503 past the poison bound and apply once it is fixed', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.bug-lama' });
        const row = h.db.seedAssistant('wamid.keluar-bug', A, 'sent');
        const body = delivery(
            [{ field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.bug-lama', current: 'ID.bug-baru' } }] } }],
            [change({ statuses: [{ id: 'wamid.keluar-bug', status: 'read', timestamp: metaTs(), recipient_id: A }] })],
        );
        h.db.fail({ target: 'whatsapp_chats.update', throws: new TypeError('boom'), times: 6 });
        h.db.fail({ target: 'rpc:wa_apply_statuses', throws: new TypeError('boom'), times: 6 });
        const answers: number[] = [];
        for (let i = 0; i < 7; i++) answers.push(await deliver(body));
        expect(answers).toEqual([503, 503, 503, 503, 503, 503, 200]);
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
        expect(h.db.chat(A)!.bsuid).toBe('ID.bug-baru');
        expect(row.status).toBe('read');
    });

    it("the pre-dedup asks for 50 keys per query and finds only this org's rows: a wamid stored in another org does not skip the message", async () => {
        h.db.quotaLimit = { inbound_minute: 1_000 };
        h.db.insertMessage({ org_id: OTHER_ORG, phone_number: A, role: 'user', content: 'di org lain', wa_message_id: 'wamid.k-0' });
        const phones = Array.from({ length: 101 }, (_, i) => `62000000${String(2000 + i)}`);
        const body = delivery([change({ contacts: phones.map((p) => contactOf(p)), messages: phones.map((p, i) => textMsg(p, `wamid.k-${i}`, `pesan ${i}`)) })]);
        expect(await deliver(body)).toBe(200);
        expect(
            h.db.prededups().map((filters) => [
                filters.find((f) => f.kind === 'eq' && f.column === 'org_id')?.value,
                (filters.find((f) => f.kind === 'in')!.value as string[]).length,
            ]),
        ).toEqual([
            [ORG, 50],
            [ORG, 50],
            [ORG, 1],
        ]);
        expect(h.db.userRows()).toHaveLength(101);
        expect(h.db.userRows()[0]).toMatchObject({ wa_message_id: 'wamid.k-0', phone_number: phones[0] });
    });

    it('a Flow resend never reaches handleFlowReply again (pre-dedup), and a media resend is not downloaded again', async () => {
        const flow = {
            from: A,
            id: 'wamid.flow-1',
            timestamp: metaTs(),
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"flow_token":"t","nama":"Budi Palsu"}' } },
        };
        const image = { from: A, id: 'wamid.foto-1', timestamp: metaTs(), type: 'image', image: { id: 'media-palsu-1', mime_type: 'image/jpeg' } };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [flow, image] })]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(handleFlowReply).toHaveBeenCalledTimes(1);
        expect(downloadWhatsAppMedia).toHaveBeenCalledTimes(1);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.flow-1', 'wamid.foto-1']);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(handleFlowReply).toHaveBeenCalledTimes(1);
        expect(downloadWhatsAppMedia).toHaveBeenCalledTimes(1);
        expect(h.db.uploads).toHaveLength(1);
    });
});

describe('fixes after the independent review of PR-C2 (2026-10-30)', () => {
    it('a function missing before 0072 (PGRST202) never counts toward the poison bound: after it is fixed one more failure still answers 503, then the real text is stored', async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.migrasi', 'halo')] })]);
        h.db.fail({ target: 'rpc:wa_ingest_inbound', error: { code: 'PGRST202' }, status: 404, times: 6 });
        // One failure that counts: had the outage raised the count, it would store a placeholder now.
        h.db.fail({ target: 'rpc:wa_ingest_inbound', error: { code: 'P0002' } });
        const answers: number[] = [];
        for (let i = 0; i < 8; i++) answers.push(await deliver(body));
        await settle();
        expect(answers).toEqual([503, 503, 503, 503, 503, 503, 503, 200]);
        expect(details('webhook_error')[0]).toBe(
            'database PGRST202 — fungsi database tidak ditemukan, migrasi belum diterapkan? (1 dari 1 item)',
        );
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.content, m.metadata])).toEqual([['wamid.migrasi', 'halo', {}]]);
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
    });

    it('statuses under such an outage stay 503 (Meta keeps them) instead of being skipped at the poison bound', async () => {
        const row = h.db.seedAssistant('wamid.keluar-pgrst', A, 'sent');
        const body = delivery([change({ statuses: [{ id: 'wamid.keluar-pgrst', status: 'read', timestamp: metaTs(), recipient_id: A }] })]);
        h.db.fail({ target: 'rpc:wa_apply_statuses', error: { code: 'PGRST202' }, status: 404, times: 6 });
        // One failure that counts: had the outage raised the count, it would skip the status now.
        h.db.fail({ target: 'rpc:wa_apply_statuses', error: { code: 'P0002' } });
        const answers: number[] = [];
        for (let i = 0; i < 8; i++) answers.push(await deliver(body));
        expect(answers).toEqual([503, 503, 503, 503, 503, 503, 503, 200]);
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
        expect(row.status).toBe('read');
    });

    it('a Flow whose own insert fails (not as a duplicate) answers 503 with nothing else done; the resend does it once, with clean answers', async () => {
        const flow = {
            from: A,
            id: 'wamid.flow-gate',
            timestamp: metaTs(),
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"flow_token":"t","nama":"Budi\u0000 Palsu"}' } },
        };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [flow] })]);
        vi.mocked(handleFlowReply).mockImplementationOnce(async () => ({ status: 'gate_failed', error: { code: '57014' }, httpStatus: 500 }));
        expect(await deliver(body)).toBe(503);
        expect(details('webhook_error')).toEqual(['database 57014 — query database dibatalkan karena terlalu lama (1 dari 1 item)']);
        expect(h.db.userRows()).toEqual([]);
        expect(await deliver(body)).toBe(200);
        expect(handleFlowReply).toHaveBeenCalledTimes(2);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.flow-gate']);
        const answers = vi.mocked(handleFlowReply).mock.calls[1][0].nfmReply;
        expect(JSON.stringify(answers)).not.toContain('\\u0000');
        expect(answers.response_json).toContain('Budi Palsu');
    });

    it('a message whose BSUID move failed in the same delivery waits for the resend instead of opening a second chat', async () => {
        h.db.seedChat({ phone_number: D, bsuid: 'ID.lama-d' });
        const move = { user_id_update: [{ user_id: { previous: 'ID.lama-d', current: 'ID.baru-d' }, timestamp: metaTs(5_000) }] };
        const hidden = { from_user_id: 'ID.baru-d', id: 'wamid.tanpa-nomor', timestamp: metaTs(), type: 'text', text: { body: 'halo lagi' } };
        const body = delivery(
            [{ field: 'user_id_update', value: move }],
            [change({ contacts: [{ profile: { name: 'Pelanggan Palsu' }, user_id: 'ID.baru-d' }], messages: [hidden] })],
        );
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: '57014' } });
        expect(await deliver(body)).toBe(503);
        expect(h.db.userRows()).toEqual([]);
        expect(h.db.chat('ID.baru-d')).toBeUndefined();
        expect(await deliver(body)).toBe(200);
        expect(h.db.chat(D)!.bsuid).toBe('ID.baru-d');
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.phone_number])).toEqual([['wamid.tanpa-nomor', D]]);
    });

    it("the only contact of a change is not lent to a message from another customer", async () => {
        const body = delivery([
            change({ contacts: [contactOf(A, 'ID.a')], messages: [textMsg(A, 'wamid.dari-a', 'dari A'), textMsg(B, 'wamid.dari-b', 'dari B')] }),
        ]);
        expect(await deliver(body)).toBe(200);
        const b = h.db.ingests().find((a) => a.p_wamid === 'wamid.dari-b')!;
        expect([b.p_from, b.p_bsuid, b.p_verified_phone]).toEqual([B, null, B]);
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.phone_number])).toEqual([
            ['wamid.dari-a', A],
            ['wamid.dari-b', B],
        ]);
    });

    it('a type Sarathi does not show is stored for the operators, marked unprocessable so the AI history leaves it out; a location stays readable', async () => {
        const order = { from: A, id: 'wamid.order-1', timestamp: metaTs(), type: 'order', order: { catalog_id: 'katalog-palsu', product_items: [] } };
        const location = {
            from: A,
            id: 'wamid.lokasi-1',
            timestamp: metaTs(),
            type: 'location',
            location: { latitude: -6.2, longitude: 106.8, name: 'Gedung Palsu' },
        };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [order, location] })]);
        expect(await deliver(body)).toBe(200);
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.metadata])).toEqual([
            ['wamid.order-1', { unprocessable: 'order' }],
            ['wamid.lokasi-1', {}],
        ]);
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
    });

    it('a media caption reaches the database clean (no U+0000, no lone surrogate)', async () => {
        const image = {
            from: A,
            id: 'wamid.foto-kotor',
            timestamp: metaTs(),
            type: 'image',
            image: { id: 'media-palsu-9', mime_type: 'image/jpeg', caption: 'foto\u0000 acara \ud800' },
        };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [image] })]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows().map((m) => m.content)).toEqual(['foto acara \ufffd']);
    });

    it('a document filename reaches the database clean, in the message row and in the chat preview', async () => {
        vi.mocked(downloadWhatsAppMedia).mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/pdf', size: 3 });
        const doc = {
            from: A,
            id: 'wamid.dokumen-kotor',
            timestamp: metaTs(),
            type: 'document',
            document: { id: 'media-palsu-10', mime_type: 'application/pdf', filename: 'brosur\u0000 acara \ud800.pdf' },
        };
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [doc] })]))).toBe(200);
        await settle();
        expect(h.db.userRows().map((m) => m.media_filename)).toEqual(['brosur acara \ufffd.pdf']);
        expect(h.db.chat(A)!.last_message).toBe('\ud83d\udcce brosur acara \ufffd.pdf');
    });
});

describe('pins the independent TS review asked for (TSR-4)', () => {
    it('(a) a main-number text keeps the message it replies to', async () => {
        const reply = textMsg(A, 'wamid.balas-1', 'iya', { context: { from: PNID, id: 'wamid.keluar-asal' } });
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [reply] })]))).toBe(200);
        expect(h.db.ingests().map((a) => a.p_reply_to_wamid)).toEqual(['wamid.keluar-asal']);
    });

    it("(b, c) a main-number card writes the BSUID only on the sender's chat of this org; a BSUID held elsewhere (23505) still answers 200 with the note", async () => {
        const card = {
            from: A,
            id: 'wamid.kartu-bsuid',
            timestamp: metaTs(),
            type: 'contacts',
            contacts: [{ name: { formatted_name: 'Teman Palsu' }, phones: [{ phone: '+62 800-0000-9999', wa_id: '620000009999' }] }],
        };
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: '23505' } });
        expect(await deliver(delivery([change({ contacts: [contactOf(A, 'ID.kartu-a')], messages: [card] })]))).toBe(200);
        const update = h.db.calls.find((c) => c.target === 'whatsapp_chats.update')!;
        expect(update.filters!.map((f) => [f.kind, f.column, f.value])).toEqual([
            ['eq', 'org_id', ORG],
            ['eq', 'phone_number', A],
        ]);
        expect(noteTexts()).toEqual(['Customer shared contact info — phone tersimpan: 620000009999']);
        expect(h.db.events()).toEqual([]);
    });

    it('(d) a statuses call cut off by the time budget is deferred, not failed', async () => {
        h.db.seedAssistant('wamid.keluar-lambat', A, 'sent');
        // The text's own call uses up the budget (its signal had the full 8 s,
        // so it completes whatever the event loop does); the statuses call
        // after it gets 10 ms and hangs until it is cut off.
        h.db.clockStep = (target) => (target === 'rpc:wa_ingest_inbound' ? 7_990 : 0);
        h.db.hang = (target) => target === 'rpc:wa_apply_statuses';
        const body = delivery([
            change({
                contacts: [contactOf(A)],
                messages: [textMsg(A, 'wamid.sebelum-status', 'halo')],
                statuses: [{ id: 'wamid.keluar-lambat', status: 'read', timestamp: metaTs(), recipient_id: A }],
            }),
        ]);
        expect(await deliver(body)).toBe(503);
        expect(h.db.events().map((e) => e.kind)).toEqual(['webhook_deferred']);
        expect(batchLines()).toEqual([expect.stringContaining('new=1 duplicate=0')]);
        expect(batchLines()[0]).toContain('retryable=0 deferred=1 ');
    });

    it('(d) a user_id_update cut off by the time budget is deferred, not failed; with nothing done it is alerted as a slow database', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.lama-lambat' });
        vi.mocked(getDefaultOrgIdStrict).mockImplementationOnce(async () => {
            vi.setSystemTime(Date.now() + 7_990);
            return ORG;
        });
        h.db.hang = (target) => target === 'whatsapp_chats.update';
        const move = { user_id_update: [{ user_id: { previous: 'ID.lama-lambat', current: 'ID.baru-lambat' } }] };
        expect(await deliver(delivery([{ field: 'user_id_update', value: move }]))).toBe(503);
        expect(h.db.chat(A)!.bsuid).toBe('ID.lama-lambat');
        expect(details('webhook_error')).toEqual([
            'database lambat atau tidak menjawab: 1 dari 1 item ditunda tanpa satu pun selesai dalam 8 detik; webhook menjawab 503, Meta mengirim ulang',
        ]);
        expect(batchLines()[0]).toContain('retryable=0 deferred=1 ');
    });

    it('(d) a placeholder write cut off by the time budget is deferred, not failed', async () => {
        // A text without a body becomes a placeholder; its own write then
        // hangs until the 10 ms left of the budget cut it off.
        h.db.clockStep = (target) => (target === 'whatsapp_messages.select' ? 7_990 : 0);
        h.db.hang = (target) => target === 'rpc:wa_ingest_inbound';
        const broken = { from: A, id: 'wamid.tanpa-isi-lambat', timestamp: metaTs(), type: 'text', text: {} };
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [broken] })]))).toBe(503);
        expect(h.db.userRows()).toEqual([]);
        expect(details('webhook_error')).toEqual([
            'database lambat atau tidak menjawab: 1 dari 1 item ditunda tanpa satu pun selesai dalam 8 detik; webhook menjawab 503, Meta mengirim ulang',
        ]);
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
        expect(batchLines()[0]).toContain('degraded=0 skipped=0 retryable=0 deferred=1 ');
    });

    it('(e) D23-2 at its edges: a text exactly 20 h old gets no AI, and a note at exactly 24 h names the template', async () => {
        const at20 = textMsg(A, 'wamid.tepat-20', 'halo', { timestamp: metaTs(20 * HOUR) });
        const at24 = textMsg(B, 'wamid.tepat-24', 'halo', { timestamp: metaTs(24 * HOUR) });
        expect(await deliver(delivery([change({ contacts: [contactOf(A), contactOf(B)], messages: [at20, at24] })]))).toBe(200);
        await settle();
        expect(h.db.ingests().map((a) => [a.p_wamid, a.p_ai_eligible])).toEqual([
            ['wamid.tepat-24', false],
            ['wamid.tepat-20', false],
        ]);
        expect(lateMessageNotice(24 * HOUR)).toContain('kirim template');
        expect(lateMessageNotice(24 * HOUR - 1)).not.toContain('kirim template');
        expect(noteTexts()).toEqual(expect.arrayContaining([lateMessageNotice(24 * HOUR), lateMessageNotice(20 * HOUR)]));
    });

    it('(f) a message without a timestamp sorts as now: after one Meta sent a minute earlier', async () => {
        const noTs = { from: A, id: 'wamid.tanpa-waktu', type: 'text', text: { body: 'tanpa waktu' } };
        const older = textMsg(B, 'wamid.semenit-lalu', 'lebih dulu', { timestamp: metaTs(60_000) });
        expect(await deliver(delivery([change({ contacts: [contactOf(A), contactOf(B)], messages: [noTs, older] })]))).toBe(200);
        expect(h.db.ingests().map((a) => a.p_wamid)).toEqual(['wamid.semenit-lalu', 'wamid.tanpa-waktu']);
    });

    it('(g) a Flow submission without its object is stored as a placeholder, with an alert', async () => {
        const flow = { from: A, id: 'wamid.flow-kosong', timestamp: metaTs(), type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: 'x' } };
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [flow] })]))).toBe(200);
        expect(handleFlowReply).not.toHaveBeenCalled();
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.metadata])).toEqual([['wamid.flow-kosong', { unprocessable: 'interactive' }]]);
        expect(details('webhook_payload_invalid')).toEqual(['pesan "interactive": kiriman form tanpa isi; disimpan sebagai pengganti']);
    });

    it('(h) a late text to another number of the WABA gets no late note (it never gets AI anyway)', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        const late = textMsg(A, 'wamid.lain-telat', 'halo', { timestamp: metaTs(21 * HOUR) });
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [late] }, OTHER_PNID)]))).toBe(200);
        await settle();
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.lain-telat']);
        expect(noteTexts().some((t) => t.startsWith('Pesan pelanggan di atas baru diterima'))).toBe(false);
    });

    it('(i) a status change is skipped only when every status in it reached the poison bound', async () => {
        const s1 = { id: 'wamid.keluar-s1', status: 'read', timestamp: metaTs(), recipient_id: A };
        const s2 = { id: 'wamid.keluar-s2', status: 'read', timestamp: metaTs(), recipient_id: A };
        // P0002 counts toward the bound (a slow database would not).
        h.db.fail({ target: 'rpc:wa_apply_statuses', error: { code: 'P0002' }, times: 5 });
        for (let i = 0; i < 4; i++) expect(await deliver(delivery([change({ statuses: [s1] })]))).toBe(503);
        expect(await deliver(delivery([change({ statuses: [s1, s2] })]))).toBe(503);
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
    });

    it('(j) a contact card without a phone, from a sender without one, is acknowledged without an alert or a note', async () => {
        const card = { from_user_id: 'ID.tanpa-hp', id: 'wamid.kartu-kosong', timestamp: metaTs(), type: 'contacts', contacts: [{ name: { formatted_name: 'Teman Palsu' } }] };
        const body = delivery([change({ contacts: [{ profile: { name: 'Pelanggan Palsu' }, user_id: 'ID.tanpa-hp' }], messages: [card] })]);
        expect(await deliver(body)).toBe(200);
        expect(h.db.events()).toEqual([]);
        expect(noteTexts()).toEqual([]);
    });
});

describe('pins the final review asked for (2026-10-30)', () => {
    it('a user_id_update under a read-only database (25006) stays 503 past the poison bound, then moves once the database is writable', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.lama' });
        const body = delivery([{ field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.lama', current: 'ID.baru' } }] } }]);
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: '25006' }, status: 500, times: 6 });
        // One failure that counts: had the outage raised the count, it would skip the move now.
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: 'P0002' } });
        const answers: number[] = [];
        for (let i = 0; i < 8; i++) answers.push(await deliver(body));
        expect(answers).toEqual([503, 503, 503, 503, 503, 503, 503, 200]);
        expect(h.db.chat(A)!.bsuid).toBe('ID.baru');
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
    });

    it('a user_id_update entry without readable ids is skipped with an alert (Meta may change the shape during the BSUID rollout)', async () => {
        const body = delivery([{ field: 'user_id_update', value: { user_id_update: [{ wa_id: A, detail: 'tanpa id' }] } }]);
        expect(await deliver(body)).toBe(200);
        expect(details('webhook_payload_invalid')).toEqual(['user_id_update tanpa id lama/baru yang terbaca; dilewati']);
        expect(batchLines()[0]).toContain('acked=0 legacy=0 degraded=0 skipped=1 ');
    });

    it('a contact-card note that fails at the network level on every resend stays 503: the outage never turns the card into a placeholder', async () => {
        const card = {
            from: A,
            id: 'wamid.kartu-jaringan',
            timestamp: metaTs(),
            type: 'contacts',
            contacts: [{ name: { formatted_name: 'Teman Palsu' }, phones: [{ phone: '+62 800-0000-7777', wa_id: '620000007777' }] }],
        };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [card] })]);
        h.db.fail({
            target: 'whatsapp_messages.insert',
            match: (a) => JSON.stringify(a.payload ?? null).includes('"role":"system"'),
            error: { code: '', message: 'TypeError: fetch failed' },
            status: 0,
            times: 6,
        });
        // One failure that counts: had the outage raised the count, it would store a placeholder now.
        h.db.fail({
            target: 'whatsapp_messages.insert',
            match: (a) => JSON.stringify(a.payload ?? null).includes('"role":"system"'),
            error: { code: 'P0002' },
        });
        const answers: number[] = [];
        for (let i = 0; i < 8; i++) answers.push(await deliver(body));
        expect(answers).toEqual([503, 503, 503, 503, 503, 503, 503, 200]);
        expect(h.db.userRows()).toEqual([]);
        expect(noteTexts()).toEqual(['Customer shared contact info — phone tersimpan: 620000007777']);
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
        expect(details('webhook_error')[0]).toBe('RpcNetworkError — Supabase tidak terjangkau atau sedang gangguan (1 dari 1 item)');
    });

    it('a BSUID move the database completed counts as progress: a text cut off after it is alerted as webhook_deferred, not as a silent database', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.pindah-lama' });
        h.db.clockStep = (target) => (target === 'whatsapp_chats.update' ? 7_990 : 0);
        h.db.hang = (target) => target === 'rpc:wa_ingest_inbound';
        const body = delivery(
            [{ field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.pindah-lama', current: 'ID.pindah-baru' } }] } }],
            [change({ contacts: [contactOf(B)], messages: [textMsg(B, 'wamid.setelah-pindah', 'halo')] })],
        );
        expect(await deliver(body)).toBe(503);
        expect(h.db.chat(A)!.bsuid).toBe('ID.pindah-baru');
        expect(h.db.events().map((e) => e.kind)).toEqual(['webhook_deferred']);
    });

    it('a BSUID move the database refused (23505: another chat holds the new id) is an answer too: a text cut off after it is webhook_deferred', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.tolak-lama' });
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: '23505' } });
        h.db.clockStep = (target) => (target === 'whatsapp_chats.update' ? 7_990 : 0);
        h.db.hang = (target) => target === 'rpc:wa_ingest_inbound';
        const body = delivery(
            [{ field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.tolak-lama', current: 'ID.tolak-baru' } }] } }],
            [change({ contacts: [contactOf(B)], messages: [textMsg(B, 'wamid.setelah-tolak', 'halo')] })],
        );
        expect(await deliver(body)).toBe(503);
        expect(h.db.chat(A)!.bsuid).toBe('ID.tolak-lama');
        expect(h.db.events().map((e) => e.kind)).toEqual(['webhook_deferred']);
    });

    it('the batch line is logged before the alert write, and its ms= leaves that write out', async () => {
        h.db.fail({ target: 'rpc:wa_ingest_inbound', error: { code: '40001' } });
        // The alert write takes 5 s.
        h.db.clockStep = (target) => (target === 'rpc:record_ops_event' ? 5_000 : 0);
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.ms', 'halo')] })]))).toBe(503);
        expect(h.db.events().map((e) => e.kind)).toEqual(['webhook_error']);
        expect(batchLines()).toHaveLength(1);
        expect(batchLines()[0]).toMatch(/ ms=\d{1,3} http=503$/);
    });

    it('a Flow whose answers cannot be read is stored as a placeholder with an alert, never dropped silently', async () => {
        vi.mocked(handleFlowReply).mockImplementationOnce(async () => ({ status: 'unreadable' }));
        const flow = {
            from: A,
            id: 'wamid.flow-tak-terbaca',
            timestamp: metaTs(),
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"nama_pic":"Bud' } },
        };
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [flow] })]))).toBe(200);
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.metadata])).toEqual([['wamid.flow-tak-terbaca', { unprocessable: 'interactive' }]]);
        expect(details('webhook_payload_invalid')).toEqual(['pesan "interactive": kiriman form tidak terbaca; disimpan sebagai pengganti']);
    });

    it("a Flow whose own insert fails in the harness answers 503 as in production (the test double honours its insert's answer)", async () => {
        const flow = {
            from: A,
            id: 'wamid.flow-gerbang-harness',
            timestamp: metaTs(),
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"nama_pic":"Budi Palsu"}' } },
        };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [flow] })]);
        h.db.fail({ target: 'whatsapp_messages.insert', match: (a) => JSON.stringify(a.payload ?? null).includes('"role":"user"'), error: { code: '57014' } });
        expect(await deliver(body)).toBe(503);
        expect(h.db.userRows()).toEqual([]);
        expect(await deliver(body)).toBe(200);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.flow-gerbang-harness']);
        expect(vi.mocked(handleFlowReply)).toHaveBeenCalledTimes(2);
    });
});

describe('pins the review of the final-review fixes asked for (2026-10-31)', () => {
    it('the batch line is written while the alert write still hangs', async () => {
        h.db.fail({ target: 'rpc:wa_ingest_inbound', error: { code: '40001' } });
        h.db.hang = (target) => target === 'rpc:record_ops_event';
        const pending = POST(signedPost(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.urutan', 'halo')] })])));
        for (let i = 0; i < 500 && batchLines().length === 0; i++) await macrotask();
        expect(batchLines()).toEqual([expect.stringMatching(/ retryable=1 .* http=503$/)]);
        // The alert's detail is in the log before its write returns.
        expect(h.logs.map((l) => String(l[0]))).toContain('Webhook alert webhook_error: database 40001 — bentrok transaksi, aman bila jarang (1 dari 1 item)');
        expect(h.db.events()).toEqual([]);
        h.db.release();
        expect((await pending).status).toBe(503);
        expect(h.db.events().map((e) => e.kind)).toEqual(['webhook_error']);
    });

    it('a contact-card note whose write throws (a bug, not a database answer) is alerted by its own name, never as a Supabase outage, and never counts', async () => {
        const card = {
            from: A,
            id: 'wamid.kartu-bug',
            timestamp: metaTs(),
            type: 'contacts',
            contacts: [{ name: { formatted_name: 'Teman Palsu' }, phones: [{ phone: '+62 800-0000-7778', wa_id: '620000007778' }] }],
        };
        h.db.fail({
            target: 'whatsapp_messages.insert',
            match: (a) => JSON.stringify(a.payload ?? null).includes('"role":"system"'),
            throws: new TypeError('x is not a function'),
        });
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [card] })]))).toBe(503);
        expect(details('webhook_error')).toEqual(['TypeError (1 dari 1 item)']);
        expect(poisonCount('wamid.kartu-bug')).toBe(0);
    });

    it('user_id_update entries that are not objects are counted and skipped with one alert', async () => {
        const body = delivery([{ field: 'user_id_update', value: { user_id_update: ['ID.bukan-objek', null] } }]);
        expect(await deliver(body)).toBe(200);
        expect(details('webhook_payload_invalid')).toEqual(['2 user_id_update tanpa isi terbaca; dilewati']);
        expect(batchLines()[0]).toMatch(/^Webhook batch: items=2 .* skipped=2 /);
    });

    it('a placeholder already stored is only a duplicate when a resend gets past a failed pre-dedup: no second alert', async () => {
        const flow = {
            from: A,
            id: 'wamid.flow-dua-kali',
            timestamp: metaTs(),
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"nama_pic":"Bud' } },
        };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [flow] })]);
        expect(await deliver(body)).toBe(200);
        h.db.fail({ target: 'whatsapp_messages.select', error: { code: '57014' } }); // the resend's pre-dedup
        expect(await deliver(body)).toBe(200);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.flow-dua-kali']);
        expect(details('webhook_payload_invalid')).toEqual(['pesan "interactive": kiriman form tidak terbaca; disimpan sebagai pengganti']);
        expect(batchLines()[1]).toContain(' duplicate=1 ');
    });

    it('a bug in the Flow handling before its gate answers 503 and is never counted (D24); the resend stores the submission', async () => {
        vi.mocked(handleFlowReply).mockImplementationOnce(async () => {
            throw new TypeError('x is not a function');
        });
        const flow = {
            from: A,
            id: 'wamid.flow-bug',
            timestamp: metaTs(),
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"nama_pic":"Budi Palsu"}' } },
        };
        const body = delivery([change({ contacts: [contactOf(A)], messages: [flow] })]);
        expect(await deliver(body)).toBe(503);
        expect(details('webhook_error')).toEqual(['TypeError (1 dari 1 item)']);
        expect(h.db.userRows()).toEqual([]);
        expect(poisonCount('wamid.flow-bug')).toBe(0);
        expect(await deliver(body)).toBe(200);
        expect(h.db.userRows().map((m) => [m.wa_message_id, m.metadata])).toEqual([['wamid.flow-bug', {}]]);
    });

    it('the RPC refusing its own parameters (22023: only a bug of this code trips it) answers 503 without a placeholder (D24); once fixed the text is stored with its content', async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.parameter', 'tolong dibalas')] })]);
        h.db.fail({ target: 'rpc:wa_ingest_inbound', error: { code: '22023' }, status: 400, times: POISON_LIMIT + 1 });
        const answers: number[] = [];
        for (let i = 0; i < POISON_LIMIT + 2; i++) answers.push(await deliver(body));
        expect(answers).toEqual([...Array(POISON_LIMIT + 1).fill(503), 200]);
        expect(details('webhook_error')[0]).toBe(
            'database 22023 — parameter fungsi database ditolak: bug kode, periksa deploy terakhir (1 dari 1 item)',
        );
        expect(h.db.events('webhook_payload_invalid')).toEqual([]);
        expect(h.db.userRows().map((m) => [m.content, m.metadata])).toEqual([['tolong dibalas', {}]]);
    });

    it("an HTTP 403 without a code on one message's own call is about that request (the org read passed with the same key): it counts, with a hint that does not blame the key", async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.ditolak', 'halo')] })]);
        const notPlaceholder = (a: Record<string, unknown>) => !(a.p_metadata as Record<string, unknown>).unprocessable;
        h.db.fail({ target: 'rpc:wa_ingest_inbound', match: notPlaceholder, error: { code: '', message: '<html>403 Forbidden</html>' }, status: 403, times: Infinity });
        const answers: number[] = [];
        for (let i = 0; i < POISON_LIMIT; i++) answers.push(await deliver(body));
        expect(answers).toEqual([...Array(POISON_LIMIT - 1).fill(503), 200]);
        expect(details('webhook_error')[0]).toBe(
            'RpcHttp403 — gateway Supabase menolak permintaan ini (HTTP 403); kunci dan alamat berlaku (1 dari 1 item)',
        );
        expect(h.db.userRows().map((m) => m.metadata)).toEqual([{ unprocessable: 'text' }]);
    });
});
