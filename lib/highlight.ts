// Pure text-splitting for in-conversation search highlighting. Splits a string
// into alternating non-match / match chunks against a query, case-insensitively,
// treating the query literally (regex specials escaped). Kept free of React so it
// unit-tests without a DOM; the component wraps match chunks in <mark>.

export interface HighlightChunk {
    text: string;
    match: boolean;
}

// Escape regex metacharacters so a query like "a.b" or "$5" matches literally.
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitHighlight(text: string, query: string): HighlightChunk[] {
    const q = query.trim();
    if (!q) return [{ text, match: false }];
    // Capturing group → String.split splices the matched substrings into the
    // result at ODD indices; the gaps between them sit at even indices.
    const re = new RegExp(`(${escapeRegExp(q)})`, 'gi');
    return text
        .split(re)
        .map((part, i) => ({ text: part, match: i % 2 === 1 }))
        .filter((chunk) => chunk.text !== '');
}
