import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase } from '@/lib/whatsapp/__tests__/fakeSupabase';

// The route of each change of a delivery (Fase 2 task 2.2a part 2): a BSUID
// update before the number gate (any number, metadata or not); a field the
// webhook does not handle is acknowledged; the app's own number (or no
// number id) is handled; another number of the WABA is dropped or, in
// process mode, only stored, with part 1's alerts per change; an unknown
// WHATSAPP_OTHER_NUMBER_EVENTS value is alerted once per delivery. The org is
// never read here. Fake ids only.

const h = vi.hoisted(() => ({ logs: [] as unknown[][] }));
vi.mock('@/lib/utils/logger', async (importOriginal) => {
    const record = (...args: unknown[]) => void h.logs.push(args);
    return {
        ...(await importOriginal<typeof import('@/lib/utils/logger')>()),
        whatsappLogger: { info: record, warn: record, error: record, debug: record },
    };
});

import { isUserIdUpdateChange, routeChanges } from '@/lib/whatsapp/webhook/router';
import { listChanges } from '@/lib/whatsapp/webhook/payload';
import { resetOpsEventThrottle } from '@/lib/ops/events';
import { resetOtherNumberState } from '@/lib/whatsapp/other-number';

const PNID = '100000000000001';
const OTHER = '100000000000002';
const APP = { appSecret: 'rahasia-palsu', phoneNumberId: PNID };

let fake: FakeSupabase;

const change = (field: unknown, value: unknown) => ({ field, value });
const body = (...changes: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ changes }] });
const kinds = () => fake.rpcCalls.filter((c) => c.name === 'record_ops_event').map((c) => (c.args as { p_kind: string }).p_kind);
const route = async (b: unknown) => (await routeChanges(fake.client, APP, listChanges(b))).map((c) => c.route.route);

beforeEach(() => {
    resetOpsEventThrottle();
    resetOtherNumberState();
    h.logs = [];
    // The ops_events lookup finds the other number reported before.
    fake = makeFakeSupabase({ resolve: (c) => (c.table === 'ops_events' ? { data: [{ id: 1 }], error: null } : { data: null, error: null }) });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('routeChanges', () => {
    it('a user_id_update by its field, or by a user_id_update(s) key, whichever number reported it', async () => {
        expect(await route(body(
            change('user_id_update', { metadata: { phone_number_id: OTHER }, user_id_update: [] }),
            change('messages', { user_id_updates: [] }),
            change(undefined, { user_id_update: {} }),
        ))).toEqual(['user_id_update', 'user_id_update', 'user_id_update']);
        expect(kinds()).toEqual([]);
        expect(isUserIdUpdateChange({ entryIndex: 0, changeIndex: 0, field: 'messages', value: 'x' })).toBe(false);
    });

    it("the app's own number, or a change without a number id, is handled; the latter with a warning", async () => {
        expect(await route(body(
            change('messages', { metadata: { phone_number_id: PNID }, messages: [{}] }),
            change('messages', { metadata: { phone_number_id: Number(PNID) } }),
            change(undefined, { messages: [{}] }),
            change('messages', 'bukan objek'),
        ))).toEqual(['main', 'main', 'main', 'main']);
        expect(h.logs.filter((l) => String(l[0]).includes('without metadata.phone_number_id'))).toHaveLength(1);
        expect(kinds()).toEqual([]);
    });

    it('a field this webhook does not handle is acknowledged, not routed', async () => {
        expect(await route(body(change('message_template_status_update', { event: 'APPROVED' }), change('account_update', {})))).toEqual([
            'ignored_field',
            'ignored_field',
        ]);
        expect(fake.calls).toEqual([]);
        expect(kinds()).toEqual([]);
    });

    it("another number's change is dropped by default, with part 1's alert per change", async () => {
        expect(await route(body(
            change('messages', { metadata: { phone_number_id: OTHER }, messages: [{}] }),
            change('messages', { metadata: { phone_number_id: OTHER }, statuses: [{}] }),
        ))).toEqual(['dropped', 'dropped']);
        expect(kinds()).toEqual(['webhook_unrouted', 'webhook_unrouted']);
        expect(JSON.stringify(h.logs)).not.toContain(OTHER);
    });

    it('process mode: store_only, with the other number for the rows', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        const [routed] = await routeChanges(fake.client, APP, listChanges(body(change('messages', { metadata: { phone_number_id: OTHER, display_phone_number: '+62 812-0000-1234' } }))));
        expect(routed.route).toEqual({ route: 'store_only', other: { ref: expect.stringMatching(/^h[0-9a-f]{10}$/), last4: '1234' } });
    });

    it('an unknown WHATSAPP_OTHER_NUMBER_EVENTS value is alerted once per delivery, before the first unrouted alert', async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'proses');
        expect(await route(body(
            change('messages', { metadata: { phone_number_id: PNID } }),
            change('messages', { metadata: { phone_number_id: OTHER } }),
            change('messages', { metadata: { phone_number_id: OTHER } }),
        ))).toEqual(['main', 'store_only', 'store_only']);
        expect(kinds()).toEqual(['webhook_unconfigured', 'webhook_unrouted', 'webhook_unrouted']);
        // The main number alone: no alert about a mode nobody uses.
        fake.rpcCalls.length = 0;
        expect(await route(body(change('messages', { metadata: { phone_number_id: PNID } })))).toEqual(['main']);
        expect(kinds()).toEqual([]);
    });

    it('a number not reported in the last 7 days is alerted within the hour too', async () => {
        fake = makeFakeSupabase({ resolve: (c) => (c.table === 'ops_events' ? { data: [], error: null } : { data: null, error: null }) });
        expect(await route(body(change('messages', { metadata: { phone_number_id: OTHER } })))).toEqual(['dropped']);
        expect(kinds()).toEqual(['webhook_unrouted_new', 'webhook_unrouted']);
    });
});
