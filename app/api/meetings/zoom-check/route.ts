import { NextResponse } from 'next/server';
import { accessDeniedResponse, requireEnvIntegration } from '@/lib/settings/org-context';

// Admin diagnostic for the Zoom Server-to-Server OAuth integration that the
// schedule_meeting tool uses to auto-provision a join link. When a booking
// stays 'pending-link', this endpoint tells you WHY without opening container
// logs: which ZOOM_* vars are present, whether an access token can be minted,
// and (with ?create=1) whether a meeting can actually be created for
// ZOOM_HOST_USER. Gated to members of the default org (the Zoom account in env
// is Sailendra's) — checked before any Zoom call. Treat as admin-only.
//
// SECRET SAFETY: never returns secret VALUES — only presence booleans, the
// account id's last 4, the (non-secret) host user, and capped error snippets.
// The token fetch is done DIRECTLY here (not via lib/zoom's cached
// getAccessToken) so a stale cached token can't mask broken/rotated creds and
// this probe can't poison the real booking path's cache.

export const dynamic = 'force-dynamic';

type TokenResult = {
    attempted: boolean;
    ok: boolean;
    httpStatus: number;
    errorCode: string | null;
    errorSnippet: string | null;
};

type CreateResult =
    | { attempted: false }
    | {
          attempted: true;
          ok: boolean;
          httpStatus: number;
          errorCode: number | string | null;
          errorSnippet: string | null;
          cleanedUp: boolean;
      };

function safeJson(s: string): Record<string, unknown> | null {
    try {
        return JSON.parse(s) as Record<string, unknown>;
    } catch {
        return null;
    }
}

// GMT "YYYY-MM-DDTHH:mm:ssZ" — Zoom's start_time format.
function toZoomGmt(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function GET(request: Request) {
    const gate = await requireEnvIntegration('zoom');
    if (!gate.ok) return accessDeniedResponse(gate);

    const doCreate = new URL(request.url).searchParams.get('create') === '1';

    // Trim so a stray space/newline pasted in EasyPanel fails loudly at the
    // token step instead of silently looking "configured".
    const acct = (process.env.ZOOM_ACCOUNT_ID ?? '').trim();
    const cid = (process.env.ZOOM_CLIENT_ID ?? '').trim();
    const sec = (process.env.ZOOM_CLIENT_SECRET ?? '').trim();
    const host = (process.env.ZOOM_HOST_USER || 'me').trim();

    const config = {
        ZOOM_ACCOUNT_ID: { present: !!acct, last4: acct ? acct.slice(-4) : null },
        ZOOM_CLIENT_ID: { present: !!cid },
        ZOOM_CLIENT_SECRET: { present: !!sec },
        ZOOM_HOST_USER: { present: !!process.env.ZOOM_HOST_USER, value: host },
        configComplete: !!(acct && cid && sec),
    };

    const checkedAt = new Date().toISOString();

    if (!config.configComplete) {
        return NextResponse.json({
            config,
            token: { attempted: false },
            createMeeting: { attempted: false },
            diagnosis:
                'ZOOM_* vars belum lengkap di service ini → getZoomConfig() null → booking diam-diam tetap pending-link. Isi ZOOM_ACCOUNT_ID/CLIENT_ID/CLIENT_SECRET di EasyPanel lalu redeploy/restart.',
            checkedAt,
        });
    }

    // --- Live token fetch (direct; bypasses the module cache) ---
    const token: TokenResult = {
        attempted: true,
        ok: false,
        httpStatus: 0,
        errorCode: null,
        errorSnippet: null,
    };
    let access: string | null = null;
    try {
        const basic = Buffer.from(`${cid}:${sec}`).toString('base64');
        const r = await fetch(
            `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(acct)}`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${basic}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                signal: AbortSignal.timeout(10_000),
            },
        );
        token.httpStatus = r.status;
        const body = await r.text();
        if (r.ok) {
            access = (safeJson(body)?.access_token as string | undefined) ?? null;
            token.ok = !!access;
        } else {
            token.errorCode = (safeJson(body)?.error as string | undefined) ?? null;
            token.errorSnippet = body.slice(0, 300);
        }
    } catch (e) {
        token.errorSnippet = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }

    // --- Optional create-then-delete dry run (?create=1) ---
    let createMeeting: CreateResult = { attempted: false };
    if (doCreate && access) {
        const cm = {
            attempted: true as const,
            ok: false,
            httpStatus: 0,
            errorCode: null as number | string | null,
            errorSnippet: null as string | null,
            cleanedUp: false,
        };
        try {
            const start = toZoomGmt(new Date(Date.now() + 86_400_000)); // tomorrow
            const r = await fetch(
                `https://api.zoom.us/v2/users/${encodeURIComponent(host)}/meetings`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${access}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        topic: '[diagnostic] zoom-check — safe to delete',
                        type: 2,
                        duration: 5,
                        start_time: start,
                        timezone: 'Asia/Jakarta',
                    }),
                    signal: AbortSignal.timeout(10_000),
                },
            );
            cm.httpStatus = r.status;
            const body = await r.text();
            if (r.ok) {
                cm.ok = true;
                const id = safeJson(body)?.id;
                if (id != null) {
                    // Clean up immediately — never leave the probe meeting behind.
                    const d = await fetch(
                        `https://api.zoom.us/v2/meetings/${encodeURIComponent(String(id))}`,
                        {
                            method: 'DELETE',
                            headers: { Authorization: `Bearer ${access}` },
                            signal: AbortSignal.timeout(10_000),
                        },
                    );
                    cm.cleanedUp = d.status === 204;
                }
            } else {
                cm.errorCode = (safeJson(body)?.code as number | string | undefined) ?? null;
                cm.errorSnippet = body.slice(0, 300);
            }
        } catch (e) {
            cm.errorSnippet = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        }
        createMeeting = cm;
    }

    return NextResponse.json({
        config,
        token,
        createMeeting,
        diagnosis: deriveHint(token, createMeeting, doCreate),
        checkedAt,
    });
}

