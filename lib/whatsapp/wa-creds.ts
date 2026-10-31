// The credentials every WhatsApp Cloud API call takes (Fase 2 task 2.2b), with
// no dependencies, so the Graph calls (client.ts, templates.ts) need nothing
// from the resolver. Resolved per org in lib/whatsapp/credentials.ts.

/** The credentials of one WhatsApp business number, for one org. */
export interface WaCreds {
    /** The org the number belongs to: every row a send writes is this org's. */
    orgId: string;
    /** The whatsapp_integrations row; null for the env credentials (Phase 0). */
    integrationId: string | null;
    phoneNumberId: string;
    /** The WhatsApp Business Account (templates); null when not configured. */
    wabaId: string | null;
    accessToken: string;
    /** The Graph API version of this number's calls (lib/whatsapp/graph.ts). */
    graphVersion: string;
}

/**
 * The org has no WhatsApp number this server may send from: today any org
 * but the default one, or the default org while WHATSAPP_PHONE_NUMBER_ID or
 * WHATSAPP_ACCESS_TOKEN is unset. Never answered with another org's number.
 */
export class WhatsAppNotConfiguredError extends Error {
    constructor(message = 'WhatsApp is not configured for this org') {
        super(message);
        this.name = 'WhatsAppNotConfiguredError';
    }
}

/** Throws WhatsAppNotConfiguredError unless the credentials can send. */
export function assertCanSend(creds: WaCreds): void {
    if (!creds.phoneNumberId || !creds.accessToken) {
        throw new WhatsAppNotConfiguredError('WhatsApp is not configured for this org (no phone number id or access token)');
    }
}
