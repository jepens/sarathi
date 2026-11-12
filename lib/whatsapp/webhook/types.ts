import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppContext } from '@/lib/whatsapp/credentials';
import type { OtherNumber } from '@/lib/whatsapp/other-number';
import type { SenderIdentity } from '@/lib/whatsapp/webhook/contact';
import type { BatchOutcome } from '@/lib/whatsapp/webhook/outcome';

// Types shared by the webhook modules.

// Meta's webhook JSON as JSON.parse returns it: not validated against a
// schema. The readers (payload.ts) and the handlers never trust a field's
// shape: a malformed message becomes a placeholder or is skipped with an
// alert (handlers/messages.ts, including a Flow whose answers cannot be
// read; a contact card with no phone from a sender without one is only
// acknowledged, there being nothing to note), a malformed status or
// user_id_update entry is skipped with an alert (handlers/statuses.ts,
// handlers/user-id-update.ts); never an exception out of the pipeline.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MetaJson = any;

/** One delivery being walked: what every item handler may use. */
export interface BatchRun {
    supabase: SupabaseClient;
    outcome: BatchOutcome;
    /**
     * The org and its credentials, read strictly once per delivery, the first
     * time an item needs them; a read error rejects every later call too.
     */
    org(): Promise<WhatsAppContext>;
    /** A message was queued or joined a waiting burst: drain the queue after the walk. */
    requestDrain(): void;
    /**
     * New BSUIDs whose user_id_update failed or was deferred in this delivery:
     * a message carrying one waits for Meta's resend (handlers/messages.ts).
     */
    heldBsuids: Set<string>;
}

/** One inbound message, ready for the handler of its type. */
export interface MessageContext {
    supabase: SupabaseClient;
    waCtx: WhatsAppContext;
    /** The messages[] entry. */
    message: Record<string, MetaJson>;
    /** messages[].type, '' when it is not a string. */
    type: string;
    /** Meta's wamid, or the syn. key of a message Meta sent without one. */
    key: string;
    /** context.id: the message the customer replied to. */
    replyTo: string | null;
    /** Meta's send time, null when missing or not plausible. */
    waTs: Date | null;
    identity: SenderIdentity;
    /** Sent to another number of the WABA (store-only), else null. */
    storeOnly: OtherNumber | null;
    /** Aborts database calls when the delivery's time budget runs out. */
    signal: AbortSignal;
    batch: Pick<BatchRun, 'requestDrain'>;
}
