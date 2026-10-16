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
}

export interface OrgRealtimeClient {
    channel(topic: string, options: { config: { private: boolean } }): OrgChannel;
    removeChannel(channel: OrgChannel): Promise<unknown>;
    realtime: { setAuth(token?: string | null): Promise<void> };
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

// realtime-js rejoins an errored channel by itself (socket drop -> reconnect
// -> SUBSCRIBED again). It never rejoins a CLOSED one: the server closes a
// channel on an expired token ("Token has expired"), revoked access or a rate
// limit. Re-create the channel then, and also when its own rejoins keep
// failing or stop (its reconnect waits for a close event that a refused
// WebSocket connect does not always fire).
const RECREATE_AFTER_FAILURES = 3;
const RECREATE_AFTER_STALL_MS = 20_000;
const REJOIN_MIN_MS = 1_000;
const REJOIN_MAX_MS = 30_000;

/** Wait before the n-th re-creation since the last join (n from 0): 1 s, 2 s, 4 s ... 30 s. */
export function rejoinDelay(attempt: number): number {
    return Math.min(REJOIN_MAX_MS, REJOIN_MIN_MS * 2 ** attempt);
}

/**
 * Joins the org's private channel and keeps it joined: RESYNC on EVERY
 * SUBSCRIBED (the first included: whatever changed before the join exists
 * only in the database), re-creation with capped exponential backoff after a
 * server-side close or a run of failed rejoins, and nothing after stop().
 * Logs status changes only, never payloads.
 */
export function startOrgChannel(
    client: OrgRealtimeClient,
    orgId: string,
    handlers: OrgChannelHandlers,
): OrgChannelController {
    const topic = orgTopic(orgId);
    let channel: OrgChannel | null = null;
    let stopped = false;
    // True while this code removes a channel itself: the CLOSED that
    // removeChannel reports is ours, not a server-side close.
    let tearingDown = false;
    let failures = 0; // failed join attempts of the current channel
    let attempt = 0; // re-creations since the last SUBSCRIBED
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
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
        retryTimer = undefined;
        stallTimer = undefined;
    };

    const remove = async (ch: OrgChannel) => {
        tearingDown = true;
        try {
            await client.removeChannel(ch);
        } catch {
            // already gone from the socket
        } finally {
            tearingDown = false;
        }
    };

    const open = async () => {
        retryTimer = undefined;
        try {
            // A current token in the join (the session may have been refreshed
            // meanwhile); supabase-js re-sends it on every heartbeat as well.
            await client.realtime.setAuth();
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
    };

    const recreate = async () => {
        clearTimers();
        const old = channel;
        channel = null;
        if (old) await remove(old);
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
            return;
        }
        report('paused', err?.message ? `${st}: ${err.message}` : st);
        if (st === 'CLOSED') {
            void recreate();
            return;
        }
        // CHANNEL_ERROR / TIMED_OUT: let realtime-js rejoin, unless it keeps
        // failing or stops trying (e.g. a socket that never reconnects).
        failures += 1;
        if (failures >= RECREATE_AFTER_FAILURES) {
            void recreate();
        } else if (stallTimer === undefined) {
            stallTimer = setTimeout(() => void recreate(), RECREATE_AFTER_STALL_MS);
        }
    };

    void open();

    return {
        wake() {
            if (stopped || retryTimer === undefined) return;
            clearTimeout(retryTimer);
            retryTimer = undefined;
            void open();
        },
        stop() {
            if (stopped) return;
            stopped = true;
            clearTimers();
            const old = channel;
            channel = null;
            if (old) void remove(old);
        },
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
        // Events can be missed while the device was offline or the tab
        // slept (background timers are throttled): refetch, and re-join now
        // if a backoff is pending. Not gated on visibility for 'online': the
        // in-tab notifier alerts while the tab is hidden.
        const resync = () => {
            channel.wake();
            bus.emit(RESYNC);
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') resync();
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('online', resync);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('online', resync);
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
