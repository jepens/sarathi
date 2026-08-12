import { getPortalConfig } from './config';
import type { PortalClient, HandoffRequestBody, HandoffResponse } from './types';

// Server-side fetch wrappers for the Portal intake endpoints. Mirrors the shape
// of lib/whatsapp/client.ts (outbound HTTP + bearer auth). NEVER import this
// from a client component — it reads the shared PORTAL_INTAKE_TOKEN.

const TIMEOUT_MS = 15_000;

/** Thrown for any Portal-side failure; `status` is the upstream HTTP status. */
export class PortalError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'PortalError';
        this.status = status;
    }
}

const NOT_CONFIGURED =
    'Portal belum dikonfigurasi (set PORTAL_BASE_URL & PORTAL_INTAKE_TOKEN).';

// Mirrors zod's z.uuid() (versions 1–8, variant 8–b). The handoff input schema
// requires a uuid clientId and the DB column is `uuid`, so a non-UUID client the
// Portal might return could never be handed off — filter it out of the picker.
const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
        // AbortSignal.timeout keeps the deadline bound to the whole exchange —
        // headers AND the body stream. A manual clearTimeout() in a finally used
        // to cancel the timer the instant fetch() resolved (headers received),
        // leaving the later res.json() body read with no timeout at all.
        return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    } catch (err) {
        // AbortSignal.timeout aborts with a DOMException named 'TimeoutError';
        // a caller-supplied AbortController (none today) would surface 'AbortError'.
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            throw new PortalError('Portal tidak merespons (timeout).');
        }
        throw new PortalError(
            `Tidak bisa menghubungi Portal: ${err instanceof Error ? err.message : 'unknown'}`
        );
    }
}

// Read a JSON body under the same timeout signal as the request. A stalled body
// (headers arrived, stream never finishes) trips AbortSignal.timeout and surfaces
// as a clean timeout PortalError instead of hanging; a non-JSON / genuine parse
// error yields null so callers fall back to their "incomplete response" handling.
async function readJson(res: Response): Promise<unknown> {
    try {
        return await res.json();
    } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            throw new PortalError('Portal tidak merespons (timeout).');
        }
        return null;
    }
}

// Pull a human-useful message out of a non-OK Portal response without leaking
// internals. Prefers a JSON { error | message }. A 404 (or any non-JSON / HTML
// body) usually means the Portal intake endpoint isn't deployed yet — give a
// clear hint instead of dumping a page of HTML into a toast.
async function errorMessage(res: Response, fallback: string): Promise<string> {
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
        try {
            const body = await res.json();
            const msg =
                (body && typeof body === 'object' && (body.error ?? body.message)) || null;
            if (typeof msg === 'string' && msg.trim()) return `${fallback}: ${msg.trim()}`;
        } catch {
            /* fall through to status-based message */
        }
    } else if (res.status === 404) {
        return `${fallback}: endpoint Portal belum tersedia (404) — pastikan /api/intake/* sudah dideploy.`;
    }
    return `${fallback} (HTTP ${res.status}).`;
}

/**
 * Live-search Portal clients (Organizations) for the picker.
 * GET {PORTAL}/api/intake/clients?q=… → [{ id, name }] (or { clients: [...] }).
 */
export async function searchPortalClients(q: string): Promise<PortalClient[]> {
    const cfg = getPortalConfig();
    if (!cfg) throw new PortalError(NOT_CONFIGURED);

    const url = new URL(`${cfg.baseUrl}/api/intake/clients`);
    url.searchParams.set('q', q);

    const res = await fetchWithTimeout(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new PortalError(await errorMessage(res, 'Gagal mencari klien Portal'), res.status);

    const data = await readJson(res);
    const arr: unknown[] = Array.isArray(data)
        ? data
        : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).clients)
            ? ((data as Record<string, unknown>).clients as unknown[])
            : [];

    return arr
        .map((row): PortalClient | null => {
            if (!row || typeof row !== 'object') return null;
            const r = row as Record<string, unknown>;
            const id = typeof r.id === 'string' && UUID_RE.test(r.id) ? r.id : null;
            const name = typeof r.name === 'string' ? r.name : null;
            return id && name ? { id, name } : null;
        })
        .filter((c): c is PortalClient => c !== null);
}

/**
 * Create-or-link the client and a DRAFT proposal in one call.
 * POST {PORTAL}/api/intake/handoff → { clientId, proposalId, proposalUrl }.
 */
export async function postHandoff(body: HandoffRequestBody): Promise<HandoffResponse> {
    const cfg = getPortalConfig();
    if (!cfg) throw new PortalError(NOT_CONFIGURED);

    const res = await fetchWithTimeout(`${cfg.baseUrl}/api/intake/handoff`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${cfg.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new PortalError(await errorMessage(res, 'Gagal membuat proposal di Portal'), res.status);

    const data = await readJson(res);
    const clientId = data && typeof data === 'object' ? (data as Record<string, unknown>).clientId : null;
    const proposalId = data && typeof data === 'object' ? (data as Record<string, unknown>).proposalId : null;
    const proposalUrl = data && typeof data === 'object' ? (data as Record<string, unknown>).proposalUrl : null;

    if (typeof clientId !== 'string' || typeof proposalId !== 'string' || typeof proposalUrl !== 'string') {
        throw new PortalError('Respons Portal tidak lengkap (clientId/proposalId/proposalUrl).');
    }
    return { clientId, proposalId, proposalUrl };
}
