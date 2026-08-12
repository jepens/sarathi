import { describe, it, expect, afterEach } from 'vitest';
import {
    buildBrief,
    buildProposalTitle,
    buildHandoffBody,
    handoffInputSchema,
    type HandoffLead,
} from '@/lib/portal/types';
import { getPortalConfig, isPortalConfigured } from '@/lib/portal/config';

const baseLead: HandoffLead = {
    phone_number: '628123456789',
    contact_name: 'Budi',
    company: 'PT Astra',
    email: 'budi@astra.co.id',
    event_interest: 'team_building',
    participant_count: 300,
    location_pref: 'Bandung',
    event_date_pref: 'Q1 2026',
    event_goals: 'memperkuat kolaborasi tim',
    budget_range: '250jt',
};

describe('buildBrief', () => {
    it('maps lead fields into the camelCase brief', () => {
        expect(buildBrief(baseLead)).toEqual({
            eventInterest: 'team_building',
            participantCount: 300,
            locationPref: 'Bandung',
            eventDatePref: 'Q1 2026',
            eventGoals: 'memperkuat kolaborasi tim',
            budgetRange: '250jt',
            contactName: 'Budi',
            company: 'PT Astra',
            phone: '628123456789',
            email: 'budi@astra.co.id',
        });
    });

    it('drops empty / null fields instead of sending noise', () => {
        const sparse: HandoffLead = {
            phone_number: '628111',
            contact_name: '   ',
            company: null,
            email: null,
            event_interest: 'gala',
            participant_count: null,
            location_pref: '',
            event_date_pref: null,
            event_goals: null,
            budget_range: null,
        };
        expect(buildBrief(sparse)).toEqual({ eventInterest: 'gala', phone: '628111' });
    });

    it('omits a synthetic manual:<uuid> phone (never sent as a real phone)', () => {
        const brief = buildBrief({ ...baseLead, phone_number: 'manual:abc-123' });
        expect(brief.phone).toBeUndefined();
    });

    it('omits a non-positive participant count', () => {
        expect(buildBrief({ ...baseLead, participant_count: 0 }).participantCount).toBeUndefined();
    });
});

describe('buildProposalTitle', () => {
    it('combines event interest + client name', () => {
        expect(buildProposalTitle({ event_interest: 'Gathering' }, 'PT Astra')).toBe(
            'Penawaran — Gathering PT Astra'
        );
    });

    it('still works with only a client name', () => {
        expect(buildProposalTitle({ event_interest: null }, 'PT Astra')).toBe('Penawaran — PT Astra');
    });

    it('falls back to a generic title when nothing is known', () => {
        expect(buildProposalTitle({ event_interest: null }, '')).toBe('Penawaran');
    });
});

describe('buildHandoffBody', () => {
    it('assembles the full request body with sourceRef.leadId = phone_number', () => {
        const body = buildHandoffBody({
            idempotencyKey: 'key-1',
            client: { mode: 'existing', clientId: 'c-1' },
            title: '  Penawaran — Gathering  ',
            lead: baseLead,
        });
        expect(body.idempotencyKey).toBe('key-1');
        expect(body.client).toEqual({ mode: 'existing', clientId: 'c-1' });
        expect(body.proposal.title).toBe('Penawaran — Gathering'); // trimmed
        expect(body.sourceRef).toEqual({ app: 'sarathi', leadId: '628123456789' });
        expect(body.brief.participantCount).toBe(300);
    });

    it('keeps the synthetic leadId in sourceRef even when phone is omitted from the brief', () => {
        const body = buildHandoffBody({
            idempotencyKey: 'k',
            client: { mode: 'new', name: 'PT Baru' },
            title: 'X',
            lead: { ...baseLead, phone_number: 'manual:xyz' },
        });
        expect(body.sourceRef.leadId).toBe('manual:xyz');
        expect(body.brief.phone).toBeUndefined();
    });
});

describe('handoffInputSchema', () => {
    const VALID_UUID = '00000000-0000-4000-8000-000000000000';

    it('accepts a valid existing-client input', () => {
        const r = handoffInputSchema.safeParse({
            phone: '628123456789',
            idempotencyKey: VALID_UUID,
            title: 'Penawaran',
            client: { mode: 'existing', clientId: VALID_UUID },
        });
        expect(r.success).toBe(true);
    });

    it('accepts a valid new-client input', () => {
        const r = handoffInputSchema.safeParse({
            phone: '628123456789',
            idempotencyKey: VALID_UUID,
            title: 'Penawaran',
            client: { mode: 'new', name: 'PT Astra' },
        });
        expect(r.success).toBe(true);
    });

    it('rejects a blank title', () => {
        const r = handoffInputSchema.safeParse({
            phone: '628',
            idempotencyKey: VALID_UUID,
            title: '   ',
            client: { mode: 'new', name: 'PT Astra' },
        });
        expect(r.success).toBe(false);
    });

    it('rejects an existing client with a non-uuid id', () => {
        const r = handoffInputSchema.safeParse({
            phone: '628',
            idempotencyKey: VALID_UUID,
            title: 'X',
            client: { mode: 'existing', clientId: 'not-a-uuid' },
        });
        expect(r.success).toBe(false);
    });

    it('rejects a new client with an empty name', () => {
        const r = handoffInputSchema.safeParse({
            phone: '628',
            idempotencyKey: VALID_UUID,
            title: 'X',
            client: { mode: 'new', name: '' },
        });
        expect(r.success).toBe(false);
    });
});

describe('getPortalConfig / isPortalConfigured', () => {
    const prevBase = process.env.PORTAL_BASE_URL;
    const prevToken = process.env.PORTAL_INTAKE_TOKEN;

    afterEach(() => {
        // Assigning `undefined` to a process.env key coerces it to the truthy
        // string "undefined" — delete instead so the gating tests stay honest.
        if (prevBase === undefined) delete process.env.PORTAL_BASE_URL;
        else process.env.PORTAL_BASE_URL = prevBase;
        if (prevToken === undefined) delete process.env.PORTAL_INTAKE_TOKEN;
        else process.env.PORTAL_INTAKE_TOKEN = prevToken;
    });

    it('returns null when not fully configured', () => {
        process.env.PORTAL_BASE_URL = 'https://portal.example.com';
        delete process.env.PORTAL_INTAKE_TOKEN;
        expect(getPortalConfig()).toBeNull();
        expect(isPortalConfigured()).toBe(false);
    });

    it('strips trailing slashes from the base URL', () => {
        process.env.PORTAL_BASE_URL = 'https://portal.example.com///';
        process.env.PORTAL_INTAKE_TOKEN = 'secret';
        expect(getPortalConfig()).toEqual({
            baseUrl: 'https://portal.example.com',
            token: 'secret',
        });
        expect(isPortalConfigured()).toBe(true);
    });
});
