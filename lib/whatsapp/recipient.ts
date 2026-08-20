import type { SupabaseClient } from '@supabase/supabase-js';
import { isDialablePhone } from '@/lib/leads/schema';

// Recipient resolution for the WhatsApp Cloud API send layer, for the
// Business-Scoped User ID (BSUID) migration.
//
// Meta's /messages send body carries the recipient as EITHER `to` (a dialable
// phone) OR `recipient` (a BSUID like "ID.26557548613939612"); a BSUID placed
// in `to` is rejected. If both are present, Meta lets `to` win — so whenever we
// have a recovered real phone we prefer it.

// Build the recipient portion of a send body from a single identifier. A
// dialable phone → { to }; anything else (a BSUID) → { recipient_type,
// recipient }. Never emits both.
//
// A phone may arrive FORMATTED (leading +, spaces, dashes — e.g. an env-set
// owner number "+62 813-…"); strip it to bare digits so it still routes to `to`
// (Meta rejects a formatted value in `recipient`). A BSUID keeps its non-phone
// characters (the "XX." prefix / period) and correctly falls through to
// `recipient`.
export function buildRecipient(identifier: string): Record<string, unknown> {
    const stripped = identifier.replace(/[\s\-()]/g, '').replace(/^\+/, '');
    return isDialablePhone(stripped)
        ? { to: stripped }
        : { recipient_type: 'individual', recipient: identifier };
}

// Given a contact's CRM key (whatsapp_chats.phone_number — which may be a BSUID
// for a phone-hidden customer), return the best identifier to SEND to: a
// recovered real phone (verified_phone) when we have one, otherwise the key
// itself (a phone, or a BSUID that buildRecipient will place in `recipient`).
// The verified_phone lookup only runs when the key is NOT already a phone.
export async function resolveSendTarget(
    supabase: SupabaseClient,
    orgId: string,
    contactKey: string,
): Promise<string> {
    if (isDialablePhone(contactKey)) return contactKey; // already a phone — fast path
    const { data } = await supabase
        .from('whatsapp_chats')
        .select('verified_phone')
        .eq('org_id', orgId)
        .eq('phone_number', contactKey)
        .maybeSingle<{ verified_phone: string | null }>();
    if (isDialablePhone(data?.verified_phone)) return data!.verified_phone!;
    return contactKey; // BSUID → send layer emits `recipient`
}
