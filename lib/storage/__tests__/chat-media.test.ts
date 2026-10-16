import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CHAT_MEDIA_ALLOWED_MIME,
    CHAT_MEDIA_BUCKET,
    CHAT_MEDIA_MAX_BYTES,
    CHAT_MEDIA_REDIRECT_MAX_AGE,
    CHAT_MEDIA_SIGNED_SECONDS,
    CHAT_MEDIA_STREAM_FRESH_MS,
    CHAT_MEDIA_STREAM_SIGNED_SECONDS,
    chatMediaHref,
    chatMediaObjectPath,
    chatMediaSignedSeconds,
    contactMediaFolder,
    safePhoneSegment,
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
const signedUrl = (key: string) => `${ORIGIN}/storage/v1/object/sign/chat-media/${key}?token=fake-signature-for-tests`;

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
        expect(chatMediaObjectPath(publicUrl(`${ORG}/620000000000/a%2Db.pdf`), ORG)).toBe(`${ORG}/620000000000/a-b.pdf`);
        // Once, not twice: %252D → %2D (a literal "%2D", refused below), never '-'.
        expect(chatMediaObjectPath(publicUrl(`${ORG}/620000000000/a%252Db.pdf`), ORG)).toBeNull();
        expect(chatMediaObjectPath(publicUrl(`${ORG}/620000000000/%E0%A4%A.pdf`), ORG)).toBeNull(); // malformed
    });

    it("refuses any character outside the writers' set [A-Za-z0-9._-] after the org folder", () => {
        // storage-js sends the key unencoded, so Storage would read these again.
        for (const name of ['a%3Fb.jpg', 'a%23b.jpg', 'a%2520b.jpg', 'a%253Fb.jpg', 'nama%20file.pdf', 'a+b.jpg', 'a@b.jpg', 'caf%C3%A9.jpg']) {
            expect(chatMediaObjectPath(publicUrl(`${ORG}/620000000000/${name}`), ORG), name).toBeNull();
            expect(chatMediaObjectPath(`${ORG}/620000000000/${name}`, ORG), name).toBeNull();
        }
        expect(chatMediaObjectPath(publicUrl(encodeURI(`${ORG}/620000000000/nama file.pdf`)), ORG)).toBeNull();
        // Everything the writers produce passes: a BSUID-style segment, dots, dashes, underscores.
        expect(chatMediaObjectPath(`${ORG}/US.1234_abc-9/5e1f0000-0000-4000-8000-000000000001.ogg`, ORG)).toBe(
            `${ORG}/US.1234_abc-9/5e1f0000-0000-4000-8000-000000000001.ogg`
        );
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

describe('signed URL lifetimes', () => {
    it('signs photos and documents for 10 minutes, voice notes and videos for an hour', () => {
        expect(chatMediaSignedSeconds('image')).toBe(CHAT_MEDIA_SIGNED_SECONDS);
        expect(chatMediaSignedSeconds('document')).toBe(CHAT_MEDIA_SIGNED_SECONDS);
        expect(chatMediaSignedSeconds(null)).toBe(CHAT_MEDIA_SIGNED_SECONDS);
        expect(chatMediaSignedSeconds('audio')).toBe(CHAT_MEDIA_STREAM_SIGNED_SECONDS);
        expect(chatMediaSignedSeconds('video')).toBe(CHAT_MEDIA_STREAM_SIGNED_SECONDS);
        expect([CHAT_MEDIA_SIGNED_SECONDS, CHAT_MEDIA_STREAM_SIGNED_SECONDS]).toEqual([600, 3600]);
    });

    it('a cached redirect never outlives its token', () => {
        expect(CHAT_MEDIA_REDIRECT_MAX_AGE).toBeLessThan(CHAT_MEDIA_SIGNED_SECONDS);
    });

    it('a stream renewed at the end of its fresh window keeps 10 minutes of token, even from a cached redirect', () => {
        expect(CHAT_MEDIA_STREAM_FRESH_MS).toBe(45 * 60 * 1000);
        const tokenLeftMs = CHAT_MEDIA_STREAM_SIGNED_SECONDS * 1000 - CHAT_MEDIA_REDIRECT_MAX_AGE * 1000 - CHAT_MEDIA_STREAM_FRESH_MS;
        expect(tokenLeftMs).toBe(10 * 60 * 1000);
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

describe("safePhoneSegment / contactMediaFolder (D21: a contact's files go with it)", () => {
    it('keeps a wa_id or BSUID as it is, and replaces everything that could add a folder', () => {
        expect(safePhoneSegment('620000000000')).toBe('620000000000');
        expect(safePhoneSegment('US.1234567890')).toBe('US.1234567890');
        expect(safePhoneSegment('+62 811/../x')).toBe('_62_811_.._x');
    });

    it('names the contact folder only when the phone is a segment as it is', () => {
        expect(contactMediaFolder(ORG, '620000000000')).toBe(`${ORG}/620000000000`);
        // '+62811' and '_62811' would share '<org>/_62811': only their own keys are removed.
        expect(contactMediaFolder(ORG, '+62811')).toBeNull();
        expect(contactMediaFolder(ORG, '..')).toBeNull();
        expect(contactMediaFolder(ORG, '.')).toBeNull();
        expect(contactMediaFolder(ORG, '')).toBeNull();
        expect(contactMediaFolder('', '620000000000')).toBeNull();
    });
});
