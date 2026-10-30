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
// or PostgREST unreachable or overloaded, a function or a grant missing (the
// code deployed ahead of migration 0072: PGRST202, 42883, 42501), a read-only
// database. Counted toward an item's poison bound they would turn an outage
// or a deploy-order slip into placeholders and skipped statuses once it is
// fixed. A thrown bug, a malformed answer and any other SQLSTATE still count.
const SYSTEMIC_CODES = new Set(['25006', '42501', '42883']);

/** Whether a retryable failure counts toward the item's poison bound (outcome.ts). */
export function countsTowardPoison(error: unknown): boolean {
    if (error === null || typeof error !== 'object') return true;
    const e = error as { name?: unknown; code?: unknown };
    if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'PlatformSettingReadError') return false;
    const code = typeof e.code === 'string' ? e.code : '';
    if (code === '' && error instanceof RpcError) {
        // No answer at all, or an HTTP error without a body.
        return !(error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);
    }
    return !(
        SYSTEMIC_CODES.has(code) ||
        /^PGRST[023]\d\d$/.test(code) ||
        /^(08|53)[0-9A-Z]{3}$/.test(code) ||
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
    if (code === 'PGRST202' || code === '42883') return 'fungsi database tidak ditemukan, migrasi 0072 belum diterapkan?';
    if (code === '42501') return 'grant fungsi database hilang';
    if (code === '25006') return 'database hanya-baca, disk penuh?';
    if (/^53[0-9A-Z]{3}$/.test(code)) return 'sumber daya database habis';
    if (code === '55P03') return 'menunggu kunci database terlalu lama';
    if (code === '40001' || code === '40P01') return 'bentrok transaksi, aman bila jarang';
    if (code === '57014') return 'query database dibatalkan karena terlalu lama';
    if (/^PGRST00\d$/.test(code) || /^08[0-9A-Z]{3}$/.test(code) || /^57P0\d$/.test(code)) {
        return 'Supabase tidak terjangkau atau sedang gangguan';
    }
    if (code === '' && error instanceof RpcError && (error.status === 0 || error.status >= 500)) {
        return 'Supabase tidak terjangkau atau sedang gangguan';
    }
    return null;
}
