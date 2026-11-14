import { describe, it, expect, vi, beforeEach } from 'vitest';

// requireWhatsAppIntegration (Fase 2 task 2.2b): the gate of every dashboard
// route that calls the WhatsApp Cloud API. The org context is checked strictly
// first; then the credentials of THAT org's number are resolved, or the route
// is refused before the body is read and before Meta is called. Fake ids only.

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';

const h = vi.hoisted(() => ({
    requireOrgContext: vi.fn(),
    getOrgWhatsAppCreds: vi.fn(),
}));

vi.mock('@/lib/settings/org-context', () => ({ requireOrgContext: h.requireOrgContext }));
vi.mock('@/lib/whatsapp/credentials', async () => {
    const { WhatsAppNotConfiguredError } = await import('@/lib/whatsapp/wa-creds');
    return { getOrgWhatsAppCreds: h.getOrgWhatsAppCreds, WhatsAppNotConfiguredError };
});

import { requireWhatsAppIntegration } from '@/lib/whatsapp/integration';
import { WhatsAppNotConfiguredError } from '@/lib/whatsapp/wa-creds';
import {
    INTEGRATION_NOT_CONFIGURED_MESSAGE,
    NOT_SIGNED_IN_MESSAGE,
    WHATSAPP_SETTINGS_UNAVAILABLE_MESSAGE,
} from '@/lib/settings/org-access';

const MEMBER = { ok: true as const, supabase: { tag: 'cookie-client' }, userId: 'user-1', orgId: ORG, role: 'owner' as const };
const CREDS = {
    orgId: ORG,
    integrationId: null,
    phoneNumberId: '100000000000001',
    wabaId: null,
    accessToken: 'token-palsu',
    graphVersion: 'v25.0',
};

beforeEach(() => {
    vi.clearAllMocks();
    h.requireOrgContext.mockResolvedValue(MEMBER);
    h.getOrgWhatsAppCreds.mockResolvedValue(CREDS);
});

describe('requireWhatsAppIntegration', () => {
    it("a member gets the context and the credentials of their own org's number", async () => {
        await expect(requireWhatsAppIntegration()).resolves.toEqual({ ...MEMBER, creds: CREDS });
        // Strict: an external side effect follows (revoked sessions refused at once).
        expect(h.requireOrgContext).toHaveBeenCalledWith({ strict: true });
        expect(h.getOrgWhatsAppCreds).toHaveBeenCalledWith(ORG);
    });

    it('a refused org context is answered as it is, without reading any credentials', async () => {
        const denied = { ok: false as const, status: 401 as const, error: NOT_SIGNED_IN_MESSAGE };
        h.requireOrgContext.mockResolvedValue(denied);
        await expect(requireWhatsAppIntegration()).resolves.toBe(denied);
        expect(h.getOrgWhatsAppCreds).not.toHaveBeenCalled();
    });

    it('an org without a WhatsApp number of its own gets 403 "not configured"', async () => {
        h.getOrgWhatsAppCreds.mockRejectedValue(new WhatsAppNotConfiguredError());
        await expect(requireWhatsAppIntegration()).resolves.toEqual({
            ok: false,
            status: 403,
            error: INTEGRATION_NOT_CONFIGURED_MESSAGE.whatsapp,
        });
    });

    it('credentials that cannot be read right now answer 503 (retry), never another number', async () => {
        h.getOrgWhatsAppCreds.mockRejectedValue(Object.assign(new Error('platform setting default_org_id could not be read (HTTP 503)'), { name: 'PlatformSettingReadError' }));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await expect(requireWhatsAppIntegration()).resolves.toEqual({
                ok: false,
                status: 503,
                error: WHATSAPP_SETTINGS_UNAVAILABLE_MESSAGE,
            });
        } finally {
            errorSpy.mockRestore();
        }
    });
});
