'use server';

import { updateAppSetting } from '@/lib/settings/app-settings';
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
