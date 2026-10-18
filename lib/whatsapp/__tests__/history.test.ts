import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase } from './fakeSupabase';

// logSystemMessage: a note in the chat thread. By default it is also the
// chat's latest activity (last_message / last_message_at); with touchChat:
// false only the note is added, so a chat whose customer message still needs
// a human reply keeps its "Belum dibalas" state. Fake ids only.

const h = vi.hoisted(() => ({ fake: null as unknown as FakeSupabase }));
vi.mock('@/lib/supabase/service', () => ({ createServiceOrServerClient: async () => h.fake.client }));
vi.mock('@/lib/utils/logger', () => ({ whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { logSystemMessage } from '@/lib/whatsapp/history';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';

beforeEach(() => {
    h.fake = makeFakeSupabase({});
});

describe('logSystemMessage', () => {
    it('by default makes the note the chat\'s latest activity and stores it in the thread', async () => {
        await logSystemMessage(ORG, PHONE, 'Catatan uji');
        expect(h.fake.calls.map((c) => [c.table, c.op])).toEqual([
            ['whatsapp_chats', 'upsert'],
            ['whatsapp_messages', 'insert'],
        ]);
        expect(h.fake.calls[0].payload).toMatchObject({ org_id: ORG, phone_number: PHONE, last_message: 'System: Catatan uji' });
        expect(h.fake.calls[1].payload).toEqual({ org_id: ORG, phone_number: PHONE, role: 'system', content: 'Catatan uji' });
    });

    it('with touchChat: false only adds the note, leaving the chat unanswered', async () => {
        await logSystemMessage(ORG, PHONE, 'Catatan uji', { touchChat: false });
        expect(h.fake.calls.map((c) => [c.table, c.op])).toEqual([['whatsapp_messages', 'insert']]);
    });
});
