import { describe, it, expect } from 'vitest';
import {
    jakartaParts,
    jakartaDayRangeUtc,
    validateMeetingWindow,
    validateMeetingDay,
    validateMeetingHorizon,
    isWeekend,
    isDayFull,
    meetingTitle,
    normalizeMeetingIso,
    meetingSlotsOverlap,
    MAX_MEETINGS_PER_DAY,
    MEETING_BUFFER_MIN,
    MAX_BOOKING_HORIZON_DAYS,
} from '@/lib/meetings/rules';

describe('validateMeetingHorizon', () => {
    const now = new Date('2026-10-15T10:00:00+07:00');
    const DAY = 24 * 60 * 60_000;

    it('accepts a meeting inside the horizon', () => {
        expect(validateMeetingHorizon(new Date(now.getTime() + DAY), now)).toEqual({ ok: true });
        expect(validateMeetingHorizon(new Date(now.getTime() + MAX_BOOKING_HORIZON_DAYS * DAY), now)).toEqual({ ok: true });
    });

    it('rejects a meeting beyond the horizon with an actionable message', () => {
        const res = validateMeetingHorizon(new Date(now.getTime() + MAX_BOOKING_HORIZON_DAYS * DAY + 60_000), now);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain(`${MAX_BOOKING_HORIZON_DAYS} hari`);
    });

    it('is 30 days per owner decision D13', () => {
        expect(MAX_BOOKING_HORIZON_DAYS).toBe(30);
    });
});

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

    it('exposes the WIB weekday (0=Sun … 6=Sat)', () => {
        expect(jakartaParts(new Date('2026-06-03T14:00:00+07:00')).weekday).toBe(3); // Wed
        expect(jakartaParts(new Date('2026-06-06T14:00:00+07:00')).weekday).toBe(6); // Sat
        expect(jakartaParts(new Date('2026-06-07T14:00:00+07:00')).weekday).toBe(0); // Sun
        // A late-Friday-WIB time that is still Saturday in UTC stays Friday (weekday 5).
        expect(jakartaParts(new Date('2026-06-05T23:00:00+07:00')).weekday).toBe(5); // Fri
    });
});

describe('validateMeetingDay / isWeekend', () => {
    it('accepts a weekday', () => {
        expect(validateMeetingDay(new Date('2026-06-03T14:00:00+07:00'))).toEqual({ ok: true }); // Wed
        expect(isWeekend(new Date('2026-06-03T14:00:00+07:00'))).toBe(false);
    });

    it('rejects Saturday and Sunday (WIB)', () => {
        expect(isWeekend(new Date('2026-06-06T14:00:00+07:00'))).toBe(true); // Sat
        expect(isWeekend(new Date('2026-06-07T14:00:00+07:00'))).toBe(true); // Sun
        expect(validateMeetingDay(new Date('2026-06-06T14:00:00+07:00')).ok).toBe(false);
        expect(validateMeetingDay(new Date('2026-06-07T14:00:00+07:00')).ok).toBe(false);
    });

    it('judges the weekend by the WIB date, not UTC', () => {
        // Sat 01:00 WIB == Fri 18:00 UTC — still a weekend in WIB.
        expect(isWeekend(new Date('2026-06-06T01:00:00+07:00'))).toBe(true);
        // Fri 23:00 WIB == Sat 16:00 UTC — still Friday in WIB, so allowed.
        expect(isWeekend(new Date('2026-06-05T23:00:00+07:00'))).toBe(false);
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

describe('meetingSlotsOverlap', () => {
    // Existing meeting: 10:00–10:40 WIB (40 min). Buffer 15 min. Mirrors the SQL
    // overlap check in reserve_meeting_slot (migration 0057).
    const ex = new Date('2026-06-03T10:00:00+07:00').getTime();
    const overlap = (reqIso: string, reqDur = 40) =>
        meetingSlotsOverlap(ex, 40, new Date(reqIso).getTime(), reqDur, MEETING_BUFFER_MIN);

    it('rejects the exact same time', () => {
        expect(overlap('2026-06-03T10:00:00+07:00')).toBe(true);
    });

    it('rejects a back-to-back slot (0-min gap < buffer)', () => {
        expect(overlap('2026-06-03T10:40:00+07:00')).toBe(true);
    });

    it('rejects a 10-minute gap (< 15-min buffer)', () => {
        expect(overlap('2026-06-03T10:50:00+07:00')).toBe(true);
    });

    it('allows a gap of exactly the 15-min buffer', () => {
        // 10:40 end + 15 min → 10:55 start is allowed (half-open ranges).
        expect(overlap('2026-06-03T10:55:00+07:00')).toBe(false);
    });

    it('allows a comfortable 20-minute gap', () => {
        expect(overlap('2026-06-03T11:00:00+07:00')).toBe(false);
    });

    it('rejects a slot that starts before and runs into the existing one', () => {
        // 09:30 + 40 = 10:10, padded to 10:25 — overlaps the 10:00 start.
        expect(overlap('2026-06-03T09:30:00+07:00')).toBe(true);
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
