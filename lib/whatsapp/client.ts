import { assertCanSend, type WaCreds } from './wa-creds';
import { toWhatsAppText } from './format';
import { buildRecipient } from './recipient';
import { graphUrl } from './graph';

// Subset of the Meta error shape — we only project the fields we care about
// up to the caller. Full payload still gets logged for diagnostics.
export interface WhatsAppApiError extends Error {
    code?: number;        // Meta error code (e.g. 131047 = past 24h window)
    subcode?: number;     // Meta error subcode
    title?: string;       // Short title from Meta (e.g. "Re-engagement message")
    details?: string;     // Long-form description
    fbtraceId?: string;   // Meta's trace id, useful for support
    httpStatus?: number;  // HTTP status code from Graph API
}

export function makeWhatsAppApiError(payload: unknown, httpStatus: number): WhatsAppApiError {
    // Safe-walk the Meta error shape:
    //   { error: { code, error_subcode, message, error_data: { details },
    //              error_user_title, error_user_msg, fbtrace_id } }
    const root = (payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {});
    const errObj = (root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : {});
    const errData = (errObj.error_data && typeof errObj.error_data === 'object'
        ? (errObj.error_data as Record<string, unknown>)
        : {});

    const code = typeof errObj.code === 'number' ? errObj.code : undefined;
    const subcode = typeof errObj.error_subcode === 'number' ? errObj.error_subcode : undefined;
    const title = typeof errObj.error_user_title === 'string'
        ? errObj.error_user_title
        : typeof errObj.message === 'string'
            ? errObj.message
            : undefined;
    const details = typeof errObj.error_user_msg === 'string'
        ? errObj.error_user_msg
        : typeof errData.details === 'string'
            ? errData.details
            : typeof errObj.message === 'string'
                ? errObj.message
                : undefined;
    const fbtraceId = typeof errObj.fbtrace_id === 'string' ? errObj.fbtrace_id : undefined;

    const message = code
        ? `Meta WhatsApp ${code}${title ? ` (${title})` : ''}: ${details ?? 'unknown error'}`
        : `WhatsApp API error (HTTP ${httpStatus})`;

    const err: WhatsAppApiError = Object.assign(new Error(message), {
        code,
        subcode,
        title,
        details,
        fbtraceId,
        httpStatus,
    });
    return err;
}

export interface SendWhatsAppResult {
    waMessageId: string | null;  // Meta's `wamid.*` — null if the response shape was unexpected
    raw: unknown;                // Full Meta response for debugging
}

// Every call takes the credentials of the number it sends from (WaCreds,
// resolved per org in lib/whatsapp/credentials.ts, Fase 2 task 2.2b): there is
// no fallback to any other number.

export async function sendWhatsAppMessage(
    creds: WaCreds,
    to: string,
    text: string,
    // When set, the message is sent as a reply to this wamid — the customer's
    // WhatsApp then shows it quoted (RFC: context.message_id).
    contextMessageId?: string | null,
): Promise<SendWhatsAppResult> {
    assertCanSend(creds);

    const response = await fetch(graphUrl(`${creds.phoneNumberId}/messages`, creds.graphVersion), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${creds.accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            // `to` for a dialable phone, `recipient` for a BSUID (Meta rejects a
            // BSUID in `to`). See lib/whatsapp/recipient.ts.
            ...buildRecipient(to),
            ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
            // Explicit: Meta's current reference marks `type` required with no
            // default (Graph v25.0 bump, tracker 2.7).
            type: 'text',
            // Normalise Markdown → WhatsApp formatting so customers never see
            // stray "**bold**" / "# heading" syntax (the model leaks it even
            // with the prompt rule in place).
            text: { body: toWhatsAppText(text) },
        }),
    });

    if (!response.ok) {
        // Try to parse the Meta error payload; fall back to text if it isn't JSON.
        let errorPayload: unknown = null;
        try {
            errorPayload = await response.json();
        } catch {
            try {
                errorPayload = { error: { message: await response.text() } };
            } catch {
                errorPayload = null;
            }
        }
        console.error(
            'Error sending WhatsApp message:',
            JSON.stringify(errorPayload, null, 2)
        );
        throw makeWhatsAppApiError(errorPayload, response.status);
    }

    const raw = await response.json();
    // Meta success shape: { messaging_product, contacts: [...], messages: [{ id: 'wamid.XXX', message_status }] }
    let waMessageId: string | null = null;
    if (raw && typeof raw === 'object') {
        const messages = (raw as Record<string, unknown>).messages;
        if (Array.isArray(messages) && messages.length > 0) {
            const first = messages[0];
            if (first && typeof first === 'object') {
                const id = (first as Record<string, unknown>).id;
                if (typeof id === 'string' && id.length > 0) waMessageId = id;
            }
        }
    }
    return { waMessageId, raw };
}

