import { describe, expect, it } from 'vitest';
import { webhookSummary } from '@/lib/whatsapp/webhook-summary';

// The webhook log line names what arrived, never its content (audit KEA-21).
// Fake values only.

describe('webhookSummary', () => {
    it('counts entries, changes, messages and statuses, with the change fields', () => {
        const body = {
            object: 'whatsapp_business_account',
            entry: [
                {
                    changes: [
                        {
                            field: 'messages',
                            value: {
                                metadata: { phone_number_id: '100000000000001' },
                                contacts: [{ profile: { name: 'Budi Santoso' }, wa_id: '628123456789' }],
                                messages: [{ from: '628123456789', text: { body: 'rahasia saya' } }],
                            },
                        },
                        { field: 'messages', value: { statuses: [{ recipient_id: '628123456789' }, {}] } },
                    ],
                },
            ],
        };
        const line = webhookSummary(body);
        expect(line).toBe('object=whatsapp_business_account entries=1 changes=2 fields=messages messages=1 statuses=2');
        expect(line).not.toMatch(/628|Budi|rahasia|100000000000001/);
    });

    it('never throws on an odd body', () => {
        expect(webhookSummary(null)).toBe('object=- entries=0 changes=0 fields=- messages=0 statuses=0');
        expect(webhookSummary({ object: 1, entry: [null, { changes: 'x' }, { changes: [null] }] })).toBe(
            'object=- entries=3 changes=1 fields=- messages=0 statuses=0'
        );
    });
});
