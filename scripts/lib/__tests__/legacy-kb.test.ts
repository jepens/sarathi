import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOrgScopedObjectPath as appIsOrgScopedObjectPath } from '@/lib/storage/object-paths';
import {
    SEED_ORG_ID,
    analyseRows,
    copyDecision,
    deleteOriginalsBlockers,
    destinationFor,
    encodeObjectPath,
    isFileBackedRow,
    isOrgScopedObjectPath,
    isRootObjectName,
    keyRole,
    logLine,
    makeRedactor,
    manifestProblems,
    outDirProblem,
    parseArgs,
    projectRefFromUrl,
    restoreDecision,
    rowState,
    sha256Hex,
    soakRemainingHours,
    verifyStatus,
} from '../legacy-kb.mjs';

const SEED = SEED_ORG_ID;
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const NAME = '1764201000101_Profil Perusahaan, final.pdf';

const jwt = (payload: object) =>
    ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

describe('parseArgs', () => {
    it('reads the --name=value form and defaults to plan with a 72 h soak', () => {
        const { opts, errors } = parseArgs(['--expect-ref=abc', '--out=/x']);
        expect(errors).toEqual([]);
        expect(opts).toMatchObject({ phase: 'plan', expectRef: 'abc', out: '/x', confirm: false, soakHours: 72 });
    });

    it('accepts --confirm only for the writing phases', () => {
        expect(parseArgs(['--phase=copy', '--expect-ref=a', '--out=/x', '--confirm']).errors).toEqual([]);
        expect(parseArgs(['--phase=verify', '--expect-ref=a', '--out=/x', '--confirm']).errors).toHaveLength(1);
        expect(parseArgs(['--phase=plan', '--expect-ref=a', '--out=/x', '--confirm']).errors).toHaveLength(1);
    });

    it('requires --expect-ref and --out and refuses unknown arguments and phases', () => {
        const { errors } = parseArgs(['--phase=move', '--force', '--soak-hours=-1']);
        expect(errors.join('\n')).toMatch(/unknown argument: --force/);
        expect(errors.join('\n')).toMatch(/--phase must be one of/);
        expect(errors.join('\n')).toMatch(/--expect-ref/);
        expect(errors.join('\n')).toMatch(/--out/);
        expect(errors.join('\n')).toMatch(/--soak-hours/);
        expect(parseArgs(['--expect-ref=a', '--out=/x', '--soak-hours=0']).opts.soakHours).toBe(0);
    });
});

describe('projectRefFromUrl / keyRole', () => {
    it('derives the project ref from a cloud URL and a local stack URL only', () => {
        expect(projectRefFromUrl('https://abcdefghijklmnopqrst.supabase.co')).toBe('abcdefghijklmnopqrst');
        expect(projectRefFromUrl('http://127.0.0.1:58821')).toBe('local-58821');
        expect(projectRefFromUrl('http://localhost:54321/')).toBe('local-54321');
        expect(projectRefFromUrl('http://abcdefghijklmnopqrst.supabase.co')).toBeNull();
        expect(projectRefFromUrl('https://evil.example.com/abcdefghijklmnopqrst.supabase.co')).toBeNull();
        expect(projectRefFromUrl('https://abcdefghijklmnopqrst.supabase.co.evil.com')).toBeNull();
        expect(projectRefFromUrl('not a url')).toBeNull();
    });

    it('recognises service-role keys and refuses the others', () => {
        expect(keyRole(jwt({ role: 'service_role' }))).toBe('service_role');
        expect(keyRole(jwt({ role: 'anon' }))).toBe('anon');
        expect(keyRole('sb_secret_abc')).toBe('secret');
        expect(keyRole('sb_publishable_abc')).toBe('publishable');
        expect(keyRole('x.y')).toBe('unknown');
        expect(keyRole('')).toBe('missing');
    });
});

