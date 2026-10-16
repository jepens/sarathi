// Pure helpers of scripts/migrate-legacy-kb-objects.mjs (tracker 1.12,
// migration 0066). No network and no file system access here (the --out
// check takes an injected `exists` function), so vitest covers them:
// scripts/lib/__tests__/legacy-kb.test.ts. Plain ESM, so the script still
// runs with plain `node`.

import { createHash } from 'node:crypto';
import path from 'node:path';

export const BUCKET = 'documents';
/** Sailendra, tenant #1 (migration 0026): owner of every legacy KB object. */
export const SEED_ORG_ID = '5a11e024-0001-4000-8000-000000000001';
/** Same pattern as the CASE guard of the storage policies (0058 / 0066). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PHASES = ['plan', 'copy', 'verify', 'delete-originals', 'restore', 'remove-copies'];
/** Phases that change Storage when run with --confirm (dry-run without it). */
export const WRITE_PHASES = new Set(['copy', 'delete-originals', 'restore', 'remove-copies']);
export const DEFAULT_SOAK_HOURS = 72;
export const MANIFEST_KIND = 'sarathi-legacy-kb-objects';
export const MANIFEST_VERSION = 1;

/**
 * Command line: --phase=<p> --expect-ref=<ref> --out=<dir> [--confirm]
 * [--soak-hours=<n>] [--allow-short-soak] [--only-user-deleted]
 * [--unreferenced-only] [--allow-replan]. Only the `--name=value` form, like
 * the other scripts.
 * @param {string[]} argv process.argv.slice(2)
 */
export function parseArgs(argv) {
    const opts = {
        phase: 'plan',
        expectRef: /** @type {string|null} */ (null),
        out: /** @type {string|null} */ (null),
        confirm: false,
        soakHours: DEFAULT_SOAK_HOURS,
        allowShortSoak: false,
        onlyUserDeleted: false,
        unreferencedOnly: false,
        allowReplan: false,
    };
    /** @type {string[]} */
    const errors = [];
    for (const arg of argv) {
        if (arg === '--confirm') opts.confirm = true;
        else if (arg === '--allow-short-soak') opts.allowShortSoak = true;
        else if (arg === '--only-user-deleted') opts.onlyUserDeleted = true;
        else if (arg === '--unreferenced-only') opts.unreferencedOnly = true;
        else if (arg === '--allow-replan') opts.allowReplan = true;
        else {
            const m = /^--(phase|expect-ref|out|soak-hours)=(.*)$/s.exec(arg);
            if (!m) {
                errors.push(`unknown argument: ${arg}`);
                continue;
            }
            const [, key, value] = m;
            if (key === 'phase') opts.phase = value;
            else if (key === 'expect-ref') opts.expectRef = value;
            else if (key === 'out') opts.out = value;
            else {
                const n = Number(value);
                if (value.trim() === '' || !Number.isFinite(n) || n < 0) {
                    errors.push('--soak-hours must be a number >= 0');
                } else {
                    opts.soakHours = n;
                }
            }
        }
    }
    if (!PHASES.includes(opts.phase)) errors.push(`--phase must be one of: ${PHASES.join(', ')}`);
    if (!opts.expectRef) errors.push('--expect-ref=<project ref> is required');
    if (!opts.out) errors.push('--out=<directory outside the repository> is required');
    if (opts.confirm && !WRITE_PHASES.has(opts.phase)) {
        errors.push(`--confirm is only accepted by the phases ${[...WRITE_PHASES].join(', ')}`);
    }
    if (opts.onlyUserDeleted && opts.phase !== 'delete-originals') {
        errors.push('--only-user-deleted is only accepted by --phase=delete-originals');
    }
    if (opts.unreferencedOnly && opts.phase !== 'remove-copies') {
        errors.push('--unreferenced-only is only accepted by --phase=remove-copies');
    }
    if (opts.allowReplan && opts.phase !== 'plan') {
        errors.push('--allow-replan is only accepted by --phase=plan');
    }
    return { opts, errors };
}

/**
 * The project ref the env points at: "<ref>" for https://<ref>.supabase.co,
 * "local-<port>" for a local stack on http://127.0.0.1:<port> (or localhost).
 * Anything else is null, and the script refuses to run.
 * @param {unknown} raw NEXT_PUBLIC_SUPABASE_URL
 */
