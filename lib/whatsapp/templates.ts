import { makeWhatsAppApiError } from '@/lib/whatsapp/client';
import type { SendWhatsAppResult } from '@/lib/whatsapp/client';
import { buildRecipient } from '@/lib/whatsapp/recipient';
import { graphUrl } from '@/lib/whatsapp/graph';
import { assertCanSend, type WaCreds } from '@/lib/whatsapp/wa-creds';

// ---------------------------------------------------------------------------
// Template message support — for re-engagement OUTSIDE the 24-hour customer
// service window (Meta error code 131047).
//
// Meta only allows pre-approved templates to start a new conversation. The
// template gets reviewed by Meta and assigned a category (UTILITY,
// MARKETING, AUTHENTICATION). Once APPROVED we can send it with variable
// substitution.
//
// API surface (each takes the credentials of the org's number, WaCreds; the
// WABA is creds.wabaId):
//   listApprovedTemplates() → fetch APPROVED templates from the WABA
//   sendTemplateMessage()   → render & send to a recipient
//
// MVP scope: BODY components with positional `{{1}}, {{2}}, ...` text params
// only. Header media + dynamic button URLs are not handled in v1; most
// re-engagement templates are body-only.
// ---------------------------------------------------------------------------

export interface TemplateComponent {
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
    text?: string;                                  // BODY/HEADER/FOOTER text (may contain {{1}}, {{2}}, ...)
    format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
}

export interface WhatsAppTemplate {
    id: string;
    name: string;
    language: string;       // e.g. 'id', 'en_US'
    category: string;       // UTILITY | MARKETING | AUTHENTICATION
    status: string;         // APPROVED | PENDING | REJECTED | ...
    components: TemplateComponent[];
}

interface TemplateListResponse {
    data: WhatsAppTemplate[];
    paging?: { next?: string; previous?: string };
}

/** The WABA of the credentials; throws when it is not configured. */
function requireWaba(creds: WaCreds): string {
    assertCanSend(creds);
    if (!creds.wabaId) {
        throw new Error('WhatsApp Business Account ID not configured for this org');
    }
    return creds.wabaId;
}

/**
 * Fetch APPROVED message templates for the WABA. Filters server-side via
 * `?status=APPROVED` and paginates up to `limit` (default 100; Meta caps).
 */
export async function listApprovedTemplates(creds: WaCreds, limit = 100): Promise<WhatsAppTemplate[]> {
    const wabaId = requireWaba(creds);

    const url = graphUrl(`${wabaId}/message_templates?status=APPROVED&limit=${limit}`, creds.graphVersion);
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${creds.accessToken}`,
        },
        // Templates change rarely; let Next.js dedupe within a request but
        // don't aggressively cache across requests (admins update templates
        // and expect freshness).
        cache: 'no-store',
    });

    if (!response.ok) {
        let errorPayload: unknown = null;
        try {
            errorPayload = await response.json();
        } catch {
            errorPayload = { error: { message: response.statusText } };
        }
        console.error('Error listing templates:', JSON.stringify(errorPayload, null, 2));
        throw makeWhatsAppApiError(errorPayload, response.status);
    }

    const json = (await response.json()) as TemplateListResponse;
    return Array.isArray(json.data) ? json.data : [];
}

/**
 * Fetch ONE template by exact name + language from the WABA. Used to detect
 * FLOW buttons before sending: Meta requires templates that carry a Flow
 * button to be sent WITH a `button` component (sub_type "flow"), otherwise
 * the send fails with 131009 "Components sub_type invalid" (from Graph v23.0
 * template parameter errors may come back as 132018 instead).
 * Returns null when not found or on any error (caller falls back gracefully).
 */
async function getTemplateDefinition(
    creds: WaCreds,
    name: string,
    language: string,
): Promise<WhatsAppTemplate | null> {
    try {
        const wabaId = requireWaba(creds);
        const url = graphUrl(`${wabaId}/message_templates?name=${encodeURIComponent(name)}&limit=25`, creds.graphVersion);
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${creds.accessToken}` },
            cache: 'no-store',
        });
        if (!response.ok) return null;
        const json = (await response.json()) as TemplateListResponse;
        const list = Array.isArray(json.data) ? json.data : [];
        // The name filter is a prefix match on Meta's side — require exact.
        return list.find((t) => t.name === name && t.language === language) ?? null;
    } catch {
        return null;
    }
}

/**
 * Build `button` components for a template's FLOW buttons. Meta indexes
 * buttons by their position in the template's BUTTONS component; URL/phone/
 * quick-reply buttons without dynamic params need no component, but every
 * FLOW button must be present with sub_type "flow" and an `action` parameter.
 * flow_token is echoed back verbatim inside the customer's nfm_reply, so a
 * per-send token doubles as a correlation id in the webhook.
 */
