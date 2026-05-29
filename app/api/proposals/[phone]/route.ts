import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { sendProposalEmail } from '@/lib/proposals/send';
import { normalizeFnaSnapshot } from '@/lib/proposals/fna';

// @react-pdf/renderer + Resend SDK both Node-only — pin to avoid future Edge migration.
export const runtime = 'nodejs';

// List the proposals already sent for a lead (newest first), including the FNA
// snapshot frozen at send time. Drafts (uploaded but never sent, sent_at=null)
// are excluded — the history shows only proposals that went out.
export async function GET(
    _request: Request,
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

    const { data, error } = await supabase
        .from('proposals')
        .select(
            'id, proposal_ref, source, file_path, intro_note, sent_at, sent_to_email, email_provider_id, skipped_reason, created_at, fna_snapshot'
        )
        .eq('lead_phone', phone)
        .not('sent_at', 'is', null)
        .order('created_at', { ascending: false });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, proposals: data ?? [] });
}

// Admin-triggered proposal send. Body accepts:
//   { proposal_id: string, intro_note?: string, fna_snapshot?: object }
//   - proposal_id: the uploaded PDF (from /upload) to send. The dialog always
//                  supplies this; the legacy template-render path still exists
//                  in sendProposalEmail but is no longer reachable from the UI.
//   - intro_note: personalised email opening.
//   - fna_snapshot: client-needs summary frozen onto the proposals row and
//                   synced back to the CRM record (see lib/proposals/fna.ts).
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
    let fnaSnapshot = null;
    try {
        const body = await request.json().catch(() => ({}));
        if (typeof body?.intro_note === 'string' && body.intro_note.trim()) {
            introNote = body.intro_note.trim();
        }
        if (typeof body?.proposal_id === 'string' && body.proposal_id.trim()) {
            proposalId = body.proposal_id.trim();
        }
        if (body?.fna_snapshot) {
            fnaSnapshot = normalizeFnaSnapshot(body.fna_snapshot);
        }
    } catch {
        // Empty body is fine — defaults to fresh generated proposal.
    }

    const result = await sendProposalEmail({
        phoneNumber: phone,
        proposalId,
        introNote,
        fnaSnapshot,
    });

    if (!result.ok) {
        return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
}
