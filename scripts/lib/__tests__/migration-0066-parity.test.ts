import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Migration 0066's relink and guard only act on a database that still holds
// legacy objects, so CI (a fresh replay) runs its DO block as a no-op and
// compare.sh cannot see it (it creates no catalog object). Instead
// 170_documents_org_prefix.test.sql runs copies of the relink and of the three
// guard predicates on fixtures. This test keeps those copies, and the guard's
// refusal condition, identical to the migration: deleting the DO block,
// changing `or` to `and` or dropping a predicate term fails CI.

const migration = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0066_documents_storage_org_prefix_only.sql'),
    'utf8'
).replace(/\r\n/g, '\n');
const pgtap = readFileSync(
    join(process.cwd(), 'supabase', 'tests', 'database', '170_documents_org_prefix.test.sql'),
    'utf8'
).replace(/\r\n/g, '\n');

/** Whitespace-insensitive SQL text (comments dropped, no spaces around parentheses). */
function norm(sql: string): string {
    return sql
        .replace(/--[^\n]*/g, '')
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

/** The first guard query after the "-- Guard predicate N" comment of 170, without its fixture filter. */
function pgtapPredicate(n: number, selectHead: RegExp, fixtureFilter: RegExp): string {
    const start = pgtap.indexOf(`-- Guard predicate ${n} (0066 b, verbatim)`);
    if (start < 0) throw new Error(`170: guard predicate ${n} comment not found`);
    const section = pgtap.slice(start);
    const head = selectHead.exec(section);
    if (!head) throw new Error(`170: guard predicate ${n} query not found`);
    const rest = section.slice(head.index + head[0].length);
    const end = fixtureFilter.exec(rest);
    if (!end) throw new Error(`170: guard predicate ${n} fixture filter not found`);
    return rest.slice(0, end.index);
}

describe('migration 0066 vs its copies in 170_documents_org_prefix.test.sql', () => {
    it('the relink statement is verbatim', () => {
        const fromMigration = capture(migration, /(update public\.documents d[\s\S]*?\n\s*\);)/, '0066 relink');
        const fromTest = capture(pgtap, /-- 0066 \(a\), verbatim\.\n(update public\.documents d[\s\S]*?\n\s*\);)/, '170 relink');
        expect(norm(fromTest)).toBe(norm(fromMigration));
    });

    it('guard predicate 1 (file-backed rows outside their org folder) is verbatim', () => {
        const fromMigration = capture(migration, /into v_rows_outside\s+from public\.documents d\s+(where[\s\S]*?);/, '0066 predicate 1');
        const fromTest = pgtapPredicate(1, /\$\$ select d\.id::text from public\.documents d\s+/, /\s+and d\.id::text like 'd0000000/);
        expect(norm(fromTest)).toBe(norm(fromMigration));
    });

    it('guard predicate 2 (root-level objects without a same-size copy) is verbatim', () => {
        const fromMigration = capture(migration, /into v_missing_copies\s+from storage\.objects o\s+(where[\s\S]*?\));/, '0066 predicate 2');
        const fromTest = pgtapPredicate(2, /\$\$ select o\.name from storage\.objects o\s+/, /\s+and o\.name like '1700000000%'/);
        expect(norm(fromTest)).toBe(norm(fromMigration));
        expect(norm(fromMigration)).toContain("c.metadata->>'size' = o.metadata->>'size'");
    });

    it('guard predicate 3 (objects in a non-uuid first folder) is verbatim', () => {
        const fromMigration = capture(migration, /into v_bad_folders\s+from storage\.objects o\s+(where[\s\S]*?);/, '0066 predicate 3');
        const fromTest = pgtapPredicate(3, /\$\$ select o\.name from storage\.objects o\s+/, /\s+and \(o\.name like '%1700000000%'/);
        expect(norm(fromTest)).toBe(norm(fromMigration));
    });

    it('the guard refuses when ANY predicate finds a row', () => {
        expect(norm(migration)).toContain(
            norm(`if v_rows_outside > 0 or v_missing_copies > 0 or v_bad_folders > 0 then
                      raise exception '0066 refused:`)
        );
    });
});
