import { randomUUID } from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { type LeadInput, normalizePhone } from './schema';

// Server-only. Creates a lead (a whatsapp_chats row) or, when one already
// exists for the same org+identity, fills in ONLY the columns that are still
// empty — never overwriting data the team (or the AI) already captured.
//
// Identity:
//   • real phone given  → normalized digits (62…); also stored as verified_phone
//     so the row auto-merges when that person later messages on WhatsApp (the
//     composite PK is (org_id, phone_number)).
//   • no/invalid phone  → synthetic `manual:<uuid>` so the lead is still
//     trackable in the pipeline until a real number arrives.
//
// Result kinds:
//   • created          — a new lead row was inserted.
//   • updated          — an existing lead had empty cells filled in.
//   • unchanged        — an existing lead already had everything; no write.
//   • skipped_non_lead — the phone belongs to a NON-lead contact (vendor/other);
//     we refuse to blend lead data onto it and report it back instead.

export type CreateLeadResult = {
    result: 'created' | 'updated' | 'unchanged' | 'skipped_non_lead';
    phone_number: string;
    contact_name: string | null;
};

// Free-text/number columns we may copy from the input into an EMPTY cell.
// Stage/source/identity are handled separately below.
const FILLABLE_COLUMNS = [
    'contact_name',
    'email',
    'event_interest',
    'participant_count',
    'location_pref',
    'event_date_pref',
    'event_goals',
    'budget_range',
    'assigned_to',
    'notes',
] as const;

type FillableColumn = (typeof FILLABLE_COLUMNS)[number];

const EXISTING_SELECT =
    'phone_number, contact_name, contact_name_locked, contact_type, ' +
    'email, event_interest, participant_count, location_pref, ' +
    'event_date_pref, event_goals, budget_range, assigned_to, notes, ' +
    'lead_stage, source';

function incomingValues(input: LeadInput): Record<FillableColumn, unknown> {
    return {
        contact_name: input.contact_name ?? null,
        email: input.email ?? null,
        event_interest: input.event_interest ?? null,
        participant_count: input.participant_count ?? null,
        location_pref: input.location_pref ?? null,
        event_date_pref: input.event_date_pref ?? null,
        event_goals: input.event_goals ?? null,
        budget_range: input.budget_range ?? null,
        assigned_to: input.assigned_to ?? null,
        notes: input.notes ?? null,
    };
}

async function selectExisting(
    supabase: SupabaseClient,
    orgId: string,
    identity: string
): Promise<Record<string, unknown> | null> {
    const { data, error } = await supabase
        .from('whatsapp_chats')
        .select(EXISTING_SELECT)
        .eq('org_id', orgId)
        .eq('phone_number', identity)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? (data as unknown as Record<string, unknown>) : null;
}

// Fill empty cells on an already-existing row. Never overwrites a non-empty
// value, a locked name, or the source (a null source means "came via WhatsApp"
// — see sourceLabel — so a later manual add must not relabel it).
async function fillExisting(
    supabase: SupabaseClient,
    orgId: string,
    row: Record<string, unknown>,
    incoming: Record<FillableColumn, unknown>,
    input: LeadInput
): Promise<CreateLeadResult> {
    const phone = String(row.phone_number);
    const contactName = (row.contact_name as string | null) ?? null;

    // The phone already belongs to a vendor/other contact — refuse to blend
    // lead fields onto it (it would never show in the pipeline yet report
    // success). Surface it so the caller can tell the user.
    if (row.contact_type != null && row.contact_type !== 'lead') {
        return { result: 'skipped_non_lead', phone_number: phone, contact_name: contactName };
    }

    const patch: Record<string, unknown> = {};
    for (const col of FILLABLE_COLUMNS) {
        const value = incoming[col];
        if (value == null) continue; // nothing new to contribute
        // Respect a name the team has locked (admin- or AI-confirmed).
        if (col === 'contact_name' && row.contact_name_locked) continue;
        const current = row[col];
        if (current == null || current === '') patch[col] = value;
    }
    // Fill the stage only when the row has none (never regress a set stage).
    // Source is intentionally NOT filled here (see the doc comment above).
    if (row.lead_stage == null) patch.lead_stage = input.lead_stage ?? 'new';

    if (Object.keys(patch).length === 0) {
        return { result: 'unchanged', phone_number: phone, contact_name: contactName };
    }

    patch.updated_at = new Date().toISOString();
    const { error } = await supabase
        .from('whatsapp_chats')
        .update(patch)
        .eq('org_id', orgId)
        .eq('phone_number', phone);
    if (error) throw new Error(error.message);

    return {
        result: 'updated',
        phone_number: phone,
        contact_name: (patch.contact_name as string | undefined) ?? contactName,
    };
}

export async function createOrFillLead(
    supabase: SupabaseClient,
    orgId: string,
    input: LeadInput
): Promise<CreateLeadResult> {
    const realPhone = normalizePhone(input.phone_number ?? null);
    const identity = realPhone ?? `manual:${randomUUID()}`;
    const incoming = incomingValues(input);

    const existing = await selectExisting(supabase, orgId, identity);
    if (existing) return fillExisting(supabase, orgId, existing, incoming, input);

    // No existing row → insert. last_message_at is forced null (overriding the
    // column's `now()` default) so a freshly imported lead with no conversation
    // stays OUT of the WhatsApp Inbox until it actually messages.
    const insertRow = {
        org_id: orgId,
        phone_number: identity,
        contact_type: 'lead' as const,
        lead_stage: input.lead_stage ?? 'new',
        source: input.source ?? 'manual',
        ai_enabled: true,
        verified_phone: realPhone, // null for synthetic identities
        // A manually entered name is authoritative — lock it so the AI's
        // profile-name sync won't clobber it on the first inbound message.
        contact_name_locked: incoming.contact_name != null,
        last_message: null,
        last_message_at: null,
        ...incoming,
    };

    const { error: insErr } = await supabase.from('whatsapp_chats').insert(insertRow);
    if (insErr) {
        // TOCTOU: a concurrent writer (another import row, the WhatsApp webhook)
        // created the row between our SELECT and INSERT. Re-read and fill-empty
        // instead of surfacing a raw unique-violation.
        if (insErr.code === '23505') {
            const now = await selectExisting(supabase, orgId, identity);
            if (now) return fillExisting(supabase, orgId, now, incoming, input);
        }
        throw new Error(insErr.message);
    }

    return {
        result: 'created',
        phone_number: identity,
        contact_name: (incoming.contact_name as string | null) ?? null,
    };
}
