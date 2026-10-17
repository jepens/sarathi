import { describe, it, expect, vi, beforeEach } from 'vitest';

// DELETE /api/leads/[phone] (owner decision D21): deleting a contact also
// removes its chat-media files and its uploaded proposal PDFs. The keys are
// read before the rows go (the keys its messages name + the older files of
// its own folder; the file_path of its proposals), the files removed through
// the Storage API with the member's client only once the cascade succeeded;
// if the keys cannot be read, nothing is deleted. Fake ids and phone numbers
// only.

const ORG = '5a11e024-0001-4000-8000-000000000001';
const OTHER = '0b0e6c1e-1111-4222-8333-444455556666';
const PHONE = '620000000001';
const ORIGIN = 'https://abcdefghijklmnop.supabase.co';
const key = (name: string, phone = PHONE, org = ORG) => `${org}/${phone}/${name}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type Entry = { name: string; id: string | null; created_at?: string | null };

const h = vi.hoisted(() => ({
    order: [] as string[],
    /** The message query's filters, as "<method>(<json args>)". */
    filters: [] as string[],
    messageRows: [] as { media_url: string | null }[],
    readError: null as null | { code: string },
    folderEntries: [] as Entry[],
    listError: false,
    listCalls: [] as { folder: string; offset: number }[],
    removed: [] as string[][],
    removeError: false,
    rpcResult: { deleted: true } as Record<string, unknown>,
    rpcError: null as null | { message: string },
    proposalRows: [] as { file_path: string | null }[],
    proposalReadError: null as null | { code: string },
    /** The proposals query's filters. */
    proposalFilters: [] as string[],
    removedProposals: [] as string[][],
}));

const fakeSupabase = {
    from: (table: string) => {
        expect(['whatsapp_messages', 'proposals']).toContain(table);
        const proposals = table === 'proposals';
        const filters = proposals ? h.proposalFilters : h.filters;
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'not']) {
            q[m] = (...args: unknown[]) => {
                filters.push(`${m}(${args.map((a) => JSON.stringify(a)).join(',')})`);
                return q;
            };
        }
        q.then = (resolve: (v: unknown) => unknown) => {
            if (proposals) {
                h.order.push('read proposals');
                return resolve(
                    h.proposalReadError ? { data: null, error: h.proposalReadError } : { data: h.proposalRows, error: null }
                );
            }
            h.order.push('read messages');
            return resolve(h.readError ? { data: null, error: h.readError } : { data: h.messageRows, error: null });
        };
        return q;
    },
    storage: {
        from: (bucket: string) => {
            if (bucket === 'proposals') {
                return {
                    remove: async (keys: string[]) => {
                        h.order.push('remove proposals');
                        h.removedProposals.push(keys);
                        return { data: [], error: null };
                    },
                };
            }
            expect(bucket).toBe('chat-media');
            return {
                list: async (folder: string, opts: { limit: number; offset: number }) => {
                    h.order.push('list');
                    h.listCalls.push({ folder, offset: opts.offset });
                    if (h.listError) return { data: null, error: { message: 'Storage unavailable' } };
                    return { data: h.folderEntries.slice(opts.offset, opts.offset + opts.limit), error: null };
                },
                remove: async (keys: string[]) => {
                    h.order.push('remove');
                    h.removed.push(keys);
                    return h.removeError ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
                },
            };
        },
    },
    rpc: async (fn: string) => {
        expect(fn).toBe('delete_contact_cascade');
        h.order.push('cascade');
        return h.rpcError ? { data: null, error: h.rpcError } : { data: h.rpcResult, error: null };
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
    h.filters = [];
    h.messageRows = [];
    h.readError = null;
    h.folderEntries = [];
    h.listError = false;
    h.listCalls = [];
    h.removed = [];
    h.removeError = false;
    h.rpcResult = { deleted: true };
    h.rpcError = null;
    h.proposalRows = [];
    h.proposalReadError = null;
    h.proposalFilters = [];
    h.removedProposals = [];
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
            { name: 'b.pdf', id: 'id-b', created_at: ago(1) }, // named by a message: goes even when new
            { name: 'orphan.ogg', id: 'id-o', created_at: ago(60) }, // an upload whose message insert failed
            { name: 'sub', id: null, created_at: null }, // a folder entry, not a file
        ];
        const res = await del();
        expect(res.status).toBe(200);
        expect(h.order).toEqual(['read messages', 'list', 'read proposals', 'cascade', 'remove']);
        // Only this org's rows of this phone that hold media.
        expect(h.filters).toEqual([
            'select("media_url")',
            `eq("org_id","${ORG}")`,
            `eq("phone_number","${PHONE}")`,
            'not("media_url","is",null)',
        ]);
        expect(h.listCalls).toEqual([{ folder: `${ORG}/${PHONE}`, offset: 0 }]);
        expect(h.removed.flat().sort()).toEqual([key('a.jpg'), key('b.pdf'), key('orphan.ogg')].sort());
    });

    it('keeps a recent file no message names yet: it may belong to a message being written right now', async () => {
        h.folderEntries = [
            { name: 'in-flight.jpg', id: 'id-f', created_at: ago(2) },
            { name: 'undated.jpg', id: 'id-u', created_at: null },
            { name: 'old-orphan.jpg', id: 'id-o', created_at: ago(11) },
        ];
        const res = await del();
        expect(res.status).toBe(200);
        expect(h.removed).toEqual([[key('old-orphan.jpg')]]);
    });

    it('a contact with bookings is refused and keeps its files', async () => {
        h.messageRows = [{ media_url: key('a.jpg') }];
        h.proposalRows = [{ file_path: `${ORG}/${PHONE}/p.pdf` }];
        h.rpcResult = { deleted: false, reason: 'has_bookings', orders: 1 };
        const res = await del();
        expect(res.status).toBe(409);
        expect(h.removed).toEqual([]);
        expect(h.removedProposals).toEqual([]);
    });

    it('its uploaded proposal PDFs go too: read before the cascade, removed after, only in its org', async () => {
        h.proposalRows = [
            { file_path: `${ORG}/${PHONE}/p1.pdf` },
            { file_path: `${ORG}/${PHONE}/p1.pdf` }, // the same file twice
            { file_path: `${OTHER}/${PHONE}/x.pdf` }, // another org's key: never
            { file_path: `${ORG}/../${OTHER}/y.pdf` }, // a traversal: never
        ];
        const res = await del();
        expect(res.status).toBe(200);
        expect(h.proposalFilters).toEqual([
            'select("file_path")',
            `eq("org_id","${ORG}")`,
            `eq("lead_phone","${PHONE}")`,
            'not("file_path","is",null)',
        ]);
        expect(h.order).toEqual(['read messages', 'list', 'read proposals', 'cascade', 'remove proposals']);
        expect(h.removedProposals).toEqual([[`${ORG}/${PHONE}/p1.pdf`]]);
    });

    it('a contact that is already gone removes nothing', async () => {
        h.folderEntries = [{ name: 'a.jpg', id: 'id-a', created_at: ago(60) }];
        h.rpcResult = { deleted: false, reason: 'not_found' };
        const res = await del();
        expect(res.status).toBe(404);
        expect(h.removed).toEqual([]);
    });

    it.each([
        ['+620000000001', '_620000000001'], // a character the writers replace
        ['_620000000001', '_620000000001'], // '_' itself: '+620000000001' writes to the same folder
    ])('the phone %s shares its folder with others: only the keys its own messages name, no listing', async (phone, segment) => {
        h.messageRows = [{ media_url: key('a.jpg', segment) }];
        h.folderEntries = [{ name: 'someone-else.jpg', id: 'id-x', created_at: ago(60) }];
        const res = await del(phone);
        expect(res.status).toBe(200);
        expect(h.listCalls).toEqual([]);
        expect(h.removed).toEqual([[key('a.jpg', segment)]]);
    });

    it('no media: no Storage remove call', async () => {
        const res = await del();
        expect(res.status).toBe(200);
        expect(h.order).toEqual(['read messages', 'list', 'read proposals', 'cascade']);
    });

    it('removes in batches of 100 and pages through a large folder', async () => {
        h.folderEntries = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.jpg`, id: `id-${i}`, created_at: ago(60) }));
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

