import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// The webhook end to end against a REAL local Supabase stack (Fase 2 task
// 2.2a part 2, PR-C2): the route's POST, the pipeline, the handlers, the
// effects after the commit and processQueue run unchanged, and every database
// call goes through PostgREST to wa_ingest_inbound, wa_apply_statuses,
// claim_queue_jobs, consume_org_quota and the tables, as in production. Only
// Meta (send, media download), Web Push and the AI generation are replaced.
//
// Opt-in: skipped unless LOCAL_SUPABASE_URL and LOCAL_SUPABASE_SERVICE_KEY are
// set (CI runs vitest without a database). The scenarios that change the
// database for a few seconds (a failing or slow trigger on message_queue,
// wa_ingest_inbound renamed or without its grant, platform_settings
// unreadable) also need LOCAL_SUPABASE_DB_CONTAINER, the stack's Postgres
// container, for psql; without it they are skipped. Local stacks only: the
// run refuses a URL that is not local, a container of another stack and a
// queue holding another org's pending jobs; it creates and deletes its own
// org and makes it the default org (platform_settings) until it ends. How to
// run it, and what an interrupted run leaves behind: supabase/README.md. Fake
// phones, wamids and texts only.

const API_URL = process.env.LOCAL_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.LOCAL_SUPABASE_SERVICE_KEY ?? '';
const DB_CONTAINER = process.env.LOCAL_SUPABASE_DB_CONTAINER ?? '';
/** LOCAL_DB_KEEP=1 keeps the run's org and rows for a look afterwards. */
const KEEP_ROWS = process.env.LOCAL_DB_KEEP === '1';
const ENABLED = API_URL !== '' && SERVICE_KEY !== '';

const h = vi.hoisted(() => ({ outSeq: 0, outbound: [] as string[] }));

vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn(), downloadWhatsAppMedia: vi.fn() }));
vi.mock('@/lib/notifications/web-push', () => ({ sendPushToOrg: vi.fn() }));
vi.mock('@/lib/ai/rag', () => ({ generateRAGResponse: vi.fn() }));

import { POST } from '@/app/api/webhook/whatsapp/route';
import { processQueue } from '@/lib/whatsapp/queue-db';
import { downloadWhatsAppMedia, sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { sendPushToOrg } from '@/lib/notifications/web-push';
import { generateRAGResponse } from '@/lib/ai/rag';
import { settleBackground } from '@/lib/whatsapp/webhook/background';
import { INGEST_PARAMS } from '@/lib/whatsapp/webhook/ingest';
import { inboundQuotaNotice } from '@/lib/quota/org-quota';
import { otherNumberLimitNotice, otherNumberNotice, otherNumberOf } from '@/lib/whatsapp/other-number';
import { SEED_ORG_ID } from '@/lib/settings/platform-settings';
import { whatsappLogger } from '@/lib/utils/logger';

const SECRET = 'e2e-rahasia-aplikasi-palsu';
const PNID = '100000000000901';
const TOKEN = 'token-palsu-e2e';
const AI_REPLY = 'Balasan AI palsu (e2e)';
const ORG_PREFIX = 'e2e local-db webhook';
// Another number of the WABA, new on every run: its first event is "new".
const OTHER_PNID = `2000${Date.now()}`;
const OTHER_DISPLAY = '+62 800-0000-4321';
const HOUR = 60 * 60 * 1000;
// The texts the spec fixes (D23-1, C2_SPEC section 8), and the placeholder's.
const WARNING = 'Mohon tunggu sebentar sebelum mengirim pesan lagi.';
const RATE_NOTE = 'Rate limit exceeded. User warned.';
const PLACEHOLDER = 'Pesan jenis "text" tidak bisa diproses otomatis (isinya tidak ditampilkan di Sarathi)';
const INGEST_SIGNATURE =
    'uuid, text, text, text, timestamptz, text, text, text, text, text, text, text, jsonb, boolean, text, integer, boolean, text, integer, text, jsonb';

const PHONE = {
    a: '620000000101',
    c: '620000000102',
    d1: '620000000111',
    d2: '620000000112',
    d3: '620000000113',
    d4: '620000000114',
    ds: '620000000115',
    e: '620000000121',
    f: '620000000131',
    g1: '620000000141',
    g2: '620000000142',
    g3: '620000000143',
    h: '620000000151',
    i: '620000000161',
    card: '620000000169',
    j: '620000000171',
    k1: '620000000181',
    k2: '620000000182',
    l: '620000000191',
    m: '620000000201',
    n: '620000000211',
    o1: '620000000221',
    o2: '620000000222',
    p1: '620000000231',
    p2: '620000000232',
    p3: '620000000233',
    q1: '620000000241',
    q2: '620000000242',
    q3: '620000000243',
    q4: '620000000244',
    q5: '620000000245',
    r: '620000000251',
    s: '620000000261',
    t1: '620000000271',
    t2: '620000000272',
    u1: '620000000281',
    u2: '620000000282',
} as const;

// The run's alerts that carry no org (deleted with the run's org).
const ORGLESS_DETAILS = ['perubahan "messages" tanpa isi terbaca; dilewati', 'database 42501 — org default tidak terbaca, periksa Supabase (1 dari 1 item)'];

type Json = Record<string, unknown>;

interface ChatRow {
    phone_number: string;
    last_message: string | null;
    last_message_at: string | null;
    last_inbound_at: string | null;
    unread_count: number;
    ai_enabled: boolean;
    verified_phone: string | null;
    bsuid: string | null;
}

interface MessageRow {
    id: string;
    phone_number: string;
    role: string;
    content: string;
    wa_message_id: string | null;
    wa_timestamp: string | null;
    metadata: Json | null;
    status: string | null;
    status_updated_at: string | null;
    error_code: number | null;
    error_title: string | null;
    error_detail: string | null;
    reply_to_wamid: string | null;
    created_at: string;
}

interface JobRow {
    message_text: string;
    wa_message_id: string | null;
    status: string;
    ai_quota_counted: boolean;
}

interface Probe {
    status: number;
    code: string;
    message: string;
}

const CHAT_COLUMNS = 'phone_number, last_message, last_message_at, last_inbound_at, unread_count, ai_enabled, verified_phone, bsuid';
const MESSAGE_COLUMNS =
    'id, phone_number, role, content, wa_message_id, wa_timestamp, metadata, status, status_updated_at, error_code, error_title, error_detail, reply_to_wamid, created_at';

let db: SupabaseClient;
/** Set once the container is known to be this stack's: only then does any psql run, also in the cleanup. */
let containerVerified = false;
let ORG = '';
let previousDefault: string | null = null;
let runStartedAt = '';
let infoSpy: MockInstance<typeof whatsappLogger.info>;
let errorSpy: MockInstance<typeof whatsappLogger.error>;

// ---------------------------------------------------------------------------
// Meta's payloads, signed like Meta signs them
// ---------------------------------------------------------------------------

/** messages[].timestamp (unix seconds) of a time, and that time in whole seconds. */
function metaAt(epochMs: number): { ts: string; at: Date } {
    const sec = Math.floor(epochMs / 1000);
    return { ts: String(sec), at: new Date(sec * 1000) };
}

/** Meta's time `agoMs` before now. */
const metaAgo = (agoMs: number) => metaAt(Date.now() - agoMs);

function delivery(...entries: Json[][]): Json {
    return { object: 'whatsapp_business_account', entry: entries.map((changes, i) => ({ id: `waba-e2e-${i}`, changes })) };
}

function change(value: Json, phoneNumberId: string = PNID, display = '+62 800-0000-0901'): Json {
    return {
        field: 'messages',
        value: { messaging_product: 'whatsapp', metadata: { display_phone_number: display, phone_number_id: phoneNumberId }, ...value },
    };
}

function userIdUpdate(waId: string, previous: string, current: string, ts: string): Json {
    return {
        field: 'user_id_update',
        value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+62 800-0000-0901', phone_number_id: PNID },
            user_id_update: [{ wa_id: waId, detail: 'pengguna mengganti nomor', user_id: { previous, current }, timestamp: ts }],
        },
    };
}

function contactOf(waId: string, userId?: string): Json {
    return { profile: { name: 'Pelanggan Palsu' }, wa_id: waId, ...(userId ? { user_id: userId } : {}) };
}

function textMsg(from: string, id: string, body: string, ts: string, extra: Json = {}): Json {
    return { from, id, timestamp: ts, type: 'text', text: { body }, ...extra };
}

function statusOf(id: string, status: string, ts: string, recipient: string, extra: Json = {}): Json {
    return { id, status, timestamp: ts, recipient_id: recipient, ...extra };
}

const bytesOf = (body: Json): Buffer => Buffer.from(JSON.stringify(body), 'utf8');