// ---- Media (admin-sent photos / documents) ----

const MEDIA_LIMITS = {
    image: { mimes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024 },
    document: {
        mimes: [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain',
        ],
        maxBytes: 100 * 1024 * 1024,
    },
} as const;

/** Every MIME type classifyMedia() accepts (the chat-media bucket must allow each). */
export const OUTBOUND_MEDIA_MIMES: readonly string[] = [...MEDIA_LIMITS.image.mimes, ...MEDIA_LIMITS.document.mimes];

export type WhatsAppMediaKind = 'image' | 'document';

// Classify a MIME type into the WhatsApp message kind we support, or null when
// it's not an allowed image/document type.
export function classifyMedia(mime: string): WhatsAppMediaKind | null {
    if ((MEDIA_LIMITS.image.mimes as readonly string[]).includes(mime)) return 'image';
    if ((MEDIA_LIMITS.document.mimes as readonly string[]).includes(mime)) return 'document';
    return null;
}

export function mediaMaxBytes(kind: WhatsAppMediaKind): number {
    return MEDIA_LIMITS[kind].maxBytes;
}

// Upload a file to Meta's media endpoint → media_id (valid ~30 days). Multipart:
// do NOT set Content-Type, fetch adds the boundary from the FormData.
export async function uploadWhatsAppMedia(
    creds: WaCreds,
    file: Blob,
    filename: string,
    mimeType: string,
): Promise<string> {
    assertCanSend(creds);

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', file, filename);

    const response = await fetch(graphUrl(`${creds.phoneNumberId}/media`, creds.graphVersion), {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        body: form,
    });

    if (!response.ok) {
        let errorPayload: unknown = null;
        try { errorPayload = await response.json(); } catch { errorPayload = null; }
        console.error('Error uploading WhatsApp media:', JSON.stringify(errorPayload, null, 2));
        throw makeWhatsAppApiError(errorPayload, response.status);
    }

    const raw = await response.json();
    const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : null;
    if (typeof id !== 'string' || !id) {
        throw new Error('Meta media upload returned no media id');
    }
    return id;
}