function buildFlowButtonComponents(template: WhatsAppTemplate): Array<Record<string, unknown>> {
    const buttonsComp = template.components.find((c) => c.type === 'BUTTONS');
    const buttons = buttonsComp?.buttons ?? [];
    const components: Array<Record<string, unknown>> = [];
    buttons.forEach((btn, index) => {
        if ((btn.type ?? '').toUpperCase() !== 'FLOW') return;
        const flowToken = `tpl_${template.name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        components.push({
            type: 'button',
            sub_type: 'flow',
            index: String(index),
            parameters: [
                { type: 'action', action: { flow_token: flowToken } },
            ],
        });
    });
    return components;
}

// Variable extraction. Matches Meta's positional placeholder syntax
// `{{1}}, {{2}}, ...` (we don't support named params in v1 — they'd require
// a different `template.components[].parameters` shape with `parameter_name`).
const VAR_REGEX = /\{\{\s*(\d+)\s*\}\}/g;

/** Return the sorted distinct variable indices found in a template body. */
export function extractBodyVariableIndices(template: WhatsAppTemplate): number[] {
    const body = template.components.find((c) => c.type === 'BODY');
    if (!body?.text) return [];
    const set = new Set<number>();
    let match: RegExpExecArray | null;
    VAR_REGEX.lastIndex = 0;
    while ((match = VAR_REGEX.exec(body.text)) !== null) {
        const n = parseInt(match[1], 10);
        if (!Number.isNaN(n)) set.add(n);
    }
    return Array.from(set).sort((a, b) => a - b);
}

/** Render the BODY text with provided variables (for preview + DB storage). */
export function renderTemplateBody(template: WhatsAppTemplate, variables: string[]): string {
    const body = template.components.find((c) => c.type === 'BODY');
    if (!body?.text) return '';
    return body.text.replace(VAR_REGEX, (_full, idxStr: string) => {
        const idx = parseInt(idxStr, 10);
        // Variables are 1-indexed in Meta's API; we receive a 0-indexed array
        // ordered by the indices returned from extractBodyVariableIndices.
        // To keep the caller simple, accept either layout: if variables[idx-1]
        // exists, use it; else leave the placeholder visible.
        const value = variables[idx - 1];
        return typeof value === 'string' ? value : `{{${idxStr}}}`;
    });
}

interface SendTemplateOptions {
    to: string;
    templateName: string;
    language: string;
    /**
     * Positional variables for BODY component, ordered by `{{1}}, {{2}}, ...`.
     * Length must match the number of distinct placeholders.
     */
    variables?: string[];
}

/**
 * Send a template message. Returns the same shape as sendWhatsAppMessage()
 * so the caller (route handler) can store wa_message_id + status='sent'
 * uniformly. Status callbacks update the row exactly as for free-form text.
 */
export async function sendTemplateMessage(creds: WaCreds, opts: SendTemplateOptions): Promise<SendWhatsAppResult> {
    assertCanSend(creds);

    const components: Array<Record<string, unknown>> = [];
    if (opts.variables && opts.variables.length > 0) {
        components.push({
            type: 'body',
            parameters: opts.variables.map((text) => ({ type: 'text', text })),
        });
    }

    // FLOW buttons (e.g. brief_acara_sailendra_v2) — required in the send
    // payload or Meta rejects with 131009 "Components sub_type invalid".
    // Best-effort: if the definition lookup fails we send without it (same
    // behavior as before this fix) and let Meta's error surface.
    const definition = await getTemplateDefinition(creds, opts.templateName, opts.language);
    if (definition) {
        components.push(...buildFlowButtonComponents(definition));
    }

    const body = {
        messaging_product: 'whatsapp',
        // Phone → `to`; BSUID → `recipient` (see lib/whatsapp/recipient.ts).
        ...buildRecipient(opts.to),
        type: 'template',
        template: {
            name: opts.templateName,
            language: { code: opts.language },
            ...(components.length > 0 ? { components } : {}),
        },
    };

    const response = await fetch(graphUrl(`${creds.phoneNumberId}/messages`, creds.graphVersion), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        let errorPayload: unknown = null;
        try {
            errorPayload = await response.json();
        } catch {
            try {
                errorPayload = { error: { message: await response.text() } };
            } catch {
                errorPayload = null;
            }
        }
        console.error(
            'Error sending template message:',
            JSON.stringify(errorPayload, null, 2)
        );
        throw makeWhatsAppApiError(errorPayload, response.status);
    }

    const raw = await response.json();
    let waMessageId: string | null = null;
    if (raw && typeof raw === 'object') {
        const messages = (raw as Record<string, unknown>).messages;
        if (Array.isArray(messages) && messages.length > 0) {
            const first = messages[0];
            if (first && typeof first === 'object') {
                const id = (first as Record<string, unknown>).id;
                if (typeof id === 'string' && id.length > 0) waMessageId = id;
            }
        }
    }
    return { waMessageId, raw };
}
