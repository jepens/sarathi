import { NextResponse } from 'next/server';
import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';
import { checkRateLimit } from '@/lib/whatsapp/rate-limiter-db';
import { enqueueMessage, processQueue } from '@/lib/whatsapp/queue-db';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';

import { checkVerifyToken } from '@/lib/settings/app-settings';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token) {
        const isValid = await checkVerifyToken(token);

        if (isValid) {
            whatsappLogger.info('Webhook verified successfully!');
            return new NextResponse(challenge, { status: 200 });
        }
    }

    whatsappLogger.warn('Webhook verification failed');
    return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(request: Request) {
    try {
        // Get raw body for signature verification
        const rawBody = await request.text();
        const signature = request.headers.get('x-hub-signature-256');

        // Verify signature (optional in development)
        if (process.env.NODE_ENV === 'production') {
            if (!(await verifyWhatsAppSignature(rawBody, signature))) {
                whatsappLogger.warn('Invalid webhook signature');
                return new NextResponse('Forbidden', { status: 403 });
            }
        }

        const body = JSON.parse(rawBody);

        // Enhanced logging for debugging
        whatsappLogger.info('Webhook received:', JSON.stringify(body, null, 2));

        // Check if this is an event from a WhatsApp Business Account
        if (body.object === 'whatsapp_business_account') {
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
                const message = body.entry[0].changes[0].value.messages[0];
                const from = message.from; // Sender's phone number
                const messageType = message.type;

                whatsappLogger.info(`Message details - From: ${from}, Type: ${messageType}`);

                if (messageType === 'text') {
                    const messageBody = message.text.body;
                    whatsappLogger.info(`Received message from ${from}: ${messageBody}`);

                    // Rate limiting (database-based)
                    const allowed = await checkRateLimit(from);
                    if (!allowed) {
                        whatsappLogger.warn(`Rate limit exceeded for ${from}`);
                        await sendWhatsAppMessage(from, 'Mohon tunggu sebentar sebelum mengirim pesan lagi.');
                        await logSystemMessage(from, 'Rate limit exceeded. User warned.');
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // Add to database queue
                    await enqueueMessage(from, messageBody);
                    whatsappLogger.info(`Message from ${from} added to queue`);

                    // Trigger queue processing immediately (fire and forget)
                    processQueue().catch(err => whatsappLogger.error('Error processing queue immediately', err));

                    // Store in chat history (Async - don't await to speed up webhook response)
                    // Use direct Supabase client (not server client) because webhook has no cookies
                    (async () => {
                        try {
                            const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
                            const supabase = createSupabaseClient(
                                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
                            );

                            // Update chat summary
                            const { error: chatError } = await supabase
                                .from('whatsapp_chats')
                                .upsert({
                                    phone_number: from,
                                    last_message: messageBody,
                                    last_message_at: new Date().toISOString(),
                                    updated_at: new Date().toISOString()
                                }, { onConflict: 'phone_number' });

                            if (chatError) {
                                whatsappLogger.error('Error updating chat summary', chatError);
                            } else {
                                whatsappLogger.info(`Chat summary updated for ${from}`);
                            }

                            // Insert message
                            const { error: msgError } = await supabase
                                .from('whatsapp_messages')
                                .insert({
                                    phone_number: from,
                                    role: 'user',
                                    content: messageBody
                                });

                            if (msgError) {
                                whatsappLogger.error('Error inserting message', msgError);
                            } else {
                                whatsappLogger.info(`User message inserted for ${from}`);
                            }

                        } catch (err) {
                            whatsappLogger.error('Error storing chat history', err);
                        }
                    })();

                    // Return 200 immediately to Meta
                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }
            }
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        } else {
            whatsappLogger.warn('Received non-WhatsApp event');
            return new NextResponse('Not a WhatsApp event', { status: 404 });
        }

    } catch (error) {
        whatsappLogger.error('Error processing webhook', error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
