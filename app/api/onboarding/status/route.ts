import { createServiceOrServerClient } from '@/lib/supabase/service';
import {
    accessDeniedResponse,
    isDefaultOrg,
    requireOrgContext,
} from '@/lib/settings/org-context';
import { getWebhookUrl, getVerifyToken } from '@/lib/settings/app-settings';
import { resolvePublicOrigin } from '@/lib/utils/public-url';
import { envWhatsAppSendConfigured } from '@/lib/whatsapp/credentials';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Drives the dashboard onboarding checklist. All counts are RLS-scoped to the
// caller's org. `show` is false once the org has started operating (any chat
// exists) so the checklist disappears for established tenants (e.g. Sailendra,
// which runs on env WhatsApp creds and would otherwise look "not connected").
export async function GET(request: Request) {
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

    // WhatsApp credentials come from server env, not a per-org row — and they
    // belong to the default org only (lib/whatsapp/credentials.ts reads them).
    const isDefault = await isDefaultOrg(orgId);
    const whatsappConfigured = isDefault && envWhatsAppSendConfigured();

    const steps = {
        profile: handoffPhone.length > 0,
        whatsapp: whatsappConfigured,
        knowledge: (docCountQ.count ?? 0) > 0,
    };

    // Callback URL + Verify Token are platform values for the env number, so
    // only default-org members see them (KEA-27). Other tenants' WhatsApp is set
    // up by the Sarathi team — they get nulls and the checklist shows a neutral
    // note instead. Resolved platform-wide: the callback URL from the request
    // host, the verify token via a service-role client.
    let webhookUrl: string | null = null;
    let verifyToken: string | null = null;
    if (isDefault) {
        const origin = resolvePublicOrigin(request.headers);
        const svc = await createServiceOrServerClient();
        webhookUrl = origin
            ? `${origin}/api/webhook/whatsapp`
            : await getWebhookUrl(svc);
        verifyToken = await getVerifyToken(svc);
    }

    return NextResponse.json({
        show: (chatCountQ.count ?? 0) === 0,
        steps,
        webhookVisible: isDefault,
        webhookUrl,
        verifyToken,
    });
}
