import { createClient } from '@/lib/supabase/server';
import { getCurrentOrgId } from '@/lib/settings/org-context';
import { getWebhookUrl, getVerifyToken } from '@/lib/settings/app-settings';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Drives the dashboard onboarding checklist. All counts are RLS-scoped to the
// caller's org. `show` is false once the org has started operating (any chat
// exists) so the checklist disappears for established tenants (e.g. Sailendra,
// which runs on env WhatsApp creds and would otherwise look "not connected").
export async function GET() {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });

    const chatCountQ = await supabase
        .from('whatsapp_chats')
        .select('phone_number', { count: 'exact', head: true });
    const profileQ = await supabase
        .from('business_profiles')
        .select('handoff_phone')
        .eq('org_id', orgId)
        .maybeSingle();
    const integrationQ = await supabase
        .from('whatsapp_integrations')
        .select('org_id', { count: 'exact', head: true });
    const docCountQ = await supabase
        .from('documents')
        .select('id', { count: 'exact', head: true });

    const handoffPhone = (profileQ.data?.handoff_phone ?? '').trim();

    const steps = {
        profile: handoffPhone.length > 0,
        whatsapp: (integrationQ.count ?? 0) > 0,
        knowledge: (docCountQ.count ?? 0) > 0,
    };

    return NextResponse.json({
        show: (chatCountQ.count ?? 0) === 0,
        steps,
        webhookUrl: await getWebhookUrl(),
        verifyToken: await getVerifyToken(),
    });
}
