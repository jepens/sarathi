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

// Trimmed: a newline or tab pasted along with a value would otherwise make
// every event of the app's own number look like another number's (the Graph
// URL parser strips them, so sends would keep working and hide it) and every
// signature fail.
function envValue(name: string): string {
    return (process.env[name] ?? '').trim();
}

function envCreds(): WhatsAppSendCreds & { appSecret: string | null } {
    return {
        phoneNumberId: envValue('WHATSAPP_PHONE_NUMBER_ID'),
        accessToken: envValue('WHATSAPP_ACCESS_TOKEN'),
        appSecret: envValue('WHATSAPP_APP_SECRET') || null,
    };
}

export interface WebhookApp {
    appSecret: string | null;
    /** The one number the webhook routes; '' when not set or not a number id. */
    phoneNumberId: string;
    /** Why phoneNumberId is '' (for the alert). */
    phoneNumberIdProblem?: 'unset' | 'not_digits';
}

/**
 * The Meta app the webhook URL serves today (Fase 2 task 2.2a, phase 0: one
 * app, from env): the secret its signatures are checked with, and the one
 * number it routes (a phone number id is digits only). Needs no database, so
 * the signature is checked before anything else happens.
 */
export function envWebhookApp(): WebhookApp {
    const env = envCreds();
    if (!env.phoneNumberId) return { appSecret: env.appSecret, phoneNumberId: '', phoneNumberIdProblem: 'unset' };
    if (!/^\d+$/.test(env.phoneNumberId)) {
        return { appSecret: env.appSecret, phoneNumberId: '', phoneNumberIdProblem: 'not_digits' };
    }
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
