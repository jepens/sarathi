import { describe, it, expect, beforeEach } from 'vitest';
import { BUDGET_MS, POISON_LIMIT, STOP_AFTER_RETRYABLE } from '@/lib/whatsapp/webhook/limits';
import { RpcError } from '@/lib/whatsapp/webhook/errors';
import {
    BatchOutcome,
    clearPoison,
    isPoisoned,
    notePoison,
    poisonCount,
    resetPoison,
    respond,
} from '@/lib/whatsapp/webhook/outcome';
import { resetOpsEventThrottle } from '@/lib/ops/events';

// The result of one delivery (Fase 2 task 2.2a part 2): 503 only when trying
// again can help, with one alert per batch; the time budget and the stop
// rule defer the rest of a batch; the poison counter bounds how often one
// item is retried in this process. Fake ids only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';

function opsClient() {
    const events: Array<Record<string, unknown>> = [];
    return {
        events,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: { rpc: async (_fn: string, args: Record<string, unknown>) => (events.push(args), { error: null }) } as any,
    };
}

beforeEach(() => {
    resetPoison();
    resetOpsEventThrottle();
});

describe('BatchOutcome: the time budget and the stop rule', () => {
    it(`defers the rest once ${BUDGET_MS} ms have passed since the request started`, () => {
        let now = 1_000_000;
        const outcome = new BatchOutcome(now, () => now);
        now += BUDGET_MS - 1;
        expect(outcome.shouldDefer()).toBe(false);
        expect(outcome.remainingMs()).toBe(1);
        now += 1;
        expect(outcome.shouldDefer()).toBe(true);
        expect(outcome.remainingMs()).toBe(1); // never 0 or negative: AbortSignal.timeout needs a delay
        // Once stopped, it stays stopped.
        now -= 5000;
        expect(outcome.shouldDefer()).toBe(true);
    });

    it(`defers the rest after ${STOP_AFTER_RETRYABLE} retryable failures in a row; anything done in between resets the streak`, () => {
        const outcome = new BatchOutcome();
        outcome.failed(new Error('a'));
        outcome.failed(new Error('b'));
        outcome.done('new');
        outcome.failed(new Error('c'));
        outcome.failed(new Error('d'));
        expect(outcome.shouldDefer()).toBe(false);
        outcome.failed(new Error('e'));
        expect(outcome.shouldDefer()).toBe(true);
        expect(outcome.logLine()).toContain('(stop_rule)');
    });

    it('a status call that went through resets the streak too', () => {
        const outcome = new BatchOutcome();
        outcome.failed(new Error('a'));
        outcome.failed(new Error('b'));
        outcome.appliedStatuses(1, 0, 0);
        outcome.failed(new Error('c'));
        expect(outcome.shouldDefer()).toBe(false);
    });

    it('signal() aborts after the remaining budget', async () => {
        const now = Date.now();
        const outcome = new BatchOutcome(now - BUDGET_MS + 20, () => now);
        const signal = outcome.signal();
        expect(signal.aborted).toBe(false);
        await new Promise((r) => setTimeout(r, 60));
        expect(signal.aborted).toBe(true);
    });

    it('the log line has counts only', () => {
        const outcome = new BatchOutcome();
        outcome.items = 3;
        outcome.done('new');
        outcome.done('duplicate');
        outcome.deferred();
        expect(outcome.logLine()).toMatch(
            /^Webhook batch: items=3 new=1 duplicate=1 rate_limited=0 acked=0 legacy=0 degraded=0 skipped=0 retryable=0 deferred=1 statuses applied=0 stale=0 unknown=0 ms=\d+$/,
        );
    });
});

