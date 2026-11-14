import { whatsappLogger } from '@/lib/utils/logger';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { resolveSendTarget } from '@/lib/whatsapp/recipient';
import { logSystemMessage } from '@/lib/whatsapp/history';
import {
    firstOtherNumberLimitNote,
    firstOtherNumberNote,
    otherNumberLimitNotice,
    otherNumberNotice,
} from '@/lib/whatsapp/other-number';
import {
    QUOTA_DEFAULTS,
    firstInboundRefusalNote,
    inboundQuotaNotice,
    recordInboundQuotaAlerts,
} from '@/lib/quota/org-quota';
import { isWhatsAppTokenError, recordOpsEvent } from '@/lib/ops/events';
import { runInBackground } from '@/lib/whatsapp/webhook/background';
import { RATE_LIMIT_PER_MINUTE } from '@/lib/whatsapp/webhook/limits';
import type { IngestResult } from '@/lib/whatsapp/webhook/ingest';
import type { MessageContext } from '@/lib/whatsapp/webhook/types';

// What follows a committed wa_ingest_inbound call: the push, the notes for
// the operators, the quota alerts and the rate-limit warning. All of it runs
// in the background and is best-effort: the message, its unread count and
// its queue job are already committed, and nothing here changes Meta's answer.
// A duplicate does nothing at all (the first delivery did it), so a resend
// never pushes, notes or warns twice.

/** The warning a customer over the main number's rate limit gets (once per window, D23-1). */
export const RATE_LIMIT_WARNING = 'Mohon tunggu sebentar sebelum mengirim pesan lagi.';

/** The operators' note when the warning went out. */
export const RATE_LIMIT_NOTE = 'Rate limit exceeded. User warned.';

/** The operators' note when the warning could not be sent. */
export const RATE_LIMIT_WARNING_FAILED_NOTE =
    `Pelanggan mengirim lebih dari ${RATE_LIMIT_PER_MINUTE} pesan dalam satu menit: pesan yang lewat batas tidak disimpan, ` +
    'dan peringatan "Mohon tunggu" gagal dikirim ke pelanggan.';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The operators' note on a text that reached us late (D23-2): stored without
 * an AI reply. Past 24 hours Meta refuses a free-form reply (131047) unless
 * the customer wrote again since.
 */
export function lateMessageNotice(ageMs: number): string {
    const hours = Math.floor(ageMs / HOUR_MS);
    return (
        `Pesan pelanggan di atas baru diterima Sarathi ${hours} jam setelah dikirim, jadi tidak dibalas AI. Balas secara manual bila perlu.` +
        (hours >= 24
            ? ' Pesan ini sudah lewat 24 jam: bila pelanggan belum menulis lagi sejak itu, balasan biasa ditolak Meta, jadi kirim template.'
            : '')
    );
}

const lateNotes = new Map<string, number>();
const LATE_NOTES_MAX = 1000;

/**
 * True at most once per chat and hour (per server process): whether a late
 * text gets the note, so a backlog Meta delivers after an outage does not
 * fill the thread with notes.
 */
export function firstLateNote(chatKey: string, now = Date.now()): boolean {
    const last = lateNotes.get(chatKey);
    if (last !== undefined && now - last < HOUR_MS) return false;
    if (lateNotes.size >= LATE_NOTES_MAX) lateNotes.clear();
    lateNotes.set(chatKey, now);
    return true;
}

/** Tests only: forget the late-note throttle. */
export function resetAfterIngestState(): void {
    lateNotes.clear();
}

/** What the handler knows that the database result does not. */
export interface AfterIngestInput {
    /** The chat-list preview and the push body. */
    preview: string;
    /** A late main-number text: its age by Meta's time, else null. */
    lateAgeMs: number | null;
}

/**
 * The effects of one committed ingest. The drain request is made at once (the
 * batch drains the queue after its walk); everything else is started in the
 * background.
 */