describe('object keys', () => {
    const cases: [unknown, string][] = [
        [`${SEED}/${NAME}`, SEED],
        [`${SEED}/sub/file name (1).txt`, SEED],
        [`${ORG_B}/x.pdf`, SEED],
        [NAME, SEED],
        [`${SEED}/`, SEED],
        [`${SEED}x/file.pdf`, SEED],
        [`${SEED}/../${ORG_B}/x.pdf`, SEED],
        [`${SEED}/./x.pdf`, SEED],
        [`${SEED}//x.pdf`, SEED],
        [`${SEED}/a\\..\\b.pdf`, SEED],
        [`${SEED}/a\u0000.pdf`, SEED],
        [`${SEED}/${'a'.repeat(1000)}`, SEED],
        [undefined, SEED],
        [42, SEED],
        ['/x.pdf', ''],
    ];

    it('isOrgScopedObjectPath agrees with lib/storage/object-paths.ts', () => {
        for (const [p, org] of cases) {
            expect(isOrgScopedObjectPath(p, org), String(p)).toBe(appIsOrgScopedObjectPath(p, org));
        }
    });

    it('accepts root-level names with spaces and commas, nothing with a folder', () => {
        expect(isRootObjectName(NAME)).toBe(true);
        expect(isRootObjectName('a/b.pdf')).toBe(false);
        expect(isRootObjectName('/b.pdf')).toBe(false);
        expect(isRootObjectName('..')).toBe(false);
        expect(isRootObjectName('a\\b')).toBe(false);
        expect(isRootObjectName('tab\there')).toBe(false);
        expect(isRootObjectName('')).toBe(false);
        expect(isRootObjectName('x'.repeat(988))).toBe(false);
    });

    it('puts the copy under "<seed org>/<same name>" and checks it like the app', () => {
        expect(destinationFor(NAME)).toBe(`${SEED}/${NAME}`);
        expect(destinationFor(NAME, ORG_B)).toBe(`${ORG_B}/${NAME}`);
        expect(destinationFor('a/b.pdf')).toBeNull();
        expect(destinationFor('..')).toBeNull();
    });

    it('URL-encodes each segment, never the slash', () => {
        expect(encodeObjectPath(`${SEED}/${NAME}`)).toBe(`${SEED}/1764201000101_Profil%20Perusahaan%2C%20final.pdf`);
        expect(encodeObjectPath('a%b#c?d.txt')).toBe('a%25b%23c%3Fd.txt');
    });
});

describe('outDirProblem', () => {
    const base = path.resolve('/srv');
    const repo = path.join(base, 'sarathi');
    const exists = (set: string[]) => (p: string) => set.includes(path.resolve(p));
    const gitOfRepo = [path.join(repo, '.git')];

    it('refuses the repository and anything inside it', () => {
        expect(outDirProblem(repo, repo, exists(gitOfRepo))).toMatch(/inside the repository/);
        expect(outDirProblem(path.join(repo, 'backup'), repo, exists(gitOfRepo))).toMatch(/inside the repository/);
        expect(outDirProblem(path.join(repo, '..x'), repo, exists(gitOfRepo))).toMatch(/inside the repository/);
    });

    it('refuses any other git working tree, even another checkout', () => {
        const other = path.join(base, 'other');
        expect(outDirProblem(path.join(other, 'a', 'b'), repo, exists([path.join(other, '.git')]))).toMatch(/git working tree/);
    });

    it('accepts a directory outside every working tree, including a sibling named like the repo', () => {
        expect(outDirProblem(path.join(base, 'backups', 'kb'), repo, exists(gitOfRepo))).toBeNull();
        expect(outDirProblem(path.join(base, 'sarathi-backup'), repo, exists(gitOfRepo))).toBeNull();
    });
});

