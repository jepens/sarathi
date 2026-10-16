import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { firstPersonaNames, saveFirstPersona } from '@/lib/ai/persona-store';

// Persona for a new org (tracker 1.8, audit KUA-6): saving the synthetic
// persona creates the org's first system_message row — scoped to the org,
// active — instead of updating a non-existent id 'default'.

const ORG = '0b0e6c1e-1111-4222-8333-444455556666';

interface Row {
    id: string;
    org_id: string;
    name: string;
    content: string;
    is_active: boolean;
}

/** In-memory system_message with the 0061 keys: unique (org_id, name), one active per org, global name. */
function fakeDb(rows: Row[], opts: { globalNames?: string[] } = {}) {
    const ops: string[] = [];
    let seq = 0;
    const taken = (r: Partial<Row>) =>
        rows.some((x) => x.org_id === r.org_id && x.name === r.name) ||
        (opts.globalNames ?? []).includes(r.name as string);

    const client = {
        from(table: string) {
            expect(table).toBe('system_message');
            const filters: Array<(r: Row) => boolean> = [];
            let mode: 'select' | 'insert' | 'update' = 'select';
            let payload: Record<string, unknown> = {};
            const q: Record<string, unknown> = {};
            const run = async () => {
                if (mode === 'insert') {
                    const r = payload as unknown as Row;
                    ops.push(`insert ${r.org_id}/${r.name}`);
                    if (taken(r)) return { data: null, error: { code: '23505', message: 'duplicate' } };
                    if (r.is_active) for (const x of rows) if (x.org_id === r.org_id) x.is_active = false;
                    const row = { ...r, id: `new-${++seq}` };
                    rows.push(row);
                    return { data: row, error: null };
                }
                const hit = rows.filter((r) => filters.every((f) => f(r)));
                if (mode === 'update') {
                    ops.push(`update ${hit.map((h) => h.id).join(',')}`);
                    for (const h of hit) Object.assign(h, payload);
                }
                if (hit.length === 0) return { data: null, error: mode === 'update' ? { code: 'PGRST116' } : null };
                return { data: { ...hit[0] }, error: null };
            };
            q.select = () => q;
            q.insert = (vals: Record<string, unknown>[]) => {
                mode = 'insert';
                payload = vals[0];
                return q;
            };
            q.update = (vals: Record<string, unknown>) => {
                mode = 'update';
                payload = vals;
                return q;
            };
            q.eq = (col: keyof Row, val: unknown) => {
                filters.push((r) => r[col] === val);
                return q;
            };
            q.in = (col: keyof Row, vals: unknown[]) => {
                filters.push((r) => vals.includes(r[col]));
                return q;
            };
            q.order = () => q;
            q.limit = () => q;
            q.single = run;
            q.maybeSingle = run;
            return q;
        },
    };
    return { client: client as unknown as SupabaseClient, rows, ops };
}

describe('firstPersonaNames', () => {
    it("tries 'default', then an org-specific name that passes the name rule", () => {
        const names = firstPersonaNames(ORG);
        expect(names[0]).toBe('default');
        expect(names[1]).toBe('default_0b0e6c1e111142228333444455556666');
        for (const n of names) expect(n).toMatch(/^[a-z0-9_]+$/);
    });
});

describe('saveFirstPersona', () => {
    it("creates the org's first persona, active and scoped to the org", async () => {
        const db = fakeDb([]);
        const res = await saveFirstPersona(db.client, ORG, 'Halo');
        expect(res.ok && res.created).toBe(true);
        expect(db.rows).toEqual([
            expect.objectContaining({ org_id: ORG, name: 'default', content: 'Halo', is_active: true }),
        ]);
    });

    it("uses the org-specific name while another org still owns 'default' globally", async () => {
        const db = fakeDb([], { globalNames: ['default'] });
        const res = await saveFirstPersona(db.client, ORG, 'Halo');
        expect(res.ok).toBe(true);
        expect(db.rows[0]).toMatchObject({ org_id: ORG, name: firstPersonaNames(ORG)[1], is_active: true });
    });

    it("reuses the org's own inactive 'default' row instead of inserting", async () => {
        const db = fakeDb([{ id: 'p1', org_id: ORG, name: 'default', content: 'lama', is_active: false }]);
        const res = await saveFirstPersona(db.client, ORG, 'baru');
        expect(res.ok && !res.created).toBe(true);
        expect(db.ops).toEqual(['update p1']);
        expect(db.rows[0]).toMatchObject({ content: 'baru', is_active: true });
    });

    it("updates the org's active persona when one appeared meanwhile (another tab)", async () => {
        const db = fakeDb([{ id: 'p9', org_id: ORG, name: 'custom', content: 'x', is_active: true }]);
        const res = await saveFirstPersona(db.client, ORG, 'baru');
        expect(res.ok).toBe(true);
        expect(db.ops).toEqual(['update p9']);
    });

    it("never touches another org's persona", async () => {
        const other = { id: 'o1', org_id: 'other-org', name: 'default', content: 'milik lain', is_active: true };
        const db = fakeDb([other]);
        const res = await saveFirstPersona(db.client, ORG, 'Halo');
        expect(res.ok).toBe(true);
        expect(other).toMatchObject({ content: 'milik lain', is_active: true });
        expect(db.rows.filter((r) => r.org_id === ORG)).toHaveLength(1);
    });

    it('surfaces non-unique errors', async () => {
        const db = fakeDb([]);
        const broken = {
            from: () => {
                const q: Record<string, unknown> = {};
                for (const m of ['select', 'eq', 'in', 'order', 'limit']) q[m] = () => q;
                q.maybeSingle = async () => ({ data: null, error: { code: '42501', message: 'denied' } });
                return q;
            },
        } as unknown as SupabaseClient;
        const res = await saveFirstPersona(broken, ORG, 'Halo');
        expect(res.ok).toBe(false);
        expect(db.rows).toEqual([]);
    });
});
