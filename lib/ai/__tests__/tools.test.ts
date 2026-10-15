import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase, type Resolver } from '@/lib/whatsapp/__tests__/fakeSupabase';

// The executors only touch Supabase + the meeting side-effect modules. Mock
// those so no network / Next server chain is loaded; the Supabase fake records
// every query for assertions.
let fake: FakeSupabase;
vi.mock('@/lib/supabase/service', () => ({
    createServiceOrServerClient: vi.fn(async () => fake.client),
}));
vi.mock('@/lib/zoom/client', () => ({
    getZoomConfig: vi.fn(() => null),
    createZoomMeeting: vi.fn(),
}));
vi.mock('@/lib/meetings/notify', () => ({ sendMeetingInvite: vi.fn() }));
vi.mock('@/lib/meetings/notify-whatsapp', () => ({ notifySalesWhatsApp: vi.fn(async () => ({ sent: false })) }));

import {
    checkAvailability,
    listProducts,
    updateLeadStage,
    handoffToHuman,
    saveLeadInfo,
    scheduleMeeting,
    checkMeetingAvailability,
    buildTools,
} from '@/lib/ai/tools';
import { createZoomMeeting } from '@/lib/zoom/client';
import { notifySalesWhatsApp } from '@/lib/meetings/notify-whatsapp';
import { GENERIC_BUSINESS_PROFILE } from '@/lib/settings/business-profile';

const ORG_A = '5a11e024-0001-4000-8000-000000000001';
const PHONE = '628123456789';
const profile = { ...GENERIC_BUSINESS_PROFILE, handoffName: 'MJ', handoffPhone: '628111' };

function setup(resolve?: Resolver, rpc?: (name: string, args: unknown) => { data?: unknown; error?: unknown }) {
    fake = makeFakeSupabase({ resolve, rpc });
}

beforeEach(() => {
    vi.clearAllMocks();
    setup();
});

// WHERE guard on AI-driven stage writes (human-owned stages are locked).
const GUARD = 'lead_stage.is.null,lead_stage.not.in.(booked,won,lost)';

const hasFilter = (filters: Array<[string, string, unknown]>, op: string, col: string, val?: unknown) =>
    filters.some(([o, c, v]) => o === op && c === col && (val === undefined || v === val));

describe('catalog tools are org-scoped (KUA-3)', () => {
    it('checkAvailability filters by org_id and escapes the search term', async () => {
        setup(() => ({ data: [{ id: 'p1', name: 'Kopi 100%', price: 1000, stock: 3, type: 'product', description: '' }], error: null }));
        const out = JSON.parse(await checkAvailability(ORG_A, 'Kopi 100%'));
        expect(out.found).toBe(true);
        const call = fake.calls[0];
        expect(call.table).toBe('products');
        expect(hasFilter(call.filters, 'eq', 'org_id', ORG_A)).toBe(true);
        expect(hasFilter(call.filters, 'ilike', 'name', '%Kopi 100\\%%')).toBe(true);
    });

    it('listProducts filters by org_id, clamps the limit and returns ids', async () => {
        setup(() => ({ data: [{ id: 'p1', name: 'Kaos', price: 50000, stock: 2, type: 'product' }], error: null }));
        const out = JSON.parse(await listProducts(ORG_A, 9999));
        expect(out.products[0].id).toBe('p1');
        expect(hasFilter(fake.calls[0].filters, 'eq', 'org_id', ORG_A)).toBe(true);
        expect(fake.calls[0].limitN).toBe(50);
    });
});

