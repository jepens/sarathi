import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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

        // Initialize Supabase client with Service Role Key for backend operations
        // This bypasses RLS policies to ensure we can always log messages
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        // Check if this is an event from a WhatsApp Business Account
        if (body.object === 'whatsapp_business_account') {
            // ========== ROUTING CONFIG ==========
            const MUDIK_PHONE_NUMBER_ID = '94146140571942';
            const MUDIK_WEBHOOK_URL = 'https://mudik.buildwithabdul.com/api/webhook/whatsapp';

            // Extract metadata for routing
            const metadata = body.entry?.[0]?.changes?.[0]?.value?.metadata;
            const phoneNumberId = metadata?.phone_number_id;

            whatsappLogger.info(`Webhook from phone_number_id: ${phoneNumberId}`);

            // ========== HANDLE STATUS CALLBACKS ==========
            const statuses = body.entry?.[0]?.changes?.[0]?.value?.statuses;

            if (statuses && statuses.length > 0) {
                // This is a STATUS callback (sent/delivered/read/failed)
                whatsappLogger.info(`Status callback received: ${statuses[0].status} for ${statuses[0].id}`);

                if (phoneNumberId === MUDIK_PHONE_NUMBER_ID) {
                    // Forward to Mudik webhook
                    try {
                        const forwardResponse = await fetch(MUDIK_WEBHOOK_URL, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Forwarded-From': 'nindra'
                            },
                            body: JSON.stringify(body)
                        });

                        if (forwardResponse.ok) {
                            whatsappLogger.info(`Status forwarded to Mudik successfully`);
                        } else {
                            whatsappLogger.error(`Failed to forward to Mudik: ${forwardResponse.status}`);
                        }
                    } catch (err) {
                        whatsappLogger.error('Error forwarding to Mudik:', err);
                    }
                } else {
                    // Status callback for Nindra (not implemented yet)
                    whatsappLogger.info('Status callback for Nindra - not implemented yet');
                }

                // Always return 200 to Meta
                return new NextResponse('EVENT_RECEIVED', { status: 200 });
            }

            // ========== SKIP MESSAGES FROM MUDIK ==========
            if (phoneNumberId === MUDIK_PHONE_NUMBER_ID) {
                // Mudik is outbound only, ignore incoming messages to this number
                whatsappLogger.info('Message from Mudik number - ignoring (Mudik is outbound only)');
                return new NextResponse('EVENT_RECEIVED', { status: 200 });
            }

            // ========== HANDLE NINDRA MESSAGES ==========
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
                const message = body.entry[0].changes[0].value.messages[0];
                const from = message.from; // Sender's phone number
                const messageType = message.type;

                whatsappLogger.info(`Message details - From: ${from}, Type: ${messageType}`);

                if (messageType === 'text') {
                    const messageBody = message.text.body;
                    whatsappLogger.info(`Received message from ${from}: ${messageBody}`);

                    // Rate limiting (database-based)
                    // Pass service role client to bypass RLS
                    const allowed = await checkRateLimit(from, supabase);
                    if (!allowed) {
                        whatsappLogger.warn(`Rate limit exceeded for ${from}`);
                        await sendWhatsAppMessage(from, 'Mohon tunggu sebentar sebelum mengirim pesan lagi.');
                        await logSystemMessage(from, 'Rate limit exceeded. User warned.');
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // Add to database queue
                    // Pass service role client to bypass RLS
                    await enqueueMessage(from, messageBody, supabase);
                    whatsappLogger.info(`Message from ${from} added to queue`);

                    // Trigger queue processing immediately (fire and forget)
                    // Pass the service role client so it can access settings
                    processQueue(supabase).catch(err => whatsappLogger.error('Error processing queue immediately', err));

                    // Store in chat history (Async - don't await to speed up webhook response)
                    (async () => {
                        try {
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
