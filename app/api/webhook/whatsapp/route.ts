import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';
import { checkRateLimit } from '@/lib/whatsapp/rate-limiter-db';
import { enqueueMessage, inboundQueueState, processQueue, getDebounceSeconds } from '@/lib/whatsapp/queue-db';
import { sendWhatsAppMessage, downloadWhatsAppMedia } from '@/lib/whatsapp/client';
import { resolveSendTarget } from '@/lib/whatsapp/recipient';
import { envWebhookApp, resolveWhatsAppContext } from '@/lib/whatsapp/credentials';
import { whatsappLogger } from '@/lib/utils/logger';
import { webhookSummary } from '@/lib/whatsapp/webhook-summary';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { handleFlowReply } from '@/lib/whatsapp/flow-response';
import {
    contactCardSummary,
    flowSubmissionSummary,
    isStoredOtherMessageType,
    otherMessagePreview,
    otherMessageSummary,
} from '@/lib/whatsapp/flow-summary';
import {
    firstOtherNumberLimitNote,
    firstOtherNumberNote,
    otherNumberLabel,
    otherNumberLimitNotice,
    otherNumberMetadata,
    otherNumberMode,
    otherNumberNotice,
    otherNumberOf,
    otherNumberSeen,
    type OtherNumber,
} from '@/lib/whatsapp/other-number';
import { CHAT_MEDIA_BUCKET, CHAT_MEDIA_MAX_BYTES, safePhoneSegment, storageContentType } from '@/lib/storage/chat-media';

import { checkVerifyToken } from '@/lib/settings/app-settings';
import { describeErrorForOps, recordOpsEvent } from '@/lib/ops/events';
import { consumeOrgQuota, firstInboundRefusalNote, inboundQuotaNotice } from '@/lib/quota/org-quota';

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
    // Without parameters: a voice note arrives as 'audio/ogg; codecs=opus'.
    return map[mime.split(';', 1)[0].trim().toLowerCase()] || 'bin';
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
    /** Sent to another number of the WABA (store-only), or null. */
    other: OtherNumber | null;
}

