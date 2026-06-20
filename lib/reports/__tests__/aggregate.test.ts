import { describe, it, expect, vi } from 'vitest';
import { makeFakeSupabase, type FakeCall } from '@/lib/whatsapp/__tests__/fakeSupabase';

// aggregate.ts imports LEAD_STAGES from ai/tools, which pulls in server-only
// modules (supabase/server → next/headers). Mock it down to the one constant
// aggregate actually uses so this node test never loads the server chain.
vi.mock('@/lib/ai/tools', () => ({
    LEAD_STAGES: ['new', 'qualifying', 'quoted', 'scheduled', 'booked', 'won', 'lost'],
}));

import { computeReport } from '@/lib/reports/aggregate';

const START = '2026-05-01T00:00:00.000Z';
const END = '2026-07-15T00:00:00.000Z';

// Orders in the period window. The 7M order is at 2026-05-31 20:00 UTC, which is
// 2026-06-01 03:00 in WIB — it must bucket into JUNE, not May.
const periodOrders = [
    { total_amount: 10_000_000, status: 'paid', created_at: '2026-05-10T03:00:00Z', event_type: 'Wedding' },
    { total_amount: 20_000_000, status: 'won', created_at: '2026-06-15T05:00:00Z', event_type: 'Gathering' },
    { total_amount: 7_000_000, status: 'completed', created_at: '2026-05-31T20:00:00Z', event_type: 'Wedding' },
    { total_amount: 5_000_000, status: 'pending', created_at: '2026-06-20T05:00:00Z', event_type: 'Wedding' },
    { total_amount: 99, status: 'cancelled', created_at: '2026-06-01T05:00:00Z', event_type: 'Batal' },
];

const outstandingOrders = [
    { total_amount: 30_000_000, dp_amount: 10_000_000 }, // 20M outstanding
    { total_amount: 5_000_000, dp_amount: 5_000_000 }, // 0
    { total_amount: 8_000_000, dp_amount: null }, // 8M
];

const leads = [
    { lead_stage: 'won', source: 'whatsapp', created_at: '2026-05-05T03:00:00Z' },
    { lead_stage: 'lost', source: 'instagram', created_at: '2026-05-06T03:00:00Z' },
    { lead_stage: 'won', source: 'whatsapp', created_at: '2026-06-06T03:00:00Z' },
    { lead_stage: 'qualifying', source: null, created_at: '2026-06-07T03:00:00Z' },
    { lead_stage: null, source: 'event', created_at: '2026-03-01T03:00:00Z' }, // before the period
];

function client() {
    return makeFakeSupabase({
        resolve: (c: FakeCall) => {
            if (c.table === 'orders') {
                // the two orders queries differ by their select list
                return c.select?.includes('dp_amount')
                    ? { data: outstandingOrders }
                    : { data: periodOrders };
            }
            if (c.table === 'whatsapp_chats') return { data: leads };
            return { data: [] };
        },
    }).client;
}

describe('computeReport — KPIs', () => {
    it('counts only paid/won/completed as revenue; bookings exclude cancelled', async () => {
        const r = await computeReport(client(), START, END);
        expect(r.kpis.revenue).toBe(37_000_000); // 10 + 20 + 7 (pending & cancelled excluded)
        expect(r.kpis.bookings).toBe(4); // all non-cancelled
        expect(r.kpis.avgBookingValue).toBe(10_500_000); // round(42M / 4)
        expect(r.kpis.outstanding).toBe(28_000_000); // 20 + 0 + 8
    });
});

describe('computeReport — WIB month bucketing', () => {
    it('buckets a UTC-evening order into the next WIB month', async () => {
        const r = await computeReport(client(), START, END);
        expect(r.revenueByMonth.map((m) => [m.month, m.revenue])).toEqual([
            ['2026-05', 10_000_000],
            ['2026-06', 27_000_000], // 20M (won) + 7M (completed, WIB-June though UTC-May)
            ['2026-07', 0],
        ]);
    });
});

describe('computeReport — breakdowns', () => {
    it('ranks revenue by event type (desc)', async () => {
        const r = await computeReport(client(), START, END);
        expect(r.revenueByEventType).toEqual([
            { type: 'Gathering', revenue: 20_000_000 },
            { type: 'Wedding', revenue: 17_000_000 }, // 10 + 7
        ]);
    });

    it('computes funnel, conversion, period lead count, and sources', async () => {
        const r = await computeReport(client(), START, END);
        expect(r.kpis.leads).toBe(4); // the March lead is outside the period
        expect(r.leadFunnel.won).toBe(2);
        expect(r.leadFunnel.lost).toBe(1);
        expect(r.leadFunnel.qualifying).toBe(1);
        expect(r.leadFunnel.unstaged).toBe(1); // the null-stage lead
        expect(r.kpis.conversionRate).toBeCloseTo(66.6667, 2); // 2 / (2 + 1)
        expect(r.leadsBySource[0]).toEqual({ label: 'WhatsApp', count: 3 }); // 2 wa + 1 null
    });
});
