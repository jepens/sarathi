import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';
import { checkRateLimit } from '@/lib/whatsapp/rate-limiter-db';
import { enqueueMessage, processQueue, getDebounceSeconds } from '@/lib/whatsapp/queue-db';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { resolveWhatsAppContext } from '@/lib/whatsapp/credentials';
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
    orgId: string,
    from: string,
    bsuid: string | null
): Promise<string> {
    if (bsuid) {
        // Scope the bsuid lookup to this org: the webhook uses a service-role
        // client (RLS bypassed), so without org_id a bsuid that two tenants
        // happen to share would re-thread the customer into the wrong org.
        const { data } = await supabase
            .from('whatsapp_chats')
            .select('phone_number')
            .eq('org_id', orgId)
            .eq('bsuid', bsuid)
            .maybeSingle<{ phone_number: string }>();
        if (data?.phone_number) return data.phone_number;
    }
    return from;
}

// A real phone number is all digits, 8-15 long (E.164 without the +). A BSUID
// (e.g. "ID.26557548613939612") or username fails this, so we use it to tell
// "Meta gave us a real phone" apart from "Meta gave us an identifier".
function looksLikePhone(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9]{8,15}$/.test(value);
}

// Phase B — user_id_update. Meta fires this when a customer changes their
// phone number: the BSUID regenerates and we get the old + new IDs. We move
// our stored bsuid from old → new so the next inbound message still resolves
// to the same contact (phone_number PK stays put — no re-key).
//
// The exact payload shape isn't fully documented during the 2026 rollout, so
// we parse defensively across the likely field names and log the raw value
// when we can't find a pair.
async function handleUserIdUpdate(
    supabase: SupabaseClient,
    orgId: string,
    value: Record<string, unknown>
): Promise<void> {
    // Candidate containers: value.user_id_updates[] (most likely) or a single
    // object on the value itself.
    const updates: Array<Record<string, unknown>> = [];
    if (Array.isArray(value.user_id_updates)) {
        for (const u of value.user_id_updates) {
            if (u && typeof u === 'object') updates.push(u as Record<string, unknown>);
        }
    } else {
        updates.push(value);
    }

    const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
        for (const k of keys) {
            const v = o[k];
            if (typeof v === 'string' && v.length > 0) return v;
        }
        return null;
    };

    for (const u of updates) {
        const oldId = pick(u, ['old_user_id', 'previous_user_id', 'old_wa_id', 'previous_wa_id']);
        const newId = pick(u, ['new_user_id', 'current_user_id', 'new_wa_id', 'current_wa_id']);
        if (!oldId || !newId) {
            whatsappLogger.warn(`user_id_update: could not parse old/new id from ${JSON.stringify(u)}`);
            continue;
        }

        const { data, error } = await supabase
            .from('whatsapp_chats')
            .update({ bsuid: newId, updated_at: new Date().toISOString() })
            .eq('org_id', orgId)
            .eq('bsuid', oldId)
            .select('phone_number');

        if (error) {
            whatsappLogger.error(`user_id_update: failed to move bsuid ${oldId}→${newId}`, error);
        } else {
            whatsappLogger.info(`user_id_update: moved bsuid ${oldId}→${newId} for ${data?.length ?? 0} contact(s)`);
        }
    }
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

        // Parse BEFORE verifying: multi-tenant signatures use the sending org's
        // app_secret, which we only know after reading phone_number_id from the
        // body. Parsing is side-effect-free; nothing acts on the payload until
        // the signature is verified below (right after we resolve the org).
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
            const change = body.entry?.[0]?.changes?.[0];
            const metadata = change?.value?.metadata;
            const phoneNumberId = metadata?.phone_number_id;

            whatsappLogger.info(`Webhook from phone_number_id: ${phoneNumberId}`);

            // Resolve the org + credentials that own this number (env fallback =
            // the original single-tenant number, e.g. Sailendra).
            const waCtx = await resolveWhatsAppContext(supabase, phoneNumberId);

            // Verify the signature with THIS org's app_secret now that we know
            // which org the payload claims to come from. Nothing above acted on
            // the body, so this is still a pre-action gate.
            if (skipSignatureVerification) {
                whatsappLogger.warn(
                    '⚠️  Webhook signature verification SKIPPED via WHATSAPP_WEBHOOK_SKIP_SIGNATURE=true. ' +
                        'This is INSECURE and must NEVER be set in production.'
                );
            } else {
                const valid = await verifyWhatsAppSignature(rawBody, signature, waCtx.appSecret);
                if (!valid) {
                    whatsappLogger.warn('Rejected webhook with invalid/missing signature');
                    return new NextResponse('Forbidden', { status: 403 });
                }
            }

            // ========== HANDLE user_id_update (Phase B) ==========
            // Fires when a customer changes their phone number → BSUID
            // regenerates. We move our stored bsuid old→new so the contact
            // stays linked. Detect by the change field name or a
            // user_id_update(s) key on the value.
            const changeValue = (change?.value ?? {}) as Record<string, unknown>;
            const isUserIdUpdate =
                change?.field === 'user_id_update' ||
                'user_id_updates' in changeValue ||
                'user_id_update' in changeValue;
            if (isUserIdUpdate) {
                await handleUserIdUpdate(supabase, waCtx.orgId, changeValue);
                return new NextResponse('EVENT_RECEIVED', { status: 200 });
            }

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
                                .eq('org_id', waCtx.orgId)
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
                // Inbound message id (wamid). Meta delivers webhooks
                // at-least-once, so this is our idempotency key: a redelivery of
                // the same message must not enqueue (or store) it twice.
                const inboundWamid: string | null = typeof message.id === 'string' ? message.id : null;
                if (!inboundWamid) {
                    // Well-formed messages always carry a wamid; a missing one
                    // means our at-least-once dedup (keyed on wamid) is bypassed
                    // for this message. Log it so the blind spot is observable.
                    whatsappLogger.warn(`Inbound ${messageType} message from ${from} has no usable message id — wamid dedup bypassed`);
                }

                // BSUID (business-scoped user ID). Present in contacts[].user_id
                // and/or messages[].from_user_id. Used as a secondary identity
                // so returning customers re-thread even if they arrive without
                // a phone number once usernames roll out.
                const bsuid: string | null =
                    value.contacts?.[0]?.user_id ?? message.from_user_id ?? null;

                // Phase C — best-known real phone. Whenever Meta hands us a
                // wa_id (or `from` is itself a phone), record it as
                // verified_phone so we can still reach a contact whose PK is a
                // BSUID. null when we only got an identifier.
                const waId: string | null =
                    (looksLikePhone(value.contacts?.[0]?.wa_id) && value.contacts[0].wa_id) ||
                    (looksLikePhone(from) && from) ||
                    null;

                // Canonical CRM key — reuse an existing contact's phone_number
                // when we recognise the BSUID; otherwise use `from`.
                const contactKey = await resolveContactKey(supabase, waCtx.orgId, from, bsuid);

                whatsappLogger.info(`Message details - From: ${from}, BSUID: ${bsuid ?? 'none'}, Key: ${contactKey}, Type: ${messageType}`);

                // ===== Phase C: explicit contact share (REQUEST_CONTACT_INFO) =====
                // When a customer taps the REQUEST_CONTACT_INFO button (or sends
                // a contact card), Meta delivers a `contacts`-type message with
                // the shared phone. Capture it into verified_phone and stop —
                // no AI reply needed for a contact share.
                if (messageType === 'contacts') {
                    const shared = Array.isArray(message.contacts) ? message.contacts[0] : null;
                    const phones = shared && Array.isArray(shared.phones) ? shared.phones : [];
                    let sharedPhone: string | null = null;
                    for (const p of phones) {
                        if (looksLikePhone(p?.wa_id)) { sharedPhone = p.wa_id; break; }
                        const digits = typeof p?.phone === 'string' ? p.phone.replace(/\D+/g, '') : '';
                        if (looksLikePhone(digits)) { sharedPhone = digits; break; }
                    }
                    const recovered = sharedPhone ?? waId;
                    if (recovered) {
                        const nowIso = new Date().toISOString();
                        // Upsert (not update): a contact-share could theoretically
                        // be the first event we see for this key, and we don't
                        // want to silently drop the recovered phone.
                        const patch: Record<string, unknown> = {
                            org_id: waCtx.orgId,
                            phone_number: contactKey,
                            verified_phone: recovered,
                            updated_at: nowIso,
                        };
                        if (bsuid) patch.bsuid = bsuid;
                        await supabase
                            .from('whatsapp_chats')
                            .upsert(patch, { onConflict: 'org_id,phone_number' });
                        await logSystemMessage(waCtx.orgId, contactKey, `Customer shared contact info — phone tersimpan: ${recovered}`);
                        whatsappLogger.info(`Contact share captured for ${contactKey}: ${recovered}`);
                    } else {
                        whatsappLogger.warn(`Contact share from ${contactKey} had no usable phone`);
                    }
                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }

                if (messageType === 'text') {
                    const messageBody = message.text.body;
                    whatsappLogger.info(`Received message from ${contactKey}: ${messageBody}`);

                    // Rate limiting (database-based). Namespace the identifier by
                    // org so two tenants who share a customer don't share a rate
                    // bucket (one tenant could otherwise exhaust the other's quota
                    // for that number). Pass service role client to bypass RLS.
                    const allowed = await checkRateLimit(`${waCtx.orgId}:${contactKey}`, supabase);
                    if (!allowed) {
                        whatsappLogger.warn(`Rate limit exceeded for ${contactKey}`);
                        await sendWhatsAppMessage(from, 'Mohon tunggu sebentar sebelum mengirim pesan lagi.', { phoneNumberId: waCtx.phoneNumberId, accessToken: waCtx.accessToken });
                        await logSystemMessage(waCtx.orgId, contactKey, 'Rate limit exceeded. User warned.');
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }

                    // Per-chat AI switch: when an admin has taken over
                    // (ai_enabled = false) skip the automatic AI reply entirely.
                    // The inbound message is still stored below (so it shows in
                    // the inbox + resets the 24h window) — only the auto-reply is
                    // skipped. New contacts have no row yet → treated as enabled.
                    const { data: aiRow } = await supabase
                        .from('whatsapp_chats')
                        .select('ai_enabled')
                        .eq('org_id', waCtx.orgId)
                        .eq('phone_number', contactKey)
                        .maybeSingle();
                    const aiEnabled = aiRow?.ai_enabled !== false;

                    if (aiEnabled) {
                        // Add to database queue (service role client bypasses RLS).
                        // Returns null when this is a duplicate webhook delivery
                        // (deduped on wa_message_id) — then there's nothing to do.
                        const queuedId = await enqueueMessage(waCtx.orgId, contactKey, messageBody, supabase, inboundWamid);
                        if (queuedId) {
                            whatsappLogger.info(`Message from ${contactKey} added to queue`);
                            // Drain any already-settled conversations now (fire and
                            // forget). This is a no-op for THIS conversation —
                            // coalescing waits for the burst to settle (debounce)
                            // before replying, so rapid follow-ups get one reply.
                            processQueue(supabase).catch(err => whatsappLogger.error('Error processing queue immediately', err));
                            // Schedule a delayed drain so this conversation is
                            // answered ~debounce seconds after the customer's LAST
                            // message. Works on the persistent server; the
                            // per-minute cron is the backstop if the timer is lost
                            // on a restart.
                            const delayMs = (getDebounceSeconds() + 5) * 1000;
                            setTimeout(() => {
                                processQueue(supabase).catch(err => whatsappLogger.error('Delayed queue drain failed', err));
                            }, delayMs);
                        }
                    } else {
                        whatsappLogger.info(`AI disabled for ${contactKey} — manual mode, skipping auto-reply`);
                    }

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
                                org_id: waCtx.orgId,
                                phone_number: contactKey,
                                last_message: messageBody,
                                last_message_at: inboundNow,
                                last_inbound_at: inboundNow,
                                updated_at: inboundNow,
                            };
                            if (bsuid) chatPatch.bsuid = bsuid;
                            // Catch-all phone recovery: if Meta revealed a real
                            // phone on this webhook, keep it as verified_phone.
                            if (waId) chatPatch.verified_phone = waId;
                            const { error: chatError } = await supabase
                                .from('whatsapp_chats')
                                .upsert(chatPatch, { onConflict: 'org_id,phone_number' });

                            if (chatError) {
                                whatsappLogger.error('Error updating chat summary', chatError);
                            } else {
                                whatsappLogger.info(`Chat summary updated for ${contactKey}`);
                            }

                            // Insert message. wa_message_id makes this idempotent:
                            // a redelivered webhook hits the unique index (23505)
                            // and is skipped instead of duplicating the history.
                            const { error: msgError } = await supabase
                                .from('whatsapp_messages')
                                .insert({
                                    org_id: waCtx.orgId,
                                    phone_number: contactKey,
                                    role: 'user',
                                    content: messageBody,
                                    wa_message_id: inboundWamid
                                });

                            if (msgError) {
                                if (msgError.code === '23505') {
                                    whatsappLogger.info(`Duplicate inbound message ${inboundWamid} — already stored, skipping`);
                                } else {
                                    whatsappLogger.error('Error inserting message', msgError);
                                }
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
