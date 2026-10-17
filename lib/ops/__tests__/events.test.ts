import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    describeErrorForOps,
    isWhatsAppTokenError,
    opsEventAllowed,
    recordOpsEvent,
    resetOpsEventThrottle,
} from '@/lib/ops/events';

// Ops events (tracker 3.5, migration 0070): recorded with the service-role
// client, never throwing, never carrying PII, throttled per kind and org.
// Fake ids only.

const ORG = '5a11e024-0001-4000-8000-000000000001';

function fakeClient(insert: (row: unknown) => unknown) {
    const rows: unknown[] = [];
    return {
        rows,
        client: {
            from: (table: string) => {
                expect(table).toBe('ops_events');
                return {
                    insert: async (row: unknown) => {
                        rows.push(row);
                        return insert(row);
                    },
                };
            },
        },
    };
}

beforeEach(() => {
    resetOpsEventThrottle();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordOpsEvent', () => {
    it('inserts the kind, the org and a redacted, length-capped detail', async () => {
        const f = fakeClient(() => ({ error: null }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordOpsEvent(f.client as any, 'queue_job_failed', { orgId: ORG, detail: `ke 628123456789 ${'x'.repeat(600)}` });
        expect(f.rows).toHaveLength(1);
        const row = f.rows[0] as { kind: string; org_id: string; detail: string };
        expect(row.kind).toBe('queue_job_failed');
        expect(row.org_id).toBe(ORG);
        expect(row.detail).not.toContain('628123456789');
        expect(row.detail.length).toBe(500);
    });

    it('never throws, whether the insert errors or throws', async () => {
        const failing = fakeClient(() => ({ error: { code: '42501' } }));
        const throwing = fakeClient(() => {
            throw new Error('network');
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(recordOpsEvent(failing.client as any, 'webhook_error')).resolves.toBeUndefined();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(recordOpsEvent(throwing.client as any, 'webhook_error')).resolves.toBeUndefined();
    });

    it('records at most 20 events per kind and org per minute', async () => {
        const f = fakeClient(() => ({ error: null }));
        for (let i = 0; i < 25; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await recordOpsEvent(f.client as any, 'webhook_signature_invalid');
        }
        expect(f.rows).toHaveLength(20);
    });
});

describe('opsEventAllowed', () => {
    it('counts per kind and org, and opens again after a minute', () => {
        const t0 = 1_000_000;
        for (let i = 0; i < 20; i++) expect(opsEventAllowed('webhook_error', null, t0)).toBe(true);
        expect(opsEventAllowed('webhook_error', null, t0 + 1)).toBe(false);
        expect(opsEventAllowed('webhook_error', ORG, t0 + 1)).toBe(true); // another org
        expect(opsEventAllowed('queue_job_failed', null, t0 + 1)).toBe(true); // another kind
        expect(opsEventAllowed('webhook_error', null, t0 + 60_000)).toBe(true);
    });
});

describe('describeErrorForOps / isWhatsAppTokenError', () => {
    it('keeps the Meta code and title, else the error class, never the message', () => {
        expect(describeErrorForOps({ code: 131047, title: 'Re-engagement message' })).toBe('Meta 131047 (Re-engagement message)');
        expect(describeErrorForOps(new TypeError('fetch to 628123456789 failed'))).toBe('TypeError');
        expect(describeErrorForOps('boom')).toBe('unknown error');
    });

    it('spots Meta error 190', () => {
        expect(isWhatsAppTokenError({ code: 190 })).toBe(true);
        expect(isWhatsAppTokenError({ code: 131047 })).toBe(false);
        expect(isWhatsAppTokenError(null)).toBe(false);
    });
});
