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
export const PHASES = ['plan', 'copy', 'verify', 'delete-originals', 'restore'];
/** Phases that change Storage when run with --confirm (dry-run without it). */
export const WRITE_PHASES = new Set(['copy', 'delete-originals', 'restore']);
export const DEFAULT_SOAK_HOURS = 72;
export const MANIFEST_KIND = 'sarathi-legacy-kb-objects';
export const MANIFEST_VERSION = 1;

/**
 * Command line: --phase=<p> --expect-ref=<ref> --out=<dir> [--confirm]
 * [--soak-hours=<n>]. Only the `--name=value` form, like the other scripts.
 * @param {string[]} argv process.argv.slice(2)
 */
export function parseArgs(argv) {
    const opts = {
        phase: 'plan',
        expectRef: /** @type {string|null} */ (null),
        out: /** @type {string|null} */ (null),
        confirm: false,
        soakHours: DEFAULT_SOAK_HOURS,
    };
    /** @type {string[]} */
    const errors = [];
    for (const arg of argv) {
        if (arg === '--confirm') {
            opts.confirm = true;
            continue;
        }
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
    if (!PHASES.includes(opts.phase)) errors.push(`--phase must be one of: ${PHASES.join(', ')}`);
    if (!opts.expectRef) errors.push('--expect-ref=<project ref> is required');
    if (!opts.out) errors.push('--out=<directory outside the repository> is required');
    if (opts.confirm && !WRITE_PHASES.has(opts.phase)) {
        errors.push(`--confirm is only accepted by the phases ${[...WRITE_PHASES].join(', ')}`);
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
 *   other: number, prefixed: number, rootSource: number, rootSourceOtherOrg: number,
 *   rootSourceDangling: number, outsideOrgFolder: number, blocking: number,
 *   referencedObjects: number,
 * }} RowCounts
 */

/**
 * Sorts the documents rows the way 0066 sees them.
 * - byName: root-level object name -> ids of the seed-org file-backed rows
 *   whose source is that name (0066 relinks exactly these).
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
    /** @type {RowCounts} */
    const counts = {
        total: rows.length,
        fileBacked: 0,
        editor: 0,
        editorRootSource: 0,
        other: 0,
        prefixed: 0,
        rootSource: 0,
        rootSourceOtherOrg: 0,
        rootSourceDangling: 0,
        outsideOrgFolder: 0,
        blocking: 0,
        referencedObjects: 0,
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
            counts.prefixed++;
        } else if (isRootSource(src)) {
            counts.rootSource++;
            if (row.org_id !== seedOrgId) counts.rootSourceOtherOrg++;
            else if (!rootNames.has(/** @type {string} */ (src))) counts.rootSourceDangling++;
            else {
                const ids = byName.get(/** @type {string} */ (src)) ?? [];
                ids.push(row.id);
                byName.set(/** @type {string} */ (src), ids);
            }
        } else {
            counts.outsideOrgFolder++;
        }
    }
    counts.blocking = counts.rootSourceOtherOrg + counts.rootSourceDangling + counts.outsideOrgFolder;
    counts.referencedObjects = byName.size;
    return { byName, counts };
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
 * copy phase, per object.
 * @param {{ rows: string, userDeleted: boolean, dest: 'absent'|'identical'|'different',
 *           original: 'present'|'absent'|'changed' }} s
 * @returns {{ action: 'copy'|'skip-identical'|'skip-user-deleted'|'abort', reason?: string }}
 */
export function copyDecision(s) {
    if (s.userDeleted || s.rows === 'user-deleted') return { action: 'skip-user-deleted' };
    if (s.rows === 'rows-partial') return { action: 'abort', reason: 'only some of its documents rows still exist' };
    if (s.dest === 'different') return { action: 'abort', reason: 'the destination exists with different content' };
    if (s.dest === 'identical') return { action: 'skip-identical' };
    if (s.original === 'changed') return { action: 'abort', reason: 'the original was replaced since the plan' };
    if (s.original === 'absent') return { action: 'abort', reason: 'the original is missing (run --phase=restore first)' };
    return { action: 'copy' };
}

/**
 * verify phase, per object.
 * @param {{ rows: string, userDeleted: boolean, copy: 'identical'|'absent'|'different' }} s
 */
