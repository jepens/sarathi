import { createServiceOrServerClient } from '@/lib/supabase/service';
import { whatsappLogger } from '@/lib/utils/logger';

// Uses the service-role-or-server helper because this is called from the
// WhatsApp webhook path (no user session) — without service_role we'd be
// writing as anon, which no longer has access to whatsapp_chats /
// whatsapp_messages after the public RLS policies were dropped.
//
// touchChat: false adds the note to the thread only, without making it the
// chat's latest activity. Use it for a note about a customer message that
// still needs a human reply: the chat list's "Belum dibalas" dot and the
// in-app notifier treat a chat whose last_message_at is newer than its
// last_inbound_at as answered. The chat row must exist (the message's foreign
// key), which it does after any inbound message.
export async function logSystemMessage(
    orgId: string,
    phoneNumber: string,
    content: string,
    opts: { touchChat?: boolean } = {},
) {
    try {
        const supabase = await createServiceOrServerClient();

        // Update chat summary. org_id is required: this runs service-role (RLS
        // bypassed) from the webhook/queue, so without it the row would fall to
        // the column DEFAULT (Sailendra) and mis-attribute a tenant's system
        // message. onConflict targets the composite (org_id, phone_number) key.
        if (opts.touchChat !== false) {
            await supabase
                .from('whatsapp_chats')
                .upsert({
                    org_id: orgId,
                    phone_number: phoneNumber,
                    last_message: `System: ${content}`,
                    last_message_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'org_id,phone_number' });
        }

        // Insert message
        await supabase
            .from('whatsapp_messages')
            .insert({
                org_id: orgId,
                phone_number: phoneNumber,
                role: 'system',
                content: content
            });

    } catch (error) {
        whatsappLogger.error('Failed to log system message', error);
    }
}
