import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Team alert emails (tracker 3.5, migration 0070). The claim, the cooldown per
// (kind, org) and the marking happen in SQL (pgTAP 200); here: nothing is
// claimed without a recipient; the claimed groups become one email; the
// events are marked sent only after the email went out, and the claim is
// released when sending fails; the daily summary comes once a day from
// 08:00 WIB, also on quiet days. Fake ids and addresses only.

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
    Resend: class {
        emails = { send: h.send };
    },
}));

import {
    DAILY_ALERT_KINDS,
    buildOpsAlertEmail,
    buildOpsDailySummaryEmail,
    maybeSendOpsAlerts,
    maybeSendOpsDailySummary,
    opsAlertConfig,
    startOfWibDay,
    type OpsAlertGroup,
} from '@/lib/ops/alerts';

const ORG = '5a11e024-0001-4000-8000-000000000001';
const NOW = new Date('2026-10-18T03:30:00Z'); // 10:30 WIB
const STAMP = '2026-10-18T03:30:00.123456+00:00';
const CUTOFF = '2026-10-18T03:29:00+00:00';

interface Fake {
    rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
    replies: Record<string, { data?: unknown; error?: unknown }>;
    unsentCount: number;
    failedJobs: number;
}

let fake: Fake;

function client() {
    return {
        rpc: async (fn: string, args: Record<string, unknown>) => {
            fake.rpcCalls.push({ fn, args });
            return fake.replies[fn] ?? { data: null, error: null };
        },
        from(table: string) {
            if (table === 'organizations') {
                return { select: () => ({ in: async () => ({ data: [{ id: ORG, name: 'Sailendra' }], error: null }) }) };
            }
            if (table === 'ops_events') {
                return { select: () => ({ is: async () => ({ count: fake.unsentCount, error: null }) }) };
            }
            expect(table).toBe('message_queue');
            return { select: () => ({ eq: () => ({ gte: async () => ({ count: fake.failedJobs, error: null }) }) }) };
        },
    };
}

const group = (kind: string, events: number, orgId: string | null = ORG, details: string[] | null = [`contoh ${kind}`]): OpsAlertGroup => ({
    kind,
    org_id: orgId,
    events,
    first_at: '2026-10-18T03:10:00+00:00',
    last_at: '2026-10-18T03:28:00+00:00',
    details,
    stamp: STAMP,
    cutoff: CUTOFF,
});

const fns = () => fake.rpcCalls.map((c) => c.fn);

