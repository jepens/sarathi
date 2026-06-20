import { SupabaseClient } from '@supabase/supabase-js';
import { getDefaultOrgId } from '@/lib/settings/org-context';

// WhatsApp credential resolution. Single-tenant: credentials come from the
// server environment (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN /
// WHATSAPP_APP_SECRET). The per-tenant whatsapp_integrations lookup is gone —
// there is one number, configured via env.

export interface WhatsAppSendCreds {
    phoneNumberId: string;
    accessToken: string;
}

export interface WhatsAppContext extends WhatsAppSendCreds {
    orgId: string;
    appSecret: string | null;
}

function envCreds(): WhatsAppSendCreds & { appSecret: string | null } {
    return {
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
        appSecret: process.env.WHATSAPP_APP_SECRET || null,
    };
}

/**
 * Resolve the org + credentials for an inbound webhook. Single-tenant: always
 * the env credentials + the one org.
 */
export async function resolveWhatsAppContext(client: SupabaseClient): Promise<WhatsAppContext> {
    return { ...envCreds(), orgId: await getDefaultOrgId(client) };
}

/**
 * Send credentials for outbound replies. Single-tenant: always the env creds.
 */
export async function getWhatsAppSendCreds(): Promise<WhatsAppSendCreds> {
    const env = envCreds();
    return { phoneNumberId: env.phoneNumberId, accessToken: env.accessToken };
}
