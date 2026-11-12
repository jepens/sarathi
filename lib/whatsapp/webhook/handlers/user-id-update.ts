import type { SupabaseClient } from '@supabase/supabase-js';
import { whatsappLogger } from '@/lib/utils/logger';

// A customer's new phone number: their stored BSUID moves to the new one, so
// the contact stays linked.

// Phase B — user_id_update. Meta fires this when a customer changes their
// phone number: the BSUID regenerates and we get the old + new IDs. We move
// our stored bsuid from old → new so the next inbound message still resolves
// to the same contact (phone_number PK stays put — no re-key).
//
// Real Meta payload (WhatsApp BSUID docs), field "user_id_update":
//   value.user_id_update: [ { wa_id, detail,
//     user_id: { previous: <OLD_BSUID>, current: <NEW_BSUID> },
//     parent_user_id: { previous, current }, timestamp } ]
// We read the nested user_id.previous/current, and still fall back to a few
// flat guesses in case Meta tweaks the shape during the 2026 rollout.
export async function handleUserIdUpdate(
    supabase: SupabaseClient,
    orgId: string,
    value: Record<string, unknown>
): Promise<void> {
    // Container: value.user_id_update[] (the documented shape); accept the
    // plural and a bare object too, defensively.
    const container = Array.isArray(value.user_id_update)
        ? value.user_id_update
        : Array.isArray(value.user_id_updates)
            ? value.user_id_updates
            : [value];
    const updates: Array<Record<string, unknown>> = container.filter(
        (u): u is Record<string, unknown> => !!u && typeof u === 'object',
    );

    const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
        for (const k of keys) {
            const v = o[k];
            if (typeof v === 'string' && v.length > 0) return v;
        }
        return null;
    };
    // The documented shape nests the ids under `user_id: { previous, current }`.
    const nested = (u: Record<string, unknown>): Record<string, unknown> | null =>
        u.user_id && typeof u.user_id === 'object' ? (u.user_id as Record<string, unknown>) : null;

    for (const u of updates) {
        const uid = nested(u);
        const oldId =
            (uid && pick(uid, ['previous'])) ||
            pick(u, ['old_user_id', 'previous_user_id', 'old_wa_id', 'previous_wa_id']);
        const newId =
            (uid && pick(uid, ['current'])) ||
            pick(u, ['new_user_id', 'current_user_id', 'new_wa_id', 'current_wa_id']);
        if (!oldId || !newId) {
            whatsappLogger.warn(`user_id_update: could not parse old/new id (fields: ${Object.keys(u ?? {}).join(',') || '-'})`);
            continue;
        }

        const { data, error } = await supabase
            .from('whatsapp_chats')
            .update({ bsuid: newId, updated_at: new Date().toISOString() })
            .eq('org_id', orgId)
            .eq('bsuid', oldId)
            .select('phone_number');

        if (error) {
            whatsappLogger.error(`user_id_update: failed to move bsuid ${oldId}→${newId}`, error);
        } else {
            whatsappLogger.info(`user_id_update: moved bsuid ${oldId}→${newId} for ${data?.length ?? 0} contact(s)`);
        }
    }
}
