import type { SupabaseClient } from '@supabase/supabase-js';

// Team alerts by email (tracker 3.5, migration 0070; owner decision
// 2026-10-18: email via Resend). Both functions run every minute from the queue
// cron (/api/queue/process).
//
// maybeSendOpsAlerts: claim_ops_alerts() claims, in one statement, every
// (kind, org) group that has unsent events of a closed minute (one that ended
// over a minute ago) and was not emailed in the last hour (a day for the kinds
// in DAILY_ALERT_KINDS), and returns the group totals. One email covers all
// claimed groups. Once it is out, mark_ops_alerts_sent() stamps the events; if
// it fails, release_ops_alerts() frees the groups for the next run. So a burst
// of failures gives at most one email per hour (a day for a daily kind) per
// kind and org, a flood of one kind never hides another, and two overlapping
// runs never email a group twice.
//
// maybeSendOpsDailySummary: once a day from 08:00 WIB, the totals of the last
// 24 hours. It comes on quiet days too, so a day without it means the cron has
// stopped (and with it every alert).
//
// Recipients: OPS_ALERT_EMAIL (comma-separated; "Name <address>" is accepted).
// Sender: OPS_ALERT_FROM_EMAIL, else SAILENDRA_FROM_EMAIL. Without a recipient,
// a sender or RESEND_API_KEY nothing is claimed or sent: the events stay unsent
// (kept 30 days) and a warning is logged once an hour. Set the variables in
// Easypanel before the deploy (a running container does not see new values).

const ALERT_EVERY_S = 60 * 60;
// Kinds whose events are expected to recur (e.g. the traffic of a number that
// is not routed, or a webhook batch deferred under load: Meta sends it again)
// and are emailed at most once a day.
export const DAILY_ALERT_KINDS: string[] = ['webhook_unrouted', 'webhook_deferred'];
const DAILY_HOUR_WIB = 8;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta has no daylight saving
const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export const OPS_KIND_LABELS: Record<string, string> = {
    webhook_signature_invalid: 'Webhook WhatsApp ditolak: tanda tangan tidak valid (403)',
    webhook_error: 'Webhook WhatsApp gagal diproses (503/500, Meta mengirim ulang)',
    webhook_unrouted: 'Webhook untuk nomor lain di WABA (bukan nomor org ini)',
    webhook_unrouted_new: 'Nomor lain di WABA mengirim event untuk pertama kali dalam 7 hari (bila ini nomor utama, periksa phone_number_id nomor org di Vault)',
    webhook_unconfigured: 'Konfigurasi webhook WhatsApp bermasalah',
    webhook_payload_invalid: 'Event WhatsApp tidak bisa diproses: pesan disimpan sebagai pengganti tanpa isi atau dilewati; status/pembaruan dilewati',
    webhook_deferred: 'Webhook WhatsApp menunda event karena batas waktu 8 detik (503, Meta mengirim ulang; bila sering: database lambat)',
    queue_job_failed: 'Balasan AI gagal setelah semua percobaan',
    whatsapp_not_configured: 'Balasan AI tidak dikirim: org belum punya nomor WhatsApp yang bisa mengirim (periksa nomor dan token aplikasi org di Vault)',
    whatsapp_token_invalid: 'Token WhatsApp tidak valid atau kedaluwarsa (Meta 190)',
    quota_inbound_exceeded: 'Kuota percakapan AI baru per menit tercapai: percakapan baru di menit itu tidak dibalas AI',
    quota_ai_daily_warning: 'Kuota balasan AI harian sudah terpakai 80%',
    quota_ai_daily_exceeded: 'Kuota balasan AI harian habis: AI berhenti membalas sampai 00.00 WIB',
    quota_check_failed: 'Pemeriksaan kuota gagal: kuota tidak ditegakkan, AI tetap membalas',
};

