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
    signatureOf,
    signedPost,
    textMsg,
} from '@/lib/whatsapp/webhook/__tests__/wa-model';

// The executable pin matrix of part 1 (Fase 2 task 2.2a part 2; synthesis
// section 7, as amended by owner decisions D23-1..4 and C2_SPEC section 7):
// one named case per row, asserting what can be observed from outside the
// webhook: the HTTP answer, the alerts, what is written, what is sent. Each
// title starts with the row's status: Kept, Changed (with the decision) or
// Kept, extended. The same stateful model of the database as the contract
// harness (wa-model.ts); Meta, the AI, Web Push and the default org are
// stubbed. Fake ids, phones and texts only.

const h = vi.hoisted(() => ({
    db: null as unknown as WaModel,
    logs: [] as unknown[][],
    orgReads: 0,
    orgError: null as unknown,
    outSeq: 0,
    /** A log line starting with this throws (a bug outside the per-item guards). */
    throwOnLog: null as string | null,
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
    const record = (...args: unknown[]) => {
        if (h.throwOnLog !== null && String(args[0]).startsWith(h.throwOnLog)) throw new TypeError('log line could not be written');
        h.logs.push(args);
    };
    return {
        ...(await importOriginal<typeof import('@/lib/utils/logger')>()),
        whatsappLogger: { info: record, warn: record, error: record, debug: record },
    };
});

import { createClient } from '@supabase/supabase-js';
import { POST } from '@/app/api/webhook/whatsapp/route';
import { sendWhatsAppMessage, downloadWhatsAppMedia } from '@/lib/whatsapp/client';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { generateRAGResponse } from '@/lib/ai/rag';
import { handleFlowReply } from '@/lib/whatsapp/flow-response';
import { settleBackground } from '@/lib/whatsapp/webhook/background';
import { resetPoison } from '@/lib/whatsapp/webhook/outcome';
import { routeChanges } from '@/lib/whatsapp/webhook/router';
import { listChanges } from '@/lib/whatsapp/webhook/payload';
import { MAX_WEBHOOK_BYTES } from '@/lib/whatsapp/webhook/verify';
import {
    RATE_LIMIT_NOTE,
    RATE_LIMIT_WARNING,
    RATE_LIMIT_WARNING_FAILED_NOTE,
    lateMessageNotice,
    resetAfterIngestState,
} from '@/lib/whatsapp/webhook/after-ingest';
import { inboundQuotaNotice } from '@/lib/quota/org-quota';
import { resetOpsEventThrottle } from '@/lib/ops/events';
import { otherNumberLimitNotice, otherNumberNotice, otherNumberOf, resetOtherNumberState } from '@/lib/whatsapp/other-number';

const A = '620000000001';
const B = '620000000002';
const C = '620000000003';
const D = '620000000004';
const E = '620000000005';
const HOUR = 60 * 60 * 1000;
const URL = 'http://localhost/api/webhook/whatsapp';
const AI_REPLY = 'Balasan AI palsu';
const OTHER = otherNumberOf(OTHER_PNID, '+62 800-0000-1234');

let day = 0;

async function deliver(body: unknown): Promise<number> {
    return (await POST(signedPost(body))).status;
}

const settle = () => settleBackground();
const sends = () => vi.mocked(sendWhatsAppMessage).mock.calls;
const replies = () => sends().filter((c) => c[1] === AI_REPLY);
const warnings = () => sends().filter((c) => c[1] === RATE_LIMIT_WARNING);
const pushes = () => vi.mocked(sendPushToOrg).mock.calls.map((c) => c[2]);
const kinds = () => h.db.events().map((e) => e.kind);
const noteTexts = () => h.db.notes().map((n) => n.content);
const text = (from: string, id: string | null, body = `pesan ${id}`, extra: Record<string, unknown> = {}) => textMsg(from, id, body, extra);
const one = (message: unknown, phoneNumberId: string | null = PNID, contacts: unknown[] = [contactOf(A)]) =>
    delivery([change({ contacts, messages: [message] }, phoneNumberId)]);
/** The pre-dedup query fails once (the database function's own gate decides then). */
const failPrededup = () => h.db.fail({ target: 'whatsapp_messages.select', match: (a) => JSON.stringify(a.filters).includes('"in"') });

/** A signed non-WABA body of exactly `size` bytes, streamed in 64 KiB chunks without a declared length. */
function streamedOfSize(size: number): Request {
    const head = '{"object":"page","isi":"';
    const tail = '"}';
    const bytes = Buffer.from(head + 'x'.repeat(size - head.length - tail.length) + tail, 'utf8');
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.length) return controller.close();
            controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 65_536)));
            offset += 65_536;
        },
    });
    return new Request(URL, { method: 'POST', headers: { 'x-hub-signature-256': signatureOf(bytes) }, body: stream, duplex: 'half' } as RequestInit);
}

