import { checkRateLimit } from '@/lib/whatsapp/rate-limiter-db';
import { enqueueMessage, inboundQueueState, processQueue, getDebounceSeconds } from '@/lib/whatsapp/queue-db';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { resolveSendTarget } from '@/lib/whatsapp/recipient';
import { whatsappLogger } from '@/lib/utils/logger';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import {
    firstOtherNumberLimitNote,
    firstOtherNumberNote,
    otherNumberLimitNotice,
    otherNumberMetadata,
    otherNumberNotice,
} from '@/lib/whatsapp/other-number';
import { consumeOrgQuota, firstInboundRefusalNote, inboundQuotaNotice } from '@/lib/quota/org-quota';
import type { InboundMessageContext } from '@/lib/whatsapp/webhook/handlers/messages';

// A text message: rate limit, AI switch and org quota, then the AI queue; the chat history is stored in the background.

export async function handleTextMessage(ctx: InboundMessageContext): Promise<void> {
    const { supabase, waCtx, message, messageType, contactKey, bsuid, waId, inboundWamid, inboundContextId, storeOnly } = ctx;

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
            return;
        }
        if (!allowed) {
            whatsappLogger.warn(`Rate limit exceeded for ${contactKey}`);
            const warnTarget = await resolveSendTarget(supabase, waCtx.orgId, contactKey);
            await sendWhatsAppMessage(warnTarget, 'Mohon tunggu sebentar sebelum mengirim pesan lagi.', { phoneNumberId: waCtx.phoneNumberId, accessToken: waCtx.accessToken });
            // The dropped message was not answered: keep the chat
            // "Belum dibalas" for the operators.
            await logSystemMessage(waCtx.orgId, contactKey, 'Rate limit exceeded. User warned.', { touchChat: false });
            return;
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
        return;
    }
}
