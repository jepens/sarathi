import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Migration 0066's relink and guard only act on a database that still holds
// legacy objects, so CI (a fresh replay) runs its DO block as a no-op and
// compare.sh cannot see it (it creates no catalog object). Instead
// 170_documents_org_prefix.test.sql runs copies of the relink and of the three
// guard predicates on fixtures. This test keeps EVERY one of those copies, and
// the guard's refusal condition, identical to the migration, and pins the
// migration itself: 0066 is applied in production (20261016154903), so its
// file must never change.

const MIGRATION_PATH = join(process.cwd(), 'supabase', 'migrations', '0066_documents_storage_org_prefix_only.sql');
/** sha256 of the LF blob applied to production on 2026-10-16. */
const APPLIED_SHA256 = 'c35e6af54a4cf146b1e82bfe337026f1fdfb106e31ab9a099d8175f4b1f1cdd0';

const migration = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
const pgtap = readFileSync(
    join(process.cwd(), 'supabase', 'tests', 'database', '170_documents_org_prefix.test.sql'),
    'utf8'
).replace(/\r\n/g, '\n');

/**
 * SQL text without comments, with keywords and identifiers lower-cased and
 * whitespace collapsed (no spaces around parentheses). String literals stay
 * exactly as written: their case and spacing matter ('documents', '{source}',
 * the seed prefix).
 */
function norm(sql: string): string {
    let out = '';
    let code = '';
    const flush = () => {
        out += code.toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')');
        code = '';
    };
    let i = 0;
    while (i < sql.length) {
        if (sql.startsWith('--', i)) {
            const nl = sql.indexOf('\n', i);
            i = nl < 0 ? sql.length : nl;
            code += ' ';
        } else if (sql.startsWith('/*', i)) {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? sql.length : end + 2;
            code += ' ';
        } else if (sql[i] === "'") {
            let j = i + 1;
            while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
            flush();
            out += sql.slice(i, j + 1);
            i = j + 1;
        } else {
            code += sql[i++];
        }
    }
    flush();
    return out.trim();
}

function capture(text: string, re: RegExp, label: string): string {
    const m = re.exec(text);
    if (!m) throw new Error(`${label}: not found`);
    return m[1];
}

/** The text of 170 from `startMarker` up to the next of `endMarkers`. */
function section(startMarker: string, endMarkers: string[]): string {
    const start = pgtap.indexOf(startMarker);
    if (start < 0) throw new Error(`170: "${startMarker}" not found`);
    const rest = pgtap.slice(start + startMarker.length);
    const ends = endMarkers.map((m) => rest.indexOf(m)).filter((i) => i >= 0);
    return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
}

/** Every $$-quoted query of a 170 section, normalised; expected-value lists (`values ...`) left out. */
function queries(text: string): string[] {
    return [...text.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => norm(m[1])).filter((q) => !q.startsWith('values'));
}

/**
 * Each query of a guard section must be, in full: one of the select heads,
 * the 0066 predicate, exactly the fixture filter that limits it to this
 * file's fixtures, and at most an `order by 1`. Nothing can be added or
 * changed anywhere, and a copy spelled another way does not slip past.
 */
function expectGuardCopies(sectionText: string, heads: string[], predicate: string, filter: string, expected: number) {
    const allowed = heads.flatMap((h) => [norm(`${h} ${predicate} ${filter}`), norm(`${h} ${predicate} ${filter} order by 1`)]);
    const found = queries(sectionText);
    expect(found).toHaveLength(expected);
    for (const q of found) expect(allowed).toContain(q);
}

const GUARD_MARKERS = ['-- Guard predicate 1', '-- Guard predicate 2', '-- Guard predicate 3', '-- The relink is idempotent'];

describe('migration 0066 vs its copies in 170_documents_org_prefix.test.sql', () => {
    it('0066 is the file applied to production (never edit an applied migration)', () => {
        expect(createHash('sha256').update(migration, 'utf8').digest('hex')).toBe(APPLIED_SHA256);
    });

    it('norm() keeps string literals exactly, and ignores comments, case and layout elsewhere', () => {
        expect(norm("WHERE  o.bucket_id = 'documents' -- note\n  AND ( x )")).toBe("where o.bucket_id = 'documents' and(x)");
        expect(norm("where o.bucket_id = 'Documents'")).not.toBe(norm("where o.bucket_id = 'documents'"));
        expect(norm("where x = 'it''s -- not a comment'")).toBe("where x = 'it''s -- not a comment'");
        expect(norm("coalesce(d.metadata->>'origin', '') <> 'editor'")).toBe("coalesce(d.metadata->>'origin', '')<> 'editor'");
    });

    it('both copies of the relink statement are verbatim', () => {
        const fromMigration = capture(migration, /(update public\.documents d[\s\S]*?\n\s*\);)/, '0066 relink');
        const first = capture(pgtap, /-- 0066 \(a\), verbatim\.\n(update public\.documents d[\s\S]*?\n\s*\);)/, '170 relink');
        expect(norm(first)).toBe(norm(fromMigration));
        // The idempotence check re-runs it, limited to the fixtures, with RETURNING: exactly that, nothing else.
        const again = queries(section('-- The relink is idempotent', ['\n-- ']));
        expect(again).toEqual([
            norm(`${fromMigration.replace(/;\s*$/, '')} and d.id::text like 'd0000000-0000-4000-8000-%' returning d.id`),
        ]);
    });

    it('all 3 copies of guard predicate 1 (file-backed rows outside their org folder) are verbatim', () => {
        const predicate = capture(migration, /into v_rows_outside\s+from public\.documents d\s+(where[\s\S]*?);/, '0066 predicate 1');
        expectGuardCopies(section('-- Guard predicate 1', GUARD_MARKERS.slice(1)),
            ['select d.id::text from public.documents d', 'select d.id from public.documents d'],
            predicate, "and d.id::text like 'd0000000-0000-4000-8000-%'", 3);
    });

    it('both copies of guard predicate 2 (root-level objects without a same-size copy) are verbatim', () => {
        const predicate = capture(migration, /into v_missing_copies\s+from storage\.objects o\s+(where[\s\S]*?\));/, '0066 predicate 2');
        expect(norm(predicate)).toContain("c.metadata->>'size' = o.metadata->>'size'");
        expectGuardCopies(section('-- Guard predicate 2', GUARD_MARKERS.slice(2)),
            ['select o.name from storage.objects o'], predicate, "and o.name like '1700000000%'", 2);
    });

    it('both copies of guard predicate 3 (objects in a non-uuid first folder) are verbatim', () => {
        const predicate = capture(migration, /into v_bad_folders\s+from storage\.objects o\s+(where[\s\S]*?);/, '0066 predicate 3');
        expectGuardCopies(section('-- Guard predicate 3', GUARD_MARKERS.slice(3)),
            ['select o.name from storage.objects o'], predicate,
            "and (o.name like '%1700000000%' or o.name like 'bukan-uuid/%' or o.name like '/%')", 2);
    });

    it('the guard refuses when ANY predicate finds a row', () => {
        expect(norm(migration)).toContain(
            norm(`if v_rows_outside > 0 or v_missing_copies > 0 or v_bad_folders > 0 then
                      raise exception '0066 refused:`)
        );
    });
});
