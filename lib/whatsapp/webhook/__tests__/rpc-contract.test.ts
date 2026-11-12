import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    INGEST_PARAMS,
    INGEST_RESULT_KEYS,
    STATUSES_PARAMS,
    STATUSES_RESULT_KEYS,
    RpcShapeError,
    applyStatuses,
    ingestInbound,
    type IngestParams,
    type StatusRow,
} from '@/lib/whatsapp/webhook/ingest';
import { RpcError, classify } from '@/lib/whatsapp/webhook/errors';

// The parity of the TypeScript and SQL halves of the webhook ingest (Fase 2
// task 2.2a part 2, C2_SPEC sections 2 and 9). The code calls the database
// functions by named arguments and reads their result columns by name, so a
// renamed, added or dropped argument or column breaks every delivery in
// production while each half's own tests stay green. This test reads the
// signatures the schema fingerprint records: the pending '>' line in
// supabase/fingerprint/expected-diff.txt while a migration waits for its
// production apply (it describes what this branch's migrations create, which
// is what the code is deployed against), else the line in production.txt;
// neither is a failure, never a skip. Then it compares them with the names
// and types the code sends and validates. Runs in ci.yml on every PR.

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (file: string) => readFileSync(`${ROOT}supabase/fingerprint/${file}`, 'utf8');

interface Column {
    name: string;
    type: string;
}

interface FnSignature {
    name: string;
    args: Column[];
    returns: string;
    /** The columns of RETURNS TABLE(...), else null. */
    table: Column[] | null;
    lang: string;
    secdef: string;
    config: string;
}

/** Splits "a int, b numeric(10,2)" at the commas outside parentheses. */
function splitTopLevel(list: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of list) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/** "p_org uuid" (pg_get_function_arguments: an optional mode, a DEFAULT) as a name and a type. */
function parseColumn(definition: string): Column {
    const plain = definition.replace(/\s+DEFAULT\s+.*$/i, '').replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, '');
    const m = /^"?([^"\s]+)"?\s+(.+)$/.exec(plain);
    if (!m) throw new Error(`unreadable argument or column "${definition}"`);
    return { name: m[1], type: m[2].trim() };
}

