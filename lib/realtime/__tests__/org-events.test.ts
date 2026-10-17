import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    ORG_EVENT_TABLES,
    RESYNC,
    coalesce,
    createOrgEventBus,
    orgTopic,
    parseOrgEvent,
    type OrgSignal,
} from '@/lib/realtime/org-events';

// The client half of payload contract v1 (migration 0064; the database half
// is pinned by supabase/tests/database/150_realtime_org_broadcast.test.sql).

const ID1 = '0b0e6a52-5f3c-4c1e-9d7a-1f2e3d4c5b6a';
const ID2 = '9f8e7d6c-5b4a-4321-8fed-cba987654321';

// A broadcast as realtime-js hands it to `.on('broadcast', { event: '*' })`.
function message(payload: Record<string, unknown>, event: unknown = payload.table) {
    return { type: 'broadcast', event, payload };
}

function v1(over: Record<string, unknown> = {}) {
    return { v: 1, table: 'whatsapp_messages', op: 'INSERT', n: 1, ids: [ID1], ...over };
}

describe('orgTopic', () => {
    it('is org:<uuid>, lower-cased like the 0064 triggers send it', () => {
        expect(orgTopic('5A11E024-0001-4000-8000-000000000001')).toBe('org:5a11e024-0001-4000-8000-000000000001');
    });
});

describe('parseOrgEvent', () => {
    it('accepts a v1 envelope and ignores the message id realtime.send adds', () => {
        expect(parseOrgEvent(message(v1({ id: 'e7c1a3c4-1111-4222-8333-944455556666' })))).toEqual({
            table: 'whatsapp_messages',
            op: 'INSERT',
            n: 1,
            ids: [ID1],
            truncated: false,
        });
    });

    it.each(ORG_EVENT_TABLES)('accepts every bus table (%s)', (table) => {
        expect(parseOrgEvent(message(v1({ table, ids: [] })))?.table).toBe(table);
    });

    it.each(['INSERT', 'UPDATE', 'DELETE'])('accepts op %s', (op) => {
        expect(parseOrgEvent(message(v1({ op })))?.op).toBe(op);
    });

    it.each([
        ['a missing payload', { type: 'broadcast', event: 'labels' }],
        ['a non-object message', 'labels'],
        ['null', null],
        ['an array payload', { event: 'labels', payload: [] }],
        ['v 2', message(v1({ v: 2 }))],
        ['v "1" (string)', message(v1({ v: '1' }))],
        ['no v', message({ table: 'labels', op: 'INSERT', n: 1, ids: [] })],
        ['an unknown table', message(v1({ table: 'documents' }))],
        ['event different from table', message(v1(), 'labels')],
        ['an unknown op', message(v1({ op: 'TRUNCATE' }))],
        ['a lower-case op', message(v1({ op: 'insert' }))],
        ['n = 0', message(v1({ n: 0, ids: [] }))],
        ['n < 0', message(v1({ n: -1, ids: [] }))],
        ['a fractional n', message(v1({ n: 1.5 }))],
        ['n as a string', message(v1({ n: '1' }))],
        ['ids not an array', message(v1({ ids: ID1 }))],
        ['a non-uuid id', message(v1({ ids: ['not-a-uuid'] }))],
        ['a numeric id', message(v1({ ids: [42] }))],
        ['more ids than n', message(v1({ n: 1, ids: [ID1, ID2] }))],
        ['more than 50 ids', message(v1({ n: 51, ids: Array.from({ length: 51 }, () => ID1) }))],
    ])('rejects %s', (_label, msg) => {
        expect(parseOrgEvent(msg)).toBeNull();
    });

    it('takes up to 50 ids', () => {
        const ids = Array.from({ length: 50 }, () => ID1);
        expect(parseOrgEvent(message(v1({ n: 50, ids })))?.ids).toHaveLength(50);
    });

    it('marks an event truncated when the ids do not name every row', () => {
        expect(parseOrgEvent(message(v1({ n: 2, ids: [ID1, ID2] })))?.truncated).toBe(false);
        expect(parseOrgEvent(message(v1({ n: 3, ids: [ID1, ID2] })))?.truncated).toBe(true);
        expect(parseOrgEvent(message(v1({ op: 'DELETE', n: 120, ids: [ID1] })))?.truncated).toBe(true);
    });

    it('marks every event of the tables without ids truncated (their keys hold the phone)', () => {
        for (const table of ['whatsapp_chats', 'chat_labels']) {
            expect(parseOrgEvent(message(v1({ table, n: 1, ids: [] })))?.truncated).toBe(true);
        }
        expect(parseOrgEvent(message(v1({ table: 'labels', n: 1, ids: [ID1] })))?.truncated).toBe(false);
    });
});

