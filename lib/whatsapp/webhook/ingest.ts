import type { SupabaseClient } from '@supabase/supabase-js';
import { RpcError } from '@/lib/whatsapp/webhook/errors';
import { isRecord, sanitizeForPg } from '@/lib/whatsapp/webhook/payload';

// The two database functions of the webhook (migration 0072): one
// wa_ingest_inbound call per inbound message, in one transaction (redelivery
// gate, rate limit, chat, message row, summary and unread, AI quota and queue
// job commit together or not at all), and one wa_apply_statuses call per
// change. The parameter and result names below must match the SQL exactly:
// rpc-contract.test.ts compares them with the recorded schema fingerprint.

/** wa_ingest_inbound's parameters, in the order of its signature. */
export const INGEST_PARAMS = [
    'p_org',
    'p_from',
    'p_bsuid',
    'p_wamid',
    'p_wa_ts',
    'p_content',
    'p_preview',
    'p_verified_phone',
    'p_reply_to_wamid',
    'p_media_type',
    'p_media_mime',
    'p_media_filename',
    'p_metadata',
    'p_unread',
    'p_rate_scope',
    'p_rate_max',
    'p_ai_eligible',
    'p_queue_text',
    'p_inbound_limit',
    'p_work_kind',
    'p_work_payload',
] as const;

/** The columns of wa_ingest_inbound's one result row. */
export const INGEST_RESULT_KEYS = [
    'outcome',
    'contact_key',
    'message_id',
    'chat_created',
    'summary_applied',
    'contact_name',
    'ai_enabled',
    'queue_outcome',
    'quota_limit',
    'quota_first_refusal',
    'quota_error',
    'rate_first',
    'rate_error',
    'bsuid_conflict',
    'work_id',
    'work_state',
] as const;

/** wa_apply_statuses' parameters, in the order of its signature. */
export const STATUSES_PARAMS = ['p_org', 'p_statuses'] as const;

/** The columns of wa_apply_statuses' one result row. */
export const STATUSES_RESULT_KEYS = ['applied', 'stale', 'unknown', 'unknown_ids', 'bsuid_filled', 'bsuid_conflicts'] as const;

export type IngestParams = {
    p_org: string;
    p_from: string | null;
    p_bsuid: string | null;
    p_wamid: string;
    /** ISO time of messages[].timestamp, or null (the database uses now()). */
    p_wa_ts: string | null;
    p_content: string;
    p_preview: string;
    p_verified_phone: string | null;
    p_reply_to_wamid: string | null;
    p_media_type: 'image' | 'document' | 'audio' | 'video' | null;
    p_media_mime: string | null;
    p_media_filename: string | null;
    p_metadata: Record<string, unknown>;
    p_unread: boolean;
    p_rate_scope: 'main' | 'other' | null;
    p_rate_max: number | null;
    p_ai_eligible: boolean;
    p_queue_text: string | null;
    p_inbound_limit: number | null;
    p_work_kind: 'media' | 'flow' | null;
    p_work_payload: Record<string, unknown> | null;
};

export type IngestOutcome = 'new' | 'duplicate' | 'rate_limited' | 'no_identity';
export type QueueOutcome = 'queued' | 'joined' | 'already_queued' | 'manual' | 'refused';

export interface IngestResult {
    outcome: IngestOutcome;
    /** The chat key the database resolved (null for 'no_identity'). */
    contactKey: string | null;
    messageId: string | null;
    chatCreated: boolean | null;
    summaryApplied: boolean | null;
    contactName: string | null;
    aiEnabled: boolean | null;
    /** Only when the message was AI-eligible. */
    queueOutcome: QueueOutcome | null;
    quotaLimit: number | null;
    quotaFirstRefusal: boolean | null;
    /** SQLSTATE of a quota counter failure (the message was let through). */
    quotaError: string | null;
    rateFirst: boolean | null;
    /** SQLSTATE of a rate-limit failure (the message was let through). */
    rateError: string | null;
    bsuidConflict: boolean | null;
    workId: string | null;
    workState: string | null;
}

export interface StatusesResult {
    applied: number;
    stale: number;
    unknown: number;
    unknownIds: string[];
    bsuidFilled: number;
    bsuidConflicts: number;
}

/** A result row of an unexpected shape: the code and the database disagree (retryable). */
export class RpcShapeError extends Error {
    constructor(call: string) {
        super(`${call} returned a result of an unexpected shape`);
        this.name = 'RpcShapeError';
    }
}

