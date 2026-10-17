// The Meta Graph API version every WhatsApp Cloud API call uses (tracker 2.7,
// audit KUA-16), in one place. v21.0 stops working on 2027-01-21; v25.0 is
// supported until 2028-07-29
// (https://developers.facebook.com/docs/graph-api/changelog/versions).
// The webhook payloads Meta sends do not follow this constant (Meta does not
// document which version they follow); the webhook reads no field that
// changed between v21.0 and v25.0.

export const GRAPH_API_VERSION = 'v25.0';

const GRAPH_ORIGIN = 'https://graph.facebook.com';

/** The Graph API URL of `path`, e.g. graphUrl(`${phoneNumberId}/messages`). */
export function graphUrl(path: string): string {
    return `${GRAPH_ORIGIN}/${GRAPH_API_VERSION}/${path.replace(/^\/+/, '')}`;
}
