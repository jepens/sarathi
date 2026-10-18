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
vi.mock('@/lib/quota/org-quota', () => ({ consumeOrgQuota: vi.fn() }));

import {
    processQueue,
    enqueueMessage,
    getDebounceSeconds,
    HANDOFF_MANUAL_MODE_NOTICE,
    aiQuotaReachedNotice,
    inboundQueueState,
} from '@/lib/whatsapp/queue-db';
import { generateRAGResponse } from '@/lib/ai/rag';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { getWhatsAppSendCreds } from '@/lib/whatsapp/credentials';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { consumeOrgQuota } from '@/lib/quota/org-quota';
import { whatsappLogger } from '@/lib/utils/logger';

const ragMock = vi.mocked(generateRAGResponse);
const sendMock = vi.mocked(sendWhatsAppMessage);
const credsMock = vi.mocked(getWhatsAppSendCreds);
const logSystemMock = vi.mocked(logSystemMessage);
const quotaMock = vi.mocked(consumeOrgQuota);

const ORG = 'org-1';
const PHONE = '628111';

interface JobOpts { retries?: number; max_retries?: number; wamid?: string; counted?: boolean; }
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
        ...(o.wamid ? { wa_message_id: o.wamid } : {}),
        ...(o.counted ? { ai_quota_counted: true } : {}),
    };
}

type HistRow = { role: 'user' | 'assistant' | 'system'; content: string; wa_message_id?: string };

