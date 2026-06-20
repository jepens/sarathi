import { createClient } from '@/lib/supabase/server';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { getCurrentOrgId } from '@/lib/settings/org-context';
import { getWebhookUrl, getVerifyToken } from '@/lib/settings/app-settings';
import { resolvePublicOrigin } from '@/lib/utils/public-url';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Drives the dashboard onboarding checklist. All counts are RLS-scoped to the
// caller's org. `show` is false once the org has started operating (any chat
// exists) so the checklist disappears for established tenants (e.g. Sailendra,
// which runs on env WhatsApp creds and would otherwise look "not connected").
export async function GET(request: Request) {
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
    const docCountQ = await supabase
        .from('documents')
        .select('id', { count: 'exact', head: true });

    const handoffPhone = (profileQ.data?.handoff_phone ?? '').trim();

    // Single-tenant: WhatsApp credentials come from server env, not a per-org row.
    const whatsappConfigured =
        !!process.env.WHATSAPP_PHONE_NUMBER_ID && !!process.env.WHATSAPP_ACCESS_TOKEN;

    const steps = {
        profile: handoffPhone.length > 0,
        whatsapp: whatsappConfigured,
        knowledge: (docCountQ.count ?? 0) > 0,
    };

    // Callback URL + Verify Token are PLATFORM-GLOBAL — the webhook routes by
    // phone_number_id, so every tenant points Meta at the same endpoint with the
    // same verify token. The canonical values live in the platform owner's
    // org-scoped app_settings row, which a *different* tenant's RLS client can't
    // read (it would fall back to localhost/'123456'). Resolve them platform-wide
    // instead: the callback URL from the request host, the verify token via a
    // service-role client.
    const origin = resolvePublicOrigin(request.headers);
    const svc = await createServiceOrServerClient();
    const webhookUrl = origin
        ? `${origin}/api/webhook/whatsapp`
        : await getWebhookUrl(svc);
    const verifyToken = await getVerifyToken(svc);

    return NextResponse.json({
        show: (chatCountQ.count ?? 0) === 0,
        steps,
        webhookUrl,
        verifyToken,
    });
}
