// Pure helpers for the quick-replies (balasan cepat) feature. Kept free of React
// / Supabase so they unit-test without a DOM, and are shared by the composer
// picker, the "/" autocomplete, and the settings editor.

export interface QuickReply {
    id: string;
    shortcut: string;
    content: string;
}

// Values pulled from the open chat's CRM row at insert time.
export interface QuickReplyVars {
    nama?: string | null;
    perusahaan?: string | null;
    event?: string | null;
}

// Natural-reading fallbacks so a snippet never renders "Halo ," when the chat has
// no name / company / event yet.
const FALLBACKS = {
    nama: 'Kak',
    perusahaan: 'perusahaan Anda',
    event: 'acara Anda',
} as const;

// Fill {nama} / {perusahaan} / {event}. Tokens match case-insensitively and
// tolerate inner spaces ("{ nama }"); every occurrence is replaced.
export function applyQuickReplyVars(content: string, vars: QuickReplyVars): string {
    const pick = (v: string | null | undefined, fb: string): string => {
        const t = v?.trim();
        return t ? t : fb;
    };
    // Single pass with a FUNCTION replacer: (1) the returned value is inserted
    // literally, so a "$" in CRM data can't be misread as a $-replacement pattern
    // ($$, $&, …); (2) each source position is matched exactly once, so a
    // substituted value that happens to contain another token is not re-expanded.
    return content.replace(/\{\s*(nama|perusahaan|event)\s*\}/gi, (_m, key: string) => {
        switch (key.toLowerCase()) {
            case 'nama':
                return pick(vars.nama, FALLBACKS.nama);
            case 'perusahaan':
                return pick(vars.perusahaan, FALLBACKS.perusahaan);
            case 'event':
                return pick(vars.event, FALLBACKS.event);
            default:
                return _m;
        }
    });
}

// The "/" autocomplete shows only when the WHOLE input is a bare slash token
// ("/", "/har") — i.e. the operator is starting a fresh message with a shortcut.
// Returns the query after "/" (may be ""), or null when it's not a slash trigger
// (empty, contains whitespace, or doesn't start with "/").
export function parseSlashQuery(input: string): string | null {
    if (!input.startsWith('/')) return null;
    const rest = input.slice(1);
    if (/\s/.test(rest)) return null; // "/harga oke" → no longer just a shortcut
    return rest;
}

// Filter for the picker (substring over shortcut+content) or the "/" menu
// (prefix over shortcut only). Case-insensitive; an empty query returns all.
export function filterQuickReplies(
    items: QuickReply[],
    query: string,
    opts: { prefix?: boolean } = {},
): QuickReply[] {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    if (opts.prefix) {
        return items.filter((it) => it.shortcut.toLowerCase().startsWith(q));
    }
    return items.filter(
        (it) => it.shortcut.toLowerCase().includes(q) || it.content.toLowerCase().includes(q),
    );
}
