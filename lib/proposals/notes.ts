// whatsapp_chats.notes is double-duty: a human-authored note PLUS an appended
// proposal audit trail (see markQuoted in send.ts). These helpers split the two
// so the FNA editor and history can show only the human note, while the audit
// lines are preserved in storage. Pure string utils — safe to import from both
// client components and server code.

// markQuoted writes lines shaped exactly like:
//   [2026-05-29T10:00:00.000Z] proposal SLDR-20260529-1000 sent
const AUDIT_LINE_RE = /^\s*\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\]\s+proposal\s+/;

export function isAuditLine(line: string): boolean {
    return AUDIT_LINE_RE.test(line);
}

// The human-authored portion: every line that is NOT a proposal audit line.
// Leading/trailing blank lines trimmed.
export function stripAuditLines(notes: string | null | undefined): string {
    if (!notes) return '';
    return notes
        .split('\n')
        .filter((l) => !isAuditLine(l))
        .join('\n')
        .trim();
}

// The proposal audit lines, in their original order.
export function extractAuditLines(notes: string | null | undefined): string[] {
    if (!notes) return [];
    return notes.split('\n').filter((l) => isAuditLine(l));
}
