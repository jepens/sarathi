import { sendTemplateMessage } from '@/lib/whatsapp/templates';
import { redactPII } from '@/lib/utils/logger';
import { MEETING_TZ } from './rules';

// Notify the sales team on WhatsApp when a meeting is booked — in ADDITION to
// the email invite (lib/meetings/notify.ts). Sent as an APPROVED Meta template
// (Utility category) because an internal sales number almost never has an open
// 24-hour customer-service window, so a free-form text would be rejected by
// Meta (error 131047). This mirrors how the follow-up digest reaches the owner.
//
// Env-gated: without MEETING_NOTIFY_WHATSAPP it returns { sent:false } and the
// booking still succeeds. Non-fatal — a send failure never fails the booking.
//
// The template must have 4 BODY variables:
//   {{1}} customer (name + company)  {{2}} date/time WIB  {{3}} topic  {{4}} link

export interface MeetingWaNotifyInput {
    customerName?: string | null;
    company?: string | null;
    eventInterest?: string | null;
    start: Date;
    joinUrl: string | null; // null / 'pending-link' → "menyusul"
}

export interface MeetingWaNotifyResult {
    sent: boolean; // true if at least one recipient was sent to
    recipients: string[]; // normalized numbers we attempted
    skippedReason?: string;
    failures?: { to: string; reason: string }[];
}

// Parse the comma/semicolon-separated MEETING_NOTIFY_WHATSAPP into normalized,
// de-duped numbers. Within a token, non-digits are stripped so
// "+62 812-8195-8110" → "6281281958110". A token that contains LETTERS
// (e.g. "0812 ext 123") is rejected wholesale rather than gluing its digits
// into a wrong number, and only plausible E.164 lengths (9–15) are kept. An
// empty env yields [].
export function parseNotifyRecipients(raw: string | undefined): string[] {
    if (!raw) return [];
    return Array.from(
        new Set(
            raw
                .split(/[,;]/) // one number per comma/semicolon token
                .map((s) => s.trim())
                .filter((s) => s.length > 0 && !/[a-z]/i.test(s)) // reject letter-bearing tokens
                .map((s) => s.replace(/\D/g, '')) // digits only within the token
                .filter((s) => s.length >= 9 && s.length <= 15), // plausible phone length
        ),
    );
}

// Meta rejects body params containing newlines, tabs, or 4+ consecutive spaces.
function sanitizeVar(s: string): string {
    return s.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

// Build the 4 positional template variables. Pure (no I/O) so it unit-tests.
export function buildMeetingWaVariables(input: MeetingWaNotifyInput): string[] {
    const name = input.customerName?.trim() || 'Klien';
    const klien = input.company?.trim() ? `${name} (${input.company.trim()})` : name;
    const when = new Intl.DateTimeFormat('id-ID', {
        timeZone: MEETING_TZ,
        dateStyle: 'full',
        timeStyle: 'short',
    }).format(input.start);
    const topik = input.eventInterest?.trim() || 'Konsultasi';
    const link =
        input.joinUrl && input.joinUrl.trim() && input.joinUrl.trim() !== 'pending-link'
            ? input.joinUrl.trim()
            : 'menyusul';
    return [klien, when, topik, link].map(sanitizeVar);
}

export async function notifySalesWhatsApp(
    input: MeetingWaNotifyInput,
): Promise<MeetingWaNotifyResult> {
    const recipients = parseNotifyRecipients(process.env.MEETING_NOTIFY_WHATSAPP);
    if (recipients.length === 0) {
        return { sent: false, skippedReason: 'MEETING_NOTIFY_WHATSAPP not set', recipients: [] };
    }

    const templateName = process.env.MEETING_NOTIFY_TEMPLATE?.trim() || 'meeting_notify';
    const language = process.env.MEETING_NOTIFY_LANG?.trim() || 'id';
    const variables = buildMeetingWaVariables(input);

    const failures: { to: string; reason: string }[] = [];
    let anySent = false;
    // Sequential (a booking notifies at most a handful of numbers) — one bad
    // recipient never blocks the others.
    for (const to of recipients) {
        try {
            await sendTemplateMessage({ to, templateName, language, variables });
            anySent = true;
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.error(`Sales WA notify to ${redactPII(to)} failed:`, redactPII(reason));
            failures.push({ to, reason });
        }
    }

    return {
        sent: anySent,
        recipients,
        ...(failures.length ? { failures } : {}),
    };
}
