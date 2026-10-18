import type { SupabaseClient } from '@supabase/supabase-js';
import { redactPII } from '@/lib/utils/logger';

// Operational events the team is emailed about (tracker 3.5, migration 0070,
// owner decision 2026-10-18). Written with the service-role client through
// record_ops_event(), which keeps one row per kind, org and minute with a
// count. `detail` is a short fixed text plus ids and error codes — never a
// phone number, a name or message text; it is redacted anyway and cut to the
// column limit.

export type OpsEventKind =
    | 'webhook_signature_invalid'
    | 'webhook_error'
    | 'queue_job_failed'
    | 'whatsapp_token_invalid';

const DETAIL_MAX = 500;

// At most MAX_PER_WINDOW database calls per kind and org per minute per server
// process, so a flood (e.g. forged webhooks, each refused with 403) costs a few
// writes a minute. The events above the cap are counted here and added to the
// next call of the same kind and org, so the totals stay right except for the
// tail of a flood that has no later event.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const windows = new Map<string, { start: number; calls: number; suppressed: number }>();

/**
 * How many events this call should record: 0 when the window's cap is used
 * up (the event is carried to the next call), else 1 plus what was carried.
 */
export function opsEventSlot(kind: string, orgId: string | null | undefined, now = Date.now()): number {
    const key = `${kind}:${orgId ?? '-'}`;
    const w = windows.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
        windows.set(key, { start: now, calls: 1, suppressed: 0 });
        return 1 + (w?.suppressed ?? 0);
    }
    if (w.calls >= MAX_PER_WINDOW) {
        w.suppressed += 1;
        return 0;
    }
    w.calls += 1;
    const n = 1 + w.suppressed;
    w.suppressed = 0;
    return n;
}

/** For tests: forget the throttle windows. */
export function resetOpsEventThrottle(): void {
    windows.clear();
}

/** Records one event. Never throws: reporting a problem must not cause another. */
export async function recordOpsEvent(
    client: SupabaseClient,
    kind: OpsEventKind,
    opts: { orgId?: string | null; detail?: string } = {},
): Promise<void> {
    const count = opsEventSlot(kind, opts.orgId);
    if (count === 0) return;
    try {
        const { error } = await client.rpc('record_ops_event', {
            p_kind: kind,
            p_org: opts.orgId ?? null,
            p_detail: redactPII(opts.detail ?? '').slice(0, DETAIL_MAX),
            p_count: count,
        });
        if (error) console.error('Ops event not recorded', { kind, code: error.code });
    } catch {
        console.error('Ops event not recorded', { kind });
    }
}

/**
 * A short, PII-free description of an error for an ops event: the Meta error
 * code and title when there is one, a database or PostgREST error code, else
 * the error class. Never the message of an arbitrary error (it can quote a
 * phone number or customer text).
 */
export function describeErrorForOps(err: unknown): string {
    if (err && typeof err === 'object') {
        const e = err as { code?: unknown; title?: unknown; name?: unknown };
        if (typeof e.code === 'number') {
            return `Meta ${e.code}${typeof e.title === 'string' ? ` (${e.title})` : ''}`;
        }
        // Postgres SQLSTATE (e.g. 57014) or PostgREST (e.g. PGRST301) codes.
        if (typeof e.code === 'string' && /^[A-Z0-9]{5,9}$/.test(e.code)) return `database ${e.code}`;
        if (typeof e.name === 'string' && e.name) return e.name;
    }
    return 'unknown error';
}

/** True for Meta's "access token invalid or expired" (code 190). */
export function isWhatsAppTokenError(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 190;
}
