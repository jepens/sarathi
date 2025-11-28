import { createClient } from '@/lib/supabase/server';
import { whatsappLogger } from '@/lib/utils/logger';

export async function logSystemMessage(phoneNumber: string, content: string) {
    try {
        const supabase = await createClient();

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