function signedRequest(bytes: Buffer): Request {
    const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(bytes).digest('hex')}`;
    return new Request('http://localhost/api/webhook/whatsapp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        body: new Uint8Array(bytes),
    });
}

/** The real route's answer to a signed delivery (the background work may still run). */
async function deliver(body: Json | Buffer): Promise<number> {
    const res = await POST(signedRequest(Buffer.isBuffer(body) ? body : bytesOf(body)));
    return res.status;
}

/** Waits for the work after the answer: pushes, notes, the warning, the queue drain. */
const settle = () => settleBackground();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Answers the settled conversations now (the webhook's own drains wait 300 s here). */
async function drainNow(): Promise<void> {
    vi.stubEnv('WHATSAPP_DEBOUNCE_SECONDS', '0');
    try {
        await processQueue(db);
    } finally {
        vi.stubEnv('WHATSAPP_DEBOUNCE_SECONDS', '300');
    }
}

const pushesTo = (phone: string) =>
    vi.mocked(sendPushToOrg).mock.calls.filter((c) => c[1] === ORG && c[2].phone === phone).map((c) => c[2]);
const sendsTo = (phone: string) => vi.mocked(sendWhatsAppMessage).mock.calls.filter((c) => c[0] === phone);
const batchLines = () => infoSpy.mock.calls.map((c) => c[0]).filter((line) => line.startsWith('Webhook batch:'));
const ms = (value: string | null | undefined) => (value ? Date.parse(value) : null);

/** The chat list's "Belum dibalas" (ChatList.tsx needsReply): the last activity was the customer's. */
function needsReply(chat: ChatRow | null): boolean {
    if (!chat?.last_inbound_at || !chat.last_message_at) return false;
    return Date.parse(chat.last_message_at) <= Date.parse(chat.last_inbound_at);
}

// ---------------------------------------------------------------------------
// The database, read and staged with the service role
// ---------------------------------------------------------------------------

async function read<T = Json>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
    const { data, error } = await query;
    if (error) throw new Error(`database read failed: ${JSON.stringify(error)}`);
    return (Array.isArray(data) ? data : data === null ? [] : [data]) as T[];
}

async function write(query: PromiseLike<{ error: unknown }>): Promise<void> {
    const { error } = await query;
    if (error) throw new Error(`database write failed: ${JSON.stringify(error)}`);
}

async function chatOf(phone: string): Promise<ChatRow | null> {
    const rows = await read<ChatRow>(db.from('whatsapp_chats').select(CHAT_COLUMNS).eq('org_id', ORG).eq('phone_number', phone));
    return rows[0] ?? null;
}

async function messagesOf(phone: string, role?: 'user' | 'assistant' | 'system'): Promise<MessageRow[]> {
    let query = db.from('whatsapp_messages').select(MESSAGE_COLUMNS).eq('org_id', ORG).eq('phone_number', phone);
    if (role) query = query.eq('role', role);
    return read<MessageRow>(query.order('created_at', { ascending: true }).order('id', { ascending: true }));
}

async function jobsOf(phone: string): Promise<JobRow[]> {
    return read<JobRow>(
        db
            .from('message_queue')
            .select('message_text, wa_message_id, status, ai_quota_counted')
            .eq('org_id', ORG)
            .eq('phone_number', phone)
            .order('created_at', { ascending: true }),
    );
}

/** Drains until the contact's jobs are done: one claim takes the 10 oldest settled conversations of the database. */
async function drainUntilAnswered(phone: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await drainNow();
        if ((await jobsOf(phone)).every((j) => j.status === 'completed' || j.status === 'failed')) return;
    }
    throw new Error('the queue did not answer the contact');
}

async function rateCount(identifier: string): Promise<number | null> {
    const rows = await read<{ request_count: number }>(db.from('rate_limits').select('request_count').eq('identifier', identifier));
    return rows[0]?.request_count ?? null;
}
const mainRate = (phone: string) => rateCount(`${ORG}:${phone}`);
const otherRate = (phone: string) => rateCount(`${ORG}:other:${phone}`);

/** The org's inbound_minute units over every window: let through and refused. */
async function inboundUnits(): Promise<{ used: number; refused: number }> {
    const rows = await read<{ used: number; refused: number }>(
        db.from('org_usage_counters').select('used, refused').eq('org_id', ORG).eq('metric', 'inbound_minute'),
    );
    return rows.reduce((t, r) => ({ used: t.used + r.used, refused: t.refused + r.refused }), { used: 0, refused: 0 });
}

/** The org's ops events of a kind: their total count and the first detail of each minute. */
async function events(kind: string, org: string | null = ORG): Promise<{ count: number; details: string[] }> {
    const base = db.from('ops_events').select('n:count, detail').eq('kind', kind);
    const rows = await read<{ n: number; detail: string }>(org === null ? base.is('org_id', null) : base.eq('org_id', org));
    return { count: rows.reduce((t, r) => t + r.n, 0), details: rows.map((r) => r.detail) };
}

/** Everything the run's org has in the tables the webhook writes. */
async function orgSnapshot(): Promise<Json> {
    return {
        chats: await read(db.from('whatsapp_chats').select('*').eq('org_id', ORG).order('phone_number')),
        messages: await read(db.from('whatsapp_messages').select('*').eq('org_id', ORG).order('created_at').order('id')),
        jobs: await read(db.from('message_queue').select('*').eq('org_id', ORG).order('created_at').order('id')),
        rates: await read(db.from('rate_limits').select('*').like('identifier', `${ORG}:%`).order('identifier')),
        counters: await read(db.from('org_usage_counters').select('*').eq('org_id', ORG).order('metric').order('window_start')),
        events: await read(db.from('ops_events').select('*').eq('org_id', ORG).order('id')),
    };
}

async function seedChat(phone: string, extra: Json = {}): Promise<void> {
    await write(db.from('whatsapp_chats').insert({ org_id: ORG, phone_number: phone, last_message_at: null, ...extra }));
}

/** An earlier reply of ours (an assistant row), for the statuses. */
async function seedReply(phone: string, wamid: string, status: string | null): Promise<void> {
    await write(
        db.from('whatsapp_messages').insert({
            org_id: ORG,
            phone_number: phone,
            role: 'assistant',
            content: 'Balasan lama (e2e)',
            wa_message_id: wamid,
            status,
            status_updated_at: status ? new Date(Date.now() - 10 * 60_000).toISOString() : null,
        }),
    );
}

/** Deletes an org of this test and everything it wrote (the org foreign keys of these tables do not cascade). */
async function purgeOrg(orgId: string): Promise<void> {
    await write(db.from('whatsapp_messages').delete().eq('org_id', orgId));
    await write(db.from('message_queue').delete().eq('org_id', orgId));
    await write(db.from('whatsapp_chats').delete().eq('org_id', orgId));
    await write(db.from('rate_limits').delete().like('identifier', `${orgId}:%`));
    await write(db.from('organizations').delete().eq('id', orgId));
}

/** wa_ingest_inbound with a null org: the function's own 22004 when it is callable, nothing written. */
async function probeIngest(): Promise<Probe> {
    const args: Json = Object.fromEntries(INGEST_PARAMS.map((name) => [name, null]));
    Object.assign(args, { p_wamid: 'wamid.e2e.probe', p_content: 'probe', p_preview: 'probe', p_metadata: {}, p_unread: true, p_ai_eligible: false });
    const { error, status } = await db.rpc('wa_ingest_inbound', args);
    return { status, code: error?.code ?? '', message: error?.message ?? '' };
}

/** Polls the probe until PostgREST's schema cache has followed a DDL change. */
async function waitForProbe(done: (probe: Probe) => boolean): Promise<Probe> {
    let last: Probe = { status: 0, code: '', message: '' };
    for (let i = 0; i < 150; i++) {
        last = await probeIngest();
        if (done(last)) return last;
        await sleep(100);
    }
    throw new Error(`PostgREST did not reach the expected state: ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------
// psql in the stack's Postgres container (DDL PostgREST cannot run)
// ---------------------------------------------------------------------------

/**
 * The Postgres container must belong to the stack LOCAL_SUPABASE_URL points at
 * (the CLI names them supabase_db_<id> and supabase_kong_<id>; the API URL is
 * Kong's published port), so psql's DDL never reaches another local database.
 */