/** One claimed (kind, org) group, as claim_ops_alerts returns it. */
export interface OpsAlertGroup {
    kind: string;
    org_id: string | null;
    events: number | string;
    first_at: string;
    last_at: string;
    details: string[] | null;
    stamp: string;
    cutoff: string;
}

export interface OpsAlertResult {
    sent: boolean;
    kinds: string[];
    reason?: string;
}

interface AlertConfig {
    key: string;
    from: string;
    to: string[];
    /** OPS_ALERT_EMAIL entries that are not addresses (ignored). */
    dropped: number;
}

function recipientAddress(entry: string): string | null {
    const angle = /<([^<>]+)>\s*$/.exec(entry);
    const address = (angle ? angle[1] : entry).trim();
    return ADDRESS_RE.test(address) ? address : null;
}

export function opsAlertConfig(env: Record<string, string | undefined> = process.env): AlertConfig | { missing: string } {
    const entries = (env.OPS_ALERT_EMAIL ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const to = entries.map(recipientAddress).filter((a): a is string => !!a);
    const from = (env.OPS_ALERT_FROM_EMAIL || env.SAILENDRA_FROM_EMAIL || '').trim();
    const key = (env.RESEND_API_KEY ?? '').trim();
    if (to.length === 0) return { missing: 'OPS_ALERT_EMAIL' };
    if (!from) return { missing: 'OPS_ALERT_FROM_EMAIL / SAILENDRA_FROM_EMAIL' };
    if (!key) return { missing: 'RESEND_API_KEY' };
    return { key, from, to, dropped: entries.length - to.length };
}

const WIB = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'short',
});

function wib(at: string | number | Date): string {
    return `${WIB.format(at instanceof Date ? at : new Date(at))} WIB`;
}

const label = (kind: string) => OPS_KIND_LABELS[kind] ?? kind;
const orgLabel = (orgId: string | null, orgNames: Map<string, string>) =>
    orgId ? orgNames.get(orgId) ?? orgId : 'tanpa org';

export function buildOpsAlertEmail(
    groups: OpsAlertGroup[],
    orgNames: Map<string, string>,
    now: Date,
): { subject: string; text: string } {
    const byKind = new Map<string, OpsAlertGroup[]>();
    for (const g of groups) byKind.set(g.kind, [...(byKind.get(g.kind) ?? []), g]);
    const kinds = [...byKind.keys()].sort();
    const lines: string[] = [`Peringatan operasional Sarathi, ${wib(now)}.`, ''];
    for (const kind of kinds) {
        const list = byKind.get(kind)!;
        const total = list.reduce((n, g) => n + Number(g.events), 0);
        const first = Math.min(...list.map((g) => Date.parse(g.first_at)));
        const last = Math.max(...list.map((g) => Date.parse(g.last_at)));
        lines.push(`- ${label(kind)}: ${total} kejadian`);
        lines.push(`  pertama ${wib(first)}, terakhir ${wib(last)}`);
        lines.push(`  org: ${list.map((g) => `${orgLabel(g.org_id, orgNames)} (${Number(g.events)})`).join(', ')}`);
        const details = [...new Set(list.flatMap((g) => g.details ?? []))].slice(0, 3);
        for (const d of details) lines.push(`  contoh: ${d}`);
    }
    const daily = kinds.filter((k) => DAILY_ALERT_KINDS.includes(k)).map(label);
    lines.push(
        '',
        `Email berikutnya untuk jenis dan org yang sama paling cepat 1 jam lagi${daily.length > 0 ? ` (1 hari lagi untuk: ${daily.join('; ')})` : ''}. Kejadian dari 1-2 menit terakhir, dan kejadian di atas batas pencatatan per menit saat banjir, masuk email berikutnya; server yang restart bisa kehilangan sebagian hitungan yang sedang ditahan. Rincian: tabel ops_events (service role).`,
    );
    const subject = `[Sarathi] Peringatan: ${kinds.map(label).join('; ')}`.slice(0, 200);
    return { subject, text: lines.join('\n') };
}

