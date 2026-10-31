import { SupabaseClient } from '@supabase/supabase-js';
import { getDefaultOrgIdStrict } from '@/lib/settings/org-context';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { GRAPH_API_VERSION } from '@/lib/whatsapp/graph';
import { assertCanSend, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/wa-creds';

export { assertCanSend, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/wa-creds';

// WhatsApp credential resolution (Fase 2 task 2.2b). Every Cloud API call
// takes a WaCreds, resolved for one org: getOrgWhatsAppCreds() for sends the
// org starts (dashboard, queue, notifications), resolveWhatsAppContext() for
// the number a webhook delivery arrived on. Nothing else reads the WhatsApp
// credentials: this file is the Phase-0 env shim, the only reader of
// WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN / WHATSAPP_APP_SECRET /
// WHATSAPP_BUSINESS_ACCOUNT_ID (pinned by __tests__/env-shim.test.ts). The env
// credentials are the default org's (Sailendra) and serve no other org. With
// owner decision D6 (one Meta app per client) they move to Supabase Vault and
// whatsapp_integrations (2.1b/2.2c, docs/FASE2_DESIGN.md); the call sites keep
// this interface.

// Trimmed: a newline or tab pasted along with a value would otherwise make
// every event of the app's own number look like another number's (the Graph
// URL parser strips them, so sends would keep working and hide it) and every
// signature fail.
function envValue(name: string): string {
    return (process.env[name] ?? '').trim();
}

/** The env credentials of the default org's number; '' / null where unset. */
function envCreds(orgId: string): WaCreds {
    return {
        orgId,
        integrationId: null,
        phoneNumberId: envValue('WHATSAPP_PHONE_NUMBER_ID'),
        wabaId: envValue('WHATSAPP_BUSINESS_ACCOUNT_ID') || null,
        accessToken: envValue('WHATSAPP_ACCESS_TOKEN'),
        graphVersion: GRAPH_API_VERSION,
    };
}

/**
 * Whether the env number can send (a phone number id and a token are set).
 * Only the default org uses it: callers check that themselves (the settings
 * page and the onboarding checklist, which already know the default org).
 */
export function envWhatsAppSendConfigured(): boolean {
    return envValue('WHATSAPP_PHONE_NUMBER_ID') !== '' && envValue('WHATSAPP_ACCESS_TOKEN') !== '';
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
    const appSecret = envValue('WHATSAPP_APP_SECRET') || null;
    const phoneNumberId = envValue('WHATSAPP_PHONE_NUMBER_ID');
    if (!phoneNumberId) return { appSecret, phoneNumberId: '', phoneNumberIdProblem: 'unset' };
    if (!/^\d+$/.test(phoneNumberId)) return { appSecret, phoneNumberId: '', phoneNumberIdProblem: 'not_digits' };
    return { appSecret, phoneNumberId };
}

/**
 * The org and credentials of the number a webhook delivery arrived on: the
 * env number, so the default org, read strictly (a read error throws, never
 * the seed org). Unlike getOrgWhatsAppCreds it does not refuse a missing
 * token: storing a message needs none, and each send checks (assertCanSend).
 */
export async function resolveWhatsAppContext(client: SupabaseClient): Promise<WaCreds> {
    return envCreds(await getDefaultOrgIdStrict(client));
}

/**
 * The credentials an org sends with. Phase 0: the env credentials, for the
 * default org only (read strictly, with a service-role client: a read error
 * throws, never answering for the seed org). Any other org, or the default
 * org without a number or token, gets WhatsAppNotConfiguredError, so no org
 * can ever send from another org's number. Without `client` a service-role
 * client is created.
 */
export async function getOrgWhatsAppCreds(orgId: string, client?: SupabaseClient): Promise<WaCreds> {
    const supabase = client ?? (await createServiceOrServerClient());
    if (orgId !== (await getDefaultOrgIdStrict(supabase))) throw new WhatsAppNotConfiguredError();
    const creds = envCreds(orgId);
    assertCanSend(creds);
    return creds;
}
