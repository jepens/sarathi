// Resolve the app's PUBLIC origin (scheme + host), surviving a reverse proxy.
//
// Behind Easypanel/Traefik the Next.js app is served on an internal address, so
// the Host header (and thus `request.url` / `request.nextUrl`) the app sees can
// be `localhost:80` rather than the public domain. Building redirects or
// copy-paste URLs from that yields broken links — e.g. an email confirmation
// bouncing to `localhost:80`, or the onboarding checklist showing a localhost
// webhook URL. Resolve the public origin deterministically instead:
//   1. NEXT_PUBLIC_APP_URL          — explicit; set this for certainty
//   2. X-Forwarded-Host (+ -Proto)  — set by the proxy
//   3. Host header                  — last resort (may be the internal host)
//
// Returns '' when nothing usable is found so callers can apply their own fallback.
export function resolvePublicOrigin(headers: Headers): string {
    const envUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
    if (envUrl) return envUrl;

    const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const host = forwarded || headers.get('host')?.trim();
    if (!host) return '';

    const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    return `${proto}://${host}`;
}
