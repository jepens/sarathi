import { describe, it, expect } from 'vitest';
import { buildRecipient } from '@/lib/whatsapp/recipient';
import { isDialablePhone } from '@/lib/leads/schema';

describe('isDialablePhone', () => {
    it('accepts bare international digits (8–15)', () => {
        expect(isDialablePhone('6281314942012')).toBe(true);
        expect(isDialablePhone('12345678')).toBe(true);
    });
    it('rejects a BSUID, synthetic identity, and junk', () => {
        expect(isDialablePhone('ID.26557548613939612')).toBe(false);
        expect(isDialablePhone('US.13491208655302741918')).toBe(false);
        expect(isDialablePhone('manual:abc-123')).toBe(false);
        expect(isDialablePhone('+62 812')).toBe(false); // has non-digits
        expect(isDialablePhone('1234567')).toBe(false); // too short
        expect(isDialablePhone(null)).toBe(false);
        expect(isDialablePhone(undefined)).toBe(false);
    });
});

describe('buildRecipient', () => {
    it('puts a dialable phone in `to` with recipient_type (and never `recipient`)', () => {
        const r = buildRecipient('6281314942012');
        expect(r).toEqual({ recipient_type: 'individual', to: '6281314942012' });
        expect(r).not.toHaveProperty('recipient');
    });

    it('normalizes a formatted phone (+, spaces, dashes) into bare-digit `to`', () => {
        expect(buildRecipient('+62 813-1494-2012')).toEqual({ recipient_type: 'individual', to: '6281314942012' });
        expect(buildRecipient('+6281234567890')).toEqual({ recipient_type: 'individual', to: '6281234567890' });
    });

    it('puts a BSUID in `recipient` with recipient_type (and never `to`)', () => {
        const r = buildRecipient('ID.26557548613939612');
        expect(r).toEqual({ recipient_type: 'individual', recipient: 'ID.26557548613939612' });
        expect(r).not.toHaveProperty('to');
    });

    it('never emits both `to` and `recipient`', () => {
        for (const id of ['6281314942012', 'ID.2655', 'US.13491208655302741918', 'manual:x']) {
            const r = buildRecipient(id);
            expect('to' in r && 'recipient' in r).toBe(false);
        }
    });
});
