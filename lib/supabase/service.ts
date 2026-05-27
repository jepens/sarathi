import { createClient as createServiceRoleClient, type SupabaseClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from './server';

// `createServiceOrServerClient` — prefers a service-role client when the env
// var is present (typical for server-side / cron / webhook contexts), and
// falls back to the cookie-based server client otherwise (dashboard requests
// where we want RLS to apply under the authenticated user's role).
//
// Why this matters: the webhook path (Meta → /api/webhook/whatsapp →
// processQueue → generateRAGResponse → AI tool executors) runs without a
// user session. If those executors create a cookie-based client, the client
// authenticates as `anon`. Anything they touch on `whatsapp_chats` /
// `whatsapp_messages` previously relied on the "Allow public access" RLS
// policy. After we drop that policy (security advisor finding), the only
// safe role is `service_role`. This helper gives us a single switch-point.
//
// Dashboard callers (already authenticated) will still also get service_role
// when the env var is set. For the tables this helper is used on — which
// are admin-only anyway and have an `auth full access` policy — the effective
// behaviour is identical (both bypass row-by-row checks). If we ever add a
// per-user audit trail or per-user RLS, switch dashboard call sites back to
// the plain `createServerClient` so the actor's identity is preserved.
export async function createServiceOrServerClient(): Promise<SupabaseClient> {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (url && serviceRoleKey) {
        return createServiceRoleClient(url, serviceRoleKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
    }

    return await createServerClient();
}
