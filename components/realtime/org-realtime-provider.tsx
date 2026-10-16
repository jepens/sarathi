'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import { useCurrentOrgId } from '@/components/current-org-provider';
import {
    coalesce,
    createOrgEventBus,
    orgTopic,
    parseOrgEvent,
    RESYNC,
    type CoalesceOptions,
    type Coalesced,
    type OrgEvent,
    type OrgEventBus,
    type OrgEventTable,
    type OrgSignal,
} from '@/lib/realtime/org-events';

// Live dashboard updates (tracker 1.9; audit KEA-15, PER-8). This file is the
// ONLY owner of a Realtime channel: one PRIVATE Broadcast channel per tab on
// the org topic 'org:<org uuid>' (migration 0064: members only, receive
// only), fed by statement-level triggers with a payload that names no row
// data. Views subscribe through useOrgRealtime / useOrgRefetch and refetch
// through PostgREST under RLS. supabase.channel() returns the existing
// channel for a topic that is already open, so a second owner would share,
// and could remove, this one: lib/realtime/__tests__/realtime-usage.test.ts
// keeps every `.channel(` call here.

/** Live-update state of the tab's org channel. */
export type OrgRealtimeStatus =
    /** No org (signed-in non-member): no channel. */
    | 'off'
    /** First join in progress. */
    | 'connecting'
    /** Joined: changes arrive within about a second. */
    | 'live'
    /** Not joined: live updates paused; the polls go on, a RESYNC follows the next join. */
    | 'paused';

// The part of a supabase-js client the channel needs (the tests pass a fake).
export interface OrgChannel {
    on(type: 'broadcast', filter: { event: string }, callback: (message: unknown) => void): OrgChannel;
    subscribe(callback: (status: string, err?: Error) => void): OrgChannel;
    unsubscribe(): Promise<unknown>;
}

/** The socket side (realtime-js RealtimeClient). */
export interface OrgRealtimeSocket {
    setAuth(token?: string | null): Promise<void>;
    connect(): void;
    isConnected(): boolean;
    isConnecting(): boolean;
    isDisconnecting(): boolean;
    /**
     * The current WebSocket (RealtimeClient.conn). Closing it is how
     * realtime-js itself recovers from a heartbeat timeout: it fails the
     * connection and reconnects with its own backoff, and the channels rejoin
     * (disconnect() would tear the channels down instead).
     */
    conn?: { close(code?: number, reason?: string): void } | null;
}

export interface OrgRealtimeClient {
    channel(topic: string, options: { config: { private: boolean } }): OrgChannel;
    removeChannel(channel: OrgChannel): Promise<unknown>;
    realtime: OrgRealtimeSocket;
}

export interface OrgChannelHandlers {
    onEvent: (event: OrgEvent) => void;
    onResync: () => void;
    onStatus: (status: OrgRealtimeStatus) => void;
}

export interface OrgChannelController {
    /** Back online / tab visible: skip the rest of a re-join backoff. */
    wake(): void;
    /** Unmount: remove the channel and never re-create it. */
    stop(): void;
}

// realtime-js keeps the SOCKET up (reconnect with backoff, heartbeats) and
// rejoins an errored channel once the socket is back. It never rejoins a
// CLOSED one: the server closes a channel on an expired token ("Token has
// expired"), revoked access or a rate limit. So the channel is re-created
// - after a server-side close (CLOSED), and
// - when its joins keep failing, or no join happens, while the socket IS
//   connected;
// and never while the socket is down: each re-creation would leave a join and
// a leave in realtime-js's send buffer, all flushed in one burst on reconnect.
// It is re-created with channel.unsubscribe(), not removeChannel(): removing
// the last channel disconnects the socket, and connect() is ignored while it
// is still 'disconnecting'. A drop of the socket reports CHANNEL_ERROR twice
// (error + close), so only failures while it is connected count.
const RECREATE_AFTER_FAILURES = 3;
const RECREATE_AFTER_STALL_MS = 20_000;
const REJOIN_MIN_MS = 1_000;
const REJOIN_MAX_MS = 30_000;
/** Retry of connect() while the socket is still 'disconnecting' (at most 100 ms in realtime-js). */
const SOCKET_RETRY_MS = 150;
/**
 * A second RESYNC this long after every join: the first join of an idle
 * Realtime tenant starts its broadcast replication, and writes in that first
 * ~0.5 s are not delivered (local measurement, supabase/README.md).
 */
