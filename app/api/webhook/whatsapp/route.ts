import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';
import { checkRateLimit } from '@/lib/whatsapp/rate-limiter-db';
import { enqueueMessage, processQueue } from '@/lib/whatsapp/queue-db';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';

import { checkVerifyToken } from '@/lib/settings/app-settings';

// Resolve the canonical contact key for the whatsapp_chats PK.
//
// Meta is migrating to business-scoped user IDs (BSUIDs). Today `from` is a
// phone number, but from June 2026 it may be a BSUID instead. We key the CRM
// on phone_number (hybrid strategy), so when a returning customer arrives
// with a BSUID we've seen before, re-thread them into their existing
// conversation by reusing the phone_number we already have. Otherwise fall
// back to `from` (a phone today, possibly a BSUID later — either works as a
// key, and Meta accepts a BSUID as the `to` for replies from June 2026).
async function resolveContactKey(
    supabase: SupabaseClient,
    from: string,
    bsuid: string | null
): Promise<string> {
    if (bsuid) {
        const { data } = await supabase
            .from('whatsapp_chats')
            .select('phone_number')
            .eq('bsuid', bsuid)
            .maybeSingle<{ phone_number: string }>();
        if (data?.phone_number) return data.phone_number;
    }
    return from;
}

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
        // Get raw body for signature verification.
        // MUST be the raw bytes — re-stringifying parsed JSON breaks the HMAC.
        const rawBody = await request.text();
        const signature = request.headers.get('x-hub-signature-256');

        // Always verify signature unless an operator explicitly opts out.
        // Use the env flag only for local dev or replay testing — never in prod.
        const skipSignatureVerification =
            process.env.WHATSAPP_WEBHOOK_SKIP_SIGNATURE === 'true';

        if (skipSignatureVerification) {
            whatsappLogger.warn(
                '⚠️  Webhook signature verification SKIPPED via WHATSAPP_WEBHOOK_SKIP_SIGNATURE=true. ' +
                    'This is INSECURE and must NEVER be set in production.'
            );
        } else {
            const valid = await verifyWhatsAppSignature(rawBody, signature);
            if (!valid) {
                whatsappLogger.warn('Rejected webhook with invalid/missing signature');
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
            const MUDIK_PHONE_NUMBER_ID = '941461405719425';
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
                    // Status callback for Nindra — match by wamid and update
                    // the row's status. Failed deliveries (e.g. code 131047
                    // "Re-engagement message" when past the 24h customer
                    // service window) used to be silent because we never
                    // wrote the failure back to the DB row.
                    for (const statusEntry of statuses) {
                        const wamid: string | undefined = statusEntry?.id;
                        const newStatus: string | undefined = statusEntry?.status;
                        if (!wamid || !newStatus) continue;

                        // Only persist the canonical Meta states we track. Unknown
                        // values are ignored to avoid violating the CHECK constraint.
                        const trackedStatuses = new Set(['sent', 'delivered', 'read', 'failed']);
                        if (!trackedStatuses.has(newStatus)) continue;

                        const patch: Record<string, unknown> = {
                            status: newStatus,
                            status_updated_at: new Date().toISOString(),
                        };

                        if (newStatus === 'failed' && Array.isArray(statusEntry.errors) && statusEntry.errors.length > 0) {
                            const err = statusEntry.errors[0];
                            if (typeof err?.code === 'number') patch.error_code = err.code;
                            if (typeof err?.title === 'string') patch.error_title = err.title;
                            const detail = err?.error_data?.details;
                            if (typeof detail === 'string') patch.error_detail = detail;
                            else if (typeof err?.message === 'string') patch.error_detail = err.message;
                        }

                        // Enrichment: status callbacks carry recipient_id
                        // (phone) + recipient_user_id (BSUID). Backfill the
                        // contact's bsuid if we have both and it isn't set yet
                        // — best-effort, never blocks the status update.
                        const recipientPhone: string | undefined = statusEntry?.recipient_id;
                        const recipientBsuid: string | undefined = statusEntry?.recipient_user_id;
                        if (recipientPhone && recipientBsuid) {
                            const { error: bsuidErr } = await supabase
                                .from('whatsapp_chats')
                                .update({ bsuid: recipientBsuid })
                                .eq('phone_number', recipientPhone)
                                .is('bsuid', null);
                            if (bsuidErr) {
                                whatsappLogger.error(`Failed to backfill bsuid for ${recipientPhone}`, bsuidErr);
                            }
                        }

                        const { error: updateErr } = await supabase
                            .from('whatsapp_messages')
                            .update(patch)
                            .eq('wa_message_id', wamid);

                        if (updateErr) {
                            whatsappLogger.error(`Failed to update status for ${wamid}`, updateErr);
                        } else {
                            whatsappLogger.info(`Updated status=${newStatus} for ${wamid}`);
                        }
                    }
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
                const value = body.entry[0].changes[0].value;
                const message = value.messages[0];
                const from = message.from; // phone today; may be a BSUID from June 2026
                const messageType = message.type;

                // BSUID (business-scoped user ID). Present in contacts[].user_id
                // and/or messages[].from_user_id. Used as a secondary identity
                // so returning customers re-thread even if they arrive without
                // a phone number once usernames roll out.
                const bsuid: string | null =
                    value.contacts?.[0]?.user_id ?? message.from_user_id ?? null;

                // Canonical CRM key — reuse an existing contact's phone_number
                // when we recognise the BSUID; otherwise use `from`.
                const contactKey = await resolveContactKey(supabase, from, bsuid);

                whatsappLogger.info(`Message details - From: ${from}, BSUID: ${bsuid ?? 'none'}, Key: ${contactKey}, Type: ${messageType}`);

                if (messageType === 'text') {
                    const messageBody = message.text.body;
                    whatsappLogger.info(`Received message from ${contactKey}: ${messageBody}`);

                    // Rate limiting (database-based)
                    // Pass service role client to bypass RLS
                    const allowed = await checkRateLimit(contactKey, supabase);
                    if (!allowed) {
                        whatsappLogger.warn(`Rate limit exceeded for ${contactKey}`);
                        await sendWhatsAppMessage(from, 'Mohon tunggu sebentar sebelum mengirim pesan lagi.');
                        await logSystemMessage(contactKey, 'Rate limit exceeded. User warned.');
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // Add to database queue
                    // Pass service role client to bypass RLS
                    await enqueueMessage(contactKey, messageBody, supabase);
                    whatsappLogger.info(`Message from ${contactKey} added to queue`);

                    // Trigger queue processing immediately (fire and forget)
                    // Pass the service role client so it can access settings
                    processQueue(supabase).catch(err => whatsappLogger.error('Error processing queue immediately', err));

                    // Store in chat history (Async - don't await to speed up webhook response)
                    (async () => {
                        try {
                            // Update chat summary. last_inbound_at is set here
                            // (and ONLY here, on the inbound path) because the
                            // 24-hour customer service window resets every time
                            // the customer messages us. Outbound sends must not
                            // touch it. bsuid is recorded so we can re-thread
                            // this contact later even if they arrive phone-less.
                            const inboundNow = new Date().toISOString();
                            const chatPatch: Record<string, unknown> = {
                                phone_number: contactKey,
                                last_message: messageBody,
                                last_message_at: inboundNow,
                                last_inbound_at: inboundNow,
                                updated_at: inboundNow,
                            };
                            if (bsuid) chatPatch.bsuid = bsuid;
                            const { error: chatError } = await supabase
                                .from('whatsapp_chats')
                                .upsert(chatPatch, { onConflict: 'phone_number' });

                            if (chatError) {
                                whatsappLogger.error('Error updating chat summary', chatError);
                            } else {
                                whatsappLogger.info(`Chat summary updated for ${contactKey}`);
                            }

                            // Insert message
                            const { error: msgError } = await supabase
                                .from('whatsapp_messages')
                                .insert({
                                    phone_number: contactKey,
                                    role: 'user',
                                    content: messageBody
                                });

                            if (msgError) {
                                whatsappLogger.error('Error inserting message', msgError);
                            } else {
                                whatsappLogger.info(`User message inserted for ${contactKey}`);
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
