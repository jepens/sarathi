import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CHAT_MEDIA_ALLOWED_MIME,
    CHAT_MEDIA_BUCKET,
    CHAT_MEDIA_MAX_BYTES,
    chatMediaHref,
    chatMediaObjectPath,
    storageContentType,
} from '@/lib/storage/chat-media';
import { OUTBOUND_MEDIA_MIMES, classifyMedia } from '@/lib/whatsapp/client';

// chat-media helpers (tracker 1.11, audit KEA-4, migration 0067). Fake ids and
// phone segments only.

const ORG = '5a11e024-0001-4000-8000-000000000001';
const OTHER = '0b0e6c1e-1111-4222-8333-444455556666';
const KEY = `${ORG}/620000000000/5e1f0000-0000-4000-8000-000000000001.jpg`;
const ORIGIN = 'https://abcdefghijklmnop.supabase.co';
const publicUrl = (key: string) => `${ORIGIN}/storage/v1/object/public/chat-media/${key}`;
const signedUrl = (key: string) => `${ORIGIN}/storage/v1/object/sign/chat-media/${key}?token=eyJhbGciOiJIUzI1NiJ9.e30.c2ln`;

describe('chatMediaObjectPath', () => {
    it('reads the same key from a public URL, a signed URL with a token and a bare key', () => {
        expect(chatMediaObjectPath(publicUrl(KEY), ORG)).toBe(KEY);
        expect(chatMediaObjectPath(signedUrl(KEY), ORG)).toBe(KEY);
        expect(chatMediaObjectPath(KEY, ORG)).toBe(KEY);
        // The local stack's API URL (http, port) works the same way.
        expect(chatMediaObjectPath(`http://127.0.0.1:58921/storage/v1/object/public/chat-media/${KEY}`, ORG)).toBe(KEY);
    });

    it("refuses another org's key in every form", () => {
        const foreign = `${OTHER}/620000000000/x.jpg`;
        expect(chatMediaObjectPath(foreign, ORG)).toBeNull();
        expect(chatMediaObjectPath(publicUrl(foreign), ORG)).toBeNull();
        expect(chatMediaObjectPath(signedUrl(foreign), ORG)).toBeNull();
        // A prefix of the org id is not the org folder.
        expect(chatMediaObjectPath(`${ORG}x/a.jpg`, ORG)).toBeNull();
    });

    it("refuses '..' traversal, also percent-encoded, and odd segments", () => {
        expect(chatMediaObjectPath(`${ORG}/../${OTHER}/x.jpg`, ORG)).toBeNull();
        expect(chatMediaObjectPath(publicUrl(`${ORG}/../${OTHER}/x.jpg`), ORG)).toBeNull();
        expect(chatMediaObjectPath(publicUrl(`${ORG}/%2E%2E/${OTHER}/x.jpg`), ORG)).toBeNull();
        expect(chatMediaObjectPath(`${ORG}/./x.jpg`, ORG)).toBeNull();
        expect(chatMediaObjectPath(`${ORG}//x.jpg`, ORG)).toBeNull();
        expect(chatMediaObjectPath(`/${KEY}`, ORG)).toBeNull();
    });

    it('refuses another bucket and any other URL', () => {
        expect(chatMediaObjectPath(`${ORIGIN}/storage/v1/object/public/documents/${KEY}`, ORG)).toBeNull();
        expect(chatMediaObjectPath(`${ORIGIN}/storage/v1/object/sign/proposals/${KEY}?token=t`, ORG)).toBeNull();
        expect(chatMediaObjectPath(`${ORIGIN}/storage/v1/object/authenticated/chat-media/${KEY}`, ORG)).toBeNull();
        expect(chatMediaObjectPath(`https://example.com/${KEY}`, ORG)).toBeNull();
        expect(chatMediaObjectPath(`javascript:alert(1)//${KEY}`, ORG)).toBeNull();
    });

    it('refuses empty, null, undefined input and a missing org', () => {
        expect(chatMediaObjectPath('', ORG)).toBeNull();
        expect(chatMediaObjectPath(null, ORG)).toBeNull();
        expect(chatMediaObjectPath(undefined, ORG)).toBeNull();
        expect(chatMediaObjectPath(publicUrl(''), ORG)).toBeNull();
        expect(chatMediaObjectPath(KEY, '')).toBeNull();
    });

    it('decodes percent-encoding exactly once', () => {
        // getPublicUrl encodes the key with encodeURI: a space → %20, a literal % → %25.
        const raw = `${ORG}/620000000000/nama file 100%.pdf`;
        expect(publicUrl(encodeURI(raw))).toContain('nama%20file%20100%25.pdf');
        expect(chatMediaObjectPath(publicUrl(encodeURI(raw)), ORG)).toBe(raw);
        // Once, not twice: %2520 → %20 (a literal "%20" in the name), not a space.
        expect(chatMediaObjectPath(publicUrl(`${ORG}/620000000000/a%2520b.pdf`), ORG)).toBe(
            `${ORG}/620000000000/a%20b.pdf`
        );
        expect(chatMediaObjectPath(publicUrl(`${ORG}/620000000000/%E0%A4%A.pdf`), ORG)).toBeNull(); // malformed
    });

    it('drops the query string and the fragment', () => {
        expect(chatMediaObjectPath(`${publicUrl(KEY)}?download=`, ORG)).toBe(KEY);
        expect(chatMediaObjectPath(`${KEY}?token=x#frag`, ORG)).toBe(KEY);
    });
});

