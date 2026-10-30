import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppContext } from '@/lib/whatsapp/credentials';
import { whatsappLogger } from '@/lib/utils/logger';
import type { MetaJson } from '@/lib/whatsapp/webhook/types';

// Delivery status callbacks (sent, delivered, read, failed), written back to the rows of our sent messages.

export async function handleStatuses(supabase: SupabaseClient, waCtx: WhatsAppContext, statuses: MetaJson): Promise<void> {
    // This is a STATUS callback (sent/delivered/read/failed)
    whatsappLogger.info(`Status callback received: ${statuses[0].status} for ${statuses[0].id}`);

    // Match each status by wamid and update the row's status. Failed
    // deliveries (e.g. code 131047 "Re-engagement message" past the
    // 24h customer service window) used to be silent because we never
    // wrote the failure back to the DB row.
    for (const statusEntry of statuses) {
        const wamid: string | undefined = statusEntry?.id;
        const newStatus: string | undefined = statusEntry?.status;
        if (!wamid || !newStatus) continue;

        // Only persist the canonical Meta states we track. Unknown
        // values are ignored to avoid violating the CHECK constraint.
        const trackedStatuses = new Set(['sent', 'delivered', 'read', 'failed']);
        if (!trackedStatuses.has(newStatus)) continue;

        const patch: Record<string, unknown> = {
            status: newStatus,
            status_updated_at: new Date().toISOString(),
        };

        if (newStatus === 'failed' && Array.isArray(statusEntry.errors) && statusEntry.errors.length > 0) {
            const err = statusEntry.errors[0];
            if (typeof err?.code === 'number') patch.error_code = err.code;
            if (typeof err?.title === 'string') patch.error_title = err.title;
            const detail = err?.error_data?.details;
            if (typeof detail === 'string') patch.error_detail = detail;
            else if (typeof err?.message === 'string') patch.error_detail = err.message;
        }

        // Enrichment: status callbacks carry recipient_id (phone) +
        // recipient_user_id (BSUID). Backfill the contact's bsuid if
        // we have both and it isn't set yet — best-effort, never
        // blocks the status update.
        const recipientPhone: string | undefined = statusEntry?.recipient_id;
        const recipientBsuid: string | undefined = statusEntry?.recipient_user_id;
        if (recipientPhone && recipientBsuid) {
            const { error: bsuidErr } = await supabase
                .from('whatsapp_chats')
                .update({ bsuid: recipientBsuid })
                .eq('org_id', waCtx.orgId)
                .eq('phone_number', recipientPhone)
                .is('bsuid', null);
            if (bsuidErr) {
                whatsappLogger.error(`Failed to backfill bsuid for ${recipientPhone}`, bsuidErr);
            }
        }

        // Scoped to the org: a wamid is only unique per org.
        const { error: updateErr } = await supabase
            .from('whatsapp_messages')
            .update(patch)
            .eq('org_id', waCtx.orgId)
            .eq('wa_message_id', wamid);

        if (updateErr) {
            whatsappLogger.error(`Failed to update status for ${wamid}`, updateErr);
        } else {
            whatsappLogger.info(`Updated status=${newStatus} for ${wamid}`);
        }
    }
}
