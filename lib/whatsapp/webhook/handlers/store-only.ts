import type { SupabaseClient } from '@supabase/supabase-js';
import { checkRateLimit } from '@/lib/whatsapp/rate-limiter-db';
import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import {
    firstOtherNumberLimitNote,
    firstOtherNumberNote,
    otherNumberLimitNotice,
    otherNumberMetadata,
    otherNumberNotice,
    type OtherNumber,
} from '@/lib/whatsapp/other-number';

// A message to another number of the WABA (process mode) that is neither
// text nor media: stored for the operators, never acted on.

// A Flow submission, a contact card or any other non-text message sent to
// another number of the WABA (store-only): kept for the operators as a
// readable row, with the chat summary, the unread badge and the push of any
// inbound message. Nothing acts on it: no Brief Acara lead or confirmation
// (flow-response.ts; it would go out from the main number), no verified_phone
// taken from a shared card. Within the contact's own rate limit for messages
// to another number (shared with text; over it: not stored, a note once a
// minute).
export async function storeOtherNumberMessage(params: {
    supabase: SupabaseClient;
    orgId: string;
    contactKey: string;
    bsuid: string | null;
    waId: string | null;
    inboundWamid: string | null;
    content: string;
    /** The chat-list preview and the push body. */
    preview: string;
    other: OtherNumber;
}): Promise<void> {
    const { supabase, orgId, contactKey, bsuid, waId, inboundWamid, content, preview, other } = params;
    if (!(await checkRateLimit(`${orgId}:other:${contactKey}`, supabase))) {
        whatsappLogger.warn(`Rate limit exceeded for ${contactKey} on another number of the WABA — not stored`);
        if (firstOtherNumberLimitNote(`${orgId}:${contactKey}`)) {
            await logSystemMessage(orgId, contactKey, otherNumberLimitNotice(other), { touchChat: false });
        }
        return;
    }
    const nowIso = new Date().toISOString();
    // last_inbound_at: an inbound message for the inbox cues (see
    // lib/whatsapp/other-number.ts; the note explains the 24-hour marker).
    const chatPatch: Record<string, unknown> = {
        org_id: orgId,
        phone_number: contactKey,
        last_message: preview,
        last_message_at: nowIso,
        last_inbound_at: nowIso,
        updated_at: nowIso,
    };
    if (bsuid) chatPatch.bsuid = bsuid;
    if (waId) chatPatch.verified_phone = waId;
    const { data: chatRow, error: chatErr } = await supabase
        .from('whatsapp_chats')
        .upsert(chatPatch, { onConflict: 'org_id,phone_number' })
        .select('contact_name')
        .maybeSingle<{ contact_name: string | null }>();
    if (chatErr) whatsappLogger.error('Error updating chat summary (message to another number)', chatErr);

    // wa_message_id makes a redelivery a 23505 instead of a second row.
    const { error: msgErr } = await supabase.from('whatsapp_messages').insert({
        org_id: orgId,
        phone_number: contactKey,
        role: 'user',
        content,
        wa_message_id: inboundWamid,
        metadata: otherNumberMetadata(other),
    });
    if (msgErr) {
        if (msgErr.code === '23505') {
            whatsappLogger.info(`Duplicate message ${inboundWamid} to another number — already stored, skipping`);
        } else {
            whatsappLogger.error('Error inserting a message to another number', msgErr);
        }
        return;
    }
    whatsappLogger.info(`Message to another number of the WABA stored for ${contactKey} (nothing sent, nothing acted on)`);
    if (firstOtherNumberNote(`${orgId}:${contactKey}`)) {
        await logSystemMessage(orgId, contactKey, otherNumberNotice(other), { touchChat: false });
    }
    const { error: unreadErr } = await supabase.rpc('bump_unread', { p_org: orgId, p_phone: contactKey });
    if (unreadErr) whatsappLogger.error('Failed to bump unread_count (message to another number)', unreadErr);
    if (inboundWamid) {
        try {
            await sendPushToOrg(supabase, orgId, {
                title: chatRow?.contact_name || contactKey,
                body: preview,
                phone: contactKey,
                url: `/dashboard/chats?phone=${encodeURIComponent(contactKey)}`,
            });
        } catch (pushErr) {
            whatsappLogger.error('Web push fan-out failed (message to another number)', pushErr);
        }
    }
}