export function verifyStatus(s) {
    if (s.userDeleted || s.rows === 'user-deleted') return 'user-deleted';
    if (s.rows === 'rows-partial') return 'fail: only some of its documents rows still exist';
    if (s.copy === 'absent') return 'fail: the copy is missing';
    if (s.copy === 'different') return 'fail: the copy differs from the manifest';
    return 'ok';
}

/**
 * restore phase, per object: puts a missing original back, from the copy
 * when it is intact, else from the byte backup. Never for a user-deleted one.
 * @param {{ rows: string, userDeleted: boolean, original: 'present'|'absent'|'changed',
 *           copy: 'identical'|'absent'|'different', backupOk: boolean }} s
 */
export function restoreDecision(s) {
    if (s.userDeleted || s.rows === 'user-deleted') return { action: 'skip-user-deleted' };
    if (s.original !== 'absent') return { action: 'skip-present' };
    if (s.copy === 'identical') return { action: 'from-copy' };
    if (s.backupOk) return { action: 'from-backup' };
    return { action: 'abort', reason: 'neither an intact copy nor an intact backup is left' };
}

/**
 * Hours of the soak still ahead. It counts from the last copy verification
 * (0066 is applied right after the copy phase); with no verification yet the
 * whole soak is ahead.
 * @param {{ copy?: { verified_at?: string|null } }[]} objects
 * @param {number} soakHours
 * @param {number} now epoch ms
 */
export function soakRemainingHours(objects, soakHours, now = Date.now()) {
    const times = objects
        .map((o) => o.copy?.verified_at)
        .filter((t) => typeof t === 'string')
        .map((t) => Date.parse(/** @type {string} */ (t)))
        .filter((t) => Number.isFinite(t));
    if (times.length === 0) return soakHours;
    const remainingMs = Math.max(...times) + soakHours * 3_600_000 - now;
    return remainingMs > 0 ? remainingMs / 3_600_000 : 0;
}

/**
 * Why delete-originals must not run yet ([] = go).
 * @param {{
 *   rows: DocRow[],
 *   objects: { dest: string, row_ids: string[], user_deleted_at?: string|null }[],
 *   verifyFailures: number,
 *   soakHoursLeft: number,
 * }} s
 */
export function deleteOriginalsBlockers(s) {
    /** @type {string[]} */
    const blockers = [];
    if (s.verifyFailures > 0) blockers.push(`verify failed for ${s.verifyFailures} object(s)`);
    // The critique fix: only file-backed rows count. Editor rows keep a
    // source without '/' (their title) forever.
    const stillRoot = s.rows.filter(
        (r) => isFileBackedRow(r.metadata) && isRootSource(metadataText(r.metadata, 'source'))
    ).length;
    if (stillRoot > 0) {
        blockers.push(`${stillRoot} file-backed documents row(s) still name a root-level object (apply 0066 first)`);
    }
    const byId = new Map(s.rows.map((r) => [r.id, r]));
    let notRelinked = 0;
    for (const o of s.objects) {
        if (o.user_deleted_at) continue;
        for (const id of o.row_ids) {
            const row = byId.get(id);
            if (row && metadataText(row.metadata, 'source') !== o.dest) notRelinked++;
        }
    }
    if (notRelinked > 0) blockers.push(`${notRelinked} manifest row(s) do not point at their copy`);
    if (s.soakHoursLeft > 0) {
        blockers.push(`the soak is not over: ${s.soakHoursLeft.toFixed(1)} h left (--soak-hours)`);
    }
    return blockers;
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
    if (!Array.isArray(m.objects)) return [...problems, 'it has no object list'];
    m.objects.forEach((/** @type {any} */ o, /** @type {number} */ i) => {
        const ok =
            o &&
            o.index === i + 1 &&
            typeof o.id === 'string' &&
            isRootObjectName(o.name) &&
            o.dest === destinationFor(o.name, SEED_ORG_ID) &&
            Number.isInteger(o.size) &&
            typeof o.sha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(o.sha256) &&
            Array.isArray(o.row_ids) &&
            typeof o.backup_file === 'string';
        if (!ok) problems.push(`object entry ${i + 1} is incomplete`);
    });
    return problems;
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
