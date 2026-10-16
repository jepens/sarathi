import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/chat/send-media writes the dashboard's copy of an outbound file to
// the private chat-media bucket (tracker 1.11, migration 0067, owner decision
// D20): media_url holds the bare object key "<org>/<safe phone>/<uuid>.<ext>",
// the upload's content type is the bucket-allowed form of the MIME, and a file
// above the bucket limit is not uploaded at all while the message is still
// sent and recorded. The gate refusals are covered in
// app/api/__tests__/org-context-gates.test.ts. Fake ids and phones only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const h = vi.hoisted(() => ({
    upload: vi.fn(),
    storageFrom: vi.fn(),
    writes: [] as Array<{ table: string; op: string; row: Record<string, unknown> }>,
    uploadWhatsAppMedia: vi.fn(),
    sendWhatsAppMedia: vi.fn(),
    logs: [] as unknown[][],
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
        requireEnvIntegration: vi.fn(async () => ({
            ok: true,
            supabase: { from: table, storage: { from: h.storageFrom } },
            userId: 'user-a1',
            orgId: ORG,
            role: 'owner',
        })),
    };
});
vi.mock('@/lib/whatsapp/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/whatsapp/client')>();
    return {
        ...actual,
        uploadWhatsAppMedia: h.uploadWhatsAppMedia,
        sendWhatsAppMedia: h.sendWhatsAppMedia,
    };
});
vi.mock('@/lib/utils/logger', () => {
    const record = (...args: unknown[]) => void h.logs.push(args);
    return { whatsappLogger: { info: record, warn: record, error: record } };
});

import { POST } from '@/app/api/chat/send-media/route';
import { CHAT_MEDIA_MAX_BYTES } from '@/lib/storage/chat-media';

/** The route only calls request.formData() and form.get(). */
function mediaRequest(file: File, phone = PHONE): Request {
    const fields: Record<string, string | File> = { phone_number: phone, file };
    return { formData: async () => ({ get: (k: string) => fields[k] ?? null }) } as unknown as Request;
}

/** A real File whose reported size is `size` (without allocating it). */
function fileOfSize(name: string, type: string, size: number): File {
    const f = new File([new Uint8Array([1, 2, 3])], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
}

const messageInsert = () => h.writes.find((w) => w.table === 'whatsapp_messages' && w.op === 'insert')?.row;

beforeEach(() => {
    vi.clearAllMocks();
    h.writes = [];
    h.logs = [];
    h.upload.mockResolvedValue({ data: { path: 'ignored' }, error: null });
    h.storageFrom.mockImplementation(() => ({ upload: h.upload }));
    h.uploadWhatsAppMedia.mockResolvedValue('meta-media-id');
    h.sendWhatsAppMedia.mockResolvedValue({ waMessageId: 'wamid.fake-out-1', raw: {} });
});

describe('POST /api/chat/send-media: the chat-media copy', () => {
    it('uploads under <org>/<phone>/<uuid>.<ext> with the allowed content type and stores the bare key', async () => {
        const res = await POST(mediaRequest(new File([new Uint8Array([1, 2, 3])], 'foto.png', { type: 'image/png' })));

        expect(res.status).toBe(200);
        expect(h.storageFrom).toHaveBeenCalledWith('chat-media');
        expect(h.upload).toHaveBeenCalledTimes(1);
        const [path, bytes, options] = h.upload.mock.calls[0];
        expect(path).toMatch(new RegExp(`^${ORG}/${PHONE}/${UUID}\\.png$`));
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(options).toEqual({ contentType: 'image/png', upsert: false });
        expect(messageInsert()).toMatchObject({
            org_id: ORG,
            phone_number: PHONE,
            media_type: 'image',
            media_url: path, // the key itself, never a URL
            media_mime: 'image/png',
            media_filename: 'foto.png',
            wa_message_id: 'wamid.fake-out-1',
        });
    });

    it('keeps the phone segment a single safe folder (the layout D21 finds a contact by)', async () => {
        await POST(mediaRequest(new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' }), '62 000/../x'));

        const [path] = h.upload.mock.calls[0];
        expect(path).toMatch(new RegExp(`^${ORG}/62_000_\\.\\._x/${UUID}\\.pdf$`));
        expect(path.split('/')).toHaveLength(3);
    });

    it('still uploads a document of exactly 50 MiB', async () => {
        await POST(mediaRequest(fileOfSize('batas.pdf', 'application/pdf', CHAT_MEDIA_MAX_BYTES)));

        expect(h.upload).toHaveBeenCalledTimes(1);
        expect(h.upload.mock.calls[0][2]).toEqual({ contentType: 'application/pdf', upsert: false });
        expect(messageInsert()?.media_url).toEqual(h.upload.mock.calls[0][0]);
    });

    it('above 50 MiB: no upload at all, but the document is sent and recorded with media_url null (D20)', async () => {
        const res = await POST(mediaRequest(fileOfSize('proposal-besar.pdf', 'application/pdf', CHAT_MEDIA_MAX_BYTES + 1)));

        expect(res.status).toBe(200);
        expect(h.storageFrom).not.toHaveBeenCalled();
        expect(h.upload).not.toHaveBeenCalled();
        expect(h.uploadWhatsAppMedia).toHaveBeenCalledTimes(1);
        expect(h.sendWhatsAppMedia).toHaveBeenCalledTimes(1);
        expect(messageInsert()).toMatchObject({
            media_type: 'document',
            media_url: null,
            media_mime: 'application/pdf',
            media_filename: 'proposal-besar.pdf',
            wa_message_id: 'wamid.fake-out-1',
        });
        // The skip is logged without the key or the phone.
        const skipLog = h.logs.find((args) => String(args[0]).includes('skipped'));
        expect(skipLog).toBeDefined();
        expect(JSON.stringify(skipLog)).not.toContain(PHONE);
        expect(JSON.stringify(skipLog)).not.toContain(ORG);
    });

    it('records the sent message with media_url null when the upload fails', async () => {
        h.upload.mockResolvedValue({ data: null, error: { message: 'Storage unavailable' } });

        const res = await POST(mediaRequest(new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' })));

        expect(res.status).toBe(200);
        expect(h.sendWhatsAppMedia).toHaveBeenCalledTimes(1);
        expect(messageInsert()).toMatchObject({ media_type: 'document', media_url: null });
    });
});
