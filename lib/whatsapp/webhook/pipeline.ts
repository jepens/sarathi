import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';
import {
    canSend,
    envWebhookApp,
    resolveWhatsAppContext,
    vaultOrgCreds,
    vaultWebhookApp,
    type WaCreds,
    type WebhookApp,
} from '@/lib/whatsapp/credentials';
import { whatsappLogger } from '@/lib/utils/logger';
import { webhookSummary } from '@/lib/whatsapp/webhook-summary';
import { describeErrorForOps, recordOpsEvent } from '@/lib/ops/events';
import { getDebounceSeconds, processQueue } from '@/lib/whatsapp/queue-db';
import { readBodyCapped, SIGNATURE_HEADER, WEBHOOK_KEY } from '@/lib/whatsapp/webhook/verify';
import { serviceRoleClient } from '@/lib/whatsapp/webhook/service-client';
import { routeChanges, type RoutedChange } from '@/lib/whatsapp/webhook/router';
import { errorCodes, isRecord, listChanges, messagesOf, statusesOf } from '@/lib/whatsapp/webhook/payload';
import { PREDEDUP_CHUNK } from '@/lib/whatsapp/webhook/limits';
import { BatchOutcome, respond } from '@/lib/whatsapp/webhook/outcome';
import { runInBackground } from '@/lib/whatsapp/webhook/background';
import type { BatchRun } from '@/lib/whatsapp/webhook/types';
import { handleUserIdUpdates } from '@/lib/whatsapp/webhook/handlers/user-id-update';
import { handleChangeStatuses } from '@/lib/whatsapp/webhook/handlers/statuses';
import { handleMessageItem, hasIdentity, planMessage, type MessagePlan } from '@/lib/whatsapp/webhook/handlers/messages';

// The webhook's POST, outside route.ts (Next.js limits what a route file
// exports): the gate, then the walk over every entry, change, message and
// status of the delivery, then one answer for the whole batch. Two gates
// share the walk: processWebhook (the bare URL, the env app) and
// processAppWebhook (a per-app URL, Vault; Fase 2 task 2.2c).

// The batch alert when the number has no usable access token, per source.
const ENV_NO_TOKEN =
    'WHATSAPP_ACCESS_TOKEN tidak diset atau tidak valid di server: pesan masuk tetap disimpan, tetapi balasan AI dan peringatan tidak terkirim';
const VAULT_NO_TOKEN =
    'token akses aplikasi ini tidak terbaca dari Vault atau tidak valid: pesan masuk tetap disimpan, tetapi balasan AI dan peringatan tidak terkirim';

export async function processWebhook(request: Request): Promise<NextResponse> {
    const startedAt = Date.now();
    // Set once the signature has passed: only then is a failure a Meta delivery
    // the team must hear about (anyone can POST junk to this URL).
    let verified = false;
    let outcome: BatchOutcome | null = null;
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
            // Without a usable number id nothing can be routed: 503 (Meta
            // retries once it is fixed) and an alert.
            if (!webhookApp.phoneNumberId) {
                const notDigits = webhookApp.phoneNumberIdProblem === 'not_digits';
                whatsappLogger.error(`Webhook cannot route: WHATSAPP_PHONE_NUMBER_ID is ${notDigits ? 'not a phone number id (digits only)' : 'not set'}`);
                await recordOpsEvent(supabase, 'webhook_unconfigured', {
                    detail: `${notDigits ? 'WHATSAPP_PHONE_NUMBER_ID bukan ID nomor (harus angka saja)' : 'WHATSAPP_PHONE_NUMBER_ID tidak diset di server'}; webhook menjawab 503, Meta mengirim ulang`,
                });
                return new NextResponse('Service Unavailable', { status: 503 });
            }
            outcome = new BatchOutcome(startedAt);
            return await walkBatch(supabase, webhookApp, body, outcome, () => resolveWhatsAppContext(supabase), ENV_NO_TOKEN);
        } else {
            // Signed by our app but not a WhatsApp Business Account event:
            // acknowledge it (a 404 would make Meta retry it for days).
            whatsappLogger.warn('Received non-WhatsApp event — acknowledged without processing');
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        }

    } catch (error) {
        // Only a bug gets here: every item has its own guard, and its failure
        // decides the answer through respond(). Meta retries the delivery.
        whatsappLogger.error('Error processing webhook', error);
        // Team alert (3.5): a webhook that keeps failing loses messages once
        // Meta gives up. Signed deliveries only.
        const alertClient = verified ? serviceRoleClient() : null;
        if (alertClient) {
            await recordOpsEvent(alertClient, 'webhook_error', { orgId: outcome?.orgId ?? null, detail: describeErrorForOps(error) });
        }
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}

