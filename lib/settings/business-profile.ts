import { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

// Helat is a vertical SaaS for Event Organizers. A tenant's identity — company
// name, the WhatsApp persona's name, specialties, hand-off contact, etc. — used
// to be hardcoded as "Sailendra / Nindra" across the AI + proposal code. This
// module centralizes that identity into one configurable BusinessProfile.
//
// Storage: the existing `app_settings` key-value table (keys prefixed
// `business.`). The app stays single-tenant for now (one global profile). In
// the multi-tenant phase the same shape moves to a per-org row — callers go
// through getBusinessProfile(), so the call sites won't have to change.

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

// Defaults = Sailendra's current values, so behaviour is identical until the
// owner edits the profile, and the de-hardcoded literals (INTERNAL_NUMBERS, the
// email guard, transcript labels, etc.) keep working unchanged.
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

// app_settings key names — single source of truth.
const KEY: Record<keyof BusinessProfile, string> = {
    businessName: 'business.name',
    assistantName: 'business.assistant_name',
    specialties: 'business.specialties',
    establishedYear: 'business.established_year',
    serviceAreas: 'business.service_areas',
    handoffName: 'business.handoff_name',
    handoffPhone: 'business.handoff_phone',
    businessEmail: 'business.email',
    website: 'business.website',
};

const FIELDS = Object.keys(KEY) as (keyof BusinessProfile)[];

/**
 * Read the business profile from app_settings, falling back to the Sailendra
 * defaults per-field for any key not yet stored. Always returns a complete
 * profile.
 */
export async function getBusinessProfile(
    client?: SupabaseClient,
): Promise<BusinessProfile> {
    const supabase = client || (await createClient());

    const { data, error } = await supabase
        .from('app_settings')
        .select('key, value')
        .like('key', 'business.%');

    if (error) {
        console.error('Error fetching business profile:', error);
        return { ...DEFAULT_BUSINESS_PROFILE };
    }

    const byKey = new Map(
        (data ?? []).map((r) => [r.key as string, r.value as string]),
    );
    const profile = { ...DEFAULT_BUSINESS_PROFILE };
    for (const field of FIELDS) {
        const v = byKey.get(KEY[field]);
        if (typeof v === 'string' && v.trim().length > 0) profile[field] = v;
    }
    return profile;
}

// Upsert without relying on a UNIQUE constraint on app_settings.key: update
// first, insert only if the key didn't exist yet.
async function setSetting(
    supabase: SupabaseClient,
    key: string,
    value: string,
    description: string,
): Promise<void> {
    const { data: updated, error: updErr } = await supabase
        .from('app_settings')
        .update({ value })
        .eq('key', key)
        .select('id');
    if (updErr) throw updErr;
    if (!updated || updated.length === 0) {
        const { error: insErr } = await supabase
            .from('app_settings')
            .insert({ key, value, description });
        if (insErr) throw insErr;
    }
}

/**
 * Persist the full business profile to app_settings (one row per field).
 */
export async function saveBusinessProfile(
    input: BusinessProfile,
    client?: SupabaseClient,
): Promise<void> {
    const supabase = client || (await createClient());
    for (const field of FIELDS) {
        const value = (input[field] ?? '').toString().trim();
        await setSetting(supabase, KEY[field], value, `Business profile: ${field}`);
    }
}
