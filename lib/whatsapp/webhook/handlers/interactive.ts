import { whatsappLogger } from '@/lib/utils/logger';
import { handleFlowReply } from '@/lib/whatsapp/flow-response';
import { flowSubmissionSummary, otherMessageSummary } from '@/lib/whatsapp/flow-summary';
import type { InboundMessageContext } from '@/lib/whatsapp/webhook/handlers/messages';
import { storeOtherNumberMessage } from '@/lib/whatsapp/webhook/handlers/store-only';

// An interactive message: a WhatsApp Flow submission (e.g. Brief Acara), or a
// button or list choice.

export async function handleInteractiveMessage(ctx: InboundMessageContext): Promise<void> {
    const { supabase, waCtx, message, messageType, contactKey, bsuid, waId, inboundWamid, storeOnly } = ctx;

    // ===== WhatsApp Flow submissions (interactive → nfm_reply) =====
    // A customer submitted a Flow (e.g. "Brief Acara" — from the
    // template button or an in-window flow message). Without this
    // branch the submission would fall through unhandled: no history
    // row, no lead, no confirmation, and no 24h-window reset. Full
    // handling (history + CRM upsert + Nindra context via system
    // message + deterministic confirmation) lives in
    // lib/whatsapp/flow-response.ts. A submission to another number of
    // the WABA (store-only) is only stored, as a summary of its answers.
    if (messageType === 'interactive') {
        const interactive = message.interactive;
        if (interactive?.type === 'nfm_reply' && interactive.nfm_reply && storeOnly) {
            await storeOtherNumberMessage({
                supabase,
                orgId: waCtx.orgId,
                contactKey,
                bsuid,
                waId,
                inboundWamid,
                content: flowSubmissionSummary(interactive.nfm_reply.response_json),
                preview: '📋 Mengisi form WhatsApp',
                other: storeOnly,
            });
        } else if (interactive?.type === 'nfm_reply' && interactive.nfm_reply) {
            await handleFlowReply({
                supabase,
                orgId: waCtx.orgId,
                phoneNumberId: waCtx.phoneNumberId,
                accessToken: waCtx.accessToken,
                contactKey,
                bsuid,
                waId,
                inboundWamid,
                nfmReply: interactive.nfm_reply,
            });
        } else if (storeOnly) {
            // A button or list choice sent to another number: kept
            // as one readable line (nothing acts on it).
            const summary = otherMessageSummary(message);
            await storeOtherNumberMessage({
                supabase,
                orgId: waCtx.orgId,
                contactKey,
                bsuid,
                waId,
                inboundWamid,
                content: summary,
                preview: summary,
                other: storeOnly,
            });
        } else {
            // Other interactive subtypes (button_reply, list_reply)
            // are not used by this app yet — log so they're visible.
            whatsappLogger.info(`Unhandled interactive subtype from ${contactKey}: ${interactive?.type ?? 'unknown'}`);
        }
        return;
    }
}
