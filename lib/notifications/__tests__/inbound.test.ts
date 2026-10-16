import { describe, it, expect } from 'vitest';
import { isNewInbound, pickFreshInbound, type ChatRealtimeRow } from '@/lib/notifications/inbound';

const MOUNT = Date.parse('2026-08-13T10:00:00Z');
const T = (iso: string) => Date.parse(iso);

function row(over: Partial<ChatRealtimeRow>): ChatRealtimeRow {
    return {
        phone_number: '628123',
        contact_name: 'Budi',
        contact_type: 'lead',
        last_message: 'Halo kak',
        last_message_at: '2026-08-13T10:05:00Z',
        last_inbound_at: '2026-08-13T10:05:00Z',
        ...over,
    };
}

describe('isNewInbound', () => {
    it('fires on a fresh inbound seen for the first time (>= mount floor)', () => {
        expect(isNewInbound(row({}), undefined, MOUNT)).toBe(true);
    });

    it('stays silent on first sight when the inbound predates the mount floor', () => {
        const stale = row({
            last_inbound_at: '2026-08-13T09:00:00Z',
            last_message_at: '2026-08-13T09:00:00Z',
        });
        expect(isNewInbound(stale, undefined, MOUNT)).toBe(false);
    });

    it('does NOT fire when we have already replied (outbound is the latest activity)', () => {
        const replied = row({
            last_inbound_at: '2026-08-13T10:05:00Z',
            last_message_at: '2026-08-13T10:06:00Z', // our reply, newer
        });
        expect(isNewInbound(replied, T('2026-08-13T10:04:00Z'), MOUNT)).toBe(false);
    });

    it('fires when the inbound is newer than the last one we saw', () => {
        expect(isNewInbound(row({}), T('2026-08-13T10:04:00Z'), MOUNT)).toBe(true);
    });

    it('does NOT fire for a repeat of an inbound we already saw', () => {
        expect(isNewInbound(row({}), T('2026-08-13T10:05:00Z'), MOUNT)).toBe(false);
    });

    it('ignores rows with no inbound timestamp', () => {
        expect(isNewInbound(row({ last_inbound_at: null }), undefined, MOUNT)).toBe(false);
    });
});

// One read of the latest threads (the notifier re-reads after every org-bus
// signal): the same rules, applied across reads through the `seen` map.
describe('pickFreshInbound', () => {
    const phones = (rows: ChatRealtimeRow[]) => rows.map((r) => r.phone_number);

    it('on the first read alerts only for inbounds at/after the mount floor, and records every row', () => {
        const seen = new Map<string, number>();
        const fresh = pickFreshInbound(
            [
                row({ phone_number: 'a' }), // 10:05, after the floor
                row({ phone_number: 'b', last_inbound_at: '2026-08-13T09:00:00Z', last_message_at: '2026-08-13T09:00:00Z' }),
                row({ phone_number: 'c', last_inbound_at: null, last_message_at: '2026-08-13T10:07:00Z' }),
            ],
            seen,
            MOUNT,
        );
        expect(phones(fresh)).toEqual(['a']);
        expect(seen).toEqual(
            new Map([
                ['a', T('2026-08-13T10:05:00Z')],
                ['b', T('2026-08-13T09:00:00Z')],
            ]),
        );
    });

    it('re-reading the same rows alerts nothing; a newer inbound alerts once', () => {
        const seen = new Map<string, number>();
        pickFreshInbound([row({ phone_number: 'a' })], seen, MOUNT);
        expect(pickFreshInbound([row({ phone_number: 'a' })], seen, MOUNT)).toEqual([]);

        const newer = row({
            phone_number: 'a',
            last_inbound_at: '2026-08-13T10:09:00Z',
            last_message_at: '2026-08-13T10:09:00Z',
        });
        expect(phones(pickFreshInbound([newer], seen, MOUNT))).toEqual(['a']);
        expect(pickFreshInbound([newer], seen, MOUNT)).toEqual([]);
        expect(seen.get('a')).toBe(T('2026-08-13T10:09:00Z'));
    });

    it('skips a thread already replied to, and does not alert for it later either', () => {
        const seen = new Map<string, number>();
        const replied = row({ phone_number: 'a', last_message_at: '2026-08-13T10:06:00Z' });
        expect(pickFreshInbound([replied], seen, MOUNT)).toEqual([]);
        expect(seen.get('a')).toBe(T('2026-08-13T10:05:00Z'));
        // The reply is still the latest activity; the same inbound never alerts.
        expect(pickFreshInbound([row({ phone_number: 'a' })], seen, MOUNT)).toEqual([]);
    });

    it('a pre-mount thread alerts once the customer writes again', () => {
        const seen = new Map<string, number>();
        const old = row({ phone_number: 'b', last_inbound_at: '2026-08-13T09:00:00Z', last_message_at: '2026-08-13T09:00:00Z' });
        expect(pickFreshInbound([old], seen, MOUNT)).toEqual([]);
        const again = row({ phone_number: 'b', last_inbound_at: '2026-08-13T10:01:00Z', last_message_at: '2026-08-13T10:01:00Z' });
        expect(phones(pickFreshInbound([again], seen, MOUNT))).toEqual(['b']);
    });

    it('nothing alerts while the mount floor is not set yet (Infinity)', () => {
        const seen = new Map<string, number>();
        expect(pickFreshInbound([row({ phone_number: 'a' })], seen, Number.POSITIVE_INFINITY)).toEqual([]);
        expect(seen.has('a')).toBe(true);
    });

    it('overlapping reads that land out of order never alert twice for one message', () => {
        const seen = new Map<string, number>();
        const before = row({ phone_number: 'p', last_inbound_at: '2026-08-13T10:02:00Z', last_message_at: '2026-08-13T10:02:00Z' });
        const after = row({ phone_number: 'p', last_inbound_at: '2026-08-13T10:03:00Z', last_message_at: '2026-08-13T10:03:00Z' });
        // Read B (started later, saw the new message) lands first and alerts.
        expect(phones(pickFreshInbound([after], seen, MOUNT))).toEqual(['p']);
        // Read A (started earlier, older snapshot) lands afterwards: no alert,
        // and it must not move `seen` back...
        expect(pickFreshInbound([before], seen, MOUNT)).toEqual([]);
        expect(seen.get('p')).toBe(T('2026-08-13T10:03:00Z'));
        // ...so the next read of the same message stays silent.
        expect(pickFreshInbound([after], seen, MOUNT)).toEqual([]);
    });
});
