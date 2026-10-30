import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { contactCardSummary } from '@/lib/whatsapp/flow-summary';
import { looksLikePhone } from '@/lib/whatsapp/webhook/contact';
import type { InboundMessageContext } from '@/lib/whatsapp/webhook/handlers/messages';
import { storeOtherNumberMessage } from '@/lib/whatsapp/webhook/handlers/store-only';

// A contact card from the customer: the shared phone kept as verified_phone, or
// only stored for another number.

export async function handleContactsMessage(ctx: InboundMessageContext): Promise<void> {
    const { supabase, waCtx, message, messageType, contactKey, bsuid, waId, inboundWamid, storeOnly } = ctx;

    // ===== Phase C: explicit contact share (REQUEST_CONTACT_INFO) =====
    // When a customer taps the REQUEST_CONTACT_INFO button (or sends
    // a contact card), Meta delivers a `contacts`-type message with
    // the shared phone. Capture it into verified_phone and stop —
    // no AI reply needed for a contact share. A card sent to another
    // number of the WABA (store-only) is only stored for the
    // operators: it was not an answer to this number's request.
    if (messageType === 'contacts' && storeOnly) {
        await storeOtherNumberMessage({
            supabase,
            orgId: waCtx.orgId,
            contactKey,
            bsuid,
            waId,
            inboundWamid,
            content: contactCardSummary(message.contacts),
            preview: '👤 Kartu kontak',
            other: storeOnly,
        });
        return;
    }
    if (messageType === 'contacts') {
        const shared = Array.isArray(message.contacts) ? message.contacts[0] : null;
        const phones = shared && Array.isArray(shared.phones) ? shared.phones : [];
        let sharedPhone: string | null = null;
        for (const p of phones) {
            if (looksLikePhone(p?.wa_id)) { sharedPhone = p.wa_id; break; }
            const digits = typeof p?.phone === 'string' ? p.phone.replace(/\D+/g, '') : '';
            if (looksLikePhone(digits)) { sharedPhone = digits; break; }
        }
        const recovered = sharedPhone ?? waId;
        if (recovered) {
            const nowIso = new Date().toISOString();
            // Upsert (not update): a contact-share could theoretically
            // be the first event we see for this key, and we don't
            // want to silently drop the recovered phone.
            const patch: Record<string, unknown> = {
                org_id: waCtx.orgId,
                phone_number: contactKey,
                verified_phone: recovered,
                updated_at: nowIso,
            };
            if (bsuid) patch.bsuid = bsuid;
            await supabase
                .from('whatsapp_chats')
                .upsert(patch, { onConflict: 'org_id,phone_number' });
            // Not a reply to the customer: an earlier unanswered
            // message keeps the chat "Belum dibalas".
            await logSystemMessage(waCtx.orgId, contactKey, `Customer shared contact info — phone tersimpan: ${recovered}`, { touchChat: false });
            whatsappLogger.info(`Contact share captured for ${contactKey}: ${recovered}`);
        } else {
            whatsappLogger.warn(`Contact share from ${contactKey} had no usable phone`);
        }
        return;
    }
}
