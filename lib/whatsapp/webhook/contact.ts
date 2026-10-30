import type { SupabaseClient } from '@supabase/supabase-js';

// Who sent an inbound message: the chat's contact key, and whether an id is a real phone (BSUID migration).

// Resolve the canonical contact key for the whatsapp_chats PK.
//
// Meta is migrating to business-scoped user IDs (BSUIDs). Today `from` is a
// phone number, but from June 2026 it may be a BSUID instead. We key the CRM
// on phone_number (hybrid strategy), so when a returning customer arrives
// with a BSUID we've seen before, re-thread them into their existing
// conversation by reusing the phone_number we already have. Otherwise fall
// back to `from` (a phone today, or a BSUID once usernames roll out — either
// works as a stable PK; the send layer routes a BSUID via `recipient`, since
// Meta rejects a BSUID in the `to` field). Returns null only when we have
// NEITHER a `from` nor a BSUID — the caller then acks and skips.
export async function resolveContactKey(
    supabase: SupabaseClient,
    orgId: string,
    from: string | null | undefined,
    bsuid: string | null
): Promise<string | null> {
    if (bsuid) {
        // Scope the bsuid lookup to this org: the webhook uses a service-role
        // client (RLS bypassed), so without org_id a bsuid that two tenants
        // happen to share would re-thread the customer into the wrong org.
        const { data } = await supabase
            .from('whatsapp_chats')
            .select('phone_number')
            .eq('org_id', orgId)
            .eq('bsuid', bsuid)
            .maybeSingle<{ phone_number: string }>();
        if (data?.phone_number) return data.phone_number;
    }
    // A phone-hidden NEW customer arrives with no phone (from omitted) but a
    // BSUID — fall back to the BSUID verbatim so contactKey is never nullish
    // for a routable message.
    return from || bsuid || null;
}

// A real phone number is all digits, 8-15 long (E.164 without the +). A BSUID
// (e.g. "ID.26557548613939612") or username fails this, so we use it to tell
// "Meta gave us a real phone" apart from "Meta gave us an identifier".
export function looksLikePhone(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9]{8,15}$/.test(value);
}
