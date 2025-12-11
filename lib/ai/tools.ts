import { createClient } from '@/lib/supabase/server';
import { ChatCompletionTool } from 'openai/resources/chat/completions';

// --- Tool Definitions (JSON Schema for OpenAI) ---

export const stockTools: ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'check_availability',
            description: 'Check the real-time stock availability and price of a specific product. Use this when the user asks about stock, availability, or price of a specific item.',
            parameters: {
                type: 'object',
                properties: {
                    product_name: {
                        type: 'string',
                        description: 'The name of the product to check (e.g. "Kopi Arabica", "Kaos Polos"). Fuzzy match is supported.',
                    },
                },
                required: ['product_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_products',
            description: 'List available products in the catalog. Use this when the user asks "what do you sell?", "show me your products", or asks for recommendations without specifying a product.',
            parameters: {
                type: 'object',
                properties: {
                    category: {
                        type: 'string',
                        description: 'Optional category filter (e.g. "coffee", "clothes"). currently not fully implemented, but good to capture.',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of products to return. Default is 10.',
                    }
                },
            },
        },
    },
];

// --- Tool Execution Logic ---

export async function checkAvailability(productName: string) {
    try {
        const supabase = await createClient();

        // Use text search or ilike for fuzzy matching
        // We'll use ilike with wildcards for simplicity and broad matching
        const { data: products, error } = await supabase
            .from('products')
            .select('id, name, price, stock, type, description')
            .ilike('name', `%${productName}%`)
            .limit(5);

        if (error) throw error;

        if (!products || products.length === 0) {
            return JSON.stringify({
                message: `Maaf, produk dengan nama "${productName}" tidak ditemukan.`,
                found: false
            });
        }

        // Format the output for the AI
        const result = products.map(p => ({
            id: p.id,
            name: p.name,
            price: p.price,
            stock: p.type === 'service' ? 'Unlimited' : p.stock,
            type: p.type,
            description: p.description
        }));

        return JSON.stringify({
            found: true,
            products: result
        });

    } catch (error) {
        console.error('Error in checkAvailability:', error);
        return JSON.stringify({ error: 'Failed to check availability' });
    }
}

export async function listProducts(limit: number = 10) {
    try {
        const supabase = await createClient();

        const { data: products, error } = await supabase
            .from('products')
            .select('id, name, price, stock, type')
            .limit(limit);

        if (error) throw error;

        if (!products || products.length === 0) {
            return JSON.stringify({
                message: "Belum ada produk di katalog.",
                products: []
            });
        }

        const result = products.map(p => ({
            name: p.name,
            price: p.price,
            stock: p.type === 'service' ? 'Unlimited' : p.stock,
            type: p.type
        }));

        return JSON.stringify({
            products: result
        });

    } catch (error) {
        console.error('Error in listProducts:', error);
        return JSON.stringify({ error: 'Failed to list products' });
    }
}
