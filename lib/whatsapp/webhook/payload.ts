import type { MetaJson } from '@/lib/whatsapp/webhook/types';

// Readers of Meta's webhook JSON. A signed body can still hold anything (a
// shape Meta changes, a test tool), and one odd change must not stop the rest
// of the batch, so none of these ever throws on what JSON.parse returns.

/** One entry x change of a delivery. */
export interface ChangeRef {
    /** Position in the payload, the tie-break of every sort. */
    entryIndex: number;
    changeIndex: number;
    field: unknown;
    value: MetaJson;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every entry x change of the body, in payload order. No cap: the 3 MB body
 * limit bounds a batch. Entries and changes that are not objects are left out
 * (there is nothing in them to route).
 */
export function listChanges(body: unknown): ChangeRef[] {
    const changes: ChangeRef[] = [];
    const entries = isRecord(body) && Array.isArray(body.entry) ? body.entry : [];
    entries.forEach((entry: unknown, entryIndex: number) => {
        const list = isRecord(entry) && Array.isArray(entry.changes) ? entry.changes : [];
        list.forEach((change: unknown, changeIndex: number) => {
            if (!isRecord(change)) return;
            changes.push({ entryIndex, changeIndex, field: change.field, value: change.value });
        });
    });
    return changes;
}

/** value.messages[] as Meta sent it (an entry may still be anything). */
export function messagesOf(value: unknown): unknown[] {
    return isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
}

/** value.statuses[] as Meta sent it (an entry may still be anything). */
export function statusesOf(value: unknown): unknown[] {
    return isRecord(value) && Array.isArray(value.statuses) ? value.statuses : [];
}

const PAST_MS = 8 * 24 * 60 * 60 * 1000; // Meta retries a delivery for 7 days
const FUTURE_MS = 5 * 60 * 1000; // clock skew

/**
 * Meta's timestamp (unix seconds, as a string or a number) as a Date, or null
 * when it is missing, not a number, or outside [now - 8 days, now + 5 min]: a
 * value out there is not a real send time, and it must not move a chat's
 * summary or decide the late-message rule.
 */
export function parseMetaTimestamp(value: unknown, now = Date.now()): Date | null {
    let seconds: number;
    if (typeof value === 'number') seconds = value;
    else if (typeof value === 'string' && /^\d{1,12}$/.test(value)) seconds = Number(value);
    else return null;
    if (!Number.isFinite(seconds)) return null;
    const ms = seconds * 1000;
    if (ms < now - PAST_MS || ms > now + FUTURE_MS) return null;
    return new Date(ms);
}

// A high surrogate not followed by a low one, or a low one without a high one
// before it (code units, hence no 'u' flag).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Deeper than anything this pipeline sends; keeps the recursion bounded.
const MAX_DEPTH = 64;

function cleanString(text: string): string {
    return text.replaceAll('\u0000', '').replace(LONE_SURROGATE, '�');
}

function clean(value: unknown, depth: number): unknown {
    if (typeof value === 'string') return cleanString(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return null;
    if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
        // defineProperty: a "__proto__" key from JSON.parse stays a plain key.
        Object.defineProperty(out, cleanString(key), { value: clean(v, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
}

/**
 * A copy of a JSON value Postgres accepts: U+0000 removed and lone surrogates
 * replaced by U+FFFD, in every string, nested object key and array. Either
 * would fail the whole call with a class-22 error (text and jsonb refuse
 * U+0000; a lone surrogate is not valid UTF-8), and the message would be lost.
 */
export function sanitizeForPg<T>(value: T): T {
    return clean(value, 0) as T;
}

/** The codes of value.errors[] (Meta's errors about the change), for the log. */
export function errorCodes(value: unknown): number[] {
    const errors = isRecord(value) && Array.isArray(value.errors) ? value.errors : [];
    return errors
        .map((e: unknown) => (isRecord(e) && typeof e.code === 'number' ? e.code : null))
        .filter((code: number | null): code is number => code !== null)
        .slice(0, 10);
}

const WORD = /^[a-z_]{1,32}$/;

/**
 * A field or type name from the payload for a log line or an alert: Meta's own
 * vocabulary (lower case and '_'), else '?', never raw input.
 */
export function metaWord(value: unknown): string {
    return typeof value === 'string' && WORD.test(value) ? value : '?';
}