interface Scenario {
    jobs: ReturnType<typeof job>[];
    aiEnabled?: boolean;
    history?: HistRow[];
    failMarkCompleted?: boolean;
    /** The completion update answers with an error (supabase-js does not throw). */
    markCompletedError?: boolean;
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
            if (s.markCompletedError) return { data: null, error: { message: 'statement timeout', code: '57014' } };
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
    quotaMock.mockResolvedValue({ allowed: true, used: 1, refused: 0, limit: 300, firstRefusal: false });
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

describe('inboundQueueState (what the org inbound quota does not count, tracker 3.4)', () => {
    const W = 'wamid.in.q1';
    function fakeQueue(rows: { queued?: boolean; stored?: boolean; pending?: boolean; fail?: boolean }) {
        return makeFakeSupabase({
            resolve: (c) => {
                if (rows.fail) return { data: null, error: { code: '57014' } };
                const byWamid = c.filters.some(([op, col]) => op === 'eq' && col === 'wa_message_id');
                const byPending = c.filters.some(([op, col, v]) => op === 'eq' && col === 'status' && v === 'pending');
                if (byWamid && c.table === 'message_queue') return { data: rows.queued ? [{ id: 'j1' }] : [], error: null };
                if (byWamid && c.table === 'whatsapp_messages') return { data: rows.stored ? [{ id: 'm1' }] : [], error: null };
                if (byPending) return { data: rows.pending ? [{ id: 'j2' }] : [], error: null };
                return { data: [], error: null };
            },
        });
    }

    it('spots a redelivery (queued, or only stored: refused or manual mode) and a burst still waiting, all scoped to the org', async () => {
        const f = fakeQueue({ queued: true, pending: true });
        expect(await inboundQueueState(f.client, ORG, PHONE, W)).toEqual({ duplicate: true, joinsBurst: true });
        for (const c of f.calls) expect(c.filters).toContainEqual(['eq', 'org_id', ORG]);
        expect(f.calls.find((c) => c.filters.some(([, col]) => col === 'status'))!.filters).toContainEqual(['eq', 'phone_number', PHONE]);
        const storedOnly = fakeQueue({ stored: true });
        expect(await inboundQueueState(storedOnly.client, ORG, PHONE, W)).toEqual({ duplicate: true, joinsBurst: false });
        expect(storedOnly.calls.find((c) => c.table === 'whatsapp_messages')!.filters).toContainEqual(['eq', 'role', 'user']);
        expect(await inboundQueueState(fakeQueue({}).client, ORG, PHONE, W)).toEqual({ duplicate: false, joinsBurst: false });
    });

    it('without a wamid only the waiting burst is checked; a read error counts the message', async () => {
        const f = fakeQueue({ pending: true });
        expect(await inboundQueueState(f.client, ORG, PHONE, null)).toEqual({ duplicate: false, joinsBurst: true });
        expect(f.calls).toHaveLength(1);
        expect(await inboundQueueState(fakeQueue({ fail: true }).client, ORG, PHONE, W)).toEqual({ duplicate: false, joinsBurst: false });
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

    it('logs a completion the database refused after a successful send, and still does not resend', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z')],
            markCompletedError: true,
        });
        await processQueue(fake.client);
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(vi.mocked(whatsappLogger.error)).toHaveBeenCalledWith(
            expect.stringContaining('Failed to mark jobs completed after sending'),
            expect.objectContaining({ code: '57014' }),
        );
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

    it('a burst kept alive by new messages fails once its oldest job is out of retries', async () => {
        sendMock.mockRejectedValueOnce(new Error('Meta 500')); // the real attempt
        sendMock.mockResolvedValueOnce({ waMessageId: null, raw: {} }); // the fallback
        const fake = clientFor({
            jobs: [
                job('j1', 'm1', '2026-06-20T10:00:00.000Z', { retries: 2, max_retries: 3, counted: true }),
                job('j2', 'm2', '2026-06-20T10:05:00.000Z'), // joined after the failures
            ],
        });
        await processQueue(fake.client);
        expect(queueUpdates(fake.calls, 'failed')).toHaveLength(1);
        expect(queueUpdates(fake.calls, 'pending')).toHaveLength(0);
        expect(sendMock).toHaveBeenCalledTimes(2);
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

describe('processQueue — daily AI quota of the org (tracker 3.4)', () => {
    it('counts one AI reply per conversation, not per message', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z'), job('j2', 'm2', '2026-06-20T10:00:02.000Z')],
        });
        await processQueue(fake.client);
        expect(quotaMock).toHaveBeenCalledTimes(1);
        expect(quotaMock).toHaveBeenCalledWith(fake.client, ORG, 'ai_reply_day');
        expect(sendMock).toHaveBeenCalledTimes(1);
        const completed = queueUpdates(fake.calls, 'completed');
        expect((completed[0].payload as Record<string, unknown>).error_message).toBeUndefined();
    });

    it('over the quota: no AI call and no send, the jobs are closed with the reason and the operators get a note', async () => {
        quotaMock.mockResolvedValueOnce({ allowed: false, used: 300, refused: 1, limit: 300, firstRefusal: true });
        const fake = clientFor({ jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z')] });
        await processQueue(fake.client);
        expect(ragMock).not.toHaveBeenCalled();
        expect(sendMock).not.toHaveBeenCalled();
        const completed = queueUpdates(fake.calls, 'completed');
        expect(completed).toHaveLength(1);
        expect(completed[0].filters).toContainEqual(['in', 'id', ['j1']]);
        expect((completed[0].payload as Record<string, unknown>).error_message).toBe('quota: ai_reply_day');
        expect(logSystemMock).toHaveBeenCalledWith(ORG, PHONE, aiQuotaReachedNotice(300));
        // a stop, not a failure: nothing is retried and no fallback is sent
        expect(queueUpdates(fake.calls, 'pending')).toHaveLength(0);
        expect(queueUpdates(fake.calls, 'failed')).toHaveLength(0);
        // the refused jobs stay uncounted: should the close fail, a reclaim
        // checks the quota again instead of answering them unchecked
        expect(
            fake.calls.some(
                (c) => c.table === 'message_queue' && c.op === 'update' && 'ai_quota_counted' in ((c.payload as Record<string, unknown>) ?? {}),
            ),
        ).toBe(false);
    });

    it('a chat in manual mode is not counted', async () => {
        const fake = clientFor({ jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z')], aiEnabled: false });
        await processQueue(fake.client);
        expect(quotaMock).not.toHaveBeenCalled();
    });

    it('marks the counted jobs, so a retry does not count them again', async () => {
        const fake = clientFor({ jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z'), job('j2', 'm2', '2026-06-20T10:00:02.000Z')] });
        await processQueue(fake.client);
        const marked = fake.calls.filter(
            (c) => c.table === 'message_queue' && c.op === 'update' && (c.payload as Record<string, unknown>).ai_quota_counted === true,
        );
        expect(marked).toHaveLength(1);
        expect(marked[0].filters).toContainEqual(['in', 'id', ['j1', 'j2']]);
    });

    it('a plain retry of a counted burst is not counted again (an outage must not use up the day)', async () => {
        const fake = clientFor({ jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z', { retries: 1, counted: true })] });
        await processQueue(fake.client);
        expect(quotaMock).not.toHaveBeenCalled();
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('a message that joined a failing burst is counted, and only it is marked', async () => {
        const fake = clientFor({
            jobs: [
                job('j1', 'm1', '2026-06-20T10:00:00.000Z', { retries: 1, counted: true }),
                job('j2', 'm2', '2026-06-20T10:00:02.000Z'),
            ],
        });
        await processQueue(fake.client);
        expect(quotaMock).toHaveBeenCalledTimes(1);
        const marked = fake.calls.find(
            (c) => c.table === 'message_queue' && c.op === 'update' && (c.payload as Record<string, unknown>).ai_quota_counted === true,
        );
        expect(marked!.filters).toContainEqual(['in', 'id', ['j2']]);
    });

    it('a burst a crashed worker claimed but never counted is counted when it is reclaimed', async () => {
        const fake = clientFor({ jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z', { retries: 1 })] });
        await processQueue(fake.client);
        expect(quotaMock).toHaveBeenCalledTimes(1);
    });
});

describe('processQueue — history around the burst (tracker 3.4)', () => {
    it("drops exactly the burst's own messages, so an earlier unanswered one (refused by the minute quota) stays as context", async () => {
        const fake = clientFor({
            jobs: [job('j1', 'jadi berapa harganya?', '2026-06-20T10:01:00.000Z', { wamid: 'wamid.b1' })],
            history: [
                { role: 'assistant', content: 'jawaban lama', wa_message_id: 'wamid.o1' },
                { role: 'user', content: 'saya mau paket B', wa_message_id: 'wamid.r1' }, // refused, never queued
                { role: 'system', content: 'Pesan pelanggan di atas tidak dibalas AI', wa_message_id: undefined },
                { role: 'user', content: 'jadi berapa harganya?', wa_message_id: 'wamid.b1' },
            ],
        });
        await processQueue(fake.client);
        const [message, history] = ragMock.mock.calls[0];
        expect(message).toBe('jadi berapa harganya?');
        expect(history).toEqual([
            { role: 'assistant', content: 'jawaban lama' },
            { role: 'user', content: 'saya mau paket B' },
        ]);
    });

    it('cuts off rows newer than the burst (a later turn), so they are not answered twice', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'pertanyaan pertama', '2026-06-20T10:00:00.000Z', { wamid: 'wamid.b1' })],
            history: [
                { role: 'assistant', content: 'jawaban lama', wa_message_id: 'wamid.o1' },
                { role: 'user', content: 'pertanyaan pertama', wa_message_id: 'wamid.b1' },
                { role: 'user', content: 'pesan berikutnya, burst lain', wa_message_id: 'wamid.n2' },
            ],
        });
        await processQueue(fake.client);
        const [, history] = ragMock.mock.calls[0];
        expect(history).toEqual([{ role: 'assistant', content: 'jawaban lama' }]);
    });

    it('keeps a reply stored after the burst (an operator answering from the dashboard meanwhile), but not a later customer message', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'berapa harga paket B?', '2026-06-20T10:00:00.000Z', { wamid: 'wamid.b1' })],
            history: [
                { role: 'assistant', content: 'jawaban lama', wa_message_id: 'wamid.o1' },
                { role: 'user', content: 'berapa harga paket B?', wa_message_id: 'wamid.b1' },
                { role: 'assistant', content: 'Paket B Rp5 juta (dari operator)', wa_message_id: 'wamid.op' },
                { role: 'user', content: 'pesan berikutnya, burst lain', wa_message_id: 'wamid.n2' },
            ],
        });
        await processQueue(fake.client);
        const [message, history] = ragMock.mock.calls[0];
        expect(message).toBe('berapa harga paket B?');
        expect(history).toEqual([
            { role: 'assistant', content: 'jawaban lama' },
            { role: 'assistant', content: 'Paket B Rp5 juta (dari operator)' },
        ]);
    });

    it('skips a photo without a caption instead of sending an empty turn', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'ini fotonya, berapa harganya?', '2026-06-20T10:00:00.000Z', { wamid: 'wamid.b1' })],
            history: [
                { role: 'assistant', content: 'jawaban lama', wa_message_id: 'wamid.o1' },
                { role: 'user', content: '', wa_message_id: 'wamid.foto' },
                { role: 'user', content: 'ini fotonya, berapa harganya?', wa_message_id: 'wamid.b1' },
            ],
        });
        await processQueue(fake.client);
        const [, history] = ragMock.mock.calls[0];
        expect(history).toEqual([{ role: 'assistant', content: 'jawaban lama' }]);
    });

    it('a job without a wamid falls back to dropping the trailing run of unanswered user messages', async () => {
        const fake = clientFor({
            jobs: [job('j1', 'm1', '2026-06-20T10:00:00.000Z', { wamid: 'wamid.b1' }), job('j2', 'm2', '2026-06-20T10:00:02.000Z')],
            history: [
                { role: 'assistant', content: 'jawaban lama' },
                { role: 'user', content: 'sebelumnya' },
                { role: 'user', content: 'm1', wa_message_id: 'wamid.b1' },
                { role: 'user', content: 'm2' },
            ],
        });
        await processQueue(fake.client);
        const [, history] = ragMock.mock.calls[0];
        expect(history).toEqual([{ role: 'assistant', content: 'jawaban lama' }]);
    });
});

