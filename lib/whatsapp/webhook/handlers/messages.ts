import { whatsappLogger } from '@/lib/utils/logger';
import { recordOpsEvent } from '@/lib/ops/events';
import { isStoredOtherMessageType } from '@/lib/whatsapp/flow-summary';
import type { OtherNumber } from '@/lib/whatsapp/other-number';
import { matchContact, senderIdentity, syntheticKey, type SenderIdentity } from '@/lib/whatsapp/webhook/contact';
import { classify, countsTowardPoison, describeItemError } from '@/lib/whatsapp/webhook/errors';
import { POISON_LIMIT } from '@/lib/whatsapp/webhook/limits';
import { clearPoison, isPoisoned, notePoison, type ItemResult } from '@/lib/whatsapp/webhook/outcome';
import { isRecord, metaWord, parseMetaTimestamp, sanitizeForPg } from '@/lib/whatsapp/webhook/payload';
import type { BatchRun, MessageContext, MetaJson } from '@/lib/whatsapp/webhook/types';
import { handleContactsMessage } from '@/lib/whatsapp/webhook/handlers/contacts';
import { handleInteractiveMessage } from '@/lib/whatsapp/webhook/handlers/interactive';
import { handleMediaMessage } from '@/lib/whatsapp/webhook/handlers/media';
import { handleOtherMessage } from '@/lib/whatsapp/webhook/handlers/other-types';
import { handleTextMessage } from '@/lib/whatsapp/webhook/handlers/text';
import { ingestRow } from '@/lib/whatsapp/webhook/handlers/row';

// An inbound message: who sent it, then the handler for its type, with the
// per-item guard: an error of one message never stops the rest of the batch.
// A message is never dropped silently: when its own payload cannot be stored
// (or its error persists), it is stored as a placeholder that says so.

/** One messages[] entry, read once before the batch is walked. */
export interface MessagePlan {
    /** The messages[] entry; null when it is not an object. */
    message: Record<string, MetaJson> | null;
    type: string;
    /** Meta's wamid, or the syn. key of a message without one. */
    key: string;
    synthetic: boolean;
    replyTo: string | null;
    waTs: Date | null;
    identity: SenderIdentity;
    storeOnly: OtherNumber | null;
    /** Whether the type is stored at all (a reaction, for one, is not). */
    stores: boolean;
}

/**
 * The prelude of a message (pure): its key, Meta time, reply context, the
 * contact entry that describes its sender (matchContact: never another
 * customer's), and the sender's identity. Every string that may reach the
 * database is sanitised here, so the TS paths (cards, media, Flow) get clean
 * values too.
 */
export function planMessage(entry: unknown, value: MetaJson, storeOnly: OtherNumber | null, now = Date.now()): MessagePlan {
    const message = isRecord(entry) ? entry : null;
    const type = typeof message?.type === 'string' ? message.type : '';
    const id = typeof message?.id === 'string' && message.id.length > 0 ? message.id : null;
    const metadata = isRecord(value) && isRecord(value.metadata) ? value.metadata : null;
    const contact = matchContact(isRecord(value) ? value.contacts : undefined, entry);
    const context = message && isRecord(message.context) ? message.context : null;
    const replyTo = typeof context?.id === 'string' && context.id.length > 0 ? context.id : null;
    return {
        message,
        type,
        key: sanitizeForPg(id ?? syntheticKey(metadata?.phone_number_id, entry)),
        synthetic: id === null,
        replyTo: sanitizeForPg(replyTo),
        waTs: parseMetaTimestamp(message?.timestamp, now),
        identity: sanitizeForPg(senderIdentity(entry, contact)),
        storeOnly,
        stores: message !== null && isStoredOtherMessageType(type),
    };
}

export function hasIdentity(plan: MessagePlan): boolean {
    return plan.identity.from !== null || plan.identity.bsuid !== null;
}

async function dispatchMessage(ctx: MessageContext): Promise<ItemResult> {
    switch (ctx.type) {
        case 'text':
            return handleTextMessage(ctx);
        case 'contacts':
            return handleContactsMessage(ctx);
        case 'interactive':
            return handleInteractiveMessage(ctx);
        case 'image':
        case 'document':
        case 'audio':
        case 'video':
        case 'sticker':
            return handleMediaMessage(ctx);
        default:
            return handleOtherMessage(ctx);
    }
}

/** The type as alerts, logs and the placeholder name it: Meta's word, or 'tidak dikenal'. */
function typeLabel(type: string): string {
    return type ? metaWord(type) : 'tidak dikenal';
}

async function alertPayload(run: BatchRun, detail: string): Promise<void> {
    await recordOpsEvent(run.supabase, 'webhook_payload_invalid', { orgId: run.outcome.orgId, detail });
}

/**
 * The fallback of a message that cannot be stored as it is: one row that says
 * a message of this type arrived, without its content (metadata.unprocessable
 * keeps it out of the AI history), unread and pushed like any message, no
 * rate limit, no AI. If even that fails permanently the message is skipped;
 * if it fails retryably the item stays retryable (503).
 */
