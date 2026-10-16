import { describe, expect, it } from 'vitest';
import { createListGuard } from '@/lib/realtime/list-guard';

type Row = { id: string; v: number };
const r = (id: string, v = 1): Row => ({ id, v });
const ids = (rows: Row[] | null) => rows?.map((x) => `${x.id}:${x.v}`).sort();

describe('createListGuard', () => {
    it('applies a whole-list read when nothing happened meanwhile', () => {
        const g = createListGuard<Row>();
        const t = g.begin();
        expect(ids(g.settle(t, [r('a'), r('b')], []))).toEqual(['a:1', 'b:1']);
    });

    it('keeps a row merged while an older whole-list read was in flight (finding: message vanishes)', () => {
        const g = createListGuard<Row>();
        const t = g.begin(); // RESYNC read starts; its snapshot predates M
        g.noteUpsert(['m']); // M arrives and is merged by id
        const current = [r('a'), r('m')];
        expect(ids(g.settle(t, [r('a')], current))).toEqual(['a:1', 'm:1']);
    });

    it('keeps the newer state of a row updated meanwhile (delivery ticks never regress)', () => {
        const g = createListGuard<Row>();
        const t = g.begin();
        g.noteUpsert(['a']);
        expect(ids(g.settle(t, [r('a', 1)], [r('a', 2)]))).toEqual(['a:2']);
    });

    it('keeps a row deleted while the read was in flight deleted (finding: booking comes back)', () => {
        const g = createListGuard<Row>();
        const t = g.begin();
        g.noteDelete(['x']);
        expect(ids(g.settle(t, [r('a'), r('x')], [r('a')]))).toEqual(['a:1']);
    });

    it('drops a read that started before one already applied (out-of-order responses)', () => {
        const g = createListGuard<Row>();
        const older = g.begin();
        const newer = g.begin();
        expect(ids(g.settle(newer, [r('a'), r('b')], []))).toEqual(['a:1', 'b:1']);
        expect(g.settle(older, [r('a')], [r('a'), r('b')])).toBeNull();
    });

    it('changes made before a read started are part of its snapshot', () => {
        const g = createListGuard<Row>();
        g.noteDelete(['x']);
        g.noteUpsert(['m']);
        const t = g.begin();
        // The read saw x again (re-created) and no m (deleted since): it wins.
        expect(ids(g.settle(t, [r('x')], [r('m')]))).toEqual(['x:1']);
    });

    it('a later delete overrides an earlier merge of the same id, and the other way round', () => {
        const g = createListGuard<Row>();
        const t = g.begin();
        g.noteUpsert(['a']);
        g.noteDelete(['a']);
        expect(ids(g.settle(t, [r('a')], [r('a', 2)]))).toEqual([]);
        const t2 = g.begin();
        g.noteDelete(['b']);
        g.noteUpsert(['b']);
        expect(ids(g.settle(t2, [], [r('b', 3)]))).toEqual(['b:3']);
    });

    it('is idempotent for the same arguments (React may run an updater twice)', () => {
        const g = createListGuard<Row>();
        const t = g.begin();
        g.noteUpsert(['m']);
        const first = g.settle(t, [r('a')], [r('a'), r('m')]);
        const second = g.settle(t, [r('a')], [r('a'), r('m')]);
        expect(ids(second)).toEqual(ids(first));
    });
});
