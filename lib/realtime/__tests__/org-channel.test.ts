import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
    FOLLOWUP_RESYNC_MS,
    rejoinDelay,
    startOrgChannel,
    watchWake,
    type OrgChannel,
    type OrgRealtimeClient,
    type OrgRealtimeStatus,
} from '@/components/realtime/org-realtime-provider';
import type { OrgEvent } from '@/lib/realtime/org-events';

// The tab's org channel (components/realtime/org-realtime-provider.tsx) as a
// state machine, against a fake supabase-js client that behaves like
// realtime-js 2.86 where it matters:
// - channel() returns the existing channel of a topic that is still listed;
// - subscribe() connects an idle socket; connect() is a no-op while the socket
//   is connecting, open or 'disconnecting';
// - unsubscribe() reports CLOSED to the subscribe callback and unlists the
//   channel; removeChannel() unsubscribes and, when no channel is left,
//   disconnects the socket ('disconnecting' for 100 ms);
// - a join or leave pushed while the socket is not open waits in the send
//   buffer until the socket opens;
// - a failed connect reports CHANNEL_ERROR twice (error + close), a dropped
//   socket once.

const ORG = '5A11E024-0001-4000-8000-000000000001';
const TOPIC = 'org:5a11e024-0001-4000-8000-000000000001';

type SocketState = 'closed' | 'connecting' | 'open' | 'disconnecting';

class FakeSocket {
    state: SocketState = 'closed';
    connects = 0;
    /** The pending or open connection (RealtimeClient.conn); close() fails a pending connect. */
    conn: { close: Mock<(code?: number, reason?: string) => void> } | null = null;
    disconnects = 0;
    sendBuffer: string[] = [];
    sent: string[] = [];
    channels: FakeChannel[] = [];
    setAuth = vi.fn(async () => {});
    connect() {
        if (this.state !== 'closed') return;
        this.state = 'connecting';
        this.connects += 1;
        const conn = {
            close: vi.fn<(code?: number, reason?: string) => void>(() => {
                if (this.conn === conn && this.state === 'connecting') this.failConnect();
            }),
        };
        this.conn = conn;
    }
    isConnected() {
        return this.state === 'open';
    }
    isConnecting() {
        return this.state === 'connecting';
    }
    isDisconnecting() {
        return this.state === 'disconnecting';
    }
    disconnect() {
        if (this.state === 'disconnecting') return;
        this.disconnects += 1;
        this.state = 'disconnecting';
        setTimeout(() => {
            this.state = 'closed';
        }, 100);
    }
    push(what: string) {
        if (this.state === 'open') this.sent.push(what);
        else this.sendBuffer.push(what);
    }
    /** The pending connect succeeded: the buffer is flushed. */
    opened() {
        this.state = 'open';
        this.sent.push(...this.sendBuffer);
        this.sendBuffer = [];
    }
    /** A connect attempt failed: error + close each report CHANNEL_ERROR. */
    failConnect() {
        this.state = 'closed';
        for (const ch of [...this.channels]) {
            ch.status('CHANNEL_ERROR', new Error('error'));
            ch.status('CHANNEL_ERROR', new Error('close'));
        }
    }
    /** An open socket dropped. */
    drop() {
        this.state = 'closed';
        for (const ch of [...this.channels]) ch.status('CHANNEL_ERROR', new Error('close'));
    }
}

