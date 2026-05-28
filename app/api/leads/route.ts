import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

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
        .order('last_message_at', { ascending: false });

    if (stage) {
        query = query.eq('lead_stage', stage);
    }

    const { data, error } = await query;

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ leads: data ?? [] });
}
