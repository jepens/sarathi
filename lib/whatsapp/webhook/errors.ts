import { describeErrorForOps } from '@/lib/ops/events';

// What a failed item means for Meta's delivery: retryable (answer 503, Meta
// sends the batch again and the item is tried again) or permanent (trying
// again cannot help: the item is stored as a placeholder or skipped, and the
// answer is 200). An error nobody foresaw is retryable, so it never drops a
// message on its first occurrence. Only a database answer specific to the
// item counts toward the poison bound (countsTowardPoison, outcome.ts); a
// thrown bug keeps the delivery in 503 until it is fixed (owner decision D24).

export type ErrorClass = 'retryable' | 'permanent';

/**
 * A payload a handler cannot store as it is (a text without a string body,
 * media without an id). `reason` is a fixed text for the alert, never payload
 * content.
 */
export class MalformedPayloadError extends Error {
    readonly reason: string;
    constructor(reason: string) {
        super(reason);
        this.name = 'MalformedPayloadError';
        this.reason = reason;
    }
}

// SQLSTATEs that say the input itself is wrong: class 22 (data exception), a
// NOT NULL or CHECK violation, a RAISE in a function. PGRST1xx: PostgREST could
// not read the request; it stays permanent because not all of it is a bug of
// this code (PGRST116, no or several rows for a single object, depends on the
// data).
const PERMANENT_CODES = new Set(['23502', '23514', 'P0001']);
// Except the parameter checks of the webhook's RPCs (22004/22023 raised by
// wa_ingest_inbound and wa_apply_statuses): only a bug of this code can trip
// them, so they follow D24 like a thrown bug: retryable, never counted. (The
// header of migration 0072, written before D24, still calls them permanent.)
const CALLER_BUG_CODES = new Set(['22004', '22023']);

export function classify(error: unknown): ErrorClass {
    if (error instanceof MalformedPayloadError) return 'permanent';
    if (error === null || typeof error !== 'object') return 'retryable';
    const e = error as { name?: unknown; code?: unknown };
    // The default org's read error carries the database code it hit, but the
    // setting is there: whatever the code, the next delivery can succeed.
    if (e.name === 'PlatformSettingReadError') return 'retryable';
    const code = typeof e.code === 'string' ? e.code : '';
    if (CALLER_BUG_CODES.has(code)) return 'retryable';
    if (/^22[0-9A-Z]{3}$/.test(code) || PERMANENT_CODES.has(code) || /^PGRST1\d\d$/.test(code)) return 'permanent';
    // Everything else: a network failure or an abort (postgrest-js answers
    // code ''), HTTP 408/429/5xx, PostgREST's connection, schema-cache (e.g.
    // PGRST202 while the code is ahead of the migration) and JWT errors,
    // serialization failures, deadlocks, lock and statement timeouts, a
    // 23505 that slipped past an ON CONFLICT, a missing grant or function,
    // and any thrown error.
    return 'retryable';
}

/**
 * The error of a failed database call, with only what may reach a log line or
 * an alert: the SQLSTATE or PostgREST code and the HTTP status. The message
 * PostgREST sends can quote the row (a phone number, message text), so it is
 * not kept.
 */
export class RpcError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(call: string, error: unknown, status: unknown) {
        const code = error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : '';
        const http = typeof status === 'number' ? status : 0;
        super(`${call} failed (HTTP ${http}${code ? `, ${code}` : ''})`);
        // Without a code the name says what failed (describeErrorForOps falls
        // back to it): no answer at all, or an HTTP error without a body.
        this.name = code ? 'RpcError' : http === 0 ? 'RpcNetworkError' : `RpcHttp${http}`;
        this.code = code;
        this.status = http;
    }
}

/** The error of an item for an alert: the fixed reason of a malformed payload, else describeErrorForOps. */
export function describeItemError(error: unknown): string {
    return error instanceof MalformedPayloadError ? error.reason : describeErrorForOps(error);
}

// Database answers that hit every item alike say nothing about the item: the
// database or PostgREST unreachable, overloaded or slow (a statement or lock
// timeout, a serialization failure or deadlock under load), the schema out of
// step with the code (class 42: a function, table, column or grant missing,
// e.g. the code deployed ahead of its migration), a read-only database, an
// internal error (classes 58 and XX, PostgREST's PGRSTX00). Counted toward an
// item's poison bound they would turn an outage, a slow database or a
// deploy-order slip into placeholders and skipped statuses once it is fixed.
// A wrong API key or URL never gets as far as an item: the delivery's org
// read on the same client fails first (PlatformSettingReadError, never
// counted; getPlatformSettingStrict also refuses an answer that is not
// PostgREST's 200, such as the empty 204 of a server that does not know the
// path), so an HTTP 401/403/404 without a code on one item's own call is
// about that request, and counts like any other answer specific to the item
// (e.g. 23503, a contact deleted meanwhile).
const SYSTEMIC_CODES = new Set(['25006', '40001', '40P01', '55P03', '57014']);
const SYSTEMIC_HTTP = new Set([0, 408, 429]);

