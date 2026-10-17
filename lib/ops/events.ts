import type { SupabaseClient } from '@supabase/supabase-js';
import { redactPII } from '@/lib/utils/logger';

// Operational events the team is emailed about (tracker 3.5, migration 0070,
// owner decision 2026-10-18). Written with the service-role client. `detail`
// is a short fixed text plus ids and Meta error codes — never a phone number,
// a name or message text; it is redacted anyway and cut to the column limit.

export type OpsEventKind =
    | 'webhook_signature_invalid'
    | 'webhook_error'
    | 'queue_job_failed'
    | 'whatsapp_token_invalid';

const DETAIL_MAX = 500;

// At most MAX_PER_WINDOW events per kind and org per minute per server
// process: a flood (e.g. forged webhooks, each refused with 403) must not
// fill the table. The email only needs to know that it happened.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const windows = new Map<string, { start: number; count: number }>();

export function opsEventAllowed(kind: string, orgId: string | null | undefined, now = Date.now()): boolean {
    const key = `${kind}:${orgId ?? '-'}`;
    const w = windows.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
        windows.set(key, { start: now, count: 1 });
        return true;
    }
    if (w.count >= MAX_PER_WINDOW) return false;
    w.count += 1;
    return true;
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
    if (!opsEventAllowed(kind, opts.orgId)) return;
    try {
        const { error } = await client.from('ops_events').insert({
            kind,
            org_id: opts.orgId ?? null,
            detail: redactPII(opts.detail ?? '').slice(0, DETAIL_MAX),
        });
        if (error) console.error('Ops event not recorded', { kind, code: error.code });
    } catch {
        console.error('Ops event not recorded', { kind });
    }
}

/**
 * A short, PII-free description of an error for an ops event: the Meta error
 * code and title when there is one, else the error class. Never the message
 * of an arbitrary error (it can quote a phone number or customer text).
 */
export function describeErrorForOps(err: unknown): string {
    if (err && typeof err === 'object') {
        const e = err as { code?: unknown; title?: unknown; name?: unknown };
        if (typeof e.code === 'number') {
            return `Meta ${e.code}${typeof e.title === 'string' ? ` (${e.title})` : ''}`;
        }
        if (typeof e.name === 'string' && e.name) return e.name;
    }
    return 'unknown error';
}

/** True for Meta's "access token invalid or expired" (code 190). */
export function isWhatsAppTokenError(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 190;
}
