import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// Events of the WABA's other numbers (Fase 2 task 2.2a, phase 0). The app is
// subscribed to the whole WABA, so the events of numbers other than
// WHATSAPP_PHONE_NUMBER_ID reach the webhook too. They are not this org's
// conversations: dropped by default, or with WHATSAPP_OTHER_NUMBER_EVENTS=
// process kept in the default org's inbox without AI ("store-only") while the
// team finds out what such a number is used for. A stored one does not touch
// last_inbound_at (Meta's 24-hour window is per business number, and the main
// number has none with this customer), is marked in metadata so the AI
// history leaves it out (queue-db.ts), and the chat gets a note for the
// operators once a day.

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

/**
 * WHATSAPP_OTHER_NUMBER_EVENTS: '' or 'drop' (the default) drops the events;
 * 'process' (or 'store') stores them without AI. Surrounding quotes are
 * ignored. Any other value is a typo (e.g. 'proses'): treated as 'process',
 * the side that loses nothing, and reported as unknownValue for an alert.
 */
export function otherNumberMode(raw = process.env.WHATSAPP_OTHER_NUMBER_EVENTS): { mode: 'drop' | 'store'; unknownValue?: string } {
    const value = (raw ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase();
    if (value === '' || value === 'drop') return { mode: 'drop' };
    if (value === 'process' || value === 'store') return { mode: 'store' };
    return { mode: 'store', unknownValue: value.replace(/[^a-z0-9_-]/g, '').slice(0, 40) };
}

// Numbers this server process already looked up (a WABA has a handful).
const checked = new Set<string>();
const CHECKED_MAX = 100;
const SEEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether no webhook_unrouted event named this number in the last 7 days: a
 * number new to the WABA, or the app's own number when WHATSAPP_PHONE_NUMBER_ID
 * is wrong. Such a number is alerted within the hour (webhook_unrouted_new); a
 * known one only daily. Call it before this event is recorded. Looked up once
 * per number per server process; a read error counts as known (the daily
 * alert still comes). ops_events keeps one example detail per minute, so a
 * number whose events always share their minute with another number's may
 * look new again after a restart: an extra email, never a missing one.
 */
export async function isNewOtherNumber(client: SupabaseClient, other: OtherNumber, now = Date.now()): Promise<boolean> {
    if (checked.has(other.ref)) return false;
    if (checked.size < CHECKED_MAX) checked.add(other.ref);
    const { data, error } = await client
        .from('ops_events')
        .select('id')
        .eq('kind', 'webhook_unrouted')
        .like('detail', `phone_number_id ${other.ref};%`)
        .gte('minute', new Date(now - SEEN_WINDOW_MS).toISOString())
        .limit(1);
    if (error) return false;
    return !data || data.length === 0;
}

const notes = new Map<string, number>();
const NOTE_EVERY_MS = 24 * 60 * 60 * 1000;
const NOTES_MAX = 1000;

/** Whether this chat gets the other-number note now: once a day per chat and server process. */
export function firstOtherNumberNote(chatKey: string, now = Date.now()): boolean {
    const last = notes.get(chatKey);
    if (last !== undefined && now - last < NOTE_EVERY_MS) return false;
    if (notes.size >= NOTES_MAX) notes.clear();
    notes.set(chatKey, now);
    return true;
}

/** The note for the operators in a chat that received a store-only message. */
export function otherNumberNotice(other: OtherNumber): string {
    const which = other.last4 ? `nomor berakhiran ${other.last4}` : `nomor lain (${other.ref})`;
    return (
        `Pesan dari kontak ini masuk ke ${which}, nomor WhatsApp lain di WABA ini, bukan nomor utama Sarathi. ` +
        'AI tidak membalasnya. Balasan dari dashboard terkirim dari nomor utama; bila kontak belum mengirim pesan ke ' +
        'nomor utama dalam 24 jam terakhir, hanya template yang bisa dikirim.'
    );
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

/** Tests only: forget the numbers looked up and the notes written. */
export function resetOtherNumberState(): void {
    checked.clear();
    notes.clear();
}