/** One 'fn public.<name>(<args>) returns=... lang=... secdef=... config=... owner=... body_md5=...' line. */
function parseFnLine(line: string): FnSignature {
    const head = /^fn public\.([a-z_][a-z0-9_]*)\(/.exec(line);
    if (!head) throw new Error(`not a function line: ${line.slice(0, 60)}`);
    let depth = 0;
    let end = -1;
    for (let i = head[0].length - 1; i < line.length; i++) {
        if (line[i] === '(') depth += 1;
        else if (line[i] === ')') {
            depth -= 1;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end < 0) throw new Error(`unbalanced argument list: ${head[1]}`);
    const rest = /^ returns=(.+) lang=(\S+) volatile=(\S+) secdef=(\S+) config=(.*) owner=(\S+) body_md5=([0-9a-f]+)$/.exec(line.slice(end + 1));
    if (!rest) throw new Error(`unreadable attributes of ${head[1]}`);
    const argText = line.slice(head[0].length, end).trim();
    const table = /^TABLE\((.*)\)$/.exec(rest[1]);
    return {
        name: head[1],
        args: argText ? splitTopLevel(argText).map(parseColumn) : [],
        returns: rest[1],
        table: table ? splitTopLevel(table[1]).map(parseColumn) : null,
        lang: rest[2],
        secdef: rest[4],
        config: rest[5],
    };
}

interface Recorded {
    signature: FnSignature;
    /** role -> may execute, from the fnexec lines of the same source. */
    exec: Record<string, boolean>;
    source: 'expected-diff.txt (pending)' | 'production.txt';
}

/** The recorded signature of public.<name>: the pending '>' line wins over production.txt. */
function recorded(name: string, files = { expectedDiff: read('expected-diff.txt'), production: read('production.txt') }): Recorded {
    const fromLines = (lines: string[], source: Recorded['source']): Recorded | null => {
        const fn = lines.find((l) => l.startsWith(`fn public.${name}(`));
        if (!fn) return null;
        const exec: Record<string, boolean> = {};
        for (const l of lines) {
            const m = new RegExp(`^fnexec public\\.${name}\\(.*\\) (\\w+)=([tf])$`).exec(l);
            if (m) exec[m[1]] = m[2] === 't';
        }
        return { signature: parseFnLine(fn), exec, source };
    };
    const pending = files.expectedDiff
        .split(/\r?\n/)
        .filter((l) => l.startsWith('> '))
        .map((l) => l.slice(2));
    const found = fromLines(pending, 'expected-diff.txt (pending)') ?? fromLines(files.production.split(/\r?\n/), 'production.txt');
    if (!found) {
        throw new Error(
            `fn public.${name}(...) is recorded neither in supabase/fingerprint/production.txt nor as a pending ` +
                `"> fn public.${name}(" line in supabase/fingerprint/expected-diff.txt: add the migration's pending ` +
                'block (C2_SPEC section 1) so the code can be compared with the database function it calls',
        );
    }
    return found;
}

const names = (cols: Column[] | null) => (cols ?? []).map((c) => c.name);
const types = (cols: Column[] | null) => Object.fromEntries((cols ?? []).map((c) => [c.name, c.type]));

/** The SQL type each value the code sends fits (ingest.ts IngestParams). */
const INGEST_PARAM_TYPES: Record<(typeof INGEST_PARAMS)[number], string> = {
    p_org: 'uuid',
    p_from: 'text',
    p_bsuid: 'text',
    p_wamid: 'text',
    p_wa_ts: 'timestamp with time zone',
    p_content: 'text',
    p_preview: 'text',
    p_verified_phone: 'text',
    p_reply_to_wamid: 'text',
    p_media_type: 'text',
    p_media_mime: 'text',
    p_media_filename: 'text',
    p_metadata: 'jsonb',
    p_unread: 'boolean',
    p_rate_scope: 'text',
    p_rate_max: 'integer',
    p_ai_eligible: 'boolean',
    p_queue_text: 'text',
    p_inbound_limit: 'integer',
    p_work_kind: 'text',
    p_work_payload: 'jsonb',
};

/** The SQL type of each result column, as ingestInbound validates it (str, bool, int). */
const INGEST_RESULT_TYPES: Record<(typeof INGEST_RESULT_KEYS)[number], string> = {
    outcome: 'text',
    contact_key: 'text',
    message_id: 'uuid',
    chat_created: 'boolean',
    summary_applied: 'boolean',
    contact_name: 'text',
    ai_enabled: 'boolean',
    queue_outcome: 'text',
    quota_limit: 'integer',
    quota_first_refusal: 'boolean',
    quota_error: 'text',
    rate_first: 'boolean',
    rate_error: 'text',
    bsuid_conflict: 'boolean',
    work_id: 'uuid',
    work_state: 'text',
};

const STATUSES_PARAM_TYPES = { p_org: 'uuid', p_statuses: 'jsonb' };
const STATUSES_RESULT_TYPES = {
    applied: 'integer',
    stale: 'integer',
    unknown: 'integer',
    unknown_ids: 'text[]',
    bsuid_filled: 'integer',
    bsuid_conflicts: 'integer',
};

describe('the recorded signatures of the four database functions (fingerprint)', () => {
    it('wa_ingest_inbound takes exactly INGEST_PARAMS, in order, with the types the code sends', () => {
        const { signature } = recorded('wa_ingest_inbound');
        expect(names(signature.args)).toEqual([...INGEST_PARAMS]);
        expect(types(signature.args)).toEqual(INGEST_PARAM_TYPES);
        expect(Object.keys(INGEST_PARAM_TYPES)).toEqual([...INGEST_PARAMS]);
    });

    it('wa_ingest_inbound returns exactly INGEST_RESULT_KEYS, with the types ingestInbound validates', () => {
        const { signature } = recorded('wa_ingest_inbound');
        expect(signature.table).not.toBeNull();
        expect(names(signature.table)).toEqual([...INGEST_RESULT_KEYS]);
        expect(types(signature.table)).toEqual(INGEST_RESULT_TYPES);
        expect(Object.keys(INGEST_RESULT_TYPES)).toEqual([...INGEST_RESULT_KEYS]);
    });

    it('wa_apply_statuses takes STATUSES_PARAMS and returns STATUSES_RESULT_KEYS', () => {
        const { signature } = recorded('wa_apply_statuses');
        expect(names(signature.args)).toEqual([...STATUSES_PARAMS]);
        expect(types(signature.args)).toEqual(STATUSES_PARAM_TYPES);
        expect(names(signature.table)).toEqual([...STATUSES_RESULT_KEYS]);
        expect(types(signature.table)).toEqual(STATUSES_RESULT_TYPES);
    });

    it('claim_inbound_work and cleanup_old_inbound_work have the signatures the next build (C3) calls', () => {
        const claim = recorded('claim_inbound_work').signature;
        expect(claim.args).toEqual([
            { name: 'p_limit', type: 'integer' },
            { name: 'p_lease_seconds', type: 'integer' },
            { name: 'p_id', type: 'uuid' },
        ]);
        expect(claim.returns).toBe('SETOF whatsapp_inbound_work');
        const cleanup = recorded('cleanup_old_inbound_work').signature;
        expect(cleanup.args).toEqual([]);
        expect(cleanup.returns).toBe('void');
    });

    it.each(['wa_ingest_inbound', 'wa_apply_statuses', 'claim_inbound_work', 'cleanup_old_inbound_work'])(
        '%s is SECURITY INVOKER with an empty search_path, executable by service_role only',
        (name) => {
            const { signature, exec } = recorded(name);
            expect(signature.secdef).toBe('f');
            expect(signature.config.split(';')).toContain('search_path=""');
            expect(exec).toEqual({ anon: false, authenticated: false, service_role: true });
        },
    );

    it.each(['wa_ingest_inbound', 'wa_apply_statuses'])('%s is plpgsql with lock_timeout 3s (a long wait is a retryable 55P03)', (name) => {
        const { signature } = recorded(name);
        expect(signature.lang).toBe('plpgsql');
        expect(signature.config.split(';')).toContain('lock_timeout=3s');
    });

    it('the lookup fails loudly when neither file records the function, and prefers a pending line', () => {
        const line = 'fn public.contoh_fn(p_a integer, p_b numeric(10,2) DEFAULT 1) returns=TABLE(x text, y text[]) lang=sql volatile=v secdef=f config=search_path="" owner=postgres body_md5=0123456789abcdef0123456789abcdef';
        expect(() => recorded('contoh_fn', { expectedDiff: '# nothing pending\n', production: 'fn public.lain() returns=void lang=sql volatile=v secdef=f config=- owner=postgres body_md5=00\n' })).toThrow(
            /neither in supabase\/fingerprint\/production\.txt nor as a pending "> fn public\.contoh_fn\("/,
        );
        const older = line.replace('p_a integer', 'p_lama integer');
        const found = recorded('contoh_fn', { expectedDiff: `> ${line}\r\n< ${older}\r\n`, production: `${older}\n` });
        expect(found.source).toBe('expected-diff.txt (pending)');
        expect(found.signature.args).toEqual([
            { name: 'p_a', type: 'integer' },
            { name: 'p_b', type: 'numeric(10,2)' },
        ]);
        expect(found.signature.table).toEqual([
            { name: 'x', type: 'text' },
            { name: 'y', type: 'text[]' },
        ]);
        expect(recorded('contoh_fn', { expectedDiff: '', production: `${older}\n` }).source).toBe('production.txt');
    });
});

// ---- the code's half: what goes over the wire and what is read back ----------

interface Sent {
    name: string;
    args: Record<string, unknown>;
    signal: AbortSignal | null;
}

/** A client whose rpc() records the call and answers `reply` (postgrest-js shape). */
function client(reply: { data?: unknown; error?: unknown; status?: number }): { sent: Sent[]; client: SupabaseClient } {
    const sent: Sent[] = [];
    const fake = {
        rpc: (name: string, args: Record<string, unknown>) => {
            const call: Sent = { name, args, signal: null };
            sent.push(call);
            const answer = Promise.resolve({ data: null, error: null, status: 200, ...reply });
            return Object.assign(answer, {
                abortSignal: (signal: AbortSignal) => {
                    call.signal = signal;
                    return answer;
                },
            });
        },
    };
    return { sent, client: fake as unknown as SupabaseClient };
}

const params: IngestParams = {
    p_org: 'aaaaaaaa-0000-4000-8000-00000000000a',
    p_from: '620000000001',
    p_bsuid: null,
    p_wamid: 'wamid.paritas',
    p_wa_ts: '2026-10-30T03:00:00.000Z',
    p_content: 'halo',
    p_preview: 'halo',
    p_verified_phone: '620000000001',
    p_reply_to_wamid: null,
    p_media_type: null,
    p_media_mime: null,
    p_media_filename: null,
    p_metadata: {},
    p_unread: true,
    p_rate_scope: 'main',
    p_rate_max: 10,
    p_ai_eligible: true,
    p_queue_text: 'halo',
    p_inbound_limit: 30,
    p_work_kind: null,
    p_work_payload: null,
};

/** A result row with every column of INGEST_RESULT_TYPES, typed as the SQL says. */
function resultRow(): Record<string, unknown> {
    const sample: Record<string, unknown> = { text: 'x', uuid: '00000000-0000-4000-8000-000000000001', boolean: true, integer: 1 };
    const row: Record<string, unknown> = Object.fromEntries(Object.entries(INGEST_RESULT_TYPES).map(([k, t]) => [k, sample[t]]));
    return { ...row, outcome: 'new', queue_outcome: 'queued' };
}

describe('ingestInbound and applyStatuses speak exactly that contract', () => {
    it('ingestInbound sends one wa_ingest_inbound call with exactly INGEST_PARAMS, in order, and the budget signal', async () => {
        const fake = client({ data: [resultRow()] });
        const signal = new AbortController().signal;
        await ingestInbound(fake.client, params, signal);
        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0].name).toBe('wa_ingest_inbound');
        expect(Object.keys(fake.sent[0].args)).toEqual([...INGEST_PARAMS]);
        expect(fake.sent[0].signal).toBe(signal);
    });

    it('a result row that carries every INGEST_RESULT_KEYS column of its SQL type is read', async () => {
        const result = await ingestInbound(client({ data: [resultRow()] }).client, params, new AbortController().signal);
        expect(result).toMatchObject({ outcome: 'new', queueOutcome: 'queued', messageId: '00000000-0000-4000-8000-000000000001', quotaLimit: 1 });
    });

    it.each([...INGEST_RESULT_KEYS])('a result row without %s is refused as an unexpected shape (retryable)', async (key) => {
        const row = resultRow();
        delete row[key];
        const error = await ingestInbound(client({ data: [row] }).client, params, new AbortController().signal).catch((e) => e);
        expect(error).toBeInstanceOf(RpcShapeError);
        expect(classify(error)).toBe('retryable');
    });

    it.each([
        ['no row', []],
        ['two rows', [resultRow(), resultRow()]],
        ['an unknown outcome', [{ ...resultRow(), outcome: 'stored' }]],
        ['an unknown queue outcome', [{ ...resultRow(), queue_outcome: 'waiting' }]],
        ['a boolean column as text', [{ ...resultRow(), chat_created: 'true' }]],
        ['an integer column as text', [{ ...resultRow(), quota_limit: '30' }]],
        ['a uuid column as a number', [{ ...resultRow(), message_id: 7 }]],
    ])('%s is refused as an unexpected shape', async (_label, data) => {
        await expect(ingestInbound(client({ data }).client, params, new AbortController().signal)).rejects.toBeInstanceOf(RpcShapeError);
    });

    it('a database error is thrown with its code and status only (a function the code is ahead of: PGRST202, retryable)', async () => {
        const error = await ingestInbound(
            client({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.wa_ingest_inbound(p_org, ...) — 620000000001' }, status: 404 }).client,
            params,
            new AbortController().signal,
        ).catch((e) => e);
        expect(error).toBeInstanceOf(RpcError);
        expect(error).toMatchObject({ code: 'PGRST202', status: 404 });
        expect(String(error.message)).not.toContain('620000000001');
        expect(classify(error)).toBe('retryable');
    });

    it('applyStatuses sends exactly STATUSES_PARAMS and reads exactly STATUSES_RESULT_KEYS', async () => {
        const rows: StatusRow[] = [
            { id: 'wamid.keluar', status: 'read', ts: null, error_code: null, error_title: null, error_detail: null, recipient_id: null, recipient_user_id: null },
        ];
        const reply = { applied: 1, stale: 0, unknown: 0, unknown_ids: ['wamid.x'], bsuid_filled: 0, bsuid_conflicts: 0 };
        const fake = client({ data: [reply] });
        const result = await applyStatuses(fake.client, 'aaaaaaaa-0000-4000-8000-00000000000a', rows, new AbortController().signal);
        expect(fake.sent.map((s) => [s.name, Object.keys(s.args)])).toEqual([['wa_apply_statuses', [...STATUSES_PARAMS]]]);
        expect(result).toEqual({ applied: 1, stale: 0, unknown: 0, unknownIds: ['wamid.x'], bsuidFilled: 0, bsuidConflicts: 0 });
        for (const key of STATUSES_RESULT_KEYS) {
            const partial: Record<string, unknown> = { ...reply };
            delete partial[key];
            await expect(applyStatuses(client({ data: [partial] }).client, 'org', rows, new AbortController().signal)).rejects.toBeInstanceOf(RpcShapeError);
        }
    });
});
