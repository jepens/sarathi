import { NextResponse } from 'next/server';
import {
    listApprovedTemplates,
    sendTemplateMessage,
    renderTemplateBody,
    extractBodyVariableIndices,
} from '@/lib/whatsapp/templates';
import { describeWhatsAppError, type WhatsAppApiError } from '@/lib/whatsapp/client';
import { whatsappLogger } from '@/lib/utils/logger';
import { accessDeniedResponse } from '@/lib/settings/org-context';
import { requireWhatsAppIntegration } from '@/lib/whatsapp/integration';

// POST /api/chat/send-template
// Body: { phone_number, template_name, language, variables?: string[] }
//
// Used to re-engage customers who haven't messaged in >24h (Meta code 131047).
// Verifies the template exists & is APPROVED, ensures variable count matches,
// sends via Meta, persists with status='sent' + wa_message_id so the existing
// status-callback handler can flip it to delivered/read/failed.

export const runtime = 'nodejs';

interface SendTemplateBody {
    phone_number?: unknown;
    template_name?: unknown;
    language?: unknown;
    variables?: unknown;
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export async function POST(request: Request) {
    // Explicit org for the composite (org_id, phone_number) key — see
    // send/route.ts. The org's own WhatsApp credentials; checked before the
    // template lookup + send hit Meta.
    const access = await requireWhatsAppIntegration();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase, orgId, creds } = access;

    let body: SendTemplateBody;
    try {
        body = (await request.json()) as SendTemplateBody;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const phoneNumber = typeof body.phone_number === 'string' ? body.phone_number.trim() : '';
    const templateName = typeof body.template_name === 'string' ? body.template_name.trim() : '';
    const language = typeof body.language === 'string' ? body.language.trim() : '';
    const variables: string[] = isStringArray(body.variables) ? body.variables : [];

    if (!phoneNumber || !templateName || !language) {
        return NextResponse.json(
            { error: 'phone_number, template_name, and language are required' },
            { status: 400 }
        );
    }

    try {
        // Verify the template is still APPROVED and resolve its body for
        // local storage. Refetching here is the safest path — admin might
        // have deleted/paused the template since the dialog opened.
        const templates = await listApprovedTemplates(creds);
        const template = templates.find(
            (t) => t.name === templateName && t.language === language
        );
        if (!template) {
            return NextResponse.json(
                {
                    error: `Template "${templateName}" (${language}) not found or not approved`,
                },
                { status: 404 }
            );
        }

        const expectedVarCount = extractBodyVariableIndices(template).length;
        if (variables.length !== expectedVarCount) {
            return NextResponse.json(
                {
                    error: `Template "${templateName}" needs ${expectedVarCount} variable(s), received ${variables.length}`,
                },
                { status: 400 }
            );
        }

        // Send via Meta. Throws WhatsAppApiError on Meta rejection.
        const sendResult = await sendTemplateMessage(creds, {
            to: phoneNumber,
            templateName,
            language,
            variables,
        });

        // Render the body so the local chat shows the same text the customer
        // sees. For templates without a BODY component this is just an empty
        // string — store a sentinel so the UI doesn't show a blank bubble.
        const renderedBody = renderTemplateBody(template, variables)
            || `[template: ${templateName}]`;

        // Mirror the chat-send flow: upsert chat summary + insert message row
        // with wa_message_id + status='sent' so the existing status-callback
        // handler can flip it to delivered/read/failed.
        const nowIso = new Date().toISOString();

        const { error: chatError } = await supabase
            .from('whatsapp_chats')
            .upsert(
                {
                    org_id: orgId,
                    phone_number: phoneNumber,
                    last_message: renderedBody,
                    last_message_at: nowIso,
                    updated_at: nowIso,
                },
                { onConflict: 'org_id,phone_number' }
            );
        if (chatError) throw chatError;

        const { error: msgError } = await supabase
            .from('whatsapp_messages')
            .insert({
                org_id: orgId,
                phone_number: phoneNumber,
                role: 'assistant',
                content: renderedBody,
                wa_message_id: sendResult.waMessageId,
                status: 'sent',
                status_updated_at: nowIso,
            });
        if (msgError) throw msgError;

        whatsappLogger.info(
            `Admin sent template "${templateName}" (${language}) to ${phoneNumber}`
        );
        return NextResponse.json({
            success: true,
            wa_message_id: sendResult.waMessageId,
            preview: renderedBody,
        });
    } catch (error) {
        whatsappLogger.error('Error sending template message', error);

        const apiErr = error as WhatsAppApiError;
        if (typeof apiErr.code === 'number') {
            return NextResponse.json(
                {
                    error: describeWhatsAppError(apiErr),
                    code: apiErr.code,
                    subcode: apiErr.subcode,
                    fbtrace_id: apiErr.fbtraceId,
                },
                { status: 502 }
            );
        }
        const msg = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
