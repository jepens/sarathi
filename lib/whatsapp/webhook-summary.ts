// The log line of an incoming WhatsApp webhook: counts and change fields
// only. The payload itself is never logged: it holds customers' phone
// numbers, names and message text (audit KEA-21, UU PDP).

export function webhookSummary(body: unknown): string {
    const b = (body ?? {}) as { object?: unknown; entry?: unknown };
    const entries = Array.isArray(b.entry) ? b.entry : [];
    let changes = 0;
    let messages = 0;
    let statuses = 0;
    const fields = new Set<string>();
    for (const entry of entries) {
        const list = (entry as { changes?: unknown } | null)?.changes;
        for (const change of Array.isArray(list) ? list : []) {
            changes++;
            const c = change as { field?: unknown; value?: { messages?: unknown; statuses?: unknown } } | null;
            if (typeof c?.field === 'string') fields.add(c.field);
            if (Array.isArray(c?.value?.messages)) messages += c.value.messages.length;
            if (Array.isArray(c?.value?.statuses)) statuses += c.value.statuses.length;
        }
    }
    const object = typeof b.object === 'string' ? b.object : '-';
    return `object=${object} entries=${entries.length} changes=${changes} fields=${[...fields].join(',') || '-'} messages=${messages} statuses=${statuses}`;
}