beforeEach(() => {
    fake = { rpcCalls: [], replies: {}, unsentCount: 0, failedJobs: 0 };
    h.send.mockReset();
    h.send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.com, Tim Sarathi <tim@example.com>');
    vi.stubEnv('OPS_ALERT_FROM_EMAIL', 'Sarathi <alert@example.com>');
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllEnvs();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (now = NOW) => maybeSendOpsAlerts(client() as any, now);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runDaily = (now: Date) => maybeSendOpsDailySummary(client() as any, now);

describe('maybeSendOpsAlerts', () => {
    it('sends nothing when no group is due', async () => {
        fake.replies.claim_ops_alerts = { data: [], error: null };
        expect(await run()).toEqual({ sent: false, kinds: [] });
        expect(h.send).not.toHaveBeenCalled();
        expect(fns()).toEqual(['claim_ops_alerts']);
        expect(fake.rpcCalls[0].args).toEqual({ p_cooldown_seconds: 3600, p_daily_kinds: ['webhook_unrouted'] });
    });

    it('emails every claimed group once, then marks the events sent with the claim stamp', async () => {
        fake.replies.claim_ops_alerts = {
            data: [group('queue_job_failed', 2), group('webhook_signature_invalid', 1200, null, null)],
            error: null,
        };
        const result = await run();
        expect(result).toEqual({ sent: true, kinds: ['queue_job_failed', 'webhook_signature_invalid'] });
        expect(h.send).toHaveBeenCalledTimes(1);
        const mail = h.send.mock.calls[0][0];
        expect(mail.to).toEqual(['ops@example.com', 'tim@example.com']);
        expect(mail.from).toBe('Sarathi <alert@example.com>');
        expect(mail.subject).toContain('Balasan AI gagal');
        expect(mail.text).toContain('Balasan AI gagal setelah semua percobaan: 2 kejadian');
        expect(mail.text).toContain('org: Sailendra (2)');
        expect(mail.text).toContain('tanda tangan tidak valid (403): 1200 kejadian');
        expect(mail.text).toContain('org: tanpa org (1200)');
        expect(fns()).toEqual(['claim_ops_alerts', 'mark_ops_alerts_sent']);
        expect(fake.rpcCalls[1].args).toEqual({ p_stamp: STAMP, p_cutoff: CUTOFF });
        expect(mail.text).toContain('paling cepat 1 jam lagi. ');
    });

    it('a number new to the WABA is emailed within the hour; its recurring traffic once a day', () => {
        expect(DAILY_ALERT_KINDS).toContain('webhook_unrouted');
        expect(DAILY_ALERT_KINDS).not.toContain('webhook_unrouted_new');
        const { text } = buildOpsAlertEmail(
            [group('webhook_unrouted_new', 1, null), group('webhook_unrouted', 7, null)],
            new Map(),
            NOW,
        );
        expect(text).toContain('pertama kali dalam 7 hari');
        expect(text).toContain('paling cepat 1 jam lagi (1 hari lagi untuk: Webhook untuk nomor lain di WABA (bukan nomor org ini)). ');
    });

    it('the footer names the kinds that wait a day before the next email', () => {
        DAILY_ALERT_KINDS.push('tst_daily');
        try {
            const { text } = buildOpsAlertEmail([group('queue_job_failed', 1), group('tst_daily', 4, null)], new Map(), NOW);
            expect(text).toContain('paling cepat 1 jam lagi (1 hari lagi untuk: tst_daily). ');
        } finally {
            DAILY_ALERT_KINDS.pop();
        }
    });

    it('a failed send releases the claim and marks nothing', async () => {
        fake.replies.claim_ops_alerts = { data: [group('webhook_error', 3)], error: null };
        h.send.mockResolvedValue({ data: null, error: { message: 'rate limited' } });
        expect(await run()).toEqual({ sent: false, kinds: [], reason: 'send failed' });
        expect(fns()).toEqual(['claim_ops_alerts', 'release_ops_alerts']);
        expect(fake.rpcCalls[1].args).toEqual({ p_stamp: STAMP });
    });

    it('a failed claim sends nothing and says so', async () => {
        fake.replies.claim_ops_alerts = { data: null, error: { code: '57014' } };
        expect(await run()).toEqual({ sent: false, kinds: [], reason: 'claim failed' });
        expect(h.send).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith('Ops alerts: claiming failed', { code: '57014' });
    });

    it('without a recipient nothing is claimed, and the backlog is logged once an hour', async () => {
        vi.stubEnv('OPS_ALERT_EMAIL', '');
        fake.unsentCount = 7;
        expect(await run()).toEqual({ sent: false, kinds: [], reason: 'OPS_ALERT_EMAIL not set' });
        expect(fake.rpcCalls).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled(); // 10:30, not on the hour
        await run(new Date('2026-10-18T04:00:00Z'));
        expect(console.warn).toHaveBeenCalledWith('Ops alerts: 7 unsent event row(s) not emailed, OPS_ALERT_EMAIL not set');
    });
});

describe('opsAlertConfig', () => {
    it('accepts "Name <address>", drops what is not an address and falls back to SAILENDRA_FROM_EMAIL', () => {
        const cfg = opsAlertConfig({
            OPS_ALERT_EMAIL: 'bukan-email, Tim <ops@example.com>',
            SAILENDRA_FROM_EMAIL: 'x@example.com',
            RESEND_API_KEY: 'k',
        });
        expect(cfg).toEqual({ key: 'k', from: 'x@example.com', to: ['ops@example.com'], dropped: 1 });
        expect(opsAlertConfig({ OPS_ALERT_EMAIL: 'ops@example.com' })).toEqual({ missing: 'OPS_ALERT_FROM_EMAIL / SAILENDRA_FROM_EMAIL' });
        expect(opsAlertConfig({ OPS_ALERT_EMAIL: 'Tim Sarathi' })).toEqual({ missing: 'OPS_ALERT_EMAIL' });
    });
});

describe('maybeSendOpsDailySummary', () => {
    it('waits for 08:00 WIB', async () => {
        expect(await runDaily(new Date('2026-10-18T00:59:00Z'))).toEqual({ sent: false }); // 07:59 WIB
        expect(fake.rpcCalls).toEqual([]);
    });

    it('claims the day once from 08:00 WIB and sends the totals of the last 24 hours, also on a quiet day', async () => {
        const at = new Date('2026-10-18T01:00:00Z'); // 08:00 WIB
        fake.replies.claim_ops_daily_summary = { data: STAMP, error: null };
        fake.replies.ops_events_summary = { data: [], error: null };
        expect(await runDaily(at)).toEqual({ sent: true });
        expect(fake.rpcCalls[0]).toEqual({ fn: 'claim_ops_daily_summary', args: { p_since: '2026-10-17T17:00:00.000Z' } });
        expect(fake.rpcCalls[1]).toEqual({ fn: 'ops_events_summary', args: { p_since: '2026-10-17T01:00:00.000Z' } });
        const mail = h.send.mock.calls[0][0];
        expect(mail.subject).toBe('[Sarathi] Ringkasan harian: tidak ada kejadian');
        expect(mail.text).toContain('Kejadian operasional: tidak ada.');
        expect(mail.text).toContain('Job antrean gagal: tidak ada.');
    });

    it('does nothing when the day was already claimed, and releases the claim when sending fails', async () => {
        const at = new Date('2026-10-18T05:00:00Z');
        fake.replies.claim_ops_daily_summary = { data: null, error: null };
        expect(await runDaily(at)).toEqual({ sent: false });
        expect(h.send).not.toHaveBeenCalled();

        fake.rpcCalls = [];
        fake.replies.claim_ops_daily_summary = { data: STAMP, error: null };
        h.send.mockResolvedValue({ data: null, error: { message: 'down' } });
        expect(await runDaily(at)).toEqual({ sent: false, reason: 'send failed' });
        expect(fns()).toEqual(['claim_ops_daily_summary', 'ops_events_summary', 'release_ops_alerts']);
    });
});

describe('daily summary when the events cannot be read', () => {
    it('says so instead of a false all-clear', async () => {
        const at = new Date('2026-10-18T01:00:00Z');
        fake.replies.claim_ops_daily_summary = { data: STAMP, error: null };
        fake.replies.ops_events_summary = { data: null, error: { code: '57014' } };
        fake.failedJobs = 3;
        expect(await runDaily(at)).toEqual({ sent: true });
        const mail = h.send.mock.calls[0][0];
        expect(mail.subject).toBe('[Sarathi] Ringkasan harian: kejadian tidak bisa dibaca, 3 job gagal');
        expect(mail.text).toContain('Kejadian operasional: tidak bisa dibaca');
        expect(mail.text).not.toContain('tidak ada.');
    });
});

describe('daily summary content', () => {
    it('lists totals per kind with the part not emailed, and the failed queue jobs', () => {
        const { subject, text } = buildOpsDailySummaryEmail(
            [
                { kind: 'queue_job_failed', org_id: ORG, events: 3, unsent: 0 },
                { kind: 'webhook_signature_invalid', org_id: null, events: 40, unsent: 5 },
            ],
            2,
            new Map([[ORG, 'Sailendra']]),
            NOW,
        );
        expect(subject).toBe('[Sarathi] Ringkasan harian: 43 kejadian, 2 job gagal');
        expect(text).toContain('Balasan AI gagal setelah semua percobaan: 3');
        expect(text).toContain('tanda tangan tidak valid (403): 40 (5 belum dikirim lewat email)');
        expect(text).toContain('Job antrean gagal: 2.');
    });

    it('startOfWibDay is 17:00 UTC of the day before', () => {
        expect(startOfWibDay(new Date('2026-10-18T16:59:00Z')).toISOString()).toBe('2026-10-17T17:00:00.000Z');
        expect(startOfWibDay(new Date('2026-10-18T17:00:00Z')).toISOString()).toBe('2026-10-18T17:00:00.000Z');
    });
});
