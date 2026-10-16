// One-off: move the legacy root-level objects of bucket `documents` under the
// seed org's folder (tracker 1.12, audit KEA-4, owner decisions D16/D17;
// migration 0066).
//
// Why: the 0038 storage policy resolved an object without a folder to the
// seed org (COALESCE). 0066 replaces it with the uuid CASE guard of 0058, so a
// root-level object becomes unreachable for every user. Before that, each
// legacy object gets a byte-identical copy at "<seed org>/<same name>" (this
// script), and 0066 relinks the documents rows (metadata.source) to it.
//
// Storage API only, with the service-role key (it bypasses Storage RLS).
// Never move or rename objects with SQL: storage.objects is the Storage API's
// metadata, and a renamed row points at bytes that stay at the old key.
//
// Runbook (order, expected numbers, owner approvals, rollback):
// docs/RUNBOOK_LEGACY_KB_OBJECTS.md. Every writing phase is a dry-run
// without --confirm:
//
//   node --env-file=.env.local scripts/migrate-legacy-kb-objects.mjs \
//       --phase=plan --expect-ref=<project ref> --out=<dir outside the repo>
//                                      once per bucket: a bucket already copied
//                                      is refused (recover the manifest
//                                      instead; --allow-replan overrides)
//   ... --phase=copy [--confirm]       copy each object, check size, type, sha256
//   ... --phase=verify                 re-hash every copy (Storage read-only);
//                                      once 0066 is in effect it records the
//                                      start of the soak in manifest.json, and
//                                      clears it if 0066 was reverted
//   ... --phase=delete-originals [--confirm] [--only-user-deleted]
//                                      --soak-hours below 72 only on a local
//                                      stack (or with --allow-short-soak)
//   ... --phase=restore [--confirm]    put missing originals back
//   ... --phase=remove-copies [--confirm]
//                                      rollback while the originals are in
//                                      place: remove exactly the manifest
//                                      copies (and what is left of KB entries
//                                      deleted by a user)
//   ... --phase=remove-copies --unreferenced-only [--confirm]
//                                      D16 (after delete-originals): remove the
//                                      copies of objects no row had at plan time
//
// Safety rails: refuses when the project ref of NEXT_PUBLIC_SUPABASE_URL is
// not --expect-ref, when the key is not a service-role key, and when --out is
// inside a git working tree. Logs only index, object id, size and a sha256
// prefix, never an object name. --out receives manifest.json (names, object
// ids, documents row ids, sha256) and backup/ (the bytes): business
// documents, to be deleted after the agreed window (UU PDP).
//
// A KB entry deleted in the dashboard during the soak (all of its documents
// rows gone) counts as deleted by the user: its bytes are never copied or
// restored again, and delete-originals removes its original too. The soak
// counts from the first verify that sees 0066 in effect, not from the copy.
//
// Exit codes: 0 = ok, 1 = a check failed or the run stopped, 2 = usage or a
// safety rail (nothing was done).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
    BUCKET,
    MANIFEST_KIND,
    MANIFEST_VERSION,
    SEED_ORG_ID,
    UUID_RE,
    WRITE_PHASES,
    analyseRows,
    backupFileFor,
    copyDecision,
    d16Decision,
    deleteOriginalDecision,
    deleteOriginalsBlockers,
    destinationFor,
    encodeObjectPath,
    keyRole,
    logLine,
    makeRedactor,
    manifestProblems,
    metadataText,
    outDirProblem,
    parseArgs,
    planDisposition,
    projectRefFromUrl,
    removeCopyDecision,
    replanCheck,
    restoreDecision,
    rowState,
    sha256Hex,
    soakHoursProblem,
    soakInterrupted,
    soakRemainingHours,
    soakStartReady,
    soakSummary,
    verifyStatus,
} from './lib/legacy-kb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 1000;
const USAGE =
    'Usage: node --env-file=.env.local scripts/migrate-legacy-kb-objects.mjs ' +
    '--phase=<plan|copy|verify|delete-originals|restore|remove-copies> --expect-ref=<project ref> ' +
    '--out=<dir outside the repo> [--confirm] [--soak-hours=<n>] [--allow-short-soak] [--only-user-deleted] ' +
    '[--unreferenced-only] [--allow-replan]';

