import type { SupabaseClient } from '@supabase/supabase-js';
import { whatsappLogger } from '@/lib/utils/logger';
import { recordOpsEvent } from '@/lib/ops/events';
import { classify, countsTowardPoison, describeItemError } from '@/lib/whatsapp/webhook/errors';
import { applyStatuses, type StatusRow } from '@/lib/whatsapp/webhook/ingest';
import { BUDGET_MS, STATUS_REAPPLY_MAX_AGE_MS, STATUS_REAPPLY_MS } from '@/lib/whatsapp/webhook/limits';
import { clearPoison, isPoisoned, notePoison } from '@/lib/whatsapp/webhook/outcome';
import { isRecord, parseMetaTimestamp } from '@/lib/whatsapp/webhook/payload';
import { runInBackground } from '@/lib/whatsapp/webhook/background';
import type { BatchRun } from '@/lib/whatsapp/webhook/types';

// Delivery status callbacks (sent, delivered, read, failed), written back to
// the rows of our sent messages by wa_apply_statuses: one call per change,
// forward only (a late 'delivered' never undoes 'read'), by Meta's time,
// only on the org's own outbound ('assistant') rows. Failed deliveries (e.g.
// 131047 past the 24h customer service window) carry Meta's error, so the
// dashboard can say why a reply did not arrive.

// Only the canonical Meta states we track; others (e.g. 'deleted') are
// acknowledged and ignored.
const TRACKED = new Set(['sent', 'delivered', 'read', 'failed']);

function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The tracked statuses of one change as wa_apply_statuses reads them, and how
 * many entries could not be read at all (not an object, or no id).
 */
export function normalizeStatuses(list: unknown[], now = Date.now()): { rows: StatusRow[]; malformed: number } {
    const rows: StatusRow[] = [];
    let malformed = 0;
    for (const s of list) {
        if (!isRecord(s) || !text(s.id)) {
            malformed += 1;
            continue;
        }
        if (typeof s.status !== 'string' || !TRACKED.has(s.status)) continue;
        // Meta's error of a failed delivery: errors[0] code, title, details.
        const err = s.status === 'failed' && Array.isArray(s.errors) && isRecord(s.errors[0]) ? s.errors[0] : null;
        const errorData = err && isRecord(err.error_data) ? err.error_data : null;
        rows.push({
            id: s.id as string,
            status: s.status as StatusRow['status'],
            ts: parseMetaTimestamp(s.timestamp, now)?.toISOString() ?? null,
            error_code: err && typeof err.code === 'number' && Number.isInteger(err.code) ? err.code : null,
            error_title: err ? text(err.title) : null,
            error_detail: err ? (text(errorData?.details) ?? text(err.message)) : null,
            // Enrichment: recipient_id (phone) + recipient_user_id (BSUID)
            // backfill the contact's bsuid where it is not set yet.
            recipient_id: text(s.recipient_id),
            recipient_user_id: text(s.recipient_user_id),
        });
    }
    return { rows, malformed };
}

/**
 * A status can arrive before the row of the message it is about (the queue
 * stores the reply after Meta accepted it). Such a young status that is not
 * 'sent' is applied once more, STATUS_REAPPLY_MS later, in the background.
 */
function scheduleReapply(supabase: SupabaseClient, orgId: string, rows: StatusRow[]): void {
    const timer = setTimeout(() => {
        runInBackground('status re-apply', async () => {
            const result = await applyStatuses(supabase, orgId, rows, AbortSignal.timeout(BUDGET_MS));
            whatsappLogger.info(`Statuses re-applied: ${rows.length} sent again, ${result.applied} applied, ${result.unknown} still without a message row`);
        });
    }, STATUS_REAPPLY_MS);
    (timer as { unref?: () => void }).unref?.();
}

/** Pass 3 of a delivery: the statuses of one change. */
export async function handleChangeStatuses(run: BatchRun, list: unknown[]): Promise<void> {
    const { outcome } = run;
    if (list.length === 0) return;
    outcome.items += list.length;
    const now = Date.now();
    const { rows, malformed } = normalizeStatuses(list, now);
    const untracked = list.length - rows.length - malformed;
    if (untracked > 0) outcome.done('acked', untracked);
    if (malformed > 0) {
        whatsappLogger.warn(`${malformed} status entr${malformed === 1 ? 'y' : 'ies'} without an id — skipped`);
        await recordOpsEvent(run.supabase, 'webhook_payload_invalid', {
            orgId: outcome.orgId,
            detail: `${malformed} status tanpa id; dilewati`,
        });
        outcome.done('skipped', malformed);
    }
    if (rows.length === 0) return;
    if (outcome.shouldDefer()) {
        outcome.deferred(rows.length);
        return;
    }
    let orgId: string;
    try {
        orgId = (await run.org()).orgId;
    } catch (error) {
        outcome.failed(error, rows.length);
        return;
    }
    const keys = rows.map((r) => `st.${r.id}.${r.status}`);
    const signal = outcome.signal();
    try {
        const result = await applyStatuses(run.supabase, orgId, rows, signal);
        keys.forEach(clearPoison);
        outcome.appliedStatuses(result.applied, result.stale, result.unknown);
        whatsappLogger.info(
            `Statuses: ${rows.length} received, ${result.applied} applied, ${result.stale} stale, ${result.unknown} without a message row` +
                (result.bsuidFilled || result.bsuidConflicts ? `, bsuid filled ${result.bsuidFilled}, conflicts ${result.bsuidConflicts}` : ''),
        );
        const unknown = new Set(result.unknownIds);
        const young = rows.filter(
            (r) => unknown.has(r.id) && r.status !== 'sent' && r.ts !== null && Date.now() - Date.parse(r.ts) <= STATUS_REAPPLY_MAX_AGE_MS,
        );
        if (young.length > 0) scheduleReapply(run.supabase, orgId, young);
    } catch (error) {
        if (signal.aborted) {
            outcome.deferred(rows.length);
            return;
        }
        // Trying again cannot help (permanent), or these statuses failed
        // POISON_LIMIT times in this process: skipped, with an alert. A
        // status is not worth a 503 for days.
        const permanent = classify(error) === 'permanent';
        if (permanent || (countsTowardPoison(error) && keys.map(notePoison).every(isPoisoned))) {
            keys.forEach(clearPoison);
            await recordOpsEvent(run.supabase, 'webhook_payload_invalid', {
                orgId,
                detail: `${rows.length} status: ${describeItemError(error)}; dilewati`,
            });
            outcome.done('skipped', rows.length);
            return;
        }
        whatsappLogger.error(`Statuses not applied (${rows.length}) — retryable`, error);
        outcome.failed(error, rows.length);
    }
}
