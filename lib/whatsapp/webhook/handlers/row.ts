import { QUOTA_DEFAULTS } from '@/lib/quota/org-quota';
import { otherNumberMetadata } from '@/lib/whatsapp/other-number';
import { RATE_LIMIT_PER_MINUTE } from '@/lib/whatsapp/webhook/limits';
import { ingestInbound, type IngestResult } from '@/lib/whatsapp/webhook/ingest';
import { afterIngest } from '@/lib/whatsapp/webhook/after-ingest';
import type { ItemResult } from '@/lib/whatsapp/webhook/outcome';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';

// One inbound message stored as a row through wa_ingest_inbound (texts,
// summaries of other types, placeholders), then its effects. Every row is
// unread and moves the chat summary by Meta's time; the handler decides the
// content, the rate limit and whether the AI may answer.

export interface RowSpec {
    content: string;
    /** The chat-list preview and the push body. */
    preview: string;
    /** whatsapp_messages.metadata; other_number is added for another number. */
    metadata?: Record<string, unknown>;
    /** Counted against the contact's rate limit (every row but a placeholder). */
    rateLimited: boolean;
    /** The text the AI queue gets, when the message may get an AI reply. */
    queueText: string | null;
    /** A late main-number text: its age by Meta's time, else null. */
    lateAgeMs: number | null;
}

export async function ingestRow(ctx: MessageContext, spec: RowSpec): Promise<IngestResult> {
    // Never AI for another number of the WABA: the reply would come from the
    // main number.
    const ai = spec.queueText !== null && ctx.storeOnly === null;
    const result = await ingestInbound(
        ctx.supabase,
        {
            p_org: ctx.waCtx.orgId,
            p_from: ctx.identity.from,
            p_bsuid: ctx.identity.bsuid,
            p_wamid: ctx.key,
            p_wa_ts: ctx.waTs ? ctx.waTs.toISOString() : null,
            p_content: spec.content,
            p_preview: spec.preview,
            p_verified_phone: ctx.identity.waId,
            p_reply_to_wamid: ctx.replyTo,
            p_media_type: null,
            p_media_mime: null,
            p_media_filename: null,
            p_metadata: { ...(spec.metadata ?? {}), ...(ctx.storeOnly ? otherNumberMetadata(ctx.storeOnly) : {}) },
            p_unread: true,
            // Another number has its own bucket ('<org>:other:<key>'), so a
            // flood there does not limit the customer on the main number.
            p_rate_scope: spec.rateLimited ? (ctx.storeOnly ? 'other' : 'main') : null,
            p_rate_max: spec.rateLimited ? RATE_LIMIT_PER_MINUTE : null,
            p_ai_eligible: ai,
            p_queue_text: ai ? spec.queueText : null,
            p_inbound_limit: ai ? QUOTA_DEFAULTS.inbound_minute : null,
            p_work_kind: null,
            p_work_payload: null,
        },
        ctx.signal,
    );
    afterIngest(ctx, { preview: spec.preview, lateAgeMs: spec.lateAgeMs }, result);
    return result;
}

/** A row's outcome as the batch counts it; 'skipped' is a database 'no_identity'. */
export function rowResult(result: IngestResult): ItemResult {
    switch (result.outcome) {
        case 'new':
            return 'new';
        case 'duplicate':
            return 'duplicate';
        case 'rate_limited':
            return 'rate_limited';
        default:
            return 'skipped';
    }
}
