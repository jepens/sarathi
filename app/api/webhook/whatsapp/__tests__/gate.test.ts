import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { makeFakeSupabase, type FakeCall, type FakeSupabase } from '@/lib/whatsapp/__tests__/fakeSupabase';

// The webhook gate (Fase 2 task 2.2a, phase 0): the signature is checked with
// the real verifier over the raw bytes before anything reads the payload; a
// signed body that is not JSON, not an object or not a WhatsApp event is
// acknowledged (200) without touching the database; events of another number
// of the WABA are dropped and alerted with a hash of the id (within the hour
// for a number not reported in the last 7 days), or in process mode stored
// without AI (shown like any inbound message, marked for the AI history, with
// a note for the operators that keeps the chat unanswered; a Flow submission
// or a contact card stored as a summary); a user_id_update applies whichever number reported
// it; status updates are scoped to the org; no service-role key, no usable
// number id or an unreadable default org never lead to a write under the
// wrong org; env values are trimmed. Since 2.2a part 2 a message is stored by
// one wa_ingest_inbound call and statuses by wa_apply_statuses (migration
// 0072): the fake answers them as the database would, and what the
// functions do inside is pinned by pgTAP 220. Fake ids, phones and secrets only.

const SECRET = 'test-app-secret';
const PNID = '100000000000001'; // the env number
const OTHER = '100000000000002'; // another number of the same WABA
const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';

const h = vi.hoisted(() => ({
    fake: null as unknown as FakeSupabase,
    defaultOrg: vi.fn(),
    /** The next wa_ingest_inbound results (fields over a 'new' row), one per call. */
    ingestReplies: [] as Array<Record<string, unknown>>,
    /** wa_ingest_inbound fails with this (thrown), when set. */
    ingestFailure: null as unknown,
    logs: [] as unknown[][],
    /** Whether the ops_events lookup finds an earlier report of the number. */
    opsSeen: true,
    /** The ops_events lookup answers with an error. */
    opsLookupError: false,
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => h.fake.client) }));
vi.mock('@/lib/settings/org-context', () => ({ getDefaultOrgIdStrict: h.defaultOrg }));
vi.mock('@/lib/settings/app-settings', () => ({ checkVerifyToken: vi.fn() }));
vi.mock('@/lib/whatsapp/client', () => ({ downloadWhatsAppMedia: vi.fn(), sendWhatsAppMessage: vi.fn() }));
vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: vi.fn(async () => {}) }));
vi.mock('@/lib/whatsapp/queue-db', () => ({
    processQueue: vi.fn(async () => {}),
    getDebounceSeconds: () => 0,
}));
vi.mock('@/lib/quota/org-quota', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/quota/org-quota')>()),
    consumeOrgQuota: vi.fn(async () => ({ allowed: true, used: 1, refused: 0, limit: 30 })),
}));
vi.mock('@/lib/whatsapp/recipient', () => ({ resolveSendTarget: vi.fn() }));
vi.mock('@/lib/whatsapp/history', () => ({ logSystemMessage: vi.fn(async () => ({ status: 'stored' })) }));
vi.mock('@/lib/whatsapp/flow-response', () => ({ handleFlowReply: vi.fn(async () => ({ status: 'handled' })) }));
vi.mock('@/lib/utils/logger', async (importOriginal) => {
    const record = (...args: unknown[]) => void h.logs.push(args);
    // Keep redactPII (the ops event writer uses it); record the log lines.
    return {
        ...(await importOriginal<typeof import('@/lib/utils/logger')>()),
        whatsappLogger: { info: record, warn: record, error: record, debug: record },
    };
});

import { createClient } from '@supabase/supabase-js';
import { resetOpsEventThrottle } from '@/lib/ops/events';
import { resetOtherNumberState } from '@/lib/whatsapp/other-number';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { handleFlowReply } from '@/lib/whatsapp/flow-response';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { settleBackground } from '@/lib/whatsapp/webhook/background';
import { resetPoison } from '@/lib/whatsapp/webhook/outcome';
import { POST } from '@/app/api/webhook/whatsapp/route';

function post(raw: string | Uint8Array, signature: 'sign' | 'none' | string = 'sign', secret = SECRET): Request {
    const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature === 'sign') {
        headers['x-hub-signature-256'] = `sha256=${crypto.createHmac('sha256', secret).update(bytes).digest('hex')}`;
    } else if (signature !== 'none') {
        headers['x-hub-signature-256'] = signature;
    }
    return new Request('http://localhost/api/webhook/whatsapp', { method: 'POST', headers, body: bytes });
}

