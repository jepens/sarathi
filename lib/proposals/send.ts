import { createClient } from '@/lib/supabase/server';
import { generateProposalRef, shouldBumpToQuoted } from './ref';
import { stripAuditLines, extractAuditLines } from './notes';
import type { FnaSnapshot } from './fna';

// Proposal generation + send pipeline. Supports two sources:
//   - 'generated' — rendered on demand from ProposalDocument template
//   - 'uploaded'  — admin-uploaded custom PDF stored in Supabase Storage
//
// All sends produce a row in the `proposals` table for audit. Uploads create
// the row at upload time (sent_at=null); sending later updates that row.
// Generated proposals only get a row at send time (we don't track drafts of
// templates because they're cheap to re-render).

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

export interface SendProposalResult {
    ok: boolean;
    error?: string;
    sent?: boolean;
    email_id?: string;
    proposal_id?: string;
    proposal_ref?: string;
    skipped_reason?: string;
}

interface ChatRow {
    contact_name: string | null;
    email: string | null;
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
    notes: string | null;
}

interface ProductRow {
    name: string;
    description: string | null;
    price: number;
}

interface ProposalRow {
    id: string;
    lead_phone: string;
    source: 'generated' | 'uploaded';
    file_path: string | null;
    intro_note: string | null;
    proposal_ref: string;
    sent_at: string | null;
}

interface ProposalContext {
    lead: ChatRow;
    recommended: ProductRow[];
    proposalRef: string;
    issuedAt: Date;
}

// ── helpers ──────────────────────────────────────────────────────────────

async function loadLead(
    phoneNumber: string,
    supabase: SupabaseServer
): Promise<
    | { ok: true; lead: ChatRow }
    | { ok: false; status: number; error: string }
> {
    const { data, error } = await supabase
        .from('whatsapp_chats')
        .select(
            'contact_name, email, event_interest, participant_count, location_pref, event_date_pref, event_goals, budget_range, notes'
        )
        .eq('phone_number', phoneNumber)
        .maybeSingle<ChatRow>();

    if (error) return { ok: false, status: 500, error: error.message };
    if (!data) return { ok: false, status: 404, error: 'Lead not found' };
    return { ok: true, lead: data };
}

