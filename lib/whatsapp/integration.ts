import { requireOrgContext, type OrgContext } from '@/lib/settings/org-context';
import {
    INTEGRATION_NOT_CONFIGURED_MESSAGE,
    WHATSAPP_SETTINGS_UNAVAILABLE_MESSAGE,
    type OrgAccessDenied,
} from '@/lib/settings/org-access';
import { getOrgWhatsAppCreds, WhatsAppNotConfiguredError, type WaCreds } from '@/lib/whatsapp/credentials';

// The gate of every dashboard route that calls the WhatsApp Cloud API (Fase 2
// task 2.2b; it replaces requireEnvIntegration('whatsapp')): the caller's org
// context, checked strictly like every route with an external side effect,
// plus the credentials of that org's number, resolved before the body is read
// and before Meta is called. An org without a number of its own gets 403 and
// can never send from another org's number.

export type WhatsAppAccess = ({ ok: true; creds: WaCreds } & OrgContext) | OrgAccessDenied;

/**
 * Gate: a verified session (Auth-server round trip), an org membership, and
 * that org's WhatsApp credentials. 401/403/500/503 from requireOrgContext;
 * 403 when the org has no WhatsApp number; 503 when its credentials cannot be
 * read right now. Call it FIRST, like requireOrgContext().
 */
export async function requireWhatsAppIntegration(): Promise<WhatsAppAccess> {
    const access = await requireOrgContext({ strict: true });
    if (!access.ok) return access;
    try {
        return { ...access, creds: await getOrgWhatsAppCreds(access.orgId) };
    } catch (error) {
        if (error instanceof WhatsAppNotConfiguredError) {
            return { ok: false, status: 403, error: INTEGRATION_NOT_CONFIGURED_MESSAGE.whatsapp };
        }
        console.error('WhatsApp credentials could not be read', error);
        return { ok: false, status: 503, error: WHATSAPP_SETTINGS_UNAVAILABLE_MESSAGE };
    }
}
