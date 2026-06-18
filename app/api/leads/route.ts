import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getCurrentOrgId } from '@/lib/settings/org-context';
import { leadInputSchema } from '@/lib/leads/schema';
import { createOrFillLead } from '@/lib/leads/create';

// Lead = whatsapp_chats row enriched with EO/CRM fields.
// "Leads" is the user-facing name; the backing table is whatsapp_chats because
// every WhatsApp contact is implicitly a lead in the EO funnel.

const LEAD_FIELDS =
    'phone_number, contact_name, email, event_interest, participant_count, ' +
    'location_pref, event_date_pref, event_goals, budget_range, lead_stage, ' +
    'assigned_to, source, tags, notes, last_message, last_message_at, updated_at';

export async function GET(request: Request) {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const stage = searchParams.get('stage');

    let query = supabase
        .from('whatsapp_chats')
        .select(LEAD_FIELDS)
        // Only actual client leads belong in the funnel — vendors and "other"
        // (spam / internal) are classified out (contact_type, migration 0017).
        .eq('contact_type', 'lead')
        // nullsFirst:false so conversation-less manual/imported leads
        // (last_message_at = null) sort to the BOTTOM, not the top.
        .order('last_message_at', { ascending: false, nullsFirst: false });

    if (stage) {
        query = query.eq('lead_stage', stage);
    }

    const { data, error } = await query;

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ leads: data ?? [] });
}

// Create a single lead manually (the "+ Tambah Lead" form). Dedup is
// fill-empty: if a row already exists for this org+identity, only empty columns
// are filled in (see createOrFillLead).
export async function POST(request: Request) {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) {
        return NextResponse.json(
            { error: 'Tidak ada organisasi aktif untuk akun ini' },
            { status: 403 }
        );
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = leadInputSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            {
                error: parsed.error.issues[0]?.message ?? 'Validasi gagal',
                issues: parsed.error.issues.map((i) => ({
                    field: i.path.join('.'),
                    message: i.message,
                })),
            },
            { status: 400 }
        );
    }

    try {
        const result = await createOrFillLead(supabase, orgId, parsed.data);
        // The phone already belongs to a vendor/other contact — report 409 so
        // the form can tell the user instead of silently doing nothing.
        if (result.result === 'skipped_non_lead') {
            return NextResponse.json(
                {
                    error: 'Nomor ini sudah terdaftar sebagai kontak lain (vendor/lainnya).',
                    ...result,
                },
                { status: 409 }
            );
        }
        return NextResponse.json(result, {
            status: result.result === 'created' ? 201 : 200,
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Gagal menyimpan lead' },
            { status: 500 }
        );
    }
}
