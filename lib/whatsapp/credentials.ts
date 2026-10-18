import { SupabaseClient } from '@supabase/supabase-js';
import { getDefaultOrgIdStrict } from '@/lib/settings/org-context';

// WhatsApp credential resolution. Single-tenant: credentials come from the
// server environment (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN /
// WHATSAPP_APP_SECRET). The per-tenant whatsapp_integrations lookup is gone —
// there is one number, configured via env. Fase 2 (owner decision D6: one Meta
// app per client) replaces this with per-app credentials in Supabase Vault and
// routing by phone_number_id (tasks 2.1b/2.2, docs/FASE2_DESIGN.md); until
// then whatsapp_integrations is service-role only and unused (0069).

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
 * The Meta app the webhook URL serves today (Fase 2 task 2.2a, phase 0: one
 * app, from env): the secret its signatures are checked with, and the one
 * number it routes. Needs no database, so the signature is checked before
 * anything else happens.
 */
export function envWebhookApp(): { appSecret: string | null; phoneNumberId: string } {
    const env = envCreds();
    return { appSecret: env.appSecret, phoneNumberId: env.phoneNumberId };
}

/**
 * Resolve the org + credentials for an inbound webhook. Single-tenant: always
 * the env credentials + the default org, read strictly (a read error throws,
 * never the seed org).
 */
export async function resolveWhatsAppContext(client: SupabaseClient): Promise<WhatsAppContext> {
    return { ...envCreds(), orgId: await getDefaultOrgIdStrict(client) };
}

/**
 * Send credentials for outbound replies. Single-tenant: always the env creds.
 */
export async function getWhatsAppSendCreds(): Promise<WhatsAppSendCreds> {
    const env = envCreds();
    return { phoneNumberId: env.phoneNumberId, accessToken: env.accessToken };
}
