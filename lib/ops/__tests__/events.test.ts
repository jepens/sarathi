import { describe, it, expect, vi, beforeEach } from 'vitest';
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
// the events above that carried into the next call. Fake ids only.

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
