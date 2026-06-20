# E2E (Tier 3 — Playwright)

Browser smoke tests that prove the **deployable artifact boots and serves
end-to-end**, complementing the Vitest unit/integration suite (Tier 0–2).

## What's covered

| Spec | Proves |
|---|---|
| `landing.spec.ts` | App boots; Sarathi rebrand is live (wordmark + hero); CTA → `/login`; no uncaught page errors |
| `login.spec.ts` | Auth shell + login form render; submit gated until email+password filled; password show/hide toggle |
| `auth-gate.spec.ts` | Middleware redirects every `/dashboard*` route to `/login` when signed out; `/signup` → `/login` (single-tenant) |

These run **unauthenticated** against placeholder Supabase env (no live DB, no
secrets). With no session cookie, `supabase.auth.getUser()` returns null without
a network call, so the auth-gate behaviour is deterministic.

## Run

```bash
npm run test:e2e          # headless (starts its own server on :3100)
npm run test:e2e:ui       # Playwright UI mode
npm run test:e2e:report   # open the last HTML report
```

Locally the runner starts `next dev` on port 3100 (and reuses an already-running
server on that port). In CI it serves the production build. First run needs the
browser: `npx playwright install chromium`.

## Extending to authenticated journeys (login → lead → booking → reports)

Not wired into CI because it needs a **dedicated test Supabase project** with a
seeded owner user — secrets that must not live in a public repo. To add it:

1. Provision a throwaway Supabase project; run the migrations against it and
   seed one confirmed owner user.
2. Store its URL/anon key + the test credentials as GitHub Actions secrets
   (`E2E_SUPABASE_URL`, `E2E_SUPABASE_ANON_KEY`, `E2E_EMAIL`, `E2E_PASSWORD`).
3. Add a Playwright **auth setup project** that signs in once via the login form
   and saves `storageState`, then have the journey specs reuse that state
   (`test.use({ storageState })`). Guard the whole describe with
   `test.skip(!process.env.E2E_EMAIL, 'needs test Supabase')` so it stays green
   when the secrets aren't present (e.g. forks, local runs without a test DB).
4. Drive the real flow: create a lead → "Jadikan Booking" + DP → see it on the
   pipeline → confirm it in `/dashboard/reports`.
