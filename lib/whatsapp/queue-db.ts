import { createClient } from '@/lib/supabase/server';
import { sendWhatsAppMessage } from './client';
import { resolveSendTarget } from './recipient';
import { getWhatsAppSendCreds } from './credentials';
import { generateRAGResponse } from '@/lib/ai/rag';
import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { describeErrorForOps, isWhatsAppTokenError, recordOpsEvent } from '@/lib/ops/events';
import { consumeOrgQuota } from '@/lib/quota/org-quota';
import { isOtherNumberRow } from '@/lib/whatsapp/other-number';

import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase-based message queue
 * Works across multiple instances
 */

export interface QueueJob {
    id: string;
    org_id: string;
    phone_number: string;
    message_text: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    retries: number;
    max_retries: number;
    error_message?: string;
    wa_message_id?: string | null;
    /** Counted against the org's daily AI quota already (tracker 3.4, 0071). */
    ai_quota_counted?: boolean;
    created_at: string;
}

// Debounce window: how long to wait for the customer to finish a burst of
// messages before the bot answers. Humans fire several short WhatsApp messages
// in a row; without this, each fragment triggers its own AI reply (the
// "double chat" bug). Configurable via env (default 60s), clamped so a typo
// can't set it to hours or to a negative value.
export function getDebounceSeconds(): number {
    const raw = Number.parseInt(process.env.WHATSAPP_DEBOUNCE_SECONDS ?? '', 10);
    if (!Number.isFinite(raw)) return 60;
    return Math.min(Math.max(raw, 0), 300);
}

const nowIso = (): string => new Date().toISOString();

/**
 * Whether a stored whatsapp_messages row is a placeholder the webhook wrote
 * for a message it could not process (metadata.unprocessable = its type).
 */
function isUnprocessableRow(metadata: unknown): boolean {
    return (
        metadata !== null &&
        typeof metadata === 'object' &&
        (metadata as Record<string, unknown>).unprocessable !== undefined &&
        (metadata as Record<string, unknown>).unprocessable !== null
    );
}

// Operator-facing note logged when a handoff switches the chat to manual mode.
export const HANDOFF_MANUAL_MODE_NOTICE =
    'Handoff ke tim: balasan otomatis AI dimatikan untuk chat ini. Balas customer secara manual, atau nyalakan lagi lewat switch "AI aktif".';

// Operator-facing note logged when the org's daily AI quota stops a reply.
export function aiQuotaReachedNotice(limit: number): string {
    return `Batas ${limit} balasan AI per hari untuk organisasi ini sudah tercapai, jadi pesan ini tidak dibalas AI. Balas customer secara manual; AI membalas lagi mulai pukul 00.00 WIB.`;
}

/**
 * Process pending messages.
 *
 * Claims SETTLED conversations (debounced — see claim_queue_jobs), then
 * coalesces each conversation's queued messages into a single AI turn so a
 * burst of customer messages gets exactly one reply. Call from the inline
 * webhook drainer and/or a cron worker.
 */