async function storePlaceholder(run: BatchRun, ctx: MessageContext, cause: unknown): Promise<void> {
    const { outcome } = run;
    const type = typeLabel(ctx.type);
    const why = describeItemError(cause);
    const content = `Pesan jenis "${type}" tidak bisa diproses otomatis (isinya tidak ditampilkan di Sarathi)`;
    try {
        const result = await ingestRow(ctx, {
            content,
            preview: content,
            metadata: { unprocessable: type },
            rateLimited: false,
            queueText: null,
            lateAgeMs: null,
        });
        clearPoison(ctx.key);
        if (result.outcome === 'no_identity') {
            await alertPayload(run, `pesan "${type}" tanpa identitas pengirim; dilewati`);
            outcome.done('skipped');
            return;
        }
        whatsappLogger.warn(`Inbound ${type} message stored as a placeholder (${why})`);
        await alertPayload(run, `pesan "${type}": ${why}; disimpan sebagai pengganti`);
        outcome.done('degraded');
    } catch (error) {
        if (ctx.signal.aborted) {
            outcome.deferred();
            return;
        }
        if (classify(error) === 'permanent') {
            clearPoison(ctx.key);
            whatsappLogger.error(`Inbound ${type} message skipped: not even a placeholder could be stored (${describeItemError(error)})`);
            await alertPayload(run, `pesan "${type}": ${why}; dilewati`);
            outcome.done('skipped');
            return;
        }
        whatsappLogger.error(`Inbound ${type} message: the placeholder could not be stored either — retryable`, error);
        outcome.failed(error);
    }
}

/**
 * One message of the batch (pass 2): skipped when the pre-dedup found it
 * stored, deferred when the budget or the stop rule says so, else dispatched
 * by type. A permanent error, or the POISON_LIMIT-th failure of the same key
 * in this process, stores a placeholder; any other failure is retryable.
 */
export async function handleMessageItem(run: BatchRun, plan: MessagePlan, stored: ReadonlySet<string>): Promise<void> {
    const { outcome } = run;
    const type = typeLabel(plan.type);
    if (plan.message === null) {
        // Not even an object (e.g. messages: [42]): no type, no sender of its
        // own, nothing a retry could read.
        whatsappLogger.warn('Inbound message entry that is not an object — skipped');
        await alertPayload(run, 'entri pesan tanpa isi terbaca; dilewati');
        outcome.done('skipped');
        return;
    }
    if (!plan.stores) {
        // A reaction, a number change or opening the chat: the customer wrote
        // nothing, so there is nothing to store (as part 1).
        whatsappLogger.info(`${type} event acknowledged without storing (the customer wrote nothing)`);
        outcome.done('acked');
        return;
    }
    if (!hasIdentity(plan)) {
        // No phone and no BSUID: nothing can key the chat, not even a
        // placeholder. Meta resending it would not help.
        whatsappLogger.warn(`Inbound ${type} message without a sender (no from, no BSUID) — skipped`);
        await alertPayload(run, `pesan "${type}" tanpa identitas pengirim; dilewati`);
        outcome.done('skipped');
        return;
    }
    if (stored.has(plan.key)) {
        // A redelivery of a message already stored: nothing happens again.
        outcome.done('duplicate');
        return;
    }
    if (plan.identity.bsuid !== null && run.heldBsuids.has(plan.identity.bsuid)) {
        // The customer's BSUID move (user_id_update, pass 1) failed or was
        // deferred in this delivery: stored now, the message would open a
        // second chat under the new BSUID. Meta's resend moves it first.
        whatsappLogger.warn(`Inbound ${type} message held back: the move of its BSUID is pending`);
        outcome.deferred();
        return;
    }
    if (outcome.shouldDefer()) {
        outcome.deferred();
        return;
    }
    let waCtx;
    try {
        waCtx = await run.org();
    } catch (error) {
        outcome.failed(error); // not the message's fault: no poison count
        return;
    }
    if (plan.synthetic) {
        whatsappLogger.warn(`Inbound ${type} message without an id — stored under a synthetic key (syn.)`);
    }
    const ctx: MessageContext = {
        supabase: run.supabase,
        waCtx,
        message: plan.message,
        type: plan.type,
        key: plan.key,
        replyTo: plan.replyTo,
        waTs: plan.waTs,
        identity: plan.identity,
        storeOnly: plan.storeOnly,
        signal: outcome.signal(),
        batch: run,
    };
    try {
        const result = await dispatchMessage(ctx);
        clearPoison(plan.key);
        if (result === 'skipped') {
            await alertPayload(run, `pesan "${type}" tanpa identitas pengirim; dilewati`);
        }
        outcome.done(result);
    } catch (error) {
        // The time budget ran out during the call: not the message's fault.
        if (ctx.signal.aborted) {
            outcome.deferred();
            return;
        }
        if (classify(error) === 'permanent') {
            await storePlaceholder(run, ctx, error);
            return;
        }
        // An outage or a missing function fails every item alike: not the
        // message's fault, so it never turns it into a placeholder.
        if (!countsTowardPoison(error)) {
            whatsappLogger.error(`Inbound ${type} message not stored (database unavailable or not migrated) — retryable`, error);
            outcome.failed(error);
            return;
        }
        const failures = notePoison(plan.key);
        if (isPoisoned(failures)) {
            await storePlaceholder(run, ctx, error);
            return;
        }
        whatsappLogger.error(`Inbound ${type} message not stored (failure ${failures} of ${POISON_LIMIT}) — retryable`, error);
        outcome.failed(error);
    }
}
