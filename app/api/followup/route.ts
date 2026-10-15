import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { NextResponse } from 'next/server';
import { computeFollowup } from '@/lib/followup/compute';

// Follow-up surface: leads/bookings that need attention right now. Computed live
// (no cron, no stored state) and org-scoped via RLS. The /dashboard/followup
// page and the sidebar badge consume this; the WhatsApp digest cron reuses
// computeFollowup directly (lib/followup/compute.ts).

export async function GET() {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase } = access;
    try {
        const data = await computeFollowup(supabase);
        return NextResponse.json(data);
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Gagal memuat follow-up' },
            { status: 500 }
        );
    }
}
