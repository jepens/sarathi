import { SupabaseClient } from '@supabase/supabase-js';
import { GRAPH_API_VERSION } from '@/lib/whatsapp/graph';
import { assertCanSend, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/wa-creds';
import { RpcError } from '@/lib/whatsapp/webhook/errors';
import { serviceRoleClient } from '@/lib/whatsapp/webhook/service-client';

export { assertCanSend, canSend, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/wa-creds';

// WhatsApp credential resolution (Fase 2 tasks 2.2b-2.2d). Every Cloud API
// call takes a WaCreds, resolved for one org from Supabase Vault (migration
// 0073, owner decision D6: one Meta app per client): getOrgWhatsAppCreds() for
// the sends an org starts (dashboard, queue, notifications), vaultWebhookApp()
// and vaultOrgCreds() for the per-app webhook URL. No app file reads WhatsApp
// credentials from env (pinned by __tests__/env-shim.test.ts).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the webhook routes a delivery with: the signing app's secret and its one number. */
export interface WebhookApp {
    appSecret: string | null;
    phoneNumberId: string;
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
 * Not cached; a read error throws RpcError. Called by the webhook and by
 * getOrgWhatsAppCreds only (pinned by __tests__/env-shim.test.ts): the caller
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
 * The credentials an org sends with, from Vault. An org without a number, a
 * paused number, a suspended app or no usable token (canSend) gets
 * WhatsAppNotConfiguredError, so no org can ever send from another org's
 * number; an orgId that is not a UUID gets it without a read. A read error
 * (RpcError, or no service-role client) is thrown as it is: retryable, never
 * "not configured". Without `client` a service-role client is created
 * (wa_org_send_credentials is the service role's only).
 */
export async function getOrgWhatsAppCreds(orgId: string, client?: SupabaseClient): Promise<WaCreds> {
    if (!UUID_RE.test(orgId)) throw new WhatsAppNotConfiguredError();
    const supabase = client ?? serviceRoleClient();
    if (!supabase) {
        throw new Error('WhatsApp credentials cannot be read: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
    }
    const number = await vaultOrgCreds(supabase, orgId);
    if (!number || number.status !== 'active' || number.appStatus !== 'active') throw new WhatsAppNotConfiguredError();
    assertCanSend(number.creds);
    return number.creds;
}

/**
 * Whether the org's number is active (Settings, onboarding). Reads
 * whatsapp_integrations.status only (one row per org, service role only), no
 * secret; a read error counts as not connected.
 */
export async function orgWhatsAppConnected(orgId: string): Promise<boolean> {
    if (!UUID_RE.test(orgId)) return false;
    const supabase = serviceRoleClient();
    if (!supabase) return false;
    try {
        const { data, error } = await supabase.from('whatsapp_integrations').select('status').eq('org_id', orgId).maybeSingle();
        return !error && data?.status === 'active';
    } catch {
        return false;
    }
}