let seq = 0;

function textEvent(phoneNumberId = PNID, display?: string): { raw: string; wamid: string } {
    seq += 1;
    const wamid = `wamid.fake-gate-${seq}`;
    const body = {
        object: 'whatsapp_business_account',
        entry: [{
            id: 'waba-palsu',
            changes: [{
                field: 'messages',
                value: {
                    metadata: { phone_number_id: phoneNumberId, ...(display ? { display_phone_number: display } : {}) },
                    contacts: [{ wa_id: PHONE }],
                    messages: [{ from: PHONE, id: wamid, type: 'text', text: { body: 'halo, masih buka?' } }],
                },
            }],
        }],
    };
    return { raw: JSON.stringify(body), wamid };
}

function flowEvent(phoneNumberId = PNID): { raw: string; wamid: string } {
    seq += 1;
    const wamid = `wamid.fake-flow-${seq}`;
    const body = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ wa_id: PHONE }],
            messages: [{
                from: PHONE,
                id: wamid,
                type: 'interactive',
                interactive: { type: 'nfm_reply', nfm_reply: {
                    name: 'flow',
                    body: 'Sent',
                    response_json: JSON.stringify({ flow_token: 'token-palsu', nama: 'Budi Palsu', jumlah_peserta: 40 }),
                } },
            }],
        } }] }],
    };
    return { raw: JSON.stringify(body), wamid };
}

const touched = (table: string) => h.fake.calls.filter((c: FakeCall) => c.table === table);
// Writes only: the batch's pre-dedup reads whatsapp_messages before anything is stored.
const written = (table: string) => touched(table).filter((c) => c.op !== 'select');
// The messages stored through wa_ingest_inbound, as their parameters.
const ingests = () =>
    h.fake.rpcCalls.filter((c) => c.name === 'wa_ingest_inbound').map((c) => c.args as Record<string, unknown>);
// The messages handed to the AI queue (the function queues them in the same transaction).
const aiQueued = () => ingests().filter((a) => a.p_ai_eligible === true);

/** wa_ingest_inbound's result row: 'new' (queued when AI-eligible), unless a test set the next reply. */
function ingestReply(args: Record<string, unknown>) {
    if (h.ingestFailure) return Promise.reject(h.ingestFailure);
    return {
        data: [{
            outcome: 'new',
            contact_key: args.p_from ?? args.p_bsuid,
            message_id: '00000000-0000-4000-8000-000000000001',
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
            ...(h.ingestReplies.shift() ?? {}),
        }],
        error: null,
    };
}
// Ops events go through the record_ops_event RPC (0070).
const opsEvents = () =>
    h.fake.rpcCalls
        .filter((c) => c.name === 'record_ops_event')
        .map((c) => c.args as { p_kind: string; p_org: string | null; p_detail: string });
const opsKinds = () => opsEvents().map((e) => e.p_kind);

beforeEach(() => {
    vi.clearAllMocks();
    resetOpsEventThrottle();
    resetOtherNumberState();
    h.logs = [];
    h.opsSeen = true;
    h.opsLookupError = false;
    h.ingestReplies = [];
    h.ingestFailure = null;
    resetPoison();
    h.fake = makeFakeSupabase({
        resolve: (c) => {
            if (c.table === 'whatsapp_chats' && c.op === 'select') return { data: { ai_enabled: true, contact_name: null }, error: null };
            if (c.table === 'ops_events' && c.op === 'select') {
                if (h.opsLookupError) return { data: null, error: { code: '57014' } };
                return { data: h.opsSeen ? [{ id: 1 }] : [], error: null };
            }
            return { data: null, error: null };
        },
        rpc: (name, args) => {
            if (name === 'wa_ingest_inbound') return ingestReply(args as Record<string, unknown>);
            if (name === 'wa_apply_statuses') {
                return { data: [{ applied: 1, stale: 0, unknown: 0, unknown_ids: [], bsuid_filled: 0, bsuid_conflicts: 0 }], error: null };
            }
            return { data: [], error: null };
        },
    });
    h.defaultOrg.mockResolvedValue(ORG);
    vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', PNID);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token-palsu');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
});

afterEach(async () => {
    // Pushes and notes run after the answer: let them finish inside their test.
    await settleBackground();
    vi.unstubAllEnvs();
});

