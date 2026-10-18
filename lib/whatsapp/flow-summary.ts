// Readable summaries of messages that are stored for the operators without
// being handled: a WhatsApp Flow submission (interactive nfm_reply) whose form
// this app does not know, as "field: value" lines, and a contact card, as
// "name: phones" lines. Used for messages to another number of the WABA
// (lib/whatsapp/other-number.ts), which are kept without the Brief Acara
// handling of flow-response.ts and without taking verified_phone from a card.

const MAX_LINES = 12;
const MAX_VALUE = 200;

function cut(text: string): string {
    return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

function valueText(value: unknown): string {
    if (Array.isArray(value)) return value.map(valueText).join(', ');
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

export function flowSubmissionSummary(responseJson: unknown): string {
    let data: unknown = responseJson;
    if (typeof responseJson === 'string') {
        try {
            data = JSON.parse(responseJson);
        } catch {
            data = null;
        }
    }
    const lines: string[] = [];
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            // flow_token is Meta's correlation id, not an answer.
            if (key === 'flow_token' || value === null || value === undefined || value === '') continue;
            lines.push(`${key}: ${cut(valueText(value))}`);
            if (lines.length >= MAX_LINES) break;
        }
    }
    return lines.length > 0
        ? `📋 Form WhatsApp dikirim\n${lines.join('\n')}`
        : '📋 Form WhatsApp dikirim (isian tidak terbaca)';
}

/** A contact card (messages[].contacts of a 'contacts' message). */
export function contactCardSummary(contacts: unknown): string {
    const lines: string[] = [];
    if (Array.isArray(contacts)) {
        for (const entry of contacts) {
            if (entry === null || typeof entry !== 'object') continue;
            const card = entry as Record<string, unknown>;
            const nameObj = card.name !== null && typeof card.name === 'object' ? (card.name as Record<string, unknown>) : {};
            const formatted = typeof nameObj.formatted_name === 'string' ? nameObj.formatted_name.trim() : '';
            const phones = (Array.isArray(card.phones) ? card.phones : [])
                .map((p) => (p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
                .map((p) => (typeof p.phone === 'string' && p.phone.trim() ? p.phone.trim() : typeof p.wa_id === 'string' ? p.wa_id.trim() : ''))
                .filter(Boolean);
            lines.push(cut(`${formatted || 'tanpa nama'}: ${phones.length > 0 ? phones.join(', ') : 'tanpa nomor'}`));
            if (lines.length >= MAX_LINES) break;
        }
    }
    return lines.length > 0
        ? `👤 Kartu kontak dibagikan\n${lines.join('\n')}`
        : '👤 Kartu kontak dibagikan (isi tidak terbaca)';
}