describe('documents rows', () => {
    const rows = [
        { id: 'r1', org_id: SEED, metadata: { source: NAME, file_name: NAME } },
        { id: 'r2', org_id: SEED, metadata: { source: NAME, file_name: NAME, chunk_index: 1 } },
        { id: 'e1', org_id: SEED, metadata: { source: 'Judul editor', file_name: 'Judul editor', origin: 'editor' } },
        { id: 'p1', org_id: SEED, metadata: { source: `${SEED}/1700_baru.txt` } },
        { id: 'x1', org_id: ORG_B, metadata: { source: 'root-of-b.txt' } },
        { id: 'x2', org_id: SEED, metadata: { source: 'tidak-ada.txt' } },
        { id: 'x3', org_id: SEED, metadata: { source: `${ORG_B}/salah-folder.txt` } },
        { id: 'n1', org_id: SEED, metadata: { file_name: 'tanpa source' } },
        { id: 'n2', org_id: SEED, metadata: null },
    ];

    it('defines file-backed rows like 0066: origin <> editor and a source key', () => {
        expect(isFileBackedRow({ source: 'a' })).toBe(true);
        expect(isFileBackedRow({ source: 'a', origin: 'upload' })).toBe(true);
        expect(isFileBackedRow({ source: null })).toBe(true);
        expect(isFileBackedRow({ source: 'a', origin: 'editor' })).toBe(false);
        expect(isFileBackedRow({ file_name: 'a' })).toBe(false);
        expect(isFileBackedRow(null)).toBe(false);
    });

    it('finds the seed rows 0066 relinks and the rows it cannot fix', () => {
        const { byName, counts } = analyseRows(rows, new Set([NAME, 'unused.pdf']));
        expect(byName.get(NAME)).toEqual(['r1', 'r2']);
        expect(byName.has('unused.pdf')).toBe(false);
        expect(counts).toMatchObject({
            total: 9,
            fileBacked: 6,
            editor: 1,
            editorRootSource: 1,
            other: 2,
            prefixed: 1,
            rootSource: 4,
            rootSourceOtherOrg: 1,
            rootSourceDangling: 1,
            outsideOrgFolder: 1,
            blocking: 3,
            referencedObjects: 1,
        });
    });
});

describe('user-deleted detection (no resurrection)', () => {
    it('classifies by the manifest rows that still exist', () => {
        expect(rowState([], new Set())).toBe('unreferenced');
        expect(rowState(['r1', 'r2'], new Set(['r1', 'r2', 'zz']))).toBe('referenced');
        expect(rowState(['r1', 'r2'], new Set(['zz']))).toBe('user-deleted');
        expect(rowState(['r1', 'r2'], new Set(['r1']))).toBe('rows-partial');
    });

    it('copy: never copies a user-deleted object, skips identical, aborts on a different destination', () => {
        const base = { rows: 'referenced', userDeleted: false, dest: 'absent', original: 'present' } as const;
        expect(copyDecision(base).action).toBe('copy');
        expect(copyDecision({ ...base, rows: 'unreferenced' }).action).toBe('copy');
        expect(copyDecision({ ...base, rows: 'user-deleted' }).action).toBe('skip-user-deleted');
        expect(copyDecision({ ...base, userDeleted: true, rows: 'referenced' }).action).toBe('skip-user-deleted');
        expect(copyDecision({ ...base, dest: 'identical', original: 'absent' }).action).toBe('skip-identical');
        expect(copyDecision({ ...base, dest: 'different' }).action).toBe('abort');
        expect(copyDecision({ ...base, original: 'absent' }).action).toBe('abort');
        expect(copyDecision({ ...base, original: 'changed' }).action).toBe('abort');
        expect(copyDecision({ ...base, rows: 'rows-partial' }).action).toBe('abort');
    });

    it('verify: a user-deleted object is not a failure, a missing copy of a live one is', () => {
        expect(verifyStatus({ rows: 'referenced', userDeleted: false, copy: 'identical' })).toBe('ok');
        expect(verifyStatus({ rows: 'user-deleted', userDeleted: false, copy: 'absent' })).toBe('user-deleted');
        expect(verifyStatus({ rows: 'unreferenced', userDeleted: false, copy: 'absent' })).toMatch(/^fail/);
        expect(verifyStatus({ rows: 'referenced', userDeleted: false, copy: 'different' })).toMatch(/^fail/);
        expect(verifyStatus({ rows: 'rows-partial', userDeleted: false, copy: 'identical' })).toMatch(/^fail/);
    });

    it('restore: puts a missing original back from the copy, else the backup, never a user-deleted one', () => {
        const base = { rows: 'referenced', userDeleted: false, original: 'absent', copy: 'identical', backupOk: true } as const;
        expect(restoreDecision(base).action).toBe('from-copy');
        expect(restoreDecision({ ...base, copy: 'absent' }).action).toBe('from-backup');
        expect(restoreDecision({ ...base, copy: 'different', backupOk: false }).action).toBe('abort');
        expect(restoreDecision({ ...base, original: 'present' }).action).toBe('skip-present');
        expect(restoreDecision({ ...base, rows: 'user-deleted' }).action).toBe('skip-user-deleted');
        expect(restoreDecision({ ...base, userDeleted: true }).action).toBe('skip-user-deleted');
    });
});

