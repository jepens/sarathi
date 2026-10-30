import crypto from 'node:crypto';
import { vi } from 'vitest';
import { INGEST_PARAMS, STATUSES_PARAMS } from '@/lib/whatsapp/webhook/ingest';

// A small stateful model of the database the webhook talks to, for the
// contract harness and the part-1 pin matrix (Fase 2 task 2.2a part 2). It
// keeps the tables the pipeline, the history notes and processQueue touch,
// and answers wa_ingest_inbound, wa_apply_statuses, claim_queue_jobs and
// consume_org_quota the way C2_SPEC sections 3 and 4 say migration 0072 does
// (what the SQL really does is pinned by pgTAP 220; the parity test pins the
// names). Writes of one call commit together or not at all, and every call
// settles only after a macrotask (setImmediate), so "committed before the
// answer" is observable: work the pipeline forgot to await is not in the
// model yet when POST returns. Failures are injected per call target.
// Fake ids, phones and texts only.

export const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';
export const PNID = '100000000000001'; // the env number
export const OTHER_PNID = '100000000000002'; // another number of the WABA
export const SECRET = 'rahasia-aplikasi-palsu';

export interface ChatRow {
    org_id: string;
    phone_number: string;
    bsuid: string | null;
    verified_phone: string | null;
    contact_name: string | null;
    ai_enabled: boolean;
    last_message: string | null;
    last_message_at: string | null;
    last_inbound_at: string | null;
    unread_count: number;
    updated_at: string | null;
}

export interface MessageRow {
    id: string;
    org_id: string;
    phone_number: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    wa_message_id: string | null;
    reply_to_wamid: string | null;
    media_type: string | null;
    media_url: string | null;
    media_mime: string | null;
    media_filename: string | null;
    metadata: Record<string, unknown> | null;
    wa_timestamp: string | null;
    status: string | null;
    status_updated_at: string | null;
    error_code: number | null;
    error_title: string | null;
    error_detail: string | null;
    created_at: string;
    seq: number;
}

export interface QueueRow {
    id: string;
    org_id: string;
    phone_number: string;
    message_text: string;
    wa_message_id: string | null;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    retries: number;
    max_retries: number;
    error_message: string | null;
    ai_quota_counted: boolean;
    created_at: string;
    updated_at: string;
    processed_at: string | null;
    seq: number;
}

export interface OpsEvent {
    kind: string;
    org: string | null;
    detail: string;
    count: number;
}

/** A failure the next matching call(s) answer with. */
export interface Failure {
    /** 'rpc:<name>' or '<table>.<op>' (select, insert, update, upsert, delete). */
    target: string;
    /** Gets the RPC's arguments, or { payload, filters } of a table call. */
    match?: (args: Record<string, unknown>) => boolean;
    /** Answered as PostgREST does: { data: null, error, status }. */
    error?: { code: string; message?: string };
    status?: number;
    /** Rejected instead (a bug, or a client library throwing). */
    throws?: unknown;
    /** How many calls it fails (default 1). */
    times?: number;
}

interface Filter {
    kind: 'eq' | 'neq' | 'is' | 'in' | 'like' | 'gte' | 'lte' | 'gt' | 'lt';
    column: string;
    value: unknown;
}

export interface Result {
    data: unknown;
    error: { code: string; message?: string; details?: string; hint?: string } | null;
    status: number;
}

type Row = Record<string, unknown>;

const iso = (ms: number) => new Date(ms).toISOString();

function isObject(value: unknown): value is Row {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether Postgres would refuse a value: U+0000 or a lone surrogate in any string or key (class 22). */
function refusedByPostgres(value: unknown, depth = 0): boolean {
    if (typeof value === 'string') return value.includes('\u0000') || LONE_SURROGATE.test(value);
    if (value === null || typeof value !== 'object' || depth > 64) return false;
    if (Array.isArray(value)) return value.some((v) => refusedByPostgres(v, depth + 1));
    return Object.entries(value).some(([k, v]) => refusedByPostgres(k, depth + 1) || refusedByPostgres(v, depth + 1));
}

/** The row's value of a column, or of a `metadata->>key` path (as text). */
function columnValue(row: Row, column: string): unknown {
    const path = /^(\w+)->>(\w+)$/.exec(column);
    if (path) {
        const json = row[path[1]];
        const v = isObject(json) ? json[path[2]] : undefined;
        return v === undefined || v === null ? null : String(v);
    }
    return row[column];
}

function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
        const v = columnValue(row, f.column);
        switch (f.kind) {
            case 'eq':
                return v === f.value;
            case 'neq':
                return v !== f.value;
            case 'is':
                return f.value === null ? v === null || v === undefined : v === f.value;
            case 'in':
                return Array.isArray(f.value) && f.value.includes(v);
            case 'like': {
                const pattern = String(f.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
                return typeof v === 'string' && new RegExp(`^${pattern}$`).test(v);
            }
            case 'gte':
                return String(v) >= String(f.value);
            case 'lte':
                return String(v) <= String(f.value);
            case 'gt':
                return String(v) > String(f.value);
            case 'lt':
                return String(v) < String(f.value);
        }
    });
}

