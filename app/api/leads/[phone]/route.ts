import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_STAGES, type LeadStage } from '@/lib/ai/tools';
import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { CHAT_MEDIA_BUCKET, chatMediaObjectPath, contactMediaFolder } from '@/lib/storage/chat-media';

const LIST_PAGE = 1000;
const REMOVE_BATCH = 100;
// Both writers upload a file before they insert the message row that names
// it, so a file in the folder that no message names yet may belong to a
// message being written right now: only older ones are orphans to remove.
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * The chat-media keys of one contact (owner decision D21), or null when they
 * could not be read: then nothing may be deleted yet, so that a retry still
 * finds them. The keys its messages name (old rows hold the public URL, newer
 * ones the bare key), and the files in its own folder '<org>/<phone>' that no
 * message names and that are older than ORPHAN_MIN_AGE_MS (uploads whose
 * insert failed), when that folder is the contact's alone
 * (contactMediaFolder). Read with the member's RLS client before the rows are
 * deleted.
 */
async function contactMediaKeys(supabase: SupabaseClient, orgId: string, phone: string): Promise<string[] | null> {
    const { data: rows, error } = await supabase
        .from('whatsapp_messages')
        .select('media_url')
        .eq('org_id', orgId)
        .eq('phone_number', phone)
        .not('media_url', 'is', null);
    if (error) {
        console.error('Contact delete: reading the media keys failed', { code: error.code });
        return null;
    }
    const keys = new Set<string>();
    for (const row of (rows ?? []) as { media_url: string | null }[]) {
        const key = chatMediaObjectPath(row.media_url, orgId);
        if (key) keys.add(key);
    }
    const folder = contactMediaFolder(orgId, phone);
    if (!folder) return [...keys];
    const now = Date.now();
    for (let offset = 0; ; offset += LIST_PAGE) {
        const { data: entries, error: listError } = await supabase.storage
            .from(CHAT_MEDIA_BUCKET)
            .list(folder, { limit: LIST_PAGE, offset });
        if (listError) {
            console.error('Contact delete: listing the media folder failed');
            return null;
        }
        for (const entry of entries ?? []) {
            if (!entry.id) continue; // a sub-folder, not a file
            // A missing or odd date gives NaN: the file stays.
            if (now - Date.parse(entry.created_at) > ORPHAN_MIN_AGE_MS) keys.add(`${folder}/${entry.name}`);
        }
        if (!entries || entries.length < LIST_PAGE) break;
    }
    return [...keys];
}

/** Best-effort: the contact is already gone; a failure only leaves files behind (logged, without keys). */
async function removeContactMedia(supabase: SupabaseClient, keys: string[]): Promise<void> {
    let failed = 0;
    for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
        const batch = keys.slice(i, i + REMOVE_BATCH);
        const { error } = await supabase.storage.from(CHAT_MEDIA_BUCKET).remove(batch);
        if (error) failed += batch.length;
    }
    if (failed) console.error(`Contact delete: ${failed} of ${keys.length} media file(s) could not be removed`);
}

// Mirror the DB CHECK constraint so we reject bad input before hitting Postgres.
function isLeadStage(v: unknown): v is LeadStage {
    return typeof v === 'string' && (LEAD_STAGES as readonly string[]).includes(v);
}

// Whitelist of patchable fields — anything else in the body is ignored. This
// keeps callers (kanban drag-drop, lead detail panel) from accidentally
// stomping on system columns like phone_number / created_at.
const PATCHABLE_FIELDS = new Set([
    'contact_name',
    'company',
    'email',
    'event_interest',
    'participant_count',
    'location_pref',
    'event_date_pref',
    'event_goals',
    'budget_range',
    'lead_stage',
    'assigned_to',
    'source',
    'tags',
    'notes',
]);

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ phone: string }> }
) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase, orgId } = access;

    const { phone } = await params;
    if (!phone) {
        return NextResponse.json({ error: 'Phone number required' }, { status: 400 });
    }

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
        if (!PATCHABLE_FIELDS.has(key)) continue;
        if (key === 'lead_stage' && value !== null && !isLeadStage(value)) {
            return NextResponse.json(
                { error: `Invalid lead_stage. Expected one of: ${LEAD_STAGES.join(', ')}` },
                { status: 400 }
            );
        }
        if (
            key === 'participant_count' &&
            value !== null &&
            (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        ) {
            return NextResponse.json(
                { error: 'participant_count harus bilangan bulat ≥ 0' },
                { status: 400 }
            );
        }
        patch[key] = value;
    }

    if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: 'No patchable fields in body' }, { status: 400 });
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('whatsapp_chats')
        .update(patch)
        .eq('org_id', orgId)
        .eq('phone_number', phone)
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ lead: data });
}

// Permanently delete a contact and EVERYTHING tied to it — its chat history (the
// AI's "memory"), pending queue items, rate-limit rows, and the contact row
// itself (which cascades proposals and unlinks any vendor). Atomic, via the
// delete_contact_cascade RPC (migration 0047). REFUSES with 409 when the contact
// has bookings, so financial records are never wiped. Its chat-media files go
// too (owner decision D21): Storage objects cannot be deleted in SQL, so their
// keys are read first (if that fails, nothing is deleted: 503, a retry is
// safe) and the files removed through the Storage API once the rows are gone.
// What can still stay behind without a row (a remove that fails, a reply lost
// after the cascade committed, an upload racing the delete) is left to a
// periodic sweep of unreferenced chat-media objects (tracker 5.3).
export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ phone: string }> }
) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase, orgId } = access;

    const { phone } = await params;
    if (!phone) {
        return NextResponse.json({ error: 'Phone number required' }, { status: 400 });
    }

    // Before the rows go: afterwards the keys the messages name are lost.
    const mediaKeys = await contactMediaKeys(supabase, orgId, phone);
    if (!mediaKeys) {
        return NextResponse.json(
            { error: 'Gagal membaca file media kontak ini. Tidak ada yang dihapus, silakan coba lagi.' },
            { status: 503 }
        );
    }

    const { data, error } = await supabase.rpc('delete_contact_cascade', {
        p_org: orgId,
        p_phone: phone,
    });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const result = (data ?? {}) as { deleted?: boolean; reason?: string; orders?: number };

    if (!result.deleted) {
        if (result.reason === 'has_bookings') {
            const n = result.orders ?? 0;
            return NextResponse.json(
                {
                    error: `Kontak ini punya ${n} booking. Hapus atau selesaikan booking-nya dulu di menu Bookings sebelum menghapus kontak.`,
                    reason: 'has_bookings',
                },
                { status: 409 }
            );
        }
        if (result.reason === 'not_found') {
            return NextResponse.json(
                { error: 'Kontak tidak ditemukan atau sudah dihapus.' },
                { status: 404 }
            );
        }
        return NextResponse.json({ error: 'Gagal menghapus kontak.' }, { status: 500 });
    }

    if (mediaKeys.length > 0) await removeContactMedia(supabase, mediaKeys);

    return NextResponse.json({ ok: true });
}
