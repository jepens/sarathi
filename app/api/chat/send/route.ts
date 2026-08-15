import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendWhatsAppMessage, describeWhatsAppError, type WhatsAppApiError } from '@/lib/whatsapp/client';
import { whatsappLogger } from '@/lib/utils/logger';
import { getCurrentOrgId } from '@/lib/settings/org-context';

export async function POST(request: Request) {
    let phone_number: string | undefined;
    let message: string | undefined;

    try {
        const body = await request.json();
        phone_number = body.phone_number;
        message = body.message;
        // Optional: reply to an earlier message (its wamid). Meta shows the reply
        // quoted on the customer's phone; we also store it so the dashboard can
        // render the quote.
        const contextMessageId: string | null =
            typeof body.context_message_id === 'string' && body.context_message_id
                ? body.context_message_id
                : null;

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

        // Resolve the sender's org explicitly. RLS would scope the write anyway,
        // but once phone_number is no longer globally unique we must set org_id
        // (it's part of the composite key) and target onConflict on it — relying
        // on the column DEFAULT would mis-stamp a non-Sailendra tenant's reply.
        const orgId = await getCurrentOrgId(supabase);
        if (!orgId) {
            return NextResponse.json({ error: 'No organization for current user' }, { status: 403 });
        }

        // Send via Meta first — if Meta rejects (e.g. past 24h window), we
        // don't want a phantom assistant message stored locally that the
        // customer never actually received. Capture wamid so the webhook
        // status callback can later flip this row to delivered/read/failed.
        const sendResult = await sendWhatsAppMessage(phone_number, message, undefined, contextMessageId);

        const { error: chatError } = await supabase
            .from('whatsapp_chats')
            .upsert({
                org_id: orgId,
                phone_number,
                last_message: message,
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'org_id,phone_number' });

        if (chatError) throw chatError;

        const { error: msgError } = await supabase
            .from('whatsapp_messages')
            .insert({
                org_id: orgId,
                phone_number,
                role: 'assistant',
                content: message,
                wa_message_id: sendResult.waMessageId,
                reply_to_wamid: contextMessageId,
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
