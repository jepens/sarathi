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
// last_inbound_at as answered. The chat row is still created when missing
// (the note's foreign key), e.g. when the queue answers a new contact before
// the webhook's background store has written the chat.
//
// waMessageId keys the note to the inbound message it is about (the webhook's
// contact-card note, D23-3): the unique index on (org_id, wa_message_id,
// role) then turns a second note for the same message, from a redelivery,
// into a 23505, reported as 'duplicate'.

export interface SystemMessageResult {
    status: 'stored' | 'duplicate' | 'failed';
    /** The database or client error of a 'failed' note. */
    error?: unknown;
}

export async function logSystemMessage(
    orgId: string,
    phoneNumber: string,
    content: string,
    opts: { touchChat?: boolean; waMessageId?: string } = {},
): Promise<SystemMessageResult> {
    try {
        const supabase = await createServiceOrServerClient();

        // Update chat summary. org_id is required: this runs service-role (RLS
        // bypassed) from the webhook/queue, so without it the row would fall to
        // the column DEFAULT (Sailendra) and mis-attribute a tenant's system
        // message. onConflict targets the composite (org_id, phone_number) key.
        const { error: chatError } = opts.touchChat !== false
            ? await supabase
                .from('whatsapp_chats')
                .upsert({
                    org_id: orgId,
                    phone_number: phoneNumber,
                    last_message: `System: ${content}`,
                    last_message_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'org_id,phone_number' })
            : await supabase
                .from('whatsapp_chats')
                .upsert({ org_id: orgId, phone_number: phoneNumber }, { onConflict: 'org_id,phone_number', ignoreDuplicates: true });
        if (chatError) whatsappLogger.error('System message: the chat row could not be written', chatError);

        // Insert message
        const { error: noteError } = await supabase
            .from('whatsapp_messages')
            .insert({
                org_id: orgId,
                phone_number: phoneNumber,
                role: 'system',
                content: content,
                ...(opts.waMessageId ? { wa_message_id: opts.waMessageId } : {}),
            });
        if (noteError) {
            if (opts.waMessageId && (noteError as { code?: unknown }).code === '23505') {
                return { status: 'duplicate' };
            }
            whatsappLogger.error('System message could not be stored', noteError);
            return { status: 'failed', error: noteError };
        }
        return { status: 'stored' };

    } catch (error) {
        whatsappLogger.error('Failed to log system message', error);
        return { status: 'failed', error };
    }
}
