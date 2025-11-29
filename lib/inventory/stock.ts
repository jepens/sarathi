import { createClient } from '@/lib/supabase/server';

/**
 * Stock Management Module
 * Handles inventory validation, reduction, and restoration
 */

export interface OrderItem {
    product_id?: string;
    name: string;
    qty: number;
    price?: number;
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

/**
 * Validate if sufficient stock is available for order items
 * Only validates products (type='product'), skips services
 */
export async function validateStock(items: OrderItem[]): Promise<StockValidationResult> {
    try {
        const supabase = await createClient();
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
