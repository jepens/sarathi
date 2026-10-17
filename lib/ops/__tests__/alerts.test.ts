import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Team alert emails (tracker 3.5, migration 0070): one email per run for the
// kinds that have unsent events and were not alerted in the last hour; rows
// claimed before sending, un-claimed when the send fails; nothing sent
// without a recipient. Fake ids and addresses only.

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
    Resend: class {
        emails = { send: h.send };
    },
}));

import { maybeSendOpsAlerts, opsAlertConfig } from '@/lib/ops/alerts';

const ORG = '5a11e024-0001-4000-8000-000000000001';
const NOW = new Date('2026-10-18T03:00:00Z');

interface Row {
    id: number;
    kind: string;
    org_id: string | null;
    detail: string;
    created_at: string;
    alerted_at: string | null;
}

let rows: Row[] = [];

// The query shapes lib/ops/alerts.ts uses, over an in-memory table.
function fakeClient() {
    return {
        from(table: string) {
            if (table === 'organizations') {
                return {
                    select: () => ({ in: async () => ({ data: [{ id: ORG, name: 'Sailendra' }], error: null }) }),
                };
            }
            expect(table).toBe('ops_events');
            return {
                select: () => ({
                    is: () => ({
                        order: () => ({
                            limit: async () => ({
                                data: rows.filter((r) => r.alerted_at === null).sort((a, b) => a.created_at.localeCompare(b.created_at)),
                                error: null,
                            }),
                        }),
                    }),
                    gte: (_col: string, since: string) => ({
                        limit: async () => ({
                            data: rows.filter((r) => r.alerted_at !== null && r.alerted_at >= since).map((r) => ({ kind: r.kind })),
                            error: null,
                        }),
                    }),
                }),
                update: (patch: { alerted_at: string | null }) => ({
                    in: (_col: string, ids: number[]) => ({
                        is: () => ({
                            select: async () => {
                                const hit = rows.filter((r) => ids.includes(r.id) && r.alerted_at === null);
                                hit.forEach((r) => (r.alerted_at = patch.alerted_at));
                                return { data: hit.map((r) => ({ ...r })), error: null };
                            },
                        }),
                        eq: async (_c: string, stamp: string) => {
                            rows.filter((r) => ids.includes(r.id) && r.alerted_at === stamp).forEach((r) => (r.alerted_at = patch.alerted_at));
                            return { error: null };
                        },
                    }),
                }),
            };
        },
    };
}

const event = (id: number, kind: string, minutesAgo: number, alertedMinutesAgo: number | null = null, orgId: string | null = ORG): Row => ({
    id,
    kind,
    org_id: orgId,
    detail: `contoh ${kind}`,
    created_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    alerted_at: alertedMinutesAgo === null ? null : new Date(NOW.getTime() - alertedMinutesAgo * 60_000).toISOString(),
});

beforeEach(() => {
    rows = [];
    h.send.mockReset();
    h.send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.com, tim@example.com');
    vi.stubEnv('OPS_ALERT_FROM_EMAIL', 'Sarathi <alert@example.com>');
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllEnvs();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = () => maybeSendOpsAlerts(fakeClient() as any, NOW);

describe('maybeSendOpsAlerts', () => {
    it('does nothing without unsent events', async () => {
        rows = [event(1, 'webhook_error', 90, 80)];
        expect(await run()).toEqual({ sent: false, kinds: [] });
        expect(h.send).not.toHaveBeenCalled();
    });

    it('emails once for every due kind, with labels, counts and org names, and claims the rows', async () => {
        rows = [event(1, 'queue_job_failed', 10), event(2, 'queue_job_failed', 5), event(3, 'webhook_signature_invalid', 3, null, null)];
        const result = await run();
        expect(result).toEqual({ sent: true, kinds: ['queue_job_failed', 'webhook_signature_invalid'] });
        expect(h.send).toHaveBeenCalledTimes(1);
        const mail = h.send.mock.calls[0][0];
        expect(mail.to).toEqual(['ops@example.com', 'tim@example.com']);
        expect(mail.from).toBe('Sarathi <alert@example.com>');
        expect(mail.subject).toContain('Balasan AI gagal');
        expect(mail.text).toContain('Balasan AI gagal setelah semua percobaan: 2 kejadian');
        expect(mail.text).toContain('org: Sailendra');
        expect(rows.every((r) => r.alerted_at === NOW.toISOString())).toBe(true);
    });

    it('waits an hour per kind: a kind alerted 30 minutes ago is not emailed again yet', async () => {
        rows = [event(1, 'queue_job_failed', 40, 30), event(2, 'queue_job_failed', 1), event(3, 'webhook_error', 2)];
        const result = await run();
        expect(result.kinds).toEqual(['webhook_error']);
        expect(rows.find((r) => r.id === 2)!.alerted_at).toBeNull();
    });

    it('without a recipient nothing is sent and nothing is claimed', async () => {
        vi.stubEnv('OPS_ALERT_EMAIL', '');
        rows = [event(1, 'webhook_error', 1)];
        const result = await run();
        expect(result).toEqual({ sent: false, kinds: [], reason: 'OPS_ALERT_EMAIL not set' });
        expect(h.send).not.toHaveBeenCalled();
        expect(rows[0].alerted_at).toBeNull();
    });

    it('a failed send un-claims the rows for the next run', async () => {
        h.send.mockResolvedValue({ data: null, error: { message: 'rate limited' } });
        rows = [event(1, 'webhook_error', 1)];
        const result = await run();
        expect(result).toEqual({ sent: false, kinds: [], reason: 'send failed' });
        expect(rows[0].alerted_at).toBeNull();
    });
});

describe('opsAlertConfig', () => {
    it('falls back to SAILENDRA_FROM_EMAIL and drops invalid recipients', () => {
        const cfg = opsAlertConfig({ OPS_ALERT_EMAIL: 'bukan-email, ops@example.com', SAILENDRA_FROM_EMAIL: 'x@example.com', RESEND_API_KEY: 'k' });
        expect(cfg).toEqual({ key: 'k', from: 'x@example.com', to: ['ops@example.com'] });
        expect(opsAlertConfig({ OPS_ALERT_EMAIL: 'ops@example.com' })).toEqual({ missing: 'OPS_ALERT_FROM_EMAIL / SAILENDRA_FROM_EMAIL' });
    });
});
