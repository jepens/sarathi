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

// Tenant settings: app_settings is keyed by (org_id, key) — the global unique
// on key was dropped in migration 0062 — so every helper takes the org.

/**
 * Get a specific tenant setting by key
 */
export async function getAppSetting(orgId: string, key: string, client?: SupabaseClient): Promise<string | null> {
    const supabase = client || await createClient();

    const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('org_id', orgId)
        .eq('key', key)
        .maybeSingle();

    if (error) {
        console.error(`Error fetching setting ${key}:`, error);
        return null;
    }

    return data?.value || null;
}

/**
 * Get all tenant settings of an org
 */
export async function getAllSettings(orgId: string, client?: SupabaseClient): Promise<AppSetting[]> {
    const supabase = client || await createClient();

    const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .eq('org_id', orgId)
        .order('key');

    if (error) {
        console.error('Error fetching all settings:', error);
        return [];
    }

    return data || [];
}

/**
 * Update a tenant setting of an org
 */
export async function updateAppSetting(orgId: string, key: string, value: string, client?: SupabaseClient): Promise<boolean> {
    const supabase = client || await createClient();

    const { error } = await supabase
        .from('app_settings')
        .update({ value })
        .eq('org_id', orgId)
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
 * Check if AI is configured
 */
export async function isAIConfigured(): Promise<boolean> {
    const apiKey = process.env.OPENAI_API_KEY;
    return !!apiKey;
}


