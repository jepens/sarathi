'use server';

import {
    type BusinessProfile,
    saveBusinessProfile,
} from '@/lib/settings/business-profile';
import { requireOrgContext } from '@/lib/settings/org-context';
import { revalidatePath } from 'next/cache';

export async function updateBusinessProfile(
    input: BusinessProfile,
): Promise<{ ok: boolean; error?: string }> {
    const access = await requireOrgContext();
    if (!access.ok) return { ok: false, error: access.error };
    const { supabase, orgId } = access;

    try {
        await saveBusinessProfile(input, supabase, orgId);
        revalidatePath('/dashboard/settings');
        return { ok: true };
    } catch (e) {
        const msg =
            e instanceof Error ? e.message : 'Gagal menyimpan profil bisnis.';
        console.error('updateBusinessProfile failed:', e);
        return { ok: false, error: msg };
    }
}

// WhatsApp credentials are managed via server environment variables in this
// single-tenant build (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN /
// WHATSAPP_APP_SECRET). There is no in-app save action anymore — the Settings
// WhatsApp card is read-only.
