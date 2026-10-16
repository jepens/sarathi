import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

// Persona (system_message) persistence per org (tracker 1.8, audit KUA-6).
//
// GET /api/system-message answers an org WITHOUT a saved persona with a
// synthetic row (id 'default') built from its business profile. Saving that
// synthetic row must CREATE the org's first persona — there is no row to
// update. The row is always scoped to the caller's org and becomes the org's
// active persona (one active persona per org: trigger
// ensure_single_active_system_message + unique index
// system_message_one_active_per_org, migration 0061).

/** Id of the synthetic, not-yet-saved persona returned by GET. */
export const SYNTHETIC_PERSONA_ID = 'default';

export interface PersonaRow {
    id: string;
    org_id: string;
    name: string;
    content: string;
    is_active: boolean | null;
    description: string | null;
    created_at: string | null;
    updated_at: string | null;
}

export type SaveFirstPersonaResult =
    | { ok: true; row: PersonaRow; created: boolean }
    | { ok: false; error: PostgrestError | Error };

/**
 * Names tried for an org's first persona, in order. 'default' is the natural
 * name; while the global system_message_name_key still exists (until the
 * contract migration) another org may already own 'default', so an
 * org-specific fallback name keeps the save working.
 */
export function firstPersonaNames(orgId: string): string[] {
    return ['default', `default_${orgId.replace(/[^0-9a-z]/gi, '').toLowerCase()}`];
}

const UNIQUE_VIOLATION = '23505';

async function findReusablePersona(
    supabase: SupabaseClient,
    orgId: string,
    names: string[],
): Promise<{ row: PersonaRow | null; error: PostgrestError | null }> {
    // The org's active persona (e.g. created meanwhile from another tab) ...
    const active = await supabase
        .from('system_message')
        .select('*')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .maybeSingle();
    if (active.error) return { row: null, error: active.error };
    if (active.data) return { row: active.data as PersonaRow, error: null };

    // ... or an inactive persona of this org that already carries the name.
    const named = await supabase
        .from('system_message')
        .select('*')
        .eq('org_id', orgId)
        .in('name', names)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (named.error) return { row: null, error: named.error };
    return { row: (named.data as PersonaRow | null) ?? null, error: null };
}

async function activateWithContent(
    supabase: SupabaseClient,
    orgId: string,
    id: string,
    content: string,
): Promise<SaveFirstPersonaResult> {
    const { data, error } = await supabase
        .from('system_message')
        .update({ content, is_active: true, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('id', id)
        .select()
        .single();
    if (error) return { ok: false, error };
    return { ok: true, row: data as PersonaRow, created: false };
}

/**
 * Save the persona of an org that has no active persona yet (the editor
 * submitted the synthetic id). Reuses the org's own row when one exists,
 * otherwise inserts the org's first persona as the active one.
 * `supabase` is the caller's RLS-bound client; `orgId` their org.
 */
export async function saveFirstPersona(
    supabase: SupabaseClient,
    orgId: string,
    content: string,
): Promise<SaveFirstPersonaResult> {
    const names = firstPersonaNames(orgId);

    const existing = await findReusablePersona(supabase, orgId, names);
    if (existing.error) return { ok: false, error: existing.error };
    if (existing.row) return activateWithContent(supabase, orgId, existing.row.id, content);

    for (const name of names) {
        const { data, error } = await supabase
            .from('system_message')
            .insert([
                {
                    org_id: orgId,
                    name,
                    content,
                    description: 'Persona AI organisasi',
                    is_active: true,
                },
            ])
            .select()
            .single();
        if (!error) return { ok: true, row: data as PersonaRow, created: true };
        if (error.code !== UNIQUE_VIOLATION) return { ok: false, error };
        // Name taken (another org during the rollout, or a concurrent save of
        // this org): try the next name / reuse the row that won the race.
    }

    const raced = await findReusablePersona(supabase, orgId, names);
    if (raced.error) return { ok: false, error: raced.error };
    if (raced.row) return activateWithContent(supabase, orgId, raced.row.id, content);
    return { ok: false, error: new Error('Could not create the persona for this org') };
}