function assertContainerMatchesUrl(): void {
    const id = /^supabase_db_(.+)$/.exec(DB_CONTAINER)?.[1];
    if (!id) throw new Error("LOCAL_SUPABASE_DB_CONTAINER must be the stack's supabase_db_<project_id> container");
    const port = new URL(API_URL).port;
    const mapped = execFileSync('docker', ['port', `supabase_kong_${id}`, '8000/tcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (port === '' || !mapped.split(/\r?\n/).some((line) => line.trim().endsWith(`:${port}`))) {
        throw new Error(`LOCAL_SUPABASE_DB_CONTAINER (${DB_CONTAINER}) is not the database of the stack at LOCAL_SUPABASE_URL`);
    }
}

function psql(sql: string): string {
    return execFileSync(
        'docker',
        ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
        { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
}

/** Undoes what scenarios c, o, p, q, t and u change, also after a run that was killed in between. */
function restoreSchema(): void {
    psql(`
        drop trigger if exists e2e_fail_once on public.message_queue;
        drop trigger if exists e2e_fail_always on public.message_queue;
        drop trigger if exists e2e_slow_once on public.message_queue;
        drop trigger if exists e2e_slow on public.message_queue;
        drop schema if exists e2e_local cascade;
        do $$
        begin
            if to_regprocedure('public.wa_ingest_inbound_e2e_hidden(${INGEST_SIGNATURE})') is not null then
                alter function public.wa_ingest_inbound_e2e_hidden(${INGEST_SIGNATURE}) rename to wa_ingest_inbound;
            end if;
            if to_regprocedure('public.wa_ingest_inbound(${INGEST_SIGNATURE})') is not null
               and not has_function_privilege('service_role', 'public.wa_ingest_inbound(${INGEST_SIGNATURE})', 'execute') then
                grant execute on function public.wa_ingest_inbound(${INGEST_SIGNATURE}) to service_role;
            end if;
            if not has_table_privilege('service_role', 'public.platform_settings', 'select') then
                grant select on table public.platform_settings to service_role;
            end if;
        end;
        $$;
    `);
}

/** The org's Realtime broadcasts by table, or null without psql or without today's partition. */
function broadcasts(): { chats: number; messages: number } | null {
    if (!DB_CONTAINER) return null;
    const partition = psql(
        `select to_regclass(format('realtime.messages_%s', to_char(now() at time zone 'utc', 'YYYY_MM_DD'))) is not null;`,
    );
    if (partition !== 't') return null;
    const out = psql(
        `select count(*) filter (where event = 'whatsapp_chats') || ',' || count(*) filter (where event = 'whatsapp_messages')
           from realtime.messages where topic = 'org:${ORG}';`,
    );
    const [chats, messages] = out.split(',').map(Number);
    return { chats, messages };
}

describe.skipIf(!ENABLED)('webhook against a local Supabase stack (PR-C2 end to end)', () => {
    beforeAll(async () => {
        const host = new URL(API_URL).hostname;
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
            throw new Error('LOCAL_SUPABASE_URL must point at a local Supabase stack (127.0.0.1 or localhost)');
        }
        db = createClient(API_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        if (DB_CONTAINER) {
            assertContainerMatchesUrl();
            containerVerified = true;
            restoreSchema();
        }
        const probe = await waitForProbe((p) => p.code === '22004' || p.code === 'PGRST202');
        if (probe.code !== '22004') throw new Error(`wa_ingest_inbound is not callable (${probe.status} ${probe.code}): apply 0072 (supabase db reset)`);

        // A fresh org, made the default org the way lib/settings reads it.
        const previous = await read<{ value: string }>(db.from('platform_settings').select('value').eq('key', 'default_org_id'));
        const leftovers = await read<{ id: string }>(db.from('organizations').select('id').like('name', `${ORG_PREFIX}%`));
        for (const { id } of leftovers) await purgeOrg(id);
        // drainNow() answers every settled job of the queue, whatever its org
        // (claim_queue_jobs is not scoped): refuse a database that holds
        // another org's pending jobs instead of answering them.
        const pending = await read<{ id: string }>(db.from('message_queue').select('id').eq('status', 'pending').limit(1));
        if (pending.length > 0) {
            throw new Error('message_queue holds pending jobs of another org: run `npx supabase db reset` before this test');
        }
        previousDefault = previous[0]?.value ?? null;
        // A run killed before its cleanup left its own org as the default.
        if (previousDefault !== null && leftovers.some((o) => o.id === previousDefault)) previousDefault = SEED_ORG_ID;
        runStartedAt = new Date(Date.now() - 1000).toISOString();
        const created = await read<{ id: string }>(
            db.from('organizations').insert({ name: `${ORG_PREFIX} ${runStartedAt}` }).select('id'),
        );
        ORG = created[0].id;
        await write(db.from('platform_settings').upsert({ key: 'default_org_id', value: ORG }, { onConflict: 'key' }));

        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', API_URL);
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
        vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
        vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', PNID);
        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', TOKEN);
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', '');
        // The webhook's own drains find nothing settled, so a test sees the
        // jobs as the ingest left them; drainNow() answers on demand.
        vi.stubEnv('WHATSAPP_DEBOUNCE_SECONDS', '300');
        infoSpy = vi.spyOn(whatsappLogger, 'info');
        errorSpy = vi.spyOn(whatsappLogger, 'error');
    }, 120_000);

    afterAll(async () => {
        await settleBackground();
        const problems: unknown[] = [];
        const attempt = async (step: () => unknown) => {
            try {
                await step();
            } catch (error) {
                problems.push(error);
            }
        };
        // Never after a refused start: the container may be another stack's.
        if (containerVerified) await attempt(() => restoreSchema());
        if (db && ORG) {
            await attempt(() =>
                write(
                    previousDefault !== null
                        ? db.from('platform_settings').upsert({ key: 'default_org_id', value: previousDefault }, { onConflict: 'key' })
                        : db.from('platform_settings').delete().eq('key', 'default_org_id'),
                ),
            );
            if (!KEEP_ROWS) {
                await attempt(() => purgeOrg(ORG));
                // The org-less alerts of this run: the other number's (j, r),
                // the unreadable change (l) and the unreadable org (t).
                const ref = otherNumberOf(OTHER_PNID, OTHER_DISPLAY).ref;
                await attempt(() => write(db.from('ops_events').delete().is('org_id', null).like('detail', `phone_number_id ${ref};%`)));
                await attempt(() =>
                    write(db.from('ops_events').delete().is('org_id', null).in('detail', ORGLESS_DETAILS).gte('first_at', runStartedAt)),
                );
            }
        }
        infoSpy?.mockRestore();
        errorSpy?.mockRestore();
        vi.unstubAllEnvs();
        if (problems.length > 0) throw new AggregateError(problems, 'local-db cleanup failed');
    }, 60_000);

    beforeEach(() => {
        h.outbound = [];
        vi.mocked(sendWhatsAppMessage)
            .mockReset()
            .mockImplementation(async () => {
                const waMessageId = `wamid.e2e-keluar-${Date.now()}-${++h.outSeq}`;
                h.outbound.push(waMessageId);
                return { waMessageId, raw: {} };
            });
        vi.mocked(downloadWhatsAppMedia).mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', size: 3 });
        vi.mocked(sendPushToOrg).mockReset().mockResolvedValue(undefined);
        vi.mocked(generateRAGResponse).mockReset().mockResolvedValue({ message: AI_REPLY, sources: [] });
        infoSpy.mockClear();
        errorSpy.mockClear();
    });

    let aBytes: Buffer = Buffer.alloc(0);

    it('a. a new contact\'s text: one call stores the chat, the row, the job, the rate slot and the minute unit; processQueue answers it once', { timeout: 60_000 }, async () => {
        const A = PHONE.a;
        const t = metaAgo(30_000);
        aBytes = bytesOf(delivery([change({ contacts: [contactOf(A)], messages: [textMsg(A, 'wamid.e2e.a1', 'Halo, masih buka?', t.ts)] })]));
        const units = await inboundUnits();
        const before = broadcasts();

        expect(await deliver(aBytes)).toBe(200);

        // Committed before the answer.
        const chat = await chatOf(A);
        expect(chat).toMatchObject({ last_message: 'Halo, masih buka?', unread_count: 1, ai_enabled: true, verified_phone: A, bsuid: null });
        expect(ms(chat?.last_inbound_at)).toBe(t.at.getTime());
        expect(ms(chat?.last_message_at)).toBe(t.at.getTime());
        const rows = await messagesOf(A);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            role: 'user',
            content: 'Halo, masih buka?',
            wa_message_id: 'wamid.e2e.a1',
            metadata: {},
            status: null,
            reply_to_wamid: null,
        });
        expect(ms(rows[0].wa_timestamp)).toBe(t.at.getTime());
        expect(await jobsOf(A)).toEqual([
            { message_text: 'Halo, masih buka?', wa_message_id: 'wamid.e2e.a1', status: 'pending', ai_quota_counted: false },
        ]);
        expect(await mainRate(A)).toBe(1);
        expect((await inboundUnits()).used).toBe(units.used + 1);

        await settle();
        expect(pushesTo(A)).toEqual([{ title: A, body: 'Halo, masih buka?', phone: A, url: `/dashboard/chats?phone=${A}` }]);
        expect(sendsTo(A)).toEqual([]);
        expect(needsReply(await chatOf(A))).toBe(true);
        expect(batchLines()).toEqual([expect.stringMatching(/^Webhook batch: items=1 new=1 duplicate=0 rate_limited=0 .*retryable=0 deferred=0 /)]);
        // One broadcast per statement: the chat insert, the message insert, the summary update.
        if (before) expect(broadcasts()).toEqual({ chats: before.chats + 2, messages: before.messages + 1 });

        // The burst has settled: processQueue answers it once.
        await drainNow();
        expect(vi.mocked(generateRAGResponse).mock.calls).toEqual([['Halo, masih buka?', [], A, { orgId: ORG }]]);
        expect(sendsTo(A)).toEqual([[A, AI_REPLY, { phoneNumberId: PNID, accessToken: TOKEN }]]);
        const after = await messagesOf(A);
        expect(after.map((m) => [m.role, m.content, m.wa_message_id, m.status])).toEqual([
            ['user', 'Halo, masih buka?', 'wamid.e2e.a1', null],
            ['assistant', AI_REPLY, h.outbound[0], 'sent'],
        ]);
        expect((await jobsOf(A)).map((j) => [j.status, j.ai_quota_counted])).toEqual([['completed', true]]);
        expect(needsReply(await chatOf(A))).toBe(false);

        // Nothing is left to answer.
        await drainNow();
        expect(sendsTo(A)).toHaveLength(1);
    });

    it('b. the same signed bytes again: 200 and nothing changes', { timeout: 60_000 }, async () => {
        expect(aBytes.length).toBeGreaterThan(0);
        const snapshot = await orgSnapshot();
        const before = broadcasts();

        expect(await deliver(aBytes)).toBe(200);
        await settle();

        expect(await orgSnapshot()).toEqual(snapshot);
        expect(pushesTo(PHONE.a)).toEqual([]);
        expect(sendsTo(PHONE.a)).toEqual([]);
        expect(batchLines()).toEqual([expect.stringMatching(/^Webhook batch: items=1 new=0 duplicate=1 /)]);
        if (before) expect(broadcasts()).toEqual(before);
    });

    it.skipIf(!DB_CONTAINER)('c. a one-shot 40001 in the call\'s last step: 503 and one webhook_error, nothing left; the resend is stored exactly once', { timeout: 60_000 }, async () => {
        const C = PHONE.c;
        const wamid = 'wamid.e2e.c1';
        const bytes = bytesOf(delivery([change({ contacts: [contactOf(C)], messages: [textMsg(C, wamid, 'Saya mau pesan paket', metaAgo(20_000).ts)] })]));
        const units = await inboundUnits();
        const errorsBefore = await events('webhook_error');
        // A sequence is not rolled back with the failed call, so this fails once.
        psql(`
            drop trigger if exists e2e_fail_once on public.message_queue;
            drop schema if exists e2e_local cascade;
            create schema e2e_local;
            create sequence e2e_local.fail_once_seq;
            create function e2e_local.fail_once() returns trigger
            language plpgsql security definer set search_path = '' as $$
            begin
                if nextval('e2e_local.fail_once_seq') = 1 then
                    raise exception 'e2e: gagal sekali' using errcode = '40001';
                end if;
                return new;
            end;
            $$;
            create trigger e2e_fail_once before insert on public.message_queue
                for each row when (new.org_id = '${ORG}'::uuid and new.wa_message_id = '${wamid}')
                execute function e2e_local.fail_once();
        `);
        try {
            await waitForProbe((p) => p.code === '22004');

            expect(await deliver(bytes)).toBe(503);
            const errors = await events('webhook_error');
            expect(errors.count).toBe(errorsBefore.count + 1);
            expect(errors.details).toContain('database 40001 — bentrok transaksi, aman bila jarang (1 dari 1 item)');
            // The call rolled back as a whole.
            expect(await chatOf(C)).toBeNull();
            expect(await messagesOf(C)).toEqual([]);
            expect(await jobsOf(C)).toEqual([]);
            expect(await mainRate(C)).toBeNull();
            expect((await inboundUnits()).used).toBe(units.used);
            await settle();
            expect(pushesTo(C)).toEqual([]);

            // Meta resends the same bytes.
            expect(await deliver(bytes)).toBe(200);
            expect((await messagesOf(C)).map((m) => [m.role, m.wa_message_id])).toEqual([['user', wamid]]);
            expect((await jobsOf(C)).map((j) => [j.wa_message_id, j.status])).toEqual([[wamid, 'pending']]);
            expect(await mainRate(C)).toBe(1);
            expect((await inboundUnits()).used).toBe(units.used + 1);
            expect((await chatOf(C))?.unread_count).toBe(1);
            await settle();
            expect(pushesTo(C)).toHaveLength(1);
            expect((await events('webhook_error')).count).toBe(errorsBefore.count + 1);
        } finally {
            psql('drop trigger if exists e2e_fail_once on public.message_queue; drop schema if exists e2e_local cascade;');
        }
    });

    it('d. 2 entries x 2 changes x 2 messages from 4 contacts plus statuses: every message stored in Meta-time order, the statuses applied', { timeout: 60_000 }, async () => {
        const { d1: D1, d2: D2, d3: D3, d4: D4, ds: DS } = PHONE;
        await seedChat(DS);
        await seedReply(DS, 'wamid.e2e.d-out1', 'sent');
        await seedReply(DS, 'wamid.e2e.d-out2', 'delivered');
        const base = Date.now() - 120_000;
        const t = (k: number) => metaAt(base + k * 5_000);
        const msg = (from: string, k: number) => textMsg(from, `wamid.e2e.d-${k}`, `Pesan ke-${k}`, t(k).ts);
        const units = await inboundUnits();

        const body = delivery(
            [
                change({ contacts: [contactOf(D1), contactOf(D2)], messages: [msg(D1, 5), msg(D2, 2)] }),
                change({
                    contacts: [contactOf(D3), contactOf(D1)],
                    messages: [msg(D3, 7), msg(D1, 1)],
                    statuses: [statusOf('wamid.e2e.d-out1', 'delivered', t(3).ts, DS)],
                }),
            ],
            [
                change({ contacts: [contactOf(D4), contactOf(D2)], messages: [msg(D4, 3), msg(D2, 8)] }),
                change({
                    contacts: [contactOf(D3), contactOf(D4)],
                    messages: [msg(D3, 4), msg(D4, 6)],
                    statuses: [statusOf('wamid.e2e.d-out2', 'read', t(6).ts, DS)],
                }),
            ],
        );
        expect(await deliver(body)).toBe(200);

        const stored = await read<MessageRow>(
            db
                .from('whatsapp_messages')
                .select(MESSAGE_COLUMNS)
                .eq('org_id', ORG)
                .eq('role', 'user')
                .in('phone_number', [D1, D2, D3, D4])
                .order('created_at', { ascending: true })
                .order('id', { ascending: true }),
        );
        // Stored oldest first by Meta's time, whatever the payload order.
        expect(stored.map((m) => m.wa_message_id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((k) => `wamid.e2e.d-${k}`));
        expect(stored.map((m) => m.phone_number)).toEqual([D1, D2, D4, D3, D1, D4, D3, D2]);
        expect(stored.map((m) => ms(m.wa_timestamp))).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((k) => t(k).at.getTime()));
        const created = stored.map((m) => Date.parse(m.created_at));
        expect(created.every((c, i) => i === 0 || c > created[i - 1])).toBe(true);
        for (const [phone, latest] of [[D1, 5], [D2, 8], [D3, 7], [D4, 6]] as const) {
            const chat = await chatOf(phone);
            expect(chat).toMatchObject({ unread_count: 2, last_message: `Pesan ke-${latest}`, verified_phone: phone });
            expect(ms(chat?.last_inbound_at)).toBe(t(latest).at.getTime());
            expect(await mainRate(phone)).toBe(2);
            expect((await jobsOf(phone)).map((j) => j.status)).toEqual(['pending', 'pending']);
        }
        // One unit per new burst; the second message of each contact joins it.
        expect((await inboundUnits()).used).toBe(units.used + 4);
        const replies = await messagesOf(DS, 'assistant');
        expect(replies.map((m) => [m.wa_message_id, m.status, ms(m.status_updated_at)])).toEqual([
            ['wamid.e2e.d-out1', 'delivered', t(3).at.getTime()],
            ['wamid.e2e.d-out2', 'read', t(6).at.getTime()],
        ]);
        await settle();
        expect([D1, D2, D3, D4].map((p) => pushesTo(p).length)).toEqual([2, 2, 2, 2]);
        expect(batchLines()).toEqual([
            expect.stringMatching(/^Webhook batch: items=10 new=8 duplicate=0 .*retryable=0 deferred=0 statuses applied=2 stale=0 unknown=0 /),
        ]);

        // Each contact's burst is answered once, its two messages as one
        // turn, without the burst's rows in the history.
        await drainNow();
        const burstPhones: string[] = [D1, D2, D3, D4];
        const turns = vi.mocked(generateRAGResponse).mock.calls.filter((c) => burstPhones.includes(c[2] ?? ''));
        expect(turns.map((c) => [c[2], c[0], c[1]]).sort()).toEqual(
            [
                [D1, 'Pesan ke-1\nPesan ke-5', []],
                [D2, 'Pesan ke-2\nPesan ke-8', []],
                [D3, 'Pesan ke-4\nPesan ke-7', []],
                [D4, 'Pesan ke-3\nPesan ke-6', []],
            ].sort(),
        );
        for (const phone of [D1, D2, D3, D4]) {
            expect(sendsTo(phone)).toHaveLength(1);
            expect((await jobsOf(phone)).map((j) => j.status)).toEqual(['completed', 'completed']);
        }
        expect((await inboundUnits()).used).toBe(units.used + 4);
    });

    it('e. statuses only move forward: sent, delivered, read applied; a late delivered and a failed after read are stale; failed keeps Meta\'s error until a newer delivered', { timeout: 60_000 }, async () => {
        const E = PHONE.e;
        await seedChat(E);
        await seedReply(E, 'wamid.e2e.e-out1', null);
        await seedReply(E, 'wamid.e2e.e-out2', 'sent');
        const base = Date.now() - 100_000;
        const t = (k: number) => metaAt(base + k * 5_000);
        const detail = 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.';
        const failure = { errors: [{ code: 131047, title: 'Re-engagement message', message: 'Re-engagement message', error_data: { details: detail } }] };
        const reply = async (wamid: string) => (await messagesOf(E, 'assistant')).find((m) => m.wa_message_id === wamid);
        const step = async (status: Json): Promise<string | undefined> => {
            infoSpy.mockClear();
            expect(await deliver(delivery([change({ statuses: [status] })]))).toBe(200);
            return batchLines()[0];
        };

        // sent on a row without a status, with the recipient's BSUID (backfilled onto the chat).
        expect(await step(statusOf('wamid.e2e.e-out1', 'sent', t(1).ts, E, { recipient_user_id: 'ID.e2e.0000000121' }))).toMatch(
            /statuses applied=1 stale=0 unknown=0/,
        );
        expect(await reply('wamid.e2e.e-out1')).toMatchObject({ status: 'sent' });
        expect(ms((await reply('wamid.e2e.e-out1'))?.status_updated_at)).toBe(t(1).at.getTime());
        expect((await chatOf(E))?.bsuid).toBe('ID.e2e.0000000121');
        expect(await step(statusOf('wamid.e2e.e-out1', 'delivered', t(2).ts, E))).toMatch(/statuses applied=1 stale=0 unknown=0/);
        expect((await reply('wamid.e2e.e-out1'))?.status).toBe('delivered');
        expect(await step(statusOf('wamid.e2e.e-out1', 'read', t(3).ts, E))).toMatch(/statuses applied=1 stale=0 unknown=0/);
        expect((await reply('wamid.e2e.e-out1'))?.status).toBe('read');

        // A late delivered (newer Meta time, lower rank) and a failed after read: stale.
        expect(await step(statusOf('wamid.e2e.e-out1', 'delivered', t(4).ts, E))).toMatch(/statuses applied=0 stale=1 unknown=0/);
        expect(await step(statusOf('wamid.e2e.e-out1', 'failed', t(5).ts, E, failure))).toMatch(/statuses applied=0 stale=1 unknown=0/);
        const out1 = await reply('wamid.e2e.e-out1');
        expect(out1).toMatchObject({ status: 'read', error_code: null, error_title: null, error_detail: null });
        expect(ms(out1?.status_updated_at)).toBe(t(3).at.getTime());

        // failed on a sent row: Meta's error is kept.
        expect(await step(statusOf('wamid.e2e.e-out2', 'failed', t(6).ts, E, failure))).toMatch(/statuses applied=1 stale=0 unknown=0/);
        expect(await reply('wamid.e2e.e-out2')).toMatchObject({
            status: 'failed',
            error_code: 131047,
            error_title: 'Re-engagement message',
            error_detail: detail,
        });
        // A delivered newer than the failure overrides it and clears the error.
        expect(await step(statusOf('wamid.e2e.e-out2', 'delivered', t(7).ts, E))).toMatch(/statuses applied=1 stale=0 unknown=0/);
        expect(await reply('wamid.e2e.e-out2')).toMatchObject({ status: 'delivered', error_code: null, error_title: null, error_detail: null });
    });

    it('f. D23-1: the 11th message of a minute is refused with ONE warning and ONE note; the 12th gets neither', { timeout: 60_000 }, async () => {
        const F = PHONE.f;
        const units = await inboundUnits();
        const body = (k: number) =>
            delivery([change({ contacts: [contactOf(F)], messages: [textMsg(F, `wamid.e2e.f-${k}`, `Pesan cepat ${k}`, metaAgo(40_000 - k * 1000).ts)] })]);
        const warnings = () => sendsTo(F).filter((c) => c[1] === WARNING);

        for (let k = 1; k <= 10; k++) expect(await deliver(body(k))).toBe(200);
        await settle();
        expect(await messagesOf(F, 'user')).toHaveLength(10);
        expect(warnings()).toEqual([]);
        const tenth = await chatOf(F);

        expect(await deliver(body(11))).toBe(200);
        await settle();
        expect(await messagesOf(F, 'user')).toHaveLength(10);
        expect(warnings()).toEqual([[F, WARNING, { phoneNumberId: PNID, accessToken: TOKEN }]]);
        expect((await messagesOf(F, 'system')).map((m) => m.content)).toEqual([RATE_NOTE]);

        expect(await deliver(body(12))).toBe(200);
        await settle();
        expect(await messagesOf(F, 'user')).toHaveLength(10);
        expect(warnings()).toHaveLength(1);
        expect(await messagesOf(F, 'system')).toHaveLength(1);

        expect(await mainRate(F)).toBe(12);
        expect((await jobsOf(F)).map((j) => j.status)).toEqual(Array(10).fill('pending'));
        expect((await inboundUnits()).used).toBe(units.used + 1);
        expect(pushesTo(F)).toHaveLength(10);
        // The note keeps the chat unanswered: the summary is still the 10th message's.
        const chat = await chatOf(F);
        expect(chat).toMatchObject({ unread_count: 10, last_message: 'Pesan cepat 10' });
        expect(chat?.last_message_at).toBe(tenth?.last_message_at);
        expect(chat?.last_inbound_at).toBe(tenth?.last_inbound_at);
        expect(needsReply(chat)).toBe(true);

        // The next window (its start moved back 61 s): stored again, from count 1.
        await write(
            db.from('rate_limits').update({ window_start: new Date(Date.now() - 61_000).toISOString() }).eq('identifier', `${ORG}:${F}`),
        );
        expect(await deliver(body(13))).toBe(200);
        expect(await mainRate(F)).toBe(1);
        expect(await messagesOf(F, 'user')).toHaveLength(11);
    });

    it('g. D23-2: a text 21 h old is stored without AI and with one note that keeps the chat unanswered; 19.5 h still gets the AI; 25 h names the template', { timeout: 60_000 }, async () => {
        const { g1: G1, g2: G2, g3: G3 } = PHONE;
        const late = metaAgo(21 * HOUR + 30_000);
        const units = await inboundUnits();

        expect(await deliver(delivery([change({ contacts: [contactOf(G1)], messages: [textMsg(G1, 'wamid.e2e.g1', 'Kemarin saya tanya harga', late.ts)] })]))).toBe(200);
        const rows = await messagesOf(G1, 'user');
        expect(rows.map((m) => [m.content, ms(m.wa_timestamp)])).toEqual([['Kemarin saya tanya harga', late.at.getTime()]]);
        expect(await jobsOf(G1)).toEqual([]);
        expect((await inboundUnits()).used).toBe(units.used);
        expect(await mainRate(G1)).toBe(1);
        const chat = await chatOf(G1);
        expect(chat?.unread_count).toBe(1);
        expect(ms(chat?.last_inbound_at)).toBe(late.at.getTime());
        expect(ms(chat?.last_message_at)).toBe(late.at.getTime());

        await settle();
        const notes = await messagesOf(G1, 'system');
        expect(notes).toHaveLength(1);
        expect(notes[0].content).toContain('21 jam');
        expect(notes[0].content).toContain('tidak dibalas AI');
        expect(notes[0].content).not.toContain('template');
        const after = await chatOf(G1);
        expect(after?.last_message_at).toBe(chat?.last_message_at);
        expect(needsReply(after)).toBe(true);
        expect(pushesTo(G1)).toHaveLength(1);

        // Under 20 h the AI still answers.
        const almost = metaAgo(19.5 * HOUR);
        expect(await deliver(delivery([change({ contacts: [contactOf(G2)], messages: [textMsg(G2, 'wamid.e2e.g2', 'Masih ada slot?', almost.ts)] })]))).toBe(200);
        expect((await jobsOf(G2)).map((j) => j.status)).toEqual(['pending']);
        expect((await inboundUnits()).used).toBe(units.used + 1);
        await settle();
        expect(await messagesOf(G2, 'system')).toEqual([]);

        // Past 24 h the note says a reply needs a template.
        const old = metaAgo(25 * HOUR);
        expect(await deliver(delivery([change({ contacts: [contactOf(G3)], messages: [textMsg(G3, 'wamid.e2e.g3', 'Halo?', old.ts)] })]))).toBe(200);
        expect(await jobsOf(G3)).toEqual([]);
        await settle();
        const oldNotes = await messagesOf(G3, 'system');
        expect(oldNotes).toHaveLength(1);
        expect(oldNotes[0].content).toContain('25 jam');
        expect(oldNotes[0].content).toContain('template');
    });

    it('h. D23-4: a template button, a button and a list choice, an order and a location are stored as one line each without AI; a reaction is not stored', { timeout: 60_000 }, async () => {
        const H = PHONE.h;
        const base = Date.now() - 60_000;
        const t = (k: number) => metaAt(base + k * 2_000).ts;
        const units = await inboundUnits();
        const messages = [
            { from: H, id: 'wamid.e2e.h1', timestamp: t(1), type: 'button', button: { text: 'Ya, lanjut', payload: 'LANJUT' } },
            { from: H, id: 'wamid.e2e.h2', timestamp: t(2), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'paket-hemat', title: 'Paket Hemat' } } },
            { from: H, id: 'wamid.e2e.h3', timestamp: t(3), type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'sabtu', title: 'Sabtu pagi', description: 'Jam 09.00' } } },
            { from: H, id: 'wamid.e2e.h4', timestamp: t(4), type: 'order', order: { catalog_id: 'katalog-palsu', product_items: [{ product_retailer_id: 'sku-1', quantity: 1, item_price: 10000, currency: 'IDR' }] } },
            { from: H, id: 'wamid.e2e.h5', timestamp: t(5), type: 'location', location: { latitude: -6.2, longitude: 106.8, name: 'Gedung Contoh', address: 'Jl. Contoh No. 1' } },
            { from: H, id: 'wamid.e2e.h6', timestamp: t(6), type: 'reaction', reaction: { message_id: 'wamid.e2e.h1', emoji: '👍' } },
        ];
        expect(await deliver(delivery([change({ contacts: [contactOf(H)], messages })]))).toBe(200);

        const rows = await messagesOf(H, 'user');
        expect(rows.map((m) => [m.wa_message_id, m.content, m.metadata])).toEqual([
            ['wamid.e2e.h1', '🔘 Tombol: Ya, lanjut', {}],
            ['wamid.e2e.h2', '🔘 Pilihan: Paket Hemat', {}],
            ['wamid.e2e.h3', '🔘 Pilihan: Sabtu pagi', {}],
            // Its line only says that it arrived: kept out of the AI history.
            ['wamid.e2e.h4', 'Pesan jenis "order" (isinya tidak ditampilkan di Sarathi)', { unprocessable: 'order' }],
            ['wamid.e2e.h5', '📍 Lokasi: Gedung Contoh, Jl. Contoh No. 1', {}],
        ]);
        expect(rows.every((m) => m.wa_timestamp !== null)).toBe(true);
        expect(await jobsOf(H)).toEqual([]);
        expect((await inboundUnits()).used).toBe(units.used);
        expect(await mainRate(H)).toBe(5);
        const chat = await chatOf(H);
        // The location's address stays out of the preview.
        expect(chat).toMatchObject({ unread_count: 5, last_message: '📍 Lokasi' });
        expect(needsReply(chat)).toBe(true);
        await settle();
        expect(pushesTo(H).map((p) => p.body)).toEqual([
            '🔘 Tombol: Ya, lanjut',
            '🔘 Pilihan: Paket Hemat',
            '🔘 Pilihan: Sabtu pagi',
            'Pesan jenis "order" (isinya tidak ditampilkan di Sarathi)',
            '📍 Lokasi',
        ]);
        expect(sendsTo(H)).toEqual([]);
        expect(batchLines()).toEqual([expect.stringMatching(/^Webhook batch: items=6 new=5 duplicate=0 rate_limited=0 acked=1 /)]);
    });

    it('i. D23-3: a contact card on the main number sets verified_phone and leaves one note keyed by its wamid; the resend writes no second note', { timeout: 60_000 }, async () => {
        const I = PHONE.i;
        const card = {
            from: I,
            id: 'wamid.e2e.i1',
            timestamp: metaAgo(20_000).ts,
            type: 'contacts',
            contacts: [{ name: { formatted_name: 'Rekan Palsu', first_name: 'Rekan' }, phones: [{ phone: '+62 000-0000-0169', wa_id: PHONE.card, type: 'CELL' }] }],
        };
        const bytes = bytesOf(delivery([change({ contacts: [contactOf(I)], messages: [card] })]));

        expect(await deliver(bytes)).toBe(200);
        // Committed before the answer.
        const chat = await chatOf(I);
        expect(chat).toMatchObject({ verified_phone: PHONE.card, unread_count: 0 });
        expect((await messagesOf(I)).map((m) => [m.role, m.content, m.wa_message_id])).toEqual([
            ['system', `Customer shared contact info — phone tersimpan: ${PHONE.card}`, 'wamid.e2e.i1'],
        ]);
        expect(await jobsOf(I)).toEqual([]);
        await settle();

        expect(await deliver(bytes)).toBe(200);
        await settle();
        expect(await messagesOf(I)).toHaveLength(1);
        expect(batchLines()[1]).toMatch(/^Webhook batch: items=1 new=0 duplicate=1 /);
    });

    it('j. store-only: a text to another number of the WABA (process mode) is stored with metadata.other_number, no job, its own rate bucket, the note and the part-1 alerts', { timeout: 60_000 }, async () => {
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        try {
            const J = PHONE.j;
            const other = otherNumberOf(OTHER_PNID, OTHER_DISPLAY);
            const t = metaAgo(20_000);
            const units = await inboundUnits();
            const body = delivery([
                change({ contacts: [contactOf(J)], messages: [textMsg(J, 'wamid.e2e.j1', 'Halo nomor lain', t.ts)] }, OTHER_PNID, OTHER_DISPLAY),
            ]);

            expect(await deliver(body)).toBe(200);
            const rows = await messagesOf(J, 'user');
            expect(rows.map((m) => [m.content, m.metadata, ms(m.wa_timestamp)])).toEqual([
                ['Halo nomor lain', { other_number: other.ref }, t.at.getTime()],
            ]);
            expect(await jobsOf(J)).toEqual([]);
            expect((await inboundUnits()).used).toBe(units.used);
            expect(await otherRate(J)).toBe(1);
            expect(await mainRate(J)).toBeNull();
            const chat = await chatOf(J);
            expect(chat?.unread_count).toBe(1);
            expect(ms(chat?.last_inbound_at)).toBe(t.at.getTime());

            await settle();
            expect((await messagesOf(J, 'system')).map((m) => m.content)).toEqual([otherNumberNotice(other)]);
            expect(pushesTo(J)).toHaveLength(1);
            expect(sendsTo(J)).toEqual([]);
            const detail = `phone_number_id ${other.ref}; nomor berakhiran 4321; diproses tanpa AI, pesan disimpan di inbox (WHATSAPP_OTHER_NUMBER_EVENTS=process)`;
            const alerts = await read<{ kind: string; n: number; detail: string }>(
                db.from('ops_events').select('kind, n:count, detail').is('org_id', null).like('detail', `phone_number_id ${other.ref};%`).order('kind'),
            );
            expect(alerts).toEqual([
                { kind: 'webhook_unrouted', n: 1, detail },
                { kind: 'webhook_unrouted_new', n: 1, detail },
            ]);

            // A contact card to that number: one summary row; the sender's own
            // phone stays verified_phone, not the card's.
            const card = {
                from: J,
                id: 'wamid.e2e.j2',
                timestamp: metaAgo(19_000).ts,
                type: 'contacts',
                contacts: [{ name: { formatted_name: 'Rekan Palsu' }, phones: [{ phone: '+62 000-0000-0169', wa_id: PHONE.card }] }],
            };
            expect(await deliver(delivery([change({ contacts: [contactOf(J)], messages: [card] }, OTHER_PNID, OTHER_DISPLAY)]))).toBe(200);
            const cardRows = await messagesOf(J, 'user');
            expect(cardRows.map((m) => [m.wa_message_id, m.content, m.metadata])).toContainEqual([
                'wamid.e2e.j2',
                '👤 Kartu kontak dibagikan\nRekan Palsu: +62 000-0000-0169',
                { other_number: other.ref },
            ]);
            expect(await chatOf(J)).toMatchObject({ verified_phone: J, last_message: '👤 Kartu kontak', unread_count: 2 });
            expect(await otherRate(J)).toBe(2);

            // The contact's own bucket for that number (D23-1, store-only
            // side): the 11th message of the minute is not stored, one note,
            // no warning from the main number.
            const text = (k: number) =>
                delivery([change({ contacts: [contactOf(J)], messages: [textMsg(J, `wamid.e2e.j-${k}`, `Lagi ${k}`, metaAgo(18_000 - k * 100).ts)] }, OTHER_PNID, OTHER_DISPLAY)]);
            for (let k = 3; k <= 12; k++) expect(await deliver(text(k))).toBe(200);
            await settle();
            expect(await messagesOf(J, 'user')).toHaveLength(10);
            expect(await otherRate(J)).toBe(12);
            expect((await messagesOf(J, 'system')).map((m) => m.content)).toEqual([otherNumberNotice(other), otherNumberLimitNotice(other)]);
            expect(sendsTo(J)).toEqual([]);
        } finally {
            vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', '');
        }
    });

    it('k. user_id_update moves the stored BSUID; a phone-less message with the new BSUID lands in the same chat, also when it comes first in the same delivery', { timeout: 60_000 }, async () => {
        const { k1: K1, k2: K2 } = PHONE;
        const [OLD1, NEW1, OLD2, NEW2] = ['ID.e2e.000000000181', 'ID.e2e.000000000182', 'ID.e2e.000000000281', 'ID.e2e.000000000282'];
        const phoneless = (bsuid: string, id: string, body: string, ts: string) =>
            change({ contacts: [{ profile: { name: 'Pelanggan Palsu' }, user_id: bsuid }], messages: [{ from_user_id: bsuid, id, timestamp: ts, type: 'text', text: { body } }] });

        // A text that records the old BSUID.
        const first = textMsg(K1, 'wamid.e2e.k1-1', 'Halo dari nomor lama', metaAgo(50_000).ts, { from_user_id: OLD1 });
        expect(await deliver(delivery([change({ contacts: [contactOf(K1, OLD1)], messages: [first] })]))).toBe(200);
        expect((await chatOf(K1))?.bsuid).toBe(OLD1);

        // The customer changed number: committed before the answer.
        expect(await deliver(delivery([userIdUpdate(K1, OLD1, NEW1, metaAgo(40_000).ts)]))).toBe(200);
        expect((await chatOf(K1))?.bsuid).toBe(NEW1);

        // A message that carries only the new BSUID lands in the same chat.
        expect(await deliver(delivery([phoneless(NEW1, 'wamid.e2e.k1-2', 'Ini saya, nomor baru', metaAgo(30_000).ts)]))).toBe(200);
        expect((await messagesOf(K1, 'user')).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.k1-1', 'wamid.e2e.k1-2']);
        expect(await chatOf(NEW1)).toBeNull();
        expect((await chatOf(K1))?.unread_count).toBe(2);
        expect(await mainRate(K1)).toBe(2);

        // Same again in ONE delivery, the message listed before the update:
        // pass 1 moves the BSUID before any message is stored.
        const second = textMsg(K2, 'wamid.e2e.k2-1', 'Halo', metaAgo(50_000).ts, { from_user_id: OLD2 });
        expect(await deliver(delivery([change({ contacts: [contactOf(K2, OLD2)], messages: [second] })]))).toBe(200);
        expect(
            await deliver(
                delivery([phoneless(NEW2, 'wamid.e2e.k2-2', 'Nomor baru saya', metaAgo(20_000).ts), userIdUpdate(K2, OLD2, NEW2, metaAgo(25_000).ts)]),
            ),
        ).toBe(200);
        expect((await messagesOf(K2, 'user')).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.k2-1', 'wamid.e2e.k2-2']);
        expect((await chatOf(K2))?.bsuid).toBe(NEW2);
        expect(await chatOf(NEW2)).toBeNull();
        await settle();
    });

    it('l. a signed text without "text" becomes a placeholder (metadata.unprocessable) with a webhook_payload_invalid; an unreadable status and change value are skipped with one each', { timeout: 60_000 }, async () => {
        const L = PHONE.l;
        const t = metaAgo(20_000);
        const invalid = await events('webhook_payload_invalid');

        expect(await deliver(delivery([change({ contacts: [contactOf(L)], messages: [{ from: L, id: 'wamid.e2e.l1', timestamp: t.ts, type: 'text' }] })]))).toBe(200);
        const rows = await messagesOf(L);
        expect(rows.map((m) => [m.role, m.content, m.metadata, m.wa_message_id, ms(m.wa_timestamp)])).toEqual([
            ['user', PLACEHOLDER, { unprocessable: 'text' }, 'wamid.e2e.l1', t.at.getTime()],
        ]);
        expect(await jobsOf(L)).toEqual([]);
        // A placeholder is not counted against the contact's rate limit.
        expect(await mainRate(L)).toBeNull();
        expect((await chatOf(L))?.unread_count).toBe(1);
        const afterText = await events('webhook_payload_invalid');
        expect(afterText.count).toBe(invalid.count + 1);
        expect(afterText.details).toContain('pesan "text": teks tanpa isi; disimpan sebagai pengganti');
        await settle();
        expect(pushesTo(L).map((p) => p.body)).toEqual([PLACEHOLDER]);

        // A photo without a media id: nothing to download, a placeholder too.
        const photo = { from: L, id: 'wamid.e2e.l2', timestamp: metaAgo(10_000).ts, type: 'image', image: { caption: 'Lihat ini' } };
        expect(await deliver(delivery([change({ contacts: [contactOf(L)], messages: [photo] })]))).toBe(200);
        expect((await messagesOf(L)).map((m) => [m.wa_message_id, m.content, m.metadata])).toContainEqual([
            'wamid.e2e.l2',
            'Pesan jenis "image" tidak bisa diproses otomatis (isinya tidak ditampilkan di Sarathi)',
            { unprocessable: 'image' },
        ]);
        expect((await events('webhook_payload_invalid')).count).toBe(invalid.count + 2);

        // C1-EQ-3: a status that is not an object, a change value that is not one.
        expect(await deliver(delivery([change({ statuses: [42] })]))).toBe(200);
        expect((await events('webhook_payload_invalid')).count).toBe(invalid.count + 3);
        const orgless = await events('webhook_payload_invalid', null);
        expect(await deliver(delivery([{ field: 'messages', value: 'bukan objek' }]))).toBe(200);
        const orglessAfter = await events('webhook_payload_invalid', null);
        expect(orglessAfter.count).toBe(orgless.count + 1);
        expect(orglessAfter.details).toContain('perubahan "messages" tanpa isi terbaca; dilewati');
    });

    it('m. AI off for the chat: the text is stored without a job or a minute unit', { timeout: 60_000 }, async () => {
        const M = PHONE.m;
        await seedChat(M, { ai_enabled: false });
        const units = await inboundUnits();

        expect(await deliver(delivery([change({ contacts: [contactOf(M)], messages: [textMsg(M, 'wamid.e2e.m1', 'Halo admin', metaAgo(20_000).ts)] })]))).toBe(200);
        expect((await messagesOf(M, 'user')).map((m) => m.content)).toEqual(['Halo admin']);
        expect(await jobsOf(M)).toEqual([]);
        expect((await inboundUnits()).used).toBe(units.used);
        expect(await mainRate(M)).toBe(1);
        expect(await chatOf(M)).toMatchObject({ ai_enabled: false, unread_count: 1, last_message: 'Halo admin' });
        await settle();
        expect(pushesTo(M)).toHaveLength(1);
        expect(await messagesOf(M, 'system')).toEqual([]);
    });

    it('n. the org\'s inbound_minute quota (override 1 a minute, already used): stored without a job, with a note and quota_inbound_exceeded', { timeout: 60_000 }, async () => {
        const N = PHONE.n;
        await write(db.from('org_quota_overrides').upsert({ org_id: ORG, inbound_per_minute: 1, note: 'e2e local-db' }, { onConflict: 'org_id' }));
        // The minute's one unit is used: a counter row for every minute around
        // now (a row of the run is kept as it is), so the refusal does not
        // depend on where in the minute the call lands.
        const minute = Math.floor(Date.now() / 60_000) * 60_000;
        await write(
            db.from('org_usage_counters').upsert(
                [-3, -2, -1, 0, 1, 2, 3].map((k) => ({ org_id: ORG, metric: 'inbound_minute', window_start: new Date(minute + k * 60_000).toISOString(), used: 1 })),
                { onConflict: 'org_id,metric,window_start', ignoreDuplicates: true },
            ),
        );
        try {
            const units = await inboundUnits();
            const exceeded = await events('quota_inbound_exceeded');

            expect(await deliver(delivery([change({ contacts: [contactOf(N)], messages: [textMsg(N, 'wamid.e2e.n1', 'Promo masih ada?', metaAgo(20_000).ts)] })]))).toBe(200);
            expect((await messagesOf(N, 'user')).map((m) => m.content)).toEqual(['Promo masih ada?']);
            expect(await jobsOf(N)).toEqual([]);
            expect(await inboundUnits()).toEqual({ used: units.used, refused: units.refused + 1 });
            expect(await mainRate(N)).toBe(1);
            const chat = await chatOf(N);
            expect(chat?.unread_count).toBe(1);

            await settle();
            expect((await messagesOf(N, 'system')).map((m) => m.content)).toEqual([inboundQuotaNotice(1)]);
            const after = await events('quota_inbound_exceeded');
            expect(after.count).toBe(exceeded.count + 1);
            expect(after.details).toContain('batas 1 percakapan AI baru per menit tercapai');
            expect((await chatOf(N))?.last_message_at).toBe(chat?.last_message_at);
            expect(pushesTo(N)).toHaveLength(1);
        } finally {
            await write(db.from('org_quota_overrides').delete().eq('org_id', ORG));
        }
    });

    it.skipIf(!DB_CONTAINER)('o. code ahead of 0072 (wa_ingest_inbound missing, or not executable): 503 and a webhook_error, nothing stored; the resend after the fix is stored once', { timeout: 120_000 }, async () => {
        const cases = [
            {
                // The function does not exist (0072 not applied yet).
                phone: PHONE.o1,
                wamid: 'wamid.e2e.o1',
                expected: 'PGRST202',
                breakIt: `alter function public.wa_ingest_inbound(${INGEST_SIGNATURE}) rename to wa_ingest_inbound_e2e_hidden;`,
                fixIt: `alter function public.wa_ingest_inbound_e2e_hidden(${INGEST_SIGNATURE}) rename to wa_ingest_inbound;`,
            },
            {
                // The function exists without its grant.
                phone: PHONE.o2,
                wamid: 'wamid.e2e.o2',
                expected: '42501',
                breakIt: `revoke execute on function public.wa_ingest_inbound(${INGEST_SIGNATURE}) from service_role;`,
                fixIt: `grant execute on function public.wa_ingest_inbound(${INGEST_SIGNATURE}) to service_role;`,
            },
        ];
        const answers: Probe[] = [];
        for (const { phone, wamid, expected, breakIt, fixIt } of cases) {
            const bytes = bytesOf(delivery([change({ contacts: [contactOf(phone)], messages: [textMsg(phone, wamid, 'Halo, ada orang?', metaAgo(20_000).ts)] })]));
            const units = await inboundUnits();
            const errorsBefore = await events('webhook_error');
            psql(breakIt);
            try {
                // Every answer PostgREST gives until its schema cache has
                // followed the change (kept for the record).
                const answer = await waitForProbe((p) => {
                    if (p.code !== '22004' && !answers.some((a) => a.code === p.code)) answers.push(p);
                    return p.code === expected;
                });
                errorSpy.mockClear();

                expect(await deliver(bytes)).toBe(503);
                expect((await events('webhook_error')).count).toBe(errorsBefore.count + 1);
                const failed = errorSpy.mock.calls.find((c) => c[0].startsWith('Inbound text message not stored'));
                expect(failed?.[1]).toMatchObject({ code: answer.code, status: answer.status });
                expect(await chatOf(phone)).toBeNull();
                expect(await messagesOf(phone)).toEqual([]);
                expect(await mainRate(phone)).toBeNull();
                expect((await inboundUnits()).used).toBe(units.used);
            } finally {
                psql(fixIt);
            }
            await waitForProbe((p) => p.code === '22004');

            expect(await deliver(bytes)).toBe(200);
            expect((await messagesOf(phone)).map((m) => m.wa_message_id)).toEqual([wamid]);
            expect((await jobsOf(phone)).map((j) => j.status)).toEqual(['pending']);
            expect(await mainRate(phone)).toBe(1);
            expect((await inboundUnits()).used).toBe(units.used + 1);
            expect((await events('webhook_error')).count).toBe(errorsBefore.count + 1);
            await settle();
        }
        // For the record: what PostgREST answered while the function was gone / not executable.
        console.info(`PostgREST answers: ${answers.map((a) => `${a.status} ${a.code} (${a.message})`).join(' | ')}`);
        expect(answers.map((a) => [a.status, a.code])).toContainEqual([404, 'PGRST202']);
        expect(answers.map((a) => [a.status, a.code])).toContainEqual([403, '42501']);
    });

    // Beyond the model of contract.test.ts: real concurrency in Postgres.
    it('p. concurrent deliveries: the same message twice at once is stored, queued, counted and pushed once; two messages of a new contact at once make one chat, one burst and one unit', { timeout: 60_000 }, async () => {
        const { p1: P1, p2: P2 } = PHONE;
        const units = await inboundUnits();
        const bytes = bytesOf(delivery([change({ contacts: [contactOf(P1)], messages: [textMsg(P1, 'wamid.e2e.p1', 'Halo, barengan', metaAgo(20_000).ts)] })]));

        expect(await Promise.all([deliver(bytes), deliver(bytes), deliver(bytes)])).toEqual([200, 200, 200]);
        expect((await messagesOf(P1)).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.p1']);
        expect((await jobsOf(P1)).map((j) => j.status)).toEqual(['pending']);
        // The redelivery gate comes before the rate limit: one slot only.
        expect(await mainRate(P1)).toBe(1);
        expect((await chatOf(P1))?.unread_count).toBe(1);
        expect((await inboundUnits()).used).toBe(units.used + 1);
        await settle();
        expect(pushesTo(P1)).toHaveLength(1);

        const first = delivery([change({ contacts: [contactOf(P2)], messages: [textMsg(P2, 'wamid.e2e.p2-1', 'Pesan satu', metaAgo(20_000).ts)] })]);
        const second = delivery([change({ contacts: [contactOf(P2)], messages: [textMsg(P2, 'wamid.e2e.p2-2', 'Pesan dua', metaAgo(19_000).ts)] })]);
        expect(await Promise.all([deliver(first), deliver(second)])).toEqual([200, 200]);
        expect((await messagesOf(P2)).map((m) => m.wa_message_id).sort()).toEqual(['wamid.e2e.p2-1', 'wamid.e2e.p2-2']);
        expect((await jobsOf(P2)).map((j) => j.status)).toEqual(['pending', 'pending']);
        expect((await inboundUnits()).used).toBe(units.used + 2);
        expect(await chatOf(P2)).toMatchObject({ unread_count: 2, last_message: 'Pesan dua' });
        expect(await mainRate(P2)).toBe(2);
        await settle();
        expect(pushesTo(P2)).toHaveLength(2);

        if (!DB_CONTAINER) return;
        // Deterministic: the first call holds its transaction open for a
        // second (a sleep in its queue insert), so the other deliveries'
        // pre-dedup cannot see the row and all three reach the database
        // function: the advisory lock makes them wait, its redelivery gate
        // answers 'duplicate'.
        const P3 = PHONE.p3;
        const slow = bytesOf(delivery([change({ contacts: [contactOf(P3)], messages: [textMsg(P3, 'wamid.e2e.p3', 'Halo, pelan', metaAgo(20_000).ts)] })]));
        psql(`
            drop schema if exists e2e_local cascade;
            create schema e2e_local;
            create function e2e_local.slow_once() returns trigger
            language plpgsql set search_path = '' as $$
            begin
                perform pg_sleep(1);
                return new;
            end;
            $$;
            create trigger e2e_slow_once before insert on public.message_queue
                for each row when (new.org_id = '${ORG}'::uuid and new.wa_message_id = 'wamid.e2e.p3')
                execute function e2e_local.slow_once();
        `);
        const rpcSpy = vi.spyOn(SupabaseClient.prototype, 'rpc');
        try {
            await waitForProbe((p) => p.code === '22004');
            rpcSpy.mockClear();
            expect(await Promise.all([deliver(slow), deliver(slow), deliver(slow)])).toEqual([200, 200, 200]);
            expect(rpcSpy.mock.calls.filter((c) => c[0] === 'wa_ingest_inbound')).toHaveLength(3);
        } finally {
            rpcSpy.mockRestore();
            psql('drop trigger if exists e2e_slow_once on public.message_queue; drop schema if exists e2e_local cascade;');
        }
        expect((await messagesOf(P3)).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.p3']);
        expect((await jobsOf(P3)).map((j) => j.status)).toEqual(['pending']);
        expect(await mainRate(P3)).toBe(1);
        expect((await chatOf(P3))?.unread_count).toBe(1);
        expect((await inboundUnits()).used).toBe(units.used + 3);
        await settle();
        expect(pushesTo(P3)).toHaveLength(1);
    });

    it.skipIf(!DB_CONTAINER)('q. a call that always fails: three failures defer the rest of the batch (stop rule); the 5th failure of one message stores a placeholder', { timeout: 60_000 }, async () => {
        const { q1: Q1, q2: Q2, q3: Q3, q4: Q4, q5: Q5 } = PHONE;
        const errorsBefore = await events('webhook_error');
        const invalidBefore = await events('webhook_payload_invalid');
        psql(`
            drop trigger if exists e2e_fail_always on public.message_queue;
            drop schema if exists e2e_local cascade;
            create schema e2e_local;
            create function e2e_local.fail_always() returns trigger
            language plpgsql set search_path = '' as $$
            begin
                -- An error of the item's own call (it counts toward the poison
                -- bound; a slow or contended database, e.g. 40001, would not).
                raise exception 'e2e: gagal terus' using errcode = '23503';
            end;
            $$;
            create trigger e2e_fail_always before insert on public.message_queue
                for each row when (new.org_id = '${ORG}'::uuid and new.wa_message_id like 'wamid.e2e.q%')
                execute function e2e_local.fail_always();
        `);
        try {
            await waitForProbe((p) => p.code === '22004');
            const base = Date.now() - 60_000;
            const four = delivery([
                change({
                    contacts: [contactOf(Q1), contactOf(Q2), contactOf(Q3), contactOf(Q4)],
                    messages: [Q1, Q2, Q3, Q4].map((q, i) => textMsg(q, `wamid.e2e.q-${i + 1}`, `Pesan ${i + 1}`, metaAt(base + i * 1000).ts)),
                }),
            ]);
            expect(await deliver(four)).toBe(503);
            expect(batchLines()).toEqual([expect.stringMatching(/ retryable=3 deferred=1 \(stop_rule\) /)]);
            const errors = await events('webhook_error');
            expect(errors.count).toBe(errorsBefore.count + 1);
            for (const q of [Q1, Q2, Q3, Q4]) {
                expect(await chatOf(q)).toBeNull();
                expect(await mainRate(q)).toBeNull();
            }

            const one = bytesOf(delivery([change({ contacts: [contactOf(Q5)], messages: [textMsg(Q5, 'wamid.e2e.q-5', 'Tolong dibalas', metaAgo(20_000).ts)] })]));
            for (let attempt = 1; attempt <= 4; attempt++) expect(await deliver(one)).toBe(503);
            expect(await chatOf(Q5)).toBeNull();
            expect(await deliver(one)).toBe(200);
            const rows = await messagesOf(Q5);
            expect(rows.map((m) => [m.content, m.metadata, m.wa_message_id])).toEqual([[PLACEHOLDER, { unprocessable: 'text' }, 'wamid.e2e.q-5']]);
            expect(await jobsOf(Q5)).toEqual([]);
            expect(await mainRate(Q5)).toBeNull();
            const invalid = await events('webhook_payload_invalid');
            expect(invalid.count).toBe(invalidBefore.count + 1);
            expect((await events('webhook_error')).count).toBe(errorsBefore.count + 5);
            await settle();
            expect(pushesTo(Q5).map((p) => p.body)).toEqual([PLACEHOLDER]);
        } finally {
            psql('drop trigger if exists e2e_fail_always on public.message_queue; drop schema if exists e2e_local cascade;');
        }
    });

    it('r. the AI history read through PostgREST keeps the conversation and leaves out a placeholder and a message to another number', { timeout: 60_000 }, async () => {
        const R = PHONE.r;
        expect(await deliver(delivery([change({ contacts: [contactOf(R)], messages: [textMsg(R, 'wamid.e2e.r1', 'Halo, saya Budi', metaAgo(50_000).ts)] })]))).toBe(200);
        await drainUntilAnswered(R);
        // In the same chat: a placeholder, then a message to another number of the WABA.
        expect(await deliver(delivery([change({ contacts: [contactOf(R)], messages: [{ from: R, id: 'wamid.e2e.r2', timestamp: metaAgo(40_000).ts, type: 'text' }] })]))).toBe(200);
        vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', 'process');
        try {
            const toOther = change({ contacts: [contactOf(R)], messages: [textMsg(R, 'wamid.e2e.r3', 'Ini ke nomor lain', metaAgo(35_000).ts)] }, OTHER_PNID, OTHER_DISPLAY);
            expect(await deliver(delivery([toOther]))).toBe(200);
        } finally {
            vi.stubEnv('WHATSAPP_OTHER_NUMBER_EVENTS', '');
        }
        expect(await deliver(delivery([change({ contacts: [contactOf(R)], messages: [textMsg(R, 'wamid.e2e.r4', 'Jadi harganya berapa?', metaAgo(30_000).ts)] })]))).toBe(200);
        expect((await messagesOf(R, 'user')).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.r1', 'wamid.e2e.r2', 'wamid.e2e.r3', 'wamid.e2e.r4']);

        vi.mocked(generateRAGResponse).mockClear();
        await drainUntilAnswered(R);
        expect(vi.mocked(generateRAGResponse).mock.calls.filter((c) => c[2] === R)).toEqual([
            [
                'Jadi harganya berapa?',
                [
                    { role: 'user', content: 'Halo, saya Budi' },
                    { role: 'assistant', content: AI_REPLY },
                ],
                R,
                { orgId: ORG },
            ],
        ]);
        await settle();
    });

    it('s. a status that arrives before the row of its reply is applied 15 s later in the background', { timeout: 60_000 }, async () => {
        const S = PHONE.s;
        await seedChat(S);
        const t = metaAgo(5_000);
        expect(await deliver(delivery([change({ statuses: [statusOf('wamid.e2e.s-out', 'delivered', t.ts, S)] })]))).toBe(200);
        expect(batchLines()).toEqual([expect.stringMatching(/statuses applied=0 stale=0 unknown=1 /)]);
        // The queue stores its reply after Meta accepted it.
        await seedReply(S, 'wamid.e2e.s-out', 'sent');
        await sleep(16_000);
        await settle();
        const [row] = await messagesOf(S, 'assistant');
        expect(row.status).toBe('delivered');
        expect(ms(row.status_updated_at)).toBe(t.at.getTime());
        expect(infoSpy.mock.calls.map((c) => c[0])).toContainEqual(
            expect.stringMatching(/^Statuses re-applied: 1 sent again, 1 applied, 0 still without a message row/),
        );
    });

    it.skipIf(!DB_CONTAINER)('t. the default org cannot be read: 503 and a webhook_error without an org, nothing stored; without an access token a message is stored and webhook_unconfigured says so', { timeout: 60_000 }, async () => {
        const { t1: T1, t2: T2 } = PHONE;
        const bytes = bytesOf(delivery([change({ contacts: [contactOf(T1)], messages: [textMsg(T1, 'wamid.e2e.t1', 'Halo?', metaAgo(20_000).ts)] })]));
        const orgless = await events('webhook_error', null);
        psql('revoke select on table public.platform_settings from service_role;');
        try {
            expect(await deliver(bytes)).toBe(503);
            const after = await events('webhook_error', null);
            expect(after.count).toBe(orgless.count + 1);
            expect(after.details).toContain('database 42501 — org default tidak terbaca, periksa Supabase (1 dari 1 item)');
            expect(await chatOf(T1)).toBeNull();
            expect(await mainRate(T1)).toBeNull();
        } finally {
            psql('grant select on table public.platform_settings to service_role;');
        }
        expect(await deliver(bytes)).toBe(200);
        expect((await messagesOf(T1)).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.t1']);

        vi.stubEnv('WHATSAPP_ACCESS_TOKEN', '');
        try {
            const unconfigured = await events('webhook_unconfigured');
            expect(await deliver(delivery([change({ contacts: [contactOf(T2)], messages: [textMsg(T2, 'wamid.e2e.t2', 'Halo lagi', metaAgo(20_000).ts)] })]))).toBe(200);
            expect((await messagesOf(T2)).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.t2']);
            expect((await jobsOf(T2)).map((j) => j.status)).toEqual(['pending']);
            const after = await events('webhook_unconfigured');
            expect(after.count).toBe(unconfigured.count + 1);
            expect(after.details).toContain(
                'WHATSAPP_ACCESS_TOKEN tidak diset di server: pesan masuk tetap disimpan, tetapi balasan AI dan peringatan tidak terkirim',
            );
        } finally {
            vi.stubEnv('WHATSAPP_ACCESS_TOKEN', TOKEN);
        }
        await settle();
    });

    it.skipIf(!DB_CONTAINER)('u. the 8 s budget runs out during a call: 503 and webhook_deferred, nothing failed; Meta\'s resend stores nothing twice', { timeout: 60_000 }, async () => {
        const { u1: U1, u2: U2 } = PHONE;
        // Each call of this delivery takes 5 s, so the budget ends during the
        // second one (well inside the 8 s statement timeout of PostgREST).
        psql(`
            drop schema if exists e2e_local cascade;
            create schema e2e_local;
            create function e2e_local.slow() returns trigger
            language plpgsql set search_path = '' as $$
            begin
                perform pg_sleep(5);
                return new;
            end;
            $$;
            create trigger e2e_slow before insert on public.message_queue
                for each row when (new.org_id = '${ORG}'::uuid and new.wa_message_id like 'wamid.e2e.u%')
                execute function e2e_local.slow();
        `);
        try {
            await waitForProbe((p) => p.code === '22004');
            const deferredBefore = await events('webhook_deferred');
            const base = Date.now() - 30_000;
            const bytes = bytesOf(
                delivery([
                    change({
                        contacts: [contactOf(U1), contactOf(U2)],
                        messages: [textMsg(U1, 'wamid.e2e.u1', 'Pesan satu', metaAt(base).ts), textMsg(U2, 'wamid.e2e.u2', 'Pesan dua', metaAt(base + 1000).ts)],
                    }),
                ]),
            );
            const started = Date.now();
            expect(await deliver(bytes)).toBe(503);
            // Answered when the budget ran out, not when the call ended.
            expect(Date.now() - started).toBeLessThan(9_500);
            expect(batchLines()).toEqual([expect.stringMatching(/ new=1 .*retryable=0 deferred=1 /)]);
            const deferred = await events('webhook_deferred');
            expect(deferred.count).toBe(deferredBefore.count + 1);
            expect(deferred.details).toContain('1 dari 2 item ditunda: batas waktu 8 detik habis; webhook menjawab 503, Meta mengirim ulang');
            expect((await messagesOf(U1)).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.u1']);

            // The abandoned call is not cancelled: it ends in the database.
            await sleep(3_500);
            await settle();
            const abandoned = (await messagesOf(U2)).length;
            const pushedBefore = pushesTo(U2).length;

            // Meta resends the batch: nothing is stored twice.
            expect(await deliver(bytes)).toBe(200);
            await settle();
            expect((await messagesOf(U1)).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.u1']);
            expect((await messagesOf(U2)).map((m) => m.wa_message_id)).toEqual(['wamid.e2e.u2']);
            expect((await jobsOf(U2)).map((j) => j.status)).toEqual(['pending']);
            expect(pushesTo(U1)).toHaveLength(1);
            console.info(
                `u: the abandoned call ${abandoned === 1 ? 'committed after the 503' : 'was rolled back'}; ` +
                    `pushes for its message: ${pushedBefore} before the resend, ${pushesTo(U2).length} after it`,
            );
        } finally {
            psql('drop trigger if exists e2e_slow on public.message_queue; drop schema if exists e2e_local cascade;');
        }
    });
});
