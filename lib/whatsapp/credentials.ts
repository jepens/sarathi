import { SupabaseClient } from '@supabase/supabase-js';
import { getDefaultOrgId } from '@/lib/settings/org-context';

// Per-tenant WhatsApp credential resolution (Fase 2b). Service-role paths
// (webhook, queue) resolve the org + credentials for an incoming/outgoing
// number. Falls back to the env credentials + default org so the original
// single-tenant number (Sailendra) keeps working until its integration row
// exists.

export interface WhatsAppSendCreds {
    phoneNumberId: string;
    accessToken: string;
}

export interface WhatsAppContext extends WhatsAppSendCreds {
    orgId: string;
    appSecret: string | null;
}

function envCreds(): WhatsAppContext & { orgId: '' } {
    return {
        orgId: '',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
        appSecret: process.env.WHATSAPP_APP_SECRET || null,
    };
}

/**
 * Resolve the org + credentials that own an INCOMING phone_number_id (webhook).
 * No integration row → env credentials + default org (Sailendra bridge).
 */
export async function resolveWhatsAppContext(
    client: SupabaseClient,
    phoneNumberId: string | undefined | null,
): Promise<WhatsAppContext> {
    if (phoneNumberId) {
        const { data } = await client
            .from('whatsapp_integrations')
            .select('org_id, phone_number_id, access_token, app_secret')
            .eq('phone_number_id', phoneNumberId)
            .maybeSingle();
        if (data?.access_token) {
            return {
                orgId: data.org_id,
                phoneNumberId: data.phone_number_id,
                accessToken: data.access_token,
                appSecret: data.app_secret ?? null,
            };
        }
    }
    const env = envCreds();
    return { ...env, orgId: await getDefaultOrgId(client) };
}

/**
 * Send credentials for a given org (queue → outbound reply). Falls back to env.
 */
export async function getWhatsAppSendCreds(
    client: SupabaseClient,
    orgId: string,
): Promise<WhatsAppSendCreds> {
    if (orgId) {
        const { data } = await client
            .from('whatsapp_integrations')
            .select('phone_number_id, access_token')
            .eq('org_id', orgId)
            .maybeSingle();
        if (data?.phone_number_id && data?.access_token) {
            return {
                phoneNumberId: data.phone_number_id,
                accessToken: data.access_token,
            };
        }
    }
    const env = envCreds();
    return { phoneNumberId: env.phoneNumberId, accessToken: env.accessToken };
}
