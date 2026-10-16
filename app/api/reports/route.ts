import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { NextResponse } from 'next/server';
import { computeReport } from '@/lib/reports/aggregate';

// Reports / insight aggregation for /dashboard/reports.
// Org-scoped via the cookie-bound client (RLS). Period-bound metrics use the
// start/end query params (ISO); the funnel, source breakdown and outstanding
// receivables are current snapshots. The aggregation lives in
// lib/reports/aggregate.ts so the PDF route (/api/reports/pdf) shares it.

export async function GET(request: Request) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase } = access;

    const { searchParams } = new URL(request.url);
    const now = new Date();
    const start = searchParams.get('start') ?? new Date(now.getFullYear(), 0, 1).toISOString();
    const end = searchParams.get('end') ?? now.toISOString();

    try {
        const data = await computeReport(supabase, start, end);
        return NextResponse.json(data);
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Gagal memuat laporan' },
            { status: 500 }
        );
    }
}
