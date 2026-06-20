'use server';

import { createClient } from '@/lib/supabase/server';
import {
    type BusinessProfile,
    saveBusinessProfile,
} from '@/lib/settings/business-profile';
import { getCurrentOrgId } from '@/lib/settings/org-context';
import { revalidatePath } from 'next/cache';

export async function updateBusinessProfile(
    input: BusinessProfile,
): Promise<{ ok: boolean; error?: string }> {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: 'Tidak terautentikasi.' };

    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) return { ok: false, error: 'Organisasi tidak ditemukan.' };

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