class Query implements PromiseLike<Result> {
    op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    payload: unknown;
    options: Row = {};
    filters: Filter[] = [];
    returning = false;
    singleMode: 'one' | 'maybe' | null = null;
    limitN: number | null = null;
    orderBy: { column: string; ascending: boolean } | null = null;
    signal: AbortSignal | null = null;

    constructor(
        private readonly model: WaModel,
        readonly table: string,
    ) {}

    /** The column list is not modelled: whole rows come back. */
    select(): this {
        if (this.op !== 'select') this.returning = true;
        return this;
    }
    insert(payload: unknown): this {
        this.op = 'insert';
        this.payload = payload;
        return this;
    }
    update(payload: unknown): this {
        this.op = 'update';
        this.payload = payload;
        return this;
    }
    upsert(payload: unknown, options?: Row): this {
        this.op = 'upsert';
        this.payload = payload;
        this.options = options ?? {};
        return this;
    }
    delete(): this {
        this.op = 'delete';
        return this;
    }
    private filter(kind: Filter['kind'], column: string, value: unknown): this {
        this.filters.push({ kind, column, value });
        return this;
    }
    eq(c: string, v: unknown) {
        return this.filter('eq', c, v);
    }
    neq(c: string, v: unknown) {
        return this.filter('neq', c, v);
    }
    is(c: string, v: unknown) {
        return this.filter('is', c, v);
    }
    in(c: string, v: unknown) {
        return this.filter('in', c, v);
    }
    like(c: string, v: unknown) {
        return this.filter('like', c, v);
    }
    gte(c: string, v: unknown) {
        return this.filter('gte', c, v);
    }
    lte(c: string, v: unknown) {
        return this.filter('lte', c, v);
    }
    gt(c: string, v: unknown) {
        return this.filter('gt', c, v);
    }
    lt(c: string, v: unknown) {
        return this.filter('lt', c, v);
    }
    order(column: string, opts?: { ascending?: boolean }): this {
        this.orderBy = { column, ascending: opts?.ascending !== false };
        return this;
    }
    limit(n: number): this {
        this.limitN = n;
        return this;
    }
    maybeSingle(): this {
        this.singleMode = 'maybe';
        return this;
    }
    single(): this {
        this.singleMode = 'one';
        return this;
    }
    abortSignal(signal: AbortSignal): this {
        this.signal = signal;
        return this;
    }
    then<A = Result, B = never>(
        onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): Promise<A | B> {
        return this.model.runQuery(this).then(onFulfilled, onRejected);
    }
}

class RpcCall implements PromiseLike<Result> {
    signal: AbortSignal | null = null;

    constructor(
        private readonly model: WaModel,
        readonly name: string,
        readonly args: Row,
    ) {}

    abortSignal(signal: AbortSignal): this {
        this.signal = signal;
        return this;
    }
    then<A = Result, B = never>(
        onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): Promise<A | B> {
        return this.model.runRpc(this).then(onFulfilled, onRejected);
    }
}

const RANK: Record<string, number> = { read: 4, delivered: 3, failed: 2, sent: 1 };

export class WaModel {
    chats: ChatRow[] = [];
    messages: MessageRow[] = [];
    queue: QueueRow[] = [];
    /** rate_limits: identifier -> count and window start (ms). */
    rateLimits = new Map<string, { count: number; windowStart: number }>();
    /** org_usage_counters: '<org>|<metric>|<window>' -> counts. */
    quota = new Map<string, { used: number; refused: number }>();
    opsEvents: OpsEvent[] = [];
    /** Every call as it reached the model: 'rpc:<name>' or '<table>.<op>', with its arguments. */
    calls: Array<{ target: string; args?: Row; filters?: Filter[]; payload?: unknown }> = [];
    /** What was committed, in commit order. */
    commits: string[] = [];
    uploads: Array<{ bucket: string; path: string; options: unknown }> = [];
    failures: Failure[] = [];
    /** Fake milliseconds each wa_ingest_inbound call takes (moves the faked clock). */
    ingestMs = 0;
    /** Fake milliseconds a call takes before it reaches the database (moves the faked clock). */
    clockStep: ((target: string) => number) | null = null;
    /**
     * Calls that wait until their abort signal fires or release() is called
     * (args as Failure.match): a database that hangs.
     */
    hang: ((target: string, args: Row) => boolean) | null = null;
    private held: Array<() => void> = [];
    /** wa_ingest_inbound's rate-limit sub-block fails with this SQLSTATE (fail-open). */
    rateError: string | null = null;
    /** wa_ingest_inbound's quota sub-block fails with this SQLSTATE (fail-open). */
    quotaError: string | null = null;
    /** The minute quota of the model's orgs (consume_org_quota's limit when given). */
    quotaLimit: Record<string, number> = {};
    private seq = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly client: any;