describe('update_lead_stage tool schema + executor (KEA-12)', () => {
    it('the tool enum only offers the AI-settable stages', () => {
        const tool = buildTools(profile).find((t) => t.type === 'function' && t.function.name === 'update_lead_stage');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params = (tool as any).function.parameters;
        expect(params.properties.stage.enum).toEqual(['new', 'qualifying', 'quoted', 'scheduled']);
    });

    it('refuses to move a lead out of a human-owned stage on the AI path', async () => {
        setup((c) => (c.op === 'select' ? { data: { notes: null, lead_stage: 'won' }, error: null } : { data: null, error: null }));
        const out = JSON.parse(await updateLeadStage(ORG_A, PHONE, 'quoted', null, { protectHumanStages: true }));
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/human team/);
        expect(fake.calls.some((c) => c.op === 'upsert')).toBe(false);
    });

    it('still advances an early-stage lead, via a DB-guarded conditional update', async () => {
        setup((c) =>
            c.op === 'select'
                ? { data: { notes: 'op', lead_stage: 'qualifying' }, error: null }
                : { data: [{ lead_stage: 'quoted' }], error: null },
        );
        const out = JSON.parse(await updateLeadStage(ORG_A, PHONE, 'quoted', 'harga dikirim', { protectHumanStages: true }));
        expect(out.ok).toBe(true);
        expect(fake.calls.some((c) => c.op === 'upsert')).toBe(false);
        const upd = fake.calls.find((c) => c.op === 'update')!;
        expect(upd.payload).toMatchObject({ lead_stage: 'quoted' });
        expect((upd.payload as { notes: string }).notes.startsWith('op\n')).toBe(true);
        expect(hasFilter(upd.filters, 'eq', 'org_id', ORG_A)).toBe(true);
        expect(hasFilter(upd.filters, 'eq', 'phone_number', PHONE)).toBe(true);
        // The human-stage lock is part of the WHERE clause (NULL stage allowed).
        expect(hasFilter(upd.filters, 'or', GUARD)).toBe(true);
    });

    it('reports the lock when a human set booked/won/lost between the read and the write', async () => {
        let reads = 0;
        setup((c) => {
            if (c.op === 'select') {
                reads++;
                return { data: reads === 1 ? { notes: null, lead_stage: 'quoted' } : { lead_stage: 'won' }, error: null };
            }
            return { data: [], error: null }; // guarded update matched no row
        });
        const out = JSON.parse(await updateLeadStage(ORG_A, PHONE, 'scheduled', null, { protectHumanStages: true }));
        expect(out.ok).toBe(false);
        expect(out.stage).toBe('won');
        expect(out.error).toMatch(/human team/);
    });

    it('creates the chat row via upsert when none exists yet', async () => {
        setup(() => ({ data: null, error: null }));
        const out = JSON.parse(await updateLeadStage(ORG_A, PHONE, 'new', null, { protectHumanStages: true }));
        expect(out.ok).toBe(true);
        const up = fake.calls.find((c) => c.op === 'upsert')!;
        expect(up.payload).toMatchObject({ org_id: ORG_A, phone_number: PHONE, lead_stage: 'new' });
    });
});

describe('save_lead_info notes (KEA-12)', () => {
    it('appends an AI-labelled line instead of overwriting operator notes', async () => {
        setup((c) => (c.op === 'select' ? { data: { notes: 'Catatan operator', contact_type: 'lead' }, error: null } : { data: null, error: null }));
        await saveLeadInfo(ORG_A, PHONE, { notes: 'minta menu vegetarian' }, profile);
        const up = fake.calls.find((c) => c.op === 'upsert')!;
        const notes = (up.payload as { notes: string }).notes;
        expect(notes.startsWith('Catatan operator\n[')).toBe(true);
        expect(notes).toMatch(/\] AI: minta menu vegetarian$/);
    });
});

describe('handoff_to_human (KEA-12)', () => {
    it('assigns the lead (org-scoped) but leaves ai_enabled to the queue, after the reply is sent', async () => {
        setup((c) => (c.op === 'select' ? { data: { notes: null }, error: null } : { data: null, error: null }));
        const out = JSON.parse(await handoffToHuman(ORG_A, PHONE, 'minta diskon besar', profile));
        expect(out.ok).toBe(true);
        expect(out.ai_auto_reply).toBe('off_after_this_reply');
        const upd = fake.calls.find((c) => c.op === 'update')!;
        expect(upd.table).toBe('whatsapp_chats');
        expect(upd.payload).toMatchObject({ assigned_to: 'MJ' });
        // Writing ai_enabled=false here would make a retry of a failed turn go
        // silent (queue skip path) - the queue does it after a successful send.
        expect(upd.payload).not.toHaveProperty('ai_enabled');
        expect(hasFilter(upd.filters, 'eq', 'org_id', ORG_A)).toBe(true);
        expect(hasFilter(upd.filters, 'eq', 'phone_number', PHONE)).toBe(true);
    });
});