async function orgNamesOf(client: SupabaseClient, orgIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(orgIds.filter((id): id is string => !!id))];
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    const { data } = await client.from('organizations').select('id, name').in('id', ids);
    for (const o of (data ?? []) as { id: string; name: string | null }[]) names.set(o.id, o.name ?? o.id);
    return names;
}

/** Sends one email; returns null, or a short reason on failure. Never throws. */
async function sendEmail(config: AlertConfig, subject: string, text: string): Promise<string | null> {
    try {
        const { Resend } = await import('resend');
        const { error } = await new Resend(config.key).emails.send({ from: config.from, to: config.to, subject, text });
        return error ? String(error.message ?? 'send error').slice(0, 120) : null;
    } catch (err) {
        return err instanceof Error ? err.message.slice(0, 120) : 'unknown';
    }
}

/** Logs, once an hour, why nothing can be emailed or which entries were ignored. */
async function warnConfigOncePerHour(client: SupabaseClient, config: AlertConfig | { missing: string }, now: Date) {
    if (now.getUTCMinutes() !== 0) return;
    if ('missing' in config) {
        const { count } = await client.from('ops_events').select('id', { count: 'exact', head: true }).is('alerted_at', null);
        if (count) console.warn(`Ops alerts: ${count} unsent event row(s) not emailed, ${config.missing} not set`);
    } else if (config.dropped > 0) {
        console.warn(`Ops alerts: ${config.dropped} OPS_ALERT_EMAIL entr${config.dropped === 1 ? 'y is' : 'ies are'} not an email address and ignored`);
    }
}

export async function maybeSendOpsAlerts(client: SupabaseClient, now: Date = new Date()): Promise<OpsAlertResult> {
    const config = opsAlertConfig();
    await warnConfigOncePerHour(client, config, now);
    if ('missing' in config) return { sent: false, kinds: [], reason: `${config.missing} not set` };

    const { data, error } = await client.rpc('claim_ops_alerts', {
        p_cooldown_seconds: ALERT_EVERY_S,
        p_daily_kinds: DAILY_ALERT_KINDS,
    });
    if (error) {
        console.error('Ops alerts: claiming failed', { code: error.code });
        return { sent: false, kinds: [], reason: 'claim failed' };
    }
    const groups = (Array.isArray(data) ? data : []) as OpsAlertGroup[];
    if (groups.length === 0) return { sent: false, kinds: [] };
    const { stamp, cutoff } = groups[0];
    const kinds = [...new Set(groups.map((g) => g.kind))].sort();

    const { subject, text } = buildOpsAlertEmail(groups, await orgNamesOf(client, groups.map((g) => g.org_id)), now);
    const sendFailure = await sendEmail(config, subject, text);
    if (sendFailure) {
        console.error('Ops alerts: sending the email failed', { kinds, reason: sendFailure });
        const { error: releaseError } = await client.rpc('release_ops_alerts', { p_stamp: stamp });
        if (releaseError) {
            console.error('Ops alerts: the claim could not be released either; these events are emailed after the wait (an hour, a day for a daily kind)', {
                kinds,
                code: releaseError.code,
            });
        }
        return { sent: false, kinds: [], reason: 'send failed' };
    }
    const { error: markError } = await client.rpc('mark_ops_alerts_sent', { p_stamp: stamp, p_cutoff: cutoff });
    if (markError) {
        console.error('Ops alerts: emailed, but the events could not be marked sent; they may be emailed again after the wait (an hour, a day for a daily kind)', {
            kinds,
            code: markError.code,
        });
    }
    return { sent: true, kinds };
}

/** Start of the Asia/Jakarta day of `now`, as an instant. */
export function startOfWibDay(now: Date): Date {
    const wibNow = new Date(now.getTime() + WIB_OFFSET_MS);
    return new Date(Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate()) - WIB_OFFSET_MS);
}

type SummaryRow = { kind: string; org_id: string | null; events: number | string; unsent: number | string };