/** Database codes that never count: the systemic ones, and the RPCs' parameter checks (a bug, D24). */
function neverCounts(code: string): boolean {
    return (
        SYSTEMIC_CODES.has(code) ||
        CALLER_BUG_CODES.has(code) ||
        /^PGRST[023X]\d\d$/.test(code) ||
        /^(08|42|53|58|XX)[0-9A-Z]{3}$/.test(code) ||
        /^57P0\d$/.test(code)
    );
}

/**
 * Whether a retryable failure counts toward the item's poison bound
 * (outcome.ts): only an answer of the database or PostgREST that is specific
 * to the item. A thrown bug, or anything else that is no database answer,
 * never counts (owner decision D24): Meta keeps resending the delivery (up to
 * 7 days, webhook_error every hour), and once the bug is fixed or rolled back
 * the message is stored with its content instead of as a placeholder.
 */
export function countsTowardPoison(error: unknown): boolean {
    if (error instanceof RpcError) {
        // Without a code: no answer at all, or an HTTP error without a body.
        if (error.code === '') return !(SYSTEMIC_HTTP.has(error.status) || error.status >= 500);
        return !neverCounts(error.code);
    }
    // A database answer handed over without the RpcError wrapper: a plain
    // object (never a thrown Error) carrying its code.
    if (error === null || typeof error !== 'object' || error instanceof Error) return false;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code !== '' && !neverCounts(code);
}

/**
 * What the team should check first, by error code, for the webhook_error
 * alert (Indonesian, like the alert); null when no hint fits.
 */
export function opsHint(error: unknown): string | null {
    if (error === null || typeof error !== 'object') return null;
    const e = error as { name?: unknown; code?: unknown; status?: unknown };
    const code = typeof e.code === 'string' ? e.code : '';
    if (e.name === 'PlatformSettingReadError') {
        // The delivery's first call on the client: a wrong API key or URL shows here.
        const status = typeof e.status === 'number' ? e.status : 0;
        if (/^PGRST3\d\d$/.test(code) || (code === '' && (status === 401 || status === 403))) {
            return 'org default tidak terbaca: kunci API Supabase ditolak, periksa SUPABASE_SERVICE_ROLE_KEY (rotasi kunci?)';
        }
        // platform_settings is the service role's only. Refused with 42501 as
        // the anonymous role (HTTP 401), the key is an anon or publishable
        // one; as the service role (403), its grant is missing.
        if (code === '42501' && status === 401) {
            return 'org default tidak terbaca: kunci bukan service role (anon/publishable?), periksa SUPABASE_SERVICE_ROLE_KEY';
        }
        if (code === '42501') return 'org default tidak terbaca: izin database (grant) hilang';
        // An empty 404 (postgrest-js reports it as 204): not a PostgREST at that address.
        if (code === '' && (status === 404 || status === 204)) {
            return 'org default tidak terbaca: alamat Supabase tidak ditemukan, periksa NEXT_PUBLIC_SUPABASE_URL';
        }
        return 'org default tidak terbaca, periksa Supabase';
    }
    if (CALLER_BUG_CODES.has(code)) return 'parameter fungsi database ditolak: bug kode, periksa deploy terakhir';
    if (code === 'PGRST202' || code === '42883') return 'fungsi database tidak ditemukan, migrasi belum diterapkan?';
    if (code === 'PGRST203') return 'dua versi fungsi database, periksa migrasi terakhir';
    if (code === 'PGRST204' || code === 'PGRST205' || code === '42703' || code === '42P01') {
        return 'kolom atau tabel database tidak ditemukan, migrasi belum diterapkan?';
    }
    if (code === '42501') return 'izin database (grant) hilang';
    if (/^42[0-9A-Z]{3}$/.test(code)) return 'skema database tidak cocok dengan kode, periksa migrasi terakhir';
    if (/^PGRST3\d\d$/.test(code)) return 'kunci API Supabase ditolak, periksa SUPABASE_SERVICE_ROLE_KEY (rotasi kunci?)';
    if (code === '25006') return 'database hanya-baca, disk penuh?';
    if (/^53[0-9A-Z]{3}$/.test(code)) return 'sumber daya database habis';
    if (code === '55P03') return 'menunggu kunci database terlalu lama';
    if (code === '40001' || code === '40P01') return 'bentrok transaksi, aman bila jarang';
    if (code === '57014') return 'query database dibatalkan karena terlalu lama';
    if (/^(58|XX)[0-9A-Z]{3}$/.test(code) || /^PGRSTX\d\d$/.test(code)) return 'galat internal database, periksa Supabase';
    if (/^PGRST00\d$/.test(code) || /^08[0-9A-Z]{3}$/.test(code) || /^57P0\d$/.test(code)) {
        return 'Supabase tidak terjangkau atau sedang gangguan';
    }
    if (code === '' && error instanceof RpcError) {
        if (error.status === 408 || error.status === 429) return 'Supabase sibuk (batas permintaan atau waktu tunggu habis)';
        if (error.status === 0 || error.status >= 500) return 'Supabase tidak terjangkau atau sedang gangguan';
        // The org read of this delivery passed with the same key and URL, so
        // the gateway refused this request itself.
        if (error.status === 401 || error.status === 403 || error.status === 404) {
            return `gateway Supabase menolak permintaan ini (HTTP ${error.status}); kunci dan alamat berlaku`;
        }
    }
    return null;
}
