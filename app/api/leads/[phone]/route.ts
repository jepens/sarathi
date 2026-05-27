import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { LEAD_STAGES, type LeadStage } from '@/lib/ai/tools';

// Mirror the DB CHECK constraint so we reject bad input before hitting Postgres.
function isLeadStage(v: unknown): v is LeadStage {
    return typeof v === 'string' && (LEAD_STAGES as readonly string[]).includes(v);
}

// Whitelist of patchable fields — anything else in the body is ignored. This
// keeps callers (kanban drag-drop, lead detail panel) from accidentally
// stomping on system columns like phone_number / created_at.
const PATCHABLE_FIELDS = new Set([
    'contact_name',
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
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
        patch[key] = value;
    }

    if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: 'No patchable fields in body' }, { status: 400 });
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('whatsapp_chats')
        .update(patch)
        .eq('phone_number', phone)
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ lead: data });
}
