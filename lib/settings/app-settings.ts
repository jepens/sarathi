import { createClient } from '@/lib/supabase/server';
import { SupabaseClient } from '@supabase/supabase-js';
import { getPlatformSetting } from '@/lib/settings/platform-settings';

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
export async function getAppSetting(key: string, client?: SupabaseClient): Promise<string | null> {
    const supabase = client || await createClient();

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
export async function getAllSettings(client?: SupabaseClient): Promise<AppSetting[]> {
    const supabase = client || await createClient();

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
export async function updateAppSetting(key: string, value: string, client?: SupabaseClient): Promise<boolean> {
    const supabase = client || await createClient();

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

// The webhook URL and verify token are PLATFORM settings (platform_settings,
// service role only — tracker 1.7 / KEA-9). Pass a service-role client; without
// one, the service-role-or-server client is used.
async function platformClient(client?: SupabaseClient): Promise<SupabaseClient> {
    if (client) return client;
    const { createServiceOrServerClient } = await import('@/lib/supabase/service');
    return createServiceOrServerClient();
}

/**
 * Get webhook URL from platform settings (with fallback to localhost)
 */
export async function getWebhookUrl(client?: SupabaseClient): Promise<string> {
    const url = await getPlatformSetting(await platformClient(client), 'whatsapp_webhook_url');
    return url || 'http://localhost:3000/api/webhook/whatsapp';
}

/**
 * Get verify token from platform settings (with fallback to env). Returns ''
 * when none is configured — never a guessable default, so verification fails
 * closed.
 */
export async function getVerifyToken(client?: SupabaseClient): Promise<string> {
    const token = await getPlatformSetting(await platformClient(client), 'whatsapp_verify_token');
    return token || process.env.WHATSAPP_VERIFY_TOKEN || '';
}

/**
 * Securely check if a token matches the stored verify token
 * Uses Database RPC to avoid exposing the token to the client/anon users
 */
export async function checkVerifyToken(inputToken: string, client?: SupabaseClient): Promise<boolean> {
    // Webhook GET (Meta token challenge) has no user session — use service
    // role so we can revoke anon+authenticated EXECUTE on the underlying
    // SECURITY DEFINER function (advisor finding).
    const supabase = await platformClient(client);

    // Try RPC first (secure way)
    const { data, error } = await supabase.rpc('verify_webhook_token', { input_token: inputToken });

    if (!error && data !== null) {
        return data;
    }

    // Fallback for development/if RPC fails (e.g. function not created yet)
    // This might fail if RLS blocks access, but it's a backup.
    const storedToken = await getVerifyToken(supabase);
    return storedToken !== '' && storedToken === inputToken;
}

/**
 * Get WhatsApp Access Token from env
 */
export async function getWhatsAppAccessToken(): Promise<string> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) {
        throw new Error('WhatsApp Access Token not configured in .env');
    }
    return token;
}

/**
 * Get WhatsApp Phone Number ID from env
 */
export async function getWhatsAppPhoneNumberId(): Promise<string> {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneId) {
        throw new Error('WhatsApp Phone Number ID not configured in .env');
    }
    return phoneId;
}

/**
 * Get WhatsApp App Secret from env
 */
export async function getWhatsAppAppSecret(): Promise<string | null> {
    return process.env.WHATSAPP_APP_SECRET || null;
}

/**
 * Get WhatsApp Business Account ID (WABA) from env. Required for the
 * template-message API (listing approved templates + sending re-engagement
 * messages outside the 24-hour customer service window).
 */
export async function getWhatsAppBusinessAccountId(): Promise<string> {
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (!wabaId) {
        throw new Error('WhatsApp Business Account ID not configured in .env (WHATSAPP_BUSINESS_ACCOUNT_ID)');
    }
    return wabaId;
}

/**
 * Get OpenAI API Key from env
 */
export async function getOpenAIApiKey(): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OpenAI API Key not configured in .env');
    }
    return apiKey;
}

/**
 * Get Shipping API Key from env
 */
export async function getShippingApiKey(): Promise<string | null> {
    return process.env.SHIPPING_COST_KOMERCE_API_KEY || null;
}

/**
 * Check if WhatsApp is fully configured
 */
export async function isWhatsAppConfigured(client?: SupabaseClient): Promise<boolean> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    // Verify token is a platform setting (platform_settings)
    const verifyToken = await getPlatformSetting(await platformClient(client), 'whatsapp_verify_token');

    return !!(accessToken && phoneNumberId && verifyToken);
}

/**
 * Check if AI is configured
 */
export async function isAIConfigured(): Promise<boolean> {
    const apiKey = process.env.OPENAI_API_KEY;
    return !!apiKey;
}


