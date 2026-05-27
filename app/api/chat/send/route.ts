import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendWhatsAppMessage, describeWhatsAppError, type WhatsAppApiError } from '@/lib/whatsapp/client';
import { whatsappLogger } from '@/lib/utils/logger';

export async function POST(request: Request) {
    let phone_number: string | undefined;
    let message: string | undefined;

    try {
        const body = await request.json();
        phone_number = body.phone_number;
        message = body.message;

        if (!phone_number || !message) {
            return NextResponse.json(
                { error: 'Missing phone_number or message' },
                { status: 400 }
            );
        }

        const supabase = await createClient();

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Send via Meta first — if Meta rejects (e.g. past 24h window), we
        // don't want a phantom assistant message stored locally that the
        // customer never actually received. Capture wamid so the webhook
        // status callback can later flip this row to delivered/read/failed.
        const sendResult = await sendWhatsAppMessage(phone_number, message);

        const { error: chatError } = await supabase
            .from('whatsapp_chats')
            .upsert({
                phone_number,
                last_message: message,
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone_number' });

        if (chatError) throw chatError;

        const { error: msgError } = await supabase
            .from('whatsapp_messages')
            .insert({
                phone_number,
                role: 'assistant',
                content: message,
                wa_message_id: sendResult.waMessageId,
                status: 'sent',
                status_updated_at: new Date().toISOString(),
            });

        if (msgError) throw msgError;

        whatsappLogger.info(`Admin sent message to ${phone_number}`);
        return NextResponse.json({ success: true });

    } catch (error) {
        whatsappLogger.error('Error sending admin message', error);

        // Meta API errors carry a `code` property — surface it to the UI so
        // the admin can see exactly why the send failed (24h window, expired
        // token, rate limit, etc.). Generic 500 hides the actual cause.
        const apiErr = error as WhatsAppApiError;
        if (typeof apiErr.code === 'number') {
            return NextResponse.json(
                {
                    error: describeWhatsAppError(apiErr),
                    code: apiErr.code,
                    subcode: apiErr.subcode,
                    fbtrace_id: apiErr.fbtraceId,
                },
                { status: 502 }   // 502 Bad Gateway — upstream (Meta) rejected
            );
        }

        const msg = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
