import { createServiceOrServerClient } from '@/lib/supabase/service';
import { whatsappLogger } from '@/lib/utils/logger';

// Uses the service-role-or-server helper because this is called from the
// WhatsApp webhook path (no user session) — without service_role we'd be
// writing as anon, which no longer has access to whatsapp_chats /
// whatsapp_messages after the public RLS policies were dropped.
export async function logSystemMessage(phoneNumber: string, content: string) {
    try {
        const supabase = await createServiceOrServerClient();

        // Update chat summary
        await supabase
            .from('whatsapp_chats')
            .upsert({
                phone_number: phoneNumber,
                last_message: `System: ${content}`,
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone_number' });

        // Insert message
        await supabase
            .from('whatsapp_messages')
            .insert({
                phone_number: phoneNumber,
                role: 'system',
                content: content
            });

    } catch (error) {
        whatsappLogger.error('Failed to log system message', error);
    }
}
