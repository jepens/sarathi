import { SupabaseClient } from '@supabase/supabase-js';

// Sarathi is a vertical SaaS for Event Organizers. A tenant's identity — company
// name, the WhatsApp persona's name, specialties, hand-off contact, etc. — used
// to be hardcoded as "Sailendra / Nindra" across the AI + proposal code, then
// lived as one GLOBAL profile in app_settings. It now lives per-org in the
// dedicated `business_profiles` table (migration 0039): one row per org, RLS-
// isolated. Every caller passes the org so each tenant's bot speaks as itself.

export interface BusinessProfile {
    businessName: string;
    assistantName: string;
    specialties: string;
    establishedYear: string;
    serviceAreas: string;
    handoffName: string;
    handoffPhone: string;
    businessEmail: string;
    website: string;
}

// Sailendra's real values. Kept as a named reference (it seeds Sailendra's
// business_profiles row in migration 0039) — NOT used as a fallback, so a fresh
// tenant never inherits Sailendra's identity.
export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
    businessName: 'Sailendra Organizer',
    assistantName: 'Nindra',
    specialties: 'Team Building, Capacity Building, dan Company Gathering',
    establishedYear: '2016',
    serviceAreas:
        'Jabodetabek, Bandung, Jogja, Bali, kota lain di Indonesia, dan internasional atas permintaan',
    handoffName: 'MJ (Mang Jajang)',
    handoffPhone: '+62 812-8195-8110',
    businessEmail: 'info@sailendra.co.id',
    website: 'sailendra.co.id',
};

// Neutral fallback for an org that hasn't filled in its profile yet (or any
// field left blank). Deliberately brand-less so an unconfigured tenant's bot
// reads as a generic EO assistant rather than impersonating anyone.
export const GENERIC_BUSINESS_PROFILE: BusinessProfile = {
    businessName: 'Event Organizer kami',
    assistantName: 'Asisten',
    specialties: 'berbagai jenis acara',
    establishedYear: '',
    serviceAreas: 'berbagai kota di Indonesia',
    handoffName: 'tim kami',
    handoffPhone: '',
    businessEmail: '',
    website: '',
};

function nonEmpty(v: unknown, fallback: string): string {
    return typeof v === 'string' && v.trim().length > 0 ? v : fallback;
}

/**
 * Read a tenant's business profile. Any field left blank falls back to the
 * neutral GENERIC profile (never Sailendra). Pass the org explicitly — a
 * service-role client (webhook/queue) bypasses RLS, an authenticated client is
 * scoped by RLS to the user's own org.
 */
export async function getBusinessProfile(
    client: SupabaseClient,
    orgId: string,
): Promise<BusinessProfile> {
    const { data, error } = await client
        .from('business_profiles')
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle();

    if (error) {
        console.error('Error fetching business profile:', error);
        return { ...GENERIC_BUSINESS_PROFILE };
    }
    if (!data) return { ...GENERIC_BUSINESS_PROFILE };

    const g = GENERIC_BUSINESS_PROFILE;
    return {
        businessName: nonEmpty(data.business_name, g.businessName),
        assistantName: nonEmpty(data.assistant_name, g.assistantName),
        specialties: nonEmpty(data.specialties, g.specialties),
        establishedYear: nonEmpty(data.established_year, g.establishedYear),
        serviceAreas: nonEmpty(data.service_areas, g.serviceAreas),
        handoffName: nonEmpty(data.handoff_name, g.handoffName),
        handoffPhone: nonEmpty(data.handoff_phone, g.handoffPhone),
        businessEmail: nonEmpty(data.business_email, g.businessEmail),
        website: nonEmpty(data.website, g.website),
    };
}

/**
 * Upsert a tenant's business profile (one row per org). Pass the org explicitly.
 */
export async function saveBusinessProfile(
    input: BusinessProfile,
    client: SupabaseClient,
    orgId: string,
): Promise<void> {
    const { error } = await client.from('business_profiles').upsert(
        {
            org_id: orgId,
            business_name: (input.businessName ?? '').trim(),
            assistant_name: (input.assistantName ?? '').trim(),
            specialties: (input.specialties ?? '').trim(),
            established_year: (input.establishedYear ?? '').trim(),
            service_areas: (input.serviceAreas ?? '').trim(),
            handoff_name: (input.handoffName ?? '').trim(),
            handoff_phone: (input.handoffPhone ?? '').trim(),
            business_email: (input.businessEmail ?? '').trim(),
            website: (input.website ?? '').trim(),
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'org_id' },
    );
    if (error) throw error;
}
