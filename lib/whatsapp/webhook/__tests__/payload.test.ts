import { describe, it, expect } from 'vitest';
import {
    errorCodes,
    listChanges,
    messagesOf,
    metaWord,
    parseMetaTimestamp,
    sanitizeForPg,
    statusesOf,
} from '@/lib/whatsapp/webhook/payload';

// The payload readers of the webhook (Fase 2 task 2.2a part 2): every entry x
// change of a delivery, never throwing on any JSON value; Meta's timestamp
// only when plausible; every string Postgres would refuse cleaned (U+0000,
// lone surrogates), in nested JSON too. Fake ids only.

const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

// Every kind of value JSON.parse can return, and shapes that are close to Meta's.
const ODD_VALUES: unknown[] = [
    null,
    42,
    'teks',
    true,
    [],
    {},
    { entry: null },
    { entry: 'x' },
    { entry: [null, 1, 'x', [], { changes: null }, { changes: [null, 2, 'y', []] }] },
];

describe('listChanges', () => {
    it('lists every entry x change in payload order, with their positions', () => {
        const body = {
            object: 'whatsapp_business_account',
            entry: [
                { id: 'waba-1', changes: [{ field: 'messages', value: { a: 1 } }, { field: 'user_id_update', value: { b: 2 } }] },
                { id: 'waba-2', changes: [{ field: 'messages', value: 'bukan objek' }] },
            ],
        };
        expect(listChanges(body)).toEqual([
            { entryIndex: 0, changeIndex: 0, field: 'messages', value: { a: 1 } },
            { entryIndex: 0, changeIndex: 1, field: 'user_id_update', value: { b: 2 } },
            { entryIndex: 1, changeIndex: 0, field: 'messages', value: 'bukan objek' },
        ]);
    });

    it('has no cap: a large batch is listed in full (the 3 MB body limit bounds it)', () => {
        const body = { entry: Array.from({ length: 30 }, () => ({ changes: Array.from({ length: 50 }, () => ({ field: 'messages', value: {} })) })) };
        expect(listChanges(body)).toHaveLength(1500);
    });

    it('never throws, and leaves out entries and changes that are not objects', () => {
        for (const value of ODD_VALUES) expect(() => listChanges(value)).not.toThrow();
        expect(listChanges(ODD_VALUES[ODD_VALUES.length - 1])).toEqual([]);
        expect(listChanges({ entry: [{ changes: [null, { field: 'messages' }] }] })).toEqual([
            { entryIndex: 0, changeIndex: 1, field: 'messages', value: undefined },
        ]);
    });
});

describe('messagesOf / statusesOf', () => {
    it('return the arrays as Meta sent them, entries of any kind included', () => {
        expect(messagesOf({ messages: [42, null, { id: 'wamid.a' }] })).toEqual([42, null, { id: 'wamid.a' }]);
        expect(statusesOf({ statuses: [null] })).toEqual([null]);
    });

    it('return [] for anything else', () => {
        for (const value of [...ODD_VALUES, { messages: {} }, { messages: 'x' }, { statuses: { id: 'a' } }]) {
            expect(messagesOf(value)).toEqual([]);
            expect(statusesOf(value)).toEqual([]);
        }
    });
});

