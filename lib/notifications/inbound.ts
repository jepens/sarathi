// Pure decision logic for the "new inbound message" notifier. Kept separate from
// the React provider so it can be unit-tested without a DOM / Supabase.
//
// The provider hears on the org Realtime bus that a `whatsapp_chats` row of the
// org changed and re-reads the latest threads through PostgREST. A row
// represents a NEW inbound message worth notifying about when the customer's
// last message is the latest activity on the thread AND its inbound timestamp
// is newer than the last one we already saw.

export interface ChatRealtimeRow {
    phone_number: string;
    contact_name: string | null;
    contact_type: string | null;
    last_message: string | null;
    last_message_at: string | null;
    last_inbound_at: string | null;
}

/**
 * Decide whether `row` is a fresh inbound message we should notify about.
 *
 * @param row            the thread as just read
 * @param prevInboundMs  the last inbound timestamp we've already seen for this
 *                       phone (ms), or undefined if we've never seen it
 * @param mountFloorMs   floor timestamp (ms) — on first sight of a phone, only
 *                       notify if the inbound is at/after this, so pre-existing
 *                       unread rows touched by an unrelated update stay silent
 */
export function isNewInbound(
    row: ChatRealtimeRow,
    prevInboundMs: number | undefined,
    mountFloorMs: number,
): boolean {
    const inboundMs = row.last_inbound_at ? Date.parse(row.last_inbound_at) : NaN;
    if (!Number.isFinite(inboundMs)) return false;

    // The customer's message must be the latest activity on the thread — an
    // outbound send / AI reply after it stamps a newer last_message_at, meaning
    // we've already responded (nothing to alert on).
    const lastMsgMs = row.last_message_at ? Date.parse(row.last_message_at) : 0;
    if (Number.isFinite(lastMsgMs) && lastMsgMs > inboundMs) return false;

    if (prevInboundMs === undefined) {
        // First time we see this chat this session: only fire for a genuinely
        // fresh inbound, never for a historical row surfaced by some other edit.
        return inboundMs >= mountFloorMs;
    }
    return inboundMs > prevInboundMs;
}

/**
 * The rows of one read of the latest threads that carry a fresh inbound
 * message (isNewInbound), in read order. Records every row's inbound
 * timestamp in `seen` (phone → ms) — also for rows that do not alert (already
 * replied, pre-mount) — so the next read only reports newer messages.
 */
export function pickFreshInbound(
    rows: readonly ChatRealtimeRow[],
    seen: Map<string, number>,
    mountFloorMs: number,
): ChatRealtimeRow[] {
    const fresh: ChatRealtimeRow[] = [];
    for (const row of rows) {
        if (isNewInbound(row, seen.get(row.phone_number), mountFloorMs)) fresh.push(row);
        const inboundMs = row.last_inbound_at ? Date.parse(row.last_inbound_at) : NaN;
        // Never move back: overlapping reads can land out of order, and an
        // older read must not make an already-alerted message look new again.
        if (Number.isFinite(inboundMs)) {
            seen.set(row.phone_number, Math.max(seen.get(row.phone_number) ?? -Infinity, inboundMs));
        }
    }
    return fresh;
}
