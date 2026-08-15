// Zoom Server-to-Server OAuth client — creates a scheduled meeting from the
// backend with no user interaction. Used by the AI schedule_meeting tool to
// auto-provision a join link. Entirely OPTIONAL: getZoomConfig() returns null
// when the ZOOM_* env vars are unset, and the caller falls back to a manual
// "pending-link" placeholder.
//
// Docs (via context7 /websites/developers_zoom_us):
//   token : POST https://zoom.us/oauth/token?grant_type=account_credentials&account_id=…
//           Authorization: Basic base64(clientId:clientSecret)   (1h TTL, no refresh)
//   create: POST https://api.zoom.us/v2/users/{hostUser}/meetings  (scope meeting:write:admin)

interface ZoomConfig {
    accountId: string;
    clientId: string;
    clientSecret: string;
    hostUser: string;
}

export function getZoomConfig(): ZoomConfig | null {
    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;
    if (!accountId || !clientId || !clientSecret) return null;
    return {
        accountId,
        clientId,
        clientSecret,
        hostUser: process.env.ZOOM_HOST_USER || 'me',
    };
}

export interface ZoomMeeting {
    joinUrl: string;
    meetingId: string;
    password: string | null;
    startUrl: string | null;
}

// Cache the account access token in module scope (1h TTL). A single Next.js
// server instance reuses it across bookings; we refresh 60s before expiry.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(cfg: ZoomConfig): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
        return cachedToken.token;
    }
    const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(cfg.accountId)}`;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Zoom token request failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('Zoom token response had no access_token');
    cachedToken = {
        token: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
    };
    return cachedToken.token;
}

// Convert a Date to Zoom's GMT start_time format "YYYY-MM-DDTHH:mm:ssZ".
function toZoomGmt(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function createZoomMeeting(input: {
    topic: string;
    start: Date;
    durationMin: number;
    timezone?: string;
    agenda?: string | null;
}): Promise<ZoomMeeting> {
    const cfg = getZoomConfig();
    if (!cfg) throw new Error('Zoom is not configured');

    const token = await getAccessToken(cfg);
    const res = await fetch(
        `https://api.zoom.us/v2/users/${encodeURIComponent(cfg.hostUser)}/meetings`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                topic: input.topic.slice(0, 200), // Zoom caps topic length
                type: 2, // scheduled meeting
                start_time: toZoomGmt(input.start),
                duration: input.durationMin,
                timezone: input.timezone ?? 'Asia/Jakarta',
                agenda: (input.agenda ?? '').slice(0, 2000) || undefined,
                settings: {
                    join_before_host: true, // customer/sales can enter without waiting for host
                    waiting_room: false,
                    mute_upon_entry: true,
                    host_video: false,
                    participant_video: false,
                    approval_type: 2, // no registration required
                },
            }),
            signal: AbortSignal.timeout(10_000),
        },
    );

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Zoom create-meeting failed (${res.status}): ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
        id?: number | string;
        join_url?: string;
        password?: string;
        start_url?: string;
    };
    if (!json.join_url) throw new Error('Zoom create-meeting returned no join_url');

    return {
        joinUrl: json.join_url,
        meetingId: json.id != null ? String(json.id) : '',
        password: json.password ?? null,
        startUrl: json.start_url ?? null,
    };
}
