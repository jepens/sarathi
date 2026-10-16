import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    rejoinDelay,
    startOrgChannel,
    type OrgChannel,
    type OrgRealtimeClient,
    type OrgRealtimeStatus,
} from '@/components/realtime/org-realtime-provider';
import type { OrgEvent } from '@/lib/realtime/org-events';

// The tab's org channel (components/realtime/org-realtime-provider.tsx) as a
// state machine, against a fake supabase-js client that behaves like
// realtime-js 2.86 where it matters: removeChannel() reports CLOSED to the
// subscribe callback (unsubscribe -> phx_close hooks), a server-side close is
// final, and channel() hands out a new channel for a removed topic.

const ORG = '5A11E024-0001-4000-8000-000000000001';
const TOPIC = 'org:5a11e024-0001-4000-8000-000000000001';

class FakeChannel implements OrgChannel {
    statusCallback?: (status: string, err?: Error) => void;
    messageCallback?: (message: unknown) => void;
    removed = false;
    constructor(
        readonly topic: string,
        readonly options: { config: { private: boolean } },
    ) {}
    on(_type: 'broadcast', _filter: { event: string }, callback: (message: unknown) => void) {
        this.messageCallback = callback;
        return this;
    }
    subscribe(callback: (status: string, err?: Error) => void) {
        this.statusCallback = callback;
        return this;
    }
    /** What the server / realtime-js reports for this channel. */
    status(status: string, err?: Error) {
        this.statusCallback?.(status, err);
    }
    broadcast(message: unknown) {
        this.messageCallback?.(message);
    }
}

function fakeClient() {
    const channels: FakeChannel[] = [];
    const calls: string[] = [];
    const client: OrgRealtimeClient = {
        channel: vi.fn((topic: string, options: { config: { private: boolean } }) => {
            calls.push('channel');
            const ch = new FakeChannel(topic, options);
            channels.push(ch);
            return ch;
        }),
        removeChannel: vi.fn(async (ch: OrgChannel) => {
            calls.push('removeChannel');
            const fake = ch as FakeChannel;
            fake.removed = true;
            fake.status('CLOSED'); // realtime-js: unsubscribe triggers the close hooks
            return 'ok';
        }),
        realtime: {
            setAuth: vi.fn(async () => {
                calls.push('setAuth');
            }),
        },
    };
    return { client, channels, calls };
}

function start(client: OrgRealtimeClient) {
    const events: OrgEvent[] = [];
    const statuses: OrgRealtimeStatus[] = [];
    const onResync = vi.fn();
    const controller = startOrgChannel(client, ORG, {
        onEvent: (e) => events.push(e),
        onResync,
        onStatus: (s) => statuses.push(s),
    });
    return { controller, events, statuses, onResync };
}

const labelsInsert = {
    type: 'broadcast',
    event: 'labels',
    payload: { v: 1, table: 'labels', op: 'INSERT', n: 1, ids: ['0b0e6a52-5f3c-4c1e-9d7a-1f2e3d4c5b6a'] },
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('rejoinDelay', () => {
    it('backs off exponentially from 1 s, capped at 30 s', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 20].map(rejoinDelay)).toEqual([
            1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
        ]);
    });
});