export const FOLLOWUP_RESYNC_MS = 3_000;

/** Wait before the n-th re-creation since the last join (n from 0): 1 s, 2 s, 4 s ... 30 s. */
export function rejoinDelay(attempt: number): number {
    return Math.min(REJOIN_MAX_MS, REJOIN_MIN_MS * 2 ** attempt);
}

/**
 * Joins the org's private channel and keeps it joined: RESYNC on EVERY
 * SUBSCRIBED (the first included: whatever changed before the join exists
 * only in the database) and again FOLLOWUP_RESYNC_MS later, re-creation with
 * capped exponential backoff after a server-side close or failed or stalled
 * joins on a connected socket, and nothing after stop(). Logs status changes
 * only, never payloads.
 */
export function startOrgChannel(
    client: OrgRealtimeClient,
    orgId: string,
    handlers: OrgChannelHandlers,
): OrgChannelController {
    const topic = orgTopic(orgId);
    const socket = client.realtime;
    let channel: OrgChannel | null = null;
    let stopped = false;
    // True while this code removes a channel itself: the CLOSED that
    // unsubscribe / removeChannel reports is ours, not a server-side close.
    let tearingDown = false;
    let failures = 0; // failed joins of the current channel while the socket was connected
    let attempt = 0; // re-creations since the last SUBSCRIBED
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let socketTimer: ReturnType<typeof setTimeout> | undefined;
    let followupTimer: ReturnType<typeof setTimeout> | undefined;
    // The socket connection seen 'connecting' at the last stall check.
    let connectingConn: unknown = null;
    let status: OrgRealtimeStatus = 'connecting';

    const report = (next: OrgRealtimeStatus, detail: string) => {
        if (next === status) return;
        status = next;
        console.info(`[realtime] ${topic} ${next} (${detail})`);
        handlers.onStatus(next);
    };

    const clearTimers = () => {
        clearTimeout(retryTimer);
        clearTimeout(stallTimer);
        clearTimeout(socketTimer);
        retryTimer = undefined;
        stallTimer = undefined;
        socketTimer = undefined;
    };

    /** Drops a channel this code no longer wants; its CLOSED is ignored. */
    const drop = async (ch: OrgChannel, how: 'unsubscribe' | 'remove') => {
        tearingDown = true;
        try {
            // remove also disconnects the socket when it was the last channel
            // (only on stop); unsubscribe leaves the socket alone.
            await (how === 'remove' ? client.removeChannel(ch) : ch.unsubscribe());
        } catch {
            // already gone from the socket
        } finally {
            tearingDown = false;
        }
    };

    // A channel waiting for its join needs a socket that is connecting or
    // open. subscribe() connects an idle socket itself, but connect() is a
    // no-op while the socket is still 'disconnecting' (after the
    // removeChannel of a previous provider, e.g. a remount): try again then.
    // Never called on a socket error, so it cannot spin while offline:
    // realtime-js reconnects with its own backoff.
    const ensureSocket = () => {
        clearTimeout(socketTimer);
        socketTimer = undefined;
        if (stopped || socket.isConnected() || socket.isConnecting()) return;
        if (socket.isDisconnecting()) {
            socketTimer = setTimeout(ensureSocket, SOCKET_RETRY_MS);
            return;
        }
        socket.connect();
    };

    const armStall = () => {
        if (stallTimer === undefined) stallTimer = setTimeout(onStall, RECREATE_AFTER_STALL_MS);
    };

    // Fails a pending connect attempt (realtime-js sees error + close and the
    // channel rejoins after the next connect) and connects again right away
    // rather than after realtime-js's backoff (up to 10 s).
    const retryConnect = (conn: { close(code?: number, reason?: string): void }, why: string) => {
        connectingConn = null;
        console.info(`[realtime] ${topic} ${why}, connecting again`);
        conn.close(1000, why);
        clearTimeout(socketTimer);
        socketTimer = setTimeout(ensureSocket, SOCKET_RETRY_MS);
    };

    // No join for a while: on a connected socket the channel is stuck, so it
    // is re-created; on a socket that is down, the socket gets a nudge and
    // the channel waits for realtime-js to rejoin it. A connect attempt still
    // pending a whole stall period later hangs (no error, no close: a silent
    // network); closing it makes realtime-js fail it and try again.
    const onStall = () => {
        stallTimer = undefined;
        if (stopped) return;
        if (socket.isConnected()) {
            connectingConn = null;
            void recreate();
            return;
        }
        if (socket.isConnecting()) {
            const conn = socket.conn ?? null;
            if (conn && conn === connectingConn) retryConnect(conn, 'connect stalled');
            else connectingConn = conn;
        } else {
            connectingConn = null;
            ensureSocket();
        }
        armStall();
    };

    const open = async () => {
        retryTimer = undefined;
        try {
            // A current token in the join (the session may have been refreshed
            // meanwhile); supabase-js re-sends it on every heartbeat as well.
            await socket.setAuth();
        } catch {
            // join with the token the socket already has
        }
        if (stopped) return;
        const ch = client.channel(topic, { config: { private: true } });
        channel = ch;
        failures = 0;
        ch.on('broadcast', { event: '*' }, (message) => {
            if (ch !== channel) return;
            const event = parseOrgEvent(message);
            if (event) handlers.onEvent(event);
        }).subscribe((st, err) => onChannelStatus(ch, st, err));
        ensureSocket();
        armStall();
    };

    const recreate = async () => {
        clearTimers();
        const old = channel;
        channel = null;
        if (old) await drop(old, 'unsubscribe');
        if (stopped) return;
        const delay = rejoinDelay(attempt);
        attempt += 1;
        console.info(`[realtime] ${topic} re-joining in ${delay / 1000} s`);
        retryTimer = setTimeout(() => void open(), delay);
    };

    const onChannelStatus = (ch: OrgChannel, st: string, err?: Error) => {
        if (stopped || tearingDown || ch !== channel) return;
        if (st === 'SUBSCRIBED') {
            failures = 0;
            attempt = 0;
            clearTimeout(stallTimer);
            stallTimer = undefined;
            report('live', st);
            handlers.onResync();
            clearTimeout(followupTimer);
            followupTimer = setTimeout(() => {
                followupTimer = undefined;
                if (!stopped) handlers.onResync();
            }, FOLLOWUP_RESYNC_MS);
            return;
        }
        report('paused', err?.message ? `${st}: ${err.message}` : st);
        if (st === 'CLOSED') {
            void recreate();
            return;
        }
        // CHANNEL_ERROR / TIMED_OUT: realtime-js rejoins by itself. Re-create
        // only when joins keep failing on a connected socket (a refused or
        // lost join); a socket drop is not a failed join.
        if (socket.isConnected()) {
            failures += 1;
            if (failures >= RECREATE_AFTER_FAILURES) {
                void recreate();
                return;
            }
        }
        armStall();
    };

    void open();

    return {
        wake() {
            if (stopped) return;
            // Back online or visible: a connect attempt still pending from
            // before most likely hangs on the dead network; redo it now.
            const conn = socket.isConnecting() ? (socket.conn ?? null) : null;
            if (conn) retryConnect(conn, 'woke up while connecting');
            else ensureSocket();
            if (retryTimer === undefined) return;
            clearTimeout(retryTimer);
            retryTimer = undefined;
            void open();
        },
        stop() {
            if (stopped) return;
            stopped = true;
            clearTimers();
            clearTimeout(followupTimer);
            followupTimer = undefined;
            const old = channel;
            channel = null;
            if (old) void drop(old, 'remove');
        },
    };
}