describe('delete-originals preconditions', () => {
    const dest = `${SEED}/${NAME}`;
    const objects = [{ dest, row_ids: ['r1'] }, { dest: `${SEED}/unused.pdf`, row_ids: [] }];
    const relinked = { id: 'r1', org_id: SEED, metadata: { source: dest } };
    const editor = { id: 'e1', org_id: SEED, metadata: { source: 'Judul editor', origin: 'editor' } };

    it('ignores editor rows: their source keeps no "/" forever (critique fix)', () => {
        expect(deleteOriginalsBlockers({ rows: [relinked, editor], objects, verifyFailures: 0, soakHoursLeft: 0 })).toEqual([]);
    });

    it('refuses before 0066 (a file-backed row still names a root object)', () => {
        const root = { id: 'r1', org_id: SEED, metadata: { source: NAME } };
        const blockers = deleteOriginalsBlockers({ rows: [root, editor], objects, verifyFailures: 0, soakHoursLeft: 0 });
        expect(blockers.join('\n')).toMatch(/1 file-backed documents row\(s\) still name a root-level object/);
        expect(blockers.join('\n')).toMatch(/1 manifest row\(s\) do not point at their copy/);
    });

    it('refuses on a failed verify and during the soak', () => {
        const blockers = deleteOriginalsBlockers({ rows: [relinked], objects, verifyFailures: 2, soakHoursLeft: 5.5 });
        expect(blockers.join('\n')).toMatch(/verify failed for 2/);
        expect(blockers.join('\n')).toMatch(/5\.5 h left/);
    });

    it('a user-deleted object (rows gone) does not block', () => {
        expect(deleteOriginalsBlockers({ rows: [editor], objects, verifyFailures: 0, soakHoursLeft: 0 })).toEqual([]);
    });

    it('counts the soak from the last copy verification', () => {
        const t0 = Date.parse('2026-10-16T10:00:00Z');
        const objs = [{ copy: { verified_at: '2026-10-16T09:00:00Z' } }, { copy: { verified_at: '2026-10-16T10:00:00Z' } }, { copy: {} }];
        expect(soakRemainingHours(objs, 72, t0)).toBe(72);
        expect(soakRemainingHours(objs, 72, t0 + 71 * 3_600_000)).toBe(1);
        expect(soakRemainingHours(objs, 72, t0 + 73 * 3_600_000)).toBe(0);
        expect(soakRemainingHours(objs, 0, t0)).toBe(0);
        expect(soakRemainingHours([{ copy: {} }], 72, t0)).toBe(72);
    });
});

describe('logging and manifest', () => {
    it('never prints a name: redacts raw and URL-encoded forms', () => {
        const redact = makeRedactor(['a.pdf', NAME]);
        const text = `Object not found: ${SEED}/${NAME} / ${encodeObjectPath(NAME)} / ${encodeURI(NAME)} / a.pdf`;
        const out = redact(text);
        expect(out).not.toContain('Profil');
        expect(out).toBe(`Object not found: ${SEED}/<object #2> / <object #2> / <object #2> / <object #1>`);
        expect(logLine({ index: 3, id: 'uuid-3', size: 10, sha256: 'ab'.repeat(32) }, 15, 'ok')).toBe(
            '[03/15] id=uuid-3 size=10 sha256=abababababab ok'
        );
    });

    it('hashes bytes with sha256', () => {
        expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('accepts only a complete manifest of the same project', () => {
        const good = {
            kind: 'sarathi-legacy-kb-objects',
            version: 1,
            project_ref: 'local-58821',
            bucket: 'documents',
            seed_org_id: SEED,
            objects: [
                {
                    index: 1,
                    id: 'uuid-1',
                    name: NAME,
                    dest: `${SEED}/${NAME}`,
                    size: 3,
                    sha256: 'ab'.repeat(32),
                    row_ids: [],
                    backup_file: 'backup/01-uuid-1.bin',
                },
            ],
        };
        expect(manifestProblems(good, { ref: 'local-58821' })).toEqual([]);
        expect(manifestProblems(good, { ref: 'abcdefghijklmnopqrst' }).join()).toMatch(/made for project local-58821/);
        expect(manifestProblems({ ...good, objects: [{ ...good.objects[0], dest: `${ORG_B}/${NAME}` }] }, { ref: 'local-58821' })).toHaveLength(1);
        expect(manifestProblems({ kind: 'x' }, { ref: 'local-58821' })).toEqual(['not a manifest of this script']);
    });
});
