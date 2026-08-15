import { buildMeetingIcs } from './ics';
import { MEETING_TZ } from './rules';

// Email the meeting details + a calendar invite (.ics) to the sales lead and the
// customer via Resend. Env-gated like the proposal mailer: without RESEND_API_KEY
// / SAILENDRA_FROM_EMAIL it returns { sent:false } and the booking still succeeds.

export interface MeetingNotifyInput {
    uid: string;
    title: string;
    start: Date;
    durationMin: number;
    joinUrl: string;
    meetingPassword?: string | null;
    notes?: string | null;
    customer: { name?: string | null; email?: string | null };
}

export interface MeetingNotifyResult {
    sent: boolean;
    skippedReason?: string;
    recipients: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(x: string | null | undefined): x is string {
    return !!x && EMAIL_RE.test(x.trim());
}

// SAILENDRA_FROM_EMAIL may be "Nindra <nindra@sailendra.co.id>" — pull the bare
// address out for the iCalendar ORGANIZER field.
function bareEmail(from: string): string {
    const m = from.match(/<([^>]+)>/);
    return (m ? m[1] : from).trim();
}

export async function sendMeetingInvite(input: MeetingNotifyInput): Promise<MeetingNotifyResult> {
    const resendKey = process.env.RESEND_API_KEY;
    const fromAddress = process.env.SAILENDRA_FROM_EMAIL;
    const salesEmail = process.env.SALES_NOTIFY_EMAIL || 'sales@sailendra.co.id';

    if (!resendKey || !fromAddress) {
        return {
            sent: false,
            skippedReason: !resendKey ? 'RESEND_API_KEY not set' : 'SAILENDRA_FROM_EMAIL not set',
            recipients: [],
        };
    }

    // De-duplicate; only include the customer when their email is valid.
    const recipients = Array.from(
        new Set(
            [salesEmail, input.customer.email]
                .filter(isEmail)
                .map((e) => e.trim().toLowerCase()),
        ),
    );
    if (recipients.length === 0) {
        return { sent: false, skippedReason: 'no valid recipients', recipients: [] };
    }

    const whenLabel =
        new Intl.DateTimeFormat('id-ID', {
            timeZone: MEETING_TZ,
            dateStyle: 'full',
            timeStyle: 'short',
        }).format(input.start) + ' WIB';

    const organizerEmail = bareEmail(fromAddress);
    const ics = buildMeetingIcs({
        uid: input.uid,
        title: input.title,
        description: buildPlainDescription(input, whenLabel),
        start: input.start,
        durationMin: input.durationMin,
        location: input.joinUrl,
        organizer: { name: 'Sailendra Organizer', email: organizerEmail },
        attendees: [
            { name: 'Sales Sailendra', email: salesEmail },
            ...(isEmail(input.customer.email)
                ? [{ name: input.customer.name ?? 'Customer', email: input.customer.email }]
                : []),
        ],
    });

    try {
        const { Resend } = await import('resend');
        const resend = new Resend(resendKey);

        const attachments = ics
            ? [{ filename: 'undangan-meeting.ics', content: Buffer.from(ics, 'utf-8') }]
            : undefined;

        const { error } = await resend.emails.send({
            from: fromAddress,
            to: recipients,
            subject: `Meeting terjadwal: ${input.title} — ${whenLabel}`,
            html: buildEmailHtml(input, whenLabel),
            attachments,
        });
        if (error) {
            return { sent: false, skippedReason: error.message, recipients };
        }
        return { sent: true, recipients };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Resend send failed';
        return { sent: false, skippedReason: msg, recipients };
    }
}

function buildPlainDescription(input: MeetingNotifyInput, whenLabel: string): string {
    return [
        `Meeting online: ${input.title}`,
        `Waktu: ${whenLabel} (${input.durationMin} menit)`,
        `Link: ${input.joinUrl}`,
        input.meetingPassword ? `Passcode: ${input.meetingPassword}` : null,
        input.notes ? `Catatan: ${input.notes}` : null,
    ]
        .filter(Boolean)
        .join('\n');
}

function buildEmailHtml(input: MeetingNotifyInput, whenLabel: string): string {
    const rows: string[] = [
        `<p><strong>Waktu:</strong> ${escapeHtml(whenLabel)} (${input.durationMin} menit)</p>`,
        `<p><strong>Link meeting:</strong> <a href="${escapeAttr(input.joinUrl)}">${escapeHtml(input.joinUrl)}</a></p>`,
    ];
    if (input.meetingPassword) {
        rows.push(`<p><strong>Passcode:</strong> ${escapeHtml(input.meetingPassword)}</p>`);
    }
    if (input.notes) {
        rows.push(`<p><strong>Catatan:</strong> ${escapeHtml(input.notes)}</p>`);
    }

    return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0f172a;max-width:560px;margin:0 auto;padding:24px;">
  <p>Halo,</p>
  <p>Sebuah meeting online telah dijadwalkan:</p>
  <h2 style="font-size:18px;margin:8px 0;">${escapeHtml(input.title)}</h2>
  ${rows.join('\n  ')}
  <p style="margin-top:16px;">Undangan kalender terlampir (file .ics) — klik untuk menambahkannya ke Google/Outlook/Apple Calendar.</p>
  <p style="margin-top:24px;color:#64748b;font-size:13px;">Sailendra Organizer · sailendra.co.id</p>
</body></html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// For href attributes: escape quotes/brackets so a crafted URL can't break out.
function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
