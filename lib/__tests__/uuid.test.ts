import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { safeRandomUUID, deterministicUuid, uuidFromBytes } from '@/lib/uuid';
import { handoffInputSchema } from '@/lib/portal/types';

// The whole point of these helpers is to emit strings that pass z.uuid() (the
// same validator handoffInputSchema uses) while working over plain HTTP.
const uuid = z.uuid();

describe('uuidFromBytes', () => {
    it('formats 16 bytes as a v4-shaped uuid (version 4, variant 8–b)', () => {
        const id = uuidFromBytes(new Uint8Array(16).fill(0xff));
        expect(uuid.safeParse(id).success).toBe(true);
        expect(id[14]).toBe('4'); // version nibble
        expect('89ab').toContain(id[19]); // variant nibble
    });

    it('is a pure function of its input bytes', () => {
        const bytes = Uint8Array.from({ length: 16 }, (_, i) => (i * 37) & 0xff);
        expect(uuidFromBytes(bytes)).toBe(uuidFromBytes(bytes));
    });
});

describe('safeRandomUUID', () => {
    it('always produces a value that passes z.uuid()', () => {
        for (let i = 0; i < 100; i++) {
            expect(uuid.safeParse(safeRandomUUID()).success).toBe(true);
        }
    });

    it('is accepted as an idempotencyKey by handoffInputSchema', () => {
        const r = handoffInputSchema.safeParse({
            phone: '628123456789',
            idempotencyKey: safeRandomUUID(),
            title: 'Penawaran',
            client: { mode: 'new', name: 'PT Astra' },
        });
        expect(r.success).toBe(true);
    });
});

describe('deterministicUuid', () => {
    it('is stable for the same seed', () => {
        const seed = '628123456789::new:PT Astra';
        expect(deterministicUuid(seed)).toBe(deterministicUuid(seed));
    });

    it('passes z.uuid()', () => {
        expect(uuid.safeParse(deterministicUuid('anything')).success).toBe(true);
    });

    it('differs when the selection differs', () => {
        expect(deterministicUuid('628123::new:PT Astra')).not.toBe(
            deterministicUuid('628123::new:PT Beta')
        );
    });

    it('differs when the lead phone differs (no cross-lead key collision)', () => {
        // Same selection, different lead → distinct keys, so the Portal can never
        // dedup two different leads into one handoff.
        expect(deterministicUuid('628111::new:PT Astra')).not.toBe(
            deterministicUuid('628222::new:PT Astra')
        );
    });
});
