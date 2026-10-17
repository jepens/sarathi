import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GET /api/chat-media/[id] (tracker 1.11, audit KEA-4, migration 0067). The
// REAL requireOrgContext() runs over a stubbed cookie-bound client, like
// app/api/__tests__/org-context-gates.test.ts:
//   - no session / no membership → refused before any message or Storage call;
//   - every failure (bad id, no row, null or foreign media_url, signing error)
//     → the same bare 404, nothing signed, nothing identifying logged;
//   - success → createSignedUrl(key, 600 s, or 3600 s for a voice note or a
//     video) on the USER's client, then a 302 to the signed URL with
//     Cache-Control: private, max-age=300 and Vary: Cookie.
// Fake ids and phone segments only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';
const MSG_ID = '5e1f0000-0000-4000-8000-0000000000c1';
const PHONE = '620000000000';
const KEY = `${ORG}/${PHONE}/5e1f0000-0000-4000-8000-000000000001.jpg`;
const ORIGIN = 'https://abcdefghijklmnop.supabase.co';
const PUBLIC_URL = `${ORIGIN}/storage/v1/object/public/chat-media/${KEY}`;
const SIGNED_URL = `${ORIGIN}/storage/v1/object/sign/chat-media/${KEY}?token=fake-signature-for-tests`;

const h = vi.hoisted(() => ({
    session: true,
    member: true,
    /** Every query-builder call, as "<table>.<method>(<json args>)". */
    calls: [] as string[],
    tables: [] as string[],
    buckets: [] as string[],
    row: null as unknown,
    rowError: null as unknown,
    createSignedUrl: vi.fn(),
    createServiceOrServerClient: vi.fn(),
}));

function query(table: string) {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) {
        q[m] = (...args: unknown[]) => {
            h.calls.push(`${table}.${m}(${args.map((a) => JSON.stringify(a)).join(',')})`);
            return q;
        };
    }
    q.maybeSingle = async () => {
        if (table === 'organization_members') {
            return { data: h.member ? { org_id: ORG, role: 'staff' } : null, error: null };
        }
        return { data: h.row, error: h.rowError };
    };
    return q;
}

const fakeClient = {
    auth: {
        getClaims: vi.fn(async () =>
            h.session ? { data: { claims: { sub: 'user-a2' } }, error: null } : { data: null, error: null }
        ),
    },
    from: (table: string) => {
        h.tables.push(table);
        return query(table);
    },
    storage: {
        from: (bucket: string) => {
            h.buckets.push(bucket);
            return { createSignedUrl: h.createSignedUrl };
        },
    },
};

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => fakeClient) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceOrServerClient: h.createServiceOrServerClient }));

import { GET } from '@/app/api/chat-media/[id]/route';
import { NO_ORG_MESSAGE, NOT_SIGNED_IN_MESSAGE } from '@/lib/settings/org-access';

const get = (id: string) =>
    GET(new Request(`http://localhost/api/chat-media/${encodeURIComponent(id)}`), {
        params: Promise.resolve({ id }),
    });

let logs: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    h.session = true;
    h.member = true;
    h.calls = [];
    h.tables = [];
    h.buckets = [];
    h.row = { media_url: PUBLIC_URL, media_type: 'image' };
    h.rowError = null;
    h.createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    logs = (['log', 'info', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {})
    );
});

afterEach(() => {
    for (const spy of logs) spy.mockRestore();
});

/** Everything written to the console during the test, as one string. */
function logged(): string {
    return logs.flatMap((spy) => spy.mock.calls.flat()).map((v) => JSON.stringify(v) ?? String(v)).join('\n');
}

describe('GET /api/chat-media/[id]: the gate', () => {
    it('401 without a session, before any query or Storage call', async () => {
        h.session = false;
        const res = await get(MSG_ID);

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: NOT_SIGNED_IN_MESSAGE });
        expect(h.tables).toEqual([]);
        expect(h.buckets).toEqual([]);
        expect(h.createSignedUrl).not.toHaveBeenCalled();
    });

    it('403 without an org membership: only the membership lookup ran', async () => {
        h.member = false;
        const res = await get(MSG_ID);

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: NO_ORG_MESSAGE });
        expect(h.tables).toEqual(['organization_members']);
        expect(h.buckets).toEqual([]);
        expect(h.createSignedUrl).not.toHaveBeenCalled();
    });
});

