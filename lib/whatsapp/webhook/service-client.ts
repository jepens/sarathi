import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The database client of the webhook: a Meta delivery has no user session, so the service role.

// The service-role client the webhook works with, or null when it is not
// configured. Never the anon key: under RLS every write would silently fail.
export function serviceRoleClient(): SupabaseClient | null {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    return url && key ? createClient(url, key) : null;
}
