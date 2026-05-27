import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { sendProposalEmail } from '@/lib/proposals/send';

// @react-pdf/renderer + Resend SDK both Node-only — pin to avoid future Edge migration.
export const runtime = 'nodejs';

// Admin-triggered proposal send. Body accepts:
//   { intro_note?: string,  proposal_id?: string }
//   - intro_note: personalised email opening (applies to either source)
//   - proposal_id: send a previously-uploaded PDF from the proposals table.
//                  If omitted, render a fresh template proposal.
//
// Both paths go through the same sendProposalEmail helper.
export async function POST(
    request: Request,
    { params }: { params: Promise<{ phone: string }> }
) {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { phone } = await params;
    if (!phone) {
        return NextResponse.json({ error: 'Phone required' }, { status: 400 });
    }

    let introNote: string | null = null;
    let proposalId: string | null = null;
    try {
        const body = await request.json().catch(() => ({}));
        if (typeof body?.intro_note === 'string' && body.intro_note.trim()) {
            introNote = body.intro_note.trim();
        }
        if (typeof body?.proposal_id === 'string' && body.proposal_id.trim()) {
            proposalId = body.proposal_id.trim();
        }
    } catch {
        // Empty body is fine — defaults to fresh generated proposal.
    }

    const result = await sendProposalEmail({
        phoneNumber: phone,
        proposalId,
        introNote,
    });

    if (!result.ok) {
        return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
}
