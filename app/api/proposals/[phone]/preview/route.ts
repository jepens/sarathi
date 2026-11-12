import { accessDeniedResponse, requireEnvIntegration } from '@/lib/settings/org-context';
import { NextResponse } from 'next/server';
import { buildProposalPreview } from '@/lib/proposals/send';

// Renders or fetches a PDF for the admin "Review & Send Proposal" dialog.
// Source:
//   - With `?proposal_id=...` → fetch the uploaded PDF from Storage (or
//     regenerate from template if the row is source='generated')
//   - Without `proposal_id` → render a fresh template proposal using
//     `?intro_note=...` to match what would be sent
//
// Opens inline in the browser; never writes any DB state.

export const runtime = 'nodejs';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ phone: string }> }
) {
    // Membership gate; buildProposalPreview reads through its own cookie-bound
    // (RLS) client, so it only ever sees this org's leads/proposals. Proposals
    // are Sailendra-only (D8, D26): the default org's members only.
    const access = await requireEnvIntegration('proposals');
    if (!access.ok) return accessDeniedResponse(access);

    const { phone } = await params;
    if (!phone) {
        return NextResponse.json({ error: 'Phone required' }, { status: 400 });
    }

    const url = new URL(request.url);
    const introNote = url.searchParams.get('intro_note');
    const proposalId = url.searchParams.get('proposal_id');

    const result = await buildProposalPreview({
        phoneNumber: phone,
        proposalId,
        introNote,
    });
    if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Wrap Buffer in Uint8Array so the Web Response BodyInit type accepts it
    // (Node Buffer is accepted at runtime but not in the TS BodyInit union).
    return new Response(new Uint8Array(result.buffer), {
        status: 200,
        headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${result.filename}"`,
            'Cache-Control': 'no-store, must-revalidate',
        },
    });
}
