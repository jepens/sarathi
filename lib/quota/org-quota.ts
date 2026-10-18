import type { SupabaseClient } from '@supabase/supabase-js';
import { describeErrorForOps, recordOpsEvent } from '@/lib/ops/events';

// Per-org quotas on the WhatsApp AI path (tracker 3.4, migration 0071; owner
// decision 2026-10-18 "Sedang", D22): per org, at most 30 new AI bursts a
// minute (webhook: a text that opens a chat's AI burst is counted; a fragment
// that joins the burst still waiting in the queue and a redelivery are not)
// and at most 300 AI replies a day, 00:00 to 00:00 WIB (queue: one unit per
// burst with a message not counted before; a plain retry is free, a message
// that joins a failing burst counts again). Over a limit the AI stops (hard
// stop); the message itself is still stored for the operators. The team is
// alerted (ops_events, emailed by lib/ops/alerts.ts) on the first refusal after
// a call that was let through (once per window, and again when a raised limit
// is reached), and warned when the daily count reaches 80% of the limit in
// force. There is no 80% warning for the minute window: nobody can act within
// the minute, and its refusals are alerted anyway.
//
// The team changes one org's limits in public.org_quota_overrides (service
// role only; not app_settings, which every org member can write).
//
// Fails open: when the counter cannot be used (a database error, or 0071 not
// applied yet) the call is let through and the team is alerted that the quota
// is not enforced. A counter outage must not silence every customer.

export type QuotaMetric = 'inbound_minute' | 'ai_reply_day';

/** The limits of an org without an override (owner decision 2026-10-18). */
export const QUOTA_DEFAULTS: Readonly<Record<QuotaMetric, number>> = {
    inbound_minute: 30,
    ai_reply_day: 300,
};

/** Share of the daily AI quota at which the team is warned. */
export const QUOTA_WARN_SHARE = 0.8;

export interface QuotaDecision {
    allowed: boolean;
    /** Calls let through in this window (this one included when allowed). */
    used: number;
    /** Calls refused in this window (this one included when refused). */
    refused: number;
    /** The limit that applied: the org's override, else the default. */
    limit: number;
    /** A refusal right after a call that was let through: the one to alert. */
    firstRefusal: boolean;
}

/** The daily count at which the team is warned: 80% of the limit, at least 1. */
export function warnThreshold(limit: number): number {
    return Math.max(1, Math.ceil(limit * QUOTA_WARN_SHARE));
}

/**
 * Counts one call against the org's current window and says whether it is
 * within the limit. Never throws.
 */
export async function consumeOrgQuota(
    client: SupabaseClient,
    orgId: string,
    metric: QuotaMetric,
): Promise<QuotaDecision> {
    let decision: QuotaDecision;
    try {
        const { data, error } = await client.rpc('consume_org_quota', {
            p_org: orgId,
            p_metric: metric,
            p_default_limit: QUOTA_DEFAULTS[metric],
        });
        if (error) throw error;
        const row = (Array.isArray(data) ? data[0] : data) as
            | { allowed?: unknown; used?: unknown; refused?: unknown; quota?: unknown; first_refusal?: unknown }
            | null
            | undefined;
        if (!row || typeof row.allowed !== 'boolean') throw new Error('consume_org_quota returned no row');
        decision = {
            allowed: row.allowed,
            used: Number(row.used) || 0,
            refused: Number(row.refused) || 0,
            limit: Number(row.quota) || QUOTA_DEFAULTS[metric],
            firstRefusal: row.first_refusal === true,
        };
    } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        const reason = typeof code === 'string' && code ? code : describeErrorForOps(err);
        console.error('Org quota check failed, letting the call through', { metric, reason });
        await recordOpsEvent(client, 'quota_check_failed', { orgId, detail: `${metric}: ${reason}` });
        return { allowed: true, used: 0, refused: 0, limit: QUOTA_DEFAULTS[metric], firstRefusal: false };
    }

    if (!decision.allowed && decision.firstRefusal) {
        await recordOpsEvent(
            client,
            metric === 'ai_reply_day' ? 'quota_ai_daily_exceeded' : 'quota_inbound_exceeded',
            {
                orgId,
                detail:
                    metric === 'ai_reply_day'
                        ? `batas ${decision.limit} balasan AI per hari tercapai`
                        : `batas ${decision.limit} percakapan AI baru per menit tercapai`,
            },
        );
    } else if (decision.allowed && metric === 'ai_reply_day' && decision.used === warnThreshold(decision.limit)) {
        await recordOpsEvent(client, 'quota_ai_daily_warning', {
            orgId,
            detail: `${decision.used} dari ${decision.limit} balasan AI hari ini terpakai`,
        });
    }
    return decision;
}

/** The operators' note on a message the minute quota kept from the AI. */
export function inboundQuotaNotice(limit: number): string {
    return `Pesan pelanggan di atas (dan pesan berikutnya pada menit yang sama) tidak dibalas AI: batas ${limit} percakapan AI baru per menit untuk organisasi ini tercapai. Balas secara manual bila perlu; bila pelanggan menulis lagi, AI tetap membaca pesan ini sebagai konteks.`;
}

const notedChats = new Map<string, number>();

/**
 * True at most once per chat and minute (per server process): whether a
 * refused message gets the operators' note, so a burst of refused fragments
 * does not fill the thread with notes.
 */
export function firstInboundRefusalNote(chatKey: string, now = Date.now()): boolean {
    const minute = Math.floor(now / 60_000);
    if (notedChats.get(chatKey) === minute) return false;
    if (notedChats.size > 5000) notedChats.clear();
    notedChats.set(chatKey, minute);
    return true;
}
