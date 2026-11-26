import crypto from 'node:crypto';
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
    metaTs,
    signedPost,
    textMsg,
} from '@/lib/whatsapp/webhook/__tests__/wa-model';

// The per-app webhook URL (Fase 2 task 2.2c): /api/webhook/whatsapp/<key>.
// The app, its secret, its number and its token come from Vault (the two
// 0073 reads, answered by the model's fixture maps), its org from the app
// row, never from the default org or the env. Shape checks run before any
// database call; tenant isolation holds because the signature binds the app
// and the router compares with the app's own number. The walk after the gate
// is pinned by contract.test.ts and part1-pins.test.ts. Meta, the AI, Web
// Push and the queue drain are stubbed. Fake ids, keys, secrets and tokens
// only.

const h = vi.hoisted(() => ({
    db: null as unknown as WaModel,
    logs: [] as unknown[][],
    orgReads: 0,
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => h.db.client) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/settings/org-context', () => ({
    getDefaultOrgIdStrict: vi.fn(async () => {
        h.orgReads += 1;
        return 'aaaaaaaa-0000-4000-8000-00000000000a';
    }),
}));
vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn(), downloadWhatsAppMedia: vi.fn() }));
vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: vi.fn() }));
vi.mock('@/lib/ai/rag', () => ({ generateRAGResponse: vi.fn() }));
vi.mock('@/lib/whatsapp/flow-response', () => ({ handleFlowReply: vi.fn(async () => ({ status: 'handled' })) }));
vi.mock('@/lib/whatsapp/queue-db', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/whatsapp/queue-db')>()),
    processQueue: vi.fn(async () => {}),
}));
vi.mock('@/lib/utils/logger', async (importOriginal) => {
    const record = (...args: unknown[]) => void h.logs.push(args);
    return {
        ...(await importOriginal<typeof import('@/lib/utils/logger')>()),
        whatsappLogger: { info: record, warn: record, error: record, debug: record },
    };
});

import { createClient } from '@supabase/supabase-js';
import { GET, POST } from '@/app/api/webhook/whatsapp/[key]/route';
import { downloadWhatsAppMedia, sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { processQueue } from '@/lib/whatsapp/queue-db';
import { settleBackground } from '@/lib/whatsapp/webhook/background';
import { resetPoison } from '@/lib/whatsapp/webhook/outcome';
import { resetAfterIngestState } from '@/lib/whatsapp/webhook/after-ingest';
import { resetOpsEventThrottle } from '@/lib/ops/events';
import { resetOtherNumberState } from '@/lib/whatsapp/other-number';

const A = '620000000001';
const KEY_A = 'A'.repeat(32);
const KEY_B = 'B'.repeat(32);
const UNKNOWN_KEY = 'C'.repeat(32);
const APP_A = 'cccccccc-0000-4000-8000-00000000000c';
const APP_B = 'dddddddd-0000-4000-8000-00000000000d';
const SECRET_B = 'rahasia-aplikasi-lain';
const VERIFY_A = 'verifikasi-palsu';
const TOKEN_A = 'token-vault-palsu';
const TOKEN_B = 'token-vault-lain';
const CHALLENGE = '1158201444';
const VAULT_NO_TOKEN =
    'token akses aplikasi ini tidak terbaca dari Vault atau tidak valid: pesan masuk tetap disimpan, tetapi balasan AI dan peringatan tidak terkirim';

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });

