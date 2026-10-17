import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';
import { checkRateLimit } from '@/lib/whatsapp/rate-limiter-db';
import { enqueueMessage, processQueue, getDebounceSeconds } from '@/lib/whatsapp/queue-db';
import { sendWhatsAppMessage, downloadWhatsAppMedia } from '@/lib/whatsapp/client';
import { resolveSendTarget } from '@/lib/whatsapp/recipient';
import { resolveWhatsAppContext } from '@/lib/whatsapp/credentials';
import { whatsappLogger } from '@/lib/utils/logger';
import { webhookSummary } from '@/lib/whatsapp/webhook-summary';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { handleFlowReply } from '@/lib/whatsapp/flow-response';

import { checkVerifyToken } from '@/lib/settings/app-settings';

// Resolve the canonical contact key for the whatsapp_chats PK.
//
// Meta is migrating to business-scoped user IDs (BSUIDs). Today `from` is a
// phone number, but from June 2026 it may be a BSUID instead. We key the CRM
// on phone_number (hybrid strategy), so when a returning customer arrives
// with a BSUID we've seen before, re-thread them into their existing
// conversation by reusing the phone_number we already have. Otherwise fall
// back to `from` (a phone today, or a BSUID once usernames roll out — either
// works as a stable PK; the send layer routes a BSUID via `recipient`, since
// Meta rejects a BSUID in the `to` field). Returns null only when we have
// NEITHER a `from` nor a BSUID — the caller then acks and skips.
async function resolveContactKey(
    supabase: SupabaseClient,
    orgId: string,
    from: string | null | undefined,
    bsuid: string | null
): Promise<string | null> {
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
    // A phone-hidden NEW customer arrives with no phone (from omitted) but a
    // BSUID — fall back to the BSUID verbatim so contactKey is never nullish
    // for a routable message.
    return from || bsuid || null;
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
// Real Meta payload (WhatsApp BSUID docs), field "user_id_update":
//   value.user_id_update: [ { wa_id, detail,
//     user_id: { previous: <OLD_BSUID>, current: <NEW_BSUID> },
//     parent_user_id: { previous, current }, timestamp } ]
// We read the nested user_id.previous/current, and still fall back to a few
// flat guesses in case Meta tweaks the shape during the 2026 rollout.
async function handleUserIdUpdate(
    supabase: SupabaseClient,
    orgId: string,
    value: Record<string, unknown>
): Promise<void> {
    // Container: value.user_id_update[] (the documented shape); accept the
    // plural and a bare object too, defensively.
    const container = Array.isArray(value.user_id_update)
        ? value.user_id_update
        : Array.isArray(value.user_id_updates)
            ? value.user_id_updates
            : [value];
    const updates: Array<Record<string, unknown>> = container.filter(
        (u): u is Record<string, unknown> => !!u && typeof u === 'object',
    );

    const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
        for (const k of keys) {
            const v = o[k];
            if (typeof v === 'string' && v.length > 0) return v;
        }
        return null;
    };
    // The documented shape nests the ids under `user_id: { previous, current }`.
    const nested = (u: Record<string, unknown>): Record<string, unknown> | null =>
        u.user_id && typeof u.user_id === 'object' ? (u.user_id as Record<string, unknown>) : null;

    for (const u of updates) {
        const uid = nested(u);
        const oldId =
            (uid && pick(uid, ['previous'])) ||
            pick(u, ['old_user_id', 'previous_user_id', 'old_wa_id', 'previous_wa_id']);
        const newId =
            (uid && pick(uid, ['current'])) ||
            pick(u, ['new_user_id', 'current_user_id', 'new_wa_id', 'current_wa_id']);
        if (!oldId || !newId) {
            whatsappLogger.warn(`user_id_update: could not parse old/new id (fields: ${Object.keys(u ?? {}).join(',') || '-'})`);
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

const CHAT_MEDIA_BUCKET = 'chat-media';

type InboundMediaKind = 'image' | 'document' | 'audio' | 'video';

// Storage object extension for an inbound file — keep the original where the
// document carried a filename, else map from the mime Meta reported.
function inboundMediaExt(mime: string, filename: string | null): string {
    if (filename && filename.includes('.')) {
        const e = filename.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (e) return e;
    }
    const map: Record<string, string> = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
        'application/pdf': 'pdf',
        'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
        'video/mp4': 'mp4', 'video/3gpp': '3gp',
    };
    return map[mime] || 'bin';
}

// One-line preview used for the chat-list `last_message` and the push body when
// the customer didn't add a caption.
function inboundMediaSummary(kind: InboundMediaKind, filename: string | null, isVoice: boolean): string {
    switch (kind) {
        case 'image': return '📷 Foto';
        case 'video': return '🎬 Video';
        case 'audio': return isVoice ? '🎤 Pesan suara' : '🎵 Audio';
        case 'document': return `📎 ${filename || 'Dokumen'}`;
    }
}

interface InboundMediaParams {
    supabase: SupabaseClient;
    orgId: string;
    creds: { phoneNumberId: string; accessToken: string };
    contactKey: string;
    bsuid: string | null;
    waId: string | null;
    inboundWamid: string | null;
    replyToWamid: string | null;
    kind: InboundMediaKind;
    mediaId: string;
    caption: string | null;
    filename: string | null;
    isVoice: boolean;
}

// Store a customer-sent photo / document / voice note / video and notify the
// admin. The AI is intentionally NOT invoked (it can't interpret media) — the
// admin handles these in manual mode. Runs fire-and-forget from the webhook so
// Meta still gets its fast 200; large downloads must not block the response.
async function handleInboundMedia(params: InboundMediaParams): Promise<void> {
    const { supabase, orgId, creds, contactKey, bsuid, waId, inboundWamid, replyToWamid, kind, mediaId, caption, filename, isVoice } = params;
    const captionText = caption?.trim() ? caption.trim() : '';
    try {
        // Dedup pre-check: Meta delivers webhooks at-least-once. If this wamid is
        // already stored, skip so we don't re-download from Meta or upload a
        // duplicate object to storage.
        if (inboundWamid) {
            const { data: existing } = await supabase
                .from('whatsapp_messages')
                .select('id')
                .eq('wa_message_id', inboundWamid)
                .maybeSingle<{ id: string }>();
            if (existing) {
                whatsappLogger.info(`Duplicate inbound media ${inboundWamid} — already stored, skipping`);
                return;
            }
        }

        // Pull the bytes from Meta (2-step download).
        const media = await downloadWhatsAppMedia(mediaId, creds);
        const mime = media.mime;

        // Best-effort persist to our public bucket so the dashboard can render it
        // inline (Meta's copy expires ~30 days). If the upload fails we still
        // insert the row (null URL → placeholder in the UI). Sanitise the phone
        // segment; orgId + the random UUID are safe.
        const safePhone = contactKey.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${orgId}/${safePhone}/${crypto.randomUUID()}.${inboundMediaExt(mime, filename)}`;
        let mediaUrl: string | null = null;
        const { error: upErr } = await supabase.storage
            .from(CHAT_MEDIA_BUCKET)
            .upload(path, media.bytes, { contentType: mime, upsert: false });
        if (upErr) {
            whatsappLogger.error('Inbound chat-media storage upload failed', upErr);
        } else {
            mediaUrl = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
        }

        const summary = captionText || inboundMediaSummary(kind, filename, isVoice);
        const nowIso = new Date().toISOString();

        // Chat summary + 24h-window reset. last_inbound_at is set on the inbound
        // path only. bsuid / verified_phone recorded when Meta revealed them.
        // .select() returns the row so we get contact_name for the push in one trip.
        const chatPatch: Record<string, unknown> = {
            org_id: orgId,
            phone_number: contactKey,
            last_message: summary,
            last_message_at: nowIso,
            last_inbound_at: nowIso,
            updated_at: nowIso,
        };
        if (bsuid) chatPatch.bsuid = bsuid;
        if (waId) chatPatch.verified_phone = waId;
        const { data: chatRow, error: chatErr } = await supabase
            .from('whatsapp_chats')
            .upsert(chatPatch, { onConflict: 'org_id,phone_number' })
            .select('contact_name')
            .maybeSingle<{ contact_name: string | null }>();
        if (chatErr) whatsappLogger.error('Error updating chat summary (inbound media)', chatErr);

        // Insert the message. wa_message_id makes this idempotent (unique index).
        const { error: msgErr } = await supabase.from('whatsapp_messages').insert({
            org_id: orgId,
            phone_number: contactKey,
            role: 'user',
            content: captionText,
            media_type: kind,
            media_url: mediaUrl,
            media_mime: mime,
            media_filename: filename,
            wa_message_id: inboundWamid,
            reply_to_wamid: replyToWamid,
        });
        if (msgErr) {
            if (msgErr.code === '23505') {
                // Raced with a redelivery that inserted first — remove the orphan
                // object we just uploaded so storage doesn't accumulate dupes.
                whatsappLogger.info(`Duplicate inbound media ${inboundWamid} on insert — cleaning orphan storage object`);
                if (mediaUrl) {
                    try { await supabase.storage.from(CHAT_MEDIA_BUCKET).remove([path]); } catch { /* best-effort */ }
                }
                return;
            }
            whatsappLogger.error('Error inserting inbound media message', msgErr);
            return;
        }

        whatsappLogger.info(`Inbound ${kind} stored for ${contactKey}`);

        // Per-chat unread badge: atomic increment (best-effort).
        const { error: unreadErr } = await supabase.rpc('bump_unread', { p_org: orgId, p_phone: contactKey });
        if (unreadErr) whatsappLogger.error('Failed to bump unread_count (inbound media)', unreadErr);

        // Tier 2 — Web Push fan-out. Gated on a present wamid (its unique index
        // dedups redeliveries, so each message pushes once). Best-effort; no-op
        // unless VAPID is configured.
        if (inboundWamid) {
            try {
                await sendPushToOrg(supabase, orgId, {
                    title: chatRow?.contact_name || contactKey,
                    body: summary,
                    phone: contactKey,
                    url: `/dashboard/chats?phone=${encodeURIComponent(contactKey)}`,
                });
            } catch (pushErr) {
                whatsappLogger.error('Web push fan-out failed (inbound media)', pushErr);
            }
        }
    } catch (err) {
        whatsappLogger.error('Error handling inbound media', err);
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

        // What arrived, never the payload itself: it holds customers' phone
        // numbers, names and message text (audit KEA-21, UU PDP).
        whatsappLogger.info(`Webhook received: ${webhookSummary(body)}`);

        // Initialize Supabase client with Service Role Key for backend operations
        // This bypasses RLS policies to ensure we can always log messages
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        // Check if this is an event from a WhatsApp Business Account
        if (body.object === 'whatsapp_business_account') {
            // Extract metadata (phone_number_id is logged only; single-tenant
            // resolves credentials from env).
            const change = body.entry?.[0]?.changes?.[0];
            const metadata = change?.value?.metadata;
            const phoneNumberId = metadata?.phone_number_id;

            whatsappLogger.info(`Webhook from phone_number_id: ${phoneNumberId}`);

            // Single-tenant: org + credentials come from env.
            const waCtx = await resolveWhatsAppContext(supabase);

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

                // Match each status by wamid and update the row's status. Failed
                // deliveries (e.g. code 131047 "Re-engagement message" past the
                // 24h customer service window) used to be silent because we never
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

                    // Enrichment: status callbacks carry recipient_id (phone) +
                    // recipient_user_id (BSUID). Backfill the contact's bsuid if
                    // we have both and it isn't set yet — best-effort, never
                    // blocks the status update.
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

                // Always return 200 to Meta
                return new NextResponse('EVENT_RECEIVED', { status: 200 });
            }

            // ========== HANDLE INBOUND MESSAGES ==========
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
                const value = body.entry[0].changes[0].value;
                const message = value.messages[0];
                const from = message.from; // phone today; may be a BSUID from June 2026
                const messageType = message.type;
                // Inbound message id (wamid). Meta delivers webhooks
                // at-least-once, so this is our idempotency key: a redelivery of
                // the same message must not enqueue (or store) it twice.
                const inboundWamid: string | null = typeof message.id === 'string' ? message.id : null;
                // If the customer replied to one of our messages, Meta includes
                // the quoted message's wamid in message.context.id.
                const inboundContextId: string | null =
                    message.context && typeof message.context.id === 'string' ? message.context.id : null;
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
                // when we recognise the BSUID; otherwise use `from`, else the
                // BSUID verbatim.
                const contactKey = await resolveContactKey(supabase, waCtx.orgId, from, bsuid);

                // A phone-hidden payload with neither a phone nor a BSUID is
                // unroutable — ack so Meta doesn't retry-storm, and skip (never
                // let an undefined key reach the phone_number PK writes below).
                if (!contactKey) {
                    whatsappLogger.warn(`Inbound ${messageType} message has no usable identity (no phone, no BSUID) — acking without processing`);
                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }

                whatsappLogger.info(`Message details - From: ${from ?? 'none'}, BSUID: ${bsuid ?? 'none'}, Key: ${contactKey}, Type: ${messageType}`);

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

                // ===== WhatsApp Flow submissions (interactive → nfm_reply) =====
                // A customer submitted a Flow (e.g. "Brief Acara" — from the
                // template button or an in-window flow message). Without this
                // branch the submission would fall through unhandled: no history
                // row, no lead, no confirmation, and no 24h-window reset. Full
                // handling (history + CRM upsert + Nindra context via system
                // message + deterministic confirmation) lives in
                // lib/whatsapp/flow-response.ts.
                if (messageType === 'interactive') {
                    const interactive = message.interactive;
                    if (interactive?.type === 'nfm_reply' && interactive.nfm_reply) {
                        await handleFlowReply({
                            supabase,
                            orgId: waCtx.orgId,
                            phoneNumberId: waCtx.phoneNumberId,
                            accessToken: waCtx.accessToken,
                            contactKey,
                            bsuid,
                            waId,
                            inboundWamid,
                            nfmReply: interactive.nfm_reply,
                        });
                    } else {
                        // Other interactive subtypes (button_reply, list_reply)
                        // are not used by this app yet — log so they're visible.
                        whatsappLogger.info(`Unhandled interactive subtype from ${contactKey}: ${interactive?.type ?? 'unknown'}`);
                    }
                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }

                // ===== Inbound media (customer sent a photo / document / voice note / video) =====
                // The AI can't "see" media, so it stays silent (manual mode): we
                // download the file, store it in chat-media, insert a role:'user'
                // row, and notify the admin. A sticker is a webp image → stored as
                // 'image'. Fire-and-forget so Meta gets its fast 200; media
                // downloads (up to video) can be slow.
                if (messageType === 'image' || messageType === 'document' || messageType === 'audio'
                    || messageType === 'video' || messageType === 'sticker') {
                    const mediaObj = message[messageType] ?? {};
                    const mediaId: string | null = typeof mediaObj.id === 'string' ? mediaObj.id : null;
                    if (!mediaId) {
                        whatsappLogger.warn(`Inbound ${messageType} from ${contactKey} had no media id — skipping`);
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }
                    const kind: InboundMediaKind = messageType === 'sticker' ? 'image' : messageType;
                    const caption: string | null = typeof mediaObj.caption === 'string' ? mediaObj.caption : null;
                    const filename: string | null =
                        messageType === 'document' && typeof mediaObj.filename === 'string' ? mediaObj.filename : null;
                    const isVoice = messageType === 'audio' && mediaObj.voice === true;

                    void handleInboundMedia({
                        supabase,
                        orgId: waCtx.orgId,
                        creds: { phoneNumberId: waCtx.phoneNumberId, accessToken: waCtx.accessToken },
                        contactKey,
                        bsuid,
                        waId,
                        inboundWamid,
                        replyToWamid: inboundContextId,
                        kind,
                        mediaId,
                        caption,
                        filename,
                        isVoice,
                    });

                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }

                if (messageType === 'text') {
                    const messageBody = message.text.body;
                    whatsappLogger.info(`Received text message from ${contactKey} (${messageBody.length} chars)`);

                    // Rate limiting (database-based). Namespace the identifier by
                    // org so two tenants who share a customer don't share a rate
                    // bucket (one tenant could otherwise exhaust the other's quota
                    // for that number). Pass service role client to bypass RLS.
                    const allowed = await checkRateLimit(`${waCtx.orgId}:${contactKey}`, supabase);
                    if (!allowed) {
                        whatsappLogger.warn(`Rate limit exceeded for ${contactKey}`);
                        const warnTarget = await resolveSendTarget(supabase, waCtx.orgId, contactKey);
                        await sendWhatsAppMessage(warnTarget, 'Mohon tunggu sebentar sebelum mengirim pesan lagi.', { phoneNumberId: waCtx.phoneNumberId, accessToken: waCtx.accessToken });
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
                        .select('ai_enabled, contact_name')
                        .eq('org_id', waCtx.orgId)
                        .eq('phone_number', contactKey)
                        .maybeSingle<{ ai_enabled: boolean | null; contact_name: string | null }>();
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
                                    wa_message_id: inboundWamid,
                                    reply_to_wamid: inboundContextId,
                                });

                            if (msgError) {
                                if (msgError.code === '23505') {
                                    whatsappLogger.info(`Duplicate inbound message ${inboundWamid} — already stored, skipping`);
                                } else {
                                    whatsappLogger.error('Error inserting message', msgError);
                                }
                            } else {
                                whatsappLogger.info(`User message inserted for ${contactKey}`);

                                // Per-chat unread badge: atomic increment (only on
                                // a genuinely-new, non-duplicate insert). Best-effort
                                // — a failure must not affect message storage.
                                const { error: unreadErr } = await supabase.rpc('bump_unread', {
                                    p_org: waCtx.orgId,
                                    p_phone: contactKey,
                                });
                                if (unreadErr) whatsappLogger.error('Failed to bump unread_count', unreadErr);

                                // Tier 2 — Web Push fan-out. Alert every subscribed
                                // admin device even when the dashboard is closed.
                                // Gated on BOTH a present wamid AND the successful
                                // insert above: the wamid unique index dedups Meta's
                                // at-least-once redeliveries (23505), so each message
                                // pushes exactly once. A wamid-less message (rare, and
                                // logged as an anomaly above) has no idempotency key —
                                // its insert isn't deduped, so we skip the push rather
                                // than risk a double-notify on redelivery. Best-effort:
                                // a push failure must never affect message storage.
                                // No-op unless VAPID keys are configured.
                                if (inboundWamid) {
                                    try {
                                        await sendPushToOrg(supabase, waCtx.orgId, {
                                            title: aiRow?.contact_name || contactKey,
                                            body: messageBody,
                                            phone: contactKey,
                                            url: `/dashboard/chats?phone=${encodeURIComponent(contactKey)}`,
                                        });
                                    } catch (pushErr) {
                                        whatsappLogger.error('Web push fan-out failed', pushErr);
                                    }
                                }
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
