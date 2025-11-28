import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { whatsappLogger } from '@/lib/utils/logger';

export async function POST(request: Request) {
    try {
        const { phone_number, message } = await request.json();

        if (!phone_number || !message) {
            return new NextResponse('Missing phone_number or message', { status: 400 });
        }

        // Store in database
        const supabase = await createClient();

        // Check authentication (Optional for MVP - uncomment to enforce strict auth)
        // const { data: { user }, error: authError } = await supabase.auth.getUser();
        // if (authError || !user) {
        //     return new NextResponse('Unauthorized', { status: 401 });
        // }

        // Send WhatsApp message
        await sendWhatsAppMessage(phone_number, message);

        // Update chat summary
        const { error: chatError } = await supabase
            .from('whatsapp_chats')
            .upsert({
                phone_number,
                last_message: message,
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone_number' });

        if (chatError) throw chatError;

        // Insert message
        const { error: msgError } = await supabase
            .from('whatsapp_messages')
            .insert({
                phone_number,
                role: 'assistant',
                content: message
            });

        if (msgError) throw msgError;

        whatsappLogger.info(`Admin sent message to ${phone_number}`);
        return NextResponse.json({ success: true });

    } catch (error) {
        whatsappLogger.error('Error sending admin message', error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