beforeEach(() => {
    day += 1;
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        now: Date.UTC(2026, 9, 1, 3, 0, 0) + day * 24 * HOUR,
    });
    vi.clearAllMocks();
    h.db = new WaModel();
    h.logs = [];
    h.orgReads = 0;
    h.orgError = null;
    h.outSeq = 0;
    h.throwOnLog = null;
    resetOpsEventThrottle();
    resetOtherNumberState();
    resetPoison();
    resetAfterIngestState();
    vi.mocked(sendWhatsAppMessage).mockReset().mockImplementation(async () => ({ waMessageId: `wamid.keluar-${++h.outSeq}`, raw: {} }));
    vi.mocked(downloadWhatsAppMedia).mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/webp', size: 3 });
    vi.mocked(sendPushToOrg).mockReset().mockResolvedValue(undefined);
    vi.mocked(generateRAGResponse).mockReset().mockResolvedValue({ message: AI_REPLY, sources: [] });
    vi.mocked(handleFlowReply).mockReset().mockImplementation(async (p) => {
        // Like the real one: its own insert of the submission is its gate.
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

describe('part-1 pin matrix (synthesis section 7, as amended by D23 and C2_SPEC section 7)', () => {
    it('P01 Kept: a body over 3 MB gets 413 by its declared length or while streaming, with no database and no alert; exactly 3 MB is still read', async () => {
        let pulls = 0;
        const declared = new Request(URL, {
            method: 'POST',
            headers: { 'content-length': String(MAX_WEBHOOK_BYTES + 1), 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
            body: new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulls += 1;
                    controller.enqueue(new Uint8Array(1024 * 1024));
                },
            }),
            duplex: 'half',
        } as RequestInit);
        expect((await POST(declared)).status).toBe(413);
        expect(pulls).toBeLessThanOrEqual(1); // the stream's own start-up pull at most
        expect((await POST(streamedOfSize(MAX_WEBHOOK_BYTES + 1))).status).toBe(413);
        expect(createClient).not.toHaveBeenCalled();
        // The limit is inclusive: exactly 3 MB is read, verified and answered.
        expect((await POST(streamedOfSize(MAX_WEBHOOK_BYTES))).status).toBe(200);
        expect(h.db.calls).toEqual([]);
    });

    it('P02 Kept: the HMAC over the raw bytes comes first: 403 before anything reads the payload, alerted only for a mismatch or an unset secret; invalid UTF-8 still verifies', async () => {
        const body = one(text(A, 'wamid.p02', 'halo, masih buka?'));
        const raw = JSON.stringify(body);
        expect((await POST(new Request(URL, { method: 'POST', body: raw }))).status).toBe(403); // no header: noise
        expect((await POST(signedPost(body, 'rahasia-lain'))).status).toBe(403);
        const signedThenChanged = new Request(URL, {
            method: 'POST',
            headers: { 'x-hub-signature-256': signatureOf(Buffer.from(raw)) },
            body: raw.replace('halo', 'HALO'),
        });
        expect((await POST(signedThenChanged)).status).toBe(403);
        vi.stubEnv('WHATSAPP_APP_SECRET', '');
        expect((await POST(signedPost(body))).status).toBe(403);
        expect(h.db.events().map((e) => [e.kind, e.detail])).toEqual([
            ['webhook_signature_invalid', 'tanda tangan tidak cocok'],
            ['webhook_signature_invalid', 'tanda tangan tidak cocok'],
            ['webhook_signature_invalid', 'WHATSAPP_APP_SECRET tidak diset di server'],
        ]);
        expect(h.db.calls.filter((c) => c.target !== 'rpc:record_ops_event')).toEqual([]);
        expect(h.orgReads).toBe(0);
        expect(h.logs.some((l) => String(l[0]).startsWith('Webhook received'))).toBe(false);
        vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
        const invalidUtf8 = Buffer.concat([
            Buffer.from('{"object":"whatsapp_business_account","entry":[],"catatan":"'),
            Buffer.from([0xff]),
            Buffer.from('"}'),
        ]);
        expect((await POST(signedPost(invalidUtf8))).status).toBe(200);
    });

    it('P03 Kept: a signed body that is not JSON or not an object gets 200 without a client; a signed non-WABA event 200 without the database', async () => {
        for (const raw of ['bukan json', 'null', '"teks"', '42']) expect((await POST(signedPost(raw))).status).toBe(200);
        expect(createClient).not.toHaveBeenCalled();
        expect((await POST(signedPost({ object: 'page', entry: [] }))).status).toBe(200);
        expect(h.db.calls).toEqual([]);
    });

    it('P04 Kept: without the service-role key the answer is 503 and createClient is never called (never the anon key)', async () => {
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
        expect(await deliver(one(text(A, 'wamid.p04')))).toBe(503);
        expect(createClient).not.toHaveBeenCalled();
    });

    it('P05 Kept: an unusable WHATSAPP_PHONE_NUMBER_ID answers 503 with one webhook_unconfigured, and nothing is routed; env values are trimmed', async () => {
        const body = one(text(A, 'wamid.p05'));
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '');
        expect(await deliver(body)).toBe(503);
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'nomor-utama');
        expect(await deliver(body)).toBe(503);
        expect(h.db.events()).toEqual([
            { kind: 'webhook_unconfigured', org: null, detail: 'WHATSAPP_PHONE_NUMBER_ID tidak diset di server; webhook menjawab 503, Meta mengirim ulang', count: 1 },
            { kind: 'webhook_unconfigured', org: null, detail: 'WHATSAPP_PHONE_NUMBER_ID bukan ID nomor (harus angka saja); webhook menjawab 503, Meta mengirim ulang', count: 1 },
        ]);
        expect(h.db.ingests()).toEqual([]);
        expect(h.orgReads).toBe(0);
        // The router refuses an empty number id itself: '' would make every event another number's (C1-EQ-2).
        await expect(routeChanges(h.db.client, { appSecret: SECRET, phoneNumberId: '' }, listChanges(body))).rejects.toThrow();
        // A pasted CR LF or newline is trimmed: the app's own number is still routed, the signature still verifies.
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', `${PNID}\r\n`);
        vi.stubEnv('WHATSAPP_APP_SECRET', `${SECRET}\n`);
        expect(await deliver(body)).toBe(200);
        expect(h.db.ingests()).toEqual([expect.objectContaining({ p_org: ORG, p_rate_scope: 'main', p_ai_eligible: true })]);
        expect(kinds()).toHaveLength(2);
    });

    it('P06 Changed (503 instead of 500, agreed 2.2a design): the default org is read strictly and once per delivery; unreadable, the answer is 503 with webhook_error without an org, and nothing is stored', async () => {
        h.orgError = Object.assign(new Error('platform setting default_org_id could not be read (57014)'), { name: 'PlatformSettingReadError', code: '57014' });
        const body = delivery([change({ contacts: [contactOf(A), contactOf(B)], messages: [text(A, 'wamid.p06-a'), text(B, 'wamid.p06-b')] })]);
        expect(await deliver(body)).toBe(503);
        expect(h.orgReads).toBe(1);
        expect(h.db.events()).toEqual([{ kind: 'webhook_error', org: null, detail: 'database 57014 — org default tidak terbaca, periksa Supabase (2 dari 2 item)', count: 1 }]);
        expect(h.db.ingests()).toEqual([]);
        expect(h.db.chats).toEqual([]);
        // Readable again: the resend is stored under the org.
        h.orgError = null;
        expect(await deliver(body)).toBe(200);
        expect(h.db.userRows().map((m) => m.org_id)).toEqual([ORG, ORG]);
    });

    it('P06b Kept (C2_SPEC section 7): a bug outside the per-item guards answers 500 with webhook_error for the org, and what was stored stays stored', async () => {
        h.throwOnLog = 'Webhook batch:';
        expect(await deliver(one(text(A, 'wamid.p06b')))).toBe(500);
        expect(h.db.events()).toEqual([{ kind: 'webhook_error', org: ORG, detail: 'TypeError', count: 1 }]);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.p06b']);
        // Meta resends: the stored message is a duplicate, the batch answers 200.
        h.throwOnLog = null;
        expect(await deliver(one(text(A, 'wamid.p06b')))).toBe(200);
        expect(h.db.ingests()).toHaveLength(1);
    });

    it("P07 Kept: drop mode by default, the org not read; webhook_unrouted_new within the hour for a number not reported in 7 days, one lookup per process, 'riwayat 7 hari tidak terbaca' when it fails, the last 4 digits only", async () => {
        expect(await deliver(one(text(A, 'wamid.p07-1'), OTHER_PNID))).toBe(200);
        expect(await deliver(one(text(A, 'wamid.p07-2'), OTHER_PNID))).toBe(200);
        expect(h.orgReads).toBe(0);
        expect(h.db.ingests()).toEqual([]);
        expect(h.db.chats).toEqual([]);
        expect(kinds()).toEqual(['webhook_unrouted_new', 'webhook_unrouted', 'webhook_unrouted']);
        expect(h.db.calls.filter((c) => c.target === 'ops_events.select')).toHaveLength(1);
        expect(h.db.events()[0].detail).toBe(`phone_number_id ${OTHER.ref}; nomor berakhiran 1234; dibuang`);
        expect(JSON.stringify([h.db.events(), h.logs])).not.toContain(OTHER_PNID);
        // A failed lookup is alerted within the hour too, saying so.
        resetOtherNumberState();
        h.db.fail({ target: 'ops_events.select', error: { code: '57014' } });
        expect(await deliver(one(text(A, 'wamid.p07-3'), OTHER_PNID))).toBe(200);
        expect(h.db.events().slice(-2).map((e) => [e.kind, e.detail])).toEqual([
            ['webhook_unrouted_new', `phone_number_id ${OTHER.ref}; nomor berakhiran 1234; dibuang; riwayat 7 hari tidak terbaca`],
            ['webhook_unrouted', `phone_number_id ${OTHER.ref}; nomor berakhiran 1234; dibuang`],
        ]);
    });

    it("P08 Kept (the alert now once per batch): WHATSAPP_OTHER_NUMBER_EVENTS ignores quotes, case and spaces, 'store' means process; an unknown value such as 'proses' is process and alerted", async () => {
        const cases: Array<[string, boolean]> = [[' Process ', true], ['store', true], ["'process'", true], ['"drop"', false], ['DROP', false]];
        for (const [i, [value, stored]] of cases.entries()) {
            vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', value);
            const before = h.db.userRows().length;
            expect(await deliver(one(text(A, `wamid.p08-${i}`), OTHER_PNID))).toBe(200);
            expect(h.db.userRows().length - before).toBe(stored ? 1 : 0);
        }
        expect(kinds().filter((k) => k === 'webhook_unconfigured')).toEqual([]);
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'proses');
        const two = delivery([
            change({ contacts: [contactOf(A)], messages: [text(A, 'wamid.p08-x')] }, OTHER_PNID),
            change({ contacts: [contactOf(B)], messages: [text(B, 'wamid.p08-y')] }, OTHER_PNID),
        ]);
        expect(await deliver(two)).toBe(200);
        expect(h.db.events('webhook_unconfigured').map((e) => e.detail)).toEqual([
            'WHATSAPP_OTHER_NUMBER_EVENTS tidak dikenal ("proses"): diperlakukan sebagai process, pesan nomor lain disimpan tanpa AI',
        ]);
        expect(h.db.ingests().slice(-2).map((a) => [a.p_wamid, a.p_ai_eligible])).toEqual([
            ['wamid.p08-x', false],
            ['wamid.p08-y', false],
        ]);
    });

    it('P09 Kept, extended (every change; a database error 503): user_id_update runs before the number gate, for any number, without metadata too, filtered exactly [eq org_id, eq bsuid], with no ops events', async () => {
        h.db.seedChat({ phone_number: A, bsuid: 'ID.a-lama' });
        h.db.seedChat({ phone_number: B, bsuid: 'ID.b-lama' });
        h.db.seedChat({ phone_number: C, bsuid: 'ID.c-lama' });
        h.db.seedChat({ org_id: OTHER_ORG, phone_number: A, bsuid: 'ID.a-lama' });
        const uid = (previous: string, current: string) => ({ user_id: { previous, current } });
        const body = delivery(
            [{ field: 'user_id_update', value: { metadata: { phone_number_id: OTHER_PNID }, user_id_update: [uid('ID.a-lama', 'ID.a-baru'), uid('ID.b-lama', 'ID.b-baru')] } }],
            [{ field: 'user_id_update', value: { user_id_update: [uid('ID.c-lama', 'ID.c-baru')] } }],
        );
        expect(await deliver(body)).toBe(200);
        const updates = h.db.calls.filter((c) => c.target === 'whatsapp_chats.update');
        expect(updates.map((u) => (u.filters ?? []).map((f) => [f.kind, f.column, f.value]))).toEqual([
            [['eq', 'org_id', ORG], ['eq', 'bsuid', 'ID.a-lama']],
            [['eq', 'org_id', ORG], ['eq', 'bsuid', 'ID.b-lama']],
            [['eq', 'org_id', ORG], ['eq', 'bsuid', 'ID.c-lama']],
        ]);
        expect(updates[0].payload).toEqual({ bsuid: 'ID.a-baru', updated_at: expect.any(String) });
        expect([h.db.chat(A)!.bsuid, h.db.chat(B)!.bsuid, h.db.chat(C)!.bsuid]).toEqual(['ID.a-baru', 'ID.b-baru', 'ID.c-baru']);
        expect(h.db.chat(A, OTHER_ORG)!.bsuid).toBe('ID.a-lama');
        expect(h.db.events()).toEqual([]);
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: '57014' } });
        expect(await deliver(delivery([{ field: 'user_id_update', value: { user_id_update: [uid('ID.c-baru', 'ID.c-lagi')] } }]))).toBe(503);
        expect(kinds()).toEqual(['webhook_error']);
    });

    it('P10 Kept: a store-only text is stored with other_number, no AI and no send, in its own <org>:other:<key> rate bucket, with equal stamps, unread, and a note once a day', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        expect(await deliver(one(text(A, 'wamid.p10-1', 'satu'), OTHER_PNID))).toBe(200);
        expect(await deliver(one(text(A, 'wamid.p10-2', 'dua'), OTHER_PNID))).toBe(200);
        await settle();
        expect(h.db.userRows().map((m) => m.metadata)).toEqual([{ other_number: OTHER.ref }, { other_number: OTHER.ref }]);
        expect(h.db.queue).toEqual([]);
        expect(sends()).toEqual([]);
        expect([...h.db.rateLimits.keys()]).toEqual([`${ORG}:other:${A}`]);
        expect(h.db.chat(A)).toMatchObject({ unread_count: 2, last_message: 'dua' });
        expect(h.db.chat(A)!.last_inbound_at).toBe(h.db.chat(A)!.last_message_at);
        expect(noteTexts()).toEqual([otherNumberNotice(OTHER)]);
        expect(pushes()).toHaveLength(2);
    });

    it("P11 Kept: over its own limit a store-only message is not stored; one 'melebihi batas' note, no warning from the main number", async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        const messages = Array.from({ length: 12 }, (_, i) => text(A, `wamid.p11-${i}`));
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages }, OTHER_PNID)]))).toBe(200);
        await settle();
        expect(h.db.userRows()).toHaveLength(10);
        expect(noteTexts()).toEqual([otherNumberNotice(OTHER), otherNumberLimitNotice(OTHER)]);
        expect(sends()).toEqual([]);
        expect(pushes()).toHaveLength(10);
    });

    it("P12 Kept: store-only Flow, card, button, list, location and unsupported become summaries; the card keeps the sender's phone; system, request_welcome and reaction are only acknowledged; a redelivery gets no note, unread or push", async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        const m = (id: string, type: string, extra: Record<string, unknown>) => ({ from: A, id, timestamp: metaTs(), type, ...extra });
        const body = delivery([
            change(
                {
                    contacts: [contactOf(A)],
                    messages: [
                        m('wamid.p12-1', 'interactive', { interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: '{"flow_token":"t","nama":"Budi Palsu"}' } } }),
                        m('wamid.p12-2', 'contacts', { contacts: [{ name: { formatted_name: 'Teman Palsu' }, phones: [{ phone: '+62 800-0000-0099', wa_id: '6280000000099' }] }] }),
                        m('wamid.p12-3', 'button', { button: { text: 'Ya', payload: 'YA' } }),
                        m('wamid.p12-4', 'interactive', { interactive: { type: 'list_reply', list_reply: { id: 'p2', title: 'Paket B' } } }),
                        m('wamid.p12-5', 'location', { location: { name: 'Kantor', latitude: -6.2, longitude: 106.8 } }),
                        m('wamid.p12-6', 'unsupported', {}),
                        m('wamid.p12-7', 'system', { system: { type: 'user_changed_number', body: 'nomor berubah' } }),
                        m('wamid.p12-8', 'request_welcome', {}),
                        m('wamid.p12-9', 'reaction', { reaction: { message_id: 'wamid.p12-3', emoji: '👍' } }),
                    ],
                },
                OTHER_PNID,
            ),
        ]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows().map((r) => r.content)).toEqual([
            '📋 Form WhatsApp dikirim\nnama: Budi Palsu',
            '👤 Kartu kontak dibagikan\nTeman Palsu: +62 800-0000-0099',
            '🔘 Tombol: Ya',
            '🔘 Pilihan: Paket B',
            '📍 Lokasi: Kantor',
            'Pesan jenis "unsupported" (isinya tidak ditampilkan di Sarathi)',
        ]);
        expect(h.db.userRows().every((r) => r.metadata?.other_number === OTHER.ref)).toBe(true);
        expect(h.db.chat(A)).toMatchObject({ verified_phone: A, unread_count: 6 });
        expect(handleFlowReply).not.toHaveBeenCalled();
        expect(sends()).toEqual([]);
        // (The first row's push waits for the daily other-number note, so the order is not the rows'.)
        expect(pushes().map((p) => p.body).sort()).toEqual(
            [
                '📋 Mengisi form WhatsApp',
                '👤 Kartu kontak',
                '🔘 Tombol: Ya',
                '🔘 Pilihan: Paket B',
                '📍 Lokasi',
                'Pesan jenis "unsupported" (isinya tidak ditampilkan di Sarathi)',
            ].sort(),
        );
        // A redelivery that gets past the pre-dedup meets the function's gate.
        failPrededup();
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows()).toHaveLength(6);
        expect(h.db.chat(A)!.unread_count).toBe(6);
        expect(h.db.notes()).toHaveLength(1);
        expect(pushes()).toHaveLength(6);
    });

    it('P13 Kept, now atomic in the database function: the redelivery gate before the rate limit, manual mode before the quota, a waiting burst joined without a unit, a refusal stored with a note once per chat and minute and alerted once, the quota failing open', async () => {
        h.db.quotaLimit = { inbound_minute: 1 };
        h.db.seedChat({ phone_number: C, ai_enabled: false });
        const body = delivery([
            change({
                contacts: [contactOf(A), contactOf(B), contactOf(C)],
                messages: [text(A, 'wamid.p13-a1'), text(A, 'wamid.p13-a2'), text(B, 'wamid.p13-b1'), text(B, 'wamid.p13-b2'), text(C, 'wamid.p13-c1')],
            }),
        ]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows()).toHaveLength(5); // a refused or manual message is still stored
        expect(h.db.queue.map((j) => j.wa_message_id)).toEqual(['wamid.p13-a1', 'wamid.p13-a2']); // a2 joined a1's burst
        // The minute counter: the join and manual mode spent nothing.
        expect([...h.db.quota].filter(([k]) => k.includes('|inbound_minute|')).map(([, v]) => v)).toEqual([{ used: 1, refused: 2 }]);
        expect(noteTexts()).toEqual([inboundQuotaNotice(1)]);
        expect(h.db.notes()[0].phone_number).toBe(B);
        expect(h.db.events().map((e) => [e.kind, e.detail])).toEqual([['quota_inbound_exceeded', 'batas 1 percakapan AI baru per menit tercapai']]);
        expect(replies().map((r) => r[0])).toEqual([A]); // one reply for A's burst
        // A redelivery past the pre-dedup is a duplicate before it spends a rate slot.
        failPrededup();
        expect(await deliver(one(text(A, 'wamid.p13-a1')))).toBe(200);
        expect(h.db.rateLimits.get(`${ORG}:${A}`)!.count).toBe(2);
        // The quota counter fails: the message is let through and alerted.
        h.db.quotaError = '57014';
        expect(await deliver(one(text(D, 'wamid.p13-d1'), PNID, [contactOf(D)]))).toBe(200);
        await settle();
        expect(h.db.queue.at(-1)!.wa_message_id).toBe('wamid.p13-d1');
        expect(h.db.events('quota_check_failed').map((e) => e.detail)).toEqual(['inbound_minute: 57014']);
    });

    it('P14 Changed (D23-1): over the main-number limit nothing is stored, the customer gets one "Mohon tunggu" and the chat one note per window (touchChat false); a failed send answers 200 with a note that says so', async () => {
        h.db.seedChat({ phone_number: A, ai_enabled: false });
        const flood = (prefix: string) => delivery([change({ contacts: [contactOf(A)], messages: Array.from({ length: 12 }, (_, i) => text(A, `wamid.${prefix}-${i}`)) })]);
        expect(await deliver(flood('p14a'))).toBe(200);
        await settle();
        expect(h.db.userRows()).toHaveLength(10);
        expect(warnings()).toEqual([[A, RATE_LIMIT_WARNING, { phoneNumberId: PNID, accessToken: 'token-palsu' }]]);
        expect(noteTexts()).toEqual([RATE_LIMIT_NOTE]);
        expect(h.db.chat(A)!.last_message).toBe('pesan wamid.p14a-9');
        // The next window, with Meta refusing the warning.
        vi.setSystemTime(Date.now() + 61_000);
        vi.mocked(sendWhatsAppMessage).mockRejectedValue(new Error('fetch failed'));
        expect(await deliver(flood('p14b'))).toBe(200);
        await settle();
        expect(h.db.userRows()).toHaveLength(20);
        expect(noteTexts()).toEqual([RATE_LIMIT_NOTE, RATE_LIMIT_WARNING_FAILED_NOTE]);
        expect(h.db.events()).toEqual([]); // not a token error: logged only
    });

    it("P15 Kept, deduplicated (D23-3): a card's phone (wa_id first, else the digits of phone, else the sender's) becomes verified_phone; a note keyed by the card's wamid with touchChat false; no AI; the key resolves by BSUID within the org; BSUID captured; the write checked", async () => {
        h.db.seedChat({ phone_number: '620000000060', bsuid: 'ID.kartu' });
        h.db.seedChat({ org_id: OTHER_ORG, phone_number: '620000000070', bsuid: 'ID.kartu' });
        const card = (from: Record<string, unknown>, id: string, cards: unknown[]) => ({ ...from, id, timestamp: metaTs(), type: 'contacts', contacts: cards });
        const body = delivery([
            change({
                contacts: [contactOf(A), contactOf(B), contactOf(C), contactOf('620000000050', 'ID.kartu'), contactOf(D, 'ID.d-baru')],
                messages: [
                    card({ from: A }, 'wamid.p15-1', [{ phones: [{ phone: '+62 800-0000-0091', wa_id: '6280000000090' }] }]),
                    card({ from: B }, 'wamid.p15-2', [{ phones: [{ phone: '+62 800-0000-0092' }] }]),
                    card({ from: C }, 'wamid.p15-3', [{ name: { formatted_name: 'Tanpa Nomor' } }]),
                    card({ from: '620000000050' }, 'wamid.p15-4', [{ phones: [{ wa_id: '6280000000094' }] }]),
                    card({ from: D }, 'wamid.p15-5', [{ phones: [{ wa_id: '6280000000095' }] }]),
                ],
            }),
        ]);
        expect(await deliver(body)).toBe(200);
        const note = (phone: string) => `Customer shared contact info — phone tersimpan: ${phone}`;
        expect(h.db.notes().map((n) => [n.phone_number, n.wa_message_id, n.content])).toEqual([
            [A, 'wamid.p15-1', note('6280000000090')],
            [B, 'wamid.p15-2', note('6280000000092')],
            [C, 'wamid.p15-3', note(C)],
            ['620000000060', 'wamid.p15-4', note('6280000000094')],
            [D, 'wamid.p15-5', note('6280000000095')],
        ]);
        expect(h.db.chat('620000000060')!.verified_phone).toBe('6280000000094');
        expect(h.db.chat('620000000070', OTHER_ORG)!.verified_phone).toBeNull();
        expect(h.db.calls.find((c) => c.target === 'whatsapp_chats.select')!.filters!.map((f) => [f.kind, f.column, f.value])).toEqual([
            ['eq', 'org_id', ORG],
            ['eq', 'bsuid', 'ID.kartu'],
        ]);
        expect(h.db.chat(D)).toMatchObject({ bsuid: 'ID.d-baru', verified_phone: '6280000000095', last_message_at: null, unread_count: 0 });
        expect(h.db.ingests()).toEqual([]);
        expect(h.db.queue).toEqual([]);
        expect(pushes()).toEqual([]);
        // The BSUID write is checked too: a database error is retryable.
        h.db.fail({ target: 'whatsapp_chats.update', error: { code: '40001' } });
        const another = delivery([change({ contacts: [contactOf(E, 'ID.e')], messages: [card({ from: E }, 'wamid.p15-6', [{ phones: [{ wa_id: '6280000000096' }] }])] })]);
        expect(await deliver(another)).toBe(503);
        expect(h.db.notes()).toHaveLength(5);
    });

    it('P16 Kept (Q5): a Flow submission to the main number goes to handleFlowReply, which keeps its own gate, lead, stage, note and confirmation; the route writes no row itself; a resend never reaches it', async () => {
        const flow = {
            from: A,
            from_user_id: 'ID.a',
            id: 'wamid.p16',
            timestamp: metaTs(),
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"flow_token":"t","nama":"Budi Palsu"}' } },
        };
        const body = one(flow);
        expect(await deliver(body)).toBe(200);
        expect(handleFlowReply).toHaveBeenCalledTimes(1);
        expect(vi.mocked(handleFlowReply).mock.calls[0][0]).toEqual({
            supabase: h.db.client,
            orgId: ORG,
            phoneNumberId: PNID,
            accessToken: 'token-palsu',
            contactKey: A,
            bsuid: 'ID.a',
            waId: A,
            inboundWamid: 'wamid.p16',
            nfmReply: flow.interactive.nfm_reply,
        });
        expect(h.db.ingests()).toEqual([]);
        // Only the org-scoped BSUID lookup of the key; every write is handleFlowReply's.
        expect(h.db.calls.filter((c) => c.target.startsWith('whatsapp_chats.')).map((c) => [c.target, (c.filters ?? []).map((f) => f.value)])).toEqual([
            ['whatsapp_chats.select', [ORG, 'ID.a']],
        ]);
        expect(h.db.userRows().map((r) => r.wa_message_id)).toEqual(['wamid.p16']);
        expect(await deliver(body)).toBe(200);
        expect(handleFlowReply).toHaveBeenCalledTimes(1);
    });

    it("P17 Kept (C2 unchanged): media goes to today's handler in the background: a sticker stored as an image under <org>/<phone>/<uuid>.<ext>, upsert false, Meta's mime, reply_to_wamid kept, no AI; the 200 does not wait for the download; a resend is not downloaded again", async () => {
        let open!: () => void;
        const downloaded = new Promise<void>((resolve) => {
            open = resolve;
        });
        vi.mocked(downloadWhatsAppMedia).mockImplementation(async () => {
            await downloaded;
            return { bytes: new Uint8Array([1, 2, 3]), mime: 'image/webp', size: 3 };
        });
        const sticker = { from: A, id: 'wamid.p17', timestamp: metaTs(), type: 'sticker', sticker: { id: 'media-palsu-17', mime_type: 'image/webp' }, context: { id: 'wamid.kutipan' } };
        const body = one(sticker);
        const res = POST(signedPost(body));
        let answered = 0;
        void res.then((r) => (answered = r.status));
        for (let i = 0; i < 200 && answered === 0; i++) await macrotask();
        open();
        expect(answered).toBe(200);
        await settle();
        const [row] = h.db.userRows();
        expect(row).toMatchObject({ wa_message_id: 'wamid.p17', media_type: 'image', media_mime: 'image/webp', reply_to_wamid: 'wamid.kutipan', metadata: {} });
        expect(h.db.uploads).toEqual([
            { bucket: 'chat-media', path: expect.stringMatching(new RegExp(`^${ORG}/${A}/[0-9a-f-]{36}\\.webp$`)), options: { contentType: 'image/webp', upsert: false } },
        ]);
        expect(row.media_url).toBe(h.db.uploads[0].path);
        expect(h.db.queue).toEqual([]);
        expect(h.db.chat(A)!.unread_count).toBe(1);
        expect(pushes()).toEqual([{ title: A, body: '📷 Foto', phone: A, url: `/dashboard/chats?phone=${A}` }]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(downloadWhatsAppMedia).toHaveBeenCalledTimes(1);
    });

    it('P18 Changed (D23-4): other types on the main number are stored as one line without AI (unread, push, "Belum dibalas"); reaction, system and request_welcome stay acknowledged only', async () => {
        const body = delivery([
            change({
                contacts: [contactOf(A)],
                messages: [
                    { from: A, id: 'wamid.p18-1', timestamp: metaTs(), type: 'button', button: { text: 'Ya, saya tertarik', payload: 'YA' } },
                    { from: A, id: 'wamid.p18-2', timestamp: metaTs(), type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } },
                ],
            }),
        ]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(h.db.userRows().map((r) => r.content)).toEqual(['🔘 Tombol: Ya, saya tertarik']);
        expect(h.db.ingests()[0]).toMatchObject({ p_ai_eligible: false, p_queue_text: null, p_rate_scope: 'main', p_metadata: {}, p_unread: true });
        expect(h.db.queue).toEqual([]);
        expect(h.db.chat(A)).toMatchObject({ unread_count: 1 });
        expect(h.db.chat(A)!.last_message_at).toBe(h.db.chat(A)!.last_inbound_at);
        expect(pushes()).toHaveLength(1);
    });

    it('P19 Kept, now forward only (Meta time, outbound rows): one call per change with the org, the 4 tracked states, the failed error fields and the recipient ids for the BSUID backfill (only where unset, in the org); untracked states ignored', async () => {
        h.db.seedChat({ phone_number: A });
        h.db.seedChat({ org_id: OTHER_ORG, phone_number: A });
        h.db.seedAssistant('wamid.p19-1', A, 'sent');
        h.db.seedAssistant('wamid.p19-2', A, 'read');
        h.db.seedAssistant('wamid.p19-3', A, 'sent');
        h.db.insertMessage({ org_id: ORG, phone_number: A, role: 'user', content: 'pesan pelanggan', wa_message_id: 'wamid.p19-4' });
        const ts = metaTs(1_000);
        const statuses = [
            { id: 'wamid.p19-1', status: 'delivered', timestamp: ts, recipient_id: A, recipient_user_id: 'ID.a' },
            { id: 'wamid.p19-2', status: 'delivered', timestamp: ts, recipient_id: A },
            { id: 'wamid.p19-3', status: 'failed', timestamp: ts, recipient_id: A, errors: [{ code: 131026, title: 'Message undeliverable', message: 'tidak terkirim' }] },
            { id: 'wamid.p19-4', status: 'read', timestamp: ts, recipient_id: A },
            { id: 'wamid.p19-5', status: 'deleted', timestamp: ts, recipient_id: A },
        ];
        expect(await deliver(delivery([change({ statuses })]))).toBe(200);
        const [call] = h.db.rpcCalls('wa_apply_statuses');
        const iso = new Date(Number(ts) * 1000).toISOString();
        const row = (id: string, status: string, over: Record<string, unknown> = {}) => ({
            id,
            status,
            ts: iso,
            error_code: null,
            error_title: null,
            error_detail: null,
            recipient_id: A,
            recipient_user_id: null,
            ...over,
        });
        expect(call).toEqual({
            p_org: ORG,
            p_statuses: [
                row('wamid.p19-1', 'delivered', { recipient_user_id: 'ID.a' }),
                row('wamid.p19-2', 'delivered'),
                row('wamid.p19-3', 'failed', { error_code: 131026, error_title: 'Message undeliverable', error_detail: 'tidak terkirim' }),
                row('wamid.p19-4', 'read'),
            ],
        });
        const status = (id: string) => h.db.messages.find((m) => m.wa_message_id === id);
        expect(status('wamid.p19-1')!.status).toBe('delivered');
        expect(status('wamid.p19-2')!.status).toBe('read'); // a late 'delivered' never undoes 'read'
        expect(status('wamid.p19-3')).toMatchObject({ status: 'failed', error_code: 131026, error_detail: 'tidak terkirim' });
        expect(status('wamid.p19-4')!.status).toBeNull(); // a customer's row is never touched
        expect(h.db.chat(A)!.bsuid).toBe('ID.a');
        expect(h.db.chat(A, OTHER_ORG)!.bsuid).toBeNull();
        expect(h.logs.map((l) => String(l[0])).filter((l) => l.startsWith('Statuses:'))).toEqual([
            'Statuses: 4 received, 2 applied, 1 stale, 1 without a message row, bsuid filled 1, conflicts 0',
        ]);
    });

    it('P20 Kept: push and unread only for a new row (title the contact name, else the key; body the preview; url /dashboard/chats?phone=<key>); nothing for a duplicate; a message without an id gets a syn. key and is pushed once', async () => {
        h.db.seedChat({ phone_number: A, contact_name: 'Budi Palsu' });
        expect(await deliver(delivery([change({ contacts: [contactOf(A), contactOf(B)], messages: [text(A, 'wamid.p20-a', 'halo'), text(B, 'wamid.p20-b', 'hai')] })]))).toBe(200);
        await settle();
        expect(pushes()).toEqual([
            { title: 'Budi Palsu', body: 'halo', phone: A, url: `/dashboard/chats?phone=${A}` },
            { title: B, body: 'hai', phone: B, url: `/dashboard/chats?phone=${B}` },
        ]);
        failPrededup();
        expect(await deliver(one(text(A, 'wamid.p20-a', 'halo')))).toBe(200);
        await settle();
        expect(pushes()).toHaveLength(2);
        expect(h.db.chat(A)!.unread_count).toBe(1);
        const withoutId = one(text(C, null, 'tanpa id'), PNID, [contactOf(C)]);
        expect(await deliver(withoutId)).toBe(200);
        expect(await deliver(withoutId)).toBe(200);
        await settle();
        expect(pushes().slice(2)).toEqual([{ title: C, body: 'tanpa id', phone: C, url: `/dashboard/chats?phone=${C}` }]);
        expect(h.db.userRows().at(-1)!.wa_message_id).toMatch(/^syn\.[0-9a-f]{64}$/);
    });

    it('P21 Kept: every operator note about a message still waiting for a reply keeps the chat "Belum dibalas" (touchChat false)', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        h.db.quotaLimit = { inbound_minute: 1 };
        h.db.seedChat({ phone_number: A, ai_enabled: false });
        const body = delivery([
            change({
                contacts: [contactOf(E), contactOf(B), contactOf(C), contactOf(A)],
                messages: [
                    text(E, 'wamid.p21-e'), // takes the minute's only AI unit
                    text(B, 'wamid.p21-b'), // refused by the quota: a note
                    text(C, 'wamid.p21-c', 'telat', { timestamp: metaTs(21 * HOUR) }), // late: a note
                    ...Array.from({ length: 11 }, (_, i) => text(A, `wamid.p21-a${i}`)), // over the limit: a note
                ],
            }),
            change({ contacts: [contactOf(D)], messages: [text(D, 'wamid.p21-d')] }, OTHER_PNID), // another number: a note
        ]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(new Set(h.db.notes().map((n) => n.phone_number))).toEqual(new Set([B, C, A, D]));
        for (const phone of [B, C, A, D]) {
            const chat = h.db.chat(phone)!;
            expect(chat.last_message_at).toBe(chat.last_inbound_at);
            expect(chat.last_message).not.toMatch(/^System: /);
        }
        expect(noteTexts()).toContain(lateMessageNotice(21 * HOUR));
    });

    it('P22 Kept: logs and alerts carry counts and fixed texts (KEA-21): no phone number or message text in any alert, no message text in any log, a counts-only result line', async () => {
        const secretText = 'isi rahasia pelanggan';
        h.db.fail({ target: 'rpc:wa_ingest_inbound', match: (a) => a.p_wamid === 'wamid.p22-2' && !(a.p_metadata as Record<string, unknown>).unprocessable, error: { code: '23514', message: `Failing row contains (${A}, ${secretText})` } });
        const body = delivery([
            change({
                contacts: [contactOf(A)],
                messages: [text(A, 'wamid.p22-1', secretText), text(A, 'wamid.p22-2', secretText), { from: A, id: 'wamid.p22-3', timestamp: metaTs(), type: 'text', text: { body: null } }],
                statuses: [{ status: 'read', recipient_id: A }],
            }),
        ]);
        expect(await deliver(body)).toBe(200);
        await settle();
        expect(kinds().sort()).toEqual(['webhook_payload_invalid', 'webhook_payload_invalid', 'webhook_payload_invalid']);
        for (const e of h.db.events()) {
            expect(e.detail).not.toContain(A);
            expect(e.detail).not.toContain(secretText);
        }
        const logged = JSON.stringify(h.logs.map((args) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : a))));
        expect(logged).not.toContain(secretText);
        const batch = h.logs.map((l) => String(l[0])).filter((l) => l.startsWith('Webhook batch:'));
        expect(batch).toHaveLength(1);
        expect(batch[0]).toMatch(
            /^Webhook batch: items=4 new=1 duplicate=0 rate_limited=0 acked=0 legacy=0 degraded=2 skipped=1 retryable=0 deferred=0 statuses applied=0 stale=0 unknown=0 ms=\d+ http=200$/,
        );
    });

    it('P23 Kept, extended: the AI history leaves out messages to another number and placeholders; every user row keeps its wamid, so the burst is trimmed exactly', async () => {
        h.db.insertMessage({ org_id: ORG, phone_number: A, role: 'user', content: 'pertanyaan lama', wa_message_id: 'wamid.lama' });
        h.db.insertMessage({ org_id: ORG, phone_number: A, role: 'assistant', content: 'jawaban lama', wa_message_id: 'wamid.keluar-lama', status: 'read' });
        h.db.insertMessage({ org_id: ORG, phone_number: A, role: 'user', content: 'ke nomor lain', wa_message_id: 'wamid.lain', metadata: { other_number: OTHER.ref } });
        h.db.insertMessage({ org_id: ORG, phone_number: A, role: 'user', content: 'Pesan jenis "text" tidak bisa diproses otomatis', wa_message_id: 'wamid.rusak', metadata: { unprocessable: 'text' } });
        h.db.insertMessage({ org_id: ORG, phone_number: A, role: 'system', content: 'catatan operator' });
        expect(await deliver(one(text(A, 'wamid.p23', 'pertanyaan baru')))).toBe(200);
        await settle();
        expect(vi.mocked(generateRAGResponse).mock.calls).toEqual([
            ['pertanyaan baru', [{ role: 'user', content: 'pertanyaan lama' }, { role: 'assistant', content: 'jawaban lama' }], A, { orgId: ORG }],
        ]);
        expect(h.db.userRows().every((r) => r.wa_message_id !== null)).toBe(true);
    });

    it('P24 Kept, once per batch: the queue is drained right after the batch and again after debounce + 5 s (the per-minute cron stays the backstop)', async () => {
        vi.stubEnv('WHATSAPP_DEBOUNCE_SECONDS', '3');
        expect(await deliver(delivery([change({ contacts: [contactOf(A), contactOf(B)], messages: [text(A, 'wamid.p24-a'), text(B, 'wamid.p24-b')] })]))).toBe(200);
        await settle();
        expect(h.db.rpcCalls('claim_queue_jobs')).toEqual([{ p_limit: 10, p_stale_seconds: 600, p_debounce_seconds: 3 }]);
        expect(replies()).toEqual([]); // the burst has not settled yet
        await vi.advanceTimersByTimeAsync(7_999);
        expect(h.db.rpcCalls('claim_queue_jobs')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(h.db.rpcCalls('claim_queue_jobs')).toHaveLength(2);
        expect(replies().map((r) => r[0])).toEqual([A, B]);
    });

    it('P25 Kept: per-process throttles: the other-number note once a day per chat, its limit note once a minute, the quota note once per chat and minute, the unrouted lookup once per number', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        const flood = (prefix: string, n: number) => delivery([change({ contacts: [contactOf(A)], messages: Array.from({ length: n }, (_, i) => text(A, `wamid.${prefix}-${i}`)) }, OTHER_PNID)]);
        expect(await deliver(flood('p25a', 12))).toBe(200);
        expect(await deliver(flood('p25b', 2))).toBe(200);
        await settle();
        expect(noteTexts()).toEqual([otherNumberNotice(OTHER), otherNumberLimitNotice(OTHER)]);
        vi.setSystemTime(Date.now() + 24 * HOUR);
        expect(await deliver(flood('p25c', 12))).toBe(200);
        await settle();
        expect(noteTexts()).toEqual([otherNumberNotice(OTHER), otherNumberLimitNotice(OTHER), otherNumberNotice(OTHER), otherNumberLimitNotice(OTHER)]);
        expect(h.db.calls.filter((c) => c.target === 'ops_events.select')).toHaveLength(1);
        // The quota note: once per chat and minute.
        h.db.quotaLimit = { inbound_minute: 0 };
        for (const id of ['wamid.p25-q1', 'wamid.p25-q2']) expect(await deliver(one(text(B, id), PNID, [contactOf(B)]))).toBe(200);
        await settle();
        expect(h.db.notes().filter((n) => n.phone_number === B).map((n) => n.content)).toEqual([inboundQuotaNotice(0)]);
    });

    it('P26 Kept (realtime contract v1, now 2 broadcasts per new message): a new text is written by the one database call, with no chat write or bump_unread from TypeScript; a duplicate writes nothing at all', async () => {
        expect(await deliver(one(text(A, 'wamid.p26')))).toBe(200);
        const targets = h.db.calls.map((c) => c.target);
        expect(targets.filter((t) => !t.endsWith('.select') && t !== 'rpc:claim_queue_jobs')).toEqual(['rpc:wa_ingest_inbound']);
        await settle();
        const commits = h.db.commits.length;
        const calls = h.db.calls.length;
        failPrededup();
        expect(await deliver(one(text(A, 'wamid.p26')))).toBe(200);
        await settle();
        expect(h.db.commits.length).toBe(commits);
        expect(h.db.calls.slice(calls).map((c) => c.target)).toEqual(['whatsapp_messages.select', 'rpc:wa_ingest_inbound']);
        expect(pushes()).toHaveLength(1);
    });

    it('P27 Kept: an event without metadata.phone_number_id is the main number (warned); the number id is compared as given, a numeric id matching; a field other than messages is acknowledged without reading the org', async () => {
        expect(await deliver(delivery([change({ contacts: [contactOf(A)], messages: [text(A, 'wamid.p27-1')] }, null)]))).toBe(200);
        expect(h.db.ingests()[0]).toMatchObject({ p_rate_scope: 'main', p_ai_eligible: true });
        expect(h.logs.filter((l) => String(l[0]).includes('without metadata.phone_number_id'))).toHaveLength(1);
        const numeric = { field: 'messages', value: { metadata: { phone_number_id: Number(PNID) }, contacts: [contactOf(B)], messages: [text(B, 'wamid.p27-2')] } };
        expect(await deliver(delivery([numeric]))).toBe(200);
        expect(h.db.ingests()[1]).toMatchObject({ p_wamid: 'wamid.p27-2', p_rate_scope: 'main' });
        const reads = h.orgReads;
        const calls = h.db.calls.length;
        expect(await deliver(delivery([{ field: 'message_template_status_update', value: { event: 'APPROVED' } }]))).toBe(200);
        expect(h.orgReads).toBe(reads);
        expect(h.db.calls.length).toBe(calls);
        expect(kinds()).toEqual([]);
    });
});
