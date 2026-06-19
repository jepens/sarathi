import { SupabaseClient } from '@supabase/supabase-js';

// Shared follow-up computation. Used by the UI route (/api/followup, RLS-scoped
// via the cookie client) and the WhatsApp digest cron (service-role client +
// explicit orgId). Client-safe types — no server-only imports.

export const STALE_LEAD_DAYS = 3; // no activity for >= this many days
export const BOOKING_HORIZON_DAYS = 7; // events within the next N days

// Working stages where a quiet lead still needs chasing. 'booked'/'won' have
// converted (followed up on the booking side); 'lost' is dead.
const ACTIVE_LEAD_STAGES = new Set(['new', 'qualifying', 'quoted', 'scheduled']);

const DAY_MS = 86_400_000;

interface LeadRow {
    phone_number: string;
    contact_name: string | null;
    lead_stage: string | null;
    last_message_at: string | null;
    last_inbound_at: string | null;
    created_at: string;
}
interface OrderRow {
    id: string;
    customer_name: string | null;
    event_date: string | null;
    status: string | null;
    dp_paid_at: string | null;
    pelunasan_paid_at: string | null;
}

export interface FollowupLead {
    phone_number: string;
    contact_name: string | null;
    lead_stage: string | null;
    reason: 'stale' | 'proposal_no_reply';
    days: number;
}
export interface FollowupBooking {
    id: string;
    customer_name: string | null;
    event_date: string | null;
    days_until: number;
    status: string | null;
    dp_paid: boolean;
    settled: boolean;
}
export interface FollowupData {
    counts: { leads: number; bookings: number; total: number };
    leads: FollowupLead[];
    bookings: FollowupBooking[];
}

function jakartaDateString(d: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${day}`;
}

// Whole-day difference between two WIB calendar dates (eventIso - todayStr).
function daysUntilWIB(eventIso: string, todayStr: string): number {
    const [ey, em, ed] = jakartaDateString(new Date(eventIso)).split('-').map(Number);
    const [ty, tm, td] = todayStr.split('-').map(Number);
    return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(ty, tm - 1, td)) / DAY_MS);
}

export async function computeFollowup(
    supabase: SupabaseClient,
    orgId?: string
): Promise<FollowupData> {
    const now = new Date();
    const nowMs = now.getTime();
    const todayStr = jakartaDateString(now);
    const startOfTodayIso = `${todayStr}T00:00:00+07:00`;

    const [hy, hm, hd] = todayStr.split('-').map(Number);
    const horizon = new Date(Date.UTC(hy, hm - 1, hd + BOOKING_HORIZON_DAYS));
    const horizonStr = `${horizon.getUTCFullYear()}-${String(horizon.getUTCMonth() + 1).padStart(2, '0')}-${String(horizon.getUTCDate()).padStart(2, '0')}`;
    const horizonIso = `${horizonStr}T23:59:59+07:00`;

    let leadsQuery = supabase
        .from('whatsapp_chats')
        .select('phone_number, contact_name, lead_stage, last_message_at, last_inbound_at, created_at')
        .eq('contact_type', 'lead');
    let ordersQuery = supabase
        .from('orders')
        .select('id, customer_name, event_date, status, dp_paid_at, pelunasan_paid_at')
        .not('event_date', 'is', null)
        .gte('event_date', startOfTodayIso)
        .lte('event_date', horizonIso)
        .neq('status', 'cancelled');
    // Cron/service-role callers bypass RLS, so scope to the org explicitly.
    if (orgId) {
        leadsQuery = leadsQuery.eq('org_id', orgId);
        ordersQuery = ordersQuery.eq('org_id', orgId);
    }

    const [leadsRes, ordersRes] = await Promise.all([leadsQuery, ordersQuery]);

    if (leadsRes.error) throw new Error(leadsRes.error.message);
    if (ordersRes.error) throw new Error(ordersRes.error.message);

    const leads: FollowupLead[] = [];
    for (const l of (leadsRes.data ?? []) as LeadRow[]) {
        const stage = l.lead_stage ?? 'new'; // unstaged behaves like 'new'
        if (!ACTIVE_LEAD_STAGES.has(stage)) continue;

        if (stage === 'quoted') {
            const inboundMs = l.last_inbound_at ? new Date(l.last_inbound_at).getTime() : null;
            const noReplyDays =
                inboundMs === null
                    ? Math.floor((nowMs - new Date(l.created_at).getTime()) / DAY_MS)
                    : Math.floor((nowMs - inboundMs) / DAY_MS);
            if (inboundMs === null || noReplyDays >= STALE_LEAD_DAYS) {
                leads.push({
                    phone_number: l.phone_number,
                    contact_name: l.contact_name,
                    lead_stage: l.lead_stage,
                    reason: 'proposal_no_reply',
                    days: noReplyDays,
                });
                continue;
            }
        }

        const lastTouch = l.last_message_at ?? l.created_at;
        const ageDays = Math.floor((nowMs - new Date(lastTouch).getTime()) / DAY_MS);
        if (ageDays >= STALE_LEAD_DAYS) {
            leads.push({
                phone_number: l.phone_number,
                contact_name: l.contact_name,
                lead_stage: l.lead_stage,
                reason: 'stale',
                days: ageDays,
            });
        }
    }
    leads.sort((a, b) => b.days - a.days);

    const bookings: FollowupBooking[] = ((ordersRes.data ?? []) as OrderRow[])
        .map((o) => ({
            id: o.id,
            customer_name: o.customer_name,
            event_date: o.event_date,
            days_until: o.event_date ? daysUntilWIB(o.event_date, todayStr) : 0,
            status: o.status,
            dp_paid: o.dp_paid_at != null,
            settled: o.pelunasan_paid_at != null,
        }))
        .sort((a, b) => a.days_until - b.days_until);

    return {
        counts: { leads: leads.length, bookings: bookings.length, total: leads.length + bookings.length },
        leads: leads.slice(0, 100),
        bookings: bookings.slice(0, 100),
    };
}
