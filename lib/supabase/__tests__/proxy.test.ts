import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthApiError, AuthInvalidJwtError, AuthRetryableFetchError, AuthUnknownError } from '@supabase/supabase-js';

// updateSession() (proxy.ts) is the UX gate in front of the pages (KEA-2). It
// must:
//   - decide "signed in" from auth.getClaims();
//   - copy refreshed session cookies onto redirect responses (or the browser
//     and server desync and the user is logged out);
//   - mark responses no-store ONLY when it wrote session cookies;
//   - not bounce /dashboard → /login when Auth is merely unreachable (the
//     dashboard layout then shows a retryable error page — no redirect loop).

type Claims = 'user' | 'none' | 'invalid' | 'retryable' | 'unknown' | 'rate-limited' | 'throws';

const s = vi.hoisted(() => ({
    claims: 'user' as Claims,
    refresh: false,
}));

type CookieAdapter = {
    setAll: (cookies: { name: string; value: string; options: Record<string, unknown> }[]) => void;
};

vi.mock('@supabase/ssr', () => ({
    createServerClient: (_url: string, _key: string, opts: { cookies: CookieAdapter }) => ({
        auth: {
            getClaims: async () => {
                // A refresh writes the new session through the cookie adapter
                // before getClaims resolves, as @supabase/ssr does.
                if (s.refresh) {
                    opts.cookies.setAll([
                        { name: 'sb-test-auth-token', value: 'refreshed', options: { path: '/', httpOnly: true } },
                    ]);
                }
                const c: Claims = s.claims;
                if (c === 'throws') throw new Error('boom');
                if (c === 'retryable') return { data: null, error: new AuthRetryableFetchError('fetch failed', 0) };
                // auth-js: a non-JSON error response (HTML 500, Cloudflare 52x).
                if (c === 'unknown') return { data: null, error: new AuthUnknownError('Unexpected token <', new SyntaxError('x')) };
                if (c === 'rate-limited') return { data: null, error: new AuthApiError('Too many requests', 429, 'over_request_rate_limit') };
                if (c === 'invalid') return { data: null, error: new AuthInvalidJwtError('Invalid JWT signature') };
                if (c === 'none') return { data: null, error: null };
                return { data: { claims: { sub: 'user-1' } }, error: null };
            },
        },
    }),
}));

import { updateSession } from '@/lib/supabase/proxy';

const req = (path: string) => new NextRequest(new URL(path, 'http://localhost'));

beforeEach(() => {
    s.claims = 'user';
    s.refresh = false;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('updateSession', () => {
    it('lets a signed-in user through to /dashboard', async () => {
        const res = await updateSession(req('/dashboard'));
        expect(res.headers.get('location')).toBeNull();
        expect(res.headers.get('x-middleware-next')).toBe('1');
    });

    it.each(['none', 'invalid'] as const)('redirects /dashboard to /login without a session (%s)', async (claims) => {
        s.claims = claims;
        const res = await updateSession(req('/dashboard/chats'));
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toBe('http://localhost/login');
    });

    it.each(['retryable', 'throws'] as const)(
        'does not redirect /dashboard when Auth is unreachable (%s)',
        async (claims) => {
            s.claims = claims;
            const res = await updateSession(req('/dashboard'));
            expect(res.headers.get('location')).toBeNull();
        }
    );

    it('redirects a signed-in user away from /login and /signup', async () => {
        for (const path of ['/login', '/signup']) {
            const res = await updateSession(req(path));
            expect(res.headers.get('location')).toBe('http://localhost/dashboard');
        }
    });

    it.each(['retryable', 'unknown', 'rate-limited'] as const)(
        'keeps /login reachable when the session cannot be verified (%s)',
        async (claims) => {
            s.claims = claims;
            const res = await updateSession(req('/login'));
            expect(res.headers.get('location')).toBeNull();
        }
    );

    it.each(['retryable', 'unknown', 'rate-limited'] as const)(
        'does not send /dashboard to /login when the session cannot be verified (%s)',
        async (claims) => {
            s.claims = claims;
            const res = await updateSession(req('/dashboard'));
            expect(res.headers.get('location')).toBeNull();
        }
    );

    it('copies refreshed cookies onto a redirect and marks it no-store', async () => {
        s.refresh = true;
        const res = await updateSession(req('/login'));
        expect(res.headers.get('location')).toBe('http://localhost/dashboard');
        expect(res.cookies.get('sb-test-auth-token')?.value).toBe('refreshed');
        expect(res.headers.get('cache-control')).toContain('no-store');
        expect(res.headers.get('pragma')).toBe('no-cache');
        expect(res.headers.get('expires')).toBe('0');
    });

    it('copies refreshed cookies onto a pass-through response and marks it no-store', async () => {
        s.refresh = true;
        const res = await updateSession(req('/dashboard'));
        expect(res.cookies.get('sb-test-auth-token')?.value).toBe('refreshed');
        expect(res.headers.get('cache-control')).toContain('no-store');
    });

    it('adds no cache headers when no cookies were written', async () => {
        const res = await updateSession(req('/dashboard'));
        expect(res.headers.get('cache-control')).toBeNull();
        expect(res.headers.get('pragma')).toBeNull();

        s.claims = 'none';
        const redirect = await updateSession(req('/dashboard'));
        expect(redirect.headers.get('location')).toBe('http://localhost/login');
        expect(redirect.headers.get('cache-control')).toBeNull();
    });
});
