import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Stock Management Module
 * Handles inventory validation, reduction, and restoration
 */

export interface OrderItem {
    product_id?: string;
    name: string;
    qty: number;
    price?: number;
    note?: string;
}

export interface StockValidationResult {
    valid: boolean;
    insufficientItems?: Array<{
        name: string;
        requested: number;
        available: number;
    }>;
    message?: string;
}

export interface PricedItem {
    product_id: string;
    name: string;
    qty: number;
    price: number;
    type: 'product' | 'service';
    note?: string;
}

export interface RepriceResult {
    valid: boolean;
    items?: PricedItem[];
    total_amount?: number;
    message?: string;
    mismatches?: Array<{
        product_id: string;
        name: string;
        llm_price: number;
        db_price: number;
    }>;
}

const PRICE_TOLERANCE_RUPIAH = 1;

/**
 * Reprice order items against the authoritative DB.
 *
 * The AI may emit a `[CREATE_ORDER]` tag containing `price` and `total_amount`.
 * Trusting those values lets a prompt-injection attacker (or a hallucinating
 * model) set arbitrary prices. This helper rebuilds every line item from the
 * `products` table and returns a server-computed total. Any LLM-supplied price
 * that diverges from the DB by more than PRICE_TOLERANCE_RUPIAH is reported as
 * a mismatch so it can be logged/monitored.
 *
 * Items without a `product_id` are rejected so the AI is forced to ground each
 * line on a real catalog entry (it has the `check_availability` / `list_products`
 * tools for that).
 */
export async function repriceItems(
    rawItems: Array<{
        product_id?: string;
        name?: string;
        qty: number;
        price?: number;
        note?: string;
    }>,
    client?: SupabaseClient
): Promise<RepriceResult> {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return { valid: false, message: 'Pesanan tidak memiliki item.' };
    }

    const supabase = client || (await createClient());
    const pricedItems: PricedItem[] = [];
    const mismatches: NonNullable<RepriceResult['mismatches']> = [];

    for (const raw of rawItems) {
        if (!raw.product_id || typeof raw.product_id !== 'string') {
            return {
                valid: false,
                message: `Produk "${raw.name ?? 'tidak dikenal'}" tidak memiliki ID. AI harus memilih produk dari katalog yang tersedia.`,
            };
        }

        const qty = Number(raw.qty);
        if (!Number.isInteger(qty) || qty <= 0) {
            return {
                valid: false,
                message: `Jumlah tidak valid untuk "${raw.name ?? raw.product_id}". Harus bilangan bulat > 0.`,
            };
        }

        const { data: product, error } = await supabase
            .from('products')
            .select('id, name, price, type')
            .eq('id', raw.product_id)
            .single();

        if (error || !product) {
            return {
                valid: false,
                message: `Produk dengan ID ${raw.product_id} tidak ditemukan di katalog.`,
            };
        }

        const dbPrice = Number(product.price);
        if (!Number.isFinite(dbPrice) || dbPrice < 0) {
            return {
                valid: false,
                message: `Harga tidak valid untuk produk "${product.name}".`,
            };
        }

        if (raw.price !== undefined) {
            const llmPrice = Number(raw.price);
            if (
                Number.isFinite(llmPrice) &&
                Math.abs(dbPrice - llmPrice) > PRICE_TOLERANCE_RUPIAH
            ) {
                mismatches.push({
                    product_id: product.id,
                    name: product.name,
                    llm_price: llmPrice,
                    db_price: dbPrice,
                });
            }
        }

        pricedItems.push({
            product_id: product.id,
            name: product.name,
            qty,
            price: dbPrice,
            type: (product.type === 'service' ? 'service' : 'product'),
            note: typeof raw.note === 'string' ? raw.note : undefined,
        });
    }

    const total_amount = pricedItems.reduce(
        (sum, item) => sum + item.price * item.qty,
        0
    );

    return {
        valid: true,
        items: pricedItems,
        total_amount,
        mismatches: mismatches.length > 0 ? mismatches : undefined,
    };
}