describe('respond', () => {
    it('200 when every item was done, whatever its result', async () => {
        const ops = opsClient();
        const outcome = new BatchOutcome();
        outcome.items = 4;
        for (const r of ['new', 'duplicate', 'degraded', 'skipped'] as const) outcome.done(r);
        const res = await respond(ops.client, outcome);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('EVENT_RECEIVED');
        expect(ops.events).toEqual([]);
    });

    it('503 and one webhook_error for the batch, with the first error and how many items failed', async () => {
        const ops = opsClient();
        const outcome = new BatchOutcome();
        outcome.orgId = ORG;
        outcome.items = 5;
        outcome.done('new');
        outcome.failed(new RpcError('wa_ingest_inbound', { code: '40001' }, 500));
        outcome.failed(new RpcError('wa_apply_statuses', { code: '57014' }, 500), 2);
        outcome.deferred(); // the budget also ran out: still one alert, the error
        const res = await respond(ops.client, outcome);
        expect(res.status).toBe(503);
        expect(ops.events).toEqual([{ p_kind: 'webhook_error', p_org: ORG, p_detail: 'database 40001 — bentrok transaksi, aman bila jarang (3 dari 5 item)', p_count: 1 }]);
    });

    it('an org that could not be read: 503, webhook_error without an org', async () => {
        const ops = opsClient();
        const outcome = new BatchOutcome();
        outcome.items = 1;
        outcome.failed(Object.assign(new Error('platform setting default_org_id could not be read (57014)'), { name: 'PlatformSettingReadError', code: '57014' }));
        const res = await respond(ops.client, outcome);
        expect(res.status).toBe(503);
        expect(ops.events).toEqual([{ p_kind: 'webhook_error', p_org: null, p_detail: 'database 57014 — org default tidak terbaca, periksa Supabase (1 dari 1 item)', p_count: 1 }]);
    });

    it('nothing at all got an answer from the database within the budget: 503 and webhook_error (a slow database is an outage)', async () => {
        const ops = opsClient();
        const outcome = new BatchOutcome();
        outcome.orgId = ORG;
        outcome.items = 3;
        outcome.done('acked');
        outcome.deferred(2);
        expect(outcome.progressed()).toBe(false);
        const res = await respond(ops.client, outcome);
        expect(res.status).toBe(503);
        expect(ops.events).toEqual([
            {
                p_kind: 'webhook_error',
                p_org: ORG,
                p_detail: 'database lambat atau tidak menjawab: 2 dari 3 item ditunda tanpa satu pun selesai dalam 8 detik; webhook menjawab 503, Meta mengirim ulang',
                p_count: 1,
            },
        ]);
    });

    it('a BSUID move the database answered (counted as acked or skipped) is progress: the rest deferred is webhook_deferred', async () => {
        const ops = opsClient();
        const outcome = new BatchOutcome();
        outcome.orgId = ORG;
        outcome.items = 2;
        outcome.done('acked');
        outcome.answered();
        outcome.deferred();
        expect(outcome.progressed()).toBe(true);
        expect((await respond(ops.client, outcome)).status).toBe(503);
        expect(ops.events.map((e) => e.p_kind)).toEqual(['webhook_deferred']);
        // The log line keeps its counters: the move shows under acked.
        expect(outcome.logLine()).toContain('acked=1 ');
    });

    it('the result line carries the answer Meta got', () => {
        const outcome = new BatchOutcome();
        expect(outcome.logLine(503)).toMatch(/ ms=\d+ http=503$/);
        expect(outcome.logLine()).toMatch(/ ms=\d+$/);
    });

    it('items deferred by the budget, nothing failed: 503 and webhook_deferred', async () => {
        const ops = opsClient();
        const outcome = new BatchOutcome();
        outcome.orgId = ORG;
        outcome.items = 20;
        outcome.done('new', 12);
        outcome.deferred(8);
        const res = await respond(ops.client, outcome);
        expect(res.status).toBe(503);
        expect(ops.events).toEqual([
            {
                p_kind: 'webhook_deferred',
                p_org: ORG,
                p_detail: '8 dari 20 item ditunda: batas waktu 8 detik habis; webhook menjawab 503, Meta mengirim ulang',
                p_count: 1,
            },
        ]);
    });
});

describe('the poison counter', () => {
    it(`counts the failures of each item; at ${POISON_LIMIT} the item stops being retried`, () => {
        for (let i = 1; i < POISON_LIMIT; i++) {
            expect(isPoisoned(notePoison('wamid.a'))).toBe(false);
        }
        expect(isPoisoned(notePoison('wamid.a'))).toBe(true);
        expect(notePoison('wamid.b')).toBe(1); // per item
    });

    it('forgets an item that went through', () => {
        notePoison('wamid.a');
        notePoison('wamid.a');
        clearPoison('wamid.a');
        expect(poisonCount('wamid.a')).toBe(0);
        expect(notePoison('wamid.a')).toBe(1);
    });

    it('holds at most 1000 keys, forgetting the oldest first', () => {
        for (let i = 0; i < 1000; i++) notePoison(`k${i}`);
        notePoison('k0'); // k0 is now the newest
        notePoison('k-new'); // evicts k1, the oldest
        expect(poisonCount('k0')).toBe(2);
        expect(poisonCount('k1')).toBe(0);
        expect(poisonCount('k2')).toBe(1);
        expect(poisonCount('k-new')).toBe(1);
    });
});