export async function processQueue(client?: SupabaseClient): Promise<void> {
    try {
        // Use provided client, or create one with Service Role if available (for cron jobs), or fall back to standard createClient
        let supabase = client;
        if (!supabase) {
            if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
                const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
                supabase = createSupabaseClient(
                    process.env.NEXT_PUBLIC_SUPABASE_URL!,
                    process.env.SUPABASE_SERVICE_ROLE_KEY
                );
            } else {
                supabase = await createClient();
            }
        }

        // Atomically claim settled conversations. claim_queue_jobs also reclaims
        // jobs stranded in 'processing' by a crashed worker, and only releases a
        // conversation once its burst has settled (no new message within the
        // debounce window). Concurrent drainers (inline webhook + cron) take
        // disjoint conversations — a customer never gets a double reply.
        // p_stale_seconds is deliberately well above the worst-case job latency
        // (AI generation + send). A merely SLOW job must not be reclaimed
        // mid-flight by a concurrent drainer — that would re-answer a burst whose
        // reply is already on its way. Reclaim only exists to recover genuinely
        // crashed workers (rare), so a long window is the safe trade.
        const { data: jobs, error } = await supabase.rpc('claim_queue_jobs', {
            p_limit: 10,
            p_stale_seconds: 600,
            p_debounce_seconds: getDebounceSeconds(),
        });

        if (error) throw error;
        if (!jobs || jobs.length === 0) return;

        // Group the claimed rows by conversation so a burst becomes ONE reply.
        const groups = new Map<string, QueueJob[]>();
        for (const job of jobs as QueueJob[]) {
            const key = `${job.org_id}::${job.phone_number}`;
            const bucket = groups.get(key);
            if (bucket) bucket.push(job);
            else groups.set(key, [job]);
        }

        whatsappLogger.info(`Processing ${jobs.length} message(s) across ${groups.size} conversation(s)`);

        for (const group of groups.values()) {
            // Stable chronological order so the coalesced turn reads correctly.
            // Tie-break on id so same-millisecond messages keep a deterministic
            // order instead of reshuffling between runs.
            group.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
            await processConversation(group, supabase);
        }

    } catch (error) {
        whatsappLogger.error('Queue processing error', error);
    }
}

/**
 * Mark a set of queue jobs as completed in one statement. `note` (kept in
 * error_message) says why jobs were closed without a reply.
 */
async function markJobsCompleted(supabase: SupabaseClient, ids: string[], note?: string): Promise<unknown> {
    const { error } = await supabase
        .from('message_queue')
        .update({ status: 'completed', processed_at: nowIso(), updated_at: nowIso(), ...(note ? { error_message: note } : {}) })
        .in('id', ids);
    return error ?? null;
}

/**
 * Process all queued messages for ONE conversation as a single AI turn.
 *
 * `jobs` are the pending rows for one (org_id, phone_number), already sorted by
 * created_at. They are coalesced into one prompt and answered with one message.
 */
