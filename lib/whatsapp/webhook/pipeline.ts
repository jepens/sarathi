import { NextResponse } from 'next/server';
import { verifyWhatsAppSignature } from '@/lib/whatsapp/security';
import { envWebhookApp, resolveWhatsAppContext } from '@/lib/whatsapp/credentials';
import { whatsappLogger } from '@/lib/utils/logger';
import { webhookSummary } from '@/lib/whatsapp/webhook-summary';
import { describeErrorForOps, recordOpsEvent } from '@/lib/ops/events';
import { readBodyCapped } from '@/lib/whatsapp/webhook/verify';
import { serviceRoleClient } from '@/lib/whatsapp/webhook/service-client';
import { routeOtherNumber } from '@/lib/whatsapp/webhook/router';
import { handleUserIdUpdate } from '@/lib/whatsapp/webhook/handlers/user-id-update';
import { handleStatuses } from '@/lib/whatsapp/webhook/handlers/statuses';
import { handleInboundMessage } from '@/lib/whatsapp/webhook/handlers/messages';

// The webhook's POST, outside route.ts (Next.js limits what a route file exports): the gate, then the event's handler.

export async function processWebhook(request: Request): Promise<NextResponse> {
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

            const route = await routeOtherNumber(supabase, webhookApp, metadata);
            if (route.route === 'dropped') return new NextResponse('EVENT_RECEIVED', { status: 200 });
            // Store-only: the other number whose event is kept in the inbox (no
            // AI, no automatic send from the wrong number), else null.
            const storeOnly = route.route === 'store_only' ? route.other : null;

            // Single-tenant: org + credentials come from env; the org is read
            // strictly (a read error throws → 500, Meta retries).
            const waCtx = await resolveWhatsAppContext(supabase);
            alertOrgId = waCtx.orgId;

            // ========== HANDLE STATUS CALLBACKS ==========
            const statuses = body.entry?.[0]?.changes?.[0]?.value?.statuses;

            if (statuses && statuses.length > 0) {
                await handleStatuses(supabase, waCtx, statuses);

                // Always return 200 to Meta
                return new NextResponse('EVENT_RECEIVED', { status: 200 });
            }

            // ========== HANDLE INBOUND MESSAGES ==========
            if (change?.value?.messages?.[0]) await handleInboundMessage({ supabase, waCtx, value: change.value, storeOnly });
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
