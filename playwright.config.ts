import { defineConfig, devices } from '@playwright/test';

// Tier 3 — end-to-end smoke tests (Playwright).
//
// These drive a REAL browser against the built app to prove the deployable
// artifact actually boots and serves end-to-end (not just compiles): the
// Sarathi landing renders, the login page works, and the proxy (proxy.ts)
// auth-gate redirects unauthenticated visitors away from /dashboard.
//
// They run UNAUTHENTICATED against placeholder Supabase env — no live database,
// no secrets — so they are safe to run in CI on every push. With no session
// cookie, supabase `getClaims()` returns null without a network call, so every
// /dashboard request deterministically redirects to /login.
//
// We exercise the PRODUCTION build (`next build` + `next start`), not `next dev`:
// dev-mode pages don't reliably hydrate under headless Chromium (HMR / React-
// compiler dev overhead), and the deployable artifact is what we want to test.
//
// Authenticated journeys (login → lead → booking → reports) need a dedicated
// test Supabase project + a seeded user; see e2e/README.md for the enable path.

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const isCI = !!process.env.CI;

// Placeholder env so the server boots without real credentials. Next does not
// override vars already present in process.env, so these win over any .env.local
// and keep the run deterministically unauthenticated.
const placeholderEnv = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder-anon-key',
    NEXT_PUBLIC_APP_URL: BASE_URL,
    // Force CAPTCHA off so the login form is testable without solving a
    // challenge (an empty key disables Turnstile). Set explicitly so a real key
    // in .env.local can't leak in and gate the submit button.
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
    NEXT_TELEMETRY_DISABLED: '1',
};

export default defineConfig({
    testDir: './e2e',
    // First hit to a route can compile/warm, so give each test headroom.
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: true,
    forbidOnly: isCI,
    retries: isCI ? 1 : 0,
    workers: isCI ? 1 : undefined,
    reporter: isCI
        ? [['github'], ['html', { open: 'never' }]]
        : [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        // Always serve the production build. In CI a dedicated "Build" step runs
        // first (so `start` is enough); locally we build then start in one go,
        // reusing an already-running server on this port if present.
        command: isCI
            ? `npm run start -- --port ${PORT}`
            : `npm run build && npm run start -- --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: !isCI,
        // A cold local build can take a couple of minutes before the server is up.
        timeout: 240_000,
        env: placeholderEnv,
    },
});
