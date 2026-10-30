import { describeErrorForOps } from '@/lib/ops/events';

// What a failed item means for Meta's delivery: retryable (answer 503, Meta
// sends the batch again and the item is tried again) or permanent (trying
// again cannot help: the item is stored as a placeholder or skipped, and the
// answer is 200). An error nobody foresaw is retryable: the poison counter
// (outcome.ts) bounds the retries, so an unknown error never drops a message
// on its first occurrence and never makes Meta retry it for days either.

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

// SQLSTATEs that say the input itself is wrong: class 22 (data exception,
// including the RPC's own 22004/22023), a NOT NULL or CHECK violation, a
// RAISE in a function. PGRST1xx: PostgREST could not read the request.
const PERMANENT_CODES = new Set(['23502', '23514', 'P0001']);

export function classify(error: unknown): ErrorClass {
    if (error instanceof MalformedPayloadError) return 'permanent';
    if (error === null || typeof error !== 'object') return 'retryable';
    const e = error as { name?: unknown; code?: unknown };
    // The default org's read error carries the database code it hit, but the
    // setting is there: whatever the code, the next delivery can succeed.
    if (e.name === 'PlatformSettingReadError') return 'retryable';
    const code = typeof e.code === 'string' ? e.code : '';
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

// Errors that hit every item alike say nothing about the item: the database
// or PostgREST unreachable, overloaded or slow (a statement or lock timeout,
// a serialization failure or deadlock under load), the schema out of step
// with the code (class 42: a function, table, column or grant missing, e.g.
// the code deployed ahead of its migration), a read-only database, an
// internal error (classes 58 and XX), a gateway that refuses every call (a
// wrong API key or URL: HTTP 401/403/404 without a PostgREST code). Counted
// toward an item's poison bound they would turn an outage, a slow database
// or a deploy-order slip into placeholders and skipped statuses once it is
// fixed. A thrown bug, a malformed answer and any other SQLSTATE (e.g. 23503,
// a contact deleted meanwhile) still count.
const SYSTEMIC_CODES = new Set(['25006', '40001', '40P01', '55P03', '57014']);
const SYSTEMIC_HTTP = new Set([0, 401, 403, 404, 408, 429]);

/** Whether a retryable failure counts toward the item's poison bound (outcome.ts). */
export function countsTowardPoison(error: unknown): boolean {
    if (error === null || typeof error !== 'object') return true;
    const e = error as { name?: unknown; code?: unknown };
    if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'PlatformSettingReadError') return false;
    const code = typeof e.code === 'string' ? e.code : '';
    if (code === '' && error instanceof RpcError) {
        // No answer at all, a gateway refusing every call, or an HTTP error without a body.
        return !(SYSTEMIC_HTTP.has(error.status) || error.status >= 500);
    }
    return !(
        SYSTEMIC_CODES.has(code) ||
        /^PGRST[023]\d\d$/.test(code) ||
        /^(08|42|53|58|XX)[0-9A-Z]{3}$/.test(code) ||
        /^57P0\d$/.test(code)
    );
}

/**
 * What the team should check first, by error code, for the webhook_error
 * alert (Indonesian, like the alert); null when no hint fits.
 */
export function opsHint(error: unknown): string | null {
    if (error === null || typeof error !== 'object') return null;
    const e = error as { name?: unknown; code?: unknown };
    if (e.name === 'PlatformSettingReadError') return 'org default tidak terbaca, periksa Supabase';
    const code = typeof e.code === 'string' ? e.code : '';
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
    if (/^(58|XX)[0-9A-Z]{3}$/.test(code)) return 'galat internal database, periksa Supabase';
    if (/^PGRST00\d$/.test(code) || /^08[0-9A-Z]{3}$/.test(code) || /^57P0\d$/.test(code)) {
        return 'Supabase tidak terjangkau atau sedang gangguan';
    }
    if (code === '' && error instanceof RpcError) {
        if (error.status === 401 || error.status === 403) {
            return 'kunci API Supabase ditolak, periksa SUPABASE_SERVICE_ROLE_KEY (rotasi kunci?)';
        }
        if (error.status === 404) return 'alamat Supabase tidak ditemukan, periksa NEXT_PUBLIC_SUPABASE_URL';
        if (error.status === 408 || error.status === 429) return 'Supabase sibuk (batas permintaan atau waktu tunggu habis)';
        if (error.status === 0 || error.status >= 500) return 'Supabase tidak terjangkau atau sedang gangguan';
    }
    return null;
}
