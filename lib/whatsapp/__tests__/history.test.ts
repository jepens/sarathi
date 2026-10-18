import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase } from './fakeSupabase';

// logSystemMessage: a note in the chat thread. By default it is also the
// chat's latest activity (last_message / last_message_at); with touchChat:
// false the chat row is only created when missing (the note's foreign key),
// so a chat whose customer message still needs a human reply keeps its
// "Belum dibalas" state. Write errors are logged. Fake ids only.

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
        await logSystemMessage(ORG, PHONE, 'Catatan uji');
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

    it('logs a note the database refused', async () => {
        h.fake = makeFakeSupabase({
            resolve: (c) => (c.table === 'whatsapp_messages' ? { data: null, error: { code: '23503' } } : { data: null, error: null }),
        });
        await logSystemMessage(ORG, PHONE, 'Catatan uji', { touchChat: false });
        expect(h.error).toHaveBeenCalledWith('System message could not be stored', { code: '23503' });
    });
});