/** App A (the default org's, PNID) and app B (another org's, OTHER_PNID), both active with a number. */
function seedApps(): void {
    h.db.webhookApps.set(KEY_A, { app_id: APP_A, org_id: ORG, status: 'active', app_secret: SECRET, verify_token_sha256: sha256(VERIFY_A) });
    h.db.webhookApps.set(KEY_B, { app_id: APP_B, org_id: OTHER_ORG, status: 'active', app_secret: SECRET_B, verify_token_sha256: sha256('verifikasi-lain') });
    h.db.sendCreds.set(ORG, {
        integration_id: 'eeeeeeee-0000-4000-8000-00000000000e',
        app_id: APP_A,
        phone_number_id: PNID,
        waba_id: '200000000000001',
        access_token: TOKEN_A,
        status: 'active',
        app_status: 'active',
    });
    h.db.sendCreds.set(OTHER_ORG, {
        integration_id: 'ffffffff-0000-4000-8000-00000000000f',
        app_id: APP_B,
        phone_number_id: OTHER_PNID,
        waba_id: '200000000000002',
        access_token: TOKEN_B,
        status: 'active',
        app_status: 'active',
    });
}

function verification(key: string, params: Record<string, string>): Request {
    return new Request(`http://localhost/api/webhook/whatsapp/${key}?${new URLSearchParams(params)}`);
}

const subscribe = (token = VERIFY_A) => ({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': CHALLENGE });

async function deliver(key: string, body: unknown, secret = SECRET): Promise<number> {
    return (await POST(signedPost(body, secret), ctx(key))).status;
}

const one = (message: unknown, phoneNumberId = PNID) => delivery([change({ contacts: [contactOf(A)], messages: [message] }, phoneNumberId)]);
const kinds = () => h.db.events().map((e) => e.kind);
const logLines = () => h.logs.map((l) => String(l[0]));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.UTC(2026, 10, 1, 3, 0, 0) });
    vi.clearAllMocks();
    h.db = new WaModel();
    h.logs = [];
    h.orgReads = 0;
    seedApps();
    resetOpsEventThrottle();
    resetOtherNumberState();
    resetPoison();
    resetAfterIngestState();
    vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue({ waMessageId: 'wamid.keluar-1', raw: {} });
    vi.mocked(downloadWhatsAppMedia).mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', size: 3 });
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

describe('GET: the verification of a per-app URL', () => {
    it("the app's verify token gets the challenge back as text/plain, checked against the Vault hash only", async () => {
        const res = await GET(verification(KEY_A, subscribe()), ctx(KEY_A));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(CHALLENGE);
        expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
        expect(h.db.rpcCalls('wa_webhook_app')).toEqual([{ p_key: KEY_A }]);
        expect(h.orgReads).toBe(0);
    });

    it.each([
        ['a wrong token', KEY_A, subscribe('verifikasi-salah'), () => {}, true],
        ["another app's token", KEY_A, subscribe('verifikasi-lain'), () => {}, true],
        ['an unknown key', UNKNOWN_KEY, subscribe(), () => {}, true],
        ['a suspended app', KEY_A, subscribe(), () => void (h.db.webhookApps.get(KEY_A)!.status = 'suspended'), true],
        ['a wa_webhook_app error', KEY_A, subscribe(), () => h.db.fail({ target: 'rpc:wa_webhook_app', error: { code: '57014' } }), true],
        ['a key of another shape', 'pendek', subscribe(), () => {}, false],
        ['no hub.mode', KEY_A, { 'hub.verify_token': VERIFY_A, 'hub.challenge': CHALLENGE }, () => {}, false],
        ['another hub.mode', KEY_A, { ...subscribe(), 'hub.mode': 'unsubscribe' }, () => {}, false],
        ['no challenge', KEY_A, { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_A }, () => {}, false],
        ['no token', KEY_A, { 'hub.mode': 'subscribe', 'hub.challenge': CHALLENGE }, () => {}, false],
        ['no service-role key', KEY_A, subscribe(), () => vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ''), false],
    ])('%s gets 403', async (_label, key, params, setup, readsDb) => {
        setup();
        const res = await GET(verification(key, params), ctx(key));
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain(CHALLENGE);
        expect(h.db.calls.length > 0).toBe(readsDb);
    });

    it('the verify token and the key never reach a log line', async () => {
        await GET(verification(KEY_A, subscribe()), ctx(KEY_A));
        await GET(verification(KEY_A, subscribe('verifikasi-salah')), ctx(KEY_A));
        h.db.fail({ target: 'rpc:wa_webhook_app', error: { code: '57014' } });
        await GET(verification(KEY_A, subscribe()), ctx(KEY_A));
        expect(h.logs.length).toBeGreaterThan(0);
        const logged = JSON.stringify(h.logs);
        for (const secret of [VERIFY_A, 'verifikasi-salah', KEY_A, sha256(VERIFY_A)]) expect(logged).not.toContain(secret);
    });
});

