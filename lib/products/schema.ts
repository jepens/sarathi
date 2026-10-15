import { z } from 'zod';

// Whitelist for PATCH /api/products/[id] (KEA-18). Only these columns are
// client-editable; everything else the dashboard sends back (id, org_id,
// created_at, embedding, …) is stripped — z.object drops unknown keys — so a
// caller can't move a product to another org or plant a fake embedding.
export const productPatchSchema = z.object({
    name: z.string().trim().min(1, 'Nama wajib diisi').max(200).optional(),
    description: z.string().max(10_000).nullable().optional(),
    price: z.number().finite().nonnegative().optional(),
    // null = "unchanged": the dialog echoes back the row, where both are nullable.
    stock: z.number().int().nonnegative().nullable().optional(),
    type: z.enum(['product', 'service']).nullable().optional(),
});

export type ProductPatch = z.infer<typeof productPatchSchema>;