describe('createOrgEventBus', () => {
    const insert = (table: string) => parseOrgEvent(message(v1({ table, ids: [] })))!;

    it('delivers an event only to the subscribers of its table', () => {
        const bus = createOrgEventBus();
        const chats = vi.fn();
        const labels = vi.fn();
        bus.subscribe(['whatsapp_chats'], chats);
        bus.subscribe(['labels', 'chat_labels'], labels);

        bus.emit(insert('chat_labels'));
        expect(chats).not.toHaveBeenCalled();
        expect(labels).toHaveBeenCalledTimes(1);
        expect(labels.mock.calls[0][0]).toMatchObject({ table: 'chat_labels', op: 'INSERT' });
    });

    it('delivers RESYNC to every subscriber, whatever its tables', () => {
        const bus = createOrgEventBus();
        const seen: OrgSignal[] = [];
        bus.subscribe(['orders'], (s) => seen.push(s));
        bus.subscribe(['whatsapp_messages'], (s) => seen.push(s));
        bus.emit(RESYNC);
        expect(seen).toEqual([RESYNC, RESYNC]);
    });

    it('stops delivering after unsubscribe', () => {
        const bus = createOrgEventBus();
        const handler = vi.fn();
        const unsubscribe = bus.subscribe(['orders'], handler);
        bus.emit(insert('orders'));
        unsubscribe();
        bus.emit(insert('orders'));
        bus.emit(RESYNC);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('keeps delivering to the others when one handler throws', () => {
        const bus = createOrgEventBus();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const after = vi.fn();
        bus.subscribe(['orders'], () => {
            throw new Error('boom');
        });
        bus.subscribe(['orders'], after);
        bus.emit(insert('orders'));
        expect(after).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });
});

describe('coalesce', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs once per burst, `wait` ms after the last call', () => {
        const fn = vi.fn();
        const run = coalesce(fn, { wait: 400, maxWait: 2000 });
        run();
        vi.advanceTimersByTime(300);
        run();
        vi.advanceTimersByTime(300);
        run();
        vi.advanceTimersByTime(399);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5000);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('still runs every maxWait ms during a continuous stream', () => {
        const fn = vi.fn();
        const run = coalesce(fn, { wait: 400, maxWait: 2000 });
        // A call every 100 ms for 5 s: the trailing timer never expires.
        for (let t = 0; t < 5000; t += 100) {
            run();
            vi.advanceTimersByTime(100);
        }
        expect(fn).toHaveBeenCalledTimes(2); // at 2000 and 4000 ms
        vi.advanceTimersByTime(400);
        expect(fn).toHaveBeenCalledTimes(3); // the trailing run after the stream
    });

    it('starts a fresh burst after a run', () => {
        const fn = vi.fn();
        const run = coalesce(fn); // defaults: 400 / 2000
        run();
        vi.advanceTimersByTime(400);
        run();
        vi.advanceTimersByTime(399);
        expect(fn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('cancel drops a pending run', () => {
        const fn = vi.fn();
        const run = coalesce(fn);
        run();
        run.cancel();
        vi.advanceTimersByTime(10_000);
        expect(fn).not.toHaveBeenCalled();
    });
});
