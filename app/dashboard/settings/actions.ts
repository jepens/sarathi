'use server';

import { updateAppSetting } from '@/lib/settings/app-settings';
import { createClient } from '@/lib/supabase/server';
import {
    type BusinessProfile,
    saveBusinessProfile,
} from '@/lib/settings/business-profile';
import { revalidatePath } from 'next/cache';

export async function updateWebhookSettings(formData: FormData) {
    const webhookUrl = formData.get('webhookUrl') as string;
    const verifyToken = formData.get('verifyToken') as string;

    if (webhookUrl) {
        await updateAppSetting('whatsapp_webhook_url', webhookUrl);
    }

    if (verifyToken) {
        await updateAppSetting('whatsapp_verify_token', verifyToken);
    }

    revalidatePath('/dashboard/settings');
    return { success: true };
}

export async function updateBusinessProfile(
    input: BusinessProfile,
): Promise<{ ok: boolean; error?: string }> {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: 'Tidak terautentikasi.' };

    try {
        await saveBusinessProfile(input, supabase);
        revalidatePath('/dashboard/settings');
        return { ok: true };
    } catch (e) {
        const msg =
            e instanceof Error ? e.message : 'Gagal menyimpan profil bisnis.';
        console.error('updateBusinessProfile failed:', e);
        return { ok: false, error: msg };
    }
}