// Send an image or document message referencing an uploaded media_id.
export async function sendWhatsAppMedia(
    creds: WaCreds,
    to: string,
    media: { kind: WhatsAppMediaKind; mediaId: string; caption?: string; filename?: string },
): Promise<SendWhatsAppResult> {
    assertCanSend(creds);

    const caption = media.caption?.trim() ? media.caption.trim() : undefined;
    const body: Record<string, unknown> = { messaging_product: 'whatsapp', ...buildRecipient(to), type: media.kind };
    if (media.kind === 'image') {
        body.image = { id: media.mediaId, ...(caption ? { caption } : {}) };
    } else {
        body.document = {
            id: media.mediaId,
            ...(caption ? { caption } : {}),
            ...(media.filename ? { filename: media.filename } : {}),
        };
    }

    const response = await fetch(graphUrl(`${creds.phoneNumberId}/messages`, creds.graphVersion), {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        let errorPayload: unknown = null;
        try { errorPayload = await response.json(); } catch { errorPayload = null; }
        console.error('Error sending WhatsApp media:', JSON.stringify(errorPayload, null, 2));
        throw makeWhatsAppApiError(errorPayload, response.status);
    }

    const raw = await response.json();
    let waMessageId: string | null = null;
    if (raw && typeof raw === 'object') {
        const messages = (raw as Record<string, unknown>).messages;
        if (Array.isArray(messages) && messages.length > 0) {
            const first = messages[0];
            if (first && typeof first === 'object') {
                const id = (first as Record<string, unknown>).id;
                if (typeof id === 'string' && id.length > 0) waMessageId = id;
            }
        }
    }
    return { waMessageId, raw };
}

// ---- Inbound media download (customer-sent photos / docs / voice / video) ----

export interface DownloadedMedia {
    bytes: Uint8Array;
    mime: string;
    size: number;
}

// Download inbound media the customer sent us. Meta's flow is two steps:
//   1. GET /{media-id}          → JSON with a short-lived lookaside `url`
//   2. GET {url}                → the raw bytes
// BOTH calls require the Bearer token (the CDN 401s without it), and the
// lookaside URL expires in ~5 minutes so we fetch it immediately. A User-Agent
// is sent because Meta's CDN occasionally 400s header-less requests.
// `creds` are the receiving number's. The lookup does not send Meta's optional
// `phone_number_id` check: Meta documents it for media "uploaded on" a number
// and does not say whether media a customer sent counts (tracker 2.2b).
export async function downloadWhatsAppMedia(creds: WaCreds, mediaId: string): Promise<DownloadedMedia> {
    assertCanSend(creds);
    const accessToken = creds.accessToken;

    // Step 1 — resolve the media id to a temporary download URL.
    const metaRes = await fetch(graphUrl(mediaId, creds.graphVersion), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaRes.ok) {
        let errorPayload: unknown = null;
        try { errorPayload = await metaRes.json(); } catch { errorPayload = null; }
        console.error('Error resolving WhatsApp media url:', JSON.stringify(errorPayload, null, 2));
        throw makeWhatsAppApiError(errorPayload, metaRes.status);
    }
    const meta = await metaRes.json();
    const metaObj = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
    const url = typeof metaObj.url === 'string' ? metaObj.url : null;
    const mimeFromMeta = typeof metaObj.mime_type === 'string' ? metaObj.mime_type : null;
    if (!url) {
        throw new Error('Meta media lookup returned no download url');
    }

    // Step 2 — fetch the bytes from the lookaside URL.
    const binRes = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            // Neutral: the same code serves every tenant.
            'User-Agent': 'Sarathi/1.0',
        },
    });
    if (!binRes.ok) {
        console.error(`Error downloading WhatsApp media bytes: HTTP ${binRes.status}`);
        throw makeWhatsAppApiError(null, binRes.status);
    }
    const bytes = new Uint8Array(await binRes.arrayBuffer());
    const mime = mimeFromMeta || binRes.headers.get('content-type') || 'application/octet-stream';
    return { bytes, mime, size: bytes.byteLength };
}

// Human-friendly hints for common Meta error codes. Returned alongside the
// raw Meta error so the dashboard UI can show a useful toast instead of
// "Internal Server Error".
export function describeWhatsAppError(err: WhatsAppApiError): string {
    if (!err.code) return err.message;
    switch (err.code) {
        case 131047:
            return 'Pesan ditolak: lebih dari 24 jam sejak pesan terakhir dari customer. Meta hanya mengizinkan template message yang sudah di-approve di luar 24-jam window. (Kode 131047)';
        case 131051:
            return 'Tipe pesan tidak didukung Meta. (Kode 131051)';
        case 131056:
            return 'Rate limit Meta tercapai untuk pasangan nomor ini — coba lagi nanti. (Kode 131056)';
        case 131026:
            return 'Nomor tujuan tidak bisa menerima pesan (mungkin belum punya WhatsApp atau diblokir). (Kode 131026)';
        case 190:
            return 'Access token Meta expired/invalid. Generate ulang di Meta Developer Dashboard → WhatsApp → API Setup. (Kode 190)';
        case 100:
            return `Parameter tidak valid: ${err.details ?? 'tidak ada detail'}. (Kode 100)`;
        // From Graph v23.0, template parameter problems at send time.
        case 132018:
            return `Parameter template ditolak Meta: ${err.details ?? 'tidak ada detail'}. Periksa jumlah dan isi variabel (tanpa baris baru atau tab, maksimal 4 spasi berturut-turut) dan tombol Flow template. (Kode 132018)`;
        default:
            return err.message;
    }
}
