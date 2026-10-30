import type { ItemResult } from '@/lib/whatsapp/webhook/outcome';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';
import { ingestRow, rowResult } from '@/lib/whatsapp/webhook/handlers/row';

// A message other than text sent to another number of the WABA (process mode):
// stored for the operators, never acted on.

// A Flow submission or a contact card sent to another number of the WABA
// (store-only): kept for the operators as a readable row, with the chat
// summary, the unread badge and the push of any inbound message. Nothing acts
// on it: no Brief Acara lead or confirmation (flow-response.ts; it would go
// out from the main number), no verified_phone taken from a shared card (the
// row records the sender's own phone, as for any message). Within the
// contact's own rate limit for messages to another number (shared with text;
// over it: not stored, one note per window).
export async function storeOnlySummary(ctx: MessageContext, content: string, preview: string): Promise<ItemResult> {
    const result = await ingestRow(ctx, { content, preview, rateLimited: true, queueText: null, lateAgeMs: null });
    return rowResult(result);
}
