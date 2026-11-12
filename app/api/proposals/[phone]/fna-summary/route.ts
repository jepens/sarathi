import { accessDeniedResponse, requireEnvIntegration } from '@/lib/settings/org-context';
import { NextResponse } from 'next/server';
import { generateFnaSummary } from '@/lib/proposals/fna';

// Generates an AI needs-analysis (FNA) narrative from the lead's chat history +
// CRM fields. On-demand admin action triggered from the Send Proposal dialog;
// returns the text for review but does NOT persist anything (the snapshot is
// stored only when the proposal is actually sent).

export const runtime = 'nodejs';

export async function POST(
    _request: Request,
    { params }: { params: Promise<{ phone: string }> }
) {
    // Proposals (and their FNA) are Sailendra-only (D8, D26).
    const access = await requireEnvIntegration('proposals');
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase, orgId } = access;

    const { phone } = await params;
    if (!phone) {
        return NextResponse.json({ error: 'Phone required' }, { status: 400 });
    }

    const result = await generateFnaSummary(phone, supabase, orgId);
    if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, summary: result.summary });
}