describe('processQueue — handoff switches the AI off only after the reply is sent', () => {
    const aiOffUpdates = (calls: FakeCall[]) =>
        calls.filter(
            (c) => c.table === 'whatsapp_chats' && c.op === 'update' && (c.payload as Record<string, unknown>)?.ai_enabled === false
        );

    it('sends the handoff reply, then sets ai_enabled=false (org-scoped) and logs a manual-mode note', async () => {
        ragMock.mockResolvedValueOnce({ message: 'Tim kami akan menghubungi kakak', sources: [], disableAi: true });
        const fake = clientFor({ jobs: [job('j1', 'mau bicara dengan orang', '2026-06-20T10:00:00.000Z')] });
        await processQueue(fake.client);

        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(sendMock.mock.calls[0][1]).toBe('Tim kami akan menghubungi kakak');
        const off = aiOffUpdates(fake.calls);
        expect(off).toHaveLength(1);
        expect(off[0].filters).toContainEqual(['eq', 'org_id', ORG]);
        expect(off[0].filters).toContainEqual(['eq', 'phone_number', PHONE]);
        expect(logSystemMock).toHaveBeenCalledWith(ORG, PHONE, HANDOFF_MANUAL_MODE_NOTICE);
        // switched off AFTER the jobs were completed (i.e. after the send)
        const completedIdx = fake.calls.findIndex(
            (c) => c.table === 'message_queue' && (c.payload as Record<string, unknown>)?.status === 'completed'
        );
        expect(fake.calls.indexOf(off[0])).toBeGreaterThan(completedIdx);
    });

    it('a normal reply never touches ai_enabled', async () => {
        const fake = clientFor({ jobs: [job('j1', 'halo', '2026-06-20T10:00:00.000Z')] });
        await processQueue(fake.client);
        expect(aiOffUpdates(fake.calls)).toHaveLength(0);
        expect(logSystemMock).not.toHaveBeenCalled();
    });

    it('handoff turn whose second AI call fails is retried and still answered', async () => {
        // Attempt 1: the handoff tool ran, then the second OpenAI call threw —
        // generateRAGResponse rejects. Nothing switched the AI off.
        ragMock.mockRejectedValueOnce(new Error('OpenAI 500 on the second call'));
        const first = clientFor({ jobs: [job('j1', 'saya kesal, mau bicara dengan orang', '2026-06-20T10:00:00.000Z')] });
        await processQueue(first.client);
        expect(sendMock).not.toHaveBeenCalled();
        expect(queueUpdates(first.calls, 'pending')).toHaveLength(1);
        expect(aiOffUpdates(first.calls)).toHaveLength(0);

        // Attempt 2 (re-claimed with retries=1): ai_enabled is still true, so
        // the turn is regenerated and the customer DOES get the handoff reply.
        ragMock.mockResolvedValueOnce({ message: 'Baik kak, tim kami segera menghubungi', sources: [], disableAi: true });
        const retry = clientFor({
            jobs: [job('j1', 'saya kesal, mau bicara dengan orang', '2026-06-20T10:00:00.000Z', { retries: 1 })],
            aiEnabled: true,
        });
        await processQueue(retry.client);
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(sendMock.mock.calls[0][1]).toBe('Baik kak, tim kami segera menghubungi');
        expect(queueUpdates(retry.calls, 'completed')).toHaveLength(1);
        expect(aiOffUpdates(retry.calls)).toHaveLength(1);
    });

    it('a failed send of the handoff reply re-queues without switching the AI off', async () => {
        ragMock.mockResolvedValueOnce({ message: 'Tim kami akan menghubungi kakak', sources: [], disableAi: true });
        sendMock.mockRejectedValueOnce(new Error('Meta 500'));
        const fake = clientFor({ jobs: [job('j1', 'mau bicara dengan orang', '2026-06-20T10:00:00.000Z')] });
        await processQueue(fake.client);
        expect(queueUpdates(fake.calls, 'pending')).toHaveLength(1);
        expect(aiOffUpdates(fake.calls)).toHaveLength(0);
        expect(logSystemMock).not.toHaveBeenCalled();
    });
});