describe('webhook gate: the signature comes first', () => {
    it('refuses a missing, wrong or stale signature with 403, before the payload is read', async () => {
        const { raw } = textEvent();
        expect((await POST(post(raw, 'none'))).status).toBe(403);
        expect((await POST(post(raw, 'sign', 'another-secret'))).status).toBe(403);
        const signedThenChanged = post(raw.replace('halo', 'HALO'), `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`);
        expect((await POST(signedThenChanged)).status).toBe(403);

        // Nothing read the payload, no org was resolved, nothing stored or queued.
        expect(h.fake.calls).toEqual([]);
        expect(h.defaultOrg).not.toHaveBeenCalled();
        expect(ingests()).toEqual([]);
        expect(h.logs.some((l) => String(l[0]).startsWith('Webhook received'))).toBe(false);
        const logged = JSON.stringify(h.logs);
        for (const secret of [PHONE, PNID, 'halo, masih buka?']) expect(logged).not.toContain(secret);
        // A signature that does not match is alerted; a request without the
        // header (internet noise: Meta always signs) is only logged.
        expect(opsEvents().map((e) => e.p_detail)).toEqual(['tanda tangan tidak cocok', 'tanda tangan tidak cocok']);
    });

    it('refuses a body over 3 MB with 413 before reading it, by declared length or while streaming', async () => {
        const chunk = new Uint8Array(1024 * 1024);
        // A declared length over 3 MB: the body is never read at all.
        let declaredPulls = 0;
        const declaredBody = new ReadableStream<Uint8Array>({
            pull(controller) {
                declaredPulls += 1;
                controller.enqueue(chunk);
            },
        });
        const big = new Request('http://localhost/api/webhook/whatsapp', {
            method: 'POST',
            headers: { 'content-length': String(3 * 1024 * 1024 + 1), 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
            body: declaredBody,
            duplex: 'half',
        } as RequestInit);
        expect((await POST(big)).status).toBe(413);
        expect(declaredPulls).toBeLessThanOrEqual(1); // the stream's own start-up pull at most

        // No declared length: the read stops, and the stream is cancelled, past 3 MB.
        let pulled = 0;
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                if (pulled > 50) controller.close();
                else controller.enqueue(chunk);
            },
            cancel() {
                cancelled = true;
            },
        });
        const chunked = new Request('http://localhost/api/webhook/whatsapp', {
            method: 'POST',
            body: stream,
            duplex: 'half',
        } as RequestInit);
        expect((await POST(chunked)).status).toBe(413);
        expect(cancelled).toBe(true);
        expect(pulled).toBeLessThan(10);
        expect(h.fake.calls).toEqual([]);
        expect(opsEvents()).toEqual([]);
    });

    it('checks the HMAC over the raw bytes, not over a decoded and re-encoded string', async () => {
        // A byte that is not valid UTF-8: text() + re-encoding would turn it
        // into U+FFFD and the signature Meta made over the bytes would fail.
        const raw = Buffer.concat([
            Buffer.from('{"object":"whatsapp_business_account","entry":[],"catatan":"'),
            Buffer.from([0xff]),
            Buffer.from('"}'),
        ]);
        expect((await POST(post(raw))).status).toBe(200);
    });
});

describe('webhook gate: signed bodies that are not WhatsApp events', () => {
    it('acknowledges a body that is not JSON or not an object with 200, without the database', async () => {
        for (const raw of ['bukan json', 'null', '"teks"', '42']) {
            expect((await POST(post(raw))).status).toBe(200);
        }
        expect(createClient).not.toHaveBeenCalled();
    });

    it('acknowledges another object type with 200 (a 404 made Meta retry for days)', async () => {
        const res = await POST(post(JSON.stringify({ object: 'page', entry: [] })));
        expect(res.status).toBe(200);
        expect(h.fake.calls).toEqual([]);
    });
});