describe('storageContentType', () => {
    it('keeps type/subtype, lower-cased and without parameters', () => {
        expect(storageContentType('audio/ogg; codecs=opus')).toBe('audio/ogg');
        expect(storageContentType('IMAGE/JPEG')).toBe('image/jpeg');
        expect(storageContentType(' application/pdf ')).toBe('application/pdf');
        expect(storageContentType('text/plain;charset=UTF-8')).toBe('text/plain');
    });

    it('stores everything the bucket does not allow as application/octet-stream', () => {
        for (const mime of ['application/zip', 'text/html', 'image/svg+xml', 'application/xml', 'application/javascript', 'image/gif', '', 'jpeg']) {
            expect(storageContentType(mime)).toBe('application/octet-stream');
        }
        expect(storageContentType(null)).toBe('application/octet-stream');
        expect(storageContentType(undefined)).toBe('application/octet-stream');
    });

    it('returns only types the bucket allows', () => {
        for (const mime of CHAT_MEDIA_ALLOWED_MIME) expect(storageContentType(mime)).toBe(mime);
    });
});

describe('CHAT_MEDIA_ALLOWED_MIME', () => {
    it('allows every MIME the dashboard sends (classifyMedia), unchanged by storageContentType', () => {
        expect(OUTBOUND_MEDIA_MIMES.length).toBeGreaterThan(0);
        for (const mime of OUTBOUND_MEDIA_MIMES) {
            expect(classifyMedia(mime), mime).not.toBeNull();
            expect(CHAT_MEDIA_ALLOWED_MIME, mime).toContain(mime);
            expect(storageContentType(mime), mime).toBe(mime);
        }
    });

    it('holds 19 distinct lower-case types and no active type', () => {
        expect(CHAT_MEDIA_ALLOWED_MIME).toHaveLength(19);
        expect(new Set(CHAT_MEDIA_ALLOWED_MIME).size).toBe(19);
        for (const mime of CHAT_MEDIA_ALLOWED_MIME) {
            expect(mime).toMatch(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/);
            // xml as the subtype or suffix only: the OOXML types contain "openxml".
            expect(mime).not.toMatch(/html|svg|javascript|ecmascript|[/+]xml$/);
        }
    });
});

describe('migration 0067 matches the code', () => {
    // The statement without SQL line comments (the header quotes the rollback).
    const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '0067_chat_media_private.sql'), 'utf8')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');

    it('sets allowed_mime_types to CHAT_MEDIA_ALLOWED_MIME, order included', () => {
        const arrays = [...sql.matchAll(/allowed_mime_types\s*=\s*array\s*\[([^\]]*)\]/gi)];
        expect(arrays).toHaveLength(1);
        const listed = [...arrays[0][1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
        expect(listed).toEqual([...CHAT_MEDIA_ALLOWED_MIME]);
    });

    it('sets file_size_limit to CHAT_MEDIA_MAX_BYTES and makes the bucket private', () => {
        expect(sql).toMatch(new RegExp(`file_size_limit\\s*=\\s*${CHAT_MEDIA_MAX_BYTES}\\b`));
        expect(CHAT_MEDIA_MAX_BYTES).toBe(50 * 1024 * 1024);
        expect(sql).toMatch(/set\s+public\s*=\s*false/i);
        expect(sql).toMatch(new RegExp(`where\\s+id\\s*=\\s*'${CHAT_MEDIA_BUCKET}'`));
    });
});

describe('chatMediaHref', () => {
    it('is the same-origin redirect route of the message', () => {
        expect(chatMediaHref('5e1f0000-0000-4000-8000-000000000009')).toBe(
            '/api/chat-media/5e1f0000-0000-4000-8000-000000000009'
        );
        expect(chatMediaHref('a/b?c')).toBe('/api/chat-media/a%2Fb%3Fc');
    });
});
