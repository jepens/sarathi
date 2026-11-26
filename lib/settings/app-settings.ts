import { createClient } from '@/lib/supabase/server';
import { SupabaseClient } from '@supabase/supabase-js';

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


