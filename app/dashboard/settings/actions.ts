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

// WhatsApp credentials are kept in Supabase Vault and set up by the Sarathi
// team (scripts/wa-provision.mjs). There is no in-app save action — the
// Settings WhatsApp card is read-only.
