import { describe, it, expect } from 'vitest';
import { isNewInbound, type ChatRealtimeRow } from '@/lib/notifications/inbound';

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
