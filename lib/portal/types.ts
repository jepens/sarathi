import { z } from 'zod';
import { isSyntheticPhone } from '@/lib/leads/schema';

// Shared types + the pure request-body builder for the Sarathi → Portal handoff.
//
// CLIENT-SAFE: imported by BOTH the picker dialog (client component) and the
// server action / fetch client. Keep it free of server-only imports (supabase,
// node:crypto, process.env access, etc.). zod is fine on the client.

// --- Portal client (Organization) picker shape ------------------------------
// The Portal's GET /api/intake/clients returns at minimum { id, name }; we
// tolerate (and ignore) any extra fields it sends.
export interface PortalClient {
    id: string;
    name: string;
}

// --- Lead fields needed to assemble the brief + identity --------------------
export interface HandoffLead {
    phone_number: string;
    contact_name: string | null;
    email: string | null;
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
}

// --- Client selection: link to existing Portal client, or create a new one --
export type HandoffClientSelection =
    | { mode: 'existing'; clientId: string }
    | { mode: 'new'; name: string };

// --- The request body Sarathi POSTs to {PORTAL}/api/intake/handoff ----------
export interface HandoffBrief {
    eventInterest?: string;
    participantCount?: number;
    locationPref?: string;
    eventDatePref?: string;
    eventGoals?: string;
    budgetRange?: string;
    contactName?: string;
    phone?: string;
    email?: string;
}

export interface HandoffRequestBody {
    idempotencyKey: string;
    client: HandoffClientSelection;
    proposal: { title: string };
    brief: HandoffBrief;
    sourceRef: { app: 'sarathi'; leadId: string };
}

// --- The response Portal returns --------------------------------------------
export interface HandoffResponse {
    clientId: string;
    proposalId: string;
    proposalUrl: string;
}

// --- Input from the dialog into the server action ---------------------------
export const handoffClientSelectionSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), clientId: z.uuid({ error: 'Client id tidak valid' }) }),
    z.object({
        mode: z.literal('new'),
        name: z.string().trim().min(1, 'Nama klien wajib diisi').max(200, 'Nama klien terlalu panjang'),
    }),
]);

export const handoffInputSchema = z.object({
    phone: z.string().min(1, 'Lead tidak valid'),
    idempotencyKey: z.uuid({ error: 'idempotencyKey tidak valid' }),
    title: z.string().trim().min(1, 'Judul proposal wajib diisi').max(300, 'Judul terlalu panjang'),
    client: handoffClientSelectionSchema,
});

export type HandoffInput = z.infer<typeof handoffInputSchema>;

// --- Helpers ----------------------------------------------------------------

/** Trim a value to a non-empty string, or undefined. */
function clean(v: string | null | undefined): string | undefined {
    const t = v?.trim();
    return t ? t : undefined;
}

// Synthetic phone-less identities are stored as `manual:<uuid>` — never send
// those to the Portal as a real phone.
function realPhone(phone: string | null | undefined): string | undefined {
    if (!phone || isSyntheticPhone(phone)) return undefined;
    return phone;
}

/**
 * Build the brief from a lead, dropping empty fields so the Portal receives a
 * clean payload (no `""`/null noise). participantCount stays a number.
 */
export function buildBrief(lead: HandoffLead): HandoffBrief {
    const brief: HandoffBrief = {};
    const ei = clean(lead.event_interest);
    if (ei) brief.eventInterest = ei;
    if (typeof lead.participant_count === 'number' && lead.participant_count > 0) {
        brief.participantCount = lead.participant_count;
    }
    const lp = clean(lead.location_pref);
    if (lp) brief.locationPref = lp;
    const ed = clean(lead.event_date_pref);
    if (ed) brief.eventDatePref = ed;
    const eg = clean(lead.event_goals);
    if (eg) brief.eventGoals = eg;
    const br = clean(lead.budget_range);
    if (br) brief.budgetRange = br;
    const cn = clean(lead.contact_name);
    if (cn) brief.contactName = cn;
    const ph = realPhone(lead.phone_number);
    if (ph) brief.phone = ph;
    const em = clean(lead.email);
    if (em) brief.email = em;
    return brief;
}

/**
 * A sensible default proposal title, e.g. "Penawaran — Gathering PT Astra".
 * `clientName` is the picked/typed Portal client (Organization) name.
 */
export function buildProposalTitle(lead: Pick<HandoffLead, 'event_interest'>, clientName: string): string {
    const interest = clean(lead.event_interest);
    const who = clean(clientName);
    const parts = ['Penawaran —', interest, who].filter(Boolean);
    // "Penawaran —" + at least one of interest/who; if both missing, generic.
    return parts.length > 1 ? parts.join(' ') : 'Penawaran';
}

/** Assemble the full handoff request body. Pure — easy to unit test. */
export function buildHandoffBody(params: {
    idempotencyKey: string;
    client: HandoffClientSelection;
    title: string;
    lead: HandoffLead;
}): HandoffRequestBody {
    return {
        idempotencyKey: params.idempotencyKey,
        client: params.client,
        proposal: { title: params.title.trim() },
        brief: buildBrief(params.lead),
        // leadId is the lead's stable identity in Sarathi (phone_number PK),
        // incl. synthetic `manual:<uuid>` so the Portal can trace any lead back.
        sourceRef: { app: 'sarathi', leadId: params.lead.phone_number },
    };
}