async function processConversation(jobs: QueueJob[], supabase: SupabaseClient): Promise<void> {
    const { org_id: orgId, phone_number: phoneNumber } = jobs[0];
    const ids = jobs.map((j) => j.id);

    // Send credentials: the env credentials of the default org until Fase 2
    // task 2.2b threads each org's own. Resolved up-front so the catch block's
    // fallback message can use them too.
    const creds = await getWhatsAppSendCreds();
    try {
        whatsappLogger.info(`Processing ${jobs.length} message(s) for ${phoneNumber}`);

        // Respect the per-chat AI switch. The webhook already skips enqueue when
        // ai_enabled = false, but re-check here so ANY processQueue trigger
        // (incl. the /api/queue/process drainer) honours a takeover that
        // happened between enqueue and processing.
        const { data: chatRow } = await supabase
            .from('whatsapp_chats')
            .select('ai_enabled')
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber)
            .maybeSingle();
        if (chatRow?.ai_enabled === false) {
            const closeError = await markJobsCompleted(supabase, ids);
            if (closeError) whatsappLogger.error(`Closing the jobs of ${phoneNumber} in manual mode failed`, closeError);
            whatsappLogger.info(`Conversation ${phoneNumber} skipped — AI disabled (manual mode)`);
            return;
        }

        // Org quota (tracker 3.4, migration 0071): at most N AI replies a day
        // per org, 00:00 to 00:00 WIB. A burst is counted when it holds a job
        // not counted before (message_queue.ai_quota_counted): its first
        // attempt, a message that joined it after a failure, or a burst a
        // crashed worker claimed but never counted. A plain retry of a counted
        // burst is not counted again, so an outage does not use up the day's
        // quota (one unit can then cost up to max_retries model calls). Over the
        // limit the burst gets no AI reply (hard stop, owner decision
        // 2026-10-18): the jobs are closed with the reason, the chat shows a note
        // for the operators, and the team is alerted on the first refusal after
        // a call that was let through (once a day, and again when a raised limit
        // is reached).
        const uncounted = jobs.filter((j) => !j.ai_quota_counted);
        const quota = uncounted.length > 0 ? await consumeOrgQuota(supabase, orgId, 'ai_reply_day') : null;
        if (quota && !quota.allowed) {
            const closeError = await markJobsCompleted(supabase, ids, 'quota: ai_reply_day');
            if (closeError) whatsappLogger.error(`Closing the jobs of ${phoneNumber} over the daily AI quota failed`, closeError);
            // The customer still needs a reply: the note must not mark the chat answered.
            await logSystemMessage(orgId, phoneNumber, aiQuotaReachedNotice(quota.limit), { touchChat: false });
            whatsappLogger.warn(`Conversation ${phoneNumber} not answered — daily AI quota of the org reached (${quota.limit})`);
            return;
        }
        if (quota) {
            // Counted: a retry, a reclaim or a later burst with these jobs does
            // not count them again. Best-effort: a failure only means they may
            // be counted once more.
            const { error: countedError } = await supabase
                .from('message_queue')
                .update({ ai_quota_counted: true })
                .in('id', uncounted.map((j) => j.id));
            if (countedError) whatsappLogger.error(`Marking the jobs of ${phoneNumber} as counted failed`, countedError);
        }

        // Coalesce the burst into one user turn, preserving order.
        const combinedMessage = jobs.map((j) => j.message_text).join('\n').trim();

        // Fetch recent conversation history (last 30 messages). generateRAGResponse
        // keeps the last 12 verbatim and summarises anything older, so a deeper
        // fetch here gives long WhatsApp threads real memory.
        const { data: historyData } = await supabase
            .from('whatsapp_messages')
            .select('role, content, wa_message_id, metadata')
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber)
            // Not messages to another number of the WABA, nor placeholders of
            // messages the webhook could not process (below), so they do not
            // take the 30 places either.
            .is('metadata->>other_number', null)
            .is('metadata->>unprocessable', null)
            .order('created_at', { ascending: false })
            .limit(30);

        // Chronological order (oldest first), conversational turns ONLY. System
        // rows (logSystemMessage writes role='system': rate-limit warnings,
        // contact-share notes, error audit) are operator text, not conversation —
        // they must never enter the model context, and if left in they would also
        // block the burst-trim below (a trailing 'system' row stops the loop, so
        // the burst would be fed to the model twice).
        // Empty rows (a photo or voice note without a caption) carry nothing for
        // the model and are skipped, and so are messages the customer sent to
        // another number of the WABA (kept for the operators by
        // WHATSAPP_OTHER_NUMBER_EVENTS=process): not this number's conversation;
        // and placeholders the webhook stored for a message it could not
        // process (metadata.unprocessable): a note for the operators, not
        // something the customer wrote.
        const chrono = ((historyData || []) as { role: string; content: string; wa_message_id: string | null; metadata?: unknown }[])
            .reverse()
            .filter(
                (msg) =>
                    (msg.role === 'user' || msg.role === 'assistant') &&
                    !!msg.content?.trim() &&
                    !isOtherNumberRow(msg.metadata) &&
                    !isUnprocessableRow(msg.metadata),
            );
        // The inbound burst is already stored in whatsapp_messages and is fed
        // to the model as combinedMessage, so it must not be in the history
        // too. When every job knows its wamid, drop exactly those rows and cut
        // the history at the first customer message after them (a later turn:
        // the next burst, and any reply to it): an earlier unanswered message
        // (one the org's minute quota kept from the AI, tracker 3.4, or one sent
        // in manual mode) stays in as context, and so does a reply stored after
        // the burst but before that next turn (an operator answering from the
        // dashboard meanwhile, or the AI's reply to the previous burst), so the
        // AI sees it. It does come before the burst in the prompt, the only
        // place generateRAGResponse takes it. Otherwise drop the trailing run
        // of UNANSWERED user messages, which is this burst, since the bot
        // hasn't replied yet.
        const burstWamids = new Set(jobs.map((j) => j.wa_message_id).filter((w): w is string => !!w));
        const inBurst = (msg: { role: string; wa_message_id: string | null }) =>
            msg.role === 'user' && !!msg.wa_message_id && burstWamids.has(msg.wa_message_id);
        let kept = chrono;
        if (burstWamids.size === jobs.length) {
            let last = -1;
            chrono.forEach((msg, i) => {
                if (inBurst(msg)) last = i;
            });
            const nextTurn = last >= 0 ? chrono.findIndex((msg, i) => i > last && msg.role === 'user') : -1;
            kept = (nextTurn >= 0 ? chrono.slice(0, nextTurn) : chrono).filter((msg) => !inBurst(msg));
        } else {
            let end = chrono.length;
            while (end > 0 && chrono[end - 1].role === 'user') end--;
            kept = chrono.slice(0, end);
        }
        const history = kept.map((msg) => ({ role: msg.role as 'user' | 'assistant', content: msg.content }));

        // Generate ONE AI response for the whole burst, scoped to the org.
        const aiResponse = await generateRAGResponse(combinedMessage, history, phoneNumber, { orgId });

        // Resolve who to SEND to: a recovered real phone (verified_phone) when we
        // have one, else the CRM key itself (a phone, or a BSUID the send layer
        // routes via `recipient`). phoneNumber stays the CRM key for all writes.
        const sendTarget = await resolveSendTarget(supabase, orgId, phoneNumber);

        // Send the reply with the org's credentials.
        const sendResult = await sendWhatsAppMessage(sendTarget, aiResponse.message, creds);

        // Mark the jobs done IMMEDIATELY after a successful send, BEFORE the
        // history writes — and guard it in its OWN try/catch. The reply is
        // already delivered, so NOTHING from here on may fall through to the
        // outer catch and re-queue the job (that would resend a duplicate). If
        // this DB write itself fails, log and swallow it: the rows stay
        // 'processing' and are reclaimed only after the wide stale window — not
        // resent now, but then answered a second time (supabase-js returns the
        // error rather than throwing it).
        const completeFailed = `Failed to mark jobs completed after sending to ${phoneNumber}: reply already sent and not resent now, but the stale-job reclaim (~10 min) answers this burst again, or fails it if this was its last attempt`;
        try {
            const completeError = await markJobsCompleted(supabase, ids);
            if (completeError) whatsappLogger.error(completeFailed, completeError);
        } catch (completeErr) {
            whatsappLogger.error(completeFailed, completeErr);
        }

        // History writes are best-effort: log on failure (returned or
        // thrown), never resend.
        try {
            const { error: chatErr } = await supabase.from('whatsapp_chats').upsert({
                org_id: orgId,
                phone_number: phoneNumber,
                last_message: aiResponse.message,
                last_message_at: nowIso(),
                updated_at: nowIso()
            }, { onConflict: 'org_id,phone_number' });
            if (chatErr) whatsappLogger.error(`Chat summary write failed after sending to ${phoneNumber} (NOT resending)`, chatErr);

            const { error: replyErr } = await supabase.from('whatsapp_messages').insert({
                org_id: orgId,
                phone_number: phoneNumber,
                role: 'assistant',
                content: aiResponse.message,
                wa_message_id: sendResult.waMessageId,
                status: 'sent',
                status_updated_at: nowIso(),
            });
            if (replyErr) whatsappLogger.error(`Reply history write failed after sending to ${phoneNumber} (NOT resending)`, replyErr);
        } catch (histErr) {
            whatsappLogger.error(`History write failed after sending to ${phoneNumber} (NOT resending)`, histErr);
        }

        // Handoff: switch the AI off for this chat only NOW, after the handoff
        // reply was delivered. Doing it inside the tool (before the reply was
        // sent) would make a retry hit the ai_enabled=false skip above and leave
        // the customer with no answer. Best-effort like the history writes —
        // never resend. The system message tells operators the chat is now in
        // manual mode (it shows in the chat thread and the chat list).
        if (aiResponse.disableAi) {
            try {
                const { error: offErr } = await supabase
                    .from('whatsapp_chats')
                    .update({ ai_enabled: false, updated_at: nowIso() })
                    .eq('org_id', orgId)
                    .eq('phone_number', phoneNumber);
                if (offErr) throw offErr;
                await logSystemMessage(orgId, phoneNumber, HANDOFF_MANUAL_MODE_NOTICE);
            } catch (offErr) {
                whatsappLogger.error(`Failed to switch AI off after handoff for ${phoneNumber} (reply already sent)`, offErr);
            }
        }

        whatsappLogger.info(`Conversation ${phoneNumber} answered (${jobs.length} message(s) coalesced)`);

    } catch (error) {
        whatsappLogger.error(`Conversation ${phoneNumber} failed`, error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        // Team alert (3.5): an invalid or expired token stops every reply.
        if (isWhatsAppTokenError(error)) {
            await recordOpsEvent(supabase, 'whatsapp_token_invalid', { orgId, detail: 'saat membalas dari antrean' });
        }
        // The send failed (mark-completed runs only after a successful send), so
        // retry the whole group, until its oldest job is out of budget: messages
        // that keep joining a failing burst must not keep it retrying (and
        // unreported) forever.
        const exhausted = jobs.some((j) => j.retries + 1 >= j.max_retries);

        if (exhausted) {
            await supabase
                .from('message_queue')
                .update({
                    status: 'failed',
                    error_message: errorMessage,
                    processed_at: nowIso(),
                    updated_at: nowIso()
                })
                .in('id', ids);

            whatsappLogger.error(`Conversation ${phoneNumber} permanently failed after ${jobs[0].max_retries} retries`);
            await recordOpsEvent(supabase, 'queue_job_failed', {
                orgId,
                detail: `${jobs.length} pesan, ${jobs[0].max_retries} percobaan: ${describeErrorForOps(error)}`,
            });
            // The customer's message still needs a human reply (only an apology
            // goes out): the note must not mark the chat answered.
            await logSystemMessage(
                orgId,
                phoneNumber,
                `Error: gagal memproses pesan setelah ${jobs[0].max_retries} percobaan. Penyebab: ${errorMessage}`,
                { touchChat: false },
            );

            // Send a single fallback message for the whole conversation.
            try {
                const fallbackTarget = await resolveSendTarget(supabase, orgId, phoneNumber);
                await sendWhatsAppMessage(fallbackTarget, 'Maaf, terjadi kesalahan saat memproses pesan Anda.', creds);
            } catch (fallbackError) {
                whatsappLogger.error('Failed to send fallback message', fallbackError);
            }
        } else {
            // Re-queue the whole group for another attempt (each job keeps its
            // original created_at, so it settles immediately on the next claim).
            for (const j of jobs) {
                await supabase
                    .from('message_queue')
                    .update({
                        status: 'pending',
                        retries: j.retries + 1,
                        error_message: errorMessage,
                        updated_at: nowIso()
                    })
                    .eq('id', j.id);
            }
            whatsappLogger.info(`Conversation ${phoneNumber} re-queued (retry)`);
        }
    }
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
    try {
        const supabase = await createClient();

        const { data, error } = await supabase
            .from('message_queue')
            .select('status')
            .in('status', ['pending', 'processing']);

        if (error) throw error;

        const pending = data?.filter(j => j.status === 'pending').length || 0;
        const processing = data?.filter(j => j.status === 'processing').length || 0;

        return {
            pending,
            processing,
            total: pending + processing
        };

    } catch (error) {
        whatsappLogger.error('Failed to get queue stats', error);
        return { pending: 0, processing: 0, total: 0 };
    }
}
