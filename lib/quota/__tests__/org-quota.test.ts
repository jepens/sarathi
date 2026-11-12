import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-org quotas (tracker 3.4, migration 0071): the RPC reply is mapped as is
// (including an org's own limit), the team is warned when the daily count
// reaches 80% of the limit in force and alerted on the first refusal after a
// call that was let through (once per window, and again after a raised limit
// is reached), and a counter that cannot be used lets the call through and
// alerts the team. Fake ids only.

const h = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/lib/ops/events', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/ops/events')>()),
    recordOpsEvent: h.record,
}));

import {
    consumeOrgQuota,
    firstInboundRefusalNote,
    inboundQuotaNotice,
    QUOTA_DEFAULTS,
    recordInboundQuotaAlerts,
    warnThreshold,
} from '@/lib/quota/org-quota';

const ORG = '5a11e024-0001-4000-8000-000000000001';

function client(reply: { data?: unknown; error?: unknown } | (() => never)) {
    const rpc = vi.fn(async () => (typeof reply === 'function' ? reply() : reply));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { rpc, client: { rpc } as any };
}

const row = (allowed: boolean, used: number, refused: number, quota: number, firstRefusal = false) => [
    { allowed, used, refused, quota, first_refusal: firstRefusal },
];

beforeEach(() => {
    h.record.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('consumeOrgQuota', () => {
    it('asks for the metric with the default limit and maps the reply', async () => {
        const f = client({ data: row(true, 7, 0, 300), error: null });
        const d = await consumeOrgQuota(f.client, ORG, 'ai_reply_day');
        expect(f.rpc).toHaveBeenCalledWith('consume_org_quota', { p_org: ORG, p_metric: 'ai_reply_day', p_default_limit: 300 });
        expect(d).toEqual({ allowed: true, used: 7, refused: 0, limit: 300, firstRefusal: false });
        expect(h.record).not.toHaveBeenCalled();
    });

    it('defaults are 30 new AI conversations a minute and 300 AI replies a day', () => {
        expect(QUOTA_DEFAULTS).toEqual({ inbound_minute: 30, ai_reply_day: 300 });
    });

    it('accepts a single row object as well as a set', async () => {
        const f = client({ data: { allowed: false, used: 30, refused: 4, quota: 30, first_refusal: false }, error: null });
        expect(await consumeOrgQuota(f.client, ORG, 'inbound_minute')).toEqual({
            allowed: false,
            used: 30,
            refused: 4,
            limit: 30,
            firstRefusal: false,
        });
    });

    it('warns once, on the call that reaches 80% of the daily quota', async () => {
        expect(warnThreshold(300)).toBe(240);
        expect(warnThreshold(1)).toBe(1);
        for (const used of [239, 240, 241]) {
            await consumeOrgQuota(client({ data: row(true, used, 0, 300) }).client, ORG, 'ai_reply_day');
        }
        expect(h.record).toHaveBeenCalledTimes(1);
        expect(h.record).toHaveBeenCalledWith(expect.anything(), 'quota_ai_daily_warning', {
            orgId: ORG,
            detail: '240 dari 300 balasan AI hari ini terpakai',
        });
    });

    it("uses the org's own limit for the warning and the refusal (not the default)", async () => {
        const d = await consumeOrgQuota(client({ data: row(true, 80, 0, 100) }).client, ORG, 'ai_reply_day');
        expect(d.limit).toBe(100);
        expect(h.record).toHaveBeenCalledWith(expect.anything(), 'quota_ai_daily_warning', {
            orgId: ORG,
            detail: '80 dari 100 balasan AI hari ini terpakai',
        });
        h.record.mockClear();
        await consumeOrgQuota(client({ data: row(false, 100, 1, 100, true) }).client, ORG, 'ai_reply_day');
        expect(h.record.mock.calls[0][2]).toEqual({ orgId: ORG, detail: 'batas 100 balasan AI per hari tercapai' });
    });

    it('has no 80% warning for the minute window', async () => {
        await consumeOrgQuota(client({ data: row(true, 24, 0, 30) }).client, ORG, 'inbound_minute');
        expect(h.record).not.toHaveBeenCalled();
    });

    it('alerts on the first refusal after a call let through only, and again after a raised limit is reached', async () => {
        await consumeOrgQuota(client({ data: row(false, 300, 1, 300, true) }).client, ORG, 'ai_reply_day');
        await consumeOrgQuota(client({ data: row(false, 300, 2, 300) }).client, ORG, 'ai_reply_day');
        await consumeOrgQuota(client({ data: row(false, 30, 1, 30, true) }).client, ORG, 'inbound_minute');
        // the team raised the limit to 600; the org reached it the same day
        await consumeOrgQuota(client({ data: row(false, 600, 3, 600, true) }).client, ORG, 'ai_reply_day');
        expect(h.record.mock.calls.map((c) => c[1])).toEqual([
            'quota_ai_daily_exceeded',
            'quota_inbound_exceeded',
            'quota_ai_daily_exceeded',
        ]);
        expect(h.record.mock.calls[0][2]).toEqual({ orgId: ORG, detail: 'batas 300 balasan AI per hari tercapai' });
        expect(h.record.mock.calls[2][2]).toEqual({ orgId: ORG, detail: 'batas 600 balasan AI per hari tercapai' });
    });

    it('fails open on an RPC error and alerts with the error code only', async () => {
        const f = client({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
        const d = await consumeOrgQuota(f.client, ORG, 'ai_reply_day');
        expect(d).toEqual({ allowed: true, used: 0, refused: 0, limit: 300, firstRefusal: false });
        expect(h.record).toHaveBeenCalledWith(expect.anything(), 'quota_check_failed', {
            orgId: ORG,
            detail: 'ai_reply_day: PGRST202',
        });
    });

    it('fails open when the RPC throws or returns no row', async () => {
        const thrown = client(() => {
            throw new TypeError('fetch failed');
        });
        expect((await consumeOrgQuota(thrown.client, ORG, 'inbound_minute')).allowed).toBe(true);
        expect((await consumeOrgQuota(client({ data: [], error: null }).client, ORG, 'inbound_minute')).allowed).toBe(true);
        expect(h.record.mock.calls.map((c) => c[2].detail)).toEqual(['inbound_minute: TypeError', 'inbound_minute: Error']);
    });
});

describe('recordInboundQuotaAlerts (the minute quota counted inside wa_ingest_inbound, 0072)', () => {
    it("alerts the first refusal with the org's own limit, in consumeOrgQuota's words", async () => {
        await recordInboundQuotaAlerts(client({}).client, ORG, { limit: 12, firstRefusal: true, error: null });
        expect(h.record.mock.calls).toEqual([
            [expect.anything(), 'quota_inbound_exceeded', { orgId: ORG, detail: 'batas 12 percakapan AI baru per menit tercapai' }],
        ]);
        // The same text as a refusal reported by consumeOrgQuota.
        h.record.mockClear();
        await consumeOrgQuota(client({ data: row(false, 12, 1, 12, true) }).client, ORG, 'inbound_minute');
        expect(h.record.mock.calls[0][2]).toEqual({ orgId: ORG, detail: 'batas 12 percakapan AI baru per menit tercapai' });
    });

    it('alerts a counter failure (the message was let through) with its SQLSTATE only', async () => {
        await recordInboundQuotaAlerts(client({}).client, ORG, { limit: null, firstRefusal: false, error: '57014' });
        expect(h.record.mock.calls).toEqual([
            [expect.anything(), 'quota_check_failed', { orgId: ORG, detail: 'inbound_minute: 57014' }],
        ]);
    });

    it('a later refusal of the window, or an allowed message, alerts nothing', async () => {
        await recordInboundQuotaAlerts(client({}).client, ORG, { limit: 30, firstRefusal: false, error: null });
        expect(h.record).not.toHaveBeenCalled();
    });

    it('falls back to the default limit when the refusal carries none', async () => {
        await recordInboundQuotaAlerts(client({}).client, ORG, { limit: null, firstRefusal: true, error: null });
        expect(h.record.mock.calls[0][2]).toEqual({ orgId: ORG, detail: `batas ${QUOTA_DEFAULTS.inbound_minute} percakapan AI baru per menit tercapai` });
    });
});

describe('operator note on a message the minute quota kept from the AI', () => {
    it('names the limit', () => {
        expect(inboundQuotaNotice(30)).toContain('batas 30 percakapan AI baru per menit');
        expect(inboundQuotaNotice(30)).toContain('AI tetap membaca pesan ini sebagai konteks');
    });

    it('is added at most once per chat and minute', () => {
        const t = 1_800_000_000_000; // a minute boundary
        expect(firstInboundRefusalNote('org:6200001', t)).toBe(true);
        expect(firstInboundRefusalNote('org:6200001', t + 30_000)).toBe(false);
        expect(firstInboundRefusalNote('org:6200002', t + 30_000)).toBe(true); // another chat
        expect(firstInboundRefusalNote('org:6200001', t + 60_000)).toBe(true); // the next minute
    });
});
