import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    describeErrorForOps,
    isWhatsAppTokenError,
    opsEventSlot,
    recordOpsEvent,
    resetOpsEventThrottle,
} from '@/lib/ops/events';

// Ops events (tracker 3.5, migration 0070): recorded with the service-role
// client through record_ops_event (one row per kind, org and minute), never
// throwing, never carrying PII; at most 20 calls per kind and org per minute,
// the events above that recorded at the end of the window (or by the next
// call, if that comes first). Fake ids only.

const ORG = '5a11e024-0001-4000-8000-000000000001';

function fakeClient(reply: () => unknown) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    return {
        calls,
        client: {
            rpc: async (fn: string, args: Record<string, unknown>) => {
                calls.push({ fn, args });
                return reply();
            },
        },
    };
}

beforeEach(() => {
    resetOpsEventThrottle();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
});

describe('recordOpsEvent', () => {
    it('calls record_ops_event with the kind, the org and a redacted, length-capped detail', async () => {
        const f = fakeClient(() => ({ error: null }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordOpsEvent(f.client as any, 'queue_job_failed', { orgId: ORG, detail: `ke 628123456789 ${'x'.repeat(600)}` });
        expect(f.calls).toHaveLength(1);
        const { fn, args } = f.calls[0];
        expect(fn).toBe('record_ops_event');
        expect(args).toMatchObject({ p_kind: 'queue_job_failed', p_org: ORG, p_count: 1 });
        expect(args.p_detail).not.toContain('628123456789');
        expect((args.p_detail as string).length).toBe(500);
    });

    it('never throws, whether the call errors or throws', async () => {
        const failing = fakeClient(() => ({ error: { code: '42501' } }));
        const throwing = fakeClient(() => {
            throw new Error('network');
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(recordOpsEvent(failing.client as any, 'webhook_error')).resolves.toBeUndefined();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(recordOpsEvent(throwing.client as any, 'webhook_error')).resolves.toBeUndefined();
    });

    it("records a burst's held-back tail when its window ends, once", async () => {
        vi.useFakeTimers();
        const f = fakeClient(() => ({ error: null }));
        for (let i = 0; i < 25; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await recordOpsEvent(f.client as any, 'webhook_signature_invalid', { detail: 'tanda tangan tidak cocok' });
        }
        expect(f.calls).toHaveLength(20);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.calls).toHaveLength(21);
        expect(f.calls[20].args).toMatchObject({ p_kind: 'webhook_signature_invalid', p_count: 5, p_detail: 'tanda tangan tidak cocok' });
        // The next event starts a new window and carries nothing already flushed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordOpsEvent(f.client as any, 'webhook_signature_invalid');
        expect(f.calls[21].args).toMatchObject({ p_count: 1 });
    });

    it('an event held after the flush already fired gets a flush of its own', async () => {
        vi.useFakeTimers();
        const f = fakeClient(() => ({ error: null }));
        const start = Date.now();
        for (let i = 0; i < 21; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await recordOpsEvent(f.client as any, 'queue_job_failed');
        }
        await vi.advanceTimersByTimeAsync(60_000); // the flush records the 1 held event
        expect(f.calls).toHaveLength(21);
        vi.setSystemTime(start + 59_995); // the wall clock says the window is still open
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordOpsEvent(f.client as any, 'queue_job_failed');
        await vi.runAllTimersAsync();
        expect(f.calls).toHaveLength(22);
        expect(f.calls[21].args).toMatchObject({ p_count: 1 });
    });

    it('a new window that comes before the flush carries the tail instead, and the flush records nothing', async () => {
        vi.useFakeTimers();
        const f = fakeClient(() => ({ error: null }));
        for (let i = 0; i < 22; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await recordOpsEvent(f.client as any, 'webhook_error');
        }
        vi.setSystemTime(Date.now() + 60_000); // the clock moves on, the timer has not fired yet
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordOpsEvent(f.client as any, 'webhook_error');
        expect(f.calls[20].args).toMatchObject({ p_count: 3 });
        await vi.runAllTimersAsync();
        expect(f.calls).toHaveLength(21);
    });

    it('makes at most 20 calls per kind and org a minute', async () => {
        const f = fakeClient(() => ({ error: null }));
        for (let i = 0; i < 25; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await recordOpsEvent(f.client as any, 'webhook_signature_invalid');
        }
        expect(f.calls).toHaveLength(20);
    });
});

describe('opsEventSlot', () => {
    it('counts per kind and org, and carries the events above the cap into the next call', () => {
        const t0 = 1_000_000;
        for (let i = 0; i < 20; i++) expect(opsEventSlot('webhook_error', null, t0)).toBe(1);
        expect(opsEventSlot('webhook_error', null, t0 + 1)).toBe(0); // carried
        expect(opsEventSlot('webhook_error', null, t0 + 2)).toBe(0); // carried
        expect(opsEventSlot('webhook_error', ORG, t0 + 3)).toBe(1); // another org
        expect(opsEventSlot('queue_job_failed', null, t0 + 3)).toBe(1); // another kind
        // A new window: the first call records itself plus the 2 carried events.
        expect(opsEventSlot('webhook_error', null, t0 + 60_000)).toBe(3);
        expect(opsEventSlot('webhook_error', null, t0 + 60_001)).toBe(1);
    });
});

describe('describeErrorForOps / isWhatsAppTokenError', () => {
    it('keeps the Meta code and title, a database code, else the error class, never the message', () => {
        expect(describeErrorForOps({ code: 131047, title: 'Re-engagement message' })).toBe('Meta 131047 (Re-engagement message)');
        expect(describeErrorForOps({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe('database 57014');
        expect(describeErrorForOps({ code: 'PGRST301', message: 'JWT expired' })).toBe('database PGRST301');
        expect(describeErrorForOps(new TypeError('fetch to 628123456789 failed'))).toBe('TypeError');
        expect(describeErrorForOps({ code: 'contains 628123456789', name: 'X' })).toBe('X');
        expect(describeErrorForOps('boom')).toBe('unknown error');
    });

    it('spots Meta error 190', () => {
        expect(isWhatsAppTokenError({ code: 190 })).toBe(true);
        expect(isWhatsAppTokenError({ code: 131047 })).toBe(false);
        expect(isWhatsAppTokenError(null)).toBe(false);
    });
});