    constructor() {
        this.client = {
            from: (table: string) => new Query(this, table),
            rpc: (name: string, args: Row) => new RpcCall(this, name, args ?? {}),
            storage: {
                from: (bucket: string) => ({
                    upload: async (path: string, _bytes: unknown, options: unknown) => {
                        await macrotask();
                        this.uploads.push({ bucket, path, options });
                        return { data: { path }, error: null };
                    },
                    remove: async () => {
                        await macrotask();
                        return { data: [], error: null };
                    },
                }),
            },
        };
    }

    // ---- set-up and inspection ---------------------------------------------

    fail(failure: Failure): void {
        this.failures.push({ times: 1, ...failure });
    }

    seedChat(chat: Partial<ChatRow> & { phone_number: string }): ChatRow {
        const row: ChatRow = {
            org_id: ORG,
            bsuid: null,
            verified_phone: null,
            contact_name: null,
            ai_enabled: true,
            last_message: null,
            last_message_at: null,
            last_inbound_at: null,
            unread_count: 0,
            updated_at: null,
            ...chat,
        };
        this.chats.push(row);
        return row;
    }

    /** One of our sent messages (the queue stores it after Meta accepted it). */
    seedAssistant(wamid: string, phone: string, status: string | null = 'sent', org = ORG): MessageRow {
        return this.insertMessage({ org_id: org, phone_number: phone, role: 'assistant', content: 'Balasan palsu', wa_message_id: wamid, status });
    }

    chat(phone: string, org = ORG): ChatRow | undefined {
        return this.chats.find((c) => c.org_id === org && c.phone_number === phone);
    }

    userRows(org = ORG): MessageRow[] {
        return this.messages.filter((m) => m.org_id === org && m.role === 'user');
    }

    notes(org = ORG): MessageRow[] {
        return this.messages.filter((m) => m.org_id === org && m.role === 'system');
    }

    rpcCalls(name: string): Row[] {
        return this.calls.filter((c) => c.target === `rpc:${name}`).map((c) => c.args ?? {});
    }

    /** wa_ingest_inbound's arguments, in call order. */
    ingests(): Row[] {
        return this.rpcCalls('wa_ingest_inbound');
    }

    /** The batch pre-dedup queries (an org-scoped select of whatsapp_messages by wa_message_id in (...)). */
    prededups(): Filter[][] {
        return this.calls
            .filter((c) => c.target === 'whatsapp_messages.select' && (c.filters ?? []).some((f) => f.kind === 'in' && f.column === 'wa_message_id'))
            .map((c) => c.filters ?? []);
    }

    events(kind?: string): OpsEvent[] {
        return kind ? this.opsEvents.filter((e) => e.kind === kind) : this.opsEvents;
    }

    // ---- execution ---------------------------------------------------------

    private takeFailure(target: string, args: Row): Failure | null {
        const i = this.failures.findIndex((f) => f.target === target && (!f.match || f.match(args)));
        if (i < 0) return null;
        const f = this.failures[i];
        f.times = (f.times ?? 1) - 1;
        if (f.times <= 0) this.failures.splice(i, 1);
        return f;
    }

    /** Lets every held call go on (and holds no more). */
    release(): void {
        this.hang = null;
        for (const resume of this.held.splice(0)) resume();
    }

    /** The shared path of every call: a macrotask, the abort signal, an injected failure, then the work. */
    private async settle(target: string, args: Row, signal: AbortSignal | null, work: () => Result): Promise<Result> {
        const step = this.clockStep?.(target) ?? 0;
        if (step > 0) vi.setSystemTime(Date.now() + step);
        if (this.hang?.(target, args)) {
            await new Promise<void>((resolve) => {
                this.held.push(resolve);
                if (signal?.aborted) resolve();
                else signal?.addEventListener('abort', () => resolve(), { once: true });
            });
        }
        await macrotask();
        if (signal?.aborted) {
            // postgrest-js turns a fetch abort into an error without a code.
            return { data: null, error: { code: '', message: 'AbortError: This operation was aborted' }, status: 0 };
        }
        const failure = this.takeFailure(target, args);
        if (failure?.throws !== undefined) throw failure.throws;
        if (failure) return { data: null, error: failure.error ?? { code: 'XX000' }, status: failure.status ?? 500 };
        return work();
    }