// Human-readable next step (Bahasa Indonesia) derived from the probe results.
function deriveHint(token: TokenResult, createMeeting: CreateResult, doCreate: boolean): string {
    if (!token.ok) {
        if (token.httpStatus === 401 || token.errorCode === 'invalid_client') {
            return 'Token 401 invalid_client → ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET salah atau ada spasi/kutip. Salin ulang dari App Credentials.';
        }
        if (token.errorCode === 'invalid_grant' || token.errorCode === 'unsupported_grant_type') {
            return 'Token ditolak → app bukan tipe Server-to-Server OAuth / belum Activated, atau ZOOM_ACCOUNT_ID salah.';
        }
        return `Token gagal (HTTP ${token.httpStatus}) → periksa ZOOM_ACCOUNT_ID / CLIENT_ID / CLIENT_SECRET.`;
    }
    if (createMeeting.attempted) {
        if (createMeeting.ok) {
            return `Zoom OK — token & create-meeting berhasil. Integrasi siap; booking baru otomatis dapat link.${createMeeting.cleanedUp ? '' : ' (Catatan: meeting uji gagal dihapus — hapus manual di Zoom.)'}`;
        }
        if (createMeeting.errorCode === 4711) {
            return 'Create ditolak 4711 → scope meeting:write:admin belum ada. Tambah scope di app Zoom lalu Re-activate.';
        }
        if (createMeeting.errorCode === 1001 || createMeeting.errorCode === 1120) {
            return 'Create ditolak 1001/1120 → ZOOM_HOST_USER bukan user valid di akun ini. Set "me" atau email user berlisensi.';
        }
        return `Create gagal (HTTP ${createMeeting.httpStatus}, code ${createMeeting.errorCode ?? '?'}) → cek scope meeting:write:admin & ZOOM_HOST_USER.`;
    }
    return doCreate
        ? 'Token OK tapi create tidak dijalankan (token akses tidak diperoleh).'
        : 'Token OK — kredensial & aktivasi app benar. Jalankan ulang dengan ?create=1 untuk menguji scope + host user (membuat lalu menghapus 1 meeting uji).';
}
