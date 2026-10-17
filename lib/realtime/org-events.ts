// Client side of the org Realtime bus (migration 0064, tracker 1.9; audit
// KEA-15, PER-8). Pure: no React, no Supabase, so it unit-tests without a
// socket. components/realtime/org-realtime-provider.tsx joins the tab's one
// private channel and feeds every parsed message into an OrgEventBus.
//
// A message only says WHAT changed (table, operation, row count, at most 50
// ids), never the row: no phone numbers, no text. Views refetch what they
// show through PostgREST, under RLS.

/** The tables whose writes are broadcast on the org topic (0064 triggers). */
export const ORG_EVENT_TABLES = [
    'whatsapp_chats',
    'whatsapp_messages',
    'labels',
    'chat_labels',
    'orders',
] as const;

export type OrgEventTable = (typeof ORG_EVENT_TABLES)[number];
export type OrgEventOp = 'INSERT' | 'UPDATE' | 'DELETE';

export interface OrgEvent {
    table: OrgEventTable;
    op: OrgEventOp;
    /** Rows of the org changed by the statement (>= 1). */
    n: number;
    /** Ids of those rows, at most 50; [] for tables without an id column. */
    ids: string[];
    /** The ids do not name every changed row: refetch what you show. */
    truncated: boolean;
}

/**
 * "Changes may have been missed": sent on every (re)join of the channel, when
 * the tab becomes visible and when the device comes back online. Every
 * subscriber gets it, whatever its tables.
 */
export interface OrgResync {
    table: '*';
    op: 'RESYNC';
}

export const RESYNC: OrgResync = Object.freeze({ table: '*', op: 'RESYNC' });

export type OrgSignal = OrgEvent | OrgResync;

/** The private Broadcast topic of an org: 'org:<uuid>', lower-case like 0064 sends it. */
export function orgTopic(orgId: string): string {
    return `org:${orgId.toLowerCase()}`;
}

// whatsapp_chats and chat_labels have composite keys that hold the customer's
// phone number, so 0064 never sends their ids: every event is "refetch".
const TABLES_WITHOUT_IDS: ReadonlySet<string> = new Set(['whatsapp_chats', 'chat_labels']);
const MAX_IDS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrgEventTable(value: unknown): value is OrgEventTable {
    return typeof value === 'string' && (ORG_EVENT_TABLES as readonly string[]).includes(value);
}

/**
 * Validates one broadcast message as realtime-js hands it to a
 * `.on('broadcast', { event: '*' })` listener — `{ event, payload }` — against
 * payload contract v1 of 0064:
 * `{ v: 1, table: <event>, op, n: integer >= 1, ids: <= 50 uuids, <= n }`.
 * Anything else is null and ignored. Keys this contract does not name (the
 * message `id` realtime.send adds) are ignored too, so a platform-side
 * addition cannot silence the bus; a change of meaning needs `v: 2`.
 */
export function parseOrgEvent(message: unknown): OrgEvent | null {
    if (!isRecord(message) || !isRecord(message.payload)) return null;
    const { v, table, op, n, ids } = message.payload;
    if (v !== 1) return null;
    if (!isOrgEventTable(table) || message.event !== table) return null;
    if (op !== 'INSERT' && op !== 'UPDATE' && op !== 'DELETE') return null;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return null;
    if (!Array.isArray(ids) || ids.length > MAX_IDS || ids.length > n) return null;
    if (!ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) return null;
    return {
        table,
        op,
        n,
        ids: ids as string[],
        truncated: TABLES_WITHOUT_IDS.has(table) || n > ids.length,
    };
}

export type OrgSignalHandler = (signal: OrgSignal) => void;

export interface OrgEventBus {
    /** Delivers the events of `tables` and every RESYNC; returns the unsubscribe. */
    subscribe(tables: readonly OrgEventTable[], handler: OrgSignalHandler): () => void;
    emit(signal: OrgSignal): void;
}

export function createOrgEventBus(): OrgEventBus {
    const subscribers = new Set<{ tables: ReadonlySet<string>; handler: OrgSignalHandler }>();
    return {
        subscribe(tables, handler) {
            const subscriber = { tables: new Set<string>(tables), handler };
            subscribers.add(subscriber);
            return () => {
                subscribers.delete(subscriber);
            };
        },
        emit(signal) {
            // A snapshot: a handler may unsubscribe (unmount) while we deliver.
            for (const { tables, handler } of Array.from(subscribers)) {
                if (signal.op !== 'RESYNC' && !tables.has(signal.table)) continue;
                try {
                    handler(signal);
                } catch (err) {
                    // One broken view must not keep the signal from the others.
                    console.error('[realtime] org event handler failed', err);
                }
            }
        },
    };
}

export interface CoalesceOptions {
    /** Quiet time after the last call before `fn` runs (ms). */
    wait?: number;
    /** Longest a continuous stream of calls can postpone `fn` (ms). */
    maxWait?: number;
}

export interface Coalesced {
    (): void;
    /** Drops a pending run (unmount). */
    cancel(): void;
}

/**
 * Trailing debounce with a ceiling: a burst of calls runs `fn` once, `wait`
 * ms after the last call, and a continuous stream still runs it every
 * `maxWait` ms. A statement-level broadcast is already one message per
 * statement; this folds the few statements of one webhook call (or a bulk
 * edit) into one refetch.
 */
export function coalesce(fn: () => unknown, { wait = 400, maxWait = 2000 }: CoalesceOptions = {}): Coalesced {
    let trailing: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
        clearTimeout(trailing);
        clearTimeout(deadline);
        trailing = undefined;
        deadline = undefined;
    };
    const fire = () => {
        clear();
        fn();
    };
    const run = () => {
        clearTimeout(trailing);
        trailing = setTimeout(fire, wait);
        if (deadline === undefined) deadline = setTimeout(fire, maxWait);
    };
    return Object.assign(run, { cancel: clear });
}
