import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { whatsappLogger } from '@/lib/utils/logger';
import { describeErrorForOps, recordOpsEvent } from '@/lib/ops/events';
import { BUDGET_MS, POISON_LIMIT, STOP_AFTER_RETRYABLE } from '@/lib/whatsapp/webhook/limits';
import { opsHint } from '@/lib/whatsapp/webhook/errors';

// One delivery's result: what happened to each item (a message, a status, a
// user_id_update entry), the time budget and the stop rule, and the answer to
// Meta (respond). 503 only when trying again can help: an item failed in a way
// a retry can fix, or the budget ran out before every item was tried. Meta
// then sends the whole batch again; what was stored is skipped as a
// duplicate, so nothing is done twice.

export type ItemResult =
    | 'new'
    | 'duplicate'
    | 'rate_limited'
    /** Understood and deliberately not stored (a reaction, a status nobody tracks). */
    | 'acked'
    /** Handed to the media or Flow code of part 1, which stores it itself. */
    | 'legacy'
    /** Stored as a placeholder instead of its content. */
    | 'degraded'
    /** Could not be stored at all (permanent failure). */
    | 'skipped';

const COUNT_OF: Record<ItemResult, keyof BatchOutcome['counts']> = {
    new: 'new',
    duplicate: 'duplicate',
    rate_limited: 'rateLimited',
    acked: 'acked',
    legacy: 'legacy',
    degraded: 'degraded',
    skipped: 'skipped',
};

export class BatchOutcome {
    readonly startedAt: number;
    private readonly clock: () => number;
    /** Items the walk took on: messages, statuses and user_id_update entries. */
    items = 0;
    readonly counts = {
        new: 0,
        duplicate: 0,
        rateLimited: 0,
        acked: 0,
        legacy: 0,
        degraded: 0,
        skipped: 0,
        retryable: 0,
        deferred: 0,
    };
    readonly statuses = { applied: 0, stale: 0, unknown: 0 };
    /** The org, once it was read (alerts name it). */
    orgId: string | null = null;
    /** A message was queued or joined a waiting burst: the queue is drained once. */
    drain = false;
    private first: { error: unknown } | null = null;
    private streak = 0;
    private stopped: 'budget' | 'stop_rule' | null = null;
    /** Items the database answered that done() counts as acked or skipped (see answered()). */
    private answeredOther = 0;

    constructor(startedAt = Date.now(), clock: () => number = () => Date.now()) {
        this.startedAt = startedAt;
        this.clock = clock;
    }

    /** What is left of the time budget, at least 1 ms. */
    remainingMs(): number {
        return Math.max(1, this.startedAt + BUDGET_MS - this.clock());
    }

    /** A signal that aborts a database call when the time budget runs out. */
    signal(): AbortSignal {
        return AbortSignal.timeout(this.remainingMs());
    }

    /**
     * Asked before every item: true when the rest of the batch is deferred
     * without being tried, because the budget is used up or the last
     * STOP_AFTER_RETRYABLE calls all failed (the database is likely down, and
     * every further call would only wait for its timeout).
     */
    shouldDefer(): boolean {
        if (this.stopped === null) {
            if (this.streak >= STOP_AFTER_RETRYABLE) this.stopped = 'stop_rule';
            else if (this.clock() - this.startedAt >= BUDGET_MS) this.stopped = 'budget';
        }
        return this.stopped !== null;
    }

    /** `items` items done (stored, a duplicate, acknowledged, degraded or skipped). */
    done(result: ItemResult, items = 1): void {
        this.counts[COUNT_OF[result]] += items;
        this.streak = 0;
    }

    /**
     * The database answered for an item that done() counts as acked or
     * skipped (a BSUID moved, or refused with 23505): progress for respond(),
     * without a counter of its own in the log line.
     */
    answered(): void {
        this.answeredOther += 1;
    }

    /** A change's statuses went through wa_apply_statuses (their own counters). */
    appliedStatuses(applied: number, stale: number, unknown: number): void {
        this.statuses.applied += applied;
        this.statuses.stale += stale;
        this.statuses.unknown += unknown;
        this.streak = 0;
    }

    /** One call failed in a way a retry can fix; it covered `items` items. */
    failed(error: unknown, items = 1): void {
        this.counts.retryable += items;
        this.streak += 1;
        if (this.first === null) this.first = { error };
    }

    /** `items` items were not tried (budget or stop rule) or their call ran out of time. */
    deferred(items = 1): void {
        this.counts.deferred += items;
    }

    /**
     * Whether the database answered for any item of the batch (stored, found
     * stored, counted, handed over, applied, or a BSUID moved or refused with
     * 23505).
     */
    progressed(): boolean {
        const c = this.counts;
        const s = this.statuses;
        return (
            c.new + c.duplicate + c.rateLimited + c.legacy + c.degraded + s.applied + s.stale + s.unknown + this.answeredOther > 0
        );
    }

