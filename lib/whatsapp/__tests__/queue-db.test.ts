import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeCall, type Resolver } from './fakeSupabase';

// ---- Module mocks (the external boundaries of the queue pipeline) ----------
vi.mock('@/lib/ai/rag', () => ({ generateRAGResponse: vi.fn() }));
vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn() }));
vi.mock('@/lib/whatsapp/credentials', () => ({ getWhatsAppSendCreds: vi.fn() }));
vi.mock('@/lib/whatsapp/history', () => ({ logSystemMessage: vi.fn() }));
vi.mock('@/lib/utils/logger', () => ({
    whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// queue-db imports createClient from here at module load; never used when a
// client is injected, but mock it so next/headers isn't pulled into the test.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

import { processQueue, enqueueMessage, getDebounceSeconds } from '@/lib/whatsapp/queue-db';
import { generateRAGResponse } from '@/lib/ai/rag';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { getWhatsAppSendCreds } from '@/lib/whatsapp/credentials';
import { logSystemMessage } from '@/lib/whatsapp/history';

const ragMock = vi.mocked(generateRAGResponse);
const sendMock = vi.mocked(sendWhatsAppMessage);
const credsMock = vi.mocked(getWhatsAppSendCreds);
const logSystemMock = vi.mocked(logSystemMessage);

const ORG = 'org-1';
const PHONE = '628111';

interface JobOpts { retries?: number; max_retries?: number; }
function job(id: string, text: string, createdAt: string, o: JobOpts = {}) {
    return {
        id,
        org_id: ORG,
        phone_number: PHONE,
        message_text: text,
        status: 'processing' as const,
        retries: o.retries ?? 0,
        max_retries: o.max_retries ?? 3,
        created_at: createdAt,
    };
}

type HistRow = { role: 'user' | 'assistant' | 'system'; content: string };

interface Scenario {
    jobs: ReturnType<typeof job>[];
    aiEnabled?: boolean;
    history?: HistRow[];
    failMarkCompleted?: boolean;
    failHistoryWrite?: boolean;
}

// Build a fake client whose resolver answers each table/op the pipeline touches.
function clientFor(s: Scenario) {
    const resolve: Resolver = (call: FakeCall) => {
        const { table, op, payload, single } = call;
        const p = (payload ?? {}) as Record<string, unknown>;

        if (table === 'whatsapp_chats' && op === 'select' && single === 'maybe') {
            return { data: { ai_enabled: s.aiEnabled ?? true } };
        }
        if (table === 'whatsapp_messages' && op === 'select') {
            // The query requests order('created_at', { ascending: false }), so a
            // faithful fake returns rows newest-first. Test data is authored
            // chronologically (readable), so reverse it here.
            return { data: [...(s.history ?? [])].reverse() };
        }
        if (table === 'message_queue' && op === 'update' && p.status === 'completed') {
            if (s.failMarkCompleted) throw new Error('DB down: mark completed failed');
            return { data: [{ id: 'x' }] };
        }
        if (table === 'whatsapp_messages' && op === 'insert') {
            // assistant reply history write
            if (s.failHistoryWrite) throw new Error('DB down: history insert failed');
            return { data: null, error: null };
        }
        // chat upsert, queue update (pending/failed), anything else
        return { data: null, error: null };
    };
    return makeFakeSupabase({ resolve, rpc: () => ({ data: s.jobs, error: null }) });
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WHATSAPP_DEBOUNCE_SECONDS;
    credsMock.mockResolvedValue({ phoneNumberId: 'pn', accessToken: 'tok' });
    ragMock.mockResolvedValue({ message: 'AI reply', sources: [] });
    sendMock.mockResolvedValue({ waMessageId: 'wamid.out', raw: {} });
});

// Helper: count message_queue update calls whose payload.status === target.
function queueUpdates(calls: FakeCall[], status: string) {
    return calls.filter(
        (c) => c.table === 'message_queue' && c.op === 'update' && (c.payload as Record<string, unknown>)?.status === status
    );
}

describe('getDebounceSeconds', () => {
    it('defaults to 60 when unset or non-numeric', () => {
        delete process.env.WHATSAPP_DEBOUNCE_SECONDS;
        expect(getDebounceSeconds()).toBe(60);
        process.env.WHATSAPP_DEBOUNCE_SECONDS = 'abc';
        expect(getDebounceSeconds()).toBe(60);
    });
    it('reads a valid value and clamps to [0, 300]', () => {
        process.env.WHATSAPP_DEBOUNCE_SECONDS = '20';
        expect(getDebounceSeconds()).toBe(20);
        process.env.WHATSAPP_DEBOUNCE_SECONDS = '-5';
        expect(getDebounceSeconds()).toBe(0);
        process.env.WHATSAPP_DEBOUNCE_SECONDS = '99999';
        expect(getDebounceSeconds()).toBe(300);
    });
});

describe('enqueueMessage (V2 idempotency)', () => {
    it('inserts with wa_message_id and returns the new id', async () => {
        const fake = makeFakeSupabase({
            resolve: () => ({ data: { id: 'job-1' }, error: null }),
        });
        const id = await enqueueMessage(ORG, PHONE, 'halo', fake.client, 'wamid.in.1');
        expect(id).toBe('job-1');
        const insert = fake.calls.find((c) => c.table === 'message_queue' && c.op === 'insert');
        expect(insert).toBeTruthy();
        expect((insert!.payload as Record<string, unknown>).wa_message_id).toBe('wamid.in.1');
    });

    it('returns null on a duplicate webhook (23505) instead of throwing', async () => {
        const fake = makeFakeSupabase({
            resolve: () => ({ error: { code: '23505', message: 'duplicate key' } }),
        });
        const id = await enqueueMessage(ORG, PHONE, 'halo', fake.client, 'wamid.in.dup');
        expect(id).toBeNull();
    });

    it('rethrows on a non-duplicate error', async () => {
        const fake = makeFakeSupabase({
            resolve: () => ({ error: { code: '23502', message: 'not null violation' } }),
        });
        await expect(enqueueMessage(ORG, PHONE, 'halo', fake.client, 'wamid.in.2')).rejects.toBeTruthy();
    });
});

describe('processQueue — V1 burst coalescing', () => {
    it('answers a 3-message burst with ONE reply over the combined text', async () => {
        const fake = clientFor({
            jobs: [
                job('j1', 'Rencananya buat team building', '2026-06-20T10:00:00.000Z'),
                job('j2', 'Sekitar 30 pax', '2026-06-20T10:00:03.000Z'),
                job('j3', 'di Dufan atau Bogor', '2026-06-20T10:00:06.000Z'),
            ],
        });
        await processQueue(fake.client);

        // ONE AI turn, ONE outbound message.
        expect(ragMock).toHaveBeenCalledTimes(1);
        expect(sendMock).toHaveBeenCalledTimes(1);
        // Combined, in chronological order.
        expect(ragMock.mock.calls[0][0]).toBe(
            'Rencananya buat team building\nSekitar 30 pax\ndi Dufan atau Bogor'
        );
        // All three jobs marked completed in one update.
        const completed = queueUpdates(fake.calls, 'completed');
        expect(completed).toHaveLength(1);
        expect(completed[0].filters).toContainEqual(['in', 'id', ['j1', 'j2', 'j3']]);
    });

    it('keeps two different conversations separate (one reply each)', async () => {
        const jobs = [
            { ...job('a1', 'hai', '2026-06-20T10:00:00.000Z'), phone_number: '628AAA' },
            { ...job('b1', 'halo', '2026-06-20T10:00:01.000Z'), phone_number: '628BBB' },
        ];
        const fake = makeFakeSupabase({
            resolve: (c) => {
                if (c.table === 'whatsapp_chats' && c.op === 'select') return { data: { ai_enabled: true } };
                if (c.table === 'whatsapp_messages' && c.op === 'select') return { data: [] };
                return { data: null, error: null };
            },
            rpc: () => ({ data: jobs, error: null }),
        });
        await processQueue(fake.client);
        expect(sendMock).toHaveBeenCalledTimes(2);
        const recipients = sendMock.mock.calls.map((c) => c[0]).sort();
        expect(recipients).toEqual(['628AAA', '628BBB']);
    });

    it('passes the configured debounce window to claim_queue_jobs', async () => {
        process.env.WHATSAPP_DEBOUNCE_SECONDS = '30';
        const fake = clientFor({ jobs: [] });
        await processQueue(fake.client);
        expect(fake.rpcCalls[0].name).toBe('claim_queue_jobs');
        expect((fake.rpcCalls[0].args as Record<string, number>).p_debounce_seconds).toBe(30);
        // stale window stays well above worst-case job latency
        expect((fake.rpcCalls[0].args as Record<string, number>).p_stale_seconds).toBe(600);
    });

    it('does nothing when no conversation has settled', async () => {
        const fake = clientFor({ jobs: [] });
        await processQueue(fake.client);
        expect(sendMock).not.toHaveBeenCalled();
        expect(ragMock).not.toHaveBeenCalled();
    });
});

describe('processQueue — history trim (do not double-feed the burst; drop system rows)', () => {
    it('removes the trailing unanswered user run so the burst is not fed twice', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z'), job('j2', 'm2', '2026-06-20T10:00:02.000Z')],
            history: [
                { role: 'user', content: 'pertanyaan lama' },
                { role: 'assistant', content: 'jawaban lama' },
                { role: 'user', content: 'm1' },
                { role: 'user', content: 'm2' },
            ],
        });
        await processQueue(fake.client);
        const [message, history] = ragMock.mock.calls[0];
        expect(message).toBe('m1\nm2');
        expect(history).toEqual([
            { role: 'user', content: 'pertanyaan lama' },
            { role: 'assistant', content: 'jawaban lama' },
        ]);
    });

    it('a trailing system row (e.g. rate-limit warning) does not block the trim', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z'), job('j2', 'm2', '2026-06-20T10:00:02.000Z')],
            history: [
                { role: 'assistant', content: 'jawaban lama' },
                { role: 'user', content: 'm1' },
                { role: 'user', content: 'm2' },
                { role: 'system', content: 'Rate limit exceeded. User warned.' },
            ],
        });
        await processQueue(fake.client);
        const [, history] = ragMock.mock.calls[0];
        // burst stripped AND no system row leaks in
        expect(history).toEqual([{ role: 'assistant', content: 'jawaban lama' }]);
    });

    it('never forwards system/audit rows into the model context', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z')],
            history: [
                { role: 'user', content: 'a' },
                { role: 'system', content: 'Customer shared contact info' },
                { role: 'assistant', content: 'b' },
                { role: 'user', content: 'm1' },
            ],
        });
        await processQueue(fake.client);
        const [, history] = ragMock.mock.calls[0] as [string, HistRow[]];
        expect(history.some((m) => m.role === 'system')).toBe(false);
        expect(history).toEqual([
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ]);
    });
});