describe('webhook gate: one-number routing', () => {
    it('drops an event of another number of the WABA and alerts with a hash of the id, never the id', async () => {
        const { raw } = textEvent(OTHER);
        const res = await POST(post(raw));
        expect(res.status).toBe(200);

        expect(ingests()).toEqual([]);
        expect(touched('whatsapp_messages')).toEqual([]);
        expect(touched('whatsapp_chats')).toEqual([]);
        expect(h.defaultOrg).not.toHaveBeenCalled();
        expect(opsKinds()).toEqual(['webhook_unrouted']); // a number reported before: daily only
        expect(opsEvents()[0].p_detail).toMatch(/^phone_number_id h[0-9a-f]{10}; dibuang$/);
        expect(JSON.stringify(h.logs)).not.toContain(OTHER);
    });

    it('a number not reported in the last 7 days is alerted within the hour (webhook_unrouted_new), looked up once per process', async () => {
        h.opsSeen = false;
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        expect(opsKinds()).toEqual(['webhook_unrouted_new', 'webhook_unrouted']);
        expect(opsEvents()[0].p_detail).toBe(opsEvents()[1].p_detail);
        const [lookup] = touched('ops_events');
        expect(lookup.op).toBe('select');
        expect(lookup.filters).toEqual([
            ['eq', 'kind', 'webhook_unrouted'],
            ['like', 'detail', expect.stringMatching(/^phone_number_id h[0-9a-f]{10};%$/)],
            ['gte', 'minute', expect.any(String)],
        ]);
        // The next event of the same number: no second lookup, no second "new" alert.
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        expect(touched('ops_events')).toHaveLength(1);
        expect(opsKinds()).toEqual(['webhook_unrouted_new', 'webhook_unrouted', 'webhook_unrouted']);
    });

    it("names the last four digits of the other number's display number, never the whole number or its id", async () => {
        expect((await POST(post(textEvent(OTHER, '+62 812-0000-1234').raw))).status).toBe(200);
        expect(opsEvents()[0].p_detail).toMatch(/^phone_number_id h[0-9a-f]{10}; nomor berakhiran 1234; dibuang$/);
        const recorded = JSON.stringify([opsEvents(), h.logs]);
        expect(recorded).not.toContain('6281200001234');
        expect(recorded).not.toContain(OTHER);
    });

    it("WHATSAPP_OTHER_NUMBER_EVENTS=process stores another number's message without AI or any send, shown like any inbound message, marked for the AI history, with a note", async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', ' Process ');
        const { raw, wamid } = textEvent(OTHER, '+62 812-0000-1234');
        expect((await POST(post(raw))).status).toBe(200);
        await settleBackground();
        // One wa_ingest_inbound call stores it, unread, with the chat summary
        // (last_inbound_at = last_message_at, from one time: pgTAP 220), as
        // for any inbound message: "Belum dibalas", the in-app notifier (the
        // note explains the 24-hour marker).
        const [stored] = ingests();
        expect(stored).toMatchObject({
            p_org: ORG,
            p_from: PHONE,
            p_wamid: wamid,
            p_content: 'halo, masih buka?',
            p_preview: 'halo, masih buka?',
            p_unread: true,
        });
        const ref = (stored.p_metadata as { other_number: string }).other_number;
        expect(ref).toMatch(/^h[0-9a-f]{10}$/);
        expect(stored).toMatchObject({ p_ai_eligible: false, p_queue_text: null });
        expect(aiQueued()).toEqual([]);
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
        // Its own rate-limit bucket ('<org>:other:<key>' in the function), apart
        // from the customer's on the main number.
        expect(stored).toMatchObject({ p_rate_scope: 'other', p_rate_max: 10 });
        // The note keeps the chat unanswered.
        expect(logSystemMessage).toHaveBeenCalledWith(ORG, PHONE, expect.stringContaining('nomor berakhiran 1234'), { touchChat: false });
        expect(opsKinds()).toEqual(['webhook_unrouted']);
        expect(opsEvents()[0].p_detail).toBe(
            `phone_number_id ${ref}; nomor berakhiran 1234; diproses tanpa AI, pesan disimpan di inbox (WHATSAPP_OTHER_NUMBER_EVENTS=process)`,
        );
    });

    it('the note for the operators comes once a day per chat, not with every message', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        await settleBackground();
        expect(ingests()).toHaveLength(2);
        expect(logSystemMessage).toHaveBeenCalledTimes(1);
    });

    it('over its own rate limit a message to another number is neither stored nor answered; the chat gets a note once a minute', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        // The function refuses both and stores nothing; only the first refusal
        // of the window carries rate_first (D23-1).
        h.ingestReplies.push(
            { outcome: 'rate_limited', rate_first: true, message_id: null, queue_outcome: null },
            { outcome: 'rate_limited', rate_first: false, message_id: null, queue_outcome: null },
        );
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        await settleBackground();
        expect(ingests().map((a) => a.p_rate_scope)).toEqual(['other', 'other']);
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(written('whatsapp_messages')).toEqual([]);
        expect(written('whatsapp_chats')).toEqual([]);
        expect(sendPushToOrg).not.toHaveBeenCalled();
        expect(logSystemMessage).toHaveBeenCalledTimes(1);
        expect(logSystemMessage).toHaveBeenCalledWith(ORG, PHONE, expect.stringContaining('melebihi batas per menit'), { touchChat: false });
    });

    it('process mode stores a Flow submission to another number as a summary of its answers: no Brief Acara handling, no send', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        const { raw, wamid } = flowEvent(OTHER);
        expect((await POST(post(raw))).status).toBe(200);
        await settleBackground();
        expect(handleFlowReply).not.toHaveBeenCalled();
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
        // Stored with its chat summary (last_inbound_at) and unread count by the function.
        expect(ingests()).toEqual([
            expect.objectContaining({
                p_org: ORG,
                p_wamid: wamid,
                p_content: '📋 Form WhatsApp dikirim\nnama: Budi Palsu\njumlah_peserta: 40',
                p_preview: '📋 Mengisi form WhatsApp',
                p_metadata: { other_number: expect.stringMatching(/^h[0-9a-f]{10}$/) },
                p_unread: true,
                p_ai_eligible: false,
            }),
        ]);
        expect(logSystemMessage).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logSystemMessage).mock.calls[0][3]).toEqual({ touchChat: false });
        expect(sendPushToOrg).toHaveBeenCalledWith(expect.anything(), ORG, expect.objectContaining({ body: '📋 Mengisi form WhatsApp', phone: PHONE }));
    });

    it('a redelivered Flow submission to another number is not stored, noted or pushed twice', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        // The function's redelivery gate: nothing written, no unread (pgTAP 220).
        h.ingestReplies.push({ outcome: 'duplicate', queue_outcome: null });
        expect((await POST(post(flowEvent(OTHER).raw))).status).toBe(200);
        await settleBackground();
        expect(logSystemMessage).not.toHaveBeenCalled();
        expect(sendPushToOrg).not.toHaveBeenCalled();
    });

    it('process mode stores a contact card sent to another number as a summary, without taking its phone as verified_phone', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        seq += 1;
        const wamid = `wamid.fake-card-${seq}`;
        const body = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: {
                metadata: { phone_number_id: OTHER },
                contacts: [{ wa_id: PHONE }],
                messages: [{
                    from: PHONE,
                    id: wamid,
                    type: 'contacts',
                    contacts: [{ name: { formatted_name: 'Teman Palsu' }, phones: [{ phone: '+62 800-0000-0099', wa_id: '6280000000099' }] }],
                }],
            } }] }],
        };
        expect((await POST(post(JSON.stringify(body)))).status).toBe(200);
        const [stored] = ingests();
        expect(stored).toMatchObject({
            p_wamid: wamid,
            p_content: '👤 Kartu kontak dibagikan\nTeman Palsu: +62 800-0000-0099',
            p_preview: '👤 Kartu kontak',
            p_metadata: { other_number: expect.stringMatching(/^h[0-9a-f]{10}$/) },
        });
        expect(stored.p_verified_phone).toBe(PHONE); // the sender's own number, never the shared card's
    });

    it('concurrent deliveries of a new number wait for one lookup and alert it once', async () => {
        h.opsSeen = false;
        const results = await Promise.all([POST(post(textEvent(OTHER).raw)), POST(post(textEvent(OTHER).raw))]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(touched('ops_events')).toHaveLength(1);
        expect(opsKinds().filter((k) => k === 'webhook_unrouted_new')).toHaveLength(1);
        expect(opsKinds().filter((k) => k === 'webhook_unrouted')).toHaveLength(2);
    });

    it('a failed lookup is alerted within the hour too (its own event would make the number look known later)', async () => {
        h.opsLookupError = true;
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        expect(opsKinds()).toEqual(['webhook_unrouted_new', 'webhook_unrouted']);
        expect(opsEvents()[0].p_detail).toMatch(/; riwayat 7 hari tidak terbaca$/);
        // The next event looks again, and finds the number (the first event's row).
        h.opsLookupError = false;
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        expect(touched('ops_events')).toHaveLength(2);
        expect(opsKinds()).toEqual(['webhook_unrouted_new', 'webhook_unrouted', 'webhook_unrouted']);
    });

    function otherEvent(type: string, extra: Record<string, unknown>): { raw: string; wamid: string } {
        seq += 1;
        const wamid = `wamid.fake-other-${seq}`;
        const body = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: {
                metadata: { phone_number_id: OTHER },
                contacts: [{ wa_id: PHONE }],
                messages: [{ from: PHONE, id: wamid, type, ...extra }],
            } }] }],
        };
        return { raw: JSON.stringify(body), wamid };
    }

    it.each([
        ['button', { button: { text: 'Ya, saya tertarik', payload: 'YA' } }, '🔘 Tombol: Ya, saya tertarik', '🔘 Tombol: Ya, saya tertarik'],
        ['interactive', { interactive: { type: 'list_reply', list_reply: { id: 'p2', title: 'Paket B' } } }, '🔘 Pilihan: Paket B', '🔘 Pilihan: Paket B'],
        // The address or coordinates stay in the message, not in the preview or the push.
        ['location', { location: { name: 'Kantor', latitude: -6.2, longitude: 106.8 } }, '📍 Lokasi: Kantor', '📍 Lokasi'],
        ['unsupported', {}, 'Pesan jenis "unsupported" (isinya tidak ditampilkan di Sarathi)', 'Pesan jenis "unsupported" (isinya tidak ditampilkan di Sarathi)'],
    ])('process mode keeps a %s message to another number as one readable line', async (type, extra, content, preview) => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        const { raw, wamid } = otherEvent(type, extra);
        expect((await POST(post(raw))).status).toBe(200);
        await settleBackground();
        const [stored] = ingests();
        expect(stored).toMatchObject({
            p_wamid: wamid,
            p_content: content,
            p_preview: preview,
            p_metadata: { other_number: expect.stringMatching(/^h[0-9a-f]{10}$/) },
            p_ai_eligible: false,
        });
        expect(sendPushToOrg).toHaveBeenCalledWith(expect.anything(), ORG, expect.objectContaining({ body: preview }));
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(handleFlowReply).not.toHaveBeenCalled();
    });

    it.each([
        ['system', { system: { type: 'user_changed_number', body: 'nomor berubah' } }],
        ['request_welcome', {}],
        ['reaction', { reaction: { message_id: 'wamid.x', emoji: '👍' } }],
        ['reaction', { reaction: { message_id: 'wamid.x', emoji: '' } }],
    ])('process mode only acknowledges a %s event for another number (the customer wrote nothing)', async (type, extra) => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        expect((await POST(post(otherEvent(type, extra).raw))).status).toBe(200);
        expect(touched('whatsapp_messages')).toEqual([]);
        expect(touched('whatsapp_chats')).toEqual([]);
        expect(ingests()).toEqual([]);
        expect(sendPushToOrg).not.toHaveBeenCalled();
        expect(logSystemMessage).not.toHaveBeenCalled();
    });

    it('over the contact\'s own rate limit, a non-text message to another number is not stored either (a note once a minute)', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        h.ingestReplies.push({ outcome: 'rate_limited', rate_first: true, message_id: null, queue_outcome: null });
        expect((await POST(post(otherEvent('button', { button: { text: 'Ya' } }).raw))).status).toBe(200);
        await settleBackground();
        expect(ingests()[0]).toMatchObject({ p_rate_scope: 'other', p_rate_max: 10 });
        expect(written('whatsapp_messages')).toEqual([]);
        expect(sendPushToOrg).not.toHaveBeenCalled();
        expect(logSystemMessage).toHaveBeenCalledWith(ORG, PHONE, expect.stringContaining('melebihi batas per menit'), { touchChat: false });
    });

    it('a location sent to its own number is stored as one summary line without AI (D23-4; part 1 only acknowledged it)', async () => {
        const body = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: {
                metadata: { phone_number_id: PNID },
                contacts: [{ wa_id: PHONE }],
                messages: [{ from: PHONE, id: 'wamid.fake-loc-own', type: 'location', location: { latitude: 1, longitude: 2 } }],
            } }] }],
        };
        expect((await POST(post(JSON.stringify(body)))).status).toBe(200);
        await settleBackground();
        expect(ingests()).toEqual([
            expect.objectContaining({
                p_wamid: 'wamid.fake-loc-own',
                p_content: '📍 Lokasi: 1, 2',
                p_preview: '📍 Lokasi',
                p_metadata: {},
                p_unread: true,
                p_rate_scope: 'main',
                p_ai_eligible: false,
            }),
        ]);
        expect(sendPushToOrg).toHaveBeenCalledWith(expect.anything(), ORG, expect.objectContaining({ body: '📍 Lokasi' }));
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('a Flow submission to its own number still gets the Brief Acara handling', async () => {
        expect((await POST(post(flowEvent(PNID).raw))).status).toBe(200);
        expect(handleFlowReply).toHaveBeenCalledTimes(1);
        expect(written('whatsapp_messages')).toEqual([]); // handleFlowReply (mocked) stores it
        expect(ingests()).toEqual([]);
    });

    it('an unrecognised WHATSAPP_OTHER_NUMBER_EVENTS value is treated as process (nothing is lost) and alerted', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'proses');
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        expect(ingests()).toHaveLength(1);
        expect(aiQueued()).toEqual([]);
        expect(opsKinds()).toEqual(['webhook_unconfigured', 'webhook_unrouted']);
        expect(opsEvents()[0].p_detail).toBe(
            'WHATSAPP_OTHER_NUMBER_EVENTS tidak dikenal ("proses"): diperlakukan sebagai process, pesan nomor lain disimpan tanpa AI',
        );
    });

    it.each([
        ['store', true],
        ["'process'", true],
        ['"drop"', false],
        ['DROP', false],
    ])('WHATSAPP_OTHER_NUMBER_EVENTS=%s is understood (stored: %s), without a configuration alert', async (value, stored) => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', value);
        expect((await POST(post(textEvent(OTHER).raw))).status).toBe(200);
        if (stored) expect(ingests()).toHaveLength(1);
        else expect(touched('whatsapp_messages')).toEqual([]);
        expect(opsKinds()).toEqual(['webhook_unrouted']);
    });

    it('a user_id_update reported with another number of the WABA is applied (a BSUID belongs to the business portfolio), not dropped', async () => {
        const body = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'user_id_update', value: {
                metadata: { phone_number_id: OTHER },
                user_id_update: [{ user_id: { previous: 'ID.lama', current: 'ID.baru' } }],
            } }] }],
        };
        expect((await POST(post(JSON.stringify(body)))).status).toBe(200);
        const update = touched('whatsapp_chats').find((c) => c.op === 'update')!;
        expect(update.filters).toEqual([
            ['eq', 'org_id', ORG],
            ['eq', 'bsuid', 'ID.lama'],
        ]);
        expect(opsKinds()).toEqual([]);
    });

    it('an event without metadata (user_id_update) is not taken for another number', async () => {
        const body = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'user_id_update', value: {
                user_id_update: [{ user_id: { previous: 'ID.lama', current: 'ID.baru' } }],
            } }] }],
        };
        expect((await POST(post(JSON.stringify(body)))).status).toBe(200);
        const update = touched('whatsapp_chats').find((c) => c.op === 'update')!;
        expect(update.filters).toEqual([
            ['eq', 'org_id', ORG],
            ['eq', 'bsuid', 'ID.lama'],
        ]);
        expect(opsKinds()).not.toContain('webhook_unrouted');
    });

    it('the media dedup pre-check is scoped to the org', async () => {
        const wamid = 'wamid.fake-media-1';
        const body = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: {
                metadata: { phone_number_id: PNID },
                contacts: [{ wa_id: PHONE }],
                messages: [{ from: PHONE, id: wamid, type: 'image', image: { id: 'media-1' } }],
            } }] }],
        };
        expect((await POST(post(JSON.stringify(body)))).status).toBe(200);
        await settleBackground();
        // The batch's pre-dedup (every key of the delivery in one query), then
        // the media handler's own check: both scoped to the org.
        expect(touched('whatsapp_messages').filter((c) => c.op === 'select').map((c) => c.filters)).toEqual([
            [['eq', 'org_id', ORG], ['in', 'wa_message_id', [wamid]]],
            [['eq', 'org_id', ORG], ['eq', 'wa_message_id', wamid]],
        ]);
    });

    it('processes an event of its own number', async () => {
        const { raw, wamid } = textEvent(PNID);
        expect((await POST(post(raw))).status).toBe(200);
        // Stored and queued for the AI by one wa_ingest_inbound call.
        expect(ingests()).toEqual([
            expect.objectContaining({
                p_org: ORG,
                p_from: PHONE,
                p_wamid: wamid,
                p_content: 'halo, masih buka?',
                p_metadata: {},
                p_rate_scope: 'main',
                p_rate_max: 10,
                p_ai_eligible: true,
                p_queue_text: 'halo, masih buka?',
                p_inbound_limit: 30,
            }),
        ]);
    });

    it('scopes a status update to the org', async () => {
        const body = {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: {
                metadata: { phone_number_id: PNID },
                statuses: [{ id: 'wamid.fake-out-1', status: 'delivered', recipient_id: PHONE }],
            } }] }],
        };
        expect((await POST(post(JSON.stringify(body)))).status).toBe(200);
        // One wa_apply_statuses call for the change, with the org (the
        // function updates only that org's 'assistant' rows: pgTAP 220).
        expect(h.fake.rpcCalls.filter((c) => c.name === 'wa_apply_statuses').map((c) => c.args)).toEqual([
            {
                p_org: ORG,
                p_statuses: [{
                    id: 'wamid.fake-out-1',
                    status: 'delivered',
                    ts: null,
                    error_code: null,
                    error_title: null,
                    error_detail: null,
                    recipient_id: PHONE,
                    recipient_user_id: null,
                }],
            },
        ]);
        expect(written('whatsapp_messages')).toEqual([]);
    });
});

