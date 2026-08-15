// Pure scheduling rules for the auto-booked online consultation meeting. Kept
// free of Supabase / Zoom / React so it unit-tests without any I/O. The DB count
// is passed in by the caller (scheduleMeeting) — everything here is deterministic.

export const MEETING_TZ = 'Asia/Jakarta'; // Sailendra operates from Indonesia (WIB, fixed UTC+7).
export const MEETING_OPEN_HOUR = 10; // earliest a meeting may START (10:00 WIB)
export const MEETING_CLOSE_HOUR = 22; // latest a meeting may END (22:00 WIB)
export const MAX_MEETINGS_PER_DAY = 4;

export interface JakartaParts {
    year: string;
    month: string;
    day: string;
    hour: number;
    minute: number;
    dateKey: string; // 'YYYY-MM-DD' in WIB
}

// Break a Date into its Asia/Jakarta wall-clock parts. Uses Intl (not the raw
// getters) so it's correct regardless of the host machine's timezone.
export function jakartaParts(date: Date): JakartaParts {
    const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: MEETING_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = (t: string) => p.find((x) => x.type === t)!.value;
    let hour = get('hour');
    if (hour === '24') hour = '00'; // Intl quirk in some Node versions
    const year = get('year');
    const month = get('month');
    const day = get('day');
    return {
        year,
        month,
        day,
        hour: Number(hour),
        minute: Number(get('minute')),
        dateKey: `${year}-${month}-${day}`,
    };
}

// The UTC ISO bounds [start, end) of the WIB calendar day that `date` falls in —
// used to count how many meetings are already booked that day.
export function jakartaDayRangeUtc(date: Date): { startUtcIso: string; endUtcIso: string } {
    const { dateKey } = jakartaParts(date);
    const start = new Date(`${dateKey}T00:00:00+07:00`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { startUtcIso: start.toISOString(), endUtcIso: end.toISOString() };
}

// The schedule_meeting tool tells the model to include a +07:00 offset, but LLMs
// sometimes emit a NAIVE datetime ("2026-06-03T14:00:00"). new Date() parses a
// naive string in the HOST timezone (UTC in production) — 7 hours off WIB — which
// would silently book/count/email the wrong instant. When no explicit offset (Z
// or ±HH:MM) is present, assume WIB so the instant matches what was agreed.
export function normalizeMeetingIso(raw: string): string {
    const s = raw.trim();
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return s; // already zoned
    if (/T\d{2}:\d{2}/.test(s)) return `${s}+07:00`; // naive datetime → assume WIB
    return s; // not a datetime (e.g. date-only) → let the NaN check reject it
}

export type SlotCheck = { ok: true } | { ok: false; error: string };

// Meeting must START at/after 10:00 WIB and END by 22:00 WIB.
export function validateMeetingWindow(start: Date, durationMin: number): SlotCheck {
    const { hour, minute } = jakartaParts(start);
    const startMin = hour * 60 + minute;
    const endMin = startMin + durationMin;
    const openMin = MEETING_OPEN_HOUR * 60;
    const closeMin = MEETING_CLOSE_HOUR * 60;

    if (startMin < openMin) {
        return { ok: false, error: 'Meeting hanya bisa dijadwalkan mulai pukul 10:00 WIB. Tawarkan jam yang lebih siang.' };
    }
    if (endMin > closeMin) {
        return { ok: false, error: 'Meeting harus selesai sebelum pukul 22:00 WIB. Tawarkan jam yang lebih awal.' };
    }
    return { ok: true };
}

export function isDayFull(existingCount: number): boolean {
    return existingCount >= MAX_MEETINGS_PER_DAY;
}

// "COMPANY - Event", e.g. "SIEMENS - Employee Gathering 2026". Falls back to the
// contact name (then a generic label) when the company is unknown, and drops the
// event half when there's no event on file yet.
export function meetingTitle(
    company: string | null | undefined,
    event: string | null | undefined,
    fallbackName?: string | null,
): string {
    const left = company?.trim() || fallbackName?.trim() || 'Konsultasi';
    const right = event?.trim();
    return right ? `${left} - ${right}` : left;
}
