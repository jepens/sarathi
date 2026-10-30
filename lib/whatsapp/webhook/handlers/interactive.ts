import { handleFlowReply } from '@/lib/whatsapp/flow-response';
import { flowSubmissionSummary } from '@/lib/whatsapp/flow-summary';
import { resolveContactKey } from '@/lib/whatsapp/webhook/contact';
import { MalformedPayloadError, RpcError } from '@/lib/whatsapp/webhook/errors';
import { isRecord, sanitizeForPg } from '@/lib/whatsapp/webhook/payload';
import type { ItemResult } from '@/lib/whatsapp/webhook/outcome';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';
import { handleOtherMessage } from '@/lib/whatsapp/webhook/handlers/other-types';
import { storeOnlySummary } from '@/lib/whatsapp/webhook/handlers/store-only';

// An interactive message: a WhatsApp Flow submission (e.g. Brief Acara), or a
// button or list choice.

export async function handleInteractiveMessage(ctx: MessageContext): Promise<ItemResult> {
    const { supabase, waCtx, message, identity, storeOnly } = ctx;
    const interactive = message.interactive;
    if (!isRecord(interactive)) throw new MalformedPayloadError('pesan interaktif tanpa isi');

    // A button or list choice (or a subtype Sarathi does not know): one
    // readable line, without AI (D23-4).
    if (interactive.type !== 'nfm_reply') return handleOtherMessage(ctx);
    if (!isRecord(interactive.nfm_reply)) throw new MalformedPayloadError('kiriman form tanpa isi');

    // ===== WhatsApp Flow submissions (interactive → nfm_reply) =====
    // A submission to another number of the WABA (store-only) is only
    // stored, as a summary of its answers.
    if (storeOnly) {
        return storeOnlySummary(ctx, flowSubmissionSummary(interactive.nfm_reply.response_json), '📋 Mengisi form WhatsApp');
    }
    // A customer submitted a Flow (e.g. "Brief Acara", from the template
    // button or an in-window flow message). Full handling (history + CRM
    // upsert + Nindra context via system message + deterministic
    // confirmation) lives in lib/whatsapp/flow-response.ts. Its own insert is
    // still its redelivery gate; the batch's pre-dedup keeps a resend of a
    // stored submission from reaching it at all.
    const contactKey = await resolveContactKey(supabase, waCtx.orgId, identity.from, identity.bsuid);
    if (!contactKey) return 'skipped'; // unreachable: the prelude requires a phone or a BSUID
    const result = await handleFlowReply({
        supabase,
        orgId: waCtx.orgId,
        phoneNumberId: waCtx.phoneNumberId,
        accessToken: waCtx.accessToken,
        contactKey,
        bsuid: identity.bsuid,
        waId: identity.waId,
        inboundWamid: ctx.key,
        nfmReply: sanitizeForPg(interactive.nfm_reply),
    });
    // The insert failed (not as a duplicate): nothing else was done. Retryable,
    // so Meta's resend does the whole submission exactly once.
    if (result.status === 'gate_failed') throw new RpcError('flow submission insert', result.error, result.httpStatus);
    return result.status === 'duplicate' ? 'duplicate' : 'legacy';
}