describe('DELETE /api/leads/[phone]: nothing is deleted when the keys cannot be read', () => {
    it('the message read fails: 503, no listing, no cascade, no remove', async () => {
        h.readError = { code: '57014' };
        const res = await del();
        expect(res.status).toBe(503);
        expect((await res.json()).error).toMatch(/Tidak ada yang dihapus/);
        expect(h.order).toEqual(['read messages']);
    });

    it('the folder listing fails: 503, no cascade, no remove', async () => {
        h.messageRows = [{ media_url: key('a.jpg') }];
        h.listError = true;
        const res = await del();
        expect(res.status).toBe(503);
        expect(h.order).toEqual(['read messages', 'list']);
        expect(h.removed).toEqual([]);
    });

    it('the proposal read fails: 503, no cascade, no remove', async () => {
        h.messageRows = [{ media_url: key('a.jpg') }];
        h.proposalRows = [{ file_path: `${ORG}/${PHONE}/p.pdf` }];
        h.proposalReadError = { code: '57014' };
        const res = await del();
        expect(res.status).toBe(503);
        expect(h.order).toEqual(['read messages', 'list', 'read proposals']);
        expect(h.removed).toEqual([]);
        expect(h.removedProposals).toEqual([]);
    });

    it('the cascade fails: 500 and the files stay', async () => {
        h.messageRows = [{ media_url: key('a.jpg') }];
        h.rpcError = { message: 'canceling statement due to statement timeout' };
        const res = await del();
        expect(res.status).toBe(500);
        expect(h.removed).toEqual([]);
    });
});
