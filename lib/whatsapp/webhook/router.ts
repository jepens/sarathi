import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebhookApp } from '@/lib/whatsapp/credentials';
import { whatsappLogger } from '@/lib/utils/logger';
import {
    otherNumberLabel,
    otherNumberMode,
    otherNumberOf,
    otherNumberSeen,
    type OtherNumber,
} from '@/lib/whatsapp/other-number';
import { recordOpsEvent } from '@/lib/ops/events';
import { isRecord, messagesOf, metaWord, statusesOf, type ChangeRef } from '@/lib/whatsapp/webhook/payload';

// What each change of a delivery is: a BSUID update, an event of this app's
// own number (handled), of another number of the WABA (dropped or only
// stored), or a field this webhook does not handle.

export type ChangeRoute =
    | { route: 'user_id_update' }
    | { route: 'main' }
    | { route: 'store_only'; other: OtherNumber }
    | { route: 'dropped' }
    | { route: 'ignored_field' };

export type RoutedChange = ChangeRef & { route: ChangeRoute };

// Fires when a customer changes their phone number → BSUID regenerates.
// Detected by the change field name or a user_id_update(s) key on the value,
// before the number gate: a BSUID is scoped to the business portfolio, so the
// change applies to this org's contacts whichever number of the WABA reported
// it (or none: it needs no metadata).
export function isUserIdUpdateChange(change: ChangeRef): boolean {
    const value = isRecord(change.value) ? change.value : {};
    return change.field === 'user_id_update' || 'user_id_updates' in value || 'user_id_update' in value;
}

// One-number routing (Fase 2 task 2.2a; see lib/whatsapp/other-number.ts).
// The app is subscribed to the whole WABA, so the events of its other
// numbers arrive here too. They are not this org's conversations (the AI
// would answer from the wrong number): dropped, or with
// WHATSAPP_OTHER_NUMBER_EVENTS=process stored in the app's org inbox
// without AI replies or any automatic send. Either way the team is told:
// within the hour for a number not seen in the last 7 days (a new number,
// or this app's own number under a wrong phone_number_id in Vault), daily
// after that.
async function routeByNumber(
    supabase: SupabaseClient,
    webhookApp: WebhookApp,
    change: ChangeRef,
    mode: ReturnType<typeof otherNumberMode>,
    alertUnknownMode: () => Promise<void>,
): Promise<ChangeRoute> {
    const metadata = isRecord(change.value) ? change.value.metadata : undefined;
    const phoneNumberId = isRecord(metadata) ? metadata.phone_number_id : undefined;
    if (phoneNumberId === undefined || phoneNumberId === null) {
        if (messagesOf(change.value).length + statusesOf(change.value).length > 0) {
            whatsappLogger.warn('Webhook change without metadata.phone_number_id — handled as the main number');
        }
        return { route: 'main' };
    }
    if (String(phoneNumberId) === webhookApp.phoneNumberId) return { route: 'main' };

    const other = otherNumberOf(String(phoneNumberId), isRecord(metadata) ? metadata.display_phone_number : undefined);
    await alertUnknownMode();
    // 'diproses': in process mode a message is stored (within the
    // contact's rate limit); a status update only updates our rows.
    const outcome = mode.mode === 'drop'
        ? 'dibuang'
        : 'diproses tanpa AI, pesan disimpan di inbox (WHATSAPP_OTHER_NUMBER_EVENTS=process)';
    // Looked up before this event is recorded; a failed lookup is
    // alerted too (see otherNumberSeen).
    const seen = await otherNumberSeen(supabase, other);
    if (seen !== 'known') {
        await recordOpsEvent(supabase, 'webhook_unrouted_new', {
            detail: `${otherNumberLabel(other)}; ${outcome}${seen === 'unchecked' ? '; riwayat 7 hari tidak terbaca' : ''}`,
        });
    }
    await recordOpsEvent(supabase, 'webhook_unrouted', { detail: `${otherNumberLabel(other)}; ${outcome}` });
    if (mode.mode === 'drop') {
        whatsappLogger.warn(`Webhook for another number of the WABA (${other.ref}) — dropped`);
        return { route: 'dropped' };
    }
    whatsappLogger.warn(`Webhook for another number of the WABA (${other.ref}) — stored without AI (WHATSAPP_OTHER_NUMBER_EVENTS=process)`);
    return { route: 'store_only', other };
}

/**
 * The route of every change of a delivery, with part 1's alerts per change
 * (webhook_unrouted, webhook_unrouted_new). WHATSAPP_OTHER_NUMBER_EVENTS is
 * read once per delivery, and an unknown value is alerted once per delivery
 * (when a change of another number is there). The org is never read here: a
 * dropped event must not depend on it.
 */
export async function routeChanges(supabase: SupabaseClient, webhookApp: WebhookApp, changes: ChangeRef[]): Promise<RoutedChange[]> {
    // An empty number id would make every event look like another number's.
    // The pipeline routes only with the number row of the app's org
    // (phone_number_id is checked digits-only in the database); any other
    // caller is a bug.
    if (!webhookApp.phoneNumberId) throw new Error('routeChanges needs a usable phone number id');
    const mode = otherNumberMode();
    let modeAlerted = false;
    const alertUnknownMode = async () => {
        if (mode.unknownValue === undefined || modeAlerted) return;
        modeAlerted = true;
        await recordOpsEvent(supabase, 'webhook_unconfigured', {
            detail: `WHATSAPP_OTHER_NUMBER_EVENTS tidak dikenal (${mode.unknownValue}): diperlakukan sebagai process, pesan nomor lain disimpan tanpa AI`,
        });
    };
    const routed: RoutedChange[] = [];
    for (const change of changes) {
        let route: ChangeRoute;
        if (isUserIdUpdateChange(change)) {
            route = { route: 'user_id_update' };
        } else if (change.field !== undefined && change.field !== null && change.field !== 'messages') {
            // Template status, account updates and the like: other tasks (2.5a).
            whatsappLogger.debug(`Webhook change field "${metaWord(change.field)}" is not handled here — acknowledged`);
            route = { route: 'ignored_field' };
        } else {
            route = await routeByNumber(supabase, webhookApp, change, mode, alertUnknownMode);
        }
        routed.push({ ...change, route });
    }
    return routed;
}
