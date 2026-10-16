import { test, expect } from '@playwright/test';

// The proxy (proxy.ts, formerly middleware) is the app's page-level auth gate,
// backed by the dashboard layout's own session check. These prove it actually
// enforces it end-to-end: an unauthenticated visitor can never reach the
// dashboard, and (single-tenant) self-serve signup is closed.
test.describe('Auth gate (proxy)', () => {
    const protectedRoutes = [
        '/dashboard',
        '/dashboard/pipeline',
        '/dashboard/contacts',
        '/dashboard/reports',
        '/dashboard/settings',
    ];

    for (const route of protectedRoutes) {
        test(`redirects ${route} to /login when signed out`, async ({ page }) => {
            await page.goto(route);
            await expect(page).toHaveURL(/\/login$/);
        });
    }

    test('redirects /signup to /login (single-tenant: signup disabled)', async ({ page }) => {
        await page.goto('/signup');
        await expect(page).toHaveURL(/\/login$/);
    });
});
