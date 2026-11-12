import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase } from './fakeSupabase';

// logSystemMessage: a note in the chat thread. By default it is also the
// chat's latest activity (last_message / last_message_at); with touchChat:
// false the chat row is only created when missing (the note's foreign key),
// so a chat whose customer message still needs a human reply keeps its
// "Belum dibalas" state. Keyed by waMessageId, a second note for the same
// inbound message is a 23505, reported as 'duplicate' (the webhook's contact
// card note, D23-3). Write errors are logged and reported. Fake ids only.

const h = vi.hoisted(() => ({ fake: null as unknown as FakeSupabase, error: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceOrServerClient: async () => h.fake.client }));
vi.mock('@/lib/utils/logger', () => ({ whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: h.error } }));

import { logSystemMessage } from '@/lib/whatsapp/history';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';

beforeEach(() => {
    h.error.mockReset();
    h.fake = makeFakeSupabase({});
});

describe('logSystemMessage', () => {
    it("by default makes the note the chat's latest activity and stores it in the thread", async () => {
        expect(await logSystemMessage(ORG, PHONE, 'Catatan uji')).toEqual({ status: 'stored' });
        expect(h.fake.calls.map((c) => [c.table, c.op])).toEqual([
            ['whatsapp_chats', 'upsert'],
            ['whatsapp_messages', 'insert'],
        ]);
        expect(h.fake.calls[0].payload).toMatchObject({ org_id: ORG, phone_number: PHONE, last_message: 'System: Catatan uji' });
        expect(h.fake.calls[1].payload).toEqual({ org_id: ORG, phone_number: PHONE, role: 'system', content: 'Catatan uji' });
    });

    it('with touchChat: false only makes sure the chat row exists, leaving its activity (the chat stays unanswered)', async () => {
        await logSystemMessage(ORG, PHONE, 'Catatan uji', { touchChat: false });
        expect(h.fake.calls.map((c) => [c.table, c.op])).toEqual([
            ['whatsapp_chats', 'upsert'],
            ['whatsapp_messages', 'insert'],
        ]);
        expect(h.fake.calls[0].payload).toEqual({ org_id: ORG, phone_number: PHONE });
        expect(h.fake.calls[0].upsertOpts).toEqual({ onConflict: 'org_id,phone_number', ignoreDuplicates: true });
    });

    it('logs a chat row the database refused, and still tries the note', async () => {
        h.fake = makeFakeSupabase({
            resolve: (c) => (c.table === 'whatsapp_chats' ? { data: null, error: { code: '57014' } } : { data: null, error: null }),
        });
        await logSystemMessage(ORG, PHONE, 'Catatan uji');
        expect(h.error).toHaveBeenCalledWith('System message: the chat row could not be written', { code: '57014' });
        expect(h.fake.calls.map((c) => c.table)).toEqual(['whatsapp_chats', 'whatsapp_messages']);
    });

    it('logs a note the database refused, and reports it as failed with the error and the HTTP status', async () => {
        h.fake = makeFakeSupabase({
            resolve: (c) => (c.table === 'whatsapp_messages' ? { data: null, error: { code: '23503' }, status: 409 } : { data: null, error: null }),
        });
        expect(await logSystemMessage(ORG, PHONE, 'Catatan uji', { touchChat: false })).toStrictEqual({
            status: 'failed',
            error: { code: '23503' },
            httpStatus: 409,
        });
        expect(h.error).toHaveBeenCalledWith('System message could not be stored', { code: '23503' });
    });

    it('keys the note to an inbound message when given, and only then', async () => {
        await logSystemMessage(ORG, PHONE, 'Catatan uji', { touchChat: false, waMessageId: 'wamid.fake-card-1' });
        expect(h.fake.calls[1].payload).toEqual({
            org_id: ORG,
            phone_number: PHONE,
            role: 'system',
            content: 'Catatan uji',
            wa_message_id: 'wamid.fake-card-1',
        });
        h.fake = makeFakeSupabase({});
        await logSystemMessage(ORG, PHONE, 'Catatan uji', { touchChat: false });
        expect(h.fake.calls[1].payload).not.toHaveProperty('wa_message_id');
    });

    it("a second note for the same inbound message (23505) is a 'duplicate', not an error", async () => {
        h.fake = makeFakeSupabase({
            resolve: (c) => (c.table === 'whatsapp_messages' ? { data: null, error: { code: '23505' } } : { data: null, error: null }),
        });
        expect(await logSystemMessage(ORG, PHONE, 'Catatan uji', { touchChat: false, waMessageId: 'wamid.fake-card-1' })).toEqual({
            status: 'duplicate',
        });
        expect(h.error).not.toHaveBeenCalled();
    });

    it('never throws: a client that cannot be created is a failed note', async () => {
        h.fake = { client: null, calls: [], rpcCalls: [] } as unknown as FakeSupabase;
        const result = await logSystemMessage(ORG, PHONE, 'Catatan uji');
        expect(result.status).toBe('failed');
        // No HTTP status: the caller keeps a throw as it is (no database answer).
        expect(result).not.toHaveProperty('httpStatus');
        expect(h.error).toHaveBeenCalledWith('Failed to log system message', expect.anything());
    });
});
