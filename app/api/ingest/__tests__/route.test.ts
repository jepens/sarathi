import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/ingest (tracker 3.9): an upload that ends without any documents
// row is invisible in the KB list and could never be deleted, so the route
// removes its object; once a row is stored the entry is listed and
// deletable, and the object stays. The org gate itself is covered in
// app/api/__tests__/org-context-gates.test.ts.

const ORG = '5a11e024-0001-4000-8000-000000000001';
const PATH = `${ORG}/1760000000000_katalog.txt`;

const h = vi.hoisted(() => ({
    fileText: '' as string,
    downloadError: null as null | { message: string },
    insertErrors: [] as boolean[], // per insert call: true = error
    removed: [] as string[][],
    inserts: 0,
    generateEmbedding: vi.fn(async () => [0.1, 0.2]),
}));

const fakeSupabase = {
    storage: {
        from: (bucket: string) => {
            expect(bucket).toBe('documents');
            return {
                download: async () =>
                    h.downloadError
                        ? { data: null, error: h.downloadError }
                        : { data: new Blob([h.fileText]), error: null },
                remove: async (keys: string[]) => {
                    h.removed.push(keys);
                    return { data: [], error: null };
                },
            };
        },
    },
    from: (table: string) => {
        expect(table).toBe('documents');
        return {
            insert: async () => {
                const failed = h.insertErrors[h.inserts] ?? false;
                h.inserts++;
                return { error: failed ? { message: 'insert failed' } : null };
            },
        };
    },
};

vi.mock('@/lib/settings/org-context', () => ({
    requireOrgContext: vi.fn(async () => ({ ok: true, supabase: fakeSupabase, orgId: ORG })),
    accessDeniedResponse: vi.fn(),
}));
vi.mock('@/lib/ai/embedding', () => ({ generateEmbedding: h.generateEmbedding }));

import { POST } from '@/app/api/ingest/route';

const req = (body: unknown) =>
    new Request('http://localhost/api/ingest', { method: 'POST', body: JSON.stringify(body) });
const ingest = () => POST(req({ filePath: PATH, fileType: 'text/plain' }));

beforeEach(() => {
    h.fileText = '';
    h.downloadError = null;
    h.insertErrors = [];
    h.removed = [];
    h.inserts = 0;
    h.generateEmbedding.mockReset();
    h.generateEmbedding.mockImplementation(async () => [0.1, 0.2]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/ingest: no upload without a documents row', () => {
    it('stores the chunks and keeps the object', async () => {
        h.fileText = 'Jam buka 08.00-17.00.';
        const res = await ingest();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, chunks: 1 });
        expect(h.inserts).toBe(1);
        expect(h.removed).toEqual([]);
    });

    it('an empty or blank file: 422 and the object is removed (nothing to list)', async () => {
        for (const text of ['', '   \n\n  ']) {
            h.removed = [];
            h.fileText = text;
            const res = await ingest();
            expect(res.status).toBe(422);
            expect((await res.json()).error).toMatch(/File kosong/);
            expect(h.removed).toEqual([[PATH]]);
        }
        expect(h.inserts).toBe(0);
        expect(h.generateEmbedding).not.toHaveBeenCalled();
    });

    it('a failed download: 500 and the object is removed', async () => {
        h.downloadError = { message: 'boom' };
        const res = await ingest();
        expect(res.status).toBe(500);
        expect(h.removed).toEqual([[PATH]]);
    });

    it('every insert failed: 500 and the object is removed', async () => {
        h.fileText = 'Satu potongan.';
        h.insertErrors = [true];
        const res = await ingest();
        expect(res.status).toBe(500);
        expect(h.removed).toEqual([[PATH]]);
    });

    it('the first embedding throws: 500 and the object is removed', async () => {
        h.fileText = 'Satu potongan.';
        h.generateEmbedding.mockRejectedValueOnce(new Error('OpenAI down'));
        const res = await ingest();
        expect(res.status).toBe(500);
        expect(h.removed).toEqual([[PATH]]);
    });

    it('a failure after a row was stored keeps the object (the entry is listed and deletable)', async () => {
        h.fileText = Array.from({ length: 4 }, (_, i) => `Paragraf ${i} `.repeat(120)).join('\n\n');
        h.generateEmbedding
            .mockImplementationOnce(async () => [0.1])
            .mockRejectedValueOnce(new Error('OpenAI down'));
        const res = await ingest();
        expect(res.status).toBe(500);
        expect(h.inserts).toBe(1);
        expect(h.removed).toEqual([]);
    });

    it('reports the number of chunks actually stored', async () => {
        h.fileText = Array.from({ length: 4 }, (_, i) => `Paragraf ${i} `.repeat(120)).join('\n\n');
        h.insertErrors = [false, true];
        const res = await ingest();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.chunks).toBe(h.inserts - 1);
        expect(h.removed).toEqual([]);
    });

    it('never touches a path outside the org folder', async () => {
        const res = await POST(req({ filePath: 'lain-org/x.txt', fileType: 'text/plain' }));
        expect(res.status).toBe(400);
        expect(h.removed).toEqual([]);
        expect(h.inserts).toBe(0);
    });
});
