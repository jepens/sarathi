// chat-media bucket helpers (tracker 1.11, audit KEA-4, migration 0067).
//
// Once 0067 is applied the bucket is PRIVATE: the dashboard never renders a
// Storage URL, only the same-origin /api/chat-media/<message id>
// (chatMediaHref), which answers with a short-lived signed URL created in the
// member's own session (chatMediaSignedSeconds). whatsapp_messages.media_url
// holds the bare object key "<org_id>/<safe phone>/<uuid>.<ext>" (the layout
// the contact delete of D21 relies on to find a contact's files by prefix);
// rows written before this change still hold the public URL, and
// chatMediaObjectPath() reads both.
// Pure (no I/O, client-safe), so the route, both writers and ChatWindow share it.

import { isOrgScopedObjectPath } from '@/lib/storage/object-paths';

export const CHAT_MEDIA_BUCKET = 'chat-media';

/**
 * The bucket's allowed_mime_types, in the order of migration 0067 (a vitest
 * keeps the two lists identical). WhatsApp's image / audio / video types, the
 * document types the dashboard sends (lib/whatsapp/client.ts), image/webp for
 * stickers (the webhook stores them as images) and application/octet-stream,
 * so an inbound document of any other type is kept as a plain download while
 * active types such as text/html or image/svg+xml are never stored as such.
 */
export const CHAT_MEDIA_ALLOWED_MIME: readonly string[] = Object.freeze([
    'image/jpeg',
    'image/png',
    'image/webp',
    'audio/aac',
    'audio/amr',
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'video/mp4',
    'video/3gpp',
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/octet-stream',
]);

/**
 * The bucket's file_size_limit (0067): 50 MiB, the Free plan's global cap.
 * A larger file (a WhatsApp document can be up to 100 MB) still goes to or
 * comes from the customer, but no copy is stored (owner decision D20). Raised
 * to 104857600 together with the bucket after the Pro upgrade (tracker 0.15).
 */
export const CHAT_MEDIA_MAX_BYTES = 52428800;

const OCTET_STREAM = 'application/octet-stream';

/**
 * The content type to upload an object with: the MIME's type/subtype,
 * lower-cased and without parameters ('audio/ogg; codecs=opus' → 'audio/ogg'),
 * when the bucket allows it, else application/octet-stream (served as a
 * download). Keep the original MIME in whatsapp_messages.media_mime.
 */
export function storageContentType(mime: string | null | undefined): string {
    const base = typeof mime === 'string' ? mime.split(';', 1)[0].trim().toLowerCase() : '';
    return CHAT_MEDIA_ALLOWED_MIME.includes(base) ? base : OCTET_STREAM;
}

/**
 * The phone segment of a chat-media key, as both writers build it: every
 * character outside [a-zA-Z0-9._-] becomes '_', so nothing can add a '/' or
 * '..' to the key.
 */
export function safePhoneSegment(phone: string): string {
    return phone.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * The folder that holds one contact's chat media, '<org>/<phone>', or null
 * when the phone is not a segment as it is (it had characters to replace, or
 * is '.' / '..'): two contacts could then share a folder, so only the keys
 * that contact's own messages name may be removed (owner decision D21).
 */
export function contactMediaFolder(orgId: string, phone: string): string | null {
    if (!orgId || !phone || phone === '.' || phone === '..') return null;
    return safePhoneSegment(phone) === phone ? `${orgId}/${phone}` : null;
}

/** The dashboard URL of a message's media: redirects to a short-lived signed URL. */
export function chatMediaHref(messageId: string): string {
    return '/api/chat-media/' + encodeURIComponent(messageId);
}

/**
 * How long the signed URL behind /api/chat-media lives, in seconds. A photo or
 * a document: 10 minutes (a document opens in a new tab, whose address bar
 * shows the signed URL). A voice note or a video: 1 hour, because a media
 * element follows the 302 once and then sends every later range request
 * (play, seek, buffering) straight to the signed URL, never to the route
 * again (seen in Chrome); keepStreamFresh (chat-media-player.ts) renews the
 * source before the token runs out.
 */
export const CHAT_MEDIA_SIGNED_SECONDS = 600;
export const CHAT_MEDIA_STREAM_SIGNED_SECONDS = 3600;

/** How long a browser may reuse the route's 302 (its Cache-Control max-age). */
export const CHAT_MEDIA_REDIRECT_MAX_AGE = 300;

/** The signed URL lifetime for a whatsapp_messages.media_type. */
export function chatMediaSignedSeconds(mediaType: string | null | undefined): number {
    return mediaType === 'audio' || mediaType === 'video' ? CHAT_MEDIA_STREAM_SIGNED_SECONDS : CHAT_MEDIA_SIGNED_SECONDS;
}

/**
 * How long after its metadata arrived a voice note's or a video's source may
 * still be played or seeked without a renewal: its signed URL can already be
 * CHAT_MEDIA_REDIRECT_MAX_AGE old (a cached 302), and playback that starts at
 * the end of this window keeps 10 minutes before the token expires. 45 min.
 */
export const CHAT_MEDIA_STREAM_FRESH_MS =
    (CHAT_MEDIA_STREAM_SIGNED_SECONDS - CHAT_MEDIA_REDIRECT_MAX_AGE - 600) * 1000;

// The two Storage URL forms media_url can hold: the public object URL
// (getPublicUrl, written before 1.11) and a signed URL. The query string
// (?token=...) is cut off before this is applied.
const STORAGE_OBJECT_URL = /^https?:\/\/[^/?#]+\/storage\/v1\/object\/(?:public|sign)\/chat-media\/(.+)$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// The writers' character set for every segment after the org folder
// (safePhoneSegment, "<uuid>.<ext>"). storage-js puts the key into the
// request path unencoded, so a '%', '?', '#' or space left after the single
// decode would be read again on the way to Storage and could name another
// object than the one checked here.
const KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The chat-media object key behind a stored media_url, or null.
 *
 * Accepts the public URL ('…/storage/v1/object/public/chat-media/<key>'), a
 * signed URL ('…/storage/v1/object/sign/chat-media/<key>?token=…') or a bare
 * key ('<org>/…'). The query string is dropped and percent-encoding decoded
 * exactly once (getPublicUrl encodes the key once with encodeURI). The key
 * must then lie inside `orgId`'s folder (isOrgScopedObjectPath), and every
 * later segment must use the writers' character set [A-Za-z0-9._-]: another
 * org's key, '..' / '.' / empty segments, any other character, another
 * bucket, any other URL and empty input all give null. The storage policy
 * re-checks the org folder when the key is signed with the member's session.
 */
export function chatMediaObjectPath(stored: string | null | undefined, orgId: string): string | null {
    if (typeof stored !== 'string' || stored === '' || !orgId) return null;
    const withoutQuery = stored.split(/[?#]/, 1)[0];
    let encoded = withoutQuery;
    if (HAS_SCHEME.test(withoutQuery)) {
        const match = STORAGE_OBJECT_URL.exec(withoutQuery);
        if (!match) return null;
        encoded = match[1];
    }
    let path: string;
    try {
        path = decodeURIComponent(encoded);
    } catch {
        return null; // malformed percent-encoding
    }
    if (!isOrgScopedObjectPath(path, orgId)) return null;
    return path.split('/').slice(1).every((segment) => KEY_SEGMENT.test(segment)) ? path : null;
}