describe('startOrgChannel', () => {
    it('sets the auth token, then joins ONE private channel on the lower-case org topic', async () => {
        const { client, channels, calls } = fakeClient();
        start(client);
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual(['setAuth', 'channel']);
        expect(channels).toHaveLength(1);
        expect(channels[0].topic).toBe(TOPIC);
        expect(channels[0].options).toEqual({ config: { private: true } });
    });

    it('forwards parsed broadcasts and drops malformed ones', async () => {
        const { client, channels } = fakeClient();
        const { events } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        channels[0].status('SUBSCRIBED');
        channels[0].broadcast(labelsInsert);
        channels[0].broadcast({ event: 'labels', payload: { v: 2, table: 'labels', op: 'INSERT', n: 1, ids: [] } });
        channels[0].broadcast('garbage');
        expect(events).toEqual([
            { table: 'labels', op: 'INSERT', n: 1, ids: ['0b0e6a52-5f3c-4c1e-9d7a-1f2e3d4c5b6a'], truncated: false },
        ]);
    });

    it('SUBSCRIBED -> CHANNEL_ERROR -> SUBSCRIBED: RESYNC on every join, realtime-js rejoins (no re-create)', async () => {
        const { client, channels } = fakeClient();
        const { statuses, onResync } = start(client);
        await vi.advanceTimersByTimeAsync(0);

        channels[0].status('SUBSCRIBED');
        expect(onResync).toHaveBeenCalledTimes(1); // the first join too
        channels[0].status('CHANNEL_ERROR', new Error('socket closed'));
        channels[0].status('SUBSCRIBED'); // realtime-js rejoined after the reconnect
        expect(onResync).toHaveBeenCalledTimes(2);
        expect(statuses).toEqual(['live', 'paused', 'live']);

        await vi.advanceTimersByTimeAsync(120_000);
        expect(client.removeChannel).not.toHaveBeenCalled();
        expect(channels).toHaveLength(1);
    });

    it('SUBSCRIBED -> CLOSED (server-side) -> re-created after the backoff -> SUBSCRIBED', async () => {
        const { client, channels, calls } = fakeClient();
        const { statuses, onResync, events } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        channels[0].status('SUBSCRIBED');

        // e.g. the token expired: the server closes the channel; realtime-js never rejoins it.
        channels[0].status('CLOSED');
        await vi.advanceTimersByTimeAsync(0);
        expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
        expect(channels).toHaveLength(1); // the CLOSED our removeChannel reported re-created nothing
        expect(statuses).toEqual(['live', 'paused']);

        await vi.advanceTimersByTimeAsync(999);
        expect(channels).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(channels).toHaveLength(2);
        expect(calls).toEqual(['setAuth', 'channel', 'removeChannel', 'setAuth', 'channel']);
        expect(channels[1].topic).toBe(TOPIC);
        expect(channels[1].options).toEqual({ config: { private: true } });

        channels[1].status('SUBSCRIBED');
        expect(onResync).toHaveBeenCalledTimes(2);
        expect(statuses).toEqual(['live', 'paused', 'live']);

        // The removed channel is dead to us: late messages and statuses are ignored.
        channels[0].broadcast(labelsInsert);
        channels[0].status('CLOSED');
        expect(events).toEqual([]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(channels).toHaveLength(2);
    });

    it('backs off 1 s, 2 s, 4 s ... while the re-created channels keep closing, and resets after a join', async () => {
        const { client, channels } = fakeClient();
        start(client);
        await vi.advanceTimersByTimeAsync(0);

        const closeAndWait = async (expectedDelay: number) => {
            const n = channels.length;
            channels[n - 1].status('CLOSED');
            await vi.advanceTimersByTimeAsync(expectedDelay - 1);
            expect(channels).toHaveLength(n);
            await vi.advanceTimersByTimeAsync(1);
            expect(channels).toHaveLength(n + 1);
        };
        await closeAndWait(1000);
        await closeAndWait(2000);
        await closeAndWait(4000);
        await closeAndWait(8000);
        channels[channels.length - 1].status('SUBSCRIBED');
        await closeAndWait(1000);
    });

    it('re-creates the channel after repeated join failures (e.g. a refused or timed-out join)', async () => {
        const { client, channels } = fakeClient();
        const { statuses } = start(client);
        await vi.advanceTimersByTimeAsync(0);

        channels[0].status('CHANNEL_ERROR', new Error('Unauthorized'));
        channels[0].status('TIMED_OUT');
        expect(client.removeChannel).not.toHaveBeenCalled();
        channels[0].status('CHANNEL_ERROR', new Error('Unauthorized'));
        await vi.advanceTimersByTimeAsync(0);
        expect(client.removeChannel).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(channels).toHaveLength(2);
        expect(statuses).toEqual(['paused']);
    });

    it('re-creates a channel whose rejoin never happens (one failure, then silence)', async () => {
        const { client, channels } = fakeClient();
        start(client);
        await vi.advanceTimersByTimeAsync(0);
        channels[0].status('SUBSCRIBED');

        channels[0].status('TIMED_OUT');
        await vi.advanceTimersByTimeAsync(19_999);
        expect(client.removeChannel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(client.removeChannel).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(channels).toHaveLength(2);
    });

    it('wake() skips the rest of a backoff', async () => {
        const { client, channels } = fakeClient();
        const { controller } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        channels[0].status('CLOSED');
        await vi.advanceTimersByTimeAsync(0);
        expect(channels).toHaveLength(1);
        controller.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(channels).toHaveLength(2);
        // ...and only once: the pending timer is gone.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(channels).toHaveLength(2);
        expect(client.channel).toHaveBeenCalledTimes(2);
    });

    it('stop() (unmount) removes the channel and never re-creates it', async () => {
        const { client, channels } = fakeClient();
        const { controller, statuses, onResync, events } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        channels[0].status('SUBSCRIBED');

        controller.stop(); // removeChannel reports CLOSED synchronously here
        await vi.advanceTimersByTimeAsync(0);
        expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
        channels[0].broadcast(labelsInsert);
        channels[0].status('SUBSCRIBED');
        await vi.advanceTimersByTimeAsync(120_000);

        expect(channels).toHaveLength(1);
        expect(onResync).toHaveBeenCalledTimes(1);
        expect(statuses).toEqual(['live']);
        expect(events).toEqual([]);
    });

    it('stop() during a backoff or before the first join creates no channel', async () => {
        const a = fakeClient();
        const first = start(a.client);
        await vi.advanceTimersByTimeAsync(0);
        a.channels[0].status('CLOSED');
        await vi.advanceTimersByTimeAsync(0);
        first.controller.stop();
        first.controller.wake();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(a.channels).toHaveLength(1);

        const b = fakeClient();
        const second = start(b.client); // setAuth still pending
        second.controller.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(b.client.channel).not.toHaveBeenCalled();
    });
});
