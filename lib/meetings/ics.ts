import { createEvent, type EventAttributes, type DateArray } from 'ics';

// Build an iCalendar invitation (RFC 5545, METHOD:REQUEST) for the meeting.
// Attached to the notification email; because it's a REQUEST with attendees,
// Gmail/Outlook/Apple auto-surface it as a calendar invite the recipient can add
// — no Google Calendar API / Workspace needed. Returns null on failure so the
// caller can still send a plain email.
export function buildMeetingIcs(input: {
    uid: string;
    title: string;
    description: string;
    start: Date;
    durationMin: number;
    location: string; // the Zoom join URL
    organizer: { name: string; email: string };
    attendees: { name?: string; email: string }[];
}): string | null {
    const d = input.start;
    // Emit DTSTART in UTC (…Z) so the time is unambiguous across the recipients'
    // own timezones.
    const start: DateArray = [
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        d.getUTCHours(),
        d.getUTCMinutes(),
    ];

    const event: EventAttributes = {
        uid: input.uid,
        start,
        startInputType: 'utc',
        startOutputType: 'utc',
        duration: { minutes: input.durationMin },
        title: input.title,
        description: input.description,
        location: input.location,
        url: input.location,
        status: 'CONFIRMED',
        busyStatus: 'BUSY',
        method: 'REQUEST',
        organizer: input.organizer,
        attendees: input.attendees.map((a) => ({
            name: a.name,
            email: a.email,
            rsvp: true,
            role: 'REQ-PARTICIPANT',
            partstat: 'NEEDS-ACTION',
        })),
        alarms: [
            { action: 'display', description: input.title, trigger: { hours: 1, before: true } },
            { action: 'display', description: input.title, trigger: { minutes: 15, before: true } },
        ],
        productId: 'sarathi/meetings',
    };

    const { error, value } = createEvent(event);
    if (error || !value) {
        console.error('Failed to build .ics invite:', error);
        return null;
    }
    return value;
}
