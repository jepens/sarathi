import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Inbound media in the WhatsApp webhook (tracker 1.11, migration 0067, owner
// decision D20): the customer's file is copied to the private chat-media
// bucket under "<org>/<safe phone>/<uuid>.<ext>" with the bucket-allowed
// content type, media_url holds that bare key and media_mime keeps Meta's
// original type; a file above the bucket limit is not uploaded at all while
// the message is still recorded (media_url null); a file sent to another
// number of the WABA in process mode is stored without the 24-hour window,
// marked for the AI history, with a note. Everything around the
// webhook (signature, credentials, Meta download, push) is stubbed; the media
// handler runs fire-and-forget after the 200, so the tests wait for its insert.
// Fake ids and phones only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const h = vi.hoisted(() => ({
    download: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
    insertError: null as unknown,
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    rpcs: [] as string[],
    /** The bucket of every storage.from() call. */
    buckets: [] as string[],
    logs: [] as unknown[][],
    sendPushToOrg: vi.fn(),
}));

function serviceClient() {
    const builder = (table: string) => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'update', 'like', 'gte']) q[m] = () => q;
        q.upsert = (row: Record<string, unknown>) => {
            h.upserts.push({ table, row });
            return q;
        };
        // The ops_events lookup for another number: reported before.
        q.limit = async () => ({ data: [{ id: 1 }], error: null });
        q.insert = (row: Record<string, unknown>) => {
            h.inserts.push({ table, row });
            return Promise.resolve({ data: null, error: table === 'whatsapp_messages' ? h.insertError : null });
        };
        q.maybeSingle = async () => ({ data: table === 'whatsapp_chats' ? { contact_name: null } : null, error: null });
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
        return q;
    };
    return {
        from: builder,
        rpc: async (fn: string) => {
            h.rpcs.push(fn);
            return { data: null, error: null };
        },
        storage: {
            from: (bucket: string) => {
                h.buckets.push(bucket);
                return { upload: h.upload, remove: h.remove };
            },
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
vi.mock('@/lib/whatsapp/client', () => ({
    downloadWhatsAppMedia: h.download,
    sendWhatsAppMessage: vi.fn(),
}));
vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: h.sendPushToOrg }));
vi.mock('@/lib/whatsapp/rate-limiter-db', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/whatsapp/queue-db', () => ({
    enqueueMessage: vi.fn(),
    processQueue: vi.fn(async () => {}),
    getDebounceSeconds: () => 0,
}));
vi.mock('@/lib/whatsapp/recipient', () => ({ resolveSendTarget: vi.fn() }));
vi.mock('@/lib/whatsapp/history', () => ({ logSystemMessage: vi.fn() }));
vi.mock('@/lib/whatsapp/flow-response', () => ({ handleFlowReply: vi.fn() }));
vi.mock('@/lib/settings/app-settings', () => ({ checkVerifyToken: vi.fn() }));
vi.mock('@/lib/utils/logger', () => {
    const record = (...args: unknown[]) => void h.logs.push(args);
    return { whatsappLogger: { info: record, warn: record, error: record, debug: record } };
});

import { POST } from '@/app/api/webhook/whatsapp/route';
import { CHAT_MEDIA_MAX_BYTES } from '@/lib/storage/chat-media';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { resetOtherNumberState } from '@/lib/whatsapp/other-number';

let seq = 0;

/** A webhook delivery of one inbound media message. */
function inbound(type: 'image' | 'document' | 'audio' | 'video', media: Record<string, unknown>, phoneNumberId = 'phone-number-id'): Request {
    seq += 1;
    const body = {
        object: 'whatsapp_business_account',
        entry: [
            {
                changes: [
                    {
                        field: 'messages',
                        value: {
                            metadata: { phone_number_id: phoneNumberId },
                            contacts: [{ wa_id: PHONE }],
                            messages: [{ from: PHONE, id: `wamid.fake-in-${seq}`, type, [type]: { id: `media-${seq}`, ...media } }],
                        },
                    },
                ],
            },
        ],
    };
    return new Request('http://localhost/api/webhook/whatsapp', { method: 'POST', body: JSON.stringify(body) });
}

/** POST, check the fast 200, then wait for the fire-and-forget media handler. */
async function deliver(req: Request): Promise<Record<string, unknown>> {
    const res = await POST(req);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(h.inserts.some((i) => i.table === 'whatsapp_messages')).toBe(true));
    return h.inserts.find((i) => i.table === 'whatsapp_messages')!.row;
}

