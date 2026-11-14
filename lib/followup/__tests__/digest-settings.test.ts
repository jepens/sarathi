import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// The digest's last-sent date is a tenant setting (tracker 1.5 / 1.7): every
// read/write is scoped to the org, and the upsert targets the org-scoped key
// app_settings (org_id, key) from migration 0061 — never the global 'key'.

vi.mock('@/lib/whatsapp/templates', () => ({ sendTemplateMessage: vi.fn() }));
vi.mock('@/lib/settings/org-context', () => ({ getDefaultOrgId: vi.fn() }));
vi.mock('@/lib/followup/compute', () => ({ computeFollowup: vi.fn() }));
vi.mock('@/lib/utils/logger', () => ({ whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/whatsapp/credentials', async () => {
    const { WhatsAppNotConfiguredError } = await import('@/lib/whatsapp/wa-creds');
    return { getOrgWhatsAppCreds: vi.fn(), WhatsAppNotConfiguredError };
});

import { claimToday, getLastSent, maybeSendFollowupDigest } from '@/lib/followup/digest';
import { sendTemplateMessage } from '@/lib/whatsapp/templates';
import { getDefaultOrgId } from '@/lib/settings/org-context';
import { computeFollowup } from '@/lib/followup/compute';
import { getOrgWhatsAppCreds, WhatsAppNotConfiguredError } from '@/lib/whatsapp/credentials';
import { whatsappLogger } from '@/lib/utils/logger';

const ORG = '0b0e6c1e-1111-4222-8333-444455556666';

function recorder(result: { data: unknown; error: unknown }) {
    const log: Array<[string, ...unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'update', 'upsert']) {
        q[m] = (...args: unknown[]) => {
            log.push([m, ...args]);
            return q;
        };
    }
    q.maybeSingle = async () => result;
    q.then = (resolve: (v: unknown) => unknown) => resolve(result);
    const client = { from: (t: string) => (log.push(['from', t]), q) } as unknown as SupabaseClient;
    return { client, log };
}

describe('digest last-sent setting', () => {
    it('getLastSent reads the org-scoped row', async () => {
        const { client, log } = recorder({ data: { value: '2026-10-16' }, error: null });
        expect(await getLastSent(client, ORG)).toBe('2026-10-16');
        expect(log).toContainEqual(['eq', 'org_id', ORG]);
        expect(log).toContainEqual(['eq', 'key', 'followup_digest_last_sent']);
    });

    it('claimToday upserts on (org_id, key) and flips only this org\'s row', async () => {
        const { client, log } = recorder({ data: [{ id: 'x' }], error: null });
        expect(await claimToday(client, ORG, '2026-10-16')).toBe(true);
        const upsert = log.find((c) => c[0] === 'upsert');
        expect(upsert?.[1]).toMatchObject({ org_id: ORG, key: 'followup_digest_last_sent' });
        expect(upsert?.[2]).toEqual({ onConflict: 'org_id,key', ignoreDuplicates: true });
        expect(log.filter((c) => c[0] === 'eq' && c[1] === 'org_id')).toHaveLength(1);
        expect(log).toContainEqual(['neq', 'value', '2026-10-16']);
    });

    it('claimToday returns false when another tick already claimed the day', async () => {
        const { client } = recorder({ data: [], error: null });
        expect(await claimToday(client, ORG, '2026-10-16')).toBe(false);
    });
});

// The digest goes out from the org's own number (Fase 2 task 2.2b), resolved
// with the cron's service-role client. Fake numbers and ids only.
describe('digest send', () => {
    const CREDS = {
        orgId: ORG,
        integrationId: null,
        phoneNumberId: '100000000000001',
        wabaId: '200000000000001',
        accessToken: 'token-palsu',
        graphVersion: 'v25.0',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('FOLLOWUP_DIGEST_TO', '620000000009');
        vi.stubEnv('FOLLOWUP_DIGEST_HOUR', '0');
        vi.mocked(getDefaultOrgId).mockResolvedValue(ORG);
        vi.mocked(computeFollowup).mockResolvedValue({ counts: { leads: 2, bookings: 1, total: 3 } } as never);
        vi.mocked(getOrgWhatsAppCreds).mockResolvedValue(CREDS);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("sends with the org's credentials, read with the cron's client", async () => {
        // Not sent today yet, and this tick wins the claim.
        const { client } = recorder({ data: [{ id: 'x' }], error: null });
        await maybeSendFollowupDigest(client);
        expect(getOrgWhatsAppCreds).toHaveBeenCalledWith(ORG, client);
        expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sendTemplateMessage).mock.calls[0][0]).toBe(CREDS);
        expect(vi.mocked(sendTemplateMessage).mock.calls[0][1]).toMatchObject({ to: '620000000009' });
    });

    it('credentials that cannot be read: the day is NOT claimed, so the next tick tries again', async () => {
        const readError = Object.assign(new Error('platform setting default_org_id could not be read (HTTP 503)'), { name: 'PlatformSettingReadError' });
        vi.mocked(getOrgWhatsAppCreds).mockRejectedValue(readError);
        const { client, log } = recorder({ data: [{ id: 'x' }], error: null });
        await maybeSendFollowupDigest(client);
        expect(log.some((c) => c[0] === 'upsert' || c[0] === 'update')).toBe(false);
        expect(sendTemplateMessage).not.toHaveBeenCalled();
        expect(whatsappLogger.error).toHaveBeenCalledWith('Follow-up digest failed', readError);
    });

    it('an org without a number: the day is claimed and the failure logged once, nothing is sent', async () => {
        vi.mocked(getOrgWhatsAppCreds).mockRejectedValue(new WhatsAppNotConfiguredError());
        const { client, log } = recorder({ data: [{ id: 'x' }], error: null });
        await maybeSendFollowupDigest(client);
        expect(log.some((c) => c[0] === 'update')).toBe(true);
        expect(sendTemplateMessage).not.toHaveBeenCalled();
        expect(whatsappLogger.error).toHaveBeenCalledWith('Follow-up digest failed', expect.any(WhatsAppNotConfiguredError));
    });
});
