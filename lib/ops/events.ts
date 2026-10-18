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
    | 'webhook_unrouted'
    | 'webhook_unrouted_new'
    | 'webhook_unconfigured'
    | 'queue_job_failed'
    | 'whatsapp_token_invalid'
    | 'quota_inbound_exceeded'
    | 'quota_ai_daily_warning'
    | 'quota_ai_daily_exceeded'
    | 'quota_check_failed';

const DETAIL_MAX = 500;

// At most MAX_PER_WINDOW database calls per kind and org per minute per server
// process (plus a few at the end of the window), so a flood (e.g. forged
// webhooks, each refused with 403) costs a few writes a minute. The events
// above the cap are counted here and recorded when the window ends (or by the
// next call, if that comes first), so a burst is reported in full, at most a
// minute late. A restart loses the held count.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

interface ThrottleWindow {
    start: number;
    calls: number;
    suppressed: number;
    flushArmed: boolean;
}
const windows = new Map<string, ThrottleWindow>();

const windowKey = (kind: string, orgId: string | null | undefined) => `${kind}:${orgId ?? '-'}`;

/**
 * How many events this call should record: 0 when the window's cap is used
 * up (the event is held for the end of the window), else 1 plus what an
 * earlier window still held.
 */
export function opsEventSlot(kind: string, orgId: string | null | undefined, now = Date.now()): number {
    const key = windowKey(kind, orgId);
    const w = windows.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
        const carried = w ? w.suppressed : 0;
        if (w) w.suppressed = 0; // so the old window's flush does not record it again
        windows.set(key, { start: now, calls: 1, suppressed: 0, flushArmed: false });
        return 1 + carried;
    }
    if (w.calls >= MAX_PER_WINDOW) {
        w.suppressed += 1;
        return 0;
    }
    w.calls += 1;
    return 1;
}

/** For tests: forget the throttle windows. */
export function resetOpsEventThrottle(): void {
    windows.clear();
}

async function writeEvent(client: SupabaseClient, kind: string, orgId: string | null, detail: string, count: number): Promise<void> {
    try {
        const { error } = await client.rpc('record_ops_event', { p_kind: kind, p_org: orgId, p_detail: detail, p_count: count });
        if (error) console.error('Ops event not recorded', { kind, code: error.code });
    } catch {
        console.error('Ops event not recorded', { kind });
    }
}

/** When a window first holds back an event, record what it held when it ends. */
function armTailFlush(client: SupabaseClient, kind: string, orgId: string | null, detail: string, now = Date.now()): void {
    const w = windows.get(windowKey(kind, orgId));
    if (!w || w.flushArmed) return;
    w.flushArmed = true;
    const timer = setTimeout(() => {
        // Re-arm: an event held after this flush (the timer can fire a hair
        // before the window ends) gets a flush of its own.
        w.flushArmed = false;
        // A newer window may already have carried the count (and zeroed it).
        if (w.suppressed === 0) return;
        const n = w.suppressed;
        w.suppressed = 0;
        void writeEvent(client, kind, orgId, detail, n);
    }, Math.max(0, w.start + WINDOW_MS - now));
    (timer as { unref?: () => void }).unref?.();
}

/** Records one event. Never throws: reporting a problem must not cause another. */
export async function recordOpsEvent(
    client: SupabaseClient,
    kind: OpsEventKind,
    opts: { orgId?: string | null; detail?: string } = {},
): Promise<void> {
    try {
        const orgId = opts.orgId ?? null;
        const detail = redactPII(opts.detail ?? '').slice(0, DETAIL_MAX);
        const count = opsEventSlot(kind, orgId);
        if (count === 0) {
            armTailFlush(client, kind, orgId, detail);
            return;
        }
        await writeEvent(client, kind, orgId, detail, count);
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
