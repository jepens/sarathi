import type { SupabaseClient } from '@supabase/supabase-js';
import { downloadWhatsAppMedia } from '@/lib/whatsapp/client';
import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { firstOtherNumberNote, otherNumberMetadata, otherNumberNotice, type OtherNumber } from '@/lib/whatsapp/other-number';
import { CHAT_MEDIA_BUCKET, CHAT_MEDIA_MAX_BYTES, safePhoneSegment, storageContentType } from '@/lib/storage/chat-media';
import { resolveContactKey } from '@/lib/whatsapp/webhook/contact';
import { MalformedPayloadError } from '@/lib/whatsapp/webhook/errors';
import { isRecord } from '@/lib/whatsapp/webhook/payload';
import { runInBackground } from '@/lib/whatsapp/webhook/background';
import type { ItemResult } from '@/lib/whatsapp/webhook/outcome';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';

// A photo, document, voice note, video or sticker from the customer: stored for
// the admin, without the AI.

export type InboundMediaKind = 'image' | 'document' | 'audio' | 'video';

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
export function inboundMediaSummary(kind: InboundMediaKind, filename: string | null, isVoice: boolean): string {
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
export async function handleInboundMedia(params: InboundMediaParams): Promise<void> {
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

export async function handleMediaMessage(ctx: MessageContext): Promise<ItemResult> {
    const { supabase, waCtx, message, type, identity, storeOnly } = ctx;

    // ===== Inbound media (customer sent a photo / document / voice note / video) =====
    // The AI can't "see" media, so it stays silent (manual mode): we
    // download the file, store it in chat-media, insert a role:'user'
    // row, and notify the admin. A sticker is a webp image → stored as
    // 'image'. Fire-and-forget so Meta gets its fast 200; media
    // downloads (up to video) can be slow. Still part 1's code path in this
    // build (PR-C3 moves it onto wa_ingest_inbound with a durable work row);
    // the batch's pre-dedup keeps a resend from downloading it again.
    const mediaType = type as 'image' | 'document' | 'audio' | 'video' | 'sticker';
    const mediaObj: Record<string, unknown> = isRecord(message[mediaType]) ? message[mediaType] : {};
    const mediaId: string | null = typeof mediaObj.id === 'string' && mediaObj.id ? mediaObj.id : null;
    // Without an id there is nothing to download: stored as a placeholder.
    if (!mediaId) throw new MalformedPayloadError('berkas tanpa id media');
    const kind: InboundMediaKind = mediaType === 'sticker' ? 'image' : mediaType;
    const caption: string | null = typeof mediaObj.caption === 'string' ? mediaObj.caption : null;
    const filename: string | null =
        mediaType === 'document' && typeof mediaObj.filename === 'string' ? mediaObj.filename : null;
    const isVoice = mediaType === 'audio' && mediaObj.voice === true;

    const contactKey = await resolveContactKey(supabase, waCtx.orgId, identity.from, identity.bsuid);
    if (!contactKey) return 'skipped'; // unreachable: the prelude requires a phone or a BSUID

    runInBackground('inbound media', () =>
        handleInboundMedia({
            supabase,
            orgId: waCtx.orgId,
            creds: { phoneNumberId: waCtx.phoneNumberId, accessToken: waCtx.accessToken },
            contactKey,
            bsuid: identity.bsuid,
            waId: identity.waId,
            inboundWamid: ctx.key,
            replyToWamid: ctx.replyTo,
            kind,
            mediaId,
            caption,
            filename,
            isVoice,
            other: storeOnly,
        }),
    );
    return 'legacy';
}
