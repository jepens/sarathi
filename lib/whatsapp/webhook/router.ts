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
import type { MetaJson } from '@/lib/whatsapp/webhook/types';

// Which number of the WABA an event is for: this app's own (handled), or
// another one (dropped or only stored).

export type ChangeRoute = { route: 'main' } | { route: 'dropped' } | { route: 'store_only'; other: OtherNumber };

// One-number routing (Fase 2 task 2.2a, phase 0; see
// lib/whatsapp/other-number.ts). The app is subscribed to the whole
// WABA, so the events of its other numbers arrive here too. They are
// not this org's conversations (the AI would answer from the wrong
// number): dropped, or with WHATSAPP_OTHER_NUMBER_EVENTS=process
// stored in the default org's inbox without AI replies or any
// automatic send. Either way the team is told: within the hour for a
// number not seen in the last 7 days (a new number, or this app's
// own number under a wrong WHATSAPP_PHONE_NUMBER_ID), daily after
// that. Without a usable number id nothing can be routed: 503 (Meta
// retries once it is fixed) and an alert.
export async function routeOtherNumber(supabase: SupabaseClient, webhookApp: WebhookApp, metadata: MetaJson): Promise<ChangeRoute> {
    const phoneNumberId = metadata?.phone_number_id;
    if (phoneNumberId !== undefined && phoneNumberId !== null && String(phoneNumberId) !== webhookApp.phoneNumberId) {
        const other = otherNumberOf(String(phoneNumberId), metadata?.display_phone_number);
        const otherNumbers = otherNumberMode();
        if (otherNumbers.unknownValue !== undefined) {
            await recordOpsEvent(supabase, 'webhook_unconfigured', {
                detail: `WHATSAPP_OTHER_NUMBER_EVENTS tidak dikenal (${otherNumbers.unknownValue}): diperlakukan sebagai process, pesan nomor lain disimpan tanpa AI`,
            });
        }
        // 'diproses': in process mode a message is stored (within the
        // contact's rate limit); a status update only updates our rows.
        const outcome = otherNumbers.mode === 'drop'
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
        if (otherNumbers.mode === 'drop') {
            whatsappLogger.warn(`Webhook for another number of the WABA (${other.ref}) — dropped`);
            return { route: 'dropped' };
        }
        whatsappLogger.warn(`Webhook for another number of the WABA (${other.ref}) — stored without AI (WHATSAPP_OTHER_NUMBER_EVENTS=process)`);
        return { route: 'store_only', other };
    }
    return { route: 'main' };
}
