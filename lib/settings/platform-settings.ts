import type { SupabaseClient } from '@supabase/supabase-js';

// Platform (deployment-level) settings vs tenant settings (tracker 1.7, audit
// KEA-9).
//
// public.platform_settings holds the configuration of the single Sarathi
// deployment: the default org of the service-role paths and the WhatsApp
// webhook verify token / URL. It has RLS on and NO policies, so only the
// service role can read or write it — a tenant member can neither read the
// verify token nor redirect the webhook to another org.
// Tenant settings stay in app_settings, keyed by (org_id, key).
//
// Rollout (expand → contract): migration 0061 copied these keys from
// app_settings but left the old rows in place. Until the contract phase removes
// them, a missing platform row (migration not yet applied, or a client that
// cannot read platform_settings) falls back to the legacy row of the SEED org
// only — never to a key another tenant could create in its own org.

/** The seed org (Sailendra, tenant #1), created by migration 0026. */
export const SEED_ORG_ID = '5a11e024-0001-4000-8000-000000000001';

export const PLATFORM_SETTING_KEYS = [
    'default_org_id',
    'whatsapp_verify_token',
    'whatsapp_webhook_url',
] as const;

export type PlatformSettingKey = (typeof PLATFORM_SETTING_KEYS)[number];

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read a platform setting. Pass a SERVICE-ROLE client: platform_settings is
 * invisible to anon/authenticated (those clients only reach the fallback).
 * Returns null when the key is not configured anywhere.
 */
export async function getPlatformSetting(
    client: SupabaseClient,
    key: PlatformSettingKey,
): Promise<string | null> {
    const { data, error } = await client
        .from('platform_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();
    if (!error) {
        const value = nonEmpty(data?.value);
        if (value) return value;
    }

    // Legacy fallback (removed in the contract phase): the seed org's row.
    const legacy = await client
        .from('app_settings')
        .select('value')
        .eq('org_id', SEED_ORG_ID)
        .eq('key', key)
        .maybeSingle();
    if (legacy.error) {
        console.error(`Error fetching platform setting ${key}:`, legacy.error);
        return null;
    }
    return nonEmpty(legacy.data?.value);
}
