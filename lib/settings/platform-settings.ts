import type { SupabaseClient } from '@supabase/supabase-js';

// Platform (deployment-level) settings vs tenant settings (tracker 1.7, audit
// KEA-9).
//
// public.platform_settings holds the configuration of the single Sarathi
// deployment: the default org of the service-role paths. It has RLS on and
// NO policies, so only the service role can read or write it. (The legacy
// WhatsApp verify token / URL rows are dead since task 2.2d: every Meta app
// has its own URL and verify token, migration 0073.)
// Tenant settings stay in app_settings, keyed by (org_id, key).
//
// Rollout: migration 0061 copied these keys from app_settings (expand), the
// contract migration 0062 deleted the app_settings copies. platform_settings is
// the only source; there is no app_settings fallback any more, so a key a
// tenant creates in its own org can never act as a platform setting.

/** The seed org (Sailendra, tenant #1), created by migration 0026. */
export const SEED_ORG_ID = '5a11e024-0001-4000-8000-000000000001';

export const PLATFORM_SETTING_KEYS = ['default_org_id'] as const;

export type PlatformSettingKey = (typeof PLATFORM_SETTING_KEYS)[number];

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read a platform setting. Pass a SERVICE-ROLE client: platform_settings is
 * invisible to anon/authenticated (those clients get null).
 * Returns null when the key is not configured.
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
    if (error) {
        console.error(`Error fetching platform setting ${key}:`, error);
        return null;
    }
    return nonEmpty(data?.value);
}

/**
 * Like getPlatformSetting, but a read error throws instead of reading as "not
 * configured", for callers that must not fall back on an error (the webhook:
 * Fase 2 task 2.2a). Returns null only when the key really is not configured.
 */
export async function getPlatformSettingStrict(
    client: SupabaseClient,
    key: PlatformSettingKey,
): Promise<string | null> {
    const { data, error, status } = await client
        .from('platform_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();
    // A read PostgREST answered is a 200, with the row or without it. Anything
    // else without an error (postgrest-js turns an empty 404, a server that
    // does not know the path, into a 204) is not PostgREST: a wrong URL.
    if (error || (typeof status === 'number' && status !== 200)) {
        // Keep the database code and the HTTP status for the alert detail and
        // its hint (describeErrorForOps, opsHint): the webhook's first read,
        // where a wrong API key or URL shows.
        const err = new Error(`platform setting ${key} could not be read (${error?.code ?? `HTTP ${status}`})`);
        err.name = 'PlatformSettingReadError';
        throw Object.assign(err, { code: error?.code, status });
    }
    return nonEmpty(data?.value);
}