class FakeChannel implements OrgChannel {
    statusCallback?: (status: string, err?: Error) => void;
    messageCallback?: (message: unknown) => void;
    removed = false;
    /** Inside realtime-js's own _rejoin (see selfLeaveDuringRejoin). */
    inRejoin = false;
    /** Dropped but still 'joining' with a live rejoin timer: it would close every later channel of the topic. */
    zombie = false;
    constructor(
        readonly socket: FakeSocket,
        readonly topic: string,
        readonly options: { config: { private: boolean } },
    ) {}
    on(_type: 'broadcast', _filter: { event: string }, callback: (message: unknown) => void) {
        this.messageCallback = callback;
        return this;
    }
    subscribe(callback: (status: string, err?: Error) => void) {
        this.statusCallback = callback;
        if (!this.socket.isConnected()) this.socket.connect();
        this.socket.push(`join ${this.topic}`);
        return this;
    }
    async unsubscribe() {
        // An unsubscribe from outside the rejoin cancels the resent join and
        // the rejoin timer (realtime-js: joinPush.destroy, rejoinTimer.reset).
        if (!this.inRejoin) this.zombie = false;
        this.socket.push(`leave ${this.topic}`);
        this.removed = true;
        this.socket.channels = this.socket.channels.filter((c) => c !== this);
        this.status('CLOSED');
        return 'ok';
    }
    /** What the server / realtime-js reports for this channel. */
    status(status: string, err?: Error) {
        this.statusCallback?.(status, err);
    }
    /**
     * realtime-js 2.86 when a rejoin reply is late: _rejoinUntilConnected ->
     * _rejoin -> socket._leaveOpenTopic(topic) finds this very channel
     * (joining) and unsubscribes it (CLOSED to the callback); then _rejoin
     * goes on: state 'joining', the join is resent, the rejoin timer runs.
     */
    selfLeaveDuringRejoin() {
        this.inRejoin = true;
        void this.unsubscribe();
        this.inRejoin = false;
        this.zombie = true;
    }
    broadcast(message: unknown) {
        this.messageCallback?.(message);
    }
}

