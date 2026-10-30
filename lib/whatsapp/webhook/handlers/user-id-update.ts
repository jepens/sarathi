import { createHash } from 'crypto';
import { whatsappLogger } from '@/lib/utils/logger';
import { recordOpsEvent } from '@/lib/ops/events';
import { classify, countsTowardPoison, describeItemError, RpcError } from '@/lib/whatsapp/webhook/errors';
import { clearPoison, isPoisoned, notePoison } from '@/lib/whatsapp/webhook/outcome';
import { isRecord, sanitizeForPg } from '@/lib/whatsapp/webhook/payload';
import type { BatchRun, MetaJson } from '@/lib/whatsapp/webhook/types';

// A customer's new phone number: their stored BSUID moves to the new one, so
// the contact stays linked.

// Phase B — user_id_update. Meta fires this when a customer changes their
// phone number: the BSUID regenerates and we get the old + new IDs. We move
// our stored bsuid from old → new so the next inbound message still resolves
// to the same contact (phone_number PK stays put — no re-key).
//
// Real Meta payload (WhatsApp BSUID docs), field "user_id_update":
//   value.user_id_update: [ { wa_id, detail,
//     user_id: { previous: <OLD_BSUID>, current: <NEW_BSUID> },
//     parent_user_id: { previous, current }, timestamp } ]
// We read the nested user_id.previous/current, and still fall back to a few
// flat guesses in case Meta tweaks the shape during the 2026 rollout.

/** The update entries of one change: value.user_id_update[] (or the plural, or the value itself). */
export function userIdUpdatesOf(value: MetaJson): Array<Record<string, unknown>> {
    const v: Record<string, unknown> = isRecord(value) ? value : {};
    // Container: value.user_id_update[] (the documented shape); accept the
    // plural and a bare object too, defensively.
    const container: unknown[] = Array.isArray(v.user_id_update)
        ? v.user_id_update
        : Array.isArray(v.user_id_updates)
            ? v.user_id_updates
            : [v];
    return container.filter(isRecord);
}

function pick(o: Record<string, unknown>, keys: string[]): string | null {
    for (const k of keys) {
        const v = o[k];
        if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
}

/** The old and new BSUID of one entry, or null when the entry cannot be read. */
export function parseUserIdUpdate(u: Record<string, unknown>): { oldId: string; newId: string } | null {
    // The documented shape nests the ids under `user_id: { previous, current }`.
    const uid = isRecord(u.user_id) ? u.user_id : null;
    const oldId =
        (uid && pick(uid, ['previous'])) ||
        pick(u, ['old_user_id', 'previous_user_id', 'old_wa_id', 'previous_wa_id']);
    const newId =
        (uid && pick(uid, ['current'])) ||
        pick(u, ['new_user_id', 'current_user_id', 'new_wa_id', 'current_wa_id']);
    return oldId && newId ? sanitizeForPg({ oldId, newId }) : null;
}

/** The entry's Meta time for the sort (unix seconds), else now. */
function entryTime(u: Record<string, unknown>, now: number): number {
    const t = u.timestamp;
    if (typeof t === 'string' && /^\d{1,12}$/.test(t)) return Number(t) * 1000;
    if (typeof t === 'number' && Number.isFinite(t)) return t * 1000;
    return now;
}

/**
 * Pass 1 of a delivery: every user_id_update entry of the batch, oldest first
 * (Meta's timestamp; payload order on ties), before any message, so a
 * message carrying the new BSUID finds the chat that moved. Each entry moves
 * the org's chats still on the old id (filters exactly org_id and bsuid). A
 * database error is retryable (503; a resend only moves rows still on the
 * old id); a 23505 (another chat of the org already holds the new id) cannot
 * succeed on a retry and is only logged.
 */
export async function handleUserIdUpdates(run: BatchRun, values: MetaJson[]): Promise<void> {
    const { outcome } = run;
    const now = Date.now();
    const entries = values
        .flatMap((value) => userIdUpdatesOf(value))
        .map((u, position) => ({ u, position, at: entryTime(u, now) }))
        .sort((a, b) => a.at - b.at || a.position - b.position);
    outcome.items += entries.length;

    for (const { u } of entries) {
        const parsed = parseUserIdUpdate(u);
        if (!parsed) {
            // Nothing a retry could read (e.g. Meta changed the shape during
            // the BSUID rollout): skipped, with an alert so the parser is
            // looked at.
            whatsappLogger.warn(`user_id_update: could not parse old/new id (fields: ${Object.keys(u).join(',') || '-'})`);
            await recordOpsEvent(run.supabase, 'webhook_payload_invalid', {
                orgId: outcome.orgId,
                detail: 'user_id_update tanpa id lama/baru yang terbaca; dilewati',
            });
            outcome.done('skipped');
            continue;
        }
        const { oldId, newId } = parsed;
        if (outcome.shouldDefer()) {
            run.heldBsuids.add(newId);
            outcome.deferred();
            continue;
        }
        let orgId: string;
        try {
            orgId = (await run.org()).orgId;
        } catch (error) {
            run.heldBsuids.add(newId);
            outcome.failed(error);
            continue;
        }
        const poisonKey = `uid.${createHash('sha256').update(`${oldId}|${newId}`).digest('hex').slice(0, 32)}`;
        const signal = outcome.signal();
        try {
            const { data, error, status } = await run.supabase
                .from('whatsapp_chats')
                .update({ bsuid: newId, updated_at: new Date().toISOString() })
                .eq('org_id', orgId)
                .eq('bsuid', oldId)
                .abortSignal(signal)
                .select('phone_number');
            if (error) throw new RpcError('user_id_update', error, status);
            whatsappLogger.info(`user_id_update: moved bsuid ${oldId}→${newId} for ${Array.isArray(data) ? data.length : 0} contact(s)`);
            clearPoison(poisonKey);
            outcome.done('acked');
            outcome.answered();
        } catch (error) {
            if (signal.aborted) {
                run.heldBsuids.add(newId);
                outcome.deferred();
                continue;
            }
            if (error instanceof RpcError && error.code === '23505') {
                whatsappLogger.warn('user_id_update: the new BSUID already belongs to another chat of the org — not moved');
                clearPoison(poisonKey);
                outcome.done('skipped');
                outcome.answered();
                continue;
            }
            const permanent = classify(error) === 'permanent';
            if (permanent || (countsTowardPoison(error) && isPoisoned(notePoison(poisonKey)))) {
                clearPoison(poisonKey);
                await recordOpsEvent(run.supabase, 'webhook_payload_invalid', {
                    orgId,
                    detail: `user_id_update: ${describeItemError(error)}; dilewati`,
                });
                outcome.done('skipped');
                continue;
            }
            whatsappLogger.error('user_id_update: failed to move the bsuid — retryable', error);
            run.heldBsuids.add(newId);
            outcome.failed(error);
        }
    }
}