export function afterIngest(ctx: MessageContext, input: AfterIngestInput, result: IngestResult): void {
    const key = result.contactKey ?? ctx.identity.from ?? ctx.identity.bsuid;
    if (!key) return; // 'no_identity': nothing was written
    if (result.outcome === 'new') {
        switch (result.queueOutcome) {
            case 'queued':
            case 'joined':
                ctx.batch.requestDrain();
                break;
            case 'manual':
                whatsappLogger.info('AI is off for this chat (manual mode): message stored without an AI reply');
                break;
            case 'already_queued':
                whatsappLogger.info('Message already queued by an earlier delivery: not queued again');
                break;
            case 'refused':
                whatsappLogger.warn(`Org inbound quota reached (${result.quotaLimit ?? '?'}/min): message stored without an AI reply`);
                break;
        }
        if (input.lateAgeMs !== null) {
            whatsappLogger.info(`Text arrived ${Math.floor(input.lateAgeMs / HOUR_MS)} h after it was sent: stored without an AI reply`);
        }
        if (result.bsuidConflict) whatsappLogger.warn('BSUID already belongs to another chat of the org: message stored, BSUID not recorded');
        if (result.rateError) whatsappLogger.error(`Rate limit check failed (${result.rateError}): message let through`);
        if (result.quotaError) whatsappLogger.error(`Org quota check failed (${result.quotaError}): message let through`);
        runInBackground('effects of a new inbound message', () => newRowEffects(ctx, input, result, key));
        return;
    }
    if (result.outcome === 'rate_limited') {
        whatsappLogger.warn(`Rate limit exceeded${ctx.storeOnly ? ' on another number of the WABA' : ''}: message not stored`);
        // Only the first refusal of the window warns and notes (D23-1).
        if (result.rateFirst) runInBackground('rate-limit warning', () => rateLimitEffects(ctx, key));
    }
}

async function newRowEffects(ctx: MessageContext, input: AfterIngestInput, result: IngestResult, key: string): Promise<void> {
    const { supabase, waCtx, storeOnly } = ctx;
    const orgId = waCtx.orgId;
    const chatKey = `${orgId}:${key}`;

    // The minute quota kept this message from the AI: tell the operators,
    // once per chat and minute, without marking the chat answered.
    if (result.queueOutcome === 'refused' && firstInboundRefusalNote(chatKey)) {
        await logSystemMessage(orgId, key, inboundQuotaNotice(result.quotaLimit ?? QUOTA_DEFAULTS.inbound_minute), { touchChat: false });
    }
    if (result.quotaFirstRefusal || result.quotaError) {
        await recordInboundQuotaAlerts(supabase, orgId, {
            limit: result.quotaLimit,
            firstRefusal: result.quotaFirstRefusal === true,
            error: result.quotaError,
        });
    }
    // A late text got no AI reply: say why, unless the chat is in manual
    // mode anyway.
    if (input.lateAgeMs !== null && result.aiEnabled !== false && firstLateNote(chatKey)) {
        await logSystemMessage(orgId, key, lateMessageNotice(input.lateAgeMs), { touchChat: false });
    }
    // A message to another number of the WABA: tell the operators, once a
    // day per chat, keeping the chat unanswered.
    if (storeOnly && firstOtherNumberNote(chatKey)) {
        await logSystemMessage(orgId, key, otherNumberNotice(storeOnly), { touchChat: false });
    }
    // Web Push to every subscribed admin device, once per message: a
    // redelivery is a 'duplicate' and never gets here. No-op without VAPID.
    try {
        await sendPushToOrg(supabase, orgId, {
            title: result.contactName || key,
            body: input.preview,
            phone: key,
            url: `/dashboard/chats?phone=${encodeURIComponent(key)}`,
        });
    } catch (pushErr) {
        whatsappLogger.error('Web push fan-out failed', pushErr);
    }
}

async function rateLimitEffects(ctx: MessageContext, key: string): Promise<void> {
    const { supabase, waCtx, storeOnly } = ctx;
    const orgId = waCtx.orgId;
    if (storeOnly) {
        // No warning from the main number for a message to another number;
        // the operators learn that messages are missing.
        if (firstOtherNumberLimitNote(`${orgId}:${key}`)) {
            await logSystemMessage(orgId, key, otherNumberLimitNotice(storeOnly), { touchChat: false });
        }
        return;
    }
    let warned = false;
    try {
        const target = await resolveSendTarget(supabase, orgId, key);
        // From the number the customer wrote to.
        await sendWhatsAppMessage(waCtx, target, RATE_LIMIT_WARNING);
        warned = true;
    } catch (error) {
        whatsappLogger.error('The rate-limit warning could not be sent', error);
        if (isWhatsAppTokenError(error)) {
            await recordOpsEvent(supabase, 'whatsapp_token_invalid', { orgId, detail: 'saat mengirim peringatan batas pesan per menit' });
        }
    }
    // The refused message was not answered: keep the chat "Belum dibalas".
    await logSystemMessage(orgId, key, warned ? RATE_LIMIT_NOTE : RATE_LIMIT_WARNING_FAILED_NOTE, { touchChat: false });
}
