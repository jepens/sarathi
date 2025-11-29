'use server';

import { updateAppSetting } from '@/lib/settings/app-settings';
import { revalidatePath } from 'next/cache';

export async function updateWebhookSettings(formData: FormData) {
    const webhookUrl = formData.get('webhookUrl') as string;
    const verifyToken = formData.get('verifyToken') as string;
    const accessToken = formData.get('accessToken') as string;
    const phoneNumberId = formData.get('phoneNumberId') as string;
    const appSecret = formData.get('appSecret') as string;

    if (webhookUrl) {
        await updateAppSetting('whatsapp_webhook_url', webhookUrl);
    }

    if (verifyToken) {
        await updateAppSetting('whatsapp_verify_token', verifyToken);
    }

    if (accessToken) {
        await updateAppSetting('whatsapp_access_token', accessToken);
    }

    if (phoneNumberId) {
        await updateAppSetting('whatsapp_phone_number_id', phoneNumberId);
    }

    if (appSecret) {
        await updateAppSetting('whatsapp_app_secret', appSecret);
    }

    revalidatePath('/dashboard/settings');
    return { success: true };
}

export async function updateAISettings(formData: FormData) {
    const openAIKey = formData.get('openAIKey') as string;

    if (openAIKey) {
        await updateAppSetting('openai_api_key', openAIKey);
    }

    revalidatePath('/dashboard/settings');
    return { success: true };
}

export async function updateShippingSettings(formData: FormData) {
    const shippingKey = formData.get('shippingKey') as string;

    if (shippingKey) {
        await updateAppSetting('shipping_api_key', shippingKey);
    }

    revalidatePath('/dashboard/settings');
    return { success: true };
}
