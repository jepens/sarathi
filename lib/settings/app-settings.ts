import { createClient } from '@/lib/supabase/server';

export interface AppSetting {
    id: string;
    key: string;
    value: string;
    description: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * Get a specific setting by key
 */
export async function getAppSetting(key: string): Promise<string | null> {
    const supabase = await createClient();

    const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();

    if (error) {
        console.error(`Error fetching setting ${key}:`, error);
        return null;
    }

    return data?.value || null;
}

/**
 * Get all settings
 */
export async function getAllSettings(): Promise<AppSetting[]> {
    const supabase = await createClient();

    const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .order('key');

    if (error) {
        console.error('Error fetching all settings:', error);
        return [];
    }

    return data || [];
}

/**
 * Update a setting
 */
export async function updateAppSetting(key: string, value: string): Promise<boolean> {
    const supabase = await createClient();

    const { error } = await supabase
        .from('app_settings')
        .update({ value })
        .eq('key', key);

    if (error) {
        console.error(`Error updating setting ${key}:`, error);
        return false;
    }

    return true;
}

/**
 * Get webhook URL from settings (with fallback to localhost)
 */
export async function getWebhookUrl(): Promise<string> {
    const url = await getAppSetting('whatsapp_webhook_url');
    return url || 'http://localhost:3000/api/webhook/whatsapp';
}

/**
 * Get verify token from settings (with fallback to env)
 */
export async function getVerifyToken(): Promise<string> {
    const token = await getAppSetting('whatsapp_verify_token');
    return token || process.env.WHATSAPP_VERIFY_TOKEN || '123456';
}

/**
 * Securely check if a token matches the stored verify token
 * Uses Database RPC to avoid exposing the token to the client/anon users
 */
export async function checkVerifyToken(inputToken: string): Promise<boolean> {
    const supabase = await createClient();

    // Try RPC first (secure way)
    const { data, error } = await supabase.rpc('verify_webhook_token', { input_token: inputToken });

    if (!error && data !== null) {
        return data;
    }

    // Fallback for development/if RPC fails (e.g. function not created yet)
    // This might fail if RLS blocks access, but it's a backup.
    const storedToken = await getVerifyToken();
    return storedToken === inputToken;
}

/**
 * Get WhatsApp Access Token from settings
 */
export async function getWhatsAppAccessToken(): Promise<string> {
    const token = await getAppSetting('whatsapp_access_token');
    if (!token) {
        throw new Error('WhatsApp Access Token not configured. Please set it in /dashboard/settings');
    }
    return token;
}

/**
 * Get WhatsApp Phone Number ID from settings
 */
export async function getWhatsAppPhoneNumberId(): Promise<string> {
    const phoneId = await getAppSetting('whatsapp_phone_number_id');
    if (!phoneId) {
        throw new Error('WhatsApp Phone Number ID not configured. Please set it in /dashboard/settings');
    }
    return phoneId;
}

/**
 * Get WhatsApp App Secret from settings
 */
export async function getWhatsAppAppSecret(): Promise<string | null> {
    return await getAppSetting('whatsapp_app_secret');
}

/**
 * Get OpenAI API Key from settings
 */
export async function getOpenAIApiKey(): Promise<string> {
    const apiKey = await getAppSetting('openai_api_key') || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OpenAI API Key not configured. Please set it in /dashboard/settings');
    }
    return apiKey;
}

/**
 * Get Shipping API Key from settings
 */
export async function getShippingApiKey(): Promise<string | null> {
    return await getAppSetting('shipping_api_key');
}

/**
 * Check if WhatsApp is fully configured
 */
export async function isWhatsAppConfigured(): Promise<boolean> {
    const accessToken = await getAppSetting('whatsapp_access_token');
    const phoneNumberId = await getAppSetting('whatsapp_phone_number_id');
    const verifyToken = await getAppSetting('whatsapp_verify_token');

    return !!(accessToken && phoneNumberId && verifyToken);
}

/**
 * Check if AI is configured
 */
export async function isAIConfigured(): Promise<boolean> {
    const apiKey = await getAppSetting('openai_api_key');
    return !!apiKey;
}