const OUTCOMES: readonly string[] = ['new', 'duplicate', 'rate_limited', 'no_identity'];
const QUEUE_OUTCOMES: readonly string[] = ['queued', 'joined', 'already_queued', 'manual', 'refused'];

function singleRow(call: string, data: unknown, keys: readonly string[]): Record<string, unknown> {
    // RETURNS TABLE arrives as an array of rows: exactly one is expected.
    const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
    if (!isRecord(row) || keys.some((k) => !(k in row))) throw new RpcShapeError(call);
    return row;
}

function str(call: string, v: unknown): string | null {
    if (v === null || typeof v === 'string') return v;
    throw new RpcShapeError(call);
}

function bool(call: string, v: unknown): boolean | null {
    if (v === null || typeof v === 'boolean') return v;
    throw new RpcShapeError(call);
}

function int(call: string, v: unknown): number | null {
    if (v === null || (typeof v === 'number' && Number.isInteger(v))) return v;
    throw new RpcShapeError(call);
}

/**
 * Stores one inbound message (wa_ingest_inbound). Every text and JSON
 * parameter is sanitised first (sanitizeForPg): a U+0000 or a lone surrogate
 * would otherwise fail the call with a class-22 error. Throws an RpcError on
 * a database or network error and an RpcShapeError when the result row is
 * not what the code expects; `signal` aborts the call when the delivery's
 * time budget runs out.
 */
export async function ingestInbound(client: SupabaseClient, params: IngestParams, signal: AbortSignal): Promise<IngestResult> {
    const call = 'wa_ingest_inbound';
    const clean = sanitizeForPg(params);
    const args = Object.fromEntries(INGEST_PARAMS.map((name) => [name, clean[name]]));
    const { data, error, status } = await client.rpc(call, args).abortSignal(signal);
    if (error) throw new RpcError(call, error, status);
    const row = singleRow(call, data, INGEST_RESULT_KEYS);
    if (typeof row.outcome !== 'string' || !OUTCOMES.includes(row.outcome)) throw new RpcShapeError(call);
    if (row.queue_outcome !== null && (typeof row.queue_outcome !== 'string' || !QUEUE_OUTCOMES.includes(row.queue_outcome))) {
        throw new RpcShapeError(call);
    }
    return {
        outcome: row.outcome as IngestOutcome,
        contactKey: str(call, row.contact_key),
        messageId: str(call, row.message_id),
        chatCreated: bool(call, row.chat_created),
        summaryApplied: bool(call, row.summary_applied),
        contactName: str(call, row.contact_name),
        aiEnabled: bool(call, row.ai_enabled),
        queueOutcome: row.queue_outcome as QueueOutcome | null,
        quotaLimit: int(call, row.quota_limit),
        quotaFirstRefusal: bool(call, row.quota_first_refusal),
        quotaError: str(call, row.quota_error),
        rateFirst: bool(call, row.rate_first),
        rateError: str(call, row.rate_error),
        bsuidConflict: bool(call, row.bsuid_conflict),
        workId: str(call, row.work_id),
        workState: str(call, row.work_state),
    };
}

/** One normalised status of a change, as wa_apply_statuses reads it. */
export interface StatusRow {
    id: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    /** ISO time of statuses[].timestamp, or null. */
    ts: string | null;
    error_code: number | null;
    error_title: string | null;
    error_detail: string | null;
    recipient_id: string | null;
    recipient_user_id: string | null;
}

/**
 * Applies the statuses of one change (wa_apply_statuses): forward only, to the
 * org's own outbound rows. Throws like ingestInbound.
 */
export async function applyStatuses(
    client: SupabaseClient,
    orgId: string,
    statuses: StatusRow[],
    signal: AbortSignal,
): Promise<StatusesResult> {
    const call = 'wa_apply_statuses';
    const { data, error, status } = await client
        .rpc(call, { p_org: orgId, p_statuses: sanitizeForPg(statuses) })
        .abortSignal(signal);
    if (error) throw new RpcError(call, error, status);
    const row = singleRow(call, data, STATUSES_RESULT_KEYS);
    const count = (v: unknown) => {
        const n = int(call, v);
        return n ?? 0;
    };
    const ids = row.unknown_ids;
    if (ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) throw new RpcShapeError(call);
    return {
        applied: count(row.applied),
        stale: count(row.stale),
        unknown: count(row.unknown),
        unknownIds: (ids ?? []) as string[],
        bsuidFilled: count(row.bsuid_filled),
        bsuidConflicts: count(row.bsuid_conflicts),
    };
}