function fakeClient() {
    const socket = new FakeSocket();
    const created: FakeChannel[] = [];
    const calls: string[] = [];
    socket.setAuth.mockImplementation(async () => {
        calls.push('setAuth');
    });
    const client: OrgRealtimeClient = {
        channel: vi.fn((topic: string, options: { config: { private: boolean } }) => {
            calls.push('channel');
            const listed = socket.channels.find((c) => c.topic === topic);
            if (listed) return listed;
            const ch = new FakeChannel(socket, topic, options);
            socket.channels.push(ch);
            created.push(ch);
            return ch;
        }),
        removeChannel: vi.fn(async (ch: OrgChannel) => {
            calls.push('removeChannel');
            await ch.unsubscribe();
            if (socket.channels.length === 0) socket.disconnect();
            return 'ok';
        }),
        realtime: socket,
    };
    return { client, socket, channels: created, calls };
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
        const { client, socket, channels, calls } = fakeClient();
        start(client);
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual(['setAuth', 'channel']);
        expect(channels).toHaveLength(1);
        expect(channels[0].topic).toBe(TOPIC);
        expect(channels[0].options).toEqual({ config: { private: true } });
        expect(socket.connects).toBe(1);
        socket.opened();
        expect(socket.sent).toEqual([`join ${TOPIC}`]);
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

    it('RESYNC on every SUBSCRIBED and once more shortly after it (first-join replication gap)', async () => {
        const { client, socket, channels } = fakeClient();
        const { statuses, onResync } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();

        channels[0].status('SUBSCRIBED');
        expect(onResync).toHaveBeenCalledTimes(1); // the first join too
        await vi.advanceTimersByTimeAsync(FOLLOWUP_RESYNC_MS - 1);
        expect(onResync).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(onResync).toHaveBeenCalledTimes(2);

        socket.drop();
        socket.opened();
        channels[0].status('SUBSCRIBED'); // realtime-js rejoined after the reconnect
        expect(onResync).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(FOLLOWUP_RESYNC_MS);
        expect(onResync).toHaveBeenCalledTimes(4);
        expect(statuses).toEqual(['live', 'paused', 'live']);

        await vi.advanceTimersByTimeAsync(120_000);
        expect(channels).toHaveLength(1); // no re-creation
        expect(onResync).toHaveBeenCalledTimes(4);
    });

    it('SUBSCRIBED -> CLOSED (server-side) -> re-created with unsubscribe after the backoff; the socket stays up', async () => {
        const { client, socket, channels, calls } = fakeClient();
        const { statuses, onResync, events } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();
        channels[0].status('SUBSCRIBED');

        // e.g. the token expired: the server closes the channel; realtime-js never rejoins it.
        channels[0].status('CLOSED');
        await vi.advanceTimersByTimeAsync(0);
        expect(channels[0].removed).toBe(true);
        expect(client.removeChannel).not.toHaveBeenCalled();
        expect(socket.disconnects).toBe(0);
        expect(channels).toHaveLength(1); // the CLOSED our unsubscribe reported re-created nothing
        expect(statuses).toEqual(['live', 'paused']);

        await vi.advanceTimersByTimeAsync(999);
        expect(channels).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(channels).toHaveLength(2);
        expect(calls).toEqual(['setAuth', 'channel', 'setAuth', 'channel']);
        expect(channels[1].topic).toBe(TOPIC);
        expect(channels[1].options).toEqual({ config: { private: true } });
        expect(socket.sendBuffer).toEqual([]); // the new join went out at once

        channels[1].status('SUBSCRIBED');
        // The 2nd join came within 3 s of the 1st: one follow-up, re-armed.
        expect(onResync).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(FOLLOWUP_RESYNC_MS);
        expect(onResync).toHaveBeenCalledTimes(3);
        expect(statuses).toEqual(['live', 'paused', 'live']);

        // The dropped channel is dead to us: late messages and statuses are ignored.
        channels[0].broadcast(labelsInsert);
        channels[0].status('CLOSED');
        expect(events).toEqual([]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(channels).toHaveLength(2);
    });

    it('a channel realtime-js closes inside its own rejoin is dropped one task later, so no zombie survives', async () => {
        const { client, socket, channels } = fakeClient();
        const { statuses } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();
        channels[0].status('SUBSCRIBED');

        channels[0].selfLeaveDuringRejoin();
        expect(channels[0].zombie).toBe(true); // realtime-js went on with the dropped channel
        await vi.advanceTimersByTimeAsync(0);
        expect(channels[0].zombie).toBe(false); // the provider's later unsubscribe cancelled that rejoin
        await vi.advanceTimersByTimeAsync(1000);
        expect(channels).toHaveLength(2);
        channels[1].status('SUBSCRIBED');
        expect(statuses).toEqual(['live', 'paused', 'live']);
    });

    it('backs off 1 s, 2 s, 4 s ... while the re-created channels keep closing, and resets after a join', async () => {
        const { client, socket, channels } = fakeClient();
        start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();

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

    it('re-creates the channel after repeated join failures on a connected socket (e.g. a refused join)', async () => {
        const { client, socket, channels } = fakeClient();
        const { statuses } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();

        channels[0].status('CHANNEL_ERROR', new Error('Unauthorized'));
        channels[0].status('TIMED_OUT');
        expect(channels[0].removed).toBe(false);
        channels[0].status('CHANNEL_ERROR', new Error('Unauthorized'));
        await vi.advanceTimersByTimeAsync(0);
        expect(channels[0].removed).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(channels).toHaveLength(2);
        expect(statuses).toEqual(['paused']);
        expect(socket.disconnects).toBe(0);
    });

    it('never re-creates while the socket is down: no join burst piles up for the reconnect', async () => {
        const { client, socket, channels } = fakeClient();
        const { statuses, onResync } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();
        channels[0].status('SUBSCRIBED');

        // A one-hour outage: the socket drops, then every connect attempt
        // fails (two CHANNEL_ERRORs each); realtime-js keeps retrying.
        socket.drop();
        for (let i = 0; i < 360; i += 1) {
            socket.connect(); // realtime-js's own reconnect timer
            socket.failConnect();
            await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(channels).toHaveLength(1);
        expect(channels[0].removed).toBe(false);
        // At most what the provider's own nudges add: no join or leave at all.
        expect(socket.sendBuffer).toEqual([]);
        expect(statuses).toEqual(['live', 'paused']);

        // Back online: realtime-js reconnects and rejoins the same channel.
        socket.connect();
        socket.opened();
        channels[0].status('SUBSCRIBED');
        expect(statuses).toEqual(['live', 'paused', 'live']);
        expect(onResync).toHaveBeenCalledTimes(3); // first join, its follow-up, the rejoin
        expect(socket.sent.filter((m) => m.startsWith('join'))).toHaveLength(1); // only the first join was ever sent
    });

    it('a stalled join on a connected socket is re-created; on a socket that is down only the socket is nudged', async () => {
        const a = fakeClient();
        start(a.client);
        await vi.advanceTimersByTimeAsync(0);
        a.socket.opened();
        a.channels[0].status('SUBSCRIBED');
        a.channels[0].status('TIMED_OUT');
        await vi.advanceTimersByTimeAsync(19_999);
        expect(a.channels[0].removed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(a.channels[0].removed).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(a.channels).toHaveLength(2);

        const b = fakeClient();
        start(b.client);
        await vi.advanceTimersByTimeAsync(0);
        b.socket.failConnect(); // the first connect fails; realtime-js would retry later
        expect(b.socket.connects).toBe(1);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(b.channels).toHaveLength(1); // not re-created while down
        expect(b.socket.connects).toBe(2); // ...but the idle socket was nudged
        expect(b.socket.sendBuffer).toEqual([`join ${TOPIC}`]); // still exactly one join waiting
        await vi.advanceTimersByTimeAsync(20_000);
        expect(b.socket.connects).toBe(2); // still connecting: no extra connect
    });

    it('wake() skips the rest of a backoff, and the new channel joins at once (no disconnecting window)', async () => {
        const { client, socket, channels } = fakeClient();
        const { controller, statuses } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();
        channels[0].status('SUBSCRIBED');
        channels[0].status('CLOSED');
        await vi.advanceTimersByTimeAsync(10);
        expect(channels).toHaveLength(1);
        controller.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(channels).toHaveLength(2);
        expect(socket.state).toBe('open');
        expect(socket.sent.at(-1)).toBe(`join ${TOPIC}`);
        channels[1].status('SUBSCRIBED');
        expect(statuses).toEqual(['live', 'paused', 'live']);
        // ...and only once: the pending timer is gone.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(channels).toHaveLength(2);
        expect(client.channel).toHaveBeenCalledTimes(2);
    });

    it('a connect that hangs for a whole stall period is failed and redone; the channel is kept', async () => {
        const { client, socket, channels } = fakeClient();
        start(client);
        await vi.advanceTimersByTimeAsync(0);
        const first = socket.conn!;
        expect(socket.state).toBe('connecting'); // the network swallows the attempt: no error, no close
        await vi.advanceTimersByTimeAsync(20_000);
        expect(first.close).not.toHaveBeenCalled(); // first sighting only
        await vi.advanceTimersByTimeAsync(20_000);
        expect(first.close).toHaveBeenCalledTimes(1); // the same attempt a stall period later
        await vi.advanceTimersByTimeAsync(150);
        expect(socket.connects).toBe(2); // connected again at once, not after realtime-js's backoff
        expect(socket.conn).not.toBe(first);
        expect(channels).toHaveLength(1);
        expect(channels[0].removed).toBe(false);
        socket.opened();
        channels[0].status('SUBSCRIBED'); // realtime-js rejoined the same channel
    });

    it('wake() during a pending connect redoes it at once (it most likely hangs on the dead network)', async () => {
        const { client, socket, channels } = fakeClient();
        const { controller } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        const pending = socket.conn!;
        controller.wake();
        expect(pending.close).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(150);
        expect(socket.connects).toBe(2);
        expect(channels).toHaveLength(1);
    });

    it('wake() connects an idle socket without re-creating a joined channel', async () => {
        const { client, socket, channels } = fakeClient();
        const { controller } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.failConnect();
        expect(socket.state).toBe('closed');
        controller.wake();
        expect(socket.connects).toBe(2);
        expect(channels).toHaveLength(1);
    });

    it('stop() (unmount) removes the channel, closes the socket and never re-creates it', async () => {
        const { client, socket, channels } = fakeClient();
        const { controller, statuses, onResync, events } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();
        channels[0].status('SUBSCRIBED');

        controller.stop(); // removeChannel reports CLOSED synchronously here
        await vi.advanceTimersByTimeAsync(0);
        expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
        expect(socket.disconnects).toBe(1);
        channels[0].broadcast(labelsInsert);
        channels[0].status('SUBSCRIBED');
        await vi.advanceTimersByTimeAsync(120_000);

        expect(channels).toHaveLength(1);
        expect(onResync).toHaveBeenCalledTimes(1); // the follow-up RESYNC was cancelled too
        expect(statuses).toEqual(['live']);
        expect(events).toEqual([]);
    });

    it('a remount right after an unmount joins within a moment, not after the 10 s timeout + 20 s stall', async () => {
        const { client, socket, channels } = fakeClient();
        const first = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();
        channels[0].status('SUBSCRIBED');

        const connectsBefore = socket.connects;
        first.controller.stop();
        const second = start(client); // same tab, same org (org change, Fast Refresh)
        await vi.advanceTimersByTimeAsync(0);
        expect(socket.state).toBe('disconnecting'); // removeChannel closed the socket
        expect(channels).toHaveLength(2);
        expect(socket.connects).toBe(connectsBefore); // subscribe's connect() was ignored
        await vi.advanceTimersByTimeAsync(150);
        expect(socket.connects).toBe(connectsBefore + 1); // ...and retried once the socket was down
        socket.opened();
        channels[1].status('SUBSCRIBED');
        expect(second.statuses).toEqual(['live']);
    });

    it('stop() during a re-create backoff still closes the socket (no channel left)', async () => {
        const { client, socket, channels } = fakeClient();
        const { controller } = start(client);
        await vi.advanceTimersByTimeAsync(0);
        socket.opened();
        channels[0].status('SUBSCRIBED');
        channels[0].status('CLOSED');
        await vi.advanceTimersByTimeAsync(300); // inside the 1 s backoff: no channel
        expect(socket.state).toBe('open');
        controller.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
        expect(socket.disconnects).toBe(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(channels).toHaveLength(1);
    });

    it('stop() during a backoff or before the first join creates no channel', async () => {
        const a = fakeClient();
        const first = start(a.client);
        await vi.advanceTimersByTimeAsync(0);
        a.socket.opened();
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

describe('watchWake', () => {
    function fakeDom() {
        const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
        const win = new EventTarget();
        return { doc, win };
    }

    it('wakes when the tab becomes visible and when the device comes back online', () => {
        const { doc, win } = fakeDom();
        const onWake = vi.fn();
        watchWake(doc as unknown as Document, win as unknown as Window, onWake);
        doc.visibilityState = 'hidden';
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(onWake).not.toHaveBeenCalled();
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(onWake).toHaveBeenCalledTimes(1);
        doc.visibilityState = 'hidden';
        win.dispatchEvent(new Event('online')); // also while hidden: the notifier alerts in the background
        expect(onWake).toHaveBeenCalledTimes(2);
    });

    it('the cleanup removes both listeners', () => {
        const { doc, win } = fakeDom();
        const onWake = vi.fn();
        const unwatch = watchWake(doc as unknown as Document, win as unknown as Window, onWake);
        unwatch();
        doc.dispatchEvent(new Event('visibilitychange'));
        win.dispatchEvent(new Event('online'));
        expect(onWake).not.toHaveBeenCalled();
    });
});