describe('parseMetaTimestamp', () => {
    it('reads unix seconds as a string or a number', () => {
        const at = NOW - 60_000;
        expect(parseMetaTimestamp(String(sec(at)), NOW)?.getTime()).toBe(sec(at) * 1000);
        expect(parseMetaTimestamp(sec(at), NOW)?.getTime()).toBe(sec(at) * 1000);
    });

    it('is null when missing or not a number of seconds', () => {
        for (const value of [undefined, null, '', 'abc', '1.5e9', ' 1761818400', '-1761818400', {}, [], true, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(parseMetaTimestamp(value, NOW)).toBeNull();
        }
    });

    it('accepts up to 8 days ago and 5 minutes ahead, nothing outside', () => {
        const day = 24 * 60 * 60 * 1000;
        expect(parseMetaTimestamp(sec(NOW - 8 * day + 1000), NOW)).not.toBeNull();
        expect(parseMetaTimestamp(sec(NOW - 8 * day) - 1, NOW)).toBeNull(); // ancient
        expect(parseMetaTimestamp(sec(NOW + 5 * 60_000), NOW)).not.toBeNull();
        expect(parseMetaTimestamp(sec(NOW + 5 * 60_000) + 1, NOW)).toBeNull(); // future
        expect(parseMetaTimestamp(0, NOW)).toBeNull();
    });
});

describe('sanitizeForPg', () => {
    const NUL = '\u0000';
    const HIGH = '\uD83D'; // the first half of an emoji
    const LOW = '\uDE00'; // the second half of an emoji

    it('removes U+0000 and replaces lone surrogates with U+FFFD, keeping whole pairs', () => {
        expect(sanitizeForPg(`ha${NUL}lo`)).toBe('halo');
        expect(sanitizeForPg(`a${HIGH}b`)).toBe('a�b');
        expect(sanitizeForPg(`a${LOW}b`)).toBe('a�b');
        expect(sanitizeForPg(`${LOW}${HIGH}`)).toBe('��'); // reversed: not a pair
        expect(sanitizeForPg(`ujung${HIGH}`)).toBe('ujung�');
        expect(sanitizeForPg('senyum 😀 ya')).toBe('senyum 😀 ya');
        expect(sanitizeForPg(`${HIGH}${LOW}`)).toBe('😀');
    });

    it('cleans every string field of the ingest parameters, and nested JSON keys and values', () => {
        const params = {
            p_org: 'aaaaaaaa-0000-4000-8000-00000000000a',
            p_from: `620000000000${NUL}`,
            p_wamid: `wamid.fake${HIGH}`,
            p_content: `halo${NUL}${LOW}`,
            p_preview: `halo${NUL}`,
            p_queue_text: `halo${HIGH} lagi`,
            p_media_filename: `berkas${NUL}.pdf`,
            p_metadata: { other_number: `h0123456789${NUL}`, [`kunci${NUL}`]: [`isi${LOW}`, { dalam: `x${HIGH}` }] },
            p_work_payload: { response_json: `{"nama":"Budi${NUL}"}` },
            p_unread: true,
            p_rate_max: 10,
            p_wa_ts: null,
        };
        const clean = sanitizeForPg(params);
        expect(clean).toEqual({
            p_org: 'aaaaaaaa-0000-4000-8000-00000000000a',
            p_from: '620000000000',
            p_wamid: 'wamid.fake�',
            p_content: 'halo�',
            p_preview: 'halo',
            p_queue_text: 'halo� lagi',
            p_media_filename: 'berkas.pdf',
            p_metadata: { other_number: 'h0123456789', kunci: ['isi�', { dalam: 'x�' }] },
            p_work_payload: { response_json: '{"nama":"Budi"}' },
            p_unread: true,
            p_rate_max: 10,
            p_wa_ts: null,
        });
        // A copy: the input is left as it was.
        expect(params.p_from).toBe(`620000000000${NUL}`);
        // What JSON.stringify sends to PostgREST has no NUL and no lone surrogate.
        const sent = JSON.stringify(clean);
        expect(sent).not.toMatch(/\\u0000/);
        expect(sent.isWellFormed()).toBe(true);
    });

    it('keeps a "__proto__" key from JSON as a plain key', () => {
        const parsed = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
        const clean = sanitizeForPg(parsed) as Record<string, unknown>;
        expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.keys(clean)).toEqual(['__proto__', 'a']);
    });

    it('never throws on any JSON value, however deep', () => {
        for (const value of ODD_VALUES) expect(() => sanitizeForPg(value)).not.toThrow();
        let deep: unknown = 'dasar';
        for (let i = 0; i < 5000; i++) deep = [deep];
        expect(() => sanitizeForPg(deep)).not.toThrow();
    });
});

describe('errorCodes', () => {
    it("lists the codes of value.errors (for the log), nothing else", () => {
        expect(errorCodes({ errors: [{ code: 131047, title: 'Re-engagement message' }, { code: 'x' }, null, { code: 131026 }] })).toEqual([131047, 131026]);
        for (const value of ODD_VALUES) expect(errorCodes(value)).toEqual([]);
    });
});

describe('metaWord', () => {
    it("passes Meta's own words, and nothing that could forge a log line", () => {
        expect(metaWord('nfm_reply')).toBe('nfm_reply');
        expect(metaWord('message_template_status_update')).toBe('message_template_status_update');
        for (const value of ['Text', 'te xt', 'a\nb', '', 42, null, 'x'.repeat(33)]) expect(metaWord(value)).toBe('?');
    });
});