    async runRpc(call: RpcCall): Promise<Result> {
        const target = `rpc:${call.name}`;
        this.calls.push({ target, args: call.args });
        return this.settle(target, call.args, call.signal, () => {
            switch (call.name) {
                case 'wa_ingest_inbound':
                    return this.ingest(call.args);
                case 'wa_apply_statuses':
                    return this.applyStatuses(call.args);
                case 'claim_queue_jobs':
                    return this.claimJobs(call.args);
                case 'consume_org_quota':
                    return this.consumeQuotaRpc(call.args);
                case 'record_ops_event':
                    this.opsEvents.push({
                        kind: String(call.args.p_kind),
                        org: (call.args.p_org as string | null) ?? null,
                        detail: String(call.args.p_detail),
                        count: Number(call.args.p_count),
                    });
                    return ok(null);
                case 'bump_unread': {
                    const chat = this.chat(String(call.args.p_phone), String(call.args.p_org));
                    if (chat) chat.unread_count += 1;
                    this.commits.push(`bump_unread:${call.args.p_phone}`);
                    return ok(null);
                }
                default:
                    return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 };
            }
        });
    }

    async runQuery(q: Query): Promise<Result> {
        const target = `${q.table}.${q.op}`;
        this.calls.push({ target, filters: [...q.filters], payload: q.payload });
        return this.settle(target, { payload: q.payload, filters: q.filters }, q.signal, () => this.execute(q));
    }

    private tableRows(table: string): Row[] | null {
        if (table === 'whatsapp_chats') return this.chats as unknown as Row[];
        if (table === 'whatsapp_messages') return this.messages as unknown as Row[];
        if (table === 'message_queue') return this.queue as unknown as Row[];
        if (table === 'ops_events') {
            return this.opsEvents.map((e) => ({ id: 1, kind: e.kind, detail: e.detail, minute: iso(Date.now()) }));
        }
        return null;
    }

    private execute(q: Query): Result {
        const rows = this.tableRows(q.table);
        if (rows === null) return ok(null);
        switch (q.op) {
            case 'select': {
                let found = rows.filter((r) => matches(r, q.filters));
                if (q.orderBy) {
                    const { column, ascending } = q.orderBy;
                    found = [...found].sort((a, b) => {
                        const c = String(a[column]).localeCompare(String(b[column])) || Number(a.seq) - Number(b.seq);
                        return ascending ? c : -c;
                    });
                }
                if (q.limitN !== null) found = found.slice(0, q.limitN);
                return this.shape(q, found.map((r) => ({ ...r })));
            }
            case 'insert': {
                const list = Array.isArray(q.payload) ? q.payload : [q.payload];
                const inserted: Row[] = [];
                for (const p of list) {
                    const conflict = this.insertConflict(q.table, p as Row);
                    if (conflict) return conflict;
                }
                for (const p of list) inserted.push(this.insertRow(q.table, p as Row));
                return this.shape(q, inserted.map((r) => ({ ...r })));
            }
            case 'update': {
                const patch = (q.payload ?? {}) as Row;
                const targets = rows.filter((r) => matches(r, q.filters));
                if (q.table === 'whatsapp_chats' && typeof patch.bsuid === 'string') {
                    const holder = this.chats.find((c) => c.bsuid === patch.bsuid && !targets.includes(c as unknown as Row) && targets.some((t) => t.org_id === c.org_id));
                    if (holder) return unique();
                }
                for (const r of targets) Object.assign(r, patch);
                this.commits.push(`${q.table}.update:${targets.length}`);
                return this.shape(q, targets.map((r) => ({ ...r })));
            }
            case 'upsert': {
                const p = (q.payload ?? {}) as Row;
                if (q.table !== 'whatsapp_chats') return ok(null);
                const existing = this.chat(String(p.phone_number), String(p.org_id));
                if (existing) {
                    if (q.options.ignoreDuplicates) return this.shape(q, []);
                    if (typeof p.bsuid === 'string' && this.chats.some((c) => c !== existing && c.org_id === existing.org_id && c.bsuid === p.bsuid)) {
                        return unique();
                    }
                    Object.assign(existing, p);
                    this.commits.push(`whatsapp_chats.upsert:${p.phone_number}`);
                    return this.shape(q, [{ ...existing }]);
                }
                const conflict = this.insertConflict('whatsapp_chats', p);
                if (conflict) return conflict;
                const row = this.insertRow('whatsapp_chats', p);
                return this.shape(q, [{ ...row }]);
            }
            case 'delete': {
                const keep = rows.filter((r) => !matches(r, q.filters));
                rows.splice(0, rows.length, ...keep);
                return ok(null);
            }
        }
    }

    /** The answer of a query: rows, one row (maybeSingle/single) or nothing (a write without select()). */
    private shape(q: Query, rows: Row[]): Result {
        if (q.op !== 'select' && !q.returning) return ok(null);
        if (q.singleMode !== null) {
            if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' }, status: 406 };
            if (rows.length === 0 && q.singleMode === 'one') return { data: null, error: { code: 'PGRST116', message: 'no rows' }, status: 406 };
            return ok(rows[0] ?? null);
        }
        return ok(rows);
    }

    private insertConflict(table: string, p: Row): Result | null {
        if (table === 'whatsapp_messages' && typeof p.wa_message_id === 'string') {
            const dup = this.messages.some((m) => m.org_id === p.org_id && m.wa_message_id === p.wa_message_id && m.role === p.role);
            if (dup) return unique();
        }
        if (table === 'whatsapp_chats') {
            if (this.chat(String(p.phone_number), String(p.org_id))) return unique();
            if (typeof p.bsuid === 'string' && this.chats.some((c) => c.org_id === p.org_id && c.bsuid === p.bsuid)) return unique();
        }
        if (table === 'message_queue' && typeof p.wa_message_id === 'string') {
            if (this.queue.some((j) => j.org_id === p.org_id && j.wa_message_id === p.wa_message_id)) return unique();
        }
        return null;
    }

    private insertRow(table: string, p: Row): Row {
        if (table === 'whatsapp_messages') return this.insertMessage(p) as unknown as Row;
        if (table === 'whatsapp_chats') {
            const row = this.seedChat({ ...(p as Partial<ChatRow>), phone_number: String(p.phone_number) });
            this.commits.push(`whatsapp_chats.insert:${row.phone_number}`);
            return row as unknown as Row;
        }
        if (table === 'message_queue') return this.insertJob(p) as unknown as Row;
        return p;
    }

    private nextId(): { id: string; seq: number } {
        this.seq += 1;
        return { id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`, seq: this.seq };
    }

    insertMessage(p: Row): MessageRow {
        const { id, seq } = this.nextId();
        const row: MessageRow = {
            id,
            org_id: String(p.org_id),
            phone_number: String(p.phone_number),
            role: p.role as MessageRow['role'],
            content: String(p.content ?? ''),
            wa_message_id: (p.wa_message_id as string | null | undefined) ?? null,
            reply_to_wamid: (p.reply_to_wamid as string | null | undefined) ?? null,
            media_type: (p.media_type as string | null | undefined) ?? null,
            media_url: (p.media_url as string | null | undefined) ?? null,
            media_mime: (p.media_mime as string | null | undefined) ?? null,
            media_filename: (p.media_filename as string | null | undefined) ?? null,
            metadata: (p.metadata as Record<string, unknown> | undefined) ?? {},
            wa_timestamp: (p.wa_timestamp as string | null | undefined) ?? null,
            status: (p.status as string | null | undefined) ?? null,
            status_updated_at: (p.status_updated_at as string | null | undefined) ?? null,
            error_code: null,
            error_title: null,
            error_detail: null,
            created_at: iso(Date.now()),
            seq,
        };
        this.messages.push(row);
        this.commits.push(`message:${row.role}:${row.wa_message_id ?? '-'}`);
        return row;
    }

    private insertJob(p: Row): QueueRow {
        const { id, seq } = this.nextId();
        const now = iso(Date.now());
        const row: QueueRow = {
            id,
            org_id: String(p.org_id),
            phone_number: String(p.phone_number),
            message_text: String(p.message_text),
            wa_message_id: (p.wa_message_id as string | null | undefined) ?? null,
            status: 'pending',
            retries: 0,
            max_retries: 3,
            error_message: null,
            ai_quota_counted: false,
            created_at: now,
            updated_at: now,
            processed_at: null,
            seq,
        };
        this.queue.push(row);
        this.commits.push(`job:${row.wa_message_id ?? '-'}`);
        return row;
    }

    // ---- the functions -------------------------------------------------------

    private consumeQuota(org: string, metric: string, limit: number): { allowed: boolean; used: number; refused: number; quota: number; first_refusal: boolean } {
        const now = Date.now();
        const window = metric === 'inbound_minute' ? Math.floor(now / 60_000) : Math.floor(now / 86_400_000);
        const key = `${org}|${metric}|${window}`;
        const c = this.quota.get(key) ?? { used: 0, refused: 0 };
        this.quota.set(key, c);
        const quota = this.quotaLimit[metric] ?? limit;
        if (c.used < quota) {
            c.used += 1;
            return { allowed: true, used: c.used, refused: c.refused, quota, first_refusal: false };
        }
        c.refused += 1;
        return { allowed: false, used: c.used, refused: c.refused, quota, first_refusal: c.refused === 1 };
    }

    private consumeQuotaRpc(a: Row): Result {
        const d = this.consumeQuota(String(a.p_org), String(a.p_metric), Number(a.p_default_limit));
        return ok([d]);
    }

    /** wa_ingest_inbound per C2_SPEC section 3, one transaction. */
    private ingest(a: Row): Result {
        const names = Object.keys(a).sort().join(',');
        if (names !== [...INGEST_PARAMS].sort().join(',')) {
            return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 };
        }
        if (refusedByPostgres(a)) return pgError('22P05');
        if (this.ingestMs > 0) vi.setSystemTime(Date.now() + this.ingestMs);
        // 0. Validation.
        for (const k of ['p_org', 'p_wamid', 'p_content', 'p_preview', 'p_metadata', 'p_unread', 'p_ai_eligible']) {
            if (a[k] === null || a[k] === undefined) return pgError('22004');
        }
        if (a.p_ai_eligible === true && a.p_queue_text === null) return pgError('22004');
        if (!isObject(a.p_metadata)) return pgError('22023');
        if (![null, 'main', 'other'].includes(a.p_rate_scope as string | null)) return pgError('22023');
        if (a.p_rate_scope !== null && typeof a.p_rate_max === 'number' && a.p_rate_max < 1) return pgError('22023');
        if (a.p_ai_eligible === true && (typeof a.p_inbound_limit !== 'number' || a.p_inbound_limit < 1)) return pgError('22023');
        if (![null, 'media', 'flow'].includes(a.p_work_kind as string | null)) return pgError('22023');
        if (![null, 'image', 'document', 'audio', 'video'].includes(a.p_media_type as string | null)) return pgError('22023');

        const org = String(a.p_org);
        const wamid = String(a.p_wamid);
        const bsuid = (a.p_bsuid as string | null) ?? null;
        const now = Date.now();
        const result = (outcome: string, over: Row = {}): Result =>
            ok([{
                outcome,
                contact_key: null,
                message_id: null,
                chat_created: null,
                summary_applied: null,
                contact_name: null,
                ai_enabled: null,
                queue_outcome: null,
                quota_limit: null,
                quota_first_refusal: null,
                quota_error: null,
                rate_first: null,
                rate_error: null,
                bsuid_conflict: null,
                work_id: null,
                work_state: null,
                ...over,
            }]);

        // 1. Contact key.
        let key: string | null = null;
        if (bsuid !== null) key = this.chats.find((c) => c.org_id === org && c.bsuid === bsuid)?.phone_number ?? null;
        key ??= (a.p_from as string | null) || null;
        key ??= bsuid;
        if (key === null) return result('no_identity');

        // 3. The redelivery gate.
        const existing = this.messages.find((m) => m.org_id === org && m.wa_message_id === wamid && m.role === 'user');
        if (existing) return result('duplicate', { contact_key: key, message_id: existing.id });

        // 4. Rate limit (fail-open).
        let rateError: string | null = null;
        if (a.p_rate_scope !== null) {
            if (this.rateError) {
                rateError = this.rateError;
            } else {
                const ident = a.p_rate_scope === 'main' ? `${org}:${key}` : `${org}:other:${key}`;
                const r = this.rateLimits.get(ident);
                let count: number;
                if (!r || r.windowStart < now - 60_000) {
                    count = 1;
                    this.rateLimits.set(ident, { count, windowStart: now });
                } else {
                    count = r.count + 1;
                    r.count = count;
                }
                const max = Number(a.p_rate_max);
                if (count > max) {
                    this.commits.push(`rate_limited:${wamid}`);
                    return result('rate_limited', { contact_key: key, rate_first: count === max + 1 });
                }
            }
        }

        // 5. Chat ensure, 6. message row.
        let chat = this.chat(key, org);
        const chatCreated = !chat;
        chat ??= this.seedChat({ org_id: org, phone_number: key });
        const message = this.insertMessage({
            org_id: org,
            phone_number: key,
            role: 'user',
            content: a.p_content,
            wa_message_id: wamid,
            reply_to_wamid: a.p_reply_to_wamid,
            media_type: a.p_media_type,
            media_mime: a.p_media_mime,
            media_filename: a.p_media_filename,
            metadata: a.p_metadata,
            wa_timestamp: a.p_wa_ts,
        });
        this.commits.push(`ingest:${wamid}`);

        // 7. Summary, forward only by Meta's time (clamped to now).
        const vts = Math.min(typeof a.p_wa_ts === 'string' ? Date.parse(a.p_wa_ts) : now, now);
        if (typeof a.p_wa_ts === 'string') message.wa_timestamp = iso(vts);
        const apply = chat.last_inbound_at === null || Date.parse(chat.last_inbound_at) <= vts;
        if (apply) {
            chat.last_message = String(a.p_preview);
            chat.last_message_at = iso(vts);
            chat.last_inbound_at = iso(vts);
        }
        if (a.p_unread === true) chat.unread_count += 1;
        chat.verified_phone = (a.p_verified_phone as string | null) || chat.verified_phone;
        chat.updated_at = iso(now);

        // 8. BSUID.
        let bsuidConflict = false;
        if (bsuid !== null && chat.bsuid !== bsuid) {
            if (this.chats.some((c) => c !== chat && c.org_id === org && c.bsuid === bsuid)) bsuidConflict = true;
            else chat.bsuid = bsuid;
        }

        // 10. AI decision.
        let queueOutcome: string | null = null;
        let quotaLimit: number | null = null;
        let quotaFirstRefusal: boolean | null = null;
        let quotaError: string | null = null;
        if (a.p_ai_eligible === true) {
            if (chat.ai_enabled === false) {
                queueOutcome = 'manual';
            } else if (this.queue.some((j) => j.org_id === org && j.wa_message_id === wamid)) {
                queueOutcome = 'already_queued';
            } else {
                const joins = this.queue.some((j) => j.org_id === org && j.phone_number === key && j.status === 'pending');
                let allowed = true;
                if (!joins) {
                    if (this.quotaError) {
                        quotaError = this.quotaError;
                    } else {
                        const d = this.consumeQuota(org, 'inbound_minute', Number(a.p_inbound_limit));
                        allowed = d.allowed;
                        if (!allowed) {
                            quotaLimit = d.quota;
                            quotaFirstRefusal = d.first_refusal;
                        }
                    }
                }
                if (allowed || joins) {
                    this.insertJob({ org_id: org, phone_number: key, message_text: a.p_queue_text, wa_message_id: wamid });
                    queueOutcome = joins ? 'joined' : 'queued';
                } else {
                    queueOutcome = 'refused';
                }
            }
        }

        return result('new', {
            contact_key: key,
            message_id: message.id,
            chat_created: chatCreated,
            summary_applied: apply,
            contact_name: chat.contact_name,
            ai_enabled: chat.ai_enabled,
            queue_outcome: queueOutcome,
            quota_limit: quotaLimit,
            quota_first_refusal: quotaFirstRefusal,
            quota_error: quotaError,
            rate_first: null,
            rate_error: rateError,
            bsuid_conflict: bsuidConflict,
        });
    }

    /** wa_apply_statuses per C2_SPEC section 4. */
    private applyStatuses(a: Row): Result {
        if (Object.keys(a).sort().join(',') !== [...STATUSES_PARAMS].sort().join(',')) {
            return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 };
        }
        if (refusedByPostgres(a)) return pgError('22P05');
        const org = String(a.p_org);
        const now = Date.now();
        const list = Array.isArray(a.p_statuses) ? a.p_statuses : [];
        const best = new Map<string, Row>();
        for (const s of list) {
            if (!isObject(s) || typeof s.id !== 'string' || !(String(s.status) in RANK)) continue;
            const prev = best.get(s.id);
            const ts = (x: Row) => (typeof x.ts === 'string' ? Date.parse(x.ts) : -Infinity);
            if (!prev || RANK[String(s.status)] > RANK[String(prev.status)] || (RANK[String(s.status)] === RANK[String(prev.status)] && ts(s) > ts(prev))) {
                best.set(s.id, s);
            }
        }
        let applied = 0;
        let stale = 0;
        const unknownIds: string[] = [];
        for (const [id, s] of best) {
            const rows = this.messages.filter((m) => m.org_id === org && m.wa_message_id === id && m.role === 'assistant');
            if (rows.length === 0) {
                unknownIds.push(id);
                continue;
            }
            const sTs = typeof s.ts === 'string' ? Date.parse(s.ts) : null;
            let any = false;
            for (const m of rows) {
                const forward =
                    m.status === null ||
                    (s.status === 'delivered' && m.status === 'sent') ||
                    (s.status === 'read' && (m.status === 'sent' || m.status === 'delivered')) ||
                    (s.status === 'failed' && m.status === 'sent') ||
                    ((s.status === 'delivered' || s.status === 'read') &&
                        m.status === 'failed' &&
                        sTs !== null &&
                        sTs > (m.status_updated_at ? Date.parse(m.status_updated_at) : -Infinity));
                if (!forward) continue;
                const wasFailed = m.status === 'failed';
                m.status = String(s.status);
                m.status_updated_at = iso(Math.min(sTs ?? now, now));
                if (s.status === 'failed') {
                    m.error_code = (s.error_code as number | null) ?? null;
                    m.error_title = (s.error_title as string | null) ?? null;
                    m.error_detail = (s.error_detail as string | null) ?? null;
                } else if (wasFailed) {
                    m.error_code = null;
                    m.error_title = null;
                    m.error_detail = null;
                }
                applied += 1;
                any = true;
            }
            if (!any) stale += 1;
        }
        let filled = 0;
        const pairs = new Set<string>();
        for (const s of list) {
            if (!isObject(s) || typeof s.recipient_id !== 'string' || typeof s.recipient_user_id !== 'string') continue;
            const pair = `${s.recipient_id}|${s.recipient_user_id}`;
            if (pairs.has(pair)) continue;
            pairs.add(pair);
            const chat = this.chat(s.recipient_id, org);
            if (!chat || chat.bsuid !== null) continue;
            if (this.chats.some((c) => c.org_id === org && c.bsuid === s.recipient_user_id)) continue;
            chat.bsuid = s.recipient_user_id;
            filled += 1;
        }
        this.commits.push(`statuses:${best.size}`);
        return ok([{ applied, stale, unknown: unknownIds.length, unknown_ids: unknownIds, bsuid_filled: filled, bsuid_conflicts: 0 }]);
    }

    /** claim_queue_jobs: pending jobs of the conversations whose newest job is older than the debounce. */
    private claimJobs(a: Row): Result {
        const now = Date.now();
        const debounceMs = Number(a.p_debounce_seconds ?? 0) * 1000;
        const pending = this.queue.filter((j) => j.status === 'pending');
        const newest = new Map<string, number>();
        for (const j of pending) {
            const k = `${j.org_id}::${j.phone_number}`;
            newest.set(k, Math.max(newest.get(k) ?? 0, Date.parse(j.created_at)));
        }
        const claimed = pending
            .filter((j) => (newest.get(`${j.org_id}::${j.phone_number}`) ?? 0) <= now - debounceMs)
            .slice(0, Number(a.p_limit ?? 10));
        for (const j of claimed) {
            j.status = 'processing';
            j.updated_at = iso(now);
        }
        return ok(claimed.map((j) => ({ ...j })));
    }
}

function ok(data: unknown): Result {
    return { data, error: null, status: 200 };
}

function pgError(code: string): Result {
    return { data: null, error: { code, message: 'model error' }, status: 400 };
}

function unique(): Result {
    return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' }, status: 409 };
}

/** A real macrotask (setImmediate is left unfaked by the tests' fake timers). */
export function macrotask(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

// ---- payloads ------------------------------------------------------------------

/** Meta's signature header value for these bytes. */
export function signatureOf(bytes: Buffer, secret = SECRET): string {
    return `sha256=${crypto.createHmac('sha256', secret).update(bytes).digest('hex')}`;
}

/** A signed webhook POST of `body` (an object, raw text or raw bytes). */
export function signedPost(body: unknown, secret = SECRET): Request {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const signature = signatureOf(bytes, secret);
    return new Request('http://localhost/api/webhook/whatsapp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        body: new Uint8Array(bytes),
    });
}

/** A delivery: one entry per list of changes. */
export function delivery(...entries: unknown[][]): Row {
    return { object: 'whatsapp_business_account', entry: entries.map((changes, i) => ({ id: `waba-palsu-${i}`, changes })) };
}

/** A 'messages' change of a number (the env number by default). */
export function change(
    value: { messages?: unknown[]; statuses?: unknown[]; contacts?: unknown[]; errors?: unknown[] },
    phoneNumberId: string | null = PNID,
    field: string | null = 'messages',
): Row {
    return {
        ...(field === null ? {} : { field }),
        value: {
            messaging_product: 'whatsapp',
            ...(phoneNumberId === null ? {} : { metadata: { display_phone_number: '+62 800-0000-1234', phone_number_id: phoneNumberId } }),
            ...value,
        },
    };
}

/** Unix seconds (as Meta sends them) of a time `agoMs` before now. */
export function metaTs(agoMs = 0): string {
    return String(Math.floor((Date.now() - agoMs) / 1000));
}

/** A text message. */
export function textMsg(from: string, id: string | null, body: string, extra: Row = {}): Row {
    return { from, ...(id === null ? {} : { id }), timestamp: metaTs(), type: 'text', text: { body }, ...extra };
}

export function contactOf(waId: string, userId?: string): Row {
    return { profile: { name: 'Pelanggan Palsu' }, wa_id: waId, ...(userId ? { user_id: userId } : {}) };
}