describe('one active meeting per customer (KEA-12)', () => {
    // A future Tuesday, 14:00 WIB — passes the weekday + business-hours rules.
    const SLOT = '2030-06-04T14:00:00+07:00';
    // Also a Tuesday 14:00 WIB, but 9 weeks out — beyond the 30-day booking horizon.
    const SLOT_TOO_FAR = '2030-08-06T14:00:00+07:00';

    // Pin "now" a few days before SLOT so the 30-day booking horizon (D13) holds.
    // Only Date is faked, so promise/timer scheduling is untouched.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2030-06-01T08:00:00+07:00'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('refuses a slot beyond the booking horizon in both tools, before touching the DB', async () => {
        setup(() => ({ data: null, error: null }));
        const booked = JSON.parse(await scheduleMeeting(ORG_A, PHONE, SLOT_TOO_FAR, null));
        expect(booked.ok).toBe(false);
        expect(booked.error).toContain('30 hari');
        const avail = JSON.parse(await checkMeetingAvailability(ORG_A, SLOT_TOO_FAR, PHONE));
        expect(avail.available).toBe(false);
        expect(avail.reason).toContain('30 hari');
        expect(fake.rpcCalls).toHaveLength(0);
        expect(fake.calls).toHaveLength(0);
    });

    it('schedule_meeting relays customer_limit with the existing time and books nothing', async () => {
        setup(
            (c) => (c.op === 'select' ? { data: { contact_name: 'Budi', company: 'PT Maju', lead_stage: 'quoted' }, error: null } : { data: null, error: null }),
            () => ({
                data: {
                    meeting_id: null, created: false, full: false, conflict: false,
                    customer_limit: true, existing_meeting_id: 'm1', existing_event_date: '2030-06-03T07:00:00+00:00',
                },
                error: null,
            }),
        );
        const out = JSON.parse(await scheduleMeeting(ORG_A, PHONE, SLOT, null));
        expect(out.ok).toBe(false);
        expect(out.customer_limit).toBe(true);
        expect(out.error).toMatch(/14[.:]00 WIB/);
        expect(out.error).toMatch(/JANGAN pesan meeting lain/);
        expect(createZoomMeeting).not.toHaveBeenCalled();
        expect(notifySalesWhatsApp).not.toHaveBeenCalled();
        expect(fake.calls.some((c) => c.op === 'update' || c.op === 'upsert')).toBe(false);
    });

    it('check_meeting_availability reports the existing upcoming meeting for that number', async () => {
        setup((c) =>
            c.op === 'select' && hasFilter(c.filters, 'eq', 'customer_phone', PHONE)
                ? { data: [{ event_date: '2030-06-03T07:00:00Z', meeting_duration_min: 40, status: 'scheduled' }], error: null }
                : { data: [], error: null },
        );
        const out = JSON.parse(await checkMeetingAvailability(ORG_A, SLOT, PHONE));
        expect(out.available).toBe(false);
        expect(out.customer_limit).toBe(true);
    });

    it('check_meeting_availability treats the slot the customer already holds as their booking, not a limit hit', async () => {
        setup((c) =>
            c.op === 'select' && hasFilter(c.filters, 'eq', 'customer_phone', PHONE)
                ? { data: [{ event_date: '2030-06-04T07:00:00+00:00', meeting_duration_min: 40, status: 'scheduled' }], error: null }
                : { data: [{ event_date: '2030-06-04T07:00:00+00:00', meeting_duration_min: 40 }], error: null },
        );
        const out = JSON.parse(await checkMeetingAvailability(ORG_A, SLOT, PHONE));
        expect(out.available).toBe(true);
        expect(out.already_booked).toBe(true);
        expect(out.customer_limit).toBeUndefined();
    });

    it('a fresh booking bumps the stage with a DB-guarded write', async () => {
        setup(
            (c) =>
                c.op === 'select'
                    ? { data: { contact_name: 'Budi', company: 'PT Maju', lead_stage: 'quoted', notes: 'op' }, error: null }
                    : { data: [{ lead_stage: 'scheduled' }], error: null },
            () => ({ data: { meeting_id: 'm3', created: true, full: false, conflict: false, customer_limit: false }, error: null }),
        );
        const out = JSON.parse(await scheduleMeeting(ORG_A, PHONE, SLOT, null));
        expect(out.ok).toBe(true);
        expect(out.stage).toBe('scheduled');
        const chatUpdates = fake.calls.filter((c) => c.op === 'update' && c.table === 'whatsapp_chats');
        // notes/audit write is unconditional; the stage write carries the guard.
        expect(chatUpdates[0].payload).not.toHaveProperty('lead_stage');
        expect((chatUpdates[0].payload as { notes: string }).notes).toMatch(/^op\n\[.*meeting booked/);
        expect(chatUpdates[1].payload).toEqual({ lead_stage: 'scheduled' });
        expect(hasFilter(chatUpdates[1].filters, 'or', GUARD)).toBe(true);
    });

    it('a stage a human set mid-booking is left alone (guard matches no row)', async () => {
        setup(
            (c) =>
                c.op === 'select'
                    ? { data: { contact_name: 'Budi', company: 'PT Maju', lead_stage: 'quoted', notes: null }, error: null }
                    : { data: [], error: null },
            () => ({ data: { meeting_id: 'm4', created: true, full: false, conflict: false, customer_limit: false }, error: null }),
        );
        const out = JSON.parse(await scheduleMeeting(ORG_A, PHONE, SLOT, null));
        expect(out.ok).toBe(true);
        expect(out.stage).toBeNull();
    });

    it('a booking never pulls a lead out of a human-owned stage', async () => {
        setup(
            (c) => (c.op === 'select' ? { data: { contact_name: 'Budi', company: 'PT Maju', lead_stage: 'booked', notes: null }, error: null } : { data: null, error: null }),
            () => ({ data: { meeting_id: 'm2', created: true, full: false, conflict: false, customer_limit: false }, error: null }),
        );
        const out = JSON.parse(await scheduleMeeting(ORG_A, PHONE, SLOT, null));
        expect(out.ok).toBe(true);
        expect(out.stage).toBe('booked');
        const upd = fake.calls.find((c) => c.op === 'update' && c.table === 'whatsapp_chats')!;
        expect(upd.payload).not.toHaveProperty('lead_stage');
    });
});
