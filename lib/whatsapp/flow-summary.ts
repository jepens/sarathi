// A readable summary of a WhatsApp Flow submission (interactive nfm_reply)
// whose form this app does not know: its answers as "field: value" lines.
// Used for a submission to another number of the WABA, which is stored for
// the operators without the Brief Acara handling of flow-response.ts (no
// lead, no confirmation sent from the wrong number).

const MAX_LINES = 12;
const MAX_VALUE = 200;

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
            const text = valueText(value);
            lines.push(`${key}: ${text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text}`);
            if (lines.length >= MAX_LINES) break;
        }
    }
    return lines.length > 0
        ? `📋 Form WhatsApp dikirim\n${lines.join('\n')}`
        : '📋 Form WhatsApp dikirim (isian tidak terbaca)';
}
