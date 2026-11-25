import { SupabaseClient } from '@supabase/supabase-js';
import { getDefaultOrgIdStrict } from '@/lib/settings/org-context';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { GRAPH_API_VERSION } from '@/lib/whatsapp/graph';
import { assertCanSend, canSend, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/wa-creds';
import { RpcError } from '@/lib/whatsapp/webhook/errors';

export { assertCanSend, canSend, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/wa-creds';

// WhatsApp credential resolution (Fase 2 task 2.2b). Every Cloud API call
// takes a WaCreds, resolved for one org: getOrgWhatsAppCreds() for sends the
// org starts (dashboard, queue, notifications), resolveWhatsAppContext() for
// the number a webhook delivery arrived on. Nothing else in the app reads the
// WhatsApp credentials: in Phase 0 this resolver is an env shim, the only app
// file that reads WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN /
// WHATSAPP_APP_SECRET / WHATSAPP_BUSINESS_ACCOUNT_ID (pinned by
// __tests__/env-shim.test.ts). The env credentials are the default org's
// (Sailendra) and serve no other org. With owner decision D6 (one Meta app per
// client) they move to Supabase Vault and whatsapp_integrations (2.1b/2.2c,
// docs/FASE2_DESIGN.md): this module stays, its env branch goes, and the call
// sites keep this interface. The per-app webhook URL (2.2c) already reads
// Vault (vaultWebhookApp, vaultOrgCreds); sends move in 2.2d.

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
 * Whether the env number can send (a phone number id and a usable token).
 * Only the default org uses it: callers check that themselves (the settings
 * page and the onboarding checklist, which already know the default org).
 */
export function envWhatsAppSendConfigured(): boolean {
    return canSend({ phoneNumberId: envValue('WHATSAPP_PHONE_NUMBER_ID'), accessToken: envValue('WHATSAPP_ACCESS_TOKEN') });
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
 * the signature is checked before anything else happens. For the webhook only
 * (pinned like resolveWhatsAppContext).
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
 * For the webhook only (lib/whatsapp/webhook/pipeline.ts, pinned by
 * __tests__/env-shim.test.ts): every other path resolves its org's credentials
 * with getOrgWhatsAppCreds.
 */
export async function resolveWhatsAppContext(client: SupabaseClient): Promise<WaCreds> {
    return envCreds(await getDefaultOrgIdStrict(client));
}

/** A client Meta app behind a per-app webhook URL (wa_webhook_app, migration 0073). */
export interface VaultWebhookApp {
    appId: string;
    orgId: string;
    /** 'active' or 'suspended'. */
    status: string;
    /** null when Vault could not decrypt it: no signature can be verified. */
    appSecret: string | null;
    /** sha256 of the verify token, hex. */
    verifyTokenSha256: string;
}

/**
 * The app whose webhook URL carries `key`, with its secret from Vault; null
 * for an unknown key. Not cached: a rotated secret is used at once. A read
 * error throws RpcError (code and HTTP status only). For the webhook only
 * (pinned by __tests__/env-shim.test.ts): the caller checks the status.
 */
export async function vaultWebhookApp(supabase: SupabaseClient, key: string): Promise<VaultWebhookApp | null> {
    const { data, error, status } = await supabase.rpc('wa_webhook_app', { p_key: key });
    if (error) throw new RpcError('wa_webhook_app', error, status);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    return {
        appId: row.app_id,
        orgId: row.org_id,
        status: row.status,
        appSecret: typeof row.app_secret === 'string' && row.app_secret !== '' ? row.app_secret : null,
        verifyTokenSha256: row.verify_token_sha256,
    };
}

/** An org's number and its app's token from Vault (wa_org_send_credentials, migration 0073). */
export interface VaultOrgCreds {
    /** accessToken is '' when Vault could not decrypt it (canSend refuses it). */
    creds: WaCreds;
    /** The number's status: 'active' or 'paused'. */
    status: string;
    /** Its app's status: 'active' or 'suspended'. */
    appStatus: string;
}

/**
 * The org's number and token from Vault; null when the org has no number.
 * Not cached; a read error throws RpcError. For the webhook only (pinned by
 * __tests__/env-shim.test.ts) until sends move to Vault (2.2d): the caller
 * checks both statuses.
 */
export async function vaultOrgCreds(supabase: SupabaseClient, orgId: string): Promise<VaultOrgCreds | null> {
    const { data, error, status } = await supabase.rpc('wa_org_send_credentials', { p_org: orgId });
    if (error) throw new RpcError('wa_org_send_credentials', error, status);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    return {
        creds: {
            orgId,
            integrationId: row.integration_id,
            phoneNumberId: row.phone_number_id,
            wabaId: row.waba_id,
            accessToken: row.access_token ?? '',
            graphVersion: GRAPH_API_VERSION,
        },
        status: row.status,
        appStatus: row.app_status,
    };
}

/**
 * The credentials an org sends with. Phase 0: the env credentials, for the
 * default org only (read strictly, with a service-role client: a read error
 * throws, never answering for the seed org). Any other org, or the default
 * org without a number or a usable token (canSend), gets
 * WhatsAppNotConfiguredError, so no org can ever send from another org's
 * number. Without `client` a service-role client is created.
 */
export async function getOrgWhatsAppCreds(orgId: string, client?: SupabaseClient): Promise<WaCreds> {
    const supabase = client ?? (await createServiceOrServerClient());
    if (orgId !== (await getDefaultOrgIdStrict(supabase))) throw new WhatsAppNotConfiguredError();
    const creds = envCreds(orgId);
    assertCanSend(creds);
    return creds;
}
