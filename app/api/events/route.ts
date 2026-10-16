import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { NextResponse } from 'next/server';

// Calendar feed for the /dashboard/calendar page.
//
// Schedule X v4 requires Temporal API instances for event start/end, not plain
// strings — so we return ISO-shaped strings here and let the client wrap them
// in Temporal.PlainDate / Temporal.ZonedDateTime before passing to the
// calendar app. JSON can't carry Temporal instances directly.
//
// Output shape (per row):
//   {
//     id, title, calendarId, description?, location?,
//     kind: 'event' | 'meeting',
//     start: string,   // 'YYYY-MM-DD' for events, ZonedDateTime ISO for meetings
//     end:   string,
//   }

const EVENT_TZ = 'Asia/Jakarta'; // Sailendra operates from Indonesia (WIB).

interface OrderEventRow {
    id: string;
    customer_name: string | null;
    customer_phone: string | null;
    event_date: string | null;
    headcount: number | null;
    venue: string | null;
    event_type: string | null;
    total_amount: number | null;
    status: string | null;
    meeting_link: string | null;
    meeting_duration_min: number | null;
}

function pad(n: number) {
    return n.toString().padStart(2, '0');
}

// Render a UTC timestamp as the calendar date "YYYY-MM-DD" *as observed in
// Asia/Jakarta*. We use Intl rather than the raw Date getters because Node's
// default timezone is host-dependent and would skew the date across the
// midnight boundary.
function plainDateInJakarta(iso: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: EVENT_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(iso));
    const y = parts.find((p) => p.type === 'year')!.value;
    const m = parts.find((p) => p.type === 'month')!.value;
    const d = parts.find((p) => p.type === 'day')!.value;
    return `${y}-${m}-${d}`;
}

// Build a ZonedDateTime ISO string anchored to Asia/Jakarta for a given UTC
// timestamp, optionally adding minutes. Output format is the canonical
// Temporal.ZonedDateTime.from() input — e.g. "2026-05-27T14:00:00+07:00[Asia/Jakarta]".
function zonedDateTimeInJakarta(iso: string, addMinutes = 0): string {
    const date = new Date(iso);
    date.setMinutes(date.getMinutes() + addMinutes);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: EVENT_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    const y = get('year');
    const mo = get('month');
    const da = get('day');
    let hh = get('hour');
    if (hh === '24') hh = '00'; // Intl quirk in some node versions
    const mi = get('minute');
    const ss = get('second');
    // WIB is fixed UTC+07:00 — no DST in Indonesia.
    return `${y}-${mo}-${da}T${hh}:${mi}:${ss}+07:00[${EVENT_TZ}]`;
}

function plainDatePlusDays(yyyyMmDd: string, days: number): string {
    const [y, m, d] = yyyyMmDd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export async function GET(request: Request) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase } = access;

    const { searchParams } = new URL(request.url);
    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString();
    const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 6, 1).toISOString();
    const start = searchParams.get('start') ?? defaultStart;
    const end = searchParams.get('end') ?? defaultEnd;

    const { data, error } = await supabase
        .from('orders')
        .select(
            'id, customer_name, customer_phone, event_date, headcount, venue, event_type, total_amount, status, meeting_link, meeting_duration_min'
        )
        .not('event_date', 'is', null)
        .gte('event_date', start)
        .lte('event_date', end);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const events = ((data ?? []) as OrderEventRow[]).map((r) => {
        const isMeeting = !!r.meeting_link;
        // Filter above guarantees event_date is non-null.
        const eventDateIso = r.event_date!;

        const customerLabel = r.customer_name ?? r.customer_phone ?? 'Klien';
        const headcountLabel = r.headcount ? ` — ${r.headcount} pax` : '';
        const title = isMeeting
            ? `Meeting: ${customerLabel}`
            : `${r.event_type ?? 'Event'}: ${customerLabel}${headcountLabel}`;

        let startStr: string;
        let endStr: string;
        if (isMeeting) {
            // Meetings: a ZonedDateTime block whose length is the stored meeting
            // duration (older rows without one fall back to 60 minutes).
            const durationMin = r.meeting_duration_min ?? 60;
            startStr = zonedDateTimeInJakarta(eventDateIso, 0);
            endStr = zonedDateTimeInJakarta(eventDateIso, durationMin);
        } else {
            // Events: PlainDate all-day block. Schedule X expects end to be
            // the day *after* the last day for single-day all-day events.
            const startDate = plainDateInJakarta(eventDateIso);
            startStr = startDate;
            endStr = plainDatePlusDays(startDate, 1);
        }

        return {
            id: r.id,
            kind: isMeeting ? 'meeting' : 'event',
            title,
            start: startStr,
            end: endStr,
            calendarId: isMeeting ? 'meetings' : 'events',
            description: [
                r.venue ? `Lokasi: ${r.venue}` : null,
                r.total_amount
                    ? `Total: Rp ${Number(r.total_amount).toLocaleString('id-ID')}`
                    : null,
                r.status ? `Status: ${r.status}` : null,
                // 'pending-link' is the sentinel set by the schedule_meeting tool
                // before an admin pastes the real Zoom/GMeet URL — hide it from
                // the description so customers don't see internal markers.
                r.meeting_link && r.meeting_link !== 'pending-link'
                    ? `Link: ${r.meeting_link}`
                    : null,
            ]
                .filter(Boolean)
                .join('\n'),
            location: r.venue ?? undefined,
        };
    });

    return NextResponse.json({ events });
}