describe('GET /api/chat-media/[id]: success', () => {
    it.each([
        ['the public URL of an old row', PUBLIC_URL],
        ['a bare key (rows written since 1.11)', KEY],
        ['a signed URL', SIGNED_URL],
    ])('302 to a fresh signed URL for %s', async (_label, mediaUrl) => {
        h.row = { media_url: mediaUrl, media_type: 'image' };
        const res = await get(MSG_ID);

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(SIGNED_URL);
        expect(res.headers.get('cache-control')).toBe('private, max-age=300');
        // A browser must not reuse the redirect once the session cookie changed (sign-out).
        expect(res.headers.get('vary')).toBe('Cookie');
        // The member's own client signs the key of THEIR org, for 600 s.
        expect(h.buckets).toEqual(['chat-media']);
        expect(h.createSignedUrl).toHaveBeenCalledTimes(1);
        expect(h.createSignedUrl).toHaveBeenCalledWith(KEY, 600);
        expect(h.createServiceOrServerClient).not.toHaveBeenCalled();
    });

    it.each([
        ['image', 600],
        ['document', 600],
        [null, 600],
        // A media element sends its later range requests straight to the signed
        // URL (ChatMediaPlayer renews it), so voice notes and videos get an hour.
        ['audio', 3600],
        ['video', 3600],
    ])('signs a %s for %i s', async (mediaType, seconds) => {
        h.row = { media_url: KEY, media_type: mediaType };
        const res = await get(MSG_ID);

        expect(res.status).toBe(302);
        expect(h.createSignedUrl).toHaveBeenCalledWith(KEY, seconds);
    });

    it('reads only media_url and media_type of that id, filtered to the member org', async () => {
        await get(MSG_ID);

        expect(h.tables).toEqual(['organization_members', 'whatsapp_messages']);
        expect(h.calls.filter((c) => c.startsWith('whatsapp_messages.'))).toEqual([
            'whatsapp_messages.select("media_url, media_type")',
            `whatsapp_messages.eq("org_id","${ORG}")`,
            `whatsapp_messages.eq("id","${MSG_ID}")`,
        ]);
    });
});

describe('GET /api/chat-media/[id]: every failure is the same bare 404', () => {
    async function expectBare404(res: Response) {
        expect(res.status).toBe(404);
        expect(res.headers.get('location')).toBeNull();
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.text()).toBe('Not found');
    }

    it.each(['not-a-uuid', `${MSG_ID}x`, '../x', ''])('for the id %j, before the message query', async (id) => {
        await expectBare404(await get(id));
        expect(h.tables).toEqual(['organization_members']);
        expect(h.createSignedUrl).not.toHaveBeenCalled();
    });

    it.each([
        ['no row (missing, or another org under RLS)', null],
        ['a null media_url (no copy stored)', { media_url: null }],
        ["another org's key", { media_url: `${OTHER_ORG}/${PHONE}/x.jpg` }],
        ["another org's public URL", { media_url: `${ORIGIN}/storage/v1/object/public/chat-media/${OTHER_ORG}/${PHONE}/x.jpg` }],
        ['a traversal out of the org folder', { media_url: `${ORG}/../${OTHER_ORG}/x.jpg` }],
        // storage-js would send the decoded '%3F' unencoded: Storage reads it as '?'.
        ['a key that still holds an escape after one decode', { media_url: `${ORG}/${PHONE}/a%253Fb.jpg` }],
        ['another bucket', { media_url: `${ORIGIN}/storage/v1/object/public/documents/${KEY}` }],
        ['an unrelated URL', { media_url: `https://example.com/${KEY}` }],
    ])('for %s, without signing', async (_label, row) => {
        h.row = row;
        await expectBare404(await get(MSG_ID));
        expect(h.createSignedUrl).not.toHaveBeenCalled();
    });

    it('when the message query fails, without signing or logging the id', async () => {
        h.rowError = { code: '57014', message: 'canceling statement due to statement timeout' };
        await expectBare404(await get(MSG_ID));
        expect(h.createSignedUrl).not.toHaveBeenCalled();
        expect(logged()).not.toContain(MSG_ID);
    });

    it.each([
        ['an error', { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400 } }],
        ['no URL', { data: { signedUrl: '' }, error: null }],
    ])('when signing returns %s, logging no key, URL, phone or id', async (_label, result) => {
        h.createSignedUrl.mockResolvedValue(result);
        await expectBare404(await get(MSG_ID));

        expect(h.createSignedUrl).toHaveBeenCalledWith(KEY, 600);
        const out = logged();
        for (const secret of [KEY, PUBLIC_URL, SIGNED_URL, PHONE, MSG_ID]) expect(out).not.toContain(secret);
    });
});

describe('route source', () => {
    const source = readFileSync(join(process.cwd(), 'app', 'api', 'chat-media', '[id]', 'route.ts'), 'utf8');

    it('never uses the service-role client', () => {
        expect(source).not.toMatch(/@\/lib\/supabase\/service|createServiceOrServerClient|SUPABASE_SERVICE_ROLE_KEY/);
        expect(source).not.toMatch(/from ['"]@supabase\/supabase-js['"]/);
    });

    it('never asks Storage for a download disposition (PDFs open inline)', () => {
        expect(source).not.toMatch(/download\s*:/);
    });
});
