import { test, expect } from '@playwright/test';

// The front door. We don't sign in (that needs a live Supabase) — we verify the
// form renders and its client-side gate works: the submit button stays disabled
// until both fields are filled.
test.describe('Login page', () => {
    test('renders the auth shell and the login form', async ({ page }) => {
        await page.goto('/login');

        await expect(page.getByText('Selamat datang kembali')).toBeVisible();
        await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
        // exact:true so this doesn't also match the "Tampilkan password" toggle.
        await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Masuk' })).toBeVisible();
    });

    test('keeps submit disabled until email and password are filled', async ({ page }) => {
        await page.goto('/login');

        const submit = page.getByRole('button', { name: 'Masuk' });
        await expect(submit).toBeDisabled();

        await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
        await expect(submit).toBeDisabled(); // password still empty

        await page.getByLabel('Password', { exact: true }).fill('a-password');
        await expect(submit).toBeEnabled();
    });

    test('the password show/hide toggle reveals the typed value', async ({ page }) => {
        await page.goto('/login');

        const password = page.getByLabel('Password', { exact: true });
        await password.fill('rahasia123');
        await expect(password).toHaveAttribute('type', 'password');

        await page.getByRole('button', { name: 'Tampilkan password' }).click();
        await expect(password).toHaveAttribute('type', 'text');
    });
});
