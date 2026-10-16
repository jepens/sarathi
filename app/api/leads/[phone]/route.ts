import { NextResponse } from 'next/server';
import { LEAD_STAGES, type LeadStage } from '@/lib/ai/tools';
import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';

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
// has bookings, so financial records are never wiped.
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

    return NextResponse.json({ ok: true });
}
