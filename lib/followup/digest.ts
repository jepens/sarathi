import { SupabaseClient } from '@supabase/supabase-js';
import { getDefaultOrgId } from '@/lib/settings/org-context';
import { computeFollowup } from '@/lib/followup/compute';
import { sendTemplateMessage } from '@/lib/whatsapp/templates';
import { getOrgWhatsAppCreds, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/credentials';
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

// The last-sent date is a TENANT setting: app_settings row (org_id, key) of the
// org the digest reports on (tracker 1.7 — platform keys live in
// platform_settings).
export async function getLastSent(supabase: SupabaseClient, orgId: string): Promise<string | null> {
    const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('org_id', orgId)
        .eq('key', LAST_SENT_KEY)
        .maybeSingle();
    return (data?.value as string | undefined) ?? null;
}

// Atomically claim today for this tick. Returns true only for the single tick
// that flips the stored value to `today` — so overlapping every-minute cron
// ticks can never both send. Relies on app_settings (org_id, key) being UNIQUE
// (app_settings_org_key_key, migration 0061).
export async function claimToday(supabase: SupabaseClient, orgId: string, today: string): Promise<boolean> {
    // Make sure the row exists (idempotent: ON CONFLICT DO NOTHING — concurrent
    // inserts don't error, and an existing value is preserved).
    await supabase
        .from('app_settings')
        .upsert(
            {
                org_id: orgId,
                key: LAST_SENT_KEY,
                value: '',
                description: 'Last WIB date the follow-up digest was sent',
            },
            { onConflict: 'org_id,key', ignoreDuplicates: true }
        );
    // Flip to today only if it isn't already today. Postgres applies the WHERE
    // atomically, so exactly one concurrent tick gets a returned row.
    const { data, error } = await supabase
        .from('app_settings')
        .update({ value: today })
        .eq('org_id', orgId)
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
        const orgId = await getDefaultOrgId(supabase);
        // Cheap early-out for the rest of the day once a digest has been sent.
        if ((await getLastSent(supabase, orgId)) === today) return;

        const data = await computeFollowup(supabase, orgId);
        // Nothing to report yet — DON'T claim the day, so a later tick (once a
        // lead crosses the staleness threshold / a booking nears) can still send.
        if (data.counts.total === 0) return;

        // From the org's own number (Fase 2 task 2.2b), read BEFORE the day is
        // claimed: a read error throws to the log below without claiming, so
        // the next minute's tick tries again. An org without a number claims
        // the day and fails once (logged once a day, not every minute).
        let creds: WaCreds | null = null;
        try {
            creds = await getOrgWhatsAppCreds(orgId, supabase);
        } catch (credsError) {
            if (!(credsError instanceof WhatsAppNotConfiguredError)) throw credsError;
        }

        // Claim atomically; only the winning tick proceeds to send.
        if (!(await claimToday(supabase, orgId, today))) return;
        if (!creds) throw new WhatsAppNotConfiguredError();

        const dateLabel = new Date().toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'Asia/Jakarta',
        });

        await sendTemplateMessage(creds, {
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
