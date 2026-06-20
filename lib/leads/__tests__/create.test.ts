import { describe, it, expect } from 'vitest';
import { makeFakeSupabase, type FakeCall } from '@/lib/whatsapp/__tests__/fakeSupabase';
import { createOrFillLead } from '@/lib/leads/create';
import { leadInputSchema } from '@/lib/leads/schema';

const ORG = 'org-1';

// A complete whatsapp_chats row as createOrFillLead reads it; override per test.
function existingRow(over: Record<string, unknown> = {}) {
    return {
        phone_number: '628123456789',
        contact_type: 'lead',
        contact_name: null,
        contact_name_locked: false,
        email: null,
        event_interest: null,
        participant_count: null,
        location_pref: null,
        event_date_pref: null,
        event_goals: null,
        budget_range: null,
        assigned_to: null,
        notes: null,
        lead_stage: null,
        source: null,
        ...over,
    };
}

function payloadOf(calls: FakeCall[], op: 'insert' | 'update'): Record<string, unknown> | undefined {
    return calls.find((c) => c.op === op)?.payload as Record<string, unknown> | undefined;
}

describe('createOrFillLead — new lead', () => {
    it('inserts a lead, normalizing a real phone into the identity + verified_phone', async () => {
        const input = leadInputSchema.parse({
            contact_name: 'Budi',
            phone_number: '08123456789',
            event_interest: 'Wedding',
        });
        const fake = makeFakeSupabase({
            resolve: (c) => (c.op === 'select' ? { data: null } : { error: null }),
        });

        const res = await createOrFillLead(fake.client, ORG, input);

        expect(res).toMatchObject({ result: 'created', phone_number: '628123456789', contact_name: 'Budi' });
        const row = payloadOf(fake.calls, 'insert')!;
        expect(row.org_id).toBe(ORG);
        expect(row.phone_number).toBe('628123456789');
        expect(row.verified_phone).toBe('628123456789');
        expect(row.contact_type).toBe('lead');
        expect(row.contact_name).toBe('Budi');
        expect(row.contact_name_locked).toBe(true); // a typed-in name is authoritative
        expect(row.event_interest).toBe('Wedding');
        expect(row.last_message_at).toBeNull(); // stays out of the inbox until it messages
    });

    it('gives a phone-less lead a synthetic manual: identity and null verified_phone', async () => {
        const input = leadInputSchema.parse({ contact_name: 'Tanpa HP' });
        const fake = makeFakeSupabase({
            resolve: (c) => (c.op === 'select' ? { data: null } : { error: null }),
        });

        const res = await createOrFillLead(fake.client, ORG, input);

        expect(res.result).toBe('created');
        expect(res.phone_number.startsWith('manual:')).toBe(true);
        const row = payloadOf(fake.calls, 'insert')!;
        expect(String(row.phone_number).startsWith('manual:')).toBe(true);
        expect(row.verified_phone).toBeNull();
    });
});

describe('createOrFillLead — existing lead (fill-empty, never overwrite)', () => {
    it('fills only the empty cells and leaves set values, stage, and source alone', async () => {
        const existing = existingRow({
            contact_name: 'Budi', // already set
            notes: 'catatan lama', // already set
            lead_stage: 'qualifying', // already set — must not regress
        });
        const input = leadInputSchema.parse({
            phone_number: '08123456789',
            contact_name: 'Budi Baru',
            email: 'b@x.co',
            event_interest: 'Wedding',
            notes: 'catatan baru',
        });
        const fake = makeFakeSupabase({
            resolve: (c) => (c.op === 'select' ? { data: existing } : { error: null }),
        });

        const res = await createOrFillLead(fake.client, ORG, input);

        expect(res.result).toBe('updated');
        const patch = payloadOf(fake.calls, 'update')!;
        expect(patch.email).toBe('b@x.co'); // was empty → filled
        expect(patch.event_interest).toBe('Wedding'); // was empty → filled
        expect(patch).not.toHaveProperty('contact_name'); // already set → untouched
        expect(patch).not.toHaveProperty('notes'); // already set → untouched
        expect(patch).not.toHaveProperty('lead_stage'); // set → not regressed
        expect(patch).not.toHaveProperty('source'); // never filled (null = "via WhatsApp")
        expect(patch).toHaveProperty('updated_at');
    });

    it('respects a locked contact name but still fills other empty cells', async () => {
        const existing = existingRow({ contact_name: null, contact_name_locked: true });
        const input = leadInputSchema.parse({
            phone_number: '08123456789',
            contact_name: 'Budi',
            email: 'b@x.co',
        });
        const fake = makeFakeSupabase({
            resolve: (c) => (c.op === 'select' ? { data: existing } : { error: null }),
        });

        const res = await createOrFillLead(fake.client, ORG, input);

        expect(res.result).toBe('updated');
        const patch = payloadOf(fake.calls, 'update')!;
        expect(patch).not.toHaveProperty('contact_name'); // locked → not filled
        expect(patch.email).toBe('b@x.co');
        expect(patch.lead_stage).toBe('new'); // existing had none → seeded
    });

    it('reports "unchanged" and writes nothing when the row is already complete', async () => {
        const existing = existingRow({
            contact_name: 'Budi',
            email: 'a@a.co',
            event_interest: 'W',
            participant_count: 100,
            location_pref: 'BDG',
            event_date_pref: '2026-09-12',
            event_goals: 'G',
            budget_range: '50jt',
            assigned_to: 'Sari',
            notes: 'n',
            lead_stage: 'won',
            source: 'manual',
        });
        const input = leadInputSchema.parse({ phone_number: '08123456789', contact_name: 'X', email: 'y@y.co' });
        const fake = makeFakeSupabase({
            resolve: (c) => (c.op === 'select' ? { data: existing } : { error: null }),
        });

        const res = await createOrFillLead(fake.client, ORG, input);

        expect(res.result).toBe('unchanged');
        expect(fake.calls.find((c) => c.op === 'update')).toBeUndefined();
    });

    it('refuses to blend lead data onto a non-lead (vendor) contact', async () => {
        const existing = existingRow({ contact_type: 'vendor', contact_name: 'PT Vendor' });
        const input = leadInputSchema.parse({ phone_number: '08123456789', contact_name: 'Budi' });
        const fake = makeFakeSupabase({
            resolve: (c) => (c.op === 'select' ? { data: existing } : { error: null }),
        });

        const res = await createOrFillLead(fake.client, ORG, input);

        expect(res).toMatchObject({ result: 'skipped_non_lead', contact_name: 'PT Vendor' });
        expect(fake.calls.find((c) => c.op === 'update')).toBeUndefined();
    });
});

describe('createOrFillLead — concurrent insert (TOCTOU)', () => {
    it('re-reads and fills instead of throwing on a 23505 unique violation', async () => {
        let selects = 0;
        const racedRow = existingRow({ lead_stage: 'new' }); // created by the other writer
        const fake = makeFakeSupabase({
            resolve: (c) => {
                if (c.op === 'select') {
                    selects += 1;
                    return selects === 1 ? { data: null } : { data: racedRow };
                }
                if (c.op === 'insert') return { error: { code: '23505', message: 'duplicate key' } };
                return { error: null }; // the follow-up update
            },
        });
        const input = leadInputSchema.parse({ phone_number: '08123456789', email: 'b@x.co' });

        const res = await createOrFillLead(fake.client, ORG, input);

        expect(res.result).toBe('updated'); // filled the empty email after losing the race
        expect(payloadOf(fake.calls, 'update')!.email).toBe('b@x.co');
    });
});
