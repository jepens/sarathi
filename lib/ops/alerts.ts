import type { SupabaseClient } from '@supabase/supabase-js';

// Team alerts by email (tracker 3.5, migration 0070; owner decision
// 2026-10-18: email via Resend). Called every minute from the queue cron
// (/api/queue/process). Sends at most one email per run, covering every event
// kind that has unsent events and was not alerted in the last hour, so a
// burst of failures produces one email per hour per kind, not one per event.
//
// Recipients: OPS_ALERT_EMAIL (comma-separated). Sender: OPS_ALERT_FROM_EMAIL,
// else SAILENDRA_FROM_EMAIL. Without a recipient, a sender or RESEND_API_KEY
// nothing is sent: the events stay unsent (kept 30 days) and a warning is
// logged once an hour. Rows are claimed (alerted_at stamped) before sending,
// so two overlapping runs cannot both send them; a failed send un-claims them
// for the next run.

const ALERT_EVERY_MS = 60 * 60 * 1000;
const MAX_ROWS = 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const OPS_KIND_LABELS: Record<string, string> = {
    webhook_signature_invalid: 'Webhook WhatsApp ditolak: tanda tangan tidak valid (403)',
    webhook_error: 'Webhook WhatsApp gagal diproses (500)',
    queue_job_failed: 'Balasan AI gagal setelah semua percobaan',
    whatsapp_token_invalid: 'Token WhatsApp tidak valid atau kedaluwarsa (Meta 190)',
};

interface OpsEventRow {
    id: number;
    kind: string;
    org_id: string | null;
    detail: string;
    created_at: string;
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
}

export function opsAlertConfig(env: Record<string, string | undefined> = process.env): AlertConfig | { missing: string } {
    const to = (env.OPS_ALERT_EMAIL ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => EMAIL_RE.test(s));
    const from = (env.OPS_ALERT_FROM_EMAIL || env.SAILENDRA_FROM_EMAIL || '').trim();
    const key = (env.RESEND_API_KEY ?? '').trim();
    if (to.length === 0) return { missing: 'OPS_ALERT_EMAIL' };
    if (!from) return { missing: 'OPS_ALERT_FROM_EMAIL / SAILENDRA_FROM_EMAIL' };
    if (!key) return { missing: 'RESEND_API_KEY' };
    return { key, from, to };
}

const WIB = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'short',
});

function wib(iso: string | Date): string {
    return `${WIB.format(typeof iso === 'string' ? new Date(iso) : iso)} WIB`;
}

export function buildOpsAlertEmail(
    events: OpsEventRow[],
    orgNames: Map<string, string>,
    now: Date,
): { subject: string; text: string } {
    const byKind = new Map<string, OpsEventRow[]>();
    for (const e of events) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
    const kinds = [...byKind.keys()].sort();
    const lines: string[] = [`Peringatan operasional Sarathi, ${wib(now)}.`, ''];
    for (const kind of kinds) {
        const list = byKind.get(kind)!;
        const orgs = [...new Set(list.map((e) => (e.org_id ? orgNames.get(e.org_id) ?? e.org_id : '-')))];
        lines.push(`- ${OPS_KIND_LABELS[kind] ?? kind}: ${list.length} kejadian`);
        lines.push(`  pertama ${wib(list[0].created_at)}, terakhir ${wib(list[list.length - 1].created_at)}`);
        lines.push(`  org: ${orgs.join(', ')}`);
        const details = [...new Set(list.map((e) => e.detail).filter(Boolean))].slice(0, 3);
        for (const d of details) lines.push(`  contoh: ${d}`);
    }
    lines.push('', 'Email berikutnya untuk jenis yang sama paling cepat 1 jam lagi. Rincian: tabel ops_events (service role).');
    const subject = `[Sarathi] Peringatan: ${kinds.map((k) => OPS_KIND_LABELS[k] ?? k).join('; ')}`.slice(0, 200);
    return { subject, text: lines.join('\n') };
}

export async function maybeSendOpsAlerts(client: SupabaseClient, now: Date = new Date()): Promise<OpsAlertResult> {
    const { data: unsent, error } = await client
        .from('ops_events')
        .select('id, kind, org_id, detail, created_at')
        .is('alerted_at', null)
        .order('created_at', { ascending: true })
        .limit(MAX_ROWS);
    if (error) {
        console.error('Ops alerts: reading events failed', { code: error.code });
        return { sent: false, kinds: [], reason: 'read failed' };
    }
    const rows = (unsent ?? []) as OpsEventRow[];
    if (rows.length === 0) return { sent: false, kinds: [] };

    const since = new Date(now.getTime() - ALERT_EVERY_MS).toISOString();
    const { data: recent, error: recentError } = await client
        .from('ops_events')
        .select('kind')
        .gte('alerted_at', since)
        .limit(MAX_ROWS);
    if (recentError) {
        console.error('Ops alerts: reading recent alerts failed', { code: recentError.code });
        return { sent: false, kinds: [], reason: 'read failed' };
    }
    const cooling = new Set(((recent ?? []) as { kind: string }[]).map((r) => r.kind));
    const due = rows.filter((e) => !cooling.has(e.kind));
    if (due.length === 0) return { sent: false, kinds: [] };

    const config = opsAlertConfig();
    if ('missing' in config) {
        if (now.getUTCMinutes() === 0) {
            console.warn(`Ops alerts: ${due.length} event(s) not emailed, ${config.missing} not set`);
        }
        return { sent: false, kinds: [], reason: `${config.missing} not set` };
    }

    const stamp = now.toISOString();
    const { data: claimedRows, error: claimError } = await client
        .from('ops_events')
        .update({ alerted_at: stamp })
        .in('id', due.map((e) => e.id))
        .is('alerted_at', null)
        .select('id, kind, org_id, detail, created_at');
    const claimed = ((claimedRows ?? []) as OpsEventRow[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (claimError || claimed.length === 0) return { sent: false, kinds: [] };

    const orgIds = [...new Set(claimed.map((e) => e.org_id).filter((id): id is string => !!id))];
    const orgNames = new Map<string, string>();
    if (orgIds.length > 0) {
        const { data: orgs } = await client.from('organizations').select('id, name').in('id', orgIds);
        for (const o of (orgs ?? []) as { id: string; name: string | null }[]) orgNames.set(o.id, o.name ?? o.id);
    }

    const { subject, text } = buildOpsAlertEmail(claimed, orgNames, now);
    try {
        const { Resend } = await import('resend');
        const { error: sendError } = await new Resend(config.key).emails.send({
            from: config.from,
            to: config.to,
            subject,
            text,
        });
        if (sendError) throw new Error(sendError.message);
        return { sent: true, kinds: [...new Set(claimed.map((e) => e.kind))].sort() };
    } catch (err) {
        // Un-claim so the next run tries again.
        await client
            .from('ops_events')
            .update({ alerted_at: null })
            .in('id', claimed.map((e) => e.id))
            .eq('alerted_at', stamp);
        console.error('Ops alerts: sending the email failed', { reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' });
        return { sent: false, kinds: [], reason: 'send failed' };
    }
}
