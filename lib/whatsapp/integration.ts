import { createClient } from '@/lib/supabase/server';

// Per-tenant WhatsApp credentials (Fase 2). Secrets never leave the server: the
// UI only ever receives a masked view (whether a secret is set, not its value).

export interface WhatsAppIntegrationView {
    phoneNumberId: string;
    wabaId: string;
    displayPhone: string;
    hasAccessToken: boolean;
    hasAppSecret: boolean;
}

/**
 * The current org's WhatsApp integration, masked for the client. RLS scopes the
 * row to the logged-in user's org, so no org_id filter is needed here.
 */
export async function getMyWhatsAppIntegration(): Promise<WhatsAppIntegrationView | null> {
    const supabase = await createClient();
    const { data } = await supabase
        .from('whatsapp_integrations')
        .select('phone_number_id, waba_id, display_phone, access_token, app_secret')
        .maybeSingle();

    if (!data) return null;
    return {
        phoneNumberId: data.phone_number_id ?? '',
        wabaId: data.waba_id ?? '',
        displayPhone: data.display_phone ?? '',
        hasAccessToken: !!data.access_token,
        hasAppSecret: !!data.app_secret,
    };
}
