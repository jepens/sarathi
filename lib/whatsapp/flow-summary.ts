// Readable summaries of messages that are stored for the operators without
// being handled, used for messages to another number of the WABA
// (lib/whatsapp/other-number.ts): a WhatsApp Flow submission (interactive
// nfm_reply) whose form this app does not know, as "field: value" lines,
// without the Brief Acara handling of flow-response.ts; a contact card, as
// "name: phones" lines, without taking verified_phone from it; and any other
// message type (a template's quick-reply button, a list or button choice, a
// location, a reaction, a type Sarathi does not show) as one line.

const MAX_LINES = 12;
const MAX_VALUE = 200;

// Cut by code points, never inside a surrogate pair: a half emoji is not
// valid UTF-8 and the database would refuse the whole row.
function cut(text: string): string {
    const chars = Array.from(text);
    return chars.length > MAX_VALUE ? `${chars.slice(0, MAX_VALUE).join('')}…` : text;
}

function valueText(value: unknown): string {
    if (Array.isArray(value)) return value.map(valueText).join(', ');
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
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
            const formatted = text(record(card.name).formatted_name);
            const phones = (Array.isArray(card.phones) ? card.phones : [])
                .map(record)
                .map((p) => text(p.phone) || text(p.wa_id))
                .filter(Boolean);
            lines.push(cut(`${formatted || 'tanpa nama'}: ${phones.length > 0 ? phones.join(', ') : 'tanpa nomor'}`));
            if (lines.length >= MAX_LINES) break;
        }
    }
    return lines.length > 0
        ? `👤 Kartu kontak dibagikan\n${lines.join('\n')}`
        : '👤 Kartu kontak dibagikan (isi tidak terbaca)';
}

/** Any other message type (one webhook messages[] entry) as one line. */
export function otherMessageSummary(message: unknown): string {
    const m = record(message);
    const type = text(m.type) || 'tidak dikenal';
    switch (type) {
        case 'button': {
            // A template's quick-reply button.
            const button = record(m.button);
            return `🔘 Tombol: ${cut(text(button.text) || text(button.payload) || '-')}`;
        }
        case 'interactive': {
            const interactive = record(m.interactive);
            const reply = record(interactive.button_reply ?? interactive.list_reply);
            return `🔘 Pilihan: ${cut(text(reply.title) || text(reply.id) || '-')}`;
        }
        case 'location': {
            const location = record(m.location);
            const place = [text(location.name), text(location.address)].filter(Boolean).join(', ');
            const coordinates = [text(location.latitude), text(location.longitude)].filter(Boolean).join(', ');
            return `📍 Lokasi: ${cut(place || coordinates || '-')}`;
        }
        case 'reaction':
            return `Reaksi: ${cut(text(record(m.reaction).emoji) || '(dihapus)')}`;
        default:
            return `Pesan jenis "${cut(type)}" (isinya tidak ditampilkan di Sarathi)`;
    }
}
