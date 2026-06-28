// Portal handoff configuration (Phase 2 — Sarathi → Portal forward cable).
//
// SERVER-SIDE ONLY. PORTAL_INTAKE_TOKEN is a shared secret with the Portal app
// and must NEVER reach the client bundle — only read it from route handlers /
// server actions. Do not prefix these with NEXT_PUBLIC.

export interface PortalConfig {
    /** Portal base URL, trailing slashes stripped (e.g. https://portal.sailendra.co.id). */
    baseUrl: string;
    /** Shared bearer token for the Portal intake endpoints. */
    token: string;
}

/**
 * Resolve the Portal config from env, or null when not fully configured. A null
 * result means the handoff feature is disabled (button shown but inert) — we
 * never fall back to a partial config that would produce a broken request.
 */
export function getPortalConfig(): PortalConfig | null {
    const baseUrl = process.env.PORTAL_BASE_URL?.trim().replace(/\/+$/, '');
    const token = process.env.PORTAL_INTAKE_TOKEN?.trim();
    if (!baseUrl || !token) return null;
    return { baseUrl, token };
}

/** Cheap boolean for gating UI / endpoints without exposing the secret. */
export function isPortalConfigured(): boolean {
    return getPortalConfig() !== null;
}
