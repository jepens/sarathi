import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';

// DashboardLayout session handling (KEA-2, F1-B item 1). The layout must send
// the user to /login ONLY when there is genuinely no session (401). When the
// session cannot be verified right now (503) the proxy may still see the user
// as signed in and bounce /login back to /dashboard — a redirect loop — so the
// layout throws to the error boundary instead. A signed-in non-member (403) or
// a failed membership lookup (500) renders with orgId null.

const h = vi.hoisted(() => ({
    access: { ok: true } as Record<string, unknown>,
    redirect: vi.fn((url: string) => {
        // next/navigation's redirect() never returns.
        throw new Error(`NEXT_REDIRECT ${url}`);
    }),
}));

vi.mock('next/headers', () => ({
    cookies: async () => ({ get: () => undefined }),
}));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/lib/settings/org-context', () => ({
    requireOrgContext: vi.fn(async () => h.access),
}));
vi.mock('@/components/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/mobile-nav', () => ({ MobileNav: () => null }));
vi.mock('@/components/nav-progress', () => ({ NavProgress: () => null }));
vi.mock('@/components/notifications/notification-provider', () => ({
    NotificationProvider: () => null,
}));
vi.mock('@/components/realtime/org-realtime-provider', () => ({ OrgRealtimeProvider: () => null }));
vi.mock('@/components/current-org-provider', () => ({ CurrentOrgProvider: () => null }));

import DashboardLayout from '@/app/dashboard/layout';
import { CurrentOrgProvider } from '@/components/current-org-provider';

const render = () => DashboardLayout({ children: null }) as Promise<ReactElement<{ orgId: string | null }>>;

beforeEach(() => {
    h.redirect.mockClear();
});

describe('DashboardLayout', () => {
    it('redirects to /login when there is no session (401)', async () => {
        h.access = { ok: false, status: 401, error: 'Unauthorized' };
        await expect(render()).rejects.toThrow('NEXT_REDIRECT /login');
        expect(h.redirect).toHaveBeenCalledWith('/login');
    });

    it('throws to the error page — no /login redirect — when the session cannot be verified (503)', async () => {
        h.access = { ok: false, status: 503, error: 'Sesi tidak dapat diverifikasi' };
        await expect(render()).rejects.toThrow('Sesi tidak dapat diverifikasi');
        expect(h.redirect).not.toHaveBeenCalled();
    });

    it.each([403, 500])('renders with orgId null for a signed-in user without an org (%i)', async (status) => {
        h.access = { ok: false, status, error: 'x' };
        const el = await render();
        expect(h.redirect).not.toHaveBeenCalled();
        expect(el.type).toBe(CurrentOrgProvider);
        expect(el.props.orgId).toBeNull();
    });

    it("passes a member's org to the client provider", async () => {
        h.access = { ok: true, orgId: 'org-1', userId: 'user-1', role: 'owner' };
        const el = await render();
        expect(h.redirect).not.toHaveBeenCalled();
        expect(el.type).toBe(CurrentOrgProvider);
        expect(el.props.orgId).toBe('org-1');
    });
});