/**
 * The POST of a per-app URL (Fase 2 task 2.2c): the app comes from the URL
 * key, its secret, number and token from Vault, its org from the app row
 * (never the default org). The same walk as processWebhook after the gate.
 * A suspended app or a paused number (only manual SQL sets them) is
 * acknowledged and dropped; an app without a number answers 503.
 */
export async function processAppWebhook(request: Request, key: string): Promise<NextResponse> {
    const startedAt = Date.now();
    let supabase: SupabaseClient | null = null;
    // The app's org once the signature has passed (see processWebhook).
    let verifiedOrg: string | null = null;
    let outcome: BatchOutcome | null = null;
    try {
        // No app has a key of another shape: nothing is read.
        if (!WEBHOOK_KEY.test(key)) return new NextResponse('Not Found', { status: 404 });
        const rawBody = await readBodyCapped(request);
        if (!rawBody) {
            whatsappLogger.warn('Webhook body over 3 MB — refused');
            return new NextResponse('Payload Too Large', { status: 413 });
        }
        // Meta always signs: without a well-formed header it is internet
        // noise, refused before any database call and logged only.
        const signature = request.headers.get('x-hub-signature-256');
        if (!signature || !SIGNATURE_HEADER.test(signature)) {
            whatsappLogger.warn('Rejected webhook with invalid/missing signature');
            return new NextResponse('Forbidden', { status: 403 });
        }

        supabase = serviceRoleClient();
        if (!supabase) {
            whatsappLogger.error('Webhook cannot store anything: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
            return new NextResponse('Service Unavailable', { status: 503 });
        }

        // An unknown key returns no row, so only a Vault or database failure
        // gets here: alerted, and Meta retries.
        let app;
        try {
            app = await vaultWebhookApp(supabase, key);
        } catch (error) {
            whatsappLogger.error(`Webhook app could not be read (${describeErrorForOps(error)})`);
            await recordOpsEvent(supabase, 'webhook_error', {
                detail: `aplikasi webhook tidak terbaca (${describeErrorForOps(error)}); webhook menjawab 503, Meta mengirim ulang`,
            });
            return new NextResponse('Service Unavailable', { status: 503 });
        }
        if (!app) {
            whatsappLogger.warn('Webhook for an unknown app key — not found');
            return new NextResponse('Not Found', { status: 404 });
        }

        if (!app.appSecret || !(await verifyWhatsAppSignature(rawBody, signature, app.appSecret))) {
            whatsappLogger.warn(`Rejected webhook with invalid signature (app ${app.appId})`);
            await recordOpsEvent(supabase, 'webhook_signature_invalid', {
                orgId: app.orgId,
                detail: !app.appSecret ? 'app secret aplikasi ini tidak terbaca dari Vault' : 'tanda tangan tidak cocok',
            });
            return new NextResponse('Forbidden', { status: 403 });
        }
        verifiedOrg = app.orgId;

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
        if (body.object !== 'whatsapp_business_account') {
            whatsappLogger.warn('Received non-WhatsApp event — acknowledged without processing');
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        }
        if (app.status !== 'active') {
            whatsappLogger.warn(`Webhook for suspended app ${app.appId} — dropped`);
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        }

        let number;
        try {
            number = await vaultOrgCreds(supabase, app.orgId);
        } catch (error) {
            whatsappLogger.error(`Webhook number could not be read (app ${app.appId}, ${describeErrorForOps(error)})`);
            await recordOpsEvent(supabase, 'webhook_error', {
                orgId: app.orgId,
                detail: `nomor WhatsApp tidak terbaca (${describeErrorForOps(error)}); webhook menjawab 503, Meta mengirim ulang`,
            });
            return new NextResponse('Service Unavailable', { status: 503 });
        }
        if (!number) {
            whatsappLogger.error(`Webhook cannot route: app ${app.appId} has no number`);
            await recordOpsEvent(supabase, 'webhook_unconfigured', {
                orgId: app.orgId,
                detail: 'aplikasi tanpa nomor di Sarathi; webhook menjawab 503, Meta mengirim ulang',
            });
            return new NextResponse('Service Unavailable', { status: 503 });
        }
        if (number.status !== 'active') {
            whatsappLogger.warn(`Webhook for a paused number (app ${app.appId}) — dropped`);
            return new NextResponse('EVENT_RECEIVED', { status: 200 });
        }

        // What arrived, never the payload itself (see processWebhook).
        whatsappLogger.info(`Webhook received (app ${app.appId}): ${webhookSummary(body)}`);
        outcome = new BatchOutcome(startedAt);
        outcome.orgId = app.orgId;
        const creds = number.creds;
        return await walkBatch(
            supabase,
            { appSecret: app.appSecret, phoneNumberId: creds.phoneNumberId },
            body,
            outcome,
            () => Promise.resolve(creds),
            VAULT_NO_TOKEN,
        );
    } catch (error) {
        // Only a bug gets here (see processWebhook). Signed deliveries only.
        whatsappLogger.error('Error processing webhook', error);
        if (supabase && verifiedOrg) {
            await recordOpsEvent(supabase, 'webhook_error', { orgId: outcome?.orgId ?? verifiedOrg, detail: describeErrorForOps(error) });
        }
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}

/** A change whose messages and statuses are handled: the main number's, or another's in process mode. */
const isRouted = (c: RoutedChange) => c.route.route === 'main' || c.route.route === 'store_only';

/**
 * The keys of the batch's messages that are already stored in the org (any
 * role: a contact card's note counts), one query per PREDEDUP_CHUNK keys.
 * They are skipped without any side effect, so a resend of a batch Meta got a
 * 503 for redoes only what failed. A failing query is ignored: the database
 * function's own redelivery gate decides then.
 */
async function storedKeys(run: BatchRun, plans: MessagePlan[]): Promise<Set<string>> {
    const found = new Set<string>();
    const keys = [...new Set(plans.filter((p) => p.stores && hasIdentity(p)).map((p) => p.key))];
    if (keys.length === 0) return found;
    let orgId: string;
    try {
        orgId = (await run.org()).orgId;
    } catch {
        return found; // every message reports the org error itself
    }
    const signal = run.outcome.signal();
    for (let i = 0; i < keys.length; i += PREDEDUP_CHUNK) {
        try {
            const { data, error } = await run.supabase
                .from('whatsapp_messages')
                .select('wa_message_id')
                .eq('org_id', orgId)
                .abortSignal(signal)
                .in('wa_message_id', keys.slice(i, i + PREDEDUP_CHUNK));
            if (error) throw error;
            for (const row of Array.isArray(data) ? data : []) {
                if (isRecord(row) && typeof row.wa_message_id === 'string') found.add(row.wa_message_id);
            }
        } catch (error) {
            whatsappLogger.warn(`Webhook pre-dedup query failed (${describeErrorForOps(error)}) — the ingest gate decides`);
        }
    }
    return found;
}

/** Drains the queue now and once more after the debounce window: once per batch. */
function drainQueue(supabase: SupabaseClient): void {
    // A no-op for the conversations of this batch (coalescing waits for the
    // burst to settle), but it answers the ones that have settled.
    runInBackground('queue drain', () => processQueue(supabase));
    // This batch's conversations are answered ~debounce seconds after the
    // customer's last message. Works on the persistent server; the
    // per-minute cron is the backstop if the timer is lost on a restart.
    const delayMs = (getDebounceSeconds() + 5) * 1000;
    setTimeout(() => {
        runInBackground('delayed queue drain', () => processQueue(supabase));
    }, delayMs);
}

/**
 * The walk over one delivery (Fase 2 task 2.2a part 2): route every change,
 * then pass 1 (user_id_update entries), the pre-dedup, pass 2 (messages, in
 * Meta's time order) and pass 3 (statuses, one call per change). Each item
 * has its own guard, so one failure never stops the others; respond() turns
 * the result into the answer. `resolveOrg` gives the org and credentials of
 * the number the delivery arrived on; `noTokenDetail` is the alert when that
 * number has no usable access token.
 */
async function walkBatch(
    supabase: SupabaseClient,
    webhookApp: WebhookApp,
    body: unknown,
    outcome: BatchOutcome,
    resolveOrg: () => Promise<WaCreds>,
    noTokenDetail: string,
): Promise<NextResponse> {
    const changes = await routeChanges(supabase, webhookApp, listChanges(body));

    // The org and credentials, read once, when an item first needs them (the
    // bare URL: env and the default org, read strictly, never the seed org;
    // a per-app URL: already read from Vault). A read error makes each item
    // that needs it retryable (503).
    let orgRead: Promise<WaCreds> | null = null;
    const run: BatchRun = {
        supabase,
        outcome,
        org: () =>
            (orgRead ??= resolveOrg().then((ctx) => {
                outcome.orgId = ctx.orgId;
                return ctx;
            })),
        requestDrain: () => {
            outcome.drain = true;
        },
        heldBsuids: new Set<string>(),
    };

    const routed = changes.filter(isRouted);
    for (const change of routed) {
        if (!isRecord(change.value)) {
            // A 'messages' change whose value is not an object: nothing in it
            // can be read, now or on a retry.
            outcome.items += 1;
            outcome.done('skipped');
            await recordOpsEvent(supabase, 'webhook_payload_invalid', { detail: 'perubahan "messages" tanpa isi terbaca; dilewati' });
            continue;
        }
        const codes = errorCodes(change.value);
        if (codes.length > 0) whatsappLogger.warn(`Webhook change carries Meta errors: ${codes.join(',')}`);
    }

    // Storing works without the access token, sending (AI replies, the
    // rate-limit warning, Flow confirmations) does not: say so once.
    if (routed.some((c) => messagesOf(c.value).length + statusesOf(c.value).length > 0)) {
        try {
            const ctx = await run.org();
            if (!canSend(ctx)) {
                await recordOpsEvent(supabase, 'webhook_unconfigured', { orgId: ctx.orgId, detail: noTokenDetail });
            }
        } catch {
            // Every item that needs the org reports the read error itself.
        }
    }

    // Pass 1: BSUID moves first, so a message with the new id finds its chat.
    await handleUserIdUpdates(run, changes.filter((c) => c.route.route === 'user_id_update').map((c) => c.value));

    // Pass 2: the messages of every routed change, oldest first by Meta's
    // time (payload order on ties; no time sorts as now).
    const now = Date.now();
    const plans = routed
        .flatMap((change) => {
            const storeOnly = change.route.route === 'store_only' ? change.route.other : null;
            return messagesOf(change.value).map((m) => planMessage(m, change.value, storeOnly, now));
        })
        .map((plan, position) => ({ plan, position, at: plan.waTs?.getTime() ?? now }))
        .sort((a, b) => a.at - b.at || a.position - b.position)
        .map(({ plan }) => plan);
    outcome.items += plans.length;
    const stored = await storedKeys(run, plans);
    for (const plan of plans) await handleMessageItem(run, plan, stored);

    // Pass 3: statuses, one call per change (they only move forward, so
    // their order does not matter).
    for (const change of routed) await handleChangeStatuses(run, statusesOf(change.value));

    if (outcome.drain) drainQueue(supabase);
    return respond(supabase, outcome);
}