    /** The first retryable error of the batch, if any. */
    firstError(): { error: unknown } | null {
        return this.first;
    }

    /** Counts only (KEA-21): never an id, a phone number or message text. */
    logLine(httpStatus?: number): string {
        const c = this.counts;
        const s = this.statuses;
        return (
            `Webhook batch: items=${this.items} new=${c.new} duplicate=${c.duplicate} rate_limited=${c.rateLimited} ` +
            `acked=${c.acked} legacy=${c.legacy} degraded=${c.degraded} skipped=${c.skipped} retryable=${c.retryable} ` +
            `deferred=${c.deferred}${this.stopped ? ` (${this.stopped})` : ''} ` +
            `statuses applied=${s.applied} stale=${s.stale} unknown=${s.unknown} ms=${this.clock() - this.startedAt}` +
            (httpStatus === undefined ? '' : ` http=${httpStatus}`)
        );
    }
}

// The poison counter: how often each item failed in this server process,
// keyed by item (a message's key, a status's id and status, a user_id_update
// hash). At POISON_LIMIT a message is stored as a placeholder and a status or
// user_id_update is skipped, so one item the database keeps refusing cannot
// keep the batch in 503 for the days Meta keeps retrying. Only failures that
// countsTowardPoison (errors.ts) counts are noted: a database answer specific
// to the item; never an outage or a thrown bug (D24). A restart forgets the
// counts (an item then gets POISON_LIMIT more tries); the map keeps the
// newest keys.
const poison = new Map<string, number>();
const POISON_KEYS_MAX = 1000;

/** Counts one more failure of the item and returns its count. */
export function notePoison(key: string): number {
    const n = (poison.get(key) ?? 0) + 1;
    poison.delete(key); // re-inserted below as the newest
    if (poison.size >= POISON_KEYS_MAX) {
        const oldest = poison.keys().next().value;
        if (oldest !== undefined) poison.delete(oldest);
    }
    poison.set(key, n);
    return n;
}

/** Whether an item failed often enough to stop retrying it. */
export function isPoisoned(count: number): boolean {
    return count >= POISON_LIMIT;
}

/** The item went through: forget its failures. */
export function clearPoison(key: string): void {
    poison.delete(key);
}

/** Tests only. */
export function resetPoison(): void {
    poison.clear();
}

/** Tests only: the counts the poison counter holds. */
export function poisonCount(key: string): number {
    return poison.get(key) ?? 0;
}

/**
 * The answer to Meta, after every item was tried or deferred:
 * - an item failed retryably (including an org that could not be read): 503,
 *   and one webhook_error for the batch with the first error and a hint;
 * - items deferred by the time budget, nothing failed: 503 and
 *   webhook_deferred (emailed once a day: it is expected under load), or
 *   webhook_error when no item at all got an answer from the database (a
 *   slow or silent database is an outage, not load);
 * - otherwise 200 (a permanent failure was alerted when it happened).
 *
 * The batch's log line comes before the alert write: that write goes to the
 * same database the alert may be about, so it could come late or not at all,
 * and ms= is the walk's time, not the write's.
 */
export async function respond(client: SupabaseClient, outcome: BatchOutcome): Promise<NextResponse> {
    const alert = alertFor(outcome);
    const status = alert ? 503 : 200;
    logBatch(outcome, status);
    if (alert) await recordOpsEvent(client, alert.kind, { orgId: outcome.orgId, detail: alert.detail });
    return status === 503
        ? new NextResponse('Service Unavailable', { status: 503 })
        : new NextResponse('EVENT_RECEIVED', { status: 200 });
}

/** The alert of a batch answered 503 (respond()), or null for a 200. */
function alertFor(outcome: BatchOutcome): { kind: 'webhook_error' | 'webhook_deferred'; detail: string } | null {
    const first = outcome.firstError();
    if (first) {
        const hint = opsHint(first.error);
        return {
            kind: 'webhook_error',
            detail: `${describeErrorForOps(first.error)}${hint ? ` — ${hint}` : ''} (${outcome.counts.retryable} dari ${outcome.items} item)`,
        };
    }
    if (outcome.counts.deferred > 0 && !outcome.progressed()) {
        return {
            kind: 'webhook_error',
            detail: `database lambat atau tidak menjawab: ${outcome.counts.deferred} dari ${outcome.items} item ditunda tanpa satu pun selesai dalam ${BUDGET_MS / 1000} detik; webhook menjawab 503, Meta mengirim ulang`,
        };
    }
    if (outcome.counts.deferred > 0) {
        return {
            kind: 'webhook_deferred',
            detail: `${outcome.counts.deferred} dari ${outcome.items} item ditunda: batas waktu ${BUDGET_MS / 1000} detik habis; webhook menjawab 503, Meta mengirim ulang`,
        };
    }
    return null;
}

/** The result log line of a batch, with the answer Meta got. */
export function logBatch(outcome: BatchOutcome, httpStatus?: number): void {
    whatsappLogger.info(outcome.logLine(httpStatus));
}
