import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakeSupabase } from '@/lib/whatsapp/__tests__/fakeSupabase';
import { computeFollowup } from '@/lib/followup/compute';

// Freeze "now" so the day-based staleness / horizon math is deterministic.
// 2026-06-20 05:00 UTC = 2026-06-20 12:00 WIB → today (WIB) = 2026-06-20.
const NOW = '2026-06-20T05:00:00.000Z';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
    vi.useRealTimers();
});

type Lead = Record<string, unknown>;
type Order = Record<string, unknown>;

function clientFor(leads: Lead[], orders: Order[]) {
    return makeFakeSupabase({
        resolve: (c) => {
            if (c.table === 'whatsapp_chats') return { data: leads };
            if (c.table === 'orders') return { data: orders };
            return { data: [] };
        },
    });
}

const LEADS: Lead[] = [
    // stale 'new' (5 days since last message)
    { phone_number: '628111', contact_name: 'Andi', lead_stage: 'new', last_message_at: '2026-06-15T05:00:00Z', last_inbound_at: null, created_at: '2026-06-10T05:00:00Z' },
    // fresh 'qualifying' (1 day) → NOT followed up
    { phone_number: '628222', contact_name: 'Budi', lead_stage: 'qualifying', last_message_at: '2026-06-19T05:00:00Z', last_inbound_at: '2026-06-19T05:00:00Z', created_at: '2026-06-01T05:00:00Z' },
    // 'quoted' with no inbound reply for 6 days → proposal_no_reply
    { phone_number: '628333', contact_name: 'Citra', lead_stage: 'quoted', last_message_at: '2026-06-18T05:00:00Z', last_inbound_at: '2026-06-14T05:00:00Z', created_at: '2026-06-01T05:00:00Z' },
    // 'quoted' but customer replied yesterday → neither proposal nor stale
    { phone_number: '628444', contact_name: 'Dewi', lead_stage: 'quoted', last_message_at: '2026-06-19T06:00:00Z', last_inbound_at: '2026-06-19T05:00:00Z', created_at: '2026-06-01T05:00:00Z' },
    // 'booked' → converted, never chased here
    { phone_number: '628555', contact_name: 'Eko', lead_stage: 'booked', last_message_at: '2026-01-01T00:00:00Z', last_inbound_at: null, created_at: '2026-01-01T00:00:00Z' },
    // null stage behaves as 'new'; 10 days stale
    { phone_number: '628666', contact_name: 'Eka', lead_stage: null, last_message_at: '2026-06-10T05:00:00Z', last_inbound_at: null, created_at: '2026-06-05T05:00:00Z' },
];

const ORDERS: Order[] = [
    { id: 'o1', customer_name: 'Fajar', event_date: '2026-06-22T00:00:00+07:00', status: 'scheduled', dp_paid_at: '2026-06-01T00:00:00Z', pelunasan_paid_at: null },
    { id: 'o2', customer_name: 'Gita', event_date: '2026-06-20T00:00:00+07:00', status: 'paid', dp_paid_at: '2026-06-02T00:00:00Z', pelunasan_paid_at: '2026-06-15T00:00:00Z' },
    { id: 'o3', customer_name: 'Hadi', event_date: '2026-06-25T00:00:00+07:00', status: 'scheduled', dp_paid_at: null, pelunasan_paid_at: null },
];

describe('computeFollowup — stale leads', () => {
    it('flags stale/no-reply active leads, skips fresh & converted, sorted by days desc', async () => {
        const fake = clientFor(LEADS, []);
        const r = await computeFollowup(fake.client);
        expect(r.counts.leads).toBe(3);
        expect(r.leads.map((l) => [l.phone_number, l.reason, l.days])).toEqual([
            ['628666', 'stale', 10],
            ['628333', 'proposal_no_reply', 6],
            ['628111', 'stale', 5],
        ]);
    });
});

describe('computeFollowup — upcoming bookings', () => {
    it('computes WIB days-until, DP/settled flags, sorted soonest-first', async () => {
        const fake = clientFor([], ORDERS);
        const r = await computeFollowup(fake.client);
        expect(r.counts.bookings).toBe(3);
        expect(r.bookings.map((b) => [b.id, b.days_until, b.dp_paid, b.settled])).toEqual([
            ['o2', 0, true, true],
            ['o1', 2, true, false],
            ['o3', 5, false, false],
        ]);
    });
});

describe('computeFollowup — counts & org scoping', () => {
    it('totals leads + bookings', async () => {
        const fake = clientFor(LEADS, ORDERS);
        const r = await computeFollowup(fake.client);
        expect(r.counts).toEqual({ leads: 3, bookings: 3, total: 6 });
    });

    it('scopes both queries to the org when an explicit orgId is given (cron path)', async () => {
        const fake = clientFor([], []);
        await computeFollowup(fake.client, 'org-9');
        const orgScoped = fake.calls.flatMap((c) => c.filters).filter(
            (f) => f[0] === 'eq' && f[1] === 'org_id' && f[2] === 'org-9'
        );
        expect(orgScoped).toHaveLength(2); // leads query + orders query
    });
});
