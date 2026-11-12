import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isRecord } from '@/lib/whatsapp/webhook/payload';

// Who sent an inbound message: the chat's contact key, and whether an id is a
// real phone (BSUID migration).

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
// wa_ingest_inbound resolves the key the same way inside its transaction;
// this TS copy serves the paths that do not go through it yet (contact cards
// on the main number, media and Flow).
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

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The value.contacts[] entry that describes this message's sender: the one
 * whose wa_id is the message's `from` or whose user_id is its `from_user_id`;
 * else the only contact of the change, unless it contradicts the message (a
 * different phone or a different BSUID: another customer's entry); else
 * none. Never the first of several: a change can carry messages of several
 * customers, and another customer's BSUID or phone must not be written to
 * this chat.
 */
export function matchContact(contacts: unknown, message: unknown): Record<string, unknown> | null {
    const list = (Array.isArray(contacts) ? contacts : []).filter(isRecord);
    const m = isRecord(message) ? message : {};
    const from = nonEmpty(m.from);
    const fromUserId = nonEmpty(m.from_user_id);
    const match = list.find((c) => (from !== null && c.wa_id === from) || (fromUserId !== null && c.user_id === fromUserId));
    if (match) return match;
    if (list.length !== 1) return null;
    const only = list[0];
    const otherPhone = looksLikePhone(from) && looksLikePhone(only.wa_id) && only.wa_id !== from;
    const otherBsuid = fromUserId !== null && nonEmpty(only.user_id) !== null && only.user_id !== fromUserId;
    return otherPhone || otherBsuid ? null : only;
}

export interface SenderIdentity {
    /** messages[].from: a phone today, possibly a BSUID later; null when absent. */
    from: string | null;
    /** The business-scoped user id (BSUID), when Meta sent one. */
    bsuid: string | null;
    /** The best-known real phone (kept as verified_phone), else null. */
    waId: string | null;
}

/**
 * Who sent a message. bsuid: messages[].from_user_id, else the matched
 * contact's user_id. waId (phase C): a phone-like contact wa_id, else a
 * phone-like `from`, so a contact keyed by a BSUID can still be reached.
 */
export function senderIdentity(message: unknown, contact: Record<string, unknown> | null): SenderIdentity {
    const m = isRecord(message) ? message : {};
    const from = nonEmpty(m.from);
    const bsuid = nonEmpty(m.from_user_id) ?? nonEmpty(contact?.user_id) ?? null;
    const contactWaId = contact?.wa_id;
    const waId = looksLikePhone(contactWaId) ? contactWaId : looksLikePhone(from) ? from : null;
    return { from, bsuid, waId };
}

/**
 * The phone a shared contact card carries (REQUEST_CONTACT_INFO, phase C):
 * the first phone-like phones[].wa_id, else the digits of phones[].phone.
 * `card` is one entry of a contacts message's contacts[].
 */
export function sharedCardPhone(card: unknown): string | null {
    const phones = isRecord(card) && Array.isArray(card.phones) ? card.phones : [];
    for (const p of phones) {
        if (!isRecord(p)) continue;
        if (looksLikePhone(p.wa_id)) return p.wa_id;
        const digits = typeof p.phone === 'string' ? p.phone.replace(/\D+/g, '') : '';
        if (looksLikePhone(digits)) return digits;
    }
    return null;
}

function keyPart(value: unknown): string {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The idempotency key of a message Meta sent without an id: 'syn.' + the
 * sha256 of what identifies it (number, sender, time, type and content). A
 * redelivery of the same message gets the same key, so the database stores it
 * once; wa_message_id documents the prefix. Statuses, quotes and the AI burst
 * trim only ever carry Meta's own ids.
 */
export function syntheticKey(phoneNumberId: unknown, message: unknown): string {
    const m = isRecord(message) ? message : {};
    const type = typeof m.type === 'string' ? m.type : '';
    const content = JSON.stringify((type ? m[type] : undefined) ?? null);
    const basis = [keyPart(phoneNumberId), keyPart(m.from), keyPart(m.from_user_id), keyPart(m.timestamp), type, content].join('|');
    return `syn.${createHash('sha256').update(basis).digest('hex')}`;
}
