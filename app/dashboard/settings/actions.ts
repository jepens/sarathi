'use server';

import { updateAppSetting } from '@/lib/settings/app-settings';
import { createClient } from '@/lib/supabase/server';
import {
    type BusinessProfile,
    saveBusinessProfile,
} from '@/lib/settings/business-profile';
import { getCurrentOrgId } from '@/lib/settings/org-context';
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

export interface WhatsAppIntegrationInput {
    phoneNumberId: string;
    wabaId: string;
    displayPhone: string;
    accessToken: string; // blank = keep existing secret
    appSecret: string; // blank = keep existing secret
}

export async function saveWhatsAppIntegration(
    input: WhatsAppIntegrationInput,
): Promise<{ ok: boolean; error?: string }> {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: 'Tidak terautentikasi.' };

    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) return { ok: false, error: 'Organisasi tidak ditemukan.' };

    const phoneNumberId = input.phoneNumberId.trim();
    if (!phoneNumberId) return { ok: false, error: 'Phone Number ID wajib diisi.' };

    const { data: existing } = await supabase
        .from('whatsapp_integrations')
        .select('org_id')
        .eq('org_id', orgId)
        .maybeSingle();

    if (!existing && !input.accessToken.trim()) {
        return {
            ok: false,
            error: 'Access Token wajib diisi saat menghubungkan pertama kali.',
        };
    }

    const patch: Record<string, unknown> = {
        org_id: orgId,
        phone_number_id: phoneNumberId,
        waba_id: input.wabaId.trim() || null,
        display_phone: input.displayPhone.trim() || null,
        updated_at: new Date().toISOString(),
    };
    if (input.accessToken.trim()) patch.access_token = input.accessToken.trim();
    if (input.appSecret.trim()) patch.app_secret = input.appSecret.trim();

    const { error } = await supabase
        .from('whatsapp_integrations')
        .upsert(patch, { onConflict: 'org_id' });

    if (error) {
        if (error.code === '23505') {
            return { ok: false, error: 'Phone Number ID ini sudah dipakai organisasi lain.' };
        }
        console.error('saveWhatsAppIntegration failed:', error);
        return { ok: false, error: error.message };
    }

    revalidatePath('/dashboard/settings');
    return { ok: true };
}