describe('webhook gate: nothing is written under the wrong org', () => {
    it('answers 503 without the service-role key, never falling back to the anon key', async () => {
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
        const res = await POST(post(textEvent().raw));
        expect(res.status).toBe(503);
        expect(createClient).not.toHaveBeenCalled();
    });

    it('answers 503 when no number is configured, so Meta retries instead of the event being dropped, and alerts', async () => {
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '');
        const res = await POST(post(textEvent().raw));
        expect(res.status).toBe(503);
        expect(ingests()).toEqual([]);
        expect(touched('whatsapp_messages')).toEqual([]);
        expect(opsEvents()).toEqual([
            {
                p_kind: 'webhook_unconfigured',
                p_org: null,
                p_detail: 'WHATSAPP_PHONE_NUMBER_ID tidak diset di server; webhook menjawab 503, Meta mengirim ulang',
                p_count: 1,
            },
        ]);
    });

    it('a WHATSAPP_PHONE_NUMBER_ID that is not a number id answers 503 and says so', async () => {
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'nomor-utama');
        expect((await POST(post(textEvent().raw))).status).toBe(503);
        expect(ingests()).toEqual([]);
        expect(opsEvents()[0].p_detail).toBe(
            'WHATSAPP_PHONE_NUMBER_ID bukan ID nomor (harus angka saja); webhook menjawab 503, Meta mengirim ulang',
        );
    });

    it('a default org that cannot be read answers 503 (Meta retries) and stores nothing', async () => {
        h.defaultOrg.mockRejectedValue(new Error('platform setting default_org_id could not be read (57014)'));
        const res = await POST(post(textEvent().raw));
        expect(res.status).toBe(503);
        expect(h.defaultOrg).toHaveBeenCalledTimes(1); // read once per delivery
        expect(ingests()).toEqual([]);
        expect(touched('whatsapp_messages')).toEqual([]);
        expect(opsKinds()).toEqual(['webhook_error']);
        expect(opsEvents()[0].p_org).toBeNull();
    });
});

