import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// Events of the WABA's other numbers (Fase 2 task 2.2a, phase 0). The app is
// subscribed to the whole WABA, so the events of numbers other than
// WHATSAPP_PHONE_NUMBER_ID reach the webhook too. They are not this org's
// conversations: dropped by default, or with WHATSAPP_OTHER_NUMBER_EVENTS=
// process kept in the default org's inbox without AI ("store-only") while the
// team finds out what such a number is used for. A stored one shows in the
// inbox like any customer message (unread, "Belum dibalas", notifications;
// it stamps last_inbound_at, so the chat's 24-hour marker follows it although
// Meta's window is per business number), is marked in metadata so the AI
// history leaves it out (queue-db.ts), and the chat gets a note for the
// operators once a day that says so.

export interface OtherNumber {
    /** 'h' + 10 hex of the sha256 of its phone_number_id; never the id itself. */
    ref: string;
    /** The last four digits of its display number, when Meta sent it. */
    last4: string | null;
}

export function otherNumberOf(phoneNumberId: string, displayPhoneNumber: unknown): OtherNumber {
    const digits = typeof displayPhoneNumber === 'string' ? displayPhoneNumber.replace(/\D+/g, '') : '';
    return {
        ref: `h${createHash('sha256').update(phoneNumberId).digest('hex').slice(0, 10)}`,
        last4: digits.length >= 4 ? digits.slice(-4) : null,
    };
}

/** How alert details name it: "phone_number_id h…; nomor berakhiran 1234". */
export function otherNumberLabel(other: OtherNumber): string {
    return `phone_number_id ${other.ref}${other.last4 ? `; nomor berakhiran ${other.last4}` : ''}`;
}

const UNKNOWN_ECHO_MAX = 12;

/**
 * WHATSAPP_OTHER_NUMBER_EVENTS: '' or 'drop' (the default) drops the events;
 * 'process' (or 'store') stores them without AI. Surrounding quotes are
 * ignored. Any other value is a typo (e.g. 'proses'): treated as 'process',
 * the side that loses nothing, and described in unknownValue for the alert:
 * a short value quoted, a longer one (more likely something pasted into the
 * wrong variable, even a secret) only by its length.
 */
export function otherNumberMode(raw = process.env.WHATSAPP_OTHER_NUMBER_EVENTS): { mode: 'drop' | 'store'; unknownValue?: string } {
    const value = (raw ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase();
    if (value === '' || value === 'drop') return { mode: 'drop' };
    if (value === 'process' || value === 'store') return { mode: 'store' };
    const unknownValue = value.length <= UNKNOWN_ECHO_MAX
        ? `"${value.replace(/[^a-z0-9_-]/g, '')}"`
        : `nilai ${value.length} karakter`;
    return { mode: 'store', unknownValue };
}

// The lookup of each number this server process has looked up or is looking
// up (a WABA has a handful).
const lookups = new Map<string, Promise<boolean>>();
const LOOKUPS_MAX = 100;
const SEEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function lookUpNew(client: SupabaseClient, other: OtherNumber, now: number): Promise<boolean> {
    const { data, error } = await client
        .from('ops_events')
        .select('id')
        .eq('kind', 'webhook_unrouted')
        .like('detail', `phone_number_id ${other.ref};%`)
        .gte('minute', new Date(now - SEEN_WINDOW_MS).toISOString())
        .limit(1);
    if (error) throw error;
    return !data || data.length === 0;
}

/**
 * Whether a webhook_unrouted event named this number in the last 7 days.
 * 'new' (none did: a number new to the WABA, or the app's own number when
 * WHATSAPP_PHONE_NUMBER_ID is wrong) and 'unchecked' (the lookup failed) are
 * alerted within the hour (webhook_unrouted_new); a 'known' number only
 * daily. A failed lookup is alerted rather than taken for known: this event's
 * own webhook_unrouted row would make every later lookup find the number.
 * Call it before this event is recorded: concurrent deliveries of the same
 * number wait for one lookup and only the first of them gets its result, so
 * no event of this number is recorded before the lookup ran. Looked up once
 * per number per server process (a restart looks again; after a failed
 * lookup the next event looks again). ops_events keeps one example detail
 * per minute, so a number whose events always share their minute with
 * another number's may look new again after a restart: an extra email, never
 * a missing one.
 */
export async function otherNumberSeen(
    client: SupabaseClient,
    other: OtherNumber,
    now = Date.now(),
): Promise<'new' | 'known' | 'unchecked'> {
    const pending = lookups.get(other.ref);
    if (pending) {
        await pending.catch(() => false);
        return 'known';
    }
    const lookup = lookUpNew(client, other, now);
    if (lookups.size < LOOKUPS_MAX) lookups.set(other.ref, lookup);
    try {
        return (await lookup) ? 'new' : 'known';
    } catch {
        lookups.delete(other.ref);
        return 'unchecked';
    }
}

const notes = new Map<string, number>();
const NOTE_EVERY_MS = 24 * 60 * 60 * 1000;
const limitNotes = new Map<string, number>();
const LIMIT_NOTE_EVERY_MS = 60 * 1000;
const NOTES_MAX = 1000;

function firstIn(map: Map<string, number>, everyMs: number, key: string, now: number): boolean {
    const last = map.get(key);
    if (last !== undefined && now - last < everyMs) return false;
    if (map.size >= NOTES_MAX) map.clear();
    map.set(key, now);
    return true;
}

/** Whether this chat gets the other-number note now: once a day per chat and server process. */
export function firstOtherNumberNote(chatKey: string, now = Date.now()): boolean {
    return firstIn(notes, NOTE_EVERY_MS, chatKey, now);
}

/** Whether this chat gets the "over the rate limit" note now: once a minute per chat and server process. */
export function firstOtherNumberLimitNote(chatKey: string, now = Date.now()): boolean {
    return firstIn(limitNotes, LIMIT_NOTE_EVERY_MS, chatKey, now);
}

function numberName(other: OtherNumber): string {
    return other.last4 ? `nomor berakhiran ${other.last4}` : `nomor lain (${other.ref})`;
}

/** The note for the operators in a chat that received a store-only message. */
export function otherNumberNotice(other: OtherNumber): string {
    return (
        `Pesan dari kontak ini masuk ke ${numberName(other)}, nomor WhatsApp lain di WABA ini, bukan nomor utama Sarathi. ` +
        'AI tidak membalasnya. Balasan dari dashboard terkirim dari nomor utama, dan tanda 24 jam chat ini ikut pesan ke ' +
        'nomor lain itu: bila kontak belum mengirim pesan ke nomor utama dalam 24 jam terakhir, kirim template (pesan biasa ditolak Meta).'
    );
}

/** The note when messages to another number were over the contact's rate limit and not stored. */
export function otherNumberLimitNotice(other: OtherNumber): string {
    return `Pesan dari kontak ini ke ${numberName(other)} melebihi batas per menit; sebagian tidak disimpan.`;
}

/** whatsapp_messages.metadata of a stored message from another number. */
export function otherNumberMetadata(other: OtherNumber): { other_number: string } {
    return { other_number: other.ref };
}

/** Whether a stored whatsapp_messages row came from another number of the WABA. */
export function isOtherNumberRow(metadata: unknown): boolean {
    return (
        metadata !== null &&
        typeof metadata === 'object' &&
        typeof (metadata as Record<string, unknown>).other_number === 'string'
    );
}

/** Tests only: forget the lookups and the notes. */
export function resetOtherNumberState(): void {
    lookups.clear();
    notes.clear();
    limitNotes.clear();
}