async function loadRecommendedPackages(
    interestRaw: string | null,
    supabase: SupabaseServer
): Promise<ProductRow[]> {
    // Sanitise the interest string before injecting into a PostgREST .or()
    // filter: commas split the OR into separate expressions, parens are
    // syntax, LIKE wildcards widen unexpectedly.
    const interest = (interestRaw ?? '')
        .replace(/[,()%_]/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');

    let rows: ProductRow[] = [];
    if (interest) {
        const { data } = await supabase
            .from('products')
            .select('name, description, price')
            .or(`name.ilike.%${interest}%,description.ilike.%${interest}%`)
            .eq('type', 'service')
            .limit(3);
        rows = (data ?? []) as ProductRow[];
    }
    if (rows.length === 0) {
        const { data } = await supabase
            .from('products')
            .select('name, description, price')
            .eq('type', 'service')
            .order('created_at', { ascending: false })
            .limit(3);
        rows = (data ?? []) as ProductRow[];
    }
    return rows;
}

async function buildGeneratedContext(
    phoneNumber: string,
    supabase: SupabaseServer
): Promise<
    | { ok: true; context: ProposalContext; lead: ChatRow }
    | { ok: false; status: number; error: string }
> {
    const loaded = await loadLead(phoneNumber, supabase);
    if (!loaded.ok) return loaded;
    const lead = loaded.lead;

    const recommended = await loadRecommendedPackages(lead.event_interest, supabase);
    const issuedAt = new Date();
    const proposalRef = generateProposalRef(phoneNumber, issuedAt);

    return {
        ok: true,
        lead,
        context: { lead, recommended, proposalRef, issuedAt },
    };
}

// Render a template proposal to PDF Buffer. Lazy imports so heavy deps
// stay out of bundles that don't render PDFs.
async function renderGeneratedPdf(
    context: ProposalContext,
    phoneNumber: string,
    introNote: string | null
): Promise<Buffer> {
    const [{ renderToBuffer }, { ProposalDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./ProposalDocument'),
    ]);

    return renderToBuffer(
        ProposalDocument({
            lead: {
                name: context.lead.contact_name ?? 'Calon Klien',
                email: context.lead.email ?? '',
                phone: phoneNumber,
                event_interest: context.lead.event_interest,
                participant_count: context.lead.participant_count,
                location_pref: context.lead.location_pref,
                event_date_pref: context.lead.event_date_pref,
                event_goals: context.lead.event_goals,
                budget_range: context.lead.budget_range,
            },
            packages: context.recommended,
            introNote,
            issuedAt: context.issuedAt,
        })
    );
}

// Fetch an uploaded PDF from Storage. The bucket is private, so we go
// through the authenticated server client — RLS enforces access.
async function downloadUploadedPdf(
    filePath: string,
    supabase: SupabaseServer
): Promise<
    | { ok: true; buffer: Buffer }
    | { ok: false; status: number; error: string }
> {
    const { data, error } = await supabase.storage
        .from('proposals')
        .download(filePath);
    if (error || !data) {
        return {
            ok: false,
            status: 500,
            error: `Storage download failed: ${error?.message ?? 'unknown'}`,
        };
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    return { ok: true, buffer };
}

// ── public: build a Buffer for preview ───────────────────────────────────

export interface PreviewParams {
    phoneNumber: string;
    proposalId?: string | null;  // existing uploaded proposal
    introNote?: string | null;   // applies to generated mode
}

export async function buildProposalPreview(
    params: PreviewParams
): Promise<
    | { ok: true; buffer: Buffer; filename: string }
    | { ok: false; status: number; error: string }
> {
    const supabase = await createClient();

    if (params.proposalId) {
        const { data, error } = await supabase
            .from('proposals')
            .select('id, lead_phone, source, file_path, intro_note, proposal_ref, sent_at')
            .eq('id', params.proposalId)
            .maybeSingle<ProposalRow>();
        if (error) return { ok: false, status: 500, error: error.message };
        if (!data) return { ok: false, status: 404, error: 'Proposal not found' };
        if (data.lead_phone !== params.phoneNumber) {
            return { ok: false, status: 403, error: 'Proposal does not belong to this lead' };
        }

        if (data.source === 'uploaded' && data.file_path) {
            const dl = await downloadUploadedPdf(data.file_path, supabase);
            if (!dl.ok) return dl;
            return {
                ok: true,
                buffer: dl.buffer,
                filename: `${data.proposal_ref}.pdf`,
            };
        }
        // Fall through to regenerate from template if somehow source=generated
        // got persisted with no file_path — shouldn't happen given the CHECK
        // constraint, but defensive.
    }

    const built = await buildGeneratedContext(params.phoneNumber, supabase);
    if (!built.ok) return built;
    const buffer = await renderGeneratedPdf(
        built.context,
        params.phoneNumber,
        params.introNote ?? null
    );
    return {
        ok: true,
        buffer,
        filename: `${built.context.proposalRef}.pdf`,
    };
}

// ── public: send (with optional uploaded source) ─────────────────────────

export interface SendParams {
    phoneNumber: string;
    proposalId?: string | null;  // if present, send the uploaded PDF
    introNote?: string | null;
    fnaSnapshot?: FnaSnapshot | null;  // client-needs snapshot frozen onto the row
}

export async function sendProposalEmail(
    params: SendParams
): Promise<SendProposalResult> {
    const supabase = await createClient();

    // Resolve buffer + proposal row depending on source.
    let pdfBuffer: Buffer;
    let proposalRef: string;
    let proposalRow: ProposalRow | null = null;
    let lead: ChatRow;

    if (params.proposalId) {
        const { data, error } = await supabase
            .from('proposals')
            .select('id, lead_phone, source, file_path, intro_note, proposal_ref, sent_at')
            .eq('id', params.proposalId)
            .maybeSingle<ProposalRow>();
        if (error) return { ok: false, error: error.message };
        if (!data) return { ok: false, error: 'Proposal not found' };
        if (data.lead_phone !== params.phoneNumber) {
            return { ok: false, error: 'Proposal does not belong to this lead' };
        }
        if (data.source !== 'uploaded' || !data.file_path) {
            return { ok: false, error: 'Proposal row is not an uploaded file' };
        }

        const leadRes = await loadLead(params.phoneNumber, supabase);
        if (!leadRes.ok) return { ok: false, error: leadRes.error };
        lead = leadRes.lead;

        const dl = await downloadUploadedPdf(data.file_path, supabase);
        if (!dl.ok) return { ok: false, error: dl.error };
        pdfBuffer = dl.buffer;
        proposalRef = data.proposal_ref;
        proposalRow = data;
    } else {
        const built = await buildGeneratedContext(params.phoneNumber, supabase);
        if (!built.ok) return { ok: false, error: built.error };
        lead = built.lead;
        pdfBuffer = await renderGeneratedPdf(
            built.context,
            params.phoneNumber,
            params.introNote ?? null
        );
        proposalRef = built.context.proposalRef;
    }

    if (!lead.email) {
        return {
            ok: false,
            error: 'Lead has no email on file. Add the email before sending.',
        };
    }

    const sentToEmail = lead.email;
    const introNote = params.introNote ?? null;

    const resendKey = process.env.RESEND_API_KEY;
    const fromAddress = process.env.SAILENDRA_FROM_EMAIL;

    // Without Resend credentials we still want a successful response — admin
    // can re-send later when credentials are configured. Stage is bumped
    // either way to reflect the human decision to commit.
    if (!resendKey || !fromAddress) {
        const skippedReason = !resendKey
            ? 'RESEND_API_KEY not set'
            : 'SAILENDRA_FROM_EMAIL not set';
        const auditId = await upsertSentRecord({
            supabase,
            phoneNumber: params.phoneNumber,
            proposalRow,
            proposalRef,
            introNote,
            sentToEmail,
            emailProviderId: null,
            skippedReason,
            fnaSnapshot: params.fnaSnapshot ?? null,
        });
        await markQuoted(supabase, params.phoneNumber, proposalRef, false, params.fnaSnapshot ?? null);
        return {
            ok: true,
            sent: false,
            skipped_reason: skippedReason,
            proposal_id: auditId,
            proposal_ref: proposalRef,
        };
    }

    try {
        const { Resend } = await import('resend');
        const resend = new Resend(resendKey);

        const html = buildEmailBody({
            name: lead.contact_name ?? 'Kak',
            introNote,
        });

        const { data, error } = await resend.emails.send({
            from: fromAddress,
            to: [sentToEmail],
            subject: `Penawaran Awal Acara dari Sailendra Organizer (${proposalRef})`,
            html,
            attachments: [
                {
                    filename: `${proposalRef}.pdf`,
                    content: pdfBuffer,
                },
            ],
        });

        if (error) {
            return { ok: false, error: error.message, proposal_ref: proposalRef };
        }

        const auditId = await upsertSentRecord({
            supabase,
            phoneNumber: params.phoneNumber,
            proposalRow,
            proposalRef,
            introNote,
            sentToEmail,
            emailProviderId: data?.id ?? null,
            skippedReason: null,
            fnaSnapshot: params.fnaSnapshot ?? null,
        });
        await markQuoted(supabase, params.phoneNumber, proposalRef, true, params.fnaSnapshot ?? null);

        return {
            ok: true,
            sent: true,
            email_id: data?.id,
            proposal_id: auditId,
            proposal_ref: proposalRef,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Resend send failed';
        return { ok: false, error: msg, proposal_ref: proposalRef };
    }
}

// For uploaded proposals we update the existing row (created at upload time).
// For generated proposals we insert a fresh row. Returns the proposal id.
async function upsertSentRecord(args: {
    supabase: SupabaseServer;
    phoneNumber: string;
    proposalRow: ProposalRow | null;
    proposalRef: string;
    introNote: string | null;
    sentToEmail: string;
    emailProviderId: string | null;
    skippedReason: string | null;
    fnaSnapshot: FnaSnapshot | null;
}): Promise<string | undefined> {
    const stamp = new Date().toISOString();

    if (args.proposalRow) {
        const { data, error } = await args.supabase
            .from('proposals')
            .update({
                intro_note: args.introNote,
                sent_at: stamp,
                sent_to_email: args.sentToEmail,
                email_provider_id: args.emailProviderId,
                skipped_reason: args.skippedReason,
                fna_snapshot: args.fnaSnapshot,
            })
            .eq('id', args.proposalRow.id)
            .select('id')
            .single();
        if (error) {
            console.error('Failed to update proposals row', error);
            return args.proposalRow.id;
        }
        return data?.id;
    }

    const { data, error } = await args.supabase
        .from('proposals')
        .insert({
            lead_phone: args.phoneNumber,
            source: 'generated',
            file_path: null,
            intro_note: args.introNote,
            proposal_ref: args.proposalRef,
            sent_at: stamp,
            sent_to_email: args.sentToEmail,
            email_provider_id: args.emailProviderId,
            skipped_reason: args.skippedReason,
            fna_snapshot: args.fnaSnapshot,
        })
        .select('id')
        .single();
    if (error) {
        console.error('Failed to insert proposals row', error);
        return undefined;
    }
    return data?.id;
}

async function markQuoted(
    supabase: SupabaseServer,
    phoneNumber: string,
    proposalRef: string,
    emailSent: boolean,
    fnaSnapshot: FnaSnapshot | null
) {
    // Read current notes + stage so we can (1) append an audit line and
    // (2) decide whether to bump the stage. Sending a follow-up proposal to a
    // booked / won / lost lead must NOT regress them back to 'quoted'.
    const { data: row } = await supabase
        .from('whatsapp_chats')
        .select('notes, lead_stage')
        .eq('phone_number', phoneNumber)
        .maybeSingle<{ notes: string | null; lead_stage: string | null }>();
    const stamp = new Date().toISOString();
    const line = `[${stamp}] proposal ${proposalRef} ${emailSent ? 'sent' : 'generated (email skipped)'}`;

    // notes = human note + proposal audit trail. The FNA editor only ever sends
    // the human portion (audit lines are hidden from it), so use the admin's
    // edited note as the human part — falling back to the existing human note if
    // they left it blank — then re-attach the preserved audit trail plus this
    // send's line. This keeps history intact without ever surfacing audit lines
    // back into the editor.
    const humanNote =
        fnaSnapshot?.notes != null
            ? stripAuditLines(fnaSnapshot.notes)
            : stripAuditLines(row?.notes);
    const auditLines = [...extractAuditLines(row?.notes), line];
    const newNotes = [humanNote, ...auditLines].filter(Boolean).join('\n');

    const patch: Record<string, unknown> = {
        notes: newNotes,
        updated_at: stamp,
    };
    if (shouldBumpToQuoted(row?.lead_stage ?? null)) {
        patch.lead_stage = 'quoted';
    }

    // Sync edited FNA fields back to the CRM record. Fill-don't-clear: only
    // non-null values are written, mirroring the saveLeadInfo convention — so
    // an empty field in the dialog never wipes existing CRM data.
    if (fnaSnapshot) {
        if (fnaSnapshot.event_interest !== null) patch.event_interest = fnaSnapshot.event_interest;
        if (fnaSnapshot.participant_count !== null) patch.participant_count = fnaSnapshot.participant_count;
        if (fnaSnapshot.location_pref !== null) patch.location_pref = fnaSnapshot.location_pref;
        if (fnaSnapshot.event_date_pref !== null) patch.event_date_pref = fnaSnapshot.event_date_pref;
        if (fnaSnapshot.event_goals !== null) patch.event_goals = fnaSnapshot.event_goals;
        if (fnaSnapshot.budget_range !== null) patch.budget_range = fnaSnapshot.budget_range;
    }

    await supabase
        .from('whatsapp_chats')
        .update(patch)
        .eq('phone_number', phoneNumber);
}

function buildEmailBody({
    name,
    introNote,
}: {
    name: string;
    introNote: string | null;
}): string {
    const intro =
        introNote?.trim() ??
        'Terima kasih sudah menghubungi Sailendra Organizer. Berikut penawaran awal acara untuk kakak — silakan dilihat di lampiran PDF.';

    return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0f172a;max-width:560px;margin:0 auto;padding:24px;">
  <p>Halo Kak ${escapeHtml(name)},</p>
  <p>${escapeHtml(intro)}</p>
  <p>Untuk diskusi detail program, konsep, dan jadwal pembayaran, tim kami siap kapan saja. Balas email ini atau hubungi langsung Mas MJ (Lead Consultant) di +62 812-8195-8110.</p>
  <p style="margin-top:24px;color:#64748b;font-size:13px;">Salam hangat,<br/>Nindra<br/>Sailendra Organizer · sailendra.co.id</p>
</body></html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
