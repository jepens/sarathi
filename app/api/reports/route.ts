import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { LEAD_STAGES, type LeadStage } from '@/lib/ai/tools';
import { sourceLabel } from '@/lib/leads/schema';

// Reports / insight aggregation for /dashboard/reports.
// Org-scoped via the cookie-bound client (RLS). Period-bound metrics use the
// start/end query params (ISO); the funnel, source breakdown and outstanding
// receivables are current snapshots (not period-bound).

const REVENUE_STATUSES = ['paid', 'completed', 'won'];

interface PeriodOrder {
    total_amount: number | null;
    status: string | null;
    created_at: string;
    event_type: string | null;
}
interface OutstandingOrder {
    total_amount: number | null;
    dp_amount: number | null;
}
interface LeadRow {
    lead_stage: LeadStage | null;
    source: string | null;
    created_at: string;
}

// The "YYYY-MM" of a timestamp as observed in Asia/Jakarta (WIB). Bucketing in
// WIB keeps month bars aligned with the WIB-midnight period bounds the client
// sends — UTC slicing would mis-bin early-of-month WIB orders and add a phantom
// prior-month bar.
function jakartaYearMonth(iso: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
    }).formatToParts(new Date(iso));
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    return `${y}-${m}`;
}

function monthsBetween(startIso: string, endIso: string): string[] {
    const [sy, sm] = jakartaYearMonth(startIso).split('-').map(Number);
    const [ey, em] = jakartaYearMonth(endIso).split('-').map(Number);
    const months: string[] = [];
    let y = sy;
    let m = sm; // 1-12
    let guard = 0;
    // Guard bounds the zero-seed list for an absurd range; actual-data months
    // outside it are still added via upsert in the caller, so no revenue is lost.
    while ((y < ey || (y === ey && m <= em)) && guard < 120) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        m++;
        if (m > 12) {
            m = 1;
            y++;
        }
        guard++;
    }
    return months;
}

function monthLabel(ym: string): string {
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('id-ID', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

export async function GET(request: Request) {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), 0, 1).toISOString();
    const start = searchParams.get('start') ?? defaultStart;
    const end = searchParams.get('end') ?? now.toISOString();

    const [periodOrdersRes, outstandingRes, leadsRes] = await Promise.all([
        supabase
            .from('orders')
            .select('total_amount, status, created_at, event_type')
            .gte('created_at', start)
            .lte('created_at', end),
        // Current receivables: not fully settled and not cancelled.
        supabase
            .from('orders')
            .select('total_amount, dp_amount')
            .is('pelunasan_paid_at', null)
            .neq('status', 'cancelled'),
        supabase
            .from('whatsapp_chats')
            .select('lead_stage, source, created_at')
            .eq('contact_type', 'lead'),
    ]);

    if (periodOrdersRes.error) return errResp(periodOrdersRes.error.message);
    if (outstandingRes.error) return errResp(outstandingRes.error.message);
    if (leadsRes.error) return errResp(leadsRes.error.message);

    const periodOrders = (periodOrdersRes.data ?? []) as PeriodOrder[];
    const outstandingOrders = (outstandingRes.data ?? []) as OutstandingOrder[];
    const leads = (leadsRes.data ?? []) as LeadRow[];

    // --- Period order metrics ---
    const nonCancelled = periodOrders.filter((o) => o.status !== 'cancelled');
    const revenueOrders = periodOrders.filter(
        (o) => o.status != null && REVENUE_STATUSES.includes(o.status)
    );
    const revenue = revenueOrders.reduce((s, o) => s + Number(o.total_amount ?? 0), 0);
    const bookings = nonCancelled.length;
    const bookingsValue = nonCancelled.reduce((s, o) => s + Number(o.total_amount ?? 0), 0);
    const avgBookingValue = bookings > 0 ? Math.round(bookingsValue / bookings) : 0;

    // Revenue by WIB month (every month in range seeded at 0; any revenue order
    // is upserted so the chart sum always equals the revenue KPI).
    const monthBuckets = new Map<string, number>(monthsBetween(start, end).map((m) => [m, 0]));
    for (const o of revenueOrders) {
        const ym = jakartaYearMonth(o.created_at);
        monthBuckets.set(ym, (monthBuckets.get(ym) ?? 0) + Number(o.total_amount ?? 0));
    }
    const revenueByMonth = Array.from(monthBuckets.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([month, rev]) => ({ month, label: monthLabel(month), revenue: rev }));

    // Revenue by event type (top buckets).
    const typeBuckets = new Map<string, number>();
    for (const o of revenueOrders) {
        const t = o.event_type?.trim() || 'Tidak diisi';
        typeBuckets.set(t, (typeBuckets.get(t) ?? 0) + Number(o.total_amount ?? 0));
    }
    const revenueByEventType = Array.from(typeBuckets.entries())
        .map(([type, rev]) => ({ type, revenue: rev }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 8);

    // --- Outstanding receivables (current snapshot) ---
    const outstanding = outstandingOrders.reduce(
        (s, o) => s + Math.max(0, Number(o.total_amount ?? 0) - Number(o.dp_amount ?? 0)),
        0
    );

    // --- Lead metrics ---
    const leadsInPeriod = leads.filter((l) => l.created_at >= start && l.created_at <= end).length;

    const leadFunnel: Record<string, number> = { unstaged: 0 };
    for (const s of LEAD_STAGES) leadFunnel[s] = 0;
    for (const l of leads) {
        const key = l.lead_stage ?? 'unstaged';
        leadFunnel[key] = (leadFunnel[key] ?? 0) + 1;
    }
    const won = leadFunnel['won'] ?? 0;
    const lost = leadFunnel['lost'] ?? 0;
    const conversionRate = won + lost > 0 ? (won / (won + lost)) * 100 : null;

    const sourceBuckets = new Map<string, number>();
    for (const l of leads) {
        const label = sourceLabel(l.source);
        sourceBuckets.set(label, (sourceBuckets.get(label) ?? 0) + 1);
    }
    const leadsBySource = Array.from(sourceBuckets.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);

    return NextResponse.json({
        period: { start, end },
        kpis: {
            revenue,
            bookings,
            avgBookingValue,
            outstanding,
            leads: leadsInPeriod,
            conversionRate,
        },
        revenueByMonth,
        revenueByEventType,
        leadsBySource,
        leadFunnel,
    });
}

function errResp(msg: string) {
    return NextResponse.json({ error: msg }, { status: 500 });
}
