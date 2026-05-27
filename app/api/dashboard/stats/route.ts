import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { LEAD_STAGES, type LeadStage } from '@/lib/ai/tools';

// Dashboard Overview KPIs for the EO workflow.
//
// Returned shape:
//   {
//     leadFunnel: Record<LeadStage | "unstaged", number>,
//     leadsThisMonth: number,
//     conversionRate: number,                     // won / (won + lost) * 100, null when no closed
//     upcomingEvents: Array<{ id, customer_name, event_date, headcount, total_amount, status }>,
//     revenueThisMonth: number,                   // sum total_amount where order created this month and status in (paid, won, completed)
//     revenueYTD: number,
//     totalLeads: number
//   }

const REVENUE_STATUSES = ['paid', 'completed', 'won'];

interface LeadStageRow {
    lead_stage: LeadStage | null;
}

interface OrderRow {
    id: string;
    customer_name: string | null;
    event_date: string | null;
    headcount: number | null;
    total_amount: number | null;
    status: string | null;
    created_at: string;
}

export async function GET() {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const startOfYear = new Date(now.getFullYear(), 0, 1).toISOString();
    const nowIso = now.toISOString();

    // Run independent queries in parallel — they each touch different tables
    // (or the same table with different filters) so there's no ordering need.
    const [stageRowsRes, leadsThisMonthRes, upcomingEventsRes, revenueRowsRes] =
        await Promise.all([
            supabase.from('whatsapp_chats').select('lead_stage'),
            supabase
                .from('whatsapp_chats')
                .select('phone_number', { count: 'exact', head: true })
                .gte('created_at', startOfMonth),
            supabase
                .from('orders')
                .select('id, customer_name, event_date, headcount, total_amount, status')
                .not('event_date', 'is', null)
                .gte('event_date', nowIso)
                .order('event_date', { ascending: true })
                .limit(10),
            supabase
                .from('orders')
                .select('id, customer_name, event_date, headcount, total_amount, status, created_at')
                .in('status', REVENUE_STATUSES)
                .gte('created_at', startOfYear),
        ]);

    if (stageRowsRes.error) return errResp(stageRowsRes.error.message);
    if (leadsThisMonthRes.error) return errResp(leadsThisMonthRes.error.message);
    if (upcomingEventsRes.error) return errResp(upcomingEventsRes.error.message);
    if (revenueRowsRes.error) return errResp(revenueRowsRes.error.message);

    // Build funnel — initialise every stage to 0 so the kanban/funnel UI can
    // render empty columns instead of "undefined".
    const leadFunnel: Record<string, number> = { unstaged: 0 };
    for (const s of LEAD_STAGES) leadFunnel[s] = 0;
    for (const row of (stageRowsRes.data ?? []) as LeadStageRow[]) {
        const key = row.lead_stage ?? 'unstaged';
        leadFunnel[key] = (leadFunnel[key] ?? 0) + 1;
    }

    const totalLeads = (stageRowsRes.data ?? []).length;
    const won = leadFunnel['won'] ?? 0;
    const lost = leadFunnel['lost'] ?? 0;
    const closed = won + lost;
    const conversionRate = closed > 0 ? (won / closed) * 100 : null;

    // Revenue: aggregate in JS rather than another round-trip — dataset is
    // small (only paid/completed/won rows YTD).
    const revenueRows = (revenueRowsRes.data ?? []) as OrderRow[];
    let revenueYTD = 0;
    let revenueThisMonth = 0;
    for (const r of revenueRows) {
        const amt = Number(r.total_amount ?? 0);
        revenueYTD += amt;
        if (r.created_at >= startOfMonth) revenueThisMonth += amt;
    }

    return NextResponse.json({
        leadFunnel,
        leadsThisMonth: leadsThisMonthRes.count ?? 0,
        conversionRate,
        upcomingEvents: upcomingEventsRes.data ?? [],
        revenueThisMonth,
        revenueYTD,
        totalLeads,
    });
}

function errResp(msg: string) {
    return NextResponse.json({ error: msg }, { status: 500 });
}