describe('webhook gate: env values are trimmed', () => {
    it("a WHATSAPP_PHONE_NUMBER_ID with a trailing CR, LF, tab or space still routes the app's own number", async () => {
        for (const tail of ['\r\n', '\n', '\t', ' ']) {
            vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', `${PNID}${tail}`);
            const { raw, wamid } = textEvent(PNID);
            expect((await POST(post(raw))).status).toBe(200);
            expect(ingests().at(-1)).toMatchObject({ p_org: ORG, p_from: PHONE, p_queue_text: 'halo, masih buka?', p_wamid: wamid });
        }
        expect(opsKinds()).toEqual([]);
    });

    it("an app secret with a trailing newline still verifies Meta's signature", async () => {
        vi.stubEnv('WHATSAPP_APP_SECRET', `${SECRET}\n`);
        expect((await POST(post(textEvent().raw))).status).toBe(200);
        expect(aiQueued()).toHaveLength(1);
    });
});

describe('webhook gate: alerts', () => {
    it('a failure after the signature passed is alerted as webhook_error with the org', async () => {
        // A retryable item failure: 503 (Meta resends), one alert for the batch.
        h.ingestFailure = new Error('ingest down');
        const res = await POST(post(textEvent().raw));
        expect(res.status).toBe(503);
        expect(opsEvents()).toEqual([{ p_kind: 'webhook_error', p_org: ORG, p_detail: 'Error (1 dari 1 item)', p_count: 1 }]);
    });

    it('the 403 says when the app secret is not set on the server', async () => {
        vi.stubEnv('WHATSAPP_APP_SECRET', '');
        expect((await POST(post(textEvent().raw))).status).toBe(403);
        expect(opsEvents()[0].p_detail).toBe('WHATSAPP_APP_SECRET tidak diset di server');
    });
});