class Stop extends Error {
    /** @param {number} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** @param {number} code @param {string} message @returns {never} */
function stop(code, message) {
    throw new Stop(code, message);
}

/** Replaced by a redactor as soon as the object names are known. */
let redact = (/** @type {unknown} */ text) => String(text ?? '');

/** @param {any} error */
function errText(error) {
    if (!error) return 'unknown error';
    const status = error.statusCode ?? error.status ?? '';
    return redact(`${status ? `${status} ` : ''}${error.message ?? error}`);
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Storage / database access (service role)
// ---------------------------------------------------------------------------

/** @param {import('@supabase/supabase-js').SupabaseClient} sb */
const bucket = (sb) => sb.storage.from(BUCKET);

/**
 * Files (by name, with id, size, mimetype) and sub-folder names directly
 * under `prefix` ('' = bucket root).
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} prefix
 */
async function listFolder(sb, prefix) {
    /** @type {Map<string, { id: string, size: number, mimetype: string|null }>} */
    const files = new Map();
    /** @type {string[]} */
    const folders = [];
    for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await bucket(sb).list(prefix, {
            limit: PAGE,
            offset,
            sortBy: { column: 'name', order: 'asc' },
        });
        if (error) stop(1, `listing ${prefix ? 'the seed folder' : 'the bucket root'} failed: ${errText(error)}`);
        for (const e of data ?? []) {
            if (e.id) {
                files.set(e.name, {
                    id: e.id,
                    size: Number(e.metadata?.size),
                    mimetype: e.metadata?.mimetype ?? null,
                });
            } else {
                folders.push(e.name);
            }
        }
        if (!data || data.length < PAGE) break;
    }
    return { files, folders };
}

/** @param {import('@supabase/supabase-js').SupabaseClient} sb @param {string} key */
async function download(sb, key) {
    const { data, error } = await bucket(sb).download(encodeObjectPath(key));
    if (error || !data) return { error: error ?? new Error('empty download') };
    return { bytes: Buffer.from(await data.arrayBuffer()) };
}

/**
 * id, size and content type of one object: info(), completed from the
 * listing of its folder (the source of the manifest's values) for any field
 * info() does not return.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb @param {string} key
 */
async function objectInfo(sb, key) {
    const { data, error } = await bucket(sb).info(encodeObjectPath(key));
    if (error || !data) return { error: error ?? new Error('no info') };
    const d = /** @type {any} */ (data);
    let id = d.id ?? null;
    let size = Number(d.size ?? d.metadata?.size);
    let contentType = d.contentType ?? d.metadata?.mimetype ?? null;
    if (!id || !Number.isFinite(size) || !contentType) {
        const slash = key.lastIndexOf('/');
        const entry = (await listFolder(sb, slash < 0 ? '' : key.slice(0, slash))).files.get(key.slice(slash + 1));
        if (!entry) return { error: new Error('not in the listing of its folder') };
        id = id ?? entry.id;
        size = Number.isFinite(size) ? size : entry.size;
        contentType = contentType ?? entry.mimetype;
    }
    return { id, size, contentType };
}

/** @param {import('@supabase/supabase-js').SupabaseClient} sb @param {string} key */
async function objectExists(sb, key) {
    try {
        const { data } = await bucket(sb).exists(encodeObjectPath(key));
        return data === true;
    } catch (e) {
        stop(1, `exists() failed: ${errText(e)}`);
    }
}

/**
 * Every documents row (id, org, metadata), paged.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @returns {Promise<import('./lib/legacy-kb.mjs').DocRow[]>}
 */
async function fetchDocumentRows(sb) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb
            .from('documents')
            .select('id, org_id, metadata')
            .order('id')
            .range(from, from + PAGE - 1);
        if (error) stop(1, `reading public.documents failed: ${errText(error)}`);
        rows.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
    }
    return rows;
}

/** One read of everything a phase decides on. @param {Ctx} ctx */
async function snapshot(ctx) {
    const root = await listFolder(ctx.sb, '');
    const seed = await listFolder(ctx.sb, SEED_ORG_ID);
    const rows = await fetchDocumentRows(ctx.sb);
    return { root, seed, rows, live: new Set(rows.map((r) => r.id)) };
}

/**
 * Size, content type and sha256 of a stored object against the manifest.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} key
 * @param {ManifestObject} o
 */
async function checkStored(sb, key, o) {
    const inf = await objectInfo(sb, key);
    if (inf.error) return { ok: false, reason: `info failed: ${errText(inf.error)}` };
    if (inf.size !== o.size) return { ok: false, reason: `size ${inf.size} instead of ${o.size}` };
    if ((inf.contentType ?? null) !== (o.mimetype ?? null)) {
        return { ok: false, reason: `content type ${inf.contentType} instead of ${o.mimetype}` };
    }
    const r = await download(sb, key);
    if (r.error) return { ok: false, reason: `download failed: ${errText(r.error)}` };
    if (r.bytes.length !== o.size || sha256Hex(r.bytes) !== o.sha256) return { ok: false, reason: 'sha256 differs' };
    return { ok: true, id: inf.id };
}

// ---------------------------------------------------------------------------
// Manifest and backup (in --out)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   index: number, id: string, name: string, dest: string, size: number,
 *   mimetype: string|null, sha256: string, backup_file: string,
 *   row_ids: string[], row_old_source: string|null, row_org_id: string|null,
 *   plan_dest_state: string,
 *   copy: { id: string|null, copied_at: string|null, verified_at: string|null, deleted_at?: string|null },
 *   original_deleted_at: string|null,
 *   restored: { at: string, from: string, id: string|null }[],
 *   user_deleted_at: string|null,
 *   d16_delete_started_at?: string|null, d16_deleted_at?: string|null,
 * }} ManifestObject
 * @typedef {{ sb: import('@supabase/supabase-js').SupabaseClient, ref: string, out: string,
 *   confirm: boolean, soakHours: number, phase: string, onlyUserDeleted: boolean,
 *   unreferencedOnly: boolean, allowReplan: boolean }} Ctx
 */

/** @param {Ctx} ctx */
const manifestPath = (ctx) => path.join(ctx.out, 'manifest.json');

/** @param {Ctx} ctx */
function loadManifest(ctx) {
    const p = manifestPath(ctx);
    if (!fs.existsSync(p)) stop(2, 'no manifest.json in --out: run --phase=plan first, with the same --out');
    let m;
    try {
        m = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        stop(2, 'manifest.json is not valid JSON');
    }
    const problems = manifestProblems(m, { ref: ctx.ref });
    if (problems.length) stop(2, `manifest.json refused: ${problems.join('; ')}`);
    redact = makeRedactor(m.objects.map((/** @type {ManifestObject} */ o) => o.name));
    return m;
}

/** Atomic rewrite, so an interrupted run never leaves half a manifest. @param {Ctx} ctx @param {any} m */
function saveManifest(ctx, m) {
    const p = manifestPath(ctx);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, p);
}

