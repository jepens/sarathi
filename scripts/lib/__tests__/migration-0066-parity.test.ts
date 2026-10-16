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

/** Comment-, case- and whitespace-insensitive SQL text (no spaces around parentheses). */
function norm(sql: string): string {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*\(\s*/g, '(')
        .replace(/\s*\)\s*/g, ')')
        .trim();
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

/**
 * Every query of a guard section: the WHERE clause after `selectHead`, without
 * the fixture filter that restricts it to this file's fixtures.
 */
function predicateCopies(text: string, selectHead: string, fixtureFilter: RegExp): string[] {
    const copies: string[] = [];
    let at = text.indexOf(selectHead);
    while (at >= 0) {
        const rest = text.slice(at + selectHead.length);
        const end = fixtureFilter.exec(rest);
        if (!end) throw new Error(`170: a "${selectHead}" query without its fixture filter`);
        copies.push(rest.slice(0, end.index));
        at = text.indexOf(selectHead, at + selectHead.length);
    }
    return copies;
}

const GUARD_MARKERS = ['-- Guard predicate 1', '-- Guard predicate 2', '-- Guard predicate 3', '-- The relink is idempotent'];

describe('migration 0066 vs its copies in 170_documents_org_prefix.test.sql', () => {
    it('0066 is the file applied to production (never edit an applied migration)', () => {
        expect(createHash('sha256').update(migration, 'utf8').digest('hex')).toBe(APPLIED_SHA256);
    });

    it('both copies of the relink statement are verbatim', () => {
        const fromMigration = capture(migration, /(update public\.documents d[\s\S]*?\n\s*\);)/, '0066 relink');
        const first = capture(pgtap, /-- 0066 \(a\), verbatim\.\n(update public\.documents d[\s\S]*?\n\s*\);)/, '170 relink');
        expect(norm(first)).toBe(norm(fromMigration));
        // The idempotence check re-runs it with the fixture filter and RETURNING.
        const again = section('-- The relink is idempotent', ['\n-- ']);
        const body = capture(again, /\$\$ (update public\.documents d[\s\S]*?)\s+and d\.id::text like 'd0000000/, '170 relink (idempotent)');
        expect(norm(`${body};`)).toBe(norm(fromMigration));
    });

    it('all 3 copies of guard predicate 1 (file-backed rows outside their org folder) are verbatim', () => {
        const fromMigration = norm(capture(migration, /into v_rows_outside\s+from public\.documents d\s+(where[\s\S]*?);/, '0066 predicate 1'));
        const copies = predicateCopies(section('-- Guard predicate 1', GUARD_MARKERS.slice(1)),
            'from public.documents d', /\s+and d\.id::text like 'd0000000/);
        expect(copies).toHaveLength(3);
        for (const c of copies) expect(norm(c)).toBe(fromMigration);
    });

    it('both copies of guard predicate 2 (root-level objects without a same-size copy) are verbatim', () => {
        const fromMigration = norm(capture(migration, /into v_missing_copies\s+from storage\.objects o\s+(where[\s\S]*?\));/, '0066 predicate 2'));
        expect(fromMigration).toContain("c.metadata->>'size' = o.metadata->>'size'");
        const copies = predicateCopies(section('-- Guard predicate 2', GUARD_MARKERS.slice(2)),
            'select o.name from storage.objects o', /\s+and o\.name like '1700000000%'/);
        expect(copies).toHaveLength(2);
        for (const c of copies) expect(norm(c)).toBe(fromMigration);
    });

    it('both copies of guard predicate 3 (objects in a non-uuid first folder) are verbatim', () => {
        const fromMigration = norm(capture(migration, /into v_bad_folders\s+from storage\.objects o\s+(where[\s\S]*?);/, '0066 predicate 3'));
        const copies = predicateCopies(section('-- Guard predicate 3', GUARD_MARKERS.slice(3)),
            'select o.name from storage.objects o', /\s+and \(o\.name like '%1700000000%'/);
        expect(copies).toHaveLength(2);
        for (const c of copies) expect(norm(c)).toBe(fromMigration);
    });

    it('the guard refuses when ANY predicate finds a row', () => {
        expect(norm(migration)).toContain(
            norm(`if v_rows_outside > 0 or v_missing_copies > 0 or v_bad_folders > 0 then
                      raise exception '0066 refused:`)
        );
    });
});
