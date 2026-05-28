// Convert the Markdown the LLM tends to emit into WhatsApp's own text-formatting
// syntax. WhatsApp uses *bold*, _italic_, ~strike~, ```mono``` — NOT Markdown's
// **bold**, # headings, or [label](url) links. gpt-4o frequently emits Markdown
// even when the system prompt forbids it, so this runs server-side on EVERY
// outbound message as the deterministic guarantee (prompt rules alone leak —
// observed: "**info@sailendra.co.id**" reaching a customer verbatim).
//
// Conservative on purpose: it only rewrites the high-frequency Markdown the
// model actually produces and leaves already-correct WhatsApp syntax (single
// *bold*, _italic_) untouched.
export function toWhatsAppText(input: string): string {
    if (!input) return input;
    let s = input;

    // Bold: **x** / __x__  →  *x*   (WhatsApp bold is a single asterisk).
    // No dotAll flag (tsconfig target) — bold never spans lines in practice.
    s = s.replace(/\*\*(.+?)\*\*/g, '*$1*');
    s = s.replace(/__(.+?)__/g, '*$1*');

    // Markdown headings "## Title"  →  bold line "*Title*"
    s = s.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*');

    // Links [label](url)  →  "label (url)" (WhatsApp auto-links bare URLs)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');

    // Bullet lists "- item" / "* item"  →  "• item"
    s = s.replace(/^[ \t]*[-*][ \t]+/gm, '• ');

    return s;
}