// Store a customer-sent photo / document / voice note / video and notify the
// admin. The AI is intentionally NOT invoked (it can't interpret media) — the
// admin handles these in manual mode. Runs fire-and-forget from the webhook so
// Meta still gets its fast 200; large downloads must not block the response.
async function handleInboundMedia(params: InboundMediaParams): Promise<void> {
    const { supabase, orgId, creds, contactKey, bsuid, waId, inboundWamid, replyToWamid, kind, mediaId, caption, filename, isVoice, other } = params;
    const captionText = caption?.trim() ? caption.trim() : '';
    try {
        // Dedup pre-check: Meta delivers webhooks at-least-once. If this wamid is
        // already stored, skip so we don't re-download from Meta or upload a
        // duplicate object to storage.
        if (inboundWamid) {
            const { data: existing } = await supabase
                .from('whatsapp_messages')
                .select('id')
                .eq('org_id', orgId)
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

        // Best-effort copy into the private chat-media bucket so the dashboard can
        // show it through /api/chat-media/<message id> (Meta's copy expires ~30
        // days). media_url holds the bare object key; the content type is the
        // bucket-allowed form of the mime (media_mime keeps Meta's original).
        // No copy (the upload failed, or the file is above the bucket limit,
        // owner decision D20: not even attempted) → null media_url → placeholder
        // + "Salinan tidak disimpan" in the UI; the row is inserted either way.
        // Sanitise the phone segment; orgId + the random UUID are safe.
        const safePhone = safePhoneSegment(contactKey);
        const path = `${orgId}/${safePhone}/${crypto.randomUUID()}.${inboundMediaExt(mime, filename)}`;
        let mediaPath: string | null = null;
        if (media.size > CHAT_MEDIA_MAX_BYTES) {
            whatsappLogger.info('Inbound media above the chat-media size limit: storage copy skipped (D20)');
        } else {
            const { error: upErr } = await supabase.storage
                .from(CHAT_MEDIA_BUCKET)
                .upload(path, media.bytes, { contentType: storageContentType(mime), upsert: false });
            if (upErr) {
                whatsappLogger.error('Inbound chat-media storage upload failed', upErr);
            } else {
                mediaPath = path;
            }
        }

        const summary = captionText || inboundMediaSummary(kind, filename, isVoice);
        const nowIso = new Date().toISOString();

        // Chat summary + 24h-window reset. last_inbound_at is set on the inbound
        // path only (for a file sent to another number of the WABA too, for the
        // inbox cues: lib/whatsapp/other-number.ts). bsuid / verified_phone
        // recorded when Meta revealed them. .select() returns the row so we get
        // contact_name for the push in one trip.
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
            media_url: mediaPath,
            media_mime: mime,
            media_filename: filename,
            wa_message_id: inboundWamid,
            reply_to_wamid: replyToWamid,
            ...(other ? { metadata: otherNumberMetadata(other) } : {}),
        });
        if (msgErr) {
            if (msgErr.code === '23505') {
                // Raced with a redelivery that inserted first — remove the orphan
                // object we just uploaded so storage doesn't accumulate dupes.
                whatsappLogger.info(`Duplicate inbound media ${inboundWamid} on insert — cleaning orphan storage object`);
                if (mediaPath) {
                    try { await supabase.storage.from(CHAT_MEDIA_BUCKET).remove([mediaPath]); } catch { /* best-effort */ }
                }
                return;
            }
            whatsappLogger.error('Error inserting inbound media message', msgErr);
            return;
        }

        whatsappLogger.info(`Inbound ${kind} stored for ${contactKey}`);
        if (other && firstOtherNumberNote(`${orgId}:${contactKey}`)) {
            await logSystemMessage(orgId, contactKey, otherNumberNotice(other), { touchChat: false });
        }

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

// A Flow submission, a contact card or any other non-text message sent to
// another number of the WABA (store-only): kept for the operators as a
// readable row, with the chat summary, the unread badge and the push of any
// inbound message. Nothing acts on it: no Brief Acara lead or confirmation
// (flow-response.ts; it would go out from the main number), no verified_phone
// taken from a shared card. Within the contact's own rate limit for messages
// to another number (shared with text; over it: not stored, a note once a
// minute).
async function storeOtherNumberMessage(params: {
    supabase: SupabaseClient;
    orgId: string;
    contactKey: string;
    bsuid: string | null;
    waId: string | null;
    inboundWamid: string | null;
    content: string;
    /** The chat-list preview and the push body. */
    preview: string;
    other: OtherNumber;
}): Promise<void> {
    const { supabase, orgId, contactKey, bsuid, waId, inboundWamid, content, preview, other } = params;
    if (!(await checkRateLimit(`${orgId}:other:${contactKey}`, supabase))) {
        whatsappLogger.warn(`Rate limit exceeded for ${contactKey} on another number of the WABA — not stored`);
        if (firstOtherNumberLimitNote(`${orgId}:${contactKey}`)) {
            await logSystemMessage(orgId, contactKey, otherNumberLimitNotice(other), { touchChat: false });
        }
        return;
    }
    const nowIso = new Date().toISOString();
    // last_inbound_at: an inbound message for the inbox cues (see
    // lib/whatsapp/other-number.ts; the note explains the 24-hour marker).
    const chatPatch: Record<string, unknown> = {
        org_id: orgId,
        phone_number: contactKey,
        last_message: preview,
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
    if (chatErr) whatsappLogger.error('Error updating chat summary (message to another number)', chatErr);

    // wa_message_id makes a redelivery a 23505 instead of a second row.
    const { error: msgErr } = await supabase.from('whatsapp_messages').insert({
        org_id: orgId,
        phone_number: contactKey,
        role: 'user',
        content,
        wa_message_id: inboundWamid,
        metadata: otherNumberMetadata(other),
    });
    if (msgErr) {
        if (msgErr.code === '23505') {
            whatsappLogger.info(`Duplicate message ${inboundWamid} to another number — already stored, skipping`);
        } else {
            whatsappLogger.error('Error inserting a message to another number', msgErr);
        }
        return;
    }
    whatsappLogger.info(`Message to another number of the WABA stored for ${contactKey} (nothing sent, nothing acted on)`);
    if (firstOtherNumberNote(`${orgId}:${contactKey}`)) {
        await logSystemMessage(orgId, contactKey, otherNumberNotice(other), { touchChat: false });
    }
    const { error: unreadErr } = await supabase.rpc('bump_unread', { p_org: orgId, p_phone: contactKey });
    if (unreadErr) whatsappLogger.error('Failed to bump unread_count (message to another number)', unreadErr);
    if (inboundWamid) {
        try {
            await sendPushToOrg(supabase, orgId, {
                title: chatRow?.contact_name || contactKey,
                body: preview,
                phone: contactKey,
                url: `/dashboard/chats?phone=${encodeURIComponent(contactKey)}`,
            });
        } catch (pushErr) {
            whatsappLogger.error('Web push fan-out failed (message to another number)', pushErr);
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
    // Set once the signature has passed: only then is a failure a Meta delivery
    // the team must hear about (anyone can POST junk to this URL).
    let verified = false;
    let alertOrgId: string | null = null;
    try {
        // The exact bytes Meta signed, at most Meta's 3 MB: a larger body is
        // refused before it is read in full (anyone can POST here). The
        // signature is checked over these bytes before anything reads the
        // payload (Fase 2 task 2.2a). request.text() would decode them first,
        // and a re-encoded string is not guaranteed to be the same bytes.
        const rawBody = await readBodyCapped(request);
        if (!rawBody) {
            whatsappLogger.warn('Webhook body over 3 MB — refused');
            return new NextResponse('Payload Too Large', { status: 413 });
        }
        const signature = request.headers.get('x-hub-signature-256');

        // One Meta app (env) serves this URL today: its secret and its number.
        const webhookApp = envWebhookApp();
        if (!(await verifyWhatsAppSignature(rawBody, signature, webhookApp.appSecret))) {
            whatsappLogger.warn('Rejected webhook with invalid/missing signature');
            // Team alert (3.5) for what points at our side: no secret set, or a
            // signature that does not match (a wrong or rotated secret makes
            // every real delivery fail). A request without the header is
            // internet noise, since Meta always signs: logged only. A flood is
            // throttled inside recordOpsEvent.
            const alertClient = !webhookApp.appSecret || signature ? serviceRoleClient() : null;
            if (alertClient) {
                await recordOpsEvent(alertClient, 'webhook_signature_invalid', {
                    detail: !webhookApp.appSecret ? 'WHATSAPP_APP_SECRET tidak diset di server' : 'tanda tangan tidak cocok',
                });
            }
            return new NextResponse('Forbidden', { status: 403 });
        }
        verified = true;

        // Signed by our app, so a body that does not parse now will not parse on
        // a retry either: acknowledge it instead of making Meta retry for days.
        let body;
        try {
            body = JSON.parse(rawBody.toString('utf8'));
        } catch {
            whatsappLogger.error('Signed webhook body is not valid JSON — acknowledged without processing');
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        }
        if (!body || typeof body !== 'object') {
            whatsappLogger.warn('Signed webhook body is not a JSON object — acknowledged without processing');
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        }

        // What arrived, never the payload itself: it holds customers' phone
        // numbers, names and message text (audit KEA-21, UU PDP).
        whatsappLogger.info(`Webhook received: ${webhookSummary(body)}`);

        // The service-role client (RLS bypassed: the webhook has no user). With
        // any other key RLS would silently drop every write, so without it the
        // answer is 503 and Meta retries once it is configured.
        const supabase = serviceRoleClient();
        if (!supabase) {
            whatsappLogger.error('Webhook cannot store anything: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
            return new NextResponse('Service Unavailable', { status: 503 });
        }

        // Check if this is an event from a WhatsApp Business Account
        if (body.object === 'whatsapp_business_account') {
            const change = body.entry?.[0]?.changes?.[0];
            const metadata = change?.value?.metadata;
            const phoneNumberId = metadata?.phone_number_id;

            // One-number routing (Fase 2 task 2.2a, phase 0; see
            // lib/whatsapp/other-number.ts). The app is subscribed to the whole
            // WABA, so the events of its other numbers arrive here too. They are
            // not this org's conversations (the AI would answer from the wrong
            // number): dropped, or with WHATSAPP_OTHER_NUMBER_EVENTS=process
            // stored in the default org's inbox without AI replies or any
            // automatic send. Either way the team is told: within the hour for a
            // number not seen in the last 7 days (a new number, or this app's
            // own number under a wrong WHATSAPP_PHONE_NUMBER_ID), daily after
            // that. Without a usable number id nothing can be routed: 503 (Meta
            // retries once it is fixed) and an alert.
            if (!webhookApp.phoneNumberId) {
                const notDigits = webhookApp.phoneNumberIdProblem === 'not_digits';
                whatsappLogger.error(`Webhook cannot route: WHATSAPP_PHONE_NUMBER_ID is ${notDigits ? 'not a phone number id (digits only)' : 'not set'}`);
                await recordOpsEvent(supabase, 'webhook_unconfigured', {
                    detail: `${notDigits ? 'WHATSAPP_PHONE_NUMBER_ID bukan ID nomor (harus angka saja)' : 'WHATSAPP_PHONE_NUMBER_ID tidak diset di server'}; webhook menjawab 503, Meta mengirim ulang`,
                });
                return new NextResponse('Service Unavailable', { status: 503 });
            }

            // ========== HANDLE user_id_update (Phase B) ==========
            // Fires when a customer changes their phone number → BSUID
            // regenerates. We move our stored bsuid old→new so the contact
            // stays linked. Detect by the change field name or a
            // user_id_update(s) key on the value. Before the number gate: a
            // BSUID is scoped to the business portfolio, so the change applies
            // to this org's contacts whichever number of the WABA reported it.
            const changeValue = (change?.value ?? {}) as Record<string, unknown>;
            const isUserIdUpdate =
                change?.field === 'user_id_update' ||
                'user_id_updates' in changeValue ||
                'user_id_update' in changeValue;
            if (isUserIdUpdate) {
                const idCtx = await resolveWhatsAppContext(supabase);
                alertOrgId = idCtx.orgId;
                await handleUserIdUpdate(supabase, idCtx.orgId, changeValue);
                return new NextResponse('EVENT_RECEIVED', { status: 200 });
            }

            // Store-only: the other number whose event is kept in the inbox (no
            // AI, no automatic send from the wrong number), else null.
            let storeOnly: OtherNumber | null = null;
            if (phoneNumberId !== undefined && phoneNumberId !== null && String(phoneNumberId) !== webhookApp.phoneNumberId) {
                const other = otherNumberOf(String(phoneNumberId), metadata?.display_phone_number);
                const otherNumbers = otherNumberMode();
                if (otherNumbers.unknownValue !== undefined) {
                    await recordOpsEvent(supabase, 'webhook_unconfigured', {
                        detail: `WHATSAPP_OTHER_NUMBER_EVENTS tidak dikenal (${otherNumbers.unknownValue}): diperlakukan sebagai process, pesan nomor lain disimpan tanpa AI`,
                    });
                }
                // 'diproses': in process mode a message is stored (within the
                // contact's rate limit); a status update only updates our rows.
                const outcome = otherNumbers.mode === 'drop'
                    ? 'dibuang'
                    : 'diproses tanpa AI, pesan disimpan di inbox (WHATSAPP_OTHER_NUMBER_EVENTS=process)';
                // Looked up before this event is recorded; a failed lookup is
                // alerted too (see otherNumberSeen).
                const seen = await otherNumberSeen(supabase, other);
                if (seen !== 'known') {
                    await recordOpsEvent(supabase, 'webhook_unrouted_new', {
                        detail: `${otherNumberLabel(other)}; ${outcome}${seen === 'unchecked' ? '; riwayat 7 hari tidak terbaca' : ''}`,
                    });
                }
                await recordOpsEvent(supabase, 'webhook_unrouted', { detail: `${otherNumberLabel(other)}; ${outcome}` });
                if (otherNumbers.mode === 'drop') {
                    whatsappLogger.warn(`Webhook for another number of the WABA (${other.ref}) — dropped`);
                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }
                whatsappLogger.warn(`Webhook for another number of the WABA (${other.ref}) — stored without AI (WHATSAPP_OTHER_NUMBER_EVENTS=process)`);
                storeOnly = other;
            }

            // Single-tenant: org + credentials come from env; the org is read
            // strictly (a read error throws → 500, Meta retries).
            const waCtx = await resolveWhatsAppContext(supabase);
            alertOrgId = waCtx.orgId;

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

                    // Scoped to the org: a wamid is only unique per org.
                    const { error: updateErr } = await supabase
                        .from('whatsapp_messages')
                        .update(patch)
                        .eq('org_id', waCtx.orgId)
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
            if (change?.value?.messages?.[0]) {
                const value = change.value;
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
                // no AI reply needed for a contact share. A card sent to another
                // number of the WABA (store-only) is only stored for the
                // operators: it was not an answer to this number's request.
                if (messageType === 'contacts' && storeOnly) {
                    await storeOtherNumberMessage({
                        supabase,
                        orgId: waCtx.orgId,
                        contactKey,
                        bsuid,
                        waId,
                        inboundWamid,
                        content: contactCardSummary(message.contacts),
                        preview: '👤 Kartu kontak',
                        other: storeOnly,
                    });
                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }
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
                        // Not a reply to the customer: an earlier unanswered
                        // message keeps the chat "Belum dibalas".
                        await logSystemMessage(waCtx.orgId, contactKey, `Customer shared contact info — phone tersimpan: ${recovered}`, { touchChat: false });
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
                // lib/whatsapp/flow-response.ts. A submission to another number of
                // the WABA (store-only) is only stored, as a summary of its answers.
                if (messageType === 'interactive') {
                    const interactive = message.interactive;
                    if (interactive?.type === 'nfm_reply' && interactive.nfm_reply && storeOnly) {
                        await storeOtherNumberMessage({
                            supabase,
                            orgId: waCtx.orgId,
                            contactKey,
                            bsuid,
                            waId,
                            inboundWamid,
                            content: flowSubmissionSummary(interactive.nfm_reply.response_json),
                            preview: '📋 Mengisi form WhatsApp',
                            other: storeOnly,
                        });
                    } else if (interactive?.type === 'nfm_reply' && interactive.nfm_reply) {
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
                    } else if (storeOnly) {
                        // A button or list choice sent to another number: kept
                        // as one readable line (nothing acts on it).
                        const summary = otherMessageSummary(message);
                        await storeOtherNumberMessage({
                            supabase,
                            orgId: waCtx.orgId,
                            contactKey,
                            bsuid,
                            waId,
                            inboundWamid,
                            content: summary,
                            preview: summary,
                            other: storeOnly,
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
                        other: storeOnly,
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
                    // A message to another number of the WABA (store-only) has its
                    // own bucket, so a flood there does not limit this customer on
                    // the main number; over the limit it is not stored (like an
                    // over-limit message to the main number), no warning is sent
                    // (it would come from the main number), and the chat gets a
                    // note once a minute so the operators know messages are missing.
                    const rateKey = storeOnly ? `${waCtx.orgId}:other:${contactKey}` : `${waCtx.orgId}:${contactKey}`;
                    const allowed = await checkRateLimit(rateKey, supabase);
                    if (!allowed && storeOnly) {
                        whatsappLogger.warn(`Rate limit exceeded for ${contactKey} on another number of the WABA — not stored, nothing sent`);
                        if (firstOtherNumberLimitNote(`${waCtx.orgId}:${contactKey}`)) {
                            await logSystemMessage(waCtx.orgId, contactKey, otherNumberLimitNotice(storeOnly), { touchChat: false });
                        }
                        return new NextResponse('EVENT_RECEIVED', { status: 200 });
                    }
                    if (!allowed) {
                        whatsappLogger.warn(`Rate limit exceeded for ${contactKey}`);
                        const warnTarget = await resolveSendTarget(supabase, waCtx.orgId, contactKey);
                        await sendWhatsAppMessage(warnTarget, 'Mohon tunggu sebentar sebelum mengirim pesan lagi.', { phoneNumberId: waCtx.phoneNumberId, accessToken: waCtx.accessToken });
                        // The dropped message was not answered: keep the chat
                        // "Belum dibalas" for the operators.
                        await logSystemMessage(waCtx.orgId, contactKey, 'Rate limit exceeded. User warned.', { touchChat: false });
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
                    const aiEnabled = !storeOnly && aiRow?.ai_enabled !== false;

                    // Org quota (tracker 3.4, migration 0071): at most N new AI
                    // bursts a minute per org. A fragment that joins this chat's
                    // burst still waiting in the queue adds no AI call and is
                    // queued uncounted; a redelivery (already queued or stored)
                    // is neither counted nor queued again. Over the limit the
                    // message is still stored below, with a note for the
                    // operators, but gets no AI reply; the team is alerted on the
                    // first refusal. Check-then-insert, not locked per chat: two
                    // first fragments arriving at once are both counted, and a
                    // fragment arriving just as its burst is claimed starts an
                    // uncounted burst (the daily quota still counts it).
                    // (inboundQueueState must run before the message is stored
                    // below: it treats a stored wamid as a redelivery.)
                    let refusedByQuota: number | null = null;
                    let redelivery = false;
                    if (aiEnabled) {
                        const queued = await inboundQueueState(supabase, waCtx.orgId, contactKey, inboundWamid);
                        redelivery = queued.duplicate;
                        if (!queued.duplicate && !queued.joinsBurst) {
                            const burst = await consumeOrgQuota(supabase, waCtx.orgId, 'inbound_minute');
                            if (!burst.allowed) refusedByQuota = burst.limit;
                        }
                    }

                    if (aiEnabled && redelivery) {
                        whatsappLogger.info('Redelivered inbound message — already queued or stored, not queued again');
                    } else if (aiEnabled && refusedByQuota === null) {
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
                    } else if (aiEnabled) {
                        whatsappLogger.warn(`Org inbound quota reached (${refusedByQuota}/min): message stored without an AI reply`);
                    } else if (storeOnly) {
                        whatsappLogger.info(`Message from ${contactKey} to another number of the WABA — stored without AI`);
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
                            // touch it. A message to another number of the WABA
                            // sets it too, for the inbox cues (see
                            // lib/whatsapp/other-number.ts; its note explains the
                            // marker). bsuid is recorded so we can re-thread this
                            // contact later even if they arrive phone-less.
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
                                    ...(storeOnly ? { metadata: otherNumberMetadata(storeOnly) } : {}),
                                });

                            if (msgError) {
                                if (msgError.code === '23505') {
                                    whatsappLogger.info(`Duplicate inbound message ${inboundWamid} — already stored, skipping`);
                                } else {
                                    whatsappLogger.error('Error inserting message', msgError);
                                }
                            } else {
                                whatsappLogger.info(`User message inserted for ${contactKey}`);

                                // The minute quota kept this message from the AI:
                                // tell the operators, once per chat and minute,
                                // without marking the chat answered (it still
                                // needs a human reply).
                                if (refusedByQuota !== null && firstInboundRefusalNote(`${waCtx.orgId}:${contactKey}`)) {
                                    await logSystemMessage(waCtx.orgId, contactKey, inboundQuotaNotice(refusedByQuota), { touchChat: false });
                                }
                                // A message to another number of the WABA: tell
                                // the operators, once a day per chat, keeping the
                                // chat unanswered.
                                if (storeOnly && firstOtherNumberNote(`${waCtx.orgId}:${contactKey}`)) {
                                    await logSystemMessage(waCtx.orgId, contactKey, otherNumberNotice(storeOnly), { touchChat: false });
                                }

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

                // Any other type the customer sent to another number of the WABA
                // (a template's quick-reply button, a location, an order, a type
                // Sarathi does not show) is kept too, as one readable line, so
                // process mode loses no message that arrived. Events where the
                // customer wrote nothing (a number change, opening the chat, a
                // reaction) are only acknowledged, as on the main number.
                if (storeOnly && !isStoredOtherMessageType(messageType)) {
                    whatsappLogger.info(`${messageType} event for another number of the WABA — acknowledged without storing`);
                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }
                if (storeOnly) {
                    await storeOtherNumberMessage({
                        supabase,
                        orgId: waCtx.orgId,
                        contactKey,
                        bsuid,
                        waId,
                        inboundWamid,
                        content: otherMessageSummary(message),
                        preview: otherMessagePreview(message),
                        other: storeOnly,
                    });
                    return new NextResponse('EVENT_RECEIVED', { status: 200 });
                }
            }
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        } else {
            // Signed by our app but not a WhatsApp Business Account event:
            // acknowledge it (a 404 would make Meta retry it for days).
            whatsappLogger.warn('Received non-WhatsApp event — acknowledged without processing');
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        }

    } catch (error) {
        whatsappLogger.error('Error processing webhook', error);
        // Team alert (3.5): Meta retries the delivery, but a webhook that keeps
        // failing loses messages once Meta gives up. Signed deliveries only.
        const alertClient = verified ? serviceRoleClient() : null;
        if (alertClient) {
            await recordOpsEvent(alertClient, 'webhook_error', { orgId: alertOrgId, detail: describeErrorForOps(error) });
        }
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}

// Meta's largest webhook payload (developers.facebook.com, set-up-webhooks).
const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024;

// The request body, or null when it is over MAX_WEBHOOK_BYTES: by the declared
// length before reading, else while reading (a chunked body is cancelled as
// soon as it passes the limit).
async function readBodyCapped(request: Request): Promise<Buffer | null> {
    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
    if (!request.body) return Buffer.alloc(0);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_WEBHOOK_BYTES) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

// The service-role client the webhook works with, or null when it is not
// configured. Never the anon key: under RLS every write would silently fail.
function serviceRoleClient(): SupabaseClient | null {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    return url && key ? createClient(url, key) : null;
}
