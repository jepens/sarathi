import { test, expect } from '@playwright/test';

// The public marketing page. Proves the app boots and serves, and that the
// Sarathi rebrand is actually live (wordmark + hero copy), with a working
// path into the product.
test.describe('Landing page', () => {
    test('renders the Sarathi brand and hero, with no uncaught errors', async ({ page }) => {
        const pageErrors: Error[] = [];
        page.on('pageerror', (err) => pageErrors.push(err));

        await page.goto('/');

        // Brand wordmark in the header.
        await expect(page.getByRole('link', { name: 'Sarathi' })).toBeVisible();

        // Hero headline — the single h1 carries the rebranded promise.
        const h1 = page.getByRole('heading', { level: 1 });
        await expect(h1).toContainText('ter-booking');

        // Footer attributes the product to Sailendra Organizer.
        await expect(page.getByText('Sailendra Organizer')).toBeVisible();

        expect(pageErrors, 'no uncaught page errors').toEqual([]);
    });

    test('the primary CTA leads into the login page', async ({ page }) => {
        await page.goto('/');

        await page.getByRole('link', { name: /Mulai gratis/i }).click();

        await expect(page).toHaveURL(/\/login$/);
        await expect(page.getByRole('button', { name: 'Masuk' })).toBeVisible();
    });
});