/** @param {any} m @param {Record<string, unknown>} entry */
function addLog(m, entry) {
    m.log = [...(m.log ?? []), { at: nowIso(), ...entry }];
}

/** @param {Ctx} ctx @param {ManifestObject} o */
function readBackup(ctx, o) {
    const p = path.join(ctx.out, o.backup_file);
    if (!fs.existsSync(p)) return null;
    const bytes = fs.readFileSync(p);
    return bytes.length === o.size && sha256Hex(bytes) === o.sha256 ? bytes : null;
}

/** Ids the original has had (the planned one, then each restore). @param {ManifestObject} o */
const knownIds = (o) => [o.id, ...(o.restored ?? []).map((r) => r.id).filter(Boolean)];

/**
 * @param {ManifestObject} o
 * @param {Map<string, { id: string }>} rootFiles
 * @returns {'present'|'absent'|'changed'}
 */
function originalState(o, rootFiles) {
    const entry = rootFiles.get(o.name);
    if (!entry) return 'absent';
    return knownIds(o).includes(entry.id) ? 'present' : 'changed';
}

/**
 * The copy under the seed folder: absent, identical to the manifest, or
 * different.
 * @param {Ctx} ctx @param {ManifestObject} o @param {Map<string, unknown>} seedFiles
 * @returns {Promise<'absent'|'identical'|'different'>}
 */