describe('POST: refused before the walk', () => {
    it('a key of another shape gets 404 before the body is read, with no database call', async () => {
        for (const key of ['pendek', `${'A'.repeat(31)}!`, 'A'.repeat(33), '']) {
            const request = signedPost(one(textMsg(A, 'wamid.k1', 'halo')));
            expect((await POST(request, ctx(key))).status).toBe(404);
            expect(request.bodyUsed).toBe(false);
        }
        expect(createClient).not.toHaveBeenCalled();
        expect(h.db.calls).toEqual([]);
    });

    it('a missing or malformed signature header gets 403 with no database call and no alert', async () => {
        const raw = JSON.stringify(one(textMsg(A, 'wamid.k2', 'halo')));
        const valid = signedPost(raw).headers.get('x-hub-signature-256')!;
        for (const header of [null, 'sha256=abc', `sha1=${valid.slice(7)}`, valid.slice(7), `${valid}0`, `sha256=${'g'.repeat(64)}`]) {
            const headers: Record<string, string> = header === null ? {} : { 'x-hub-signature-256': header };
            const request = new Request('http://localhost/api/webhook/whatsapp/x', { method: 'POST', headers, body: raw });
            expect((await POST(request, ctx(KEY_A))).status, String(header)).toBe(403);
        }
        expect(createClient).not.toHaveBeenCalled();
        expect(h.db.calls).toEqual([]);
        expect(h.db.events()).toEqual([]);
    });

    it('a body over 3 MB gets 413 with no database call', async () => {
        const request = new Request('http://localhost/api/webhook/whatsapp/x', {
            method: 'POST',
            headers: { 'content-length': String(3 * 1024 * 1024 + 1), 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
            body: '{}',
        });
        expect((await POST(request, ctx(KEY_A))).status).toBe(413);
        expect(h.db.calls).toEqual([]);
    });

    it('without the service-role key: 503, and createClient is never called', async () => {
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k3', 'halo')))).toBe(503);
        expect(createClient).not.toHaveBeenCalled();
    });

    it('an unknown key gets 404 after one lookup, logged only', async () => {
        expect(await deliver(UNKNOWN_KEY, one(textMsg(A, 'wamid.k4', 'halo')))).toBe(404);
        expect(h.db.calls.map((c) => c.target)).toEqual(['rpc:wa_webhook_app']);
        expect(h.db.events()).toEqual([]);
    });

    it('a wa_webhook_app error gets 503 and webhook_error without an org', async () => {
        h.db.fail({ target: 'rpc:wa_webhook_app', error: { code: '57014' } });
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k5', 'halo')))).toBe(503);
        expect(h.db.events()).toEqual([
            { kind: 'webhook_error', org: null, detail: 'aplikasi webhook tidak terbaca (database 57014); webhook menjawab 503, Meta mengirim ulang', count: 1 },
        ]);
        expect(h.db.ingests()).toEqual([]);
    });

    it("a signature by another secret gets 403 and webhook_signature_invalid for the URL's app; nothing is read or written", async () => {
        const body = one(textMsg(A, 'wamid.k6', 'halo'));
        expect(await deliver(KEY_A, body, SECRET_B)).toBe(403);
        // App A's own signature on app B's URL is refused as well.
        expect(await deliver(KEY_B, delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.k6b', 'halo')] }, OTHER_PNID)]), SECRET)).toBe(403);
        expect(h.db.events()).toEqual([
            { kind: 'webhook_signature_invalid', org: ORG, detail: 'tanda tangan tidak cocok', count: 1 },
            { kind: 'webhook_signature_invalid', org: OTHER_ORG, detail: 'tanda tangan tidak cocok', count: 1 },
        ]);
        expect(h.db.calls.map((c) => c.target).filter((t) => t !== 'rpc:record_ops_event')).toEqual(['rpc:wa_webhook_app', 'rpc:wa_webhook_app']);
        expect(h.db.chats).toEqual([]);
        expect(logLines().some((l) => l.startsWith('Webhook received'))).toBe(false);
    });

    it('an app secret Vault could not decrypt gets 403 with the Vault detail', async () => {
        h.db.webhookApps.get(KEY_A)!.app_secret = null;
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k7', 'halo')))).toBe(403);
        expect(h.db.events()).toEqual([
            { kind: 'webhook_signature_invalid', org: ORG, detail: 'app secret aplikasi ini tidak terbaca dari Vault', count: 1 },
        ]);
        expect(h.db.ingests()).toEqual([]);
    });
});

describe('POST: signed, acknowledged or answered without the walk', () => {
    it('a suspended app gets 200 and the batch is dropped, with a log line naming the app', async () => {
        h.db.webhookApps.get(KEY_A)!.status = 'suspended';
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k8', 'halo')))).toBe(200);
        expect(h.db.calls.map((c) => c.target)).toEqual(['rpc:wa_webhook_app']);
        expect(h.db.events()).toEqual([]);
        expect(logLines()).toContain(`Webhook for suspended app ${APP_A} — dropped`);
    });

    it('an app without a number gets 503 and webhook_unconfigured for its org', async () => {
        h.db.sendCreds.delete(ORG);
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k9', 'halo')))).toBe(503);
        expect(h.db.events()).toEqual([
            { kind: 'webhook_unconfigured', org: ORG, detail: 'aplikasi tanpa nomor di Sarathi; webhook menjawab 503, Meta mengirim ulang', count: 1 },
        ]);
        expect(h.db.ingests()).toEqual([]);
    });

    it('a paused number gets 200 and the batch is dropped', async () => {
        h.db.sendCreds.get(ORG)!.status = 'paused';
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k10', 'halo')))).toBe(200);
        expect(h.db.ingests()).toEqual([]);
        expect(h.db.chats).toEqual([]);
        expect(h.db.events()).toEqual([]);
        expect(logLines()).toContain(`Webhook for a paused number (app ${APP_A}) — dropped`);
    });

    it('a wa_org_send_credentials error gets 503 and webhook_error for the org', async () => {
        h.db.fail({ target: 'rpc:wa_org_send_credentials', error: { code: '57014' } });
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k11', 'halo')))).toBe(503);
        expect(h.db.events()).toEqual([
            { kind: 'webhook_error', org: ORG, detail: 'nomor WhatsApp tidak terbaca (database 57014); webhook menjawab 503, Meta mengirim ulang', count: 1 },
        ]);
        expect(h.db.ingests()).toEqual([]);
    });

    it('a signed body that is not JSON, not an object or not a WABA event gets 200 without reading the number', async () => {
        for (const raw of ['bukan json', 'null', '42', JSON.stringify({ object: 'page', entry: [] })]) {
            expect(await deliver(KEY_A, raw)).toBe(200);
        }
        expect(h.db.rpcCalls('wa_org_send_credentials')).toEqual([]);
    });
});

describe("POST: the app's own number", () => {
    it("a text is stored in the app's org and queued; the default org is never read", async () => {
        const body = delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.k12', 'halo, masih buka?')] }, OTHER_PNID)]);
        expect(await deliver(KEY_B, body, SECRET_B)).toBe(200);
        expect(h.db.ingests()).toEqual([expect.objectContaining({ p_org: OTHER_ORG, p_rate_scope: 'main', p_ai_eligible: true })]);
        expect(h.db.queue.map((j) => [j.org_id, j.wa_message_id])).toEqual([[OTHER_ORG, 'wamid.k12']]);
        expect(h.db.rpcCalls('wa_org_send_credentials')).toEqual([{ p_org: OTHER_ORG }]);
        await settleBackground();
        expect(processQueue).toHaveBeenCalled();
        expect(h.orgReads).toBe(0);
        expect(logLines().filter((l) => l.startsWith('Webhook received'))).toEqual([
            `Webhook received (app ${APP_B}): object=whatsapp_business_account entries=1 changes=1 fields=messages messages=1 statuses=0`,
        ]);
    });

    it("an inbound photo is downloaded with the app's Vault token", async () => {
        const image = { from: A, id: 'wamid.k13', timestamp: metaTs(), type: 'image', image: { id: 'media-palsu-1', mime_type: 'image/jpeg' } };
        expect(await deliver(KEY_A, one(image))).toBe(200);
        await settleBackground();
        expect(vi.mocked(downloadWhatsAppMedia).mock.calls).toEqual([
            [expect.objectContaining({ orgId: ORG, phoneNumberId: PNID, accessToken: TOKEN_A, wabaId: '200000000000001' }), 'media-palsu-1'],
        ]);
        expect(h.orgReads).toBe(0);
    });

    it("a token Vault could not decrypt: the message is still stored, with one webhook_unconfigured in the Vault's words", async () => {
        h.db.sendCreds.get(ORG)!.access_token = null;
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k14', 'halo')))).toBe(200);
        expect(h.db.events()).toEqual([{ kind: 'webhook_unconfigured', org: ORG, detail: VAULT_NO_TOKEN, count: 1 }]);
        expect(h.db.userRows().map((m) => m.wa_message_id)).toEqual(['wamid.k14']);
    });
});

describe('POST: tenant isolation', () => {
    it("a payload signed by app A that names B's number is dropped with webhook_unrouted, never written to B's org", async () => {
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k15', 'halo'), OTHER_PNID))).toBe(200);
        expect(h.db.ingests()).toEqual([]);
        expect(h.db.chats).toEqual([]);
        expect(kinds()).toEqual(['webhook_unrouted_new', 'webhook_unrouted']);
        expect(h.orgReads).toBe(0);
    });

    it("in process mode another number's message is stored without AI in the signing app's own org", async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        expect(await deliver(KEY_A, one(textMsg(A, 'wamid.k16', 'halo'), OTHER_PNID))).toBe(200);
        expect(h.db.ingests()).toEqual([expect.objectContaining({ p_org: ORG, p_rate_scope: 'other', p_ai_eligible: false })]);
        expect(h.db.userRows(OTHER_ORG)).toEqual([]);
    });

    it("statuses and user_id_update apply to the app's org only", async () => {
        for (const org of [ORG, OTHER_ORG]) {
            h.db.seedChat({ org_id: org, phone_number: A, bsuid: 'ID.lama' });
            h.db.seedAssistant('wamid.keluar-k', A, 'sent', org);
        }
        const body = delivery(
            [change({ statuses: [{ id: 'wamid.keluar-k', status: 'delivered', timestamp: metaTs(1_000), recipient_id: A }] }, OTHER_PNID)],
            [{ field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'ID.lama', current: 'ID.baru' } }] } }],
        );
        expect(await deliver(KEY_B, body, SECRET_B)).toBe(200);
        expect(h.db.rpcCalls('wa_apply_statuses').map((a) => a.p_org)).toEqual([OTHER_ORG]);
        expect(h.db.messages.map((m) => [m.org_id, m.status])).toEqual([
            [ORG, 'sent'],
            [OTHER_ORG, 'delivered'],
        ]);
        expect([h.db.chat(A, ORG)?.bsuid, h.db.chat(A, OTHER_ORG)?.bsuid]).toEqual(['ID.lama', 'ID.baru']);
        expect(h.orgReads).toBe(0);
    });
});
