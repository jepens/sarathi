import { getWhatsAppAccessToken, getWhatsAppPhoneNumberId } from '@/lib/settings/app-settings';

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0';

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

function makeWhatsAppApiError(payload: unknown, httpStatus: number): WhatsAppApiError {
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

export async function sendWhatsAppMessage(to: string, text: string) {
    const phoneNumberId = await getWhatsAppPhoneNumberId();
    const accessToken = await getWhatsAppAccessToken();

    if (!phoneNumberId || !accessToken) {
        throw new Error('WhatsApp not configured. Please configure in /dashboard/settings');
    }

    const response = await fetch(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: to,
            text: { body: text },
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

    return await response.json();
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
        default:
            return err.message;
    }
}
