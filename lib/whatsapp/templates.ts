import {
    getWhatsAppAccessToken,
    getWhatsAppPhoneNumberId,
    getWhatsAppBusinessAccountId,
} from '@/lib/settings/app-settings';
import { makeWhatsAppApiError } from '@/lib/whatsapp/client';
import type { SendWhatsAppResult } from '@/lib/whatsapp/client';

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0';

// ---------------------------------------------------------------------------
// Template message support — for re-engagement OUTSIDE the 24-hour customer
// service window (Meta error code 131047).
//
// Meta only allows pre-approved templates to start a new conversation. The
// template gets reviewed by Meta and assigned a category (UTILITY,
// MARKETING, AUTHENTICATION). Once APPROVED we can send it with variable
// substitution.
//
// API surface:
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

/**
 * Fetch APPROVED message templates for the WABA. Filters server-side via
 * `?status=APPROVED` and paginates up to `limit` (default 100; Meta caps).
 */
export async function listApprovedTemplates(limit = 100): Promise<WhatsAppTemplate[]> {
    const accessToken = await getWhatsAppAccessToken();
    const wabaId = await getWhatsAppBusinessAccountId();

    const url = `${WHATSAPP_API_URL}/${wabaId}/message_templates?status=APPROVED&limit=${limit}`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
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
export async function sendTemplateMessage(opts: SendTemplateOptions): Promise<SendWhatsAppResult> {
    const phoneNumberId = await getWhatsAppPhoneNumberId();
    const accessToken = await getWhatsAppAccessToken();

    const components: Array<Record<string, unknown>> = [];
    if (opts.variables && opts.variables.length > 0) {
        components.push({
            type: 'body',
            parameters: opts.variables.map((text) => ({ type: 'text', text })),
        });
    }

    const body = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'template',
        template: {
            name: opts.templateName,
            language: { code: opts.language },
            ...(components.length > 0 ? { components } : {}),
        },
    };

    const response = await fetch(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
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
