import { AI_MAX_AGE_HOURS } from '@/lib/whatsapp/webhook/limits';
import { MalformedPayloadError } from '@/lib/whatsapp/webhook/errors';
import { isRecord } from '@/lib/whatsapp/webhook/payload';
import type { ItemResult } from '@/lib/whatsapp/webhook/outcome';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';
import { ingestRow, rowResult } from '@/lib/whatsapp/webhook/handlers/row';

// A text message. One wa_ingest_inbound call does what part 1 did in several
// steps, in one transaction: the redelivery gate, the contact's rate limit,
// the chat and its summary, the message row, the unread count, and, for the
// main number, the AI switch, the org's minute quota and the AI queue job.
// The push, the notes and the queue drain follow after the commit
// (after-ingest.ts).

const LATE_MS = AI_MAX_AGE_HOURS * 60 * 60 * 1000;

export async function handleTextMessage(ctx: MessageContext): Promise<ItemResult> {
    const body = isRecord(ctx.message.text) ? ctx.message.text.body : undefined;
    if (typeof body !== 'string') throw new MalformedPayloadError('teks tanpa isi');

    // The main number's AI answers, unless the text reached us 20 hours or
    // more after the customer sent it (D23-2: stored for the operators with a
    // note instead). A message to another number of the WABA never gets an
    // AI reply: it would come from the main number.
    let queueText: string | null = null;
    let lateAgeMs: number | null = null;
    if (!ctx.storeOnly) {
        const age = ctx.waTs ? Date.now() - ctx.waTs.getTime() : null;
        if (age !== null && age >= LATE_MS) lateAgeMs = age;
        else queueText = body;
    }
    const result = await ingestRow(ctx, { content: body, preview: body, rateLimited: true, queueText, lateAgeMs });
    return rowResult(result);
}