async function copyState(ctx, o, seedFiles) {
    if (!seedFiles.has(o.name)) return 'absent';
    const c = await checkStored(ctx.sb, o.dest, o);
    return c.ok ? 'identical' : 'different';
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** plan: read-only for Supabase; writes manifest.json + backup/ to --out. @param {Ctx} ctx */
async function phasePlan(ctx) {
    if (fs.existsSync(manifestPath(ctx))) {
        stop(2, 'manifest.json already exists in --out. Every later phase relies on the manifest of the ' +
            'first plan (it records which documents rows each object had); use a new --out to plan again.');
    }
    const snap = await snapshot(ctx);
    const names = [...snap.root.files.keys()].sort();
    redact = makeRedactor(names);
    const total = names.length;
    const { byName, rowsAtRoot, rowsOnCopy, counts } = analyseRows(snap.rows, new Set(names));
    const nonUuidFolders = snap.root.folders.filter((f) => !UUID_RE.test(f)).length;
    const uuidFolders = snap.root.folders.length - nonUuidFolders;

    /** @type {ManifestObject[]} */
    const objects = [];
    /** @type {Buffer[]} */
    const buffers = [];
    /** @type {string[]} */
    const problems = [];
    const dest = { absent: 0, identical: 0, different: 0 };
    for (const [i, name] of names.entries()) {
        const entry = /** @type {{ id: string, size: number, mimetype: string|null }} */ (snap.root.files.get(name));
        const destKey = destinationFor(name, SEED_ORG_ID);
        const base = { index: i + 1, id: entry.id, size: entry.size };
        if (!destKey) {
            problems.push(logLine(base, total, 'has a name the script refuses (control characters, backslash or too long)'));
            continue;
        }
        const r = await download(ctx.sb, name);
        if (r.error) stop(1, logLine(base, total, `download failed: ${errText(r.error)}`));
        const bytes = /** @type {Buffer} */ (r.bytes);
        const sha = sha256Hex(bytes);
        if (Number.isFinite(entry.size) && entry.size !== bytes.length) {
            problems.push(logLine(base, total, `the listing says ${entry.size} bytes, the download has ${bytes.length}`));
        }
        /** @type {'absent'|'identical'|'different'} */
        let destState = 'absent';
        if (snap.seed.files.has(name)) {
            const d = await download(ctx.sb, destKey);
            if (d.error) stop(1, logLine(base, total, `destination download failed: ${errText(d.error)}`));
            const db = /** @type {Buffer} */ (d.bytes);
            destState = db.length === bytes.length && sha256Hex(db) === sha ? 'identical' : 'different';
        }
        dest[destState]++;
        const rowIds = byName.get(name) ?? [];
        /** @type {ManifestObject} */
        const o = {
            index: i + 1,
            id: entry.id,
            name,
            dest: destKey,
            size: bytes.length,
            mimetype: entry.mimetype,
            sha256: sha,
            backup_file: backupFileFor(i + 1, entry.id),
            row_ids: rowIds,
            row_old_source: rowIds.length ? name : null,
            row_org_id: rowIds.length ? SEED_ORG_ID : null,
            plan_dest_state: destState,
            copy: { id: null, copied_at: null, verified_at: null },
            original_deleted_at: null,
            restored: [],
            user_deleted_at: null,
        };
        if (destState === 'different') {
            problems.push(logLine(o, total, 'its destination already exists with DIFFERENT content'));
        }
        objects.push(o);
        buffers.push(bytes);
        console.log(logLine(o, total, `mime=${o.mimetype ?? '-'} rows=${rowIds.length} dest=${destState}`));
    }

    // A bucket the copy phase has run on must not be planned again (see
    // replanCheck); with --allow-replan each object is classified, and a copy
    // that vanished after 0066 marks its KB entry deleted by a user.
    const replan = replanCheck({
        relinked: counts.relinked,
        rootSource: counts.rootSource,
        identicalCopies: dest.identical,
        allowReplan: ctx.allowReplan,
    });
    problems.push(...replan.problems);
    for (const o of objects) {
        const disposition = planDisposition({
            stage: replan.stage,
            destState: /** @type {'absent'|'identical'|'different'} */ (o.plan_dest_state),
            rowsAtRoot: rowsAtRoot.get(o.name) ?? 0,
            rowsOnCopy: rowsOnCopy.get(o.name) ?? 0,
        });
        if (disposition === 'user-deleted') {
            o.user_deleted_at = nowIso();
            console.log(logLine(o, total, 'no copy after 0066: its KB entry was deleted by a user (never copied again)'));
        } else if (disposition === 'copy-missing') {
            problems.push(logLine(o, total, 'documents rows name its copy, which does not exist'));
        } else if (disposition === 'ambiguous') {
            problems.push(logLine(o, total, 'no copy and no row in a bucket that was already copied: a human decides'));
        }
    }

    const bytesTotal = objects.reduce((s, o) => s + o.size, 0);
    console.log('');
    console.log(`copy stage         : ${replan.stage}`);
    console.log(`root-level objects : ${total} (${bytesTotal} bytes, ${new Set(objects.map((o) => o.sha256)).size} distinct sha256)`);
    console.log(`root-level folders : ${snap.root.folders.length} (uuid ${uuidFolders}, not uuid ${nonUuidFolders})`);
    console.log(`destinations       : ${dest.absent} absent, ${dest.identical} identical, ${dest.different} different`);
    console.log(`documents rows     : ${counts.total} total; file-backed ${counts.fileBacked} ` +
        `(root source ${counts.rootSource}, relinked ${counts.relinked} -> ${counts.referencedObjects} object(s), ` +
        `already prefixed ${counts.prefixed}, blocking ${counts.blocking}); editor ${counts.editor} ` +
        `(source without '/': ${counts.editorRootSource}); other ${counts.other}`);
    console.log(`objects with rows  : ${objects.filter((o) => o.row_ids.length).length} (rows ${objects.reduce((s, o) => s + o.row_ids.length, 0)}), ` +
        `without rows ${objects.filter((o) => !o.row_ids.length).length}`);

    if (nonUuidFolders) problems.push(`${nonUuidFolders} root-level folder(s) are not a uuid: the 0066 guard refuses while any object sits there`);
    if (counts.blocking) {
        problems.push(`${counts.blocking} file-backed documents row(s) cannot be relinked by 0066 ` +
            `(root source of another org: ${counts.rootSourceOtherOrg}, root source naming no object: ` +
            `${counts.rootSourceDangling}, outside the row's org folder: ${counts.outsideOrgFolder})`);
    }
    if (problems.length) {
        stop(1, `plan refused, nothing was written:\n  - ${problems.join('\n  - ')}`);
    }

    fs.mkdirSync(path.join(ctx.out, 'backup'), { recursive: true, mode: 0o700 });
    objects.forEach((o, i) => fs.writeFileSync(path.join(ctx.out, o.backup_file), buffers[i], { mode: 0o600 }));
    const manifest = {
        kind: MANIFEST_KIND,
        version: MANIFEST_VERSION,
        project_ref: ctx.ref,
        bucket: BUCKET,
        seed_org_id: SEED_ORG_ID,
        planned_at: nowIso(),
        plan_stage: replan.stage,
        row_counts: counts,
        objects,
        log: [],
    };
    addLog(manifest, { phase: 'plan', objects: total, bytes: bytesTotal });
    saveManifest(ctx, manifest);
    console.log(`\nmanifest.json and backup/ (${objects.length} file(s), ${bytesTotal} bytes) written to --out.`);
    console.log('Review the counts above before running --phase=copy --confirm.');
}

/** copy: Storage writes with --confirm; never writes the database. @param {Ctx} ctx */
async function phaseCopy(ctx) {
    const m = loadManifest(ctx);
    const total = m.objects.length;
    const snap = await snapshot(ctx);
    const known = new Set(m.objects.map((/** @type {ManifestObject} */ o) => o.name));
    const unknown = [...snap.root.files.keys()].filter((n) => !known.has(n)).length;
    if (unknown) {
        stop(1, `${unknown} root-level object(s) are not in the manifest (created after the plan?): ` +
            'nothing was copied; plan again with a new --out');
    }

    // Decide every object before the first write.
    /** @type {{ o: ManifestObject, action: string, reason?: string }[]} */
    const decisions = [];
    for (const o of /** @type {ManifestObject[]} */ (m.objects)) {
        const rows = rowState(o.row_ids, snap.live);
        const dest = await copyState(ctx, o, snap.seed.files);
        const original = originalState(o, snap.root.files);
        const d = copyDecision({
            rows, userDeleted: Boolean(o.user_deleted_at), d16Deleted: Boolean(o.d16_deleted_at), dest, original,
        });
        decisions.push({ o, ...d });
        console.log(logLine(o, total, `rows=${rows} dest=${dest} original=${original} -> ${d.action}${d.reason ? ` (${d.reason})` : ''}`));
    }
    const count = (/** @type {string} */ a) => decisions.filter((d) => d.action === a).length;
    console.log(`\nto copy ${count('copy')}, identical already ${count('skip-identical')}, ` +
        `deleted by the user ${count('skip-user-deleted')}, removed under D16 ${count('skip-d16-deleted')}, ` +
        `need a human ${count('abort')}`);
    if (count('abort')) stop(1, 'copy stopped before any write: see the objects marked abort above');
    if (!ctx.confirm) {
        console.log('(dry-run: nothing copied. Add --confirm to copy.)');
        return;
    }

    for (const d of decisions) {
        const o = d.o;
        if (d.action === 'skip-user-deleted') {
            if (!o.user_deleted_at) {
                o.user_deleted_at = nowIso();
                saveManifest(ctx, m);
            }
            continue;
        }
        if (d.action === 'skip-d16-deleted') continue;
        if (d.action === 'skip-identical') {
            if (!o.copy.verified_at) {
                o.copy = { ...o.copy, id: snap.seed.files.get(o.name)?.id ?? o.copy.id, verified_at: nowIso() };
                saveManifest(ctx, m);
            }
            continue;
        }
        const { error } = await bucket(ctx.sb).copy(o.name, o.dest);
        if (error) stop(1, logLine(o, total, `copy failed: ${errText(error)}`));
        const c = await checkStored(ctx.sb, o.dest, o);
        if (!c.ok) {
            // Remove only the copy this run has just made, so a re-run can try again.
            const { error: rmError } = await bucket(ctx.sb).remove([o.dest]);
            stop(1, logLine(o, total, `the new copy does not match the manifest (${c.reason}); ` +
                (rmError ? `removing it failed too: ${errText(rmError)}` : 'it was removed again')));
        }
        const at = nowIso();
        o.copy = { id: c.id ?? null, copied_at: at, verified_at: at };
        saveManifest(ctx, m);
        console.log(logLine(o, total, 'copied; size, content type and sha256 verified'));
    }
    addLog(m, { phase: 'copy', copied: count('copy'), identical: count('skip-identical'), user_deleted: count('skip-user-deleted') });
    saveManifest(ctx, m);
    console.log('\ncopy done. Next: --phase=verify, then migration 0066.');
}

/**
 * Re-hashes every copy and reports originals and rows. Read-only.
 * @param {Ctx} ctx @param {any} m @param {Awaited<ReturnType<typeof snapshot>>} snap
 */
async function runVerify(ctx, m, snap) {
    const total = m.objects.length;
    const byId = new Map(snap.rows.map((r) => [r.id, r]));
    const res = {
        ok: 0, userDeleted: 0, d16Deleted: 0, failures: 0, failuresUserDeleted: 0, originals: 0,
        rowsLive: 0, rowsRelinked: 0, rowsRoot: 0,
    };
    for (const o of /** @type {ManifestObject[]} */ (m.objects)) {
        const rows = rowState(o.row_ids, snap.live);
        const userDeleted = Boolean(o.user_deleted_at) || rows === 'user-deleted';
        const d16Deleted = Boolean(o.d16_deleted_at);
        const copy = userDeleted || d16Deleted
            ? (snap.seed.files.has(o.name) ? 'present' : 'absent')
            : await copyState(ctx, o, snap.seed.files);
        const status = verifyStatus({
            rows, userDeleted, d16Deleted, d16Started: Boolean(o.d16_delete_started_at),
            copy: copy === 'present' ? 'identical' : copy,
        });
        const original = originalState(o, snap.root.files);
        let live = 0;
        let relinked = 0;
        let root = 0;
        for (const id of o.row_ids) {
            const row = byId.get(id);
            if (!row) continue;
            live++;
            const src = metadataText(row.metadata, 'source');
            if (src === o.dest) relinked++;
            else if (src === o.name) root++;
        }
        res.rowsLive += live;
        res.rowsRelinked += relinked;
        res.rowsRoot += root;
        if (original !== 'absent') res.originals++;
        if (status === 'ok') res.ok++;
        else if (status === 'user-deleted') res.userDeleted++;
        else if (status === 'd16-deleted') res.d16Deleted++;
        else {
            res.failures++;
            if (userDeleted) res.failuresUserDeleted++;
        }
        console.log(logLine(o, total, `copy=${copy} original=${original} rows=${live}/${o.row_ids.length} ` +
            `(relinked ${relinked}, root ${root}) -> ${status}`));
    }
    console.log(`\ncopies ok ${res.ok}, deleted by the user ${res.userDeleted}, removed under D16 ${res.d16Deleted}, ` +
        `failed ${res.failures}; originals still present ${res.originals}; manifest rows live ${res.rowsLive} ` +
        `(relinked ${res.rowsRelinked}, still root ${res.rowsRoot})`);
    return res;
}

/**
 * verify: read-only for Supabase. The first time it sees 0066 in effect (every
 * live manifest row on its copy, no file-backed row left at the root) it
 * records the start of the soak in manifest.json; delete-originals counts the
 * soak from there.
 * @param {Ctx} ctx
 */
async function phaseVerify(ctx) {
    const m = loadManifest(ctx);
    const snap = await snapshot(ctx);
    const res = await runVerify(ctx, m, snap);
    // 0066 no longer in effect (a rollback reverted the relink): the originals
    // are needed again, so the soak starts over once 0066 is back.
    if (soakInterrupted({ soakStartedAt: m.soak_started_at, rows: snap.rows })) {
        console.log(`soak interrupted: file-backed rows name root-level objects again (it had started at ${m.soak_started_at}).`);
        addLog(m, { phase: 'verify', soak_interrupted: m.soak_started_at });
        m.soak_started_at = null;
        saveManifest(ctx, m);
    } else if (!m.soak_started_at && soakStartReady({ rows: snap.rows, objects: m.objects, verifyFailures: res.failures })) {
        m.soak_started_at = nowIso();
        addLog(m, { phase: 'verify', soak_started: true });
        saveManifest(ctx, m);
        console.log(`0066 is in effect: the soak starts now (${m.soak_started_at}).`);
    }
    console.log(soakSummary(m.soak_started_at, ctx.soakHours));
    if (res.failures) stop(1, `verify failed for ${res.failures} object(s)`);
    console.log('verify ok.');
}

/** delete-originals: Storage deletes with --confirm. @param {Ctx} ctx */
async function phaseDeleteOriginals(ctx) {
    const m = loadManifest(ctx);
    const total = m.objects.length;
    const snap = await snapshot(ctx);
    const v = await runVerify(ctx, m, snap);
    const blockers = deleteOriginalsBlockers({
        rows: snap.rows,
        objects: m.objects,
        verifyFailures: v.failures,
        verifyFailuresUserDeleted: v.failuresUserDeleted,
        soakStartedAt: m.soak_started_at,
        soakHoursLeft: soakRemainingHours(m.soak_started_at, ctx.soakHours),
        onlyUserDeleted: ctx.onlyUserDeleted,
    });
    console.log(soakSummary(m.soak_started_at, ctx.soakHours));
    if (ctx.onlyUserDeleted) console.log('--only-user-deleted: only KB entries deleted by a user are touched.');
    /** @type {{ o: ManifestObject, removeOriginal: boolean, removeCopy: boolean, recheckCopy: boolean, userDeleted: boolean }[]} */
    const work = [];
    for (const o of /** @type {ManifestObject[]} */ (m.objects)) {
        const userDeleted = Boolean(o.user_deleted_at) || rowState(o.row_ids, snap.live) === 'user-deleted';
        const d = deleteOriginalDecision({
            onlyUserDeleted: ctx.onlyUserDeleted,
            userDeleted,
            d16Deleted: Boolean(o.d16_deleted_at),
            original: originalState(o, snap.root.files),
            copyPresent: snap.seed.files.has(o.name),
        });
        if (d.action === 'refuse') {
            blockers.push(logLine(o, total, /** @type {string} */ (d.reason)));
            continue;
        }
        if (d.action === 'skip') continue;
        work.push({ o, userDeleted, removeOriginal: d.removeOriginal, removeCopy: d.removeCopy, recheckCopy: d.recheckCopy });
    }
    if (blockers.length) stop(1, `delete-originals refused, nothing was deleted:\n  - ${blockers.join('\n  - ')}`);

    for (const w of work) {
        const what = [w.removeOriginal && 'original', w.removeCopy && 'copy'].filter(Boolean).join(' + ') || 'nothing (already gone)';
        console.log(logLine(w.o, total, `${w.userDeleted ? 'deleted by the user: ' : ''}remove ${what}`));
    }
    const originals = work.filter((w) => w.removeOriginal).length;
    const copies = work.filter((w) => w.removeCopy).length;
    console.log(`\nto remove: ${originals} original(s), ${copies} copy/copies of KB entries deleted by the user`);
    if (!ctx.confirm) {
        console.log('(dry-run: nothing deleted. Add --confirm to delete.)');
        return;
    }

    for (const w of work) {
        const o = w.o;
        if (w.userDeleted && !o.user_deleted_at) o.user_deleted_at = nowIso();
        if (w.recheckCopy) {
            // Re-check the copy right before its original goes.
            const c = await checkStored(ctx.sb, o.dest, o);
            if (!c.ok) stop(1, logLine(o, total, `the copy is no longer intact (${c.reason}); its original was kept and the run stopped`));
        }
        for (const [flag, key, label] of /** @type {[boolean, string, string][]} */ ([
            [w.removeOriginal, o.name, 'original'],
            [w.removeCopy, o.dest, 'copy'],
        ])) {
            if (!flag) continue;
            const { error } = await bucket(ctx.sb).remove([key]);
            if (error) stop(1, logLine(o, total, `removing the ${label} failed: ${errText(error)}`));
            if (await objectExists(ctx.sb, key)) stop(1, logLine(o, total, `the ${label} still exists after remove()`));
            if (label === 'original') o.original_deleted_at = nowIso();
            else o.copy = { ...o.copy, deleted_at: nowIso() };
            saveManifest(ctx, m);
            console.log(logLine(o, total, `${label} removed; exists() = false`));
        }
        saveManifest(ctx, m);
    }
    addLog(m, { phase: 'delete-originals', originals, user_deleted_copies: copies, only_user_deleted: ctx.onlyUserDeleted });
    saveManifest(ctx, m);
    console.log(ctx.onlyUserDeleted
        ? '\ndelete-originals --only-user-deleted done. Continue with the next rollback step of the runbook.'
        : '\ndelete-originals done. Run the final check of the runbook (step 8).');
}

/**
 * Removes one key through the Storage API and proves it is gone.
 * @param {Ctx} ctx @param {ManifestObject} o @param {number} total @param {string} key @param {string} label
 */
async function removeKey(ctx, o, total, key, label) {
    const { error } = await bucket(ctx.sb).remove([key]);
    if (error) stop(1, logLine(o, total, `removing the ${label} failed: ${errText(error)}`));
    if (await objectExists(ctx.sb, key)) stop(1, logLine(o, total, `the ${label} still exists after remove()`));
    console.log(logLine(o, total, `${label} removed; exists() = false`));
}

/**
 * remove-copies. Storage writes with --confirm; never writes the database.
 * - default (rollback while the originals are in place, after the relink was
 *   reverted): removes exactly the manifest copies of live entries, and
 *   whatever is left of entries deleted by a user (copy and original). It
 *   clears the recorded soak start: copying again later restarts the soak.
 * - --unreferenced-only (owner decision D16, runbook step 8b, after
 *   delete-originals): removes for good the copies of the objects no
 *   documents row had at plan time, and marks them d16_deleted_at so verify,
 *   copy and restore leave them alone.
 * @param {Ctx} ctx
 */
async function phaseRemoveCopies(ctx) {
    const m = loadManifest(ctx);
    const total = m.objects.length;
    const snap = await snapshot(ctx);
    const byDest = new Map();
    for (const r of snap.rows) {
        const src = metadataText(r.metadata, 'source');
        if (src) byDest.set(src, (byDest.get(src) ?? 0) + 1);
    }
    if (ctx.unreferencedOnly) console.log('--unreferenced-only (D16): only copies of objects no documents row had at plan time.');
    /** @type {{ o: ManifestObject, action: string, reason?: string, removeCopy?: boolean, removeOriginal?: boolean, userDeleted: boolean }[]} */
    const decisions = [];
    for (const o of /** @type {ManifestObject[]} */ (m.objects)) {
        const userDeleted = Boolean(o.user_deleted_at) || rowState(o.row_ids, snap.live) === 'user-deleted';
        const copy = await copyState(ctx, o, snap.seed.files);
        const original = originalState(o, snap.root.files);
        const rowsPointAtCopy = byDest.get(o.dest) ?? 0;
        const d = ctx.unreferencedOnly
            ? d16Decision({
                rowIds: o.row_ids.length, userDeleted, d16Deleted: Boolean(o.d16_deleted_at),
                d16Started: Boolean(o.d16_delete_started_at), original, copy, rowsPointAtCopy,
            })
            : removeCopyDecision({ userDeleted, d16Deleted: Boolean(o.d16_deleted_at), original, copy, rowsPointAtCopy });
        decisions.push({ o, userDeleted, ...d });
        console.log(logLine(o, total, `copy=${copy} original=${original} -> ${d.action}${d.reason ? ` (${d.reason})` : ''}`));
    }
    const count = (/** @type {string} */ a) => decisions.filter((d) => d.action === a).length;
    console.log(`\nto remove ${count('remove')}, to mark ${count('mark')}, skipped ${decisions.length - count('remove') - count('mark') - count('abort')}, ` +
        `need a human ${count('abort')}`);
    if (count('abort')) stop(1, 'remove-copies stopped before any write: see the objects marked abort above');
    if (!ctx.confirm) {
        console.log('(dry-run: nothing removed. Add --confirm to remove.)');
        return;
    }
    for (const d of decisions) {
        const o = d.o;
        if (ctx.unreferencedOnly) {
            if (d.action === 'remove') {
                // Recorded first, so an interrupted run is completed ('mark') and
                // verify does not report the vanished copy as a plain failure.
                o.d16_delete_started_at = nowIso();
                saveManifest(ctx, m);
                await removeKey(ctx, o, total, o.dest, 'copy');
                o.copy = { ...o.copy, deleted_at: nowIso() };
            }
            if (d.action === 'remove' || d.action === 'mark') {
                o.d16_deleted_at = nowIso();
                saveManifest(ctx, m);
            }
            continue;
        }
        if (d.action !== 'remove') continue;
        if (d.userDeleted && !o.user_deleted_at) o.user_deleted_at = nowIso();
        if (d.removeCopy) {
            await removeKey(ctx, o, total, o.dest, 'copy');
            o.copy = { ...o.copy, deleted_at: nowIso() };
            saveManifest(ctx, m);
        }
        if (d.removeOriginal) {
            await removeKey(ctx, o, total, o.name, 'original');
            o.original_deleted_at = nowIso();
            saveManifest(ctx, m);
        }
    }
    if (!ctx.unreferencedOnly && m.soak_started_at) {
        // The copies are gone: a later copy (and 0066) needs a full soak again.
        addLog(m, { phase: 'remove-copies', soak_cleared: m.soak_started_at });
        m.soak_started_at = null;
        console.log('the recorded soak start was cleared (a later copy restarts the soak).');
    }
    addLog(m, { phase: 'remove-copies', unreferenced_only: ctx.unreferencedOnly, removed: count('remove'), marked: count('mark') });
    saveManifest(ctx, m);
    console.log('\nremove-copies done.');
}

/** restore: Storage writes with --confirm; never writes the database. @param {Ctx} ctx */
async function phaseRestore(ctx) {
    const m = loadManifest(ctx);
    const total = m.objects.length;
    const snap = await snapshot(ctx);
    /** @type {{ o: ManifestObject, action: string, reason?: string, userDeleted: boolean }[]} */
    const decisions = [];
    for (const o of /** @type {ManifestObject[]} */ (m.objects)) {
        const rows = rowState(o.row_ids, snap.live);
        const userDeleted = Boolean(o.user_deleted_at) || rows === 'user-deleted';
        const d16Deleted = Boolean(o.d16_deleted_at);
        const original = originalState(o, snap.root.files);
        const skipCopyCheck = userDeleted || d16Deleted || original !== 'absent';
        const copy = skipCopyCheck ? 'absent' : await copyState(ctx, o, snap.seed.files);
        const backupOk = !skipCopyCheck && readBackup(ctx, o) !== null;
        const d = restoreDecision({ rows, userDeleted, d16Deleted, original, copy, backupOk });
        decisions.push({ o, userDeleted, ...d });
        console.log(logLine(o, total, `original=${original} -> ${d.action}${d.reason ? ` (${d.reason})` : ''}`));
    }
    const count = (/** @type {string} */ a) => decisions.filter((d) => d.action === a).length;
    console.log(`\nfrom the copy ${count('from-copy')}, from the backup ${count('from-backup')}, ` +
        `present ${count('skip-present')}, deleted by the user (never restored) ${count('skip-user-deleted')}, ` +
        `removed under D16 (never restored) ${count('skip-d16-deleted')}, impossible ${count('abort')}`);
    if (count('abort')) stop(1, 'restore stopped before any write: see the objects marked abort above');
    if (!ctx.confirm) {
        console.log('(dry-run: nothing restored. Add --confirm to restore.)');
        return;
    }

    for (const d of decisions) {
        const o = d.o;
        if (d.action === 'skip-user-deleted') {
            if (!o.user_deleted_at) {
                o.user_deleted_at = nowIso();
                saveManifest(ctx, m);
            }
            continue;
        }
        if (d.action !== 'from-copy' && d.action !== 'from-backup') continue;
        if (d.action === 'from-copy') {
            const { error } = await bucket(ctx.sb).copy(o.dest, o.name);
            if (error) stop(1, logLine(o, total, `copying back failed: ${errText(error)}`));
        } else {
            const bytes = readBackup(ctx, o);
            if (!bytes) stop(1, logLine(o, total, 'the backup is no longer intact'));
            const { error } = await bucket(ctx.sb).upload(encodeObjectPath(o.name), bytes, {
                contentType: o.mimetype ?? 'application/octet-stream',
                upsert: false,
            });
            if (error) stop(1, logLine(o, total, `uploading the backup failed: ${errText(error)}`));
        }
        const c = await checkStored(ctx.sb, o.name, o);
        if (!c.ok) stop(1, logLine(o, total, `the restored original does not match the manifest (${c.reason})`));
        o.restored = [...(o.restored ?? []), { at: nowIso(), from: d.action === 'from-copy' ? 'copy' : 'backup', id: c.id ?? null }];
        o.original_deleted_at = null;
        saveManifest(ctx, m);
        console.log(logLine(o, total, `original restored ${d.action === 'from-copy' ? 'from the copy' : 'from the backup'}; size, content type and sha256 verified`));
    }
    addLog(m, { phase: 'restore', from_copy: count('from-copy'), from_backup: count('from-backup') });
    saveManifest(ctx, m);
    console.log('\nrestore done.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** --out with symlinks/junctions of its existing part resolved. @param {string} p */
function resolveOut(p) {
    const abs = path.resolve(p);
    let existing = abs;
    const tail = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        tail.unshift(path.basename(existing));
        existing = parent;
    }
    const real = fs.existsSync(existing) ? fs.realpathSync.native(existing) : existing;
    return path.join(real, ...tail);
}

async function main() {
    const { opts, errors } = parseArgs(process.argv.slice(2));
    if (errors.length) stop(2, `${errors.join('\n')}\n${USAGE}`);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        stop(2, 'Missing env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). Run with: ' +
            'node --env-file=.env.local scripts/migrate-legacy-kb-objects.mjs ...');
    }
    const ref = projectRefFromUrl(url);
    if (!ref) {
        stop(2, 'NEXT_PUBLIC_SUPABASE_URL is neither https://<ref>.supabase.co nor a local stack (http://127.0.0.1:<port>)');
    }
    if (ref !== opts.expectRef) {
        stop(2, `project ref mismatch: the env points at "${ref}", --expect-ref is "${opts.expectRef}"`);
    }
    const role = keyRole(key);
    if (role !== 'service_role' && role !== 'secret') {
        stop(2, `SUPABASE_SERVICE_ROLE_KEY is not a service-role key (${role}): Storage RLS would hide the objects`);
    }
    const soakProblem = soakHoursProblem({ soakHours: opts.soakHours, ref, allowShortSoak: opts.allowShortSoak });
    if (soakProblem) stop(2, soakProblem);
    const out = resolveOut(/** @type {string} */ (opts.out));
    const problem = outDirProblem(out, fs.existsSync(REPO_ROOT) ? fs.realpathSync.native(REPO_ROOT) : REPO_ROOT, (p) => fs.existsSync(p));
    if (problem) {
        stop(2, `--out refused: ${problem}. The backup holds business documents (UU PDP); keep it outside every repository.`);
    }
    if (fs.existsSync(out) && !fs.statSync(out).isDirectory()) stop(2, '--out exists and is not a directory');
    if (opts.phase === 'plan') fs.mkdirSync(out, { recursive: true, mode: 0o700 });

    const mode = opts.confirm ? 'CONFIRM (writes)' : WRITE_PHASES.has(opts.phase) ? 'dry-run (no writes)' : 'read-only';
    console.log(`migrate-legacy-kb-objects: phase=${opts.phase} mode=${mode} project=${ref} bucket=${BUCKET} seed=${SEED_ORG_ID}`);
    console.log(`out=${out}\n`);

    const sb = createClient(/** @type {string} */ (url), /** @type {string} */ (key), {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    /** @type {Ctx} */
    const ctx = {
        sb, ref, out, confirm: opts.confirm, soakHours: opts.soakHours, phase: opts.phase,
        onlyUserDeleted: opts.onlyUserDeleted, unreferencedOnly: opts.unreferencedOnly, allowReplan: opts.allowReplan,
    };
    const phases = {
        plan: phasePlan,
        copy: phaseCopy,
        verify: phaseVerify,
        'delete-originals': phaseDeleteOriginals,
        restore: phaseRestore,
        'remove-copies': phaseRemoveCopies,
    };
    await phases[/** @type {keyof typeof phases} */ (opts.phase)](ctx);
}

main().then(
    () => process.exit(0),
    (e) => {
        if (e instanceof Stop) {
            console.error(`\n${e.code === 2 ? 'REFUSED' : 'STOPPED'}: ${redact(e.message)}`);
            process.exit(e.code);
        }
        console.error(`\nSTOPPED: ${redact(e?.name ?? 'Error')}: ${redact(e?.message ?? e)}`);
        process.exit(1);
    }
);
