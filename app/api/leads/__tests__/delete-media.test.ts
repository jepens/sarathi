import { describe, it, expect, vi, beforeEach } from 'vitest';

// DELETE /api/leads/[phone] (owner decision D21): deleting a contact also
// removes its chat-media files. The keys are read before the rows go (the
// keys its messages name + its own folder), the files removed through the
// Storage API with the member's client only once the cascade succeeded. Fake
// ids and phone numbers only.

const ORG = '5a11e024-0001-4000-8000-000000000001';
const OTHER = '0b0e6c1e-1111-4222-8333-444455556666';
const PHONE = '620000000001';
const ORIGIN = 'https://abcdefghijklmnop.supabase.co';
const key = (name: string, phone = PHONE, org = ORG) => `${org}/${phone}/${name}`;

const h = vi.hoisted(() => ({
    order: [] as string[],
    messageRows: [] as { media_url: string | null }[],
    folderEntries: [] as { name: string; id: string | null }[],
    listCalls: [] as { folder: string; offset: number }[],
    removed: [] as string[][],
    removeError: false,
    rpcResult: { deleted: true } as Record<string, unknown>,
}));

const fakeSupabase = {
    from: (table: string) => {
        expect(table).toBe('whatsapp_messages');
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'not']) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown) => {
            h.order.push('read messages');
            return resolve({ data: h.messageRows, error: null });
        };
        return q;
    },
    storage: {
        from: (bucket: string) => {
            expect(bucket).toBe('chat-media');
            return {
                list: async (folder: string, opts: { limit: number; offset: number }) => {
                    h.order.push('list');
                    h.listCalls.push({ folder, offset: opts.offset });
                    return { data: h.folderEntries.slice(opts.offset, opts.offset + opts.limit), error: null };
                },
                remove: async (keys: string[]) => {
                    h.order.push('remove');
                    h.removed.push(keys);
                    return { data: [], error: h.removeError ? { message: 'boom' } : null };
                },
            };
        },
    },
    rpc: async (fn: string) => {
        expect(fn).toBe('delete_contact_cascade');
        h.order.push('cascade');
        return { data: h.rpcResult, error: null };
    },
};

vi.mock('@/lib/settings/org-context', () => ({
    requireOrgContext: vi.fn(async () => ({ ok: true, supabase: fakeSupabase, orgId: ORG })),
    accessDeniedResponse: vi.fn(),
}));

import { DELETE } from '@/app/api/leads/[phone]/route';

const del = (phone = PHONE) =>
    DELETE(new Request(`http://localhost/api/leads/${encodeURIComponent(phone)}`, { method: 'DELETE' }), {
        params: Promise.resolve({ phone }),
    });

beforeEach(() => {
    h.order = [];
    h.messageRows = [];
    h.folderEntries = [];
    h.listCalls = [];
    h.removed = [];
    h.removeError = false;
    h.rpcResult = { deleted: true };
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe("DELETE /api/leads/[phone]: the contact's media files go with it (D21)", () => {
    it("reads the keys first, then deletes the rows, then removes exactly the contact's files", async () => {
        h.messageRows = [
            { media_url: `${ORIGIN}/storage/v1/object/public/chat-media/${key('a.jpg')}` }, // old row: public URL
            { media_url: key('b.pdf') }, // new row: bare key
            { media_url: key('b.pdf') }, // the same file twice
            { media_url: key('x.jpg', PHONE, OTHER) }, // another org's key: never
            { media_url: null },
        ];
        h.folderEntries = [
            { name: 'b.pdf', id: 'id-b' },
            { name: 'orphan.ogg', id: 'id-o' }, // an upload whose message insert failed
            { name: 'sub', id: null }, // a folder entry, not a file
        ];
        const res = await del();
        expect(res.status).toBe(200);
        expect(h.order).toEqual(['read messages', 'list', 'cascade', 'remove']);
        expect(h.listCalls).toEqual([{ folder: `${ORG}/${PHONE}`, offset: 0 }]);
        expect(h.removed.flat().sort()).toEqual([key('a.jpg'), key('b.pdf'), key('orphan.ogg')].sort());
    });

    it('a contact with bookings is refused and keeps its files', async () => {
        h.messageRows = [{ media_url: key('a.jpg') }];
        h.rpcResult = { deleted: false, reason: 'has_bookings', orders: 1 };
        const res = await del();
        expect(res.status).toBe(409);
        expect(h.removed).toEqual([]);
    });

    it('a contact that is already gone removes nothing', async () => {
        h.folderEntries = [{ name: 'a.jpg', id: 'id-a' }];
        h.rpcResult = { deleted: false, reason: 'not_found' };
        const res = await del();
        expect(res.status).toBe(404);
        expect(h.removed).toEqual([]);
    });

    it('a phone that is not a segment as it is: only the keys its own messages name, no folder listing', async () => {
        const phone = '+620000000001';
        h.messageRows = [{ media_url: key('a.jpg', '_620000000001') }];
        h.folderEntries = [{ name: 'someone-else.jpg', id: 'id-x' }];
        const res = await del(phone);
        expect(res.status).toBe(200);
        expect(h.listCalls).toEqual([]);
        expect(h.removed).toEqual([[key('a.jpg', '_620000000001')]]);
    });

    it('no media: no Storage remove call', async () => {
        const res = await del();
        expect(res.status).toBe(200);
        expect(h.order).toEqual(['read messages', 'list', 'cascade']);
    });

    it('removes in batches of 100 and pages through a large folder', async () => {
        h.folderEntries = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.jpg`, id: `id-${i}` }));
        const res = await del();
        expect(res.status).toBe(200);
        expect(h.listCalls).toEqual([
            { folder: `${ORG}/${PHONE}`, offset: 0 },
            { folder: `${ORG}/${PHONE}`, offset: 1000 },
        ]);
        expect(h.removed.map((b) => b.length)).toEqual([...Array(10).fill(100), 1]);
    });

    it('a failed remove still answers 200 (the contact is gone) and logs no key', async () => {
        h.messageRows = [{ media_url: key('a.jpg') }];
        h.removeError = true;
        const res = await del();
        expect(res.status).toBe(200);
        const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(' ');
        expect(logged).not.toContain(PHONE);
        expect(logged).not.toContain(ORG);
    });
});