/**
 * Calls `onWake` when the tab becomes visible again and when the device comes
 * back online (events can be missed while offline, and background timers are
 * throttled); returns the cleanup. Not gated on visibility for 'online': the
 * in-tab notifier alerts while the tab is hidden.
 */
export function watchWake(
    doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
    win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    onWake: () => void,
): () => void {
    const onVisibility = () => {
        if (doc.visibilityState === 'visible') onWake();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('online', onWake);
    return () => {
        doc.removeEventListener('visibilitychange', onVisibility);
        win.removeEventListener('online', onWake);
    };
}

const OrgEventBusContext = createContext<OrgEventBus | null>(null);
const OrgRealtimeStatusContext = createContext<OrgRealtimeStatus>('off');

export function OrgRealtimeProvider({ children }: { children: React.ReactNode }) {
    const orgId = useCurrentOrgId();
    const [bus] = useState(createOrgEventBus);
    const [status, setStatus] = useState<OrgRealtimeStatus>('connecting');

    useEffect(() => {
        if (!orgId) return;
        const channel = startOrgChannel(createClient(), orgId, {
            onEvent: (event) => bus.emit(event),
            onResync: () => bus.emit(RESYNC),
            onStatus: setStatus,
        });
        // Back from offline or a sleeping tab: refetch, and re-join now if a
        // backoff is pending.
        const unwatch = watchWake(document, window, () => {
            channel.wake();
            bus.emit(RESYNC);
        });
        return () => {
            unwatch();
            channel.stop();
        };
    }, [orgId, bus]);

    return (
        <OrgEventBusContext.Provider value={bus}>
            <OrgRealtimeStatusContext.Provider value={orgId ? status : 'off'}>
                {children}
            </OrgRealtimeStatusContext.Provider>
        </OrgEventBusContext.Provider>
    );
}

/** The tab's live-update state, e.g. for a "live updates paused" hint. */
export function useOrgRealtimeStatus(): OrgRealtimeStatus {
    return useContext(OrgRealtimeStatusContext);
}

/**
 * Calls `handler` for every event of `tables` and for every RESYNC. The
 * handler lives in a ref, so passing a new one on each render never
 * resubscribes. A no-op outside OrgRealtimeProvider.
 */
export function useOrgRealtime(
    tables: OrgEventTable | readonly OrgEventTable[],
    handler: (signal: OrgSignal) => void,
): void {
    const bus = useContext(OrgEventBusContext);
    const handlerRef = useRef(handler);
    useLayoutEffect(() => {
        handlerRef.current = handler;
    });
    const key = typeof tables === 'string' ? tables : tables.join(',');
    useEffect(() => {
        if (!bus) return;
        return bus.subscribe(key.split(',') as OrgEventTable[], (signal) => handlerRef.current(signal));
    }, [bus, key]);
}

/**
 * A stable function that runs the latest `fn` coalesced (see coalesce in
 * lib/realtime/org-events.ts); a pending run is dropped on unmount.
 */
export function useCoalesced(fn: () => unknown, options?: CoalesceOptions): () => void {
    const fnRef = useRef(fn);
    const runRef = useRef<Coalesced | null>(null);
    useLayoutEffect(() => {
        fnRef.current = fn;
    });
    const wait = options?.wait;
    const maxWait = options?.maxWait;
    useEffect(() => {
        const run = coalesce(() => fnRef.current(), { wait, maxWait });
        runRef.current = run;
        return () => {
            run.cancel();
            runRef.current = null;
        };
    }, [wait, maxWait]);
    return useCallback(() => runRef.current?.(), []);
}

/** Runs `refetch` (coalesced) on every event of `tables` and every RESYNC. */
export function useOrgRefetch(tables: OrgEventTable | readonly OrgEventTable[], refetch: () => unknown): void {
    const refetchSoon = useCoalesced(refetch);
    useOrgRealtime(tables, refetchSoon);
}
