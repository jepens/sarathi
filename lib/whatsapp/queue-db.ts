import { createClient } from '@/lib/supabase/server';
import { sendWhatsAppMessage } from './client';
import { getWhatsAppSendCreds } from './credentials';
import { generateRAGResponse } from '@/lib/ai/rag';
import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';

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
 * Add an inbound message to the queue.
 *
 * Returns the new job id, or `null` when the message was a duplicate webhook
 * delivery (Meta delivers webhooks at-least-once). We dedupe on the inbound
 * message id (wamid) via a unique index, so a redelivery can never enqueue the
 * same message twice and trigger a second reply.
 */
export async function enqueueMessage(
    orgId: string,
    phoneNumber: string,
    messageText: string,
    client?: SupabaseClient,
    waMessageId?: string | null,
): Promise<string | null> {
    try {
        const supabase = client || await createClient();

        const { data, error } = await supabase
            .from('message_queue')
            .insert({
                org_id: orgId,
                phone_number: phoneNumber,
                message_text: messageText,
                wa_message_id: waMessageId ?? null,
                status: 'pending'
            })
            .select('id')
            .single();

        if (error) {
            // 23505 = unique violation on (org_id, wa_message_id): a duplicate
            // webhook delivery. Not a failure — just skip the re-enqueue.
            if (error.code === '23505') {
                whatsappLogger.info(`Duplicate inbound message ${waMessageId} — already queued, skipping`);
                return null;
            }
            throw error;
        }

        whatsappLogger.info(`Message enqueued: ${data.id}`);
        return data.id;

    } catch (error) {
        whatsappLogger.error('Failed to enqueue message', error);
        throw error;
    }
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

/** Mark a set of queue jobs as completed in one statement. */
async function markJobsCompleted(supabase: SupabaseClient, ids: string[]): Promise<void> {
    await supabase
        .from('message_queue')
        .update({ status: 'completed', processed_at: nowIso(), updated_at: nowIso() })
        .in('id', ids);
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

    // Per-tenant send credentials (env fallback). Resolved up-front so the catch
    // block's fallback message can use them too.
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
            await markJobsCompleted(supabase, ids);
            whatsappLogger.info(`Conversation ${phoneNumber} skipped — AI disabled (manual mode)`);
            return;
        }

        // Coalesce the burst into one user turn, preserving order.
        const combinedMessage = jobs.map((j) => j.message_text).join('\n').trim();

        // Fetch recent conversation history (last 30 messages). generateRAGResponse
        // keeps the last 12 verbatim and summarises anything older, so a deeper
        // fetch here gives long WhatsApp threads real memory.
        const { data: historyData } = await supabase
            .from('whatsapp_messages')
            .select('role, content')
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber)
            .order('created_at', { ascending: false })
            .limit(30);

        // Chronological order (oldest first), conversational turns ONLY. System
        // rows (logSystemMessage writes role='system': rate-limit warnings,
        // contact-share notes, error audit) are operator text, not conversation —
        // they must never enter the model context, and if left in they would also
        // block the burst-trim below (a trailing 'system' row stops the loop, so
        // the burst would be fed to the model twice).
        const chrono = (historyData || [])
            .reverse()
            .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
            .map((msg) => ({ role: msg.role as 'user' | 'assistant', content: msg.content }));
        // The inbound burst is already stored in whatsapp_messages, so drop the
        // trailing run of UNANSWERED user messages — otherwise they'd be fed to
        // the model twice (once in history, once as combinedMessage). That
        // trailing run is exactly this burst, since the bot hasn't replied yet.
        let end = chrono.length;
        while (end > 0 && chrono[end - 1].role === 'user') end--;
        const history = chrono.slice(0, end);

        // Generate ONE AI response for the whole burst, scoped to the org.
        const aiResponse = await generateRAGResponse(combinedMessage, history, phoneNumber, { orgId });

        // Send the reply with the org's credentials.
        const sendResult = await sendWhatsAppMessage(phoneNumber, aiResponse.message, creds);

        // Mark the jobs done IMMEDIATELY after a successful send, BEFORE the
        // history writes — and guard it in its OWN try/catch. The reply is
        // already delivered, so NOTHING from here on may fall through to the
        // outer catch and re-queue the job (that would resend a duplicate). If
        // this DB write itself fails, swallow it: the rows stay 'processing' and
        // are reclaimed only after the wide stale window — not resent now.
        try {
            await markJobsCompleted(supabase, ids);
        } catch (completeErr) {
            whatsappLogger.error(`Failed to mark jobs completed after sending to ${phoneNumber} (reply already sent — NOT resending)`, completeErr);
        }

        // History writes are best-effort: log on failure, never resend.
        try {
            await supabase.from('whatsapp_chats').upsert({
                org_id: orgId,
                phone_number: phoneNumber,
                last_message: aiResponse.message,
                last_message_at: nowIso(),
                updated_at: nowIso()
            }, { onConflict: 'org_id,phone_number' });

            await supabase.from('whatsapp_messages').insert({
                org_id: orgId,
                phone_number: phoneNumber,
                role: 'assistant',
                content: aiResponse.message,
                wa_message_id: sendResult.waMessageId,
                status: 'sent',
                status_updated_at: nowIso(),
            });
        } catch (histErr) {
            whatsappLogger.error(`History write failed after sending to ${phoneNumber} (NOT resending)`, histErr);
        }

        whatsappLogger.info(`Conversation ${phoneNumber} answered (${jobs.length} message(s) coalesced)`);

    } catch (error) {
        whatsappLogger.error(`Conversation ${phoneNumber} failed`, error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        // The send failed (mark-completed runs only after a successful send), so
        // retry the whole group. Exhaust only when every job is out of budget.
        const exhausted = jobs.every((j) => j.retries + 1 >= j.max_retries);

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
            await logSystemMessage(orgId, phoneNumber, `Error: gagal memproses pesan setelah ${jobs[0].max_retries} percobaan. Penyebab: ${errorMessage}`);

            // Send a single fallback message for the whole conversation.
            try {
                await sendWhatsAppMessage(phoneNumber, 'Maaf, terjadi kesalahan saat memproses pesan Anda.', creds);
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
