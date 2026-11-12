import { whatsappLogger } from '@/lib/utils/logger';
import { isStoredOtherMessageType, otherMessagePreview, otherMessageSummary } from '@/lib/whatsapp/flow-summary';
import { isRecord, metaWord } from '@/lib/whatsapp/webhook/payload';
import type { ItemResult } from '@/lib/whatsapp/webhook/outcome';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';
import { ingestRow, rowResult } from '@/lib/whatsapp/webhook/handlers/row';

// Every message type without a handler of its own: a template's quick-reply
// button, a button or list choice, a location, an order, a type Sarathi does
// not show. On either number it is stored as one readable line, without AI
// (owner decision D23-4: unread, push, "Belum dibalas"; part 1 dropped them
// silently on the main number), so no message a customer wrote is lost.
// Events where the customer wrote nothing (a number change, opening the chat,
// a reaction) are only acknowledged.

// The types whose line carries what the customer chose or shared (a button
// or list title, a place): the AI history keeps them as context. Any other
// line only says that a message arrived ("isinya tidak ditampilkan"): marked
// like a placeholder (metadata.unprocessable), so the AI never reads it as
// something the customer said.
function readableSummary(message: MessageContext['message']): boolean {
    if (message.type === 'button' || message.type === 'location') return true;
    const interactive = message.interactive;
    return message.type === 'interactive' && isRecord(interactive)
        && (isRecord(interactive.button_reply) || isRecord(interactive.list_reply));
}

export async function handleOtherMessage(ctx: MessageContext): Promise<ItemResult> {
    if (!isStoredOtherMessageType(ctx.type)) {
        whatsappLogger.info(`${metaWord(ctx.type)} event acknowledged without storing (the customer wrote nothing)`);
        return 'acked';
    }
    const result = await ingestRow(ctx, {
        content: otherMessageSummary(ctx.message),
        // A location's address stays out of the preview and the push.
        preview: otherMessagePreview(ctx.message),
        metadata: readableSummary(ctx.message) ? undefined : { unprocessable: metaWord(ctx.type) },
        rateLimited: true,
        queueText: null,
        lateAgeMs: null,
    });
    return rowResult(result);
}