describe('processQueue — V3 resend safety', () => {
    it('does NOT resend when the history write fails after a successful send', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z')],
            failHistoryWrite: true,
        });
        await processQueue(fake.client);
        expect(sendMock).toHaveBeenCalledTimes(1);
        // jobs were marked completed before the history write — not re-queued
        expect(queueUpdates(fake.calls, 'completed')).toHaveLength(1);
        expect(queueUpdates(fake.calls, 'pending')).toHaveLength(0);
        expect(queueUpdates(fake.calls, 'failed')).toHaveLength(0);
    });

    it('does NOT resend or re-queue when mark-completed fails right after a successful send', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z')],
            failMarkCompleted: true,
        });
        await processQueue(fake.client);
        // exactly one send; the post-send DB hiccup must not route into retry/resend
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(queueUpdates(fake.calls, 'pending')).toHaveLength(0);
        expect(queueUpdates(fake.calls, 'failed')).toHaveLength(0);
    });
});

describe('processQueue — retry & exhaustion on send failure', () => {
    it('re-queues (pending) without a fallback when retries remain', async () => {
        sendMock.mockRejectedValueOnce(new Error('Meta 500'));
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z', { retries: 0, max_retries: 3 })],
        });
        await processQueue(fake.client);
        expect(queueUpdates(fake.calls, 'pending')).toHaveLength(1);
        expect(queueUpdates(fake.calls, 'completed')).toHaveLength(0);
        // the only send was the failed attempt — no fallback yet
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('marks failed and sends ONE fallback when retries are exhausted', async () => {
        sendMock.mockRejectedValueOnce(new Error('Meta 500')); // the real attempt
        sendMock.mockResolvedValueOnce({ waMessageId: null, raw: {} }); // the fallback
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z', { retries: 2, max_retries: 3 })],
        });
        await processQueue(fake.client);
        expect(queueUpdates(fake.calls, 'failed')).toHaveLength(1);
        expect(logSystemMock).toHaveBeenCalledTimes(1);
        // failed attempt + one fallback message
        expect(sendMock).toHaveBeenCalledTimes(2);
        expect(sendMock.mock.calls[1][1]).toMatch(/Maaf, terjadi kesalahan/);
    });
});

describe('processQueue — admin takeover', () => {
    it('sends nothing and completes the jobs when ai_enabled is false', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z')],
            aiEnabled: false,
        });
        await processQueue(fake.client);
        expect(ragMock).not.toHaveBeenCalled();
        expect(sendMock).not.toHaveBeenCalled();
        expect(queueUpdates(fake.calls, 'completed')).toHaveLength(1);
    });
});
