import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppContext } from '@/lib/whatsapp/credentials';
import { whatsappLogger } from '@/lib/utils/logger';
import { isStoredOtherMessageType, otherMessagePreview, otherMessageSummary } from '@/lib/whatsapp/flow-summary';
import type { OtherNumber } from '@/lib/whatsapp/other-number';
import type { MetaJson } from '@/lib/whatsapp/webhook/types';
import { looksLikePhone, resolveContactKey } from '@/lib/whatsapp/webhook/contact';
import { handleContactsMessage } from '@/lib/whatsapp/webhook/handlers/contacts';
import { handleInteractiveMessage } from '@/lib/whatsapp/webhook/handlers/interactive';
import { handleMediaMessage } from '@/lib/whatsapp/webhook/handlers/media';
import { handleTextMessage } from '@/lib/whatsapp/webhook/handlers/text';
import { storeOtherNumberMessage } from '@/lib/whatsapp/webhook/handlers/store-only';

// An inbound message: who sent it, then the handler for its type.

export interface InboundMessageContext {
    supabase: SupabaseClient;
    waCtx: WhatsAppContext;
    message: MetaJson;
    messageType: MetaJson;
    contactKey: string;
    bsuid: string | null;
    waId: string | null;
    inboundWamid: string | null;
    inboundContextId: string | null;
    storeOnly: OtherNumber | null;
}

export async function handleInboundMessage(params: {
    supabase: SupabaseClient;
    waCtx: WhatsAppContext;
    value: MetaJson;
    storeOnly: OtherNumber | null;
}): Promise<void> {
    const { supabase, waCtx, value, storeOnly } = params;
    const message = value.messages[0];
    const from = message.from; // phone today; may be a BSUID from June 2026
    const messageType = message.type;
    // Inbound message id (wamid). Meta delivers webhooks
    // at-least-once, so this is our idempotency key: a redelivery of
    // the same message must not enqueue (or store) it twice.
    const inboundWamid: string | null = typeof message.id === 'string' ? message.id : null;
    // If the customer replied to one of our messages, Meta includes
    // the quoted message's wamid in message.context.id.
    const inboundContextId: string | null =
        message.context && typeof message.context.id === 'string' ? message.context.id : null;
    if (!inboundWamid) {
        // Well-formed messages always carry a wamid; a missing one
        // means our at-least-once dedup (keyed on wamid) is bypassed
        // for this message. Log it so the blind spot is observable.
        whatsappLogger.warn(`Inbound ${messageType} message from ${from} has no usable message id — wamid dedup bypassed`);
    }

    // BSUID (business-scoped user ID). Present in contacts[].user_id
    // and/or messages[].from_user_id. Used as a secondary identity
    // so returning customers re-thread even if they arrive without
    // a phone number once usernames roll out.
    const bsuid: string | null =
        value.contacts?.[0]?.user_id ?? message.from_user_id ?? null;

    // Phase C — best-known real phone. Whenever Meta hands us a
    // wa_id (or `from` is itself a phone), record it as
    // verified_phone so we can still reach a contact whose PK is a
    // BSUID. null when we only got an identifier.
    const waId: string | null =
        (looksLikePhone(value.contacts?.[0]?.wa_id) && value.contacts[0].wa_id) ||
        (looksLikePhone(from) && from) ||
        null;

    // Canonical CRM key — reuse an existing contact's phone_number
    // when we recognise the BSUID; otherwise use `from`, else the
    // BSUID verbatim.
    const contactKey = await resolveContactKey(supabase, waCtx.orgId, from, bsuid);

    // A phone-hidden payload with neither a phone nor a BSUID is
    // unroutable — ack so Meta doesn't retry-storm, and skip (never
    // let an undefined key reach the handlers' phone_number PK writes).
    if (!contactKey) {
        whatsappLogger.warn(`Inbound ${messageType} message has no usable identity (no phone, no BSUID) — acking without processing`);
        return;
    }

    whatsappLogger.info(`Message details - From: ${from ?? 'none'}, BSUID: ${bsuid ?? 'none'}, Key: ${contactKey}, Type: ${messageType}`);

    const ctx: InboundMessageContext = {
        supabase,
        waCtx,
        message,
        messageType,
        contactKey,
        bsuid,
        waId,
        inboundWamid,
        inboundContextId,
        storeOnly,
    };

    if (messageType === 'contacts') {
        await handleContactsMessage(ctx);
        return;
    }
    if (messageType === 'interactive') {
        await handleInteractiveMessage(ctx);
        return;
    }
    if (messageType === 'image' || messageType === 'document' || messageType === 'audio'
        || messageType === 'video' || messageType === 'sticker') {
        handleMediaMessage(ctx);
        return;
    }
    if (messageType === 'text') {
        await handleTextMessage(ctx);
        return;
    }

    // Any other type the customer sent to another number of the WABA
    // (a template's quick-reply button, a location, an order, a type
    // Sarathi does not show) is kept too, as one readable line, so
    // process mode loses no message that arrived. Events where the
    // customer wrote nothing (a number change, opening the chat, a
    // reaction) are only acknowledged, as on the main number.
    if (storeOnly && !isStoredOtherMessageType(messageType)) {
        whatsappLogger.info(`${messageType} event for another number of the WABA — acknowledged without storing`);
        return;
    }
    if (storeOnly) {
        await storeOtherNumberMessage({
            supabase,
            orgId: waCtx.orgId,
            contactKey,
            bsuid,
            waId,
            inboundWamid,
            content: otherMessageSummary(message),
            preview: otherMessagePreview(message),
            other: storeOnly,
        });
        return;
    }
}
