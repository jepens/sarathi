import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { contactCardSummary } from '@/lib/whatsapp/flow-summary';
import { resolveContactKey, sharedCardPhone } from '@/lib/whatsapp/webhook/contact';
import { RpcError } from '@/lib/whatsapp/webhook/errors';
import type { ItemResult } from '@/lib/whatsapp/webhook/outcome';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';
import { storeOnlySummary } from '@/lib/whatsapp/webhook/handlers/store-only';

// A contact card from the customer: the shared phone kept as verified_phone, or
// only stored for another number.

export async function handleContactsMessage(ctx: MessageContext): Promise<ItemResult> {
    const { supabase, waCtx, message, identity, storeOnly } = ctx;

    // A card sent to another number of the WABA (store-only) is only stored
    // for the operators: it was not an answer to this number's request.
    if (storeOnly) return storeOnlySummary(ctx, contactCardSummary(message.contacts), '👤 Kartu kontak');

    // ===== Phase C: explicit contact share (REQUEST_CONTACT_INFO) =====
    // When a customer taps the REQUEST_CONTACT_INFO button (or sends a
    // contact card), Meta delivers a `contacts`-type message with the shared
    // phone. Capture it into verified_phone and leave a note for the
    // operators (D23-3: a system note, not an inbox message); no AI reply.
    const cards = Array.isArray(message.contacts) ? message.contacts : [];
    const recovered = sharedCardPhone(cards[0]) ?? identity.waId;
    if (!recovered) {
        whatsappLogger.warn('Contact share had no usable phone — acknowledged');
        return 'acked';
    }
    const orgId = waCtx.orgId;
    const contactKey = await resolveContactKey(supabase, orgId, identity.from, identity.bsuid);
    if (!contactKey) return 'skipped'; // unreachable: the prelude requires a phone or a BSUID

    // Upsert (not update): a contact share could be the first event we see
    // for this key, and the recovered phone must not be dropped. A failed
    // write is now an error of the item (retried by Meta), no longer ignored.
    const { error: chatError, status: chatStatus } = await supabase
        .from('whatsapp_chats')
        .upsert(
            { org_id: orgId, phone_number: contactKey, verified_phone: recovered, updated_at: new Date().toISOString() },
            { onConflict: 'org_id,phone_number' },
        )
        .abortSignal(ctx.signal);
    if (chatError) throw new RpcError('whatsapp_chats upsert', chatError, chatStatus);
    // The BSUID in its own write: when another chat of the org already holds
    // it (unique), only the BSUID is left out, never the phone or the note.
    if (identity.bsuid) {
        const { error: bsuidError, status: bsuidStatus } = await supabase
            .from('whatsapp_chats')
            .update({ bsuid: identity.bsuid })
            .eq('org_id', orgId)
            .eq('phone_number', contactKey)
            .abortSignal(ctx.signal);
        if (bsuidError && (bsuidError as { code?: unknown }).code === '23505') {
            whatsappLogger.warn('Contact share: the BSUID already belongs to another chat of the org — not recorded');
        } else if (bsuidError) {
            throw new RpcError('whatsapp_chats bsuid update', bsuidError, bsuidStatus);
        }
    }
    // Not a reply to the customer: an earlier unanswered message keeps the
    // chat "Belum dibalas". Keyed by the card's wamid, so a redelivery that
    // got past the batch's pre-dedup writes no second note.
    const note = await logSystemMessage(orgId, contactKey, `Customer shared contact info — phone tersimpan: ${recovered}`, {
        touchChat: false,
        waMessageId: ctx.key,
    });
    if (note.status === 'failed') throw note.error ?? new Error('contact-share note not stored');
    if (note.status === 'duplicate') return 'duplicate';
    whatsappLogger.info(`Contact share captured for ${contactKey}: ${recovered}`);
    return 'new';
}