beforeEach(() => {
    vi.clearAllMocks();
    // The webhook only works with the service-role client.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
    h.inserts = [];
    h.upserts = [];
    h.rpcs = [];
    resetOtherNumberState();
    h.buckets = [];
    h.logs = [];
    h.insertError = null;
    h.upload.mockResolvedValue({ data: { path: 'ignored' }, error: null });
    h.remove.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('webhook inbound media: the chat-media copy', () => {
    it('stores a voice note under <org>/<phone>/<uuid>.ogg as audio/ogg and keeps the bare key', async () => {
        h.download.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'audio/ogg; codecs=opus', size: 3 });

        const row = await deliver(inbound('audio', { voice: true, mime_type: 'audio/ogg; codecs=opus' }));

        expect(h.upload).toHaveBeenCalledTimes(1);
        expect(h.buckets).toEqual(['chat-media']); // the private bucket /api/chat-media signs from
        const [path, bytes, options] = h.upload.mock.calls[0];
        expect(path).toMatch(new RegExp(`^${ORG}/${PHONE}/${UUID}\\.ogg$`));
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(options).toEqual({ contentType: 'audio/ogg', upsert: false });
        expect(row).toMatchObject({
            org_id: ORG,
            phone_number: PHONE,
            role: 'user',
            media_type: 'audio',
            media_url: path, // the key itself, never a URL
            media_mime: 'audio/ogg; codecs=opus', // Meta's original type
        });
        expect(row).not.toHaveProperty('metadata');
        // The customer wrote to this number: the 24-hour window opens.
        expect(h.upserts.find((u) => u.table === 'whatsapp_chats')!.row).toHaveProperty('last_inbound_at');
    });

    it('a file sent to another number of the WABA (process mode): no 24-hour window, marked for the AI history, one note', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        h.download.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', size: 3 });

        const row = await deliver(inbound('image', {}, 'other-number-id'));

        expect(row).toMatchObject({ org_id: ORG, role: 'user', media_type: 'image', metadata: { other_number: expect.stringMatching(/^h[0-9a-f]{10}$/) } });
        const chat = h.upserts.find((u) => u.table === 'whatsapp_chats')!.row;
        expect(chat).toMatchObject({ org_id: ORG, phone_number: PHONE });
        expect(chat).not.toHaveProperty('last_inbound_at');
        await vi.waitFor(() => expect(h.rpcs).toContain('bump_unread'));
        expect(logSystemMessage).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logSystemMessage).mock.calls[0][2]).toContain('nomor WhatsApp lain');
    });

    it('stores an unknown document type as application/octet-stream (a download), media_mime unchanged', async () => {
        h.download.mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'application/zip', size: 1 });

        const row = await deliver(inbound('document', { filename: 'arsip.zip' }));

        const [path, , options] = h.upload.mock.calls[0];
        expect(path).toMatch(new RegExp(`^${ORG}/${PHONE}/${UUID}\\.zip$`));
        expect(options).toEqual({ contentType: 'application/octet-stream', upsert: false });
        expect(row).toMatchObject({ media_type: 'document', media_url: path, media_mime: 'application/zip' });
    });

    it('above 50 MiB: no upload at all, the message is still recorded with media_url null (D20)', async () => {
        h.download.mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'application/pdf', size: CHAT_MEDIA_MAX_BYTES + 1 });

        const row = await deliver(inbound('document', { filename: 'katalog-besar.pdf' }));

        expect(h.upload).not.toHaveBeenCalled();
        expect(row).toMatchObject({
            media_type: 'document',
            media_url: null,
            media_mime: 'application/pdf',
            media_filename: 'katalog-besar.pdf',
        });
        // Handled like any inbound message (unread badge), and the skip is
        // logged without the key or the phone.
        await vi.waitFor(() => expect(h.rpcs).toContain('bump_unread'));
        const skipLog = h.logs.find((args) => String(args[0]).includes('skipped'));
        expect(skipLog).toBeDefined();
        expect(JSON.stringify(skipLog)).not.toContain(PHONE);
        expect(JSON.stringify(skipLog)).not.toContain(ORG);
    });

    it('still uploads a file of exactly 50 MiB', async () => {
        h.download.mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'video/mp4', size: CHAT_MEDIA_MAX_BYTES });

        const row = await deliver(inbound('video', {}));

        expect(h.upload).toHaveBeenCalledTimes(1);
        expect(row.media_url).toBe(h.upload.mock.calls[0][0]);
    });

    it('removes the orphan object by its key when a redelivery won the insert race', async () => {
        h.download.mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'image/jpeg', size: 1 });
        h.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };

        await deliver(inbound('image', {}));

        await vi.waitFor(() => expect(h.remove).toHaveBeenCalledTimes(1));
        expect(h.remove).toHaveBeenCalledWith([h.upload.mock.calls[0][0]]);
        expect(h.buckets).toEqual(['chat-media', 'chat-media']); // upload, then remove, same bucket
    });
});
