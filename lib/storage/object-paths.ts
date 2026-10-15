// Storage object-key helpers. Every tenant bucket (documents, chat-media,
// proposals) keys objects as "<org_id>/..." and the storage RLS policies
// (migrations 0038 / 0058) authorise only members of the org in that first
// segment. Pure — no I/O — so they're unit-testable.

/** `${orgId}/${phone}/${uuid}.pdf` — the proposals bucket key (KEA-4). */
export function proposalObjectKey(orgId: string, phone: string, uuid: string): string {
    return `${orgId}/${phone}/${uuid}.pdf`;
}

/**
 * True when `path` is a plausible object key INSIDE the org's folder: a string
 * starting with "<orgId>/", with a non-empty remainder, and no traversal or
 * odd segments ("..", ".", empty segments, backslashes, control characters).
 * Used to refuse client-supplied paths that point at another org's objects.
 */
export function isOrgScopedObjectPath(path: unknown, orgId: string): path is string {
    if (typeof path !== 'string' || !orgId) return false;
    if (path.length > 1024) return false;
    const prefix = `${orgId}/`;
    if (!path.startsWith(prefix)) return false;
    if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
    const rest = path.slice(prefix.length);
    if (!rest) return false;
    return rest.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
