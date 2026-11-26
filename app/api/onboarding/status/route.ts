import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { orgWhatsAppConnected } from '@/lib/whatsapp/credentials';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Drives the dashboard onboarding checklist. All counts are RLS-scoped to the
// caller's org. `show` is false once the org has started operating (any chat
// exists) so the checklist disappears for established tenants.
export async function GET() {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase, orgId } = access;

    const chatCountQ = await supabase
        .from('whatsapp_chats')
        .select('phone_number', { count: 'exact', head: true });
    const profileQ = await supabase
        .from('business_profiles')
        .select('handoff_phone')
        .eq('org_id', orgId)
        .maybeSingle();
    const docCountQ = await supabase
        .from('documents')
        .select('id', { count: 'exact', head: true });

    const handoffPhone = (profileQ.data?.handoff_phone ?? '').trim();

    // Every org's number is connected by the Sarathi team (Vault, 2.2d): the
    // step is done once it is active. No URL or token is returned.
    const steps = {
        profile: handoffPhone.length > 0,
        whatsapp: await orgWhatsAppConnected(orgId),
        knowledge: (docCountQ.count ?? 0) > 0,
    };

    return NextResponse.json({
        show: (chatCountQ.count ?? 0) === 0,
        steps,
    });
}
