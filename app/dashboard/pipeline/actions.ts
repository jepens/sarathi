'use server';

// Server actions for the Sarathi → Portal handoff (Phase 2). The actual outbound
// call to the Portal lives here (server-side) so PORTAL_INTAKE_TOKEN never ships
// to the browser and there's no cross-origin call from the client.

import { createClient } from '@/lib/supabase/server';
import { getCurrentOrgId } from '@/lib/settings/org-context';
import { isPortalConfigured } from '@/lib/portal/config';
import { postHandoff, PortalError } from '@/lib/portal/client';
import {
    buildHandoffBody,
    handoffInputSchema,
    type HandoffClientSelection,
    type HandoffLead,
} from '@/lib/portal/types';

type HandoffResult =
    | { ok: true; clientId: string; proposalUrl: string }
    | { ok: false; error: string };

// Exactly the lead columns the brief + identity need.
const LEAD_SELECT =
    'phone_number, contact_name, email, event_interest, participant_count, ' +
    'location_pref, event_date_pref, event_goals, budget_range, portal_client_id';

// The select string is a runtime const, so supabase-js can't infer the row
// shape — declare it explicitly for typed access below.
type LeadRow = HandoffLead & { portal_client_id: string | null };

/**
 * Create-or-link the lead's Portal client and spin up a DRAFT proposal there,
 * then remember the link on the lead. Returns the proposal URL for the caller
 * to open in a new tab.
 */
export async function handoffToPortal(raw: unknown): Promise<HandoffResult> {
    if (!isPortalConfigured()) {
        return { ok: false, error: 'Portal belum dikonfigurasi.' };
    }

    const parsed = handoffInputSchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? 'Input tidak valid' };
    }
    const input = parsed.data;

    const supabase = await createClient();
    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) return { ok: false, error: 'Tidak ada organisasi aktif untuk akun ini' };

    const { data, error } = await supabase
        .from('whatsapp_chats')
        .select(LEAD_SELECT)
        .eq('phone_number', input.phone)
        // Only real funnel leads — never hand off a vendor/'other' contact
        // (whatsapp_chats holds all three; mirrors GET /api/leads).
        .eq('contact_type', 'lead')
        .single();
    if (error || !data) return { ok: false, error: 'Lead tidak ditemukan' };
    const lead = data as unknown as LeadRow;

    // If this lead is already linked to a Portal client, ALWAYS reuse that id —
    // this enforces "no duplicate Portal client" even if a stale UI sent a
    // different selection (e.g. two tabs, or a race after the first link).
    const client: HandoffClientSelection = lead.portal_client_id
        ? { mode: 'existing', clientId: lead.portal_client_id }
        : input.client;

    const body = buildHandoffBody({
        idempotencyKey: input.idempotencyKey,
        client,
        title: input.title,
        lead,
    });

    let resp;
    try {
        resp = await postHandoff(body);
    } catch (err) {
        const msg =
            err instanceof PortalError
                ? err.message
                : err instanceof Error
                    ? err.message
                    : 'Gagal handoff ke Portal';
        return { ok: false, error: msg };
    }

    // Remember the link (idempotent — repeated handoffs just refresh the URL).
    // A failure to persist here is non-fatal: the proposal already exists in the
    // Portal, so surface the URL anyway and let the next handoff re-link.
    const { error: updateError } = await supabase
        .from('whatsapp_chats')
        .update({
            portal_client_id: resp.clientId,
            portal_last_proposal_url: resp.proposalUrl,
            updated_at: new Date().toISOString(),
        })
        .eq('phone_number', input.phone);
    if (updateError) {
        console.error('Handoff succeeded but failed to persist portal_client_id:', updateError);
    }

    return { ok: true, clientId: resp.clientId, proposalUrl: resp.proposalUrl };
}
