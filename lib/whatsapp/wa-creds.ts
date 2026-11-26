// The credentials every WhatsApp Cloud API call takes (Fase 2 task 2.2b), with
// no dependencies, so the Graph calls (client.ts, templates.ts) need nothing
// from the resolver. Resolved per org from Vault in lib/whatsapp/credentials.ts.

/** The credentials of one WhatsApp business number, for one org. */
export interface WaCreds {
    /** The org the number belongs to: every row a send writes is this org's. */
    orgId: string;
    /** The whatsapp_integrations row the credentials were read from. */
    integrationId: string | null;
    phoneNumberId: string;
    /** The WhatsApp Business Account (templates); null when not configured. */
    wabaId: string | null;
    accessToken: string;
    /** The Graph API version of this number's calls (lib/whatsapp/graph.ts). */
    graphVersion: string;
}

/**
 * The org has no WhatsApp number this server may send from: no number row
 * in Vault, a paused number, a suspended app, or no usable access token
 * (canSend). Never answered with another org's number.
 */
export class WhatsAppNotConfiguredError extends Error {
    constructor(message = 'WhatsApp is not configured for this org') {
        super(message);
        this.name = 'WhatsAppNotConfiguredError';
    }
}

// A usable token is visible ASCII without spaces. One with a line break or
// another control character inside (a value pasted badly) would make fetch
// throw an error that quotes the whole Authorization header, and that message
// reaches responses, queue rows and logs: such a token is not usable.
const USABLE_TOKEN = /^[\x21-\x7e]+$/;

/**
 * Whether the credentials can call the Cloud API: a number id and a usable
 * token. Checks the types too: credentials built from an untyped database row
 * (2.2c) must not pass with a missing value (RegExp.test(undefined) is true).
 */
export function canSend(creds: Pick<WaCreds, 'phoneNumberId' | 'accessToken'>): boolean {
    return (
        typeof creds.phoneNumberId === 'string' &&
        creds.phoneNumberId !== '' &&
        typeof creds.accessToken === 'string' &&
        USABLE_TOKEN.test(creds.accessToken)
    );
}

/** Throws WhatsAppNotConfiguredError unless the credentials can send (canSend). */
export function assertCanSend(creds: WaCreds): void {
    if (!canSend(creds)) {
        throw new WhatsAppNotConfiguredError('WhatsApp is not configured for this org (no phone number id or no usable access token)');
    }
}
