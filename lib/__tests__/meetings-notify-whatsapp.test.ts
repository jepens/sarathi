import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The sender is mocked; the resolver too, with its real error class.
vi.mock('@/lib/whatsapp/templates', () => ({ sendTemplateMessage: vi.fn() }));
vi.mock('@/lib/whatsapp/credentials', async () => {
    const { WhatsAppNotConfiguredError } = await import('@/lib/whatsapp/wa-creds');
    return { getOrgWhatsAppCreds: vi.fn(), WhatsAppNotConfiguredError };
});

import {
    parseNotifyRecipients,
    buildMeetingWaVariables,
    notifySalesWhatsApp,
} from '@/lib/meetings/notify-whatsapp';
import { sendTemplateMessage } from '@/lib/whatsapp/templates';
import { getOrgWhatsAppCreds, WhatsAppNotConfiguredError } from '@/lib/whatsapp/credentials';

describe('parseNotifyRecipients', () => {
    it('returns [] for empty/undefined', () => {
        expect(parseNotifyRecipients(undefined)).toEqual([]);
        expect(parseNotifyRecipients('')).toEqual([]);
        expect(parseNotifyRecipients('  ')).toEqual([]);
    });

    it('parses a single number', () => {
        expect(parseNotifyRecipients('6281281958110')).toEqual(['6281281958110']);
    });

    it('splits on commas and keeps digits only (+, spaces, dashes stripped)', () => {
        expect(parseNotifyRecipients('+62 812-8195-8110, 628123456789')).toEqual([
            '6281281958110',
            '628123456789',
        ]);
    });

    it('de-duplicates and drops too-short fragments', () => {
        expect(parseNotifyRecipients('628111222333, 628111222333, 123')).toEqual([
            '628111222333',
        ]);
    });

    it('rejects a letter-bearing token instead of gluing its digits', () => {
        // "…8110 ext 123" must NOT become 6281281958110123 (a wrong number).
        expect(parseNotifyRecipients('+62 812-8195-8110 ext 123')).toEqual([]);
        expect(parseNotifyRecipients('+62 812-8195-8110, catatan 5')).toEqual(['6281281958110']);
    });

    it('also splits on semicolons', () => {
        expect(parseNotifyRecipients('628111222333;628222333444')).toEqual([
            '628111222333',
            '628222333444',
        ]);
    });

    it('drops implausibly long tokens', () => {
        expect(parseNotifyRecipients('6281234567890123456')).toEqual([]);
    });
});

describe('buildMeetingWaVariables', () => {
    const start = new Date('2026-08-21T16:00:00+07:00'); // Fri 21 Aug 2026, 16:00 WIB

    it('builds 4 vars: klien(+company), waktu WIB, topik, link', () => {
        const v = buildMeetingWaVariables({
            customerName: 'Abdul',
            company: 'PT Sailendra',
            eventInterest: 'Gathering 100 orang',
            start,
            joinUrl: 'https://zoom.us/j/123',
        });
        expect(v).toHaveLength(4);
        expect(v[0]).toBe('Abdul (PT Sailendra)');
        expect(v[1]).toContain('21 Agustus 2026'); // WIB date, ICU-format tolerant
        expect(v[2]).toBe('Gathering 100 orang');
        expect(v[3]).toBe('https://zoom.us/j/123');
    });

    it('drops the company parens when there is no company', () => {
        const v = buildMeetingWaVariables({ customerName: 'Budi', start, joinUrl: null });
        expect(v[0]).toBe('Budi');
    });

    it('falls back: name→Klien, topic→Konsultasi, link→menyusul', () => {
        const v = buildMeetingWaVariables({
            customerName: null,
            company: null,
            eventInterest: null,
            start,
            joinUrl: null,
        });
        expect(v[0]).toBe('Klien');
        expect(v[2]).toBe('Konsultasi');
        expect(v[3]).toBe('menyusul');
    });

    it('treats the pending-link sentinel as "menyusul"', () => {
        const v = buildMeetingWaVariables({ customerName: 'X', start, joinUrl: 'pending-link' });
        expect(v[3]).toBe('menyusul');
    });

    it('sanitizes newlines/tabs that Meta would reject in a body param', () => {
        const v = buildMeetingWaVariables({
            customerName: 'A',
            eventInterest: 'Outbound\nteam building\tSentul',
            start,
            joinUrl: 'https://zoom.us/j/1',
        });
        expect(v[2]).toBe('Outbound team building Sentul');
        expect(v[2]).not.toMatch(/[\r\n\t]/);
    });
});

// The booking org's own number (Fase 2 task 2.2b): an org without one sends
// nothing, never from the default org's number. Fake numbers and ids only.
describe('notifySalesWhatsApp', () => {
    const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const CREDS = {
        orgId: ORG,
        integrationId: null,
        phoneNumberId: '100000000000001',
        wabaId: '200000000000001',
        accessToken: 'token-palsu',
        graphVersion: 'v25.0',
    };
    const INPUT = { customerName: 'Budi Palsu', start: new Date('2026-11-02T03:00:00Z'), joinUrl: null };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getOrgWhatsAppCreds).mockResolvedValue(CREDS);
        vi.mocked(sendTemplateMessage).mockResolvedValue({ waMessageId: 'wamid.palsu', raw: {} });
        vi.stubEnv('MEETING_NOTIFY_WHATSAPP', '620000000001, 620000000002');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("sends the template to every recipient with the booking org's credentials", async () => {
        const res = await notifySalesWhatsApp(ORG, INPUT);
        expect(res).toMatchObject({ sent: true, recipients: ['620000000001', '620000000002'] });
        expect(getOrgWhatsAppCreds).toHaveBeenCalledWith(ORG);
        expect(vi.mocked(sendTemplateMessage).mock.calls.map((c) => [c[0], c[1].to])).toEqual([
            [CREDS, '620000000001'],
            [CREDS, '620000000002'],
        ]);
    });

    it('an org without a number of its own sends nothing', async () => {
        vi.mocked(getOrgWhatsAppCreds).mockRejectedValue(new WhatsAppNotConfiguredError());
        await expect(notifySalesWhatsApp(ORG, INPUT)).resolves.toEqual({
            sent: false,
            skippedReason: 'WhatsApp not configured for this org',
            recipients: ['620000000001', '620000000002'],
        });
        expect(sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('credentials that cannot be read send nothing either (the booking still succeeds)', async () => {
        vi.mocked(getOrgWhatsAppCreds).mockRejectedValue(new Error('platform setting default_org_id could not be read (HTTP 503)'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await expect(notifySalesWhatsApp(ORG, INPUT)).resolves.toMatchObject({
                sent: false,
                skippedReason: 'WhatsApp credentials could not be read',
            });
        } finally {
            errorSpy.mockRestore();
        }
        expect(sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('without recipients nothing is resolved or sent', async () => {
        vi.stubEnv('MEETING_NOTIFY_WHATSAPP', '');
        await expect(notifySalesWhatsApp(ORG, INPUT)).resolves.toMatchObject({ sent: false, recipients: [] });
        expect(getOrgWhatsAppCreds).not.toHaveBeenCalled();
        expect(sendTemplateMessage).not.toHaveBeenCalled();
    });
});
