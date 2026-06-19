import { SupabaseClient } from '@supabase/supabase-js';
import { getDefaultOrgId } from '@/lib/settings/org-context';
import { computeFollowup } from '@/lib/followup/compute';
import { sendTemplateMessage } from '@/lib/whatsapp/templates';
import { whatsappLogger } from '@/lib/utils/logger';

// Daily WhatsApp follow-up digest to the owner. Triggered by the existing
// every-minute queue cron (/api/queue/process) but SELF-GUARDED so it sends at
// most once per WIB day, after FOLLOWUP_DIGEST_HOUR, and only when there's
// something to report.
//
// Config (env): FOLLOWUP_DIGEST_TO (owner number — empty disables the digest),
// FOLLOWUP_DIGEST_TEMPLATE (default 'followup_digest'), FOLLOWUP_DIGEST_LANG
// (default 'id'), FOLLOWUP_DIGEST_HOUR (default 8). The template must be an
// APPROVED Meta template with 3 body variables: {{1}} date, {{2}} lead count,
// {{3}} booking count.

const LAST_SENT_KEY = 'followup_digest_last_sent';

function wibDateHour(d: Date): { date: string; hour: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    let hour = Number.parseInt(get('hour'), 10);
    if (!Number.isFinite(hour) || hour === 24) hour = 0; // Intl quirk in some runtimes
    return { date, hour };
}

async function getLastSent(supabase: SupabaseClient): Promise<string | null> {
    const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', LAST_SENT_KEY)
        .maybeSingle();
    return (data?.value as string | undefined) ?? null;
}

// Atomically claim today for this tick. Returns true only for the single tick
// that flips the stored value to `today` — so overlapping every-minute cron
// ticks can never both send. Relies on app_settings.key being UNIQUE.
async function claimToday(supabase: SupabaseClient, today: string): Promise<boolean> {
    // Make sure the row exists (idempotent: ON CONFLICT DO NOTHING — concurrent
    // inserts don't error, and an existing value is preserved).
    await supabase
        .from('app_settings')
        .upsert(
            { key: LAST_SENT_KEY, value: '', description: 'Last WIB date the follow-up digest was sent' },
            { onConflict: 'key', ignoreDuplicates: true }
        );
    // Flip to today only if it isn't already today. Postgres applies the WHERE
    // atomically, so exactly one concurrent tick gets a returned row.
    const { data, error } = await supabase
        .from('app_settings')
        .update({ value: today })
        .eq('key', LAST_SENT_KEY)
        .neq('value', today)
        .select('id');
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
}

export async function maybeSendFollowupDigest(supabase: SupabaseClient): Promise<void> {
    const to = process.env.FOLLOWUP_DIGEST_TO?.trim();
    if (!to) return; // disabled — no owner number configured

    const templateName = process.env.FOLLOWUP_DIGEST_TEMPLATE?.trim() || 'followup_digest';
    const language = process.env.FOLLOWUP_DIGEST_LANG?.trim() || 'id';
    const hourEnv = Number.parseInt(process.env.FOLLOWUP_DIGEST_HOUR ?? '', 10);
    const sendHour = Number.isFinite(hourEnv) ? hourEnv : 8;

    const { date: today, hour: nowHour } = wibDateHour(new Date());
    if (nowHour < sendHour) return; // too early today

    try {
        // Cheap early-out for the rest of the day once a digest has been sent.
        if ((await getLastSent(supabase)) === today) return;

        const orgId = await getDefaultOrgId(supabase);
        const data = await computeFollowup(supabase, orgId);
        // Nothing to report yet — DON'T claim the day, so a later tick (once a
        // lead crosses the staleness threshold / a booking nears) can still send.
        if (data.counts.total === 0) return;

        // Claim atomically; only the winning tick proceeds to send.
        if (!(await claimToday(supabase, today))) return;

        const dateLabel = new Date().toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'Asia/Jakarta',
        });

        await sendTemplateMessage({
            to,
            templateName,
            language,
            variables: [dateLabel, String(data.counts.leads), String(data.counts.bookings)],
        });
        whatsappLogger.info(
            `Follow-up digest sent to ${to}: ${data.counts.leads} leads, ${data.counts.bookings} bookings`
        );
    } catch (err) {
        whatsappLogger.error('Follow-up digest failed', err);
    }
}