export function projectRefFromUrl(raw) {
    let url;
    try {
        url = new URL(String(raw));
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    const cloud = /^([a-z0-9]{20})\.supabase\.co$/.exec(host);
    if (cloud && url.protocol === 'https:') return cloud[1];
    if ((host === '127.0.0.1' || host === 'localhost') && url.protocol === 'http:' && url.port) {
        return `local-${url.port}`;
    }
    return null;
}

/** A local stack's ref ("local-<port>", projectRefFromUrl). @param {unknown} ref */
export function isLocalRef(ref) {
    return typeof ref === 'string' && /^local-\d+$/.test(ref);
}

/**
 * Why --soak-hours is not acceptable, or null. The soak is the time the
 * originals stay in place while 0066 is live (the rollback window): below 72 h
 * only on a local stack (rehearsals), or with the explicit --allow-short-soak.
 * The runbook forbids both in production.
 * @param {{ soakHours: number, ref: string, allowShortSoak: boolean }} s
 */
export function soakHoursProblem(s) {
    if (s.soakHours >= DEFAULT_SOAK_HOURS || isLocalRef(s.ref) || s.allowShortSoak) return null;
    return `--soak-hours=${s.soakHours} is below ${DEFAULT_SOAK_HOURS} for project ${s.ref}, which is not a local stack ` +
        '(never shorten the soak in production; only --allow-short-soak overrides this)';
}

/**
 * Which kind of key SUPABASE_SERVICE_ROLE_KEY holds. Only 'service_role' (a
 * legacy JWT key) and 'secret' (sb_secret_...) bypass Storage RLS; with any
 * other key the listing would silently come back empty.
 * @param {unknown} key
 */
export function keyRole(key) {
    if (typeof key !== 'string' || key === '') return 'missing';
    if (key.startsWith('sb_secret_')) return 'secret';
    if (key.startsWith('sb_publishable_')) return 'publishable';
    const parts = key.split('.');
    if (parts.length !== 3) return 'unknown';
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return typeof payload?.role === 'string' ? payload.role : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Same rule as isOrgScopedObjectPath in lib/storage/object-paths.ts (kept in
 * sync by a parity test): a key inside "<orgId>/" with a non-empty remainder
 * and no traversal or odd segments.
 * @param {unknown} p
 * @param {string} orgId
 * @returns {p is string}
 */
export function isOrgScopedObjectPath(p, orgId) {
    if (typeof p !== 'string' || !orgId) return false;
    if (p.length > 1024) return false;
    const prefix = `${orgId}/`;
    if (!p.startsWith(prefix)) return false;
    if (/[\\\u0000-\u001f\u007f]/.test(p)) return false;
    const rest = p.slice(prefix.length);
    if (!rest) return false;
    return rest.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * A root-level object name the script may handle: no folder at all (the
 * objects the 0038 policy resolved to the seed org), no control characters or
 * backslashes, and short enough to get the 37-character org prefix.
 * @param {unknown} name
 * @returns {name is string}
 */
export function isRootObjectName(name) {
    if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return false;
    if (name.includes('/')) return false;
    if (/[\\\u0000-\u001f\u007f]/.test(name)) return false;
    return name.length <= 1024 - 37;
}

/**
 * The key of the copy: "<orgId>/<same name>", or null when the name is not
 * a safe root-level name (the script then refuses to plan).
 * @param {unknown} name
 * @param {string} orgId
 */
export function destinationFor(name, orgId = SEED_ORG_ID) {
    if (!isRootObjectName(name)) return null;
    const dest = `${orgId}/${name}`;
    return isOrgScopedObjectPath(dest, orgId) ? dest : null;
}

/**
 * storage-js puts the key into the URL as is (download, info, exists,
 * upload). Encode each segment so spaces, commas, '%', '#' or '?' reach the
 * Storage API intact. copy() and remove() send keys in a JSON body instead
 * and take them raw.
 * @param {string} key
 */
export function encodeObjectPath(key) {
    return key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/**
 * @param {string} child
 * @param {string} parent
 */
export function isInsideDir(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return false;
    return !(rel === '..' || rel.startsWith(`..${path.sep}`));
}

/**
 * Why --out is not acceptable, or null. The backup holds business documents
 * (UU PDP): it must never end up in a working tree where it could be
 * committed. Refused: the repository itself, anything inside it, and any
 * directory with a `.git` entry in it or in one of its parents.
 * @param {string} outAbs resolved --out (symlinks resolved by the caller)
 * @param {string} repoRoot the repository the script belongs to
 * @param {(p: string) => boolean} exists
 */
export function outDirProblem(outAbs, repoRoot, exists) {
    const out = path.resolve(outAbs);
    if (isInsideDir(out, repoRoot)) return 'it is inside the repository';
    let dir = out;
    for (;;) {
        if (exists(path.join(dir, '.git'))) return 'it is inside a git working tree';
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * `metadata->>key` in SQL: the text of the key, or null when it is missing or
 * JSON null.
 * @param {unknown} meta
 * @param {string} key
 */
export function metadataText(meta, key) {
    if (meta === null || typeof meta !== 'object' || !Object.prototype.hasOwnProperty.call(meta, key)) {
        return null;
    }
    const v = /** @type {Record<string, unknown>} */ (meta)[key];
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * A file-backed documents row, exactly as 0066 and the runbook queries define
 * it: `coalesce(metadata->>'origin','') <> 'editor' and metadata ? 'source'`.
 * Editor rows (app/api/knowledge/text) keep source = title and have no
 * Storage object.
 * @param {unknown} meta
 */
export function isFileBackedRow(meta) {
    return (
        meta !== null &&
        typeof meta === 'object' &&
        Object.prototype.hasOwnProperty.call(meta, 'source') &&
        (metadataText(meta, 'origin') ?? '') !== 'editor'
    );
}

/** `strpos(source, '/') = 0`: a root-level name (null is not). @param {unknown} src */
export function isRootSource(src) {
    return typeof src === 'string' && !src.includes('/');
}

/**
 * @typedef {{ id: string, org_id: string, metadata: unknown }} DocRow
 * @typedef {{
 *   total: number, fileBacked: number, editor: number, editorRootSource: number,
 *   other: number, prefixed: number, relinked: number, rootSource: number,
 *   rootSourceOtherOrg: number, rootSourceDangling: number, outsideOrgFolder: number,
 *   blocking: number, referencedObjects: number,
 * }} RowCounts
 * @typedef {{ dest: string, row_ids: string[], user_deleted_at?: string|null, d16_deleted_at?: string|null }} EntryLike
 */

/**
 * File-backed rows whose source is a root-level name: 0066 is not in effect
 * (not applied yet, or reverted). Editor rows keep a source without '/'
 * (their title) forever and do not count.
 * @param {DocRow[]} rows
 */
export function fileBackedRootRows(rows) {
    return rows.filter((r) => isFileBackedRow(r.metadata) && isRootSource(metadataText(r.metadata, 'source'))).length;
}

/**
 * Sorts the documents rows the way 0066 sees them.
 * - byName: root-level object name -> ids of the seed-org file-backed rows
 *   whose source is that name (0066 relinks exactly these), or is already its
 *   copy '<seed>/<that name>' (rows relinked by 0066). rowsAtRoot and
 *   rowsOnCopy count the two kinds per name.
 * - blocking: file-backed rows the relink cannot fix (another org, a source
 *   that names no object, a source outside the row's org folder); the 0066
 *   guard would refuse while they exist.
 * @param {DocRow[]} rows
 * @param {Set<string>} rootNames
 * @param {string} seedOrgId
 */
export function analyseRows(rows, rootNames, seedOrgId = SEED_ORG_ID) {
    /** @type {Map<string, string[]>} */
    const byName = new Map();
    /** @type {Map<string, number>} */
    const rowsAtRoot = new Map();
    /** @type {Map<string, number>} */
    const rowsOnCopy = new Map();
    /** @type {RowCounts} */
    const counts = {
        total: rows.length,
        fileBacked: 0,
        editor: 0,
        editorRootSource: 0,
        other: 0,
        prefixed: 0,
        relinked: 0,
        rootSource: 0,
        rootSourceOtherOrg: 0,
        rootSourceDangling: 0,
        outsideOrgFolder: 0,
        blocking: 0,
        referencedObjects: 0,
    };
    /** @param {Map<string, number>} map @param {string} name @param {string} id */
    const add = (map, name, id) => {
        const ids = byName.get(name) ?? [];
        ids.push(id);
        byName.set(name, ids);
        map.set(name, (map.get(name) ?? 0) + 1);
    };
    for (const row of rows) {
        const meta = row.metadata;
        if (!isFileBackedRow(meta)) {
            if ((metadataText(meta, 'origin') ?? '') === 'editor') {
                counts.editor++;
                if (isRootSource(metadataText(meta, 'source'))) counts.editorRootSource++;
            } else {
                counts.other++;
            }
            continue;
        }
        counts.fileBacked++;
        const src = metadataText(meta, 'source');
        if (typeof src === 'string' && src.startsWith(`${row.org_id}/`)) {
            const rootName = row.org_id === seedOrgId ? src.slice(seedOrgId.length + 1) : null;
            if (rootName !== null && rootNames.has(rootName) && destinationFor(rootName, seedOrgId) === src) {
                counts.relinked++;
                add(rowsOnCopy, rootName, row.id);
            } else {
                counts.prefixed++;
            }
        } else if (isRootSource(src)) {
            counts.rootSource++;
            if (row.org_id !== seedOrgId) counts.rootSourceOtherOrg++;
            else if (!rootNames.has(/** @type {string} */ (src))) counts.rootSourceDangling++;
            else add(rowsAtRoot, /** @type {string} */ (src), row.id);
        } else {
            counts.outsideOrgFolder++;
        }
    }
    counts.blocking = counts.rootSourceOtherOrg + counts.rootSourceDangling + counts.outsideOrgFolder;
    counts.referencedObjects = byName.size;
    return { byName, rowsAtRoot, rowsOnCopy, counts };
}

/**
 * The copy stage a plan finds, and why it may not plan. A bucket the copy
 * phase has already run on (rows relinked by 0066, or seed copies identical to
 * a root-level object) must not be planned again: the manifest of the first
 * plan is the only record of which documents rows each object had, so a new
 * plan cannot tell a KB entry a user deleted since. Recover manifest.json
 * from its second copy instead; only --allow-replan overrides this.
 * - 'fresh': nothing copied yet, a normal plan.
 * - 'after-0066': rows are relinked and none names a root-level object.
 * - 'before-0066': rows name root-level objects and none is relinked (0066
 *   not applied yet, or reverted).
 * - 'unknown': neither (all referenced entries gone, or both kinds of rows):
 *   refused even with --allow-replan.
 * @param {{ relinked: number, rootSource: number, identicalCopies: number, allowReplan: boolean }} s
 * @returns {{ stage: 'fresh'|'after-0066'|'before-0066'|'unknown', problems: string[] }}
 */
export function replanCheck(s) {
    if (s.relinked === 0 && s.identicalCopies === 0) return { stage: 'fresh', problems: [] };
    /** @type {'after-0066'|'before-0066'|'unknown'} */
    let stage = 'unknown';
    if (s.relinked > 0 && s.rootSource === 0) stage = 'after-0066';
    else if (s.relinked === 0 && s.rootSource > 0) stage = 'before-0066';
    /** @type {string[]} */
    const problems = [];
    if (!s.allowReplan) {
        problems.push(`the bucket was already copied (relinked rows ${s.relinked}, seed copies identical to a root-level ` +
            `object ${s.identicalCopies}): do not plan again; recover manifest.json from its second copy (runbook). ` +
            'Only --allow-replan overrides this');
    } else if (stage === 'unknown') {
        problems.push(`--allow-replan: cannot tell whether 0066 is in effect (relinked rows ${s.relinked}, rows naming a ` +
            `root-level object ${s.rootSource}); a human decides`);
    }
    return { stage, problems };
}

/**
 * plan, per root-level object: what it means that it has (or has not) an
 * identical copy at its destination, given the copy stage (replanCheck).
 * - 'plan': planned as usual (copied, or skipped as identical).
 * - 'user-deleted': no copy after 0066. 0066's guard proved that every
 *   root-level object had a same-size copy, so a copy that is gone since was
 *   removed with its KB entry (DELETE /api/documents): the manifest marks it
 *   deleted by a user and its bytes are never copied back.
 * - 'copy-missing': rows name its copy, which does not exist (refused).
 * - 'ambiguous': no copy and no row before 0066 (or at an unknown stage) in a
 *   bucket already copied: an interrupted copy, or a KB entry a user deleted
 *   while 0066 was in effect before a revert; refused, a human decides.
 * @param {{ stage: string, destState: 'absent'|'identical'|'different', rowsAtRoot: number, rowsOnCopy: number }} s
 * @returns {'plan'|'user-deleted'|'copy-missing'|'ambiguous'}
 */
export function planDisposition(s) {
    if (s.destState !== 'absent') return 'plan';
    if (s.rowsOnCopy > 0) return 'copy-missing';
    if (s.stage === 'fresh' || s.rowsAtRoot > 0) return 'plan';
    if (s.stage === 'after-0066') return 'user-deleted';
    return 'ambiguous';
}

/**
 * What became of the documents rows an object had at plan time.
 * - 'unreferenced': it had none (13 of the 15 in production). Such an object
 *   can never count as deleted by a user: the dashboard does not list it.
 * - 'referenced': all of them still exist.
 * - 'user-deleted': none exists any more. Only DELETE /api/documents removes
 *   all chunks of a file (then the object in metadata.source), so the KB
 *   entry was deleted in the dashboard. Its bytes must not come back
 *   (UU PDP): never copy or restore it again; delete-originals removes the
 *   original and any copy left over.
 * - 'rows-partial': only some exist, which no app path does; a human looks.
 * @param {string[]} manifestRowIds
 * @param {Set<string>} liveRowIds
 */
export function rowState(manifestRowIds, liveRowIds) {
    if (manifestRowIds.length === 0) return 'unreferenced';
    const live = manifestRowIds.filter((id) => liveRowIds.has(id)).length;
    if (live === manifestRowIds.length) return 'referenced';
    if (live === 0) return 'user-deleted';
    return 'rows-partial';
}

/**
 * copy phase, per object. An entry deleted by a user or removed under D16
 * (owner decision, remove-copies --unreferenced-only) is never copied again.
 * @param {{ rows: string, userDeleted: boolean, d16Deleted?: boolean, dest: 'absent'|'identical'|'different',
 *           original: 'present'|'absent'|'changed' }} s
 * @returns {{ action: 'copy'|'skip-identical'|'skip-user-deleted'|'skip-d16-deleted'|'abort', reason?: string }}
 */
export function copyDecision(s) {
    if (s.userDeleted || s.rows === 'user-deleted') return { action: 'skip-user-deleted' };
    if (s.d16Deleted) return { action: 'skip-d16-deleted' };
    if (s.rows === 'rows-partial') return { action: 'abort', reason: 'only some of its documents rows still exist' };
    if (s.dest === 'different') return { action: 'abort', reason: 'the destination exists with different content' };
    if (s.dest === 'identical') return { action: 'skip-identical' };
    if (s.original === 'changed') return { action: 'abort', reason: 'the original was replaced since the plan' };
    if (s.original === 'absent') return { action: 'abort', reason: 'the original is missing (run --phase=restore first)' };
    return { action: 'copy' };
}

/**
 * verify phase, per object. Neither an entry deleted by a user nor one removed
 * under D16 needs its copy, so neither is a failure.
 * @param {{ rows: string, userDeleted: boolean, d16Deleted?: boolean, d16Started?: boolean,
 *           copy: 'identical'|'absent'|'different' }} s
 */
export function verifyStatus(s) {
    if (s.userDeleted || s.rows === 'user-deleted') return 'user-deleted';
    if (s.d16Deleted) return 'd16-deleted';
    if (s.rows === 'rows-partial') return 'fail: only some of its documents rows still exist';
    if (s.copy === 'absent') {
        return s.d16Started
            ? 'fail: the copy is missing (a D16 removal was interrupted: run remove-copies --unreferenced-only again)'
            : 'fail: the copy is missing';
    }
    if (s.copy === 'different') return 'fail: the copy differs from the manifest';
    return 'ok';
}

/**
 * restore phase, per object: puts a missing original back, from the copy
 * when it is intact, else from the byte backup. Never for an entry deleted by
 * a user or removed under D16.
 * @param {{ rows: string, userDeleted: boolean, d16Deleted?: boolean, original: 'present'|'absent'|'changed',
 *           copy: 'identical'|'absent'|'different', backupOk: boolean }} s
 */
export function restoreDecision(s) {
    if (s.userDeleted || s.rows === 'user-deleted') return { action: 'skip-user-deleted' };
    if (s.d16Deleted) return { action: 'skip-d16-deleted' };
    if (s.original !== 'absent') return { action: 'skip-present' };
    if (s.copy === 'identical') return { action: 'from-copy' };
    if (s.backupOk) return { action: 'from-backup' };
    return { action: 'abort', reason: 'neither an intact copy nor an intact backup is left' };
}

/**
 * Hours of the soak still ahead. The soak is the time the originals stay in
 * place while the new policy (0066) is live, so it counts from
 * manifest.soak_started_at, which the verify phase records the first time it
 * sees 0066 in effect (soakStartReady). Not started yet = the whole soak is
 * ahead.
 * @param {string|null|undefined} soakStartedAt ISO time
 * @param {number} soakHours
 * @param {number} now epoch ms
 */
export function soakRemainingHours(soakStartedAt, soakHours, now = Date.now()) {
    const start = typeof soakStartedAt === 'string' ? Date.parse(soakStartedAt) : NaN;
    if (!Number.isFinite(start)) return soakHours;
    const remainingMs = start + soakHours * 3_600_000 - now;
    return remainingMs > 0 ? remainingMs / 3_600_000 : 0;
}

/**
 * One line for verify and delete-originals: the recorded soak start, the
 * --soak-hours in force, when the soak ends and how much is left (or over).
 * @param {string|null|undefined} soakStartedAt ISO time
 * @param {number} soakHours
 * @param {number} now epoch ms
 */
export function soakSummary(soakStartedAt, soakHours, now = Date.now()) {
    const start = typeof soakStartedAt === 'string' ? Date.parse(soakStartedAt) : NaN;
    if (!Number.isFinite(start)) {
        return `soak: not started (no verify has seen 0066 in effect yet); --soak-hours=${soakHours}`;
    }
    const endMs = start + soakHours * 3_600_000;
    const leftH = (endMs - now) / 3_600_000;
    const state = leftH > 0 ? `${leftH.toFixed(1)} h left` : `over for ${(-leftH).toFixed(1)} h`;
    return `soak: started at ${soakStartedAt}, --soak-hours=${soakHours}, ends ${new Date(endMs).toISOString()}: ${state}`;
}

/**
 * Whether verify may record the soak start: 0066 is in effect (no file-backed
 * row names a root-level object any more), every live manifest row points at
 * its copy, and every copy verified.
 * @param {{ rows: DocRow[], objects: EntryLike[], verifyFailures: number }} s
 */
export function soakStartReady(s) {
    if (s.verifyFailures > 0) return false;
    if (fileBackedRootRows(s.rows) > 0) return false;
    return manifestRowsNotRelinked(s.rows, s.objects) === 0;
}

/**
 * Whether verify must clear the recorded soak start: a file-backed row names
 * a root-level object again, so 0066 is no longer in effect (a rollback
 * reverted it) and the originals are needed again. If 0066 comes back, the
 * next verify records a new start, so delete-originals gets a full soak.
 * @param {{ soakStartedAt: string|null|undefined, rows: DocRow[] }} s
 */
export function soakInterrupted(s) {
    return Boolean(s.soakStartedAt) && fileBackedRootRows(s.rows) > 0;
}

/**
 * Live manifest rows (of entries neither deleted by a user nor removed under
 * D16) whose source is not their object's copy.
 * @param {DocRow[]} rows
 * @param {EntryLike[]} objects
 */
function manifestRowsNotRelinked(rows, objects) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    let notRelinked = 0;
    for (const o of objects) {
        if (o.user_deleted_at || o.d16_deleted_at) continue;
        for (const id of o.row_ids) {
            const row = byId.get(id);
            if (row && metadataText(row.metadata, 'source') !== o.dest) notRelinked++;
        }
    }
    return notRelinked;
}

/**
 * Why delete-originals must not run yet ([] = go). The per-entry refusal (a
 * root-level object under a manifest name that is not the manifest's object)
 * comes from deleteOriginalDecision.
 * - normal run: a clean verify, 0066 in effect (no file-backed row at the
 *   root, every live manifest row on its copy) and the soak over.
 * - onlyUserDeleted (the first step of a rollback during the soak: the
 *   originals of KB entries users deleted must be gone before the 0038
 *   fallback returns): it touches only those entries, so only their verify
 *   failures count (verify never fails one: it does not need its copy). The
 *   other entries' copies, the relink and the soak do not matter here, so a
 *   broken copy elsewhere, or remove-copies having run, never blocks it.
 * @param {{
 *   rows: DocRow[],
 *   objects: EntryLike[],
 *   verifyFailures: number,
 *   verifyFailuresUserDeleted?: number,
 *   soakStartedAt: string|null|undefined,
 *   soakHoursLeft: number,
 *   onlyUserDeleted?: boolean,
 * }} s
 */
export function deleteOriginalsBlockers(s) {
    /** @type {string[]} */
    const blockers = [];
    if (s.onlyUserDeleted) {
        const failed = s.verifyFailuresUserDeleted ?? 0;
        if (failed > 0) blockers.push(`verify failed for ${failed} KB entr${failed === 1 ? 'y' : 'ies'} deleted by a user`);
        return blockers;
    }
    if (s.verifyFailures > 0) blockers.push(`verify failed for ${s.verifyFailures} object(s)`);
    const stillRoot = fileBackedRootRows(s.rows);
    if (stillRoot > 0) {
        blockers.push(`${stillRoot} file-backed documents row(s) still name a root-level object (apply 0066 first)`);
    }
    const notRelinked = manifestRowsNotRelinked(s.rows, s.objects);
    if (notRelinked > 0) blockers.push(`${notRelinked} manifest row(s) do not point at their copy`);
    if (!s.soakStartedAt) {
        blockers.push('the soak has not started: run --phase=verify once 0066 is live (it records the start)');
    } else if (s.soakHoursLeft > 0) {
        blockers.push(`the soak is not over: ${s.soakHoursLeft.toFixed(1)} h left (--soak-hours)`);
    }
    return blockers;
}

/**
 * delete-originals, per manifest entry.
 * - an entry removed under D16 is never touched (nothing of it is left);
 * - onlyUserDeleted: every entry not deleted by a user is skipped untouched;
 * - a root-level object under the entry's name that is not the manifest's
 *   object ('changed') refuses the whole run;
 * - else the original goes if present, and for an entry deleted by a user
 *   also any copy left over. A live entry's copy is re-verified right before
 *   its original goes (recheckCopy).
 * @param {{ onlyUserDeleted: boolean, userDeleted: boolean, d16Deleted: boolean,
 *           original: 'present'|'absent'|'changed', copyPresent: boolean }} s
 * @returns {{ action: 'skip'|'refuse'|'remove', removeOriginal: boolean, removeCopy: boolean,
 *             recheckCopy: boolean, reason?: string }}
 */
export function deleteOriginalDecision(s) {
    const none = { removeOriginal: false, removeCopy: false, recheckCopy: false };
    if (s.d16Deleted) return { action: 'skip', ...none, reason: 'removed under D16' };
    if (s.onlyUserDeleted && !s.userDeleted) return { action: 'skip', ...none, reason: 'not deleted by a user' };
    if (s.original === 'changed') {
        return { action: 'refuse', ...none, reason: 'the root-level object under this name is not the one in the manifest' };
    }
    const removeOriginal = s.original === 'present';
    return {
        action: 'remove',
        removeOriginal,
        removeCopy: s.userDeleted && s.copyPresent,
        recheckCopy: removeOriginal && !s.userDeleted,
    };
}

/**
 * remove-copies (rollback while the originals are in place), per manifest
 * entry.
 * - live entry: removes exactly the manifest copy, only while its original
 *   (the manifest's object) is in place and no documents row names the copy;
 *   its original is never touched;
 * - entry deleted by a user: removes whatever is left of it, its copy and its
 *   original, so it ends with neither (the original would be readable again
 *   once the 0038 fallback returns);
 * - entry removed under D16: never touched.
 * Any abort stops the whole run before the first write.
 * @param {{ userDeleted: boolean, d16Deleted?: boolean, original: 'present'|'absent'|'changed',
 *           copy: 'identical'|'absent'|'different', rowsPointAtCopy: number }} s
 * @returns {{ action: 'remove'|'skip-absent'|'skip-d16-deleted'|'abort', removeCopy: boolean,
 *             removeOriginal: boolean, reason?: string }}
 */
export function removeCopyDecision(s) {
    const none = { removeCopy: false, removeOriginal: false };
    /** @param {string} reason */
    const abort = (reason) => ({ action: /** @type {const} */ ('abort'), ...none, reason });
    if (s.d16Deleted) return { action: 'skip-d16-deleted', ...none };
    if (s.copy === 'different') return abort('the copy no longer matches the manifest');
    if (s.copy === 'identical' && s.rowsPointAtCopy > 0) {
        return abort(`${s.rowsPointAtCopy} documents row(s) still point at the copy (revert the 0066 relink first)`);
    }
    if (s.userDeleted) {
        if (s.original === 'changed') return abort('the root-level object under this name is not the one in the manifest');
        const removeCopy = s.copy === 'identical';
        const removeOriginal = s.original === 'present';
        return removeCopy || removeOriginal ? { action: 'remove', removeCopy, removeOriginal } : { action: 'skip-absent', ...none };
    }
    if (s.copy === 'absent') return { action: 'skip-absent', ...none };
    if (s.original === 'changed') return abort('the root-level object under this name is not the one in the manifest');
    if (s.original !== 'present') return abort('the original is not in place (run --phase=restore first)');
    return { action: 'remove', removeCopy: true, removeOriginal: false };
}

/**
 * remove-copies --unreferenced-only (owner decision D16, runbook step 8b,
 * after delete-originals), per manifest entry: deletes for good the copy of
 * an object no documents row had at plan time. Only entries with
 * row_ids = [] that are not deleted by a user; the original must be gone
 * already (delete-originals), the copy must match the manifest's sha256 and
 * no documents row may name it. Any abort stops the whole run before the
 * first write. 'mark' completes an interrupted run: the copy of an entry whose
 * removal had started (d16_delete_started_at) is already gone.
 * @param {{ rowIds: number, userDeleted: boolean, d16Deleted: boolean, d16Started: boolean,
 *           original: 'present'|'absent'|'changed', copy: 'identical'|'absent'|'different',
 *           rowsPointAtCopy: number }} s
 * @returns {{ action: 'remove'|'mark'|'skip-referenced'|'skip-user-deleted'|'skip-done'|'abort', reason?: string }}
 */
export function d16Decision(s) {
    if (s.rowIds > 0) return { action: 'skip-referenced' };
    if (s.userDeleted) return { action: 'skip-user-deleted' };
    if (s.d16Deleted) return { action: 'skip-done' };
    if (s.original === 'changed') {
        return { action: 'abort', reason: 'the root-level object under this name is not the one in the manifest' };
    }
    if (s.original === 'present') {
        return { action: 'abort', reason: 'the original is still in place (D16 comes after delete-originals)' };
    }
    if (s.copy === 'different') return { action: 'abort', reason: 'the copy differs from the manifest' };
    if (s.copy === 'absent') {
        return s.d16Started ? { action: 'mark' } : { action: 'abort', reason: 'the copy is missing (verify fails on it); a human looks' };
    }
    if (s.rowsPointAtCopy > 0) return { action: 'abort', reason: `${s.rowsPointAtCopy} documents row(s) name the copy` };
    return { action: 'remove' };
}

/** @param {Uint8Array} buf */
export function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/** @param {string|null|undefined} hex */
export function shortSha(hex) {
    return typeof hex === 'string' ? hex.slice(0, 12) : '-';
}

/**
 * Replaces every known object name (raw and URL-encoded forms) in a message
 * with "<object #i>": Storage and PostgREST errors may echo a key, and the
 * script never prints names.
 * @param {string[]} names in manifest order
 */
export function makeRedactor(names) {
    /** @type {[string, string][]} */
    const pairs = [];
    names.forEach((name, i) => {
        if (!name) return;
        const label = `<object #${i + 1}>`;
        const forms = new Set([name, encodeObjectPath(name), encodeURIComponent(name), encodeURI(name)]);
        for (const form of forms) pairs.push([form, label]);
    });
    pairs.sort((a, b) => b[0].length - a[0].length);
    /** @param {unknown} text */
    return (text) => {
        let s = String(text ?? '');
        for (const [form, label] of pairs) s = s.split(form).join(label);
        return s;
    };
}

/** null/undefined, or a string Date.parse understands. @param {unknown} v */
const isTimeOrNull = (v) => v == null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));

/**
 * The manifest belongs to this project, bucket and seed org, and has the
 * fields every later phase relies on.
 * @param {any} m
 * @param {{ ref: string }} expected
 */
export function manifestProblems(m, expected) {
    /** @type {string[]} */
    const problems = [];
    if (!m || m.kind !== MANIFEST_KIND || m.version !== MANIFEST_VERSION) return ['not a manifest of this script'];
    if (m.project_ref !== expected.ref) problems.push(`it was made for project ${m.project_ref}`);
    if (m.bucket !== BUCKET) problems.push('it is for another bucket');
    if (m.seed_org_id !== SEED_ORG_ID) problems.push('it is for another org');
    if (!isTimeOrNull(m.soak_started_at)) problems.push('its soak_started_at is not a time');
    if (!Array.isArray(m.objects)) return [...problems, 'it has no object list'];
    m.objects.forEach((/** @type {any} */ o, /** @type {number} */ i) => {
        const ok =
            o &&
            o.index === i + 1 &&
            typeof o.id === 'string' &&
            UUID_RE.test(o.id) &&
            isRootObjectName(o.name) &&
            o.dest === destinationFor(o.name, SEED_ORG_ID) &&
            Number.isInteger(o.size) &&
            typeof o.sha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(o.sha256) &&
            Array.isArray(o.row_ids) &&
            // Exactly the form the plan writes: a manifest entry can never point
            // restore at a file outside --out/backup.
            o.backup_file === backupFileFor(i + 1, o.id) &&
            isTimeOrNull(o.user_deleted_at) &&
            isTimeOrNull(o.d16_deleted_at) &&
            isTimeOrNull(o.d16_delete_started_at);
        if (!ok) problems.push(`object entry ${i + 1} is incomplete`);
    });
    return problems;
}

/**
 * The backup file of manifest entry `index` (1-based), relative to --out.
 * @param {number} index
 * @param {string} id object id
 */
export function backupFileFor(index, id) {
    return path.posix.join('backup', `${String(index).padStart(2, '0')}-${id}.bin`);
}

/**
 * The only per-object log line format: index, object id, size and a sha256
 * prefix, never a name.
 * @param {{ index: number, id: string, size: number, sha256?: string|null }} o
 * @param {number} total
 * @param {string} text
 */
export function logLine(o, total, text) {
    const width = String(total).length;
    return `[${String(o.index).padStart(width, '0')}/${total}] id=${o.id} size=${o.size} sha256=${shortSha(o.sha256)} ${text}`;
}