/**
 * Validate if sufficient stock is available for order items
 * Only validates products (type='product'), skips services
 *
 * Accepts an optional SupabaseClient so callers (e.g. the webhook flow) can
 * pass a service-role client and stay consistent with repriceItems.
 */
export async function validateStock(
    items: OrderItem[],
    client?: SupabaseClient
): Promise<StockValidationResult> {
    try {
        const supabase = client || (await createClient());
        const insufficientItems: Array<{ name: string; requested: number; available: number }> = [];

        for (const item of items) {
            // Skip if no product_id (might be service or legacy order)
            if (!item.product_id) continue;

            // Fetch product from database
            const { data: product, error } = await supabase
                .from('products')
                .select('name, type, stock')
                .eq('id', item.product_id)
                .single();

            if (error || !product) {
                console.error(`Product not found: ${item.product_id}`, error);
                continue;
            }

            // Only validate stock for products, skip services
            if (product.type === 'product') {
                if (product.stock < item.qty) {
                    insufficientItems.push({
                        name: product.name,
                        requested: item.qty,
                        available: product.stock
                    });
                }
            }
        }

        if (insufficientItems.length > 0) {
            const itemsText = insufficientItems.map(item =>
                `${item.name} (diminta: ${item.requested}, tersedia: ${item.available})`
            ).join(', ');

            return {
                valid: false,
                insufficientItems,
                message: `Stok tidak mencukupi untuk: ${itemsText}`
            };
        }

        return { valid: true };
    } catch (error) {
        console.error('Error validating stock:', error);
        return {
            valid: false,
            message: 'Gagal memvalidasi stok. Silakan coba lagi.'
        };
    }
}

/**
 * Reduce stock for order items when payment is confirmed
 * Only reduces stock for products (type='product'), skips services
 */
export async function reduceStock(items: OrderItem[]): Promise<{ success: boolean; error?: string }> {
    try {
        const supabase = await createClient();

        for (const item of items) {
            // Skip if no product_id
            if (!item.product_id) continue;

            // Fetch product to check type
            const { data: product, error: fetchError } = await supabase
                .from('products')
                .select('type, stock')
                .eq('id', item.product_id)
                .single();

            if (fetchError || !product) {
                console.error(`Product not found for stock reduction: ${item.product_id}`, fetchError);
                continue;
            }

            // Only reduce stock for products, skip services
            if (product.type === 'product') {
                const newStock = product.stock - item.qty;

                // Prevent negative stock (safety check)
                if (newStock < 0) {
                    console.warn(`Stock would go negative for product ${item.product_id}. Current: ${product.stock}, Requested: ${item.qty}`);
                    // Continue anyway to honor payment, but log warning
                }

                const { error: updateError } = await supabase
                    .from('products')
                    .update({ stock: Math.max(0, newStock) }) // Prevent negative
                    .eq('id', item.product_id);

                if (updateError) {
                    console.error(`Error reducing stock for ${item.product_id}:`, updateError);
                    // Continue with other items
                }
            }
        }

        return { success: true };
    } catch (error) {
        console.error('Error in reduceStock:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Return stock for order items when order is cancelled
 * Reverses the stock reduction
 */
export async function returnStock(items: OrderItem[]): Promise<{ success: boolean; error?: string }> {
    try {
        const supabase = await createClient();

        for (const item of items) {
            // Skip if no product_id
            if (!item.product_id) continue;

            // Fetch product to check type
            const { data: product, error: fetchError } = await supabase
                .from('products')
                .select('type, stock')
                .eq('id', item.product_id)
                .single();

            if (fetchError || !product) {
                console.error(`Product not found for stock return: ${item.product_id}`, fetchError);
                continue;
            }

            // Only return stock for products, skip services
            if (product.type === 'product') {
                const newStock = product.stock + item.qty;

                const { error: updateError } = await supabase
                    .from('products')
                    .update({ stock: newStock })
                    .eq('id', item.product_id);

                if (updateError) {
                    console.error(`Error returning stock for ${item.product_id}:`, updateError);
                    // Continue with other items
                }
            }
        }

        return { success: true };
    } catch (error) {
        console.error('Error in returnStock:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}
