import { describe, it, expect } from 'vitest';
import { productPatchSchema } from '@/lib/products/schema';

// PATCH /api/products/[id] whitelist (KEA-18): the edit dialog posts the whole
// row back, so unknown/forbidden columns must be dropped, not written.

describe('productPatchSchema', () => {
    it('keeps only the editable columns from an echoed-back row', () => {
        const parsed = productPatchSchema.parse({
            id: 'p1',
            org_id: 'another-org',
            created_at: '2026-01-01T00:00:00Z',
            embedding: [0.1, 0.2],
            metadata: { x: 1 },
            name: 'Paket Gathering',
            description: null,
            price: 1500000,
            stock: null,
            type: 'service',
        });
        expect(parsed).toEqual({
            name: 'Paket Gathering',
            description: null,
            price: 1500000,
            stock: null,
            type: 'service',
        });
        expect(parsed).not.toHaveProperty('org_id');
        expect(parsed).not.toHaveProperty('embedding');
    });

    it('accepts a partial update', () => {
        expect(productPatchSchema.parse({ price: 0 })).toEqual({ price: 0 });
    });

    it('rejects bad types and values', () => {
        expect(productPatchSchema.safeParse({ type: 'bundle' }).success).toBe(false);
        expect(productPatchSchema.safeParse({ price: -1 }).success).toBe(false);
        expect(productPatchSchema.safeParse({ price: '100' }).success).toBe(false);
        expect(productPatchSchema.safeParse({ stock: 1.5 }).success).toBe(false);
        expect(productPatchSchema.safeParse({ name: '   ' }).success).toBe(false);
    });
});
