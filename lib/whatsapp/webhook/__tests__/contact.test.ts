import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
    looksLikePhone,
    matchContact,
    senderIdentity,
    sharedCardPhone,
    syntheticKey,
} from '@/lib/whatsapp/webhook/contact';

// Who sent a message (Fase 2 task 2.2a part 2): the contact entry of the
// sender only (a change can carry several customers' messages, and another
// customer's BSUID or phone must never be written to this chat), the BSUID
// and best-known phone, the phone of a shared contact card, and the stable
// key of a message Meta sent without an id. Fake ids and phones only.

const A = { wa_id: '620000000001', user_id: 'ID.0000000001', profile: { name: 'Pelanggan A' } };
const B = { wa_id: '620000000002', user_id: 'ID.0000000002', profile: { name: 'Pelanggan B' } };

describe('matchContact', () => {
    it("takes the contact whose wa_id is the message's from", () => {
        expect(matchContact([A, B], { from: '620000000002' })).toBe(B);
        expect(matchContact([A, B], { from: '620000000001' })).toBe(A);
    });

    it("takes the contact whose user_id is the message's from_user_id (a phone-hidden customer)", () => {
        expect(matchContact([A, B], { from_user_id: 'ID.0000000002' })).toBe(B);
    });

    it('takes the only contact of a change', () => {
        expect(matchContact([A], { from: '620000000009' })).toBe(A);
        expect(matchContact([null, A, 'x'], { from: '620000000009' })).toBe(A);
    });

    it('never lends the first of several contacts that do not match', () => {
        expect(matchContact([A, B], { from: '620000000009' })).toBeNull();
        expect(matchContact([A, B], {})).toBeNull();
        expect(matchContact([A, B], 42)).toBeNull();
    });

    it('none when there are no contacts', () => {
        for (const contacts of [undefined, null, [], 'x', {}, [null]]) expect(matchContact(contacts, { from: '620000000001' })).toBeNull();
    });
});

describe('senderIdentity', () => {
    it('from, the BSUID from from_user_id first, and the phone', () => {
        expect(senderIdentity({ from: '620000000001', from_user_id: 'ID.dari-pesan' }, A)).toEqual({
            from: '620000000001',
            bsuid: 'ID.dari-pesan',
            waId: '620000000001',
        });
    });

    it("else the contact's user_id", () => {
        expect(senderIdentity({ from: '620000000001' }, A).bsuid).toBe('ID.0000000001');
        expect(senderIdentity({ from: '620000000001' }, null).bsuid).toBeNull();
    });

    it("waId: a phone-like contact wa_id, else a phone-like from, else null", () => {
        expect(senderIdentity({ from: 'ID.0000000003' }, { wa_id: '620000000003' }).waId).toBe('620000000003');
        expect(senderIdentity({ from: '620000000004' }, { wa_id: 'ID.bukan-nomor' }).waId).toBe('620000000004');
        expect(senderIdentity({ from: 'ID.0000000005', from_user_id: 'ID.0000000005' }, null)).toEqual({
            from: 'ID.0000000005',
            bsuid: 'ID.0000000005',
            waId: null,
        });
    });

    it('a phone-hidden customer: no from, a BSUID', () => {
        expect(senderIdentity({ from_user_id: 'ID.0000000006' }, null)).toEqual({ from: null, bsuid: 'ID.0000000006', waId: null });
    });

    it('empty or odd values are absent, never thrown', () => {
        expect(senderIdentity({ from: '', from_user_id: '' }, { user_id: '' })).toEqual({ from: null, bsuid: null, waId: null });
        expect(senderIdentity(42, null)).toEqual({ from: null, bsuid: null, waId: null });
        expect(senderIdentity({ from: 620000000001 }, null).from).toBeNull();
    });
});

describe('sharedCardPhone', () => {
    it("the first phone-like phones[].wa_id", () => {
        expect(sharedCardPhone({ phones: [{ phone: '+62 800-0000-0011', wa_id: '6280000000012' }] })).toBe('6280000000012');
    });

    it('else the digits of phones[].phone', () => {
        expect(sharedCardPhone({ phones: [{ phone: '+62 800-0000-0011' }] })).toBe('6280000000011');
        expect(sharedCardPhone({ phones: [{ phone: '12' }, { phone: '(021) 5000-0013' }] })).toBe('02150000013');
    });

    it('null without a usable phone', () => {
        for (const card of [undefined, null, {}, { phones: [] }, { phones: [{ phone: 'tidak ada' }] }, { phones: 'x' }, { phones: [null] }]) {
            expect(sharedCardPhone(card)).toBeNull();
        }
    });

    it('looksLikePhone: 8-15 digits only', () => {
        expect(looksLikePhone('62800000')).toBe(true);
        expect(looksLikePhone('6280000000000000')).toBe(false);
        expect(looksLikePhone('ID.26557548613939612')).toBe(false);
    });
});

describe('syntheticKey', () => {
    const message = { from: '620000000001', timestamp: '1761818400', type: 'text', text: { body: 'halo' } };

    it("is 'syn.' + the sha256 of number, sender, time, type and content", () => {
        const expected = createHash('sha256')
            .update(['100000000000001', '620000000001', '', '1761818400', 'text', JSON.stringify({ body: 'halo' })].join('|'))
            .digest('hex');
        expect(syntheticKey('100000000000001', message)).toBe(`syn.${expected}`);
    });

    it('is the same for a redelivery of the same message', () => {
        expect(syntheticKey('100000000000001', { ...message })).toBe(syntheticKey('100000000000001', message));
    });

    it('differs when the number, the sender, the time, the type or the content differs', () => {
        const key = syntheticKey('100000000000001', message);
        expect(syntheticKey('100000000000002', message)).not.toBe(key);
        expect(syntheticKey('100000000000001', { ...message, from: '620000000002' })).not.toBe(key);
        expect(syntheticKey('100000000000001', { ...message, from_user_id: 'ID.0000000001' })).not.toBe(key);
        expect(syntheticKey('100000000000001', { ...message, timestamp: '1761818401' })).not.toBe(key);
        expect(syntheticKey('100000000000001', { ...message, text: { body: 'halo!' } })).not.toBe(key);
        expect(syntheticKey('100000000000001', { ...message, type: 'button', button: { text: 'halo' } })).not.toBe(key);
    });

    it('never throws on odd input, and never looks like a Meta wamid', () => {
        for (const odd of [null, 42, 'x', [], {}, { type: 7 }, { type: 'text' }]) {
            const key = syntheticKey(undefined, odd);
            expect(key).toMatch(/^syn\.[0-9a-f]{64}$/);
        }
    });
});