export function buildOpsDailySummaryEmail(
    rows: SummaryRow[] | null,
    failedJobs: number | null,
    orgNames: Map<string, string>,
    now: Date,
): { subject: string; text: string } {
    const byKind = new Map<string, SummaryRow[]>();
    for (const r of rows ?? []) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
    const total = (rows ?? []).reduce((n, r) => n + Number(r.events), 0);
    const lines: string[] = [`Ringkasan harian operasional Sarathi, ${wib(now)} (24 jam terakhir).`, ''];
    if (rows === null) {
        lines.push('Kejadian operasional: tidak bisa dibaca (lihat log server).');
    } else if (total === 0) {
        lines.push('Kejadian operasional: tidak ada.');
    } else {
        lines.push('Kejadian operasional:');
        for (const kind of [...byKind.keys()].sort()) {
            const list = byKind.get(kind)!;
            const n = list.reduce((s, r) => s + Number(r.events), 0);
            const unsent = list.reduce((s, r) => s + Number(r.unsent), 0);
            lines.push(`- ${label(kind)}: ${n}${unsent ? ` (${unsent} belum dikirim lewat email)` : ''}`);
            lines.push(`  org: ${list.map((r) => `${orgLabel(r.org_id, orgNames)} (${Number(r.events)})`).join(', ')}`);
        }
    }
    lines.push('', `Job antrean gagal: ${failedJobs === null ? 'tidak bisa dibaca' : failedJobs === 0 ? 'tidak ada' : failedJobs}.`);
    lines.push(
        '',
        `Email ini dikirim setiap hari mulai pukul 0${DAILY_HOUR_WIB}.00 WIB, juga saat semuanya normal. Bila suatu hari tidak datang, cron antrean (/api/queue/process) kemungkinan berhenti, dan bersamanya semua peringatan: periksa layanan cron di Easypanel.`,
    );
    const events = rows === null ? 'kejadian tidak bisa dibaca' : total === 0 ? 'tidak ada kejadian' : `${total} kejadian`;
    const subject = `[Sarathi] Ringkasan harian: ${events}${failedJobs ? `, ${failedJobs} job gagal` : ''}`;
    return { subject, text: lines.join('\n') };
}

export async function maybeSendOpsDailySummary(client: SupabaseClient, now: Date = new Date()): Promise<{ sent: boolean; reason?: string }> {
    if (new Date(now.getTime() + WIB_OFFSET_MS).getUTCHours() < DAILY_HOUR_WIB) return { sent: false };
    const config = opsAlertConfig();
    if ('missing' in config) return { sent: false, reason: `${config.missing} not set` };

    const { data: stamp, error } = await client.rpc('claim_ops_daily_summary', { p_since: startOfWibDay(now).toISOString() });
    if (error) {
        console.error('Ops daily summary: claiming failed', { code: error.code });
        return { sent: false, reason: 'claim failed' };
    }
    if (!stamp) return { sent: false };

    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const [summary, failed] = await Promise.all([
        client.rpc('ops_events_summary', { p_since: since }),
        client.from('message_queue').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('processed_at', since),
    ]);
    const rows = summary.error ? null : ((Array.isArray(summary.data) ? summary.data : []) as SummaryRow[]);
    if (summary.error) console.error('Ops daily summary: reading the events failed', { code: summary.error.code });
    const failedJobs = failed.error ? null : failed.count ?? 0;

    const { subject, text } = buildOpsDailySummaryEmail(rows, failedJobs, await orgNamesOf(client, (rows ?? []).map((r) => r.org_id)), now);
    const sendFailure = await sendEmail(config, subject, text);
    if (sendFailure) {
        console.error('Ops daily summary: sending failed', { reason: sendFailure });
        const { error: releaseError } = await client.rpc('release_ops_alerts', { p_stamp: stamp });
        if (releaseError) console.error('Ops daily summary: the claim could not be released; no retry today', { code: releaseError.code });
        return { sent: false, reason: 'send failed' };
    }
    return { sent: true };
}
