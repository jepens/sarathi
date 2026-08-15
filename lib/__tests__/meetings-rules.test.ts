import { describe, it, expect } from 'vitest';
import {
    jakartaParts,
    jakartaDayRangeUtc,
    validateMeetingWindow,
    isDayFull,
    meetingTitle,
    normalizeMeetingIso,
    MAX_MEETINGS_PER_DAY,
} from '@/lib/meetings/rules';

describe('jakartaParts', () => {
    it('reads WIB wall-clock regardless of input offset', () => {
        // 07:00Z == 14:00 WIB
        const p = jakartaParts(new Date('2026-06-03T07:00:00Z'));
        expect(p.dateKey).toBe('2026-06-03');
        expect(p.hour).toBe(14);
        expect(p.minute).toBe(0);
    });

    it('rolls the date back for a late-UTC time that is still the same WIB day', () => {
        // 2026-06-02T20:00Z == 2026-06-03T03:00 WIB
        const p = jakartaParts(new Date('2026-06-02T20:00:00Z'));
        expect(p.dateKey).toBe('2026-06-03');
        expect(p.hour).toBe(3);
    });
});

describe('jakartaDayRangeUtc', () => {
    it('spans a full WIB day in UTC (17:00 prev → 17:00 same)', () => {
        const { startUtcIso, endUtcIso } = jakartaDayRangeUtc(new Date('2026-06-03T14:00:00+07:00'));
        expect(startUtcIso).toBe('2026-06-02T17:00:00.000Z');
        expect(endUtcIso).toBe('2026-06-03T17:00:00.000Z');
    });
});

describe('validateMeetingWindow', () => {
    it('accepts a mid-day slot', () => {
        expect(validateMeetingWindow(new Date('2026-06-03T14:00:00+07:00'), 40)).toEqual({ ok: true });
    });

    it('accepts exactly 10:00 WIB', () => {
        expect(validateMeetingWindow(new Date('2026-06-03T10:00:00+07:00'), 60)).toEqual({ ok: true });
    });

    it('rejects before 10:00 WIB', () => {
        const r = validateMeetingWindow(new Date('2026-06-03T09:30:00+07:00'), 40);
        expect(r.ok).toBe(false);
    });

    it('rejects when the meeting would end after 22:00 WIB', () => {
        // 21:30 + 40 min = 22:10 → too late
        const r = validateMeetingWindow(new Date('2026-06-03T21:30:00+07:00'), 40);
        expect(r.ok).toBe(false);
    });

    it('accepts a slot that ends exactly at 22:00 WIB', () => {
        // 21:20 + 40 = 22:00 → ok (end == close is allowed)
        expect(validateMeetingWindow(new Date('2026-06-03T21:20:00+07:00'), 40)).toEqual({ ok: true });
    });
});

describe('isDayFull', () => {
    it('is full at the cap', () => {
        expect(isDayFull(MAX_MEETINGS_PER_DAY)).toBe(true);
        expect(isDayFull(MAX_MEETINGS_PER_DAY - 1)).toBe(false);
        expect(isDayFull(0)).toBe(false);
    });
});

describe('normalizeMeetingIso', () => {
    it('leaves an already-zoned datetime untouched', () => {
        expect(normalizeMeetingIso('2026-06-03T14:00:00+07:00')).toBe('2026-06-03T14:00:00+07:00');
        expect(normalizeMeetingIso('2026-06-03T07:00:00Z')).toBe('2026-06-03T07:00:00Z');
        expect(normalizeMeetingIso('2026-06-03T14:00:00-0500')).toBe('2026-06-03T14:00:00-0500');
    });

    it('appends +07:00 (WIB) to a naive datetime', () => {
        expect(normalizeMeetingIso('2026-06-03T14:00:00')).toBe('2026-06-03T14:00:00+07:00');
        expect(normalizeMeetingIso('2026-06-03T14:00')).toBe('2026-06-03T14:00+07:00');
        // A naive datetime becomes the intended WIB instant (14:00 WIB = 07:00Z)
        // regardless of the host timezone.
        expect(new Date(normalizeMeetingIso('2026-06-03T14:00:00')).toISOString()).toBe('2026-06-03T07:00:00.000Z');
    });

    it('leaves a non-datetime (date-only) string for the NaN check', () => {
        expect(normalizeMeetingIso('2026-06-03')).toBe('2026-06-03');
    });
});

describe('meetingTitle', () => {
    it('joins company and event', () => {
        expect(meetingTitle('SIEMENS', 'Employee Gathering 2026')).toBe('SIEMENS - Employee Gathering 2026');
    });

    it('falls back to contact name, then a generic label', () => {
        expect(meetingTitle(null, 'Gala Dinner', 'Budi')).toBe('Budi - Gala Dinner');
        expect(meetingTitle(null, null, 'Budi')).toBe('Budi');
        expect(meetingTitle(null, null, null)).toBe('Konsultasi');
    });

    it('drops the event half when absent, trims whitespace', () => {
        expect(meetingTitle('  ACME  ', '   ')).toBe('ACME');
    });
});
