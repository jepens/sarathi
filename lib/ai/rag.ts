import { createClient } from '@/lib/supabase/server';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getActiveSystemMessage } from './system-message';

// Types
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface RAGResponse {
    message: string;
    sources: string[];
}

interface Document {
    id: string;
    content: string;
    metadata: {
        filename?: string;
        source?: string;
        [key: string]: unknown;
    };
    similarity: number;
}

interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    type?: 'product' | 'service';
    similarity: number;
}

export interface OrderItem {
    product_id?: string; // For stock management - matches products.id
    name: string;
    qty: number;
    price: number;
    note?: string;
}

export interface OrderData {
    type: 'product' | 'service';
    items: OrderItem[];
    total_amount: number;
    delivery_info: string;
}

// Helper to generate embedding
async function generateEmbedding(text: string): Promise<number[]> {
    const { getOpenAIApiKey } = await import('@/lib/settings/app-settings');
    const apiKey = await getOpenAIApiKey();

    const openai = new OpenAI({
        apiKey: apiKey,
    });

    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.replace(/\n/g, ' '),
    });

    return response.data[0].embedding;
}

// Helper to update contact name
async function updateContactName(phoneNumber: string, name: string) {
    try {
        const supabase = await createClient();
        const { error } = await supabase
            .from('whatsapp_chats')
            .update({ contact_name: name })
            .eq('phone_number', phoneNumber);

        if (error) throw error;
    } catch (error) {
        console.error('Error updating contact name:', error);
    }
}

// Helper to detect shipping intent
function detectShippingIntent(message: string): boolean {
    const keywords = ['ongkir', 'ongkos kirim', 'biaya kirim', 'pengiriman ke', 'kirim ke'];
    return keywords.some(keyword => message.toLowerCase().includes(keyword));
}

// Helper to extract city name (simplified)
function extractCityName(message: string): string | null {
    // This is a very basic extraction. In production, use an entity extraction model.
    // We look for "ke [City]" or "kirim ke [City]"
    const match = message.match(/(?:ke|di)\s+([a-zA-Z\s]+?)(?:\s|$|\.|,)/i);
    if (match && match[1]) {
        // Filter out common words that might be matched
        const stopWords = ['sana', 'sini', 'mana', 'berapa', 'rumah', 'kantor', 'toko'];
        if (!stopWords.includes(match[1].toLowerCase())) {
            return match[1].trim();
        }
    }
    return null;
}

// Mock function for RajaOngkir search (replace with actual API call)
async function searchDestination(query: string) {
    // In a real app, call RajaOngkir API /city or /subdistrict
    // For now, return mock data
    return [
        { id: 152, label: 'Jakarta Pusat' },
        { id: 151, label: 'Jakarta Barat' },
        { id: 153, label: 'Jakarta Selatan' },
        { id: 444, label: 'Surabaya' },
        { id: 23, label: 'Bandung' },
    ].filter(d => d.label.toLowerCase().includes(query.toLowerCase()));
}

// Mock function for cost calculation (replace with actual API call)
async function calculateMultipleCouriers() {
    // Mock response
    return {
        jne: [
            { service: 'REG', description: 'Layanan Reguler', cost: 10000, etd: '1-2 Hari' },
            { service: 'YES', description: 'Yakin Esok Sampai', cost: 18000, etd: '1 Hari' }
        ],
        sicepat: [
            { service: 'SIUNT', description: 'SiUntung', cost: 9000, etd: '2-3 Hari' },
            { service: 'GOKIL', description: 'Cargo Kilat', cost: 25000, etd: '1-3 Hari' }
        ]
    };
}

/**
 * Helper to create order in database
 * Now includes stock validation before order creation
 */
export async function createOrder(phoneNumber: string, orderData: OrderData) {
    try {
        // STEP 1: Validate stock before creating order
        const { validateStock } = await import('@/lib/inventory/stock');
        const stockValidation = await validateStock(orderData.items);

        if (!stockValidation.valid) {
            console.error('Stock validation failed:', stockValidation.message);
            throw new Error(stockValidation.message || 'Stok tidak mencukupi');
        }

        // STEP 2: Proceed with order creation if stock is valid
        // Use Service Role if available to bypass RLS
        let supabase;
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (supabaseUrl && serviceRoleKey) {
            const { createClient } = await import('@supabase/supabase-js');
            supabase = createClient(supabaseUrl, serviceRoleKey, {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            });
        } else {
            // Fallback to standard server client
            const { createClient } = await import('@/lib/supabase/server');
            supabase = await createClient();
        }

        // Check if contact exists
        const { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('contact_name')
            .eq('phone_number', phoneNumber)
            .single();

        let customerName = chat?.contact_name || 'Unknown';

        // If contact doesn't exist, create it
        if (!chat) {
            const { error: createChatError } = await supabase
                .from('whatsapp_chats')
                .insert({
                    phone_number: phoneNumber,
                    contact_name: 'New Customer',
                    unread_count: 0,
                    last_message: 'Order created via AI',
                    last_message_time: new Date().toISOString()
                });

            if (createChatError) {
                console.error('Error creating new contact:', createChatError);
            } else {
                customerName = 'New Customer';
            }
        }

        const { error } = await supabase
            .from('orders')
            .insert({
                customer_phone: phoneNumber,
                customer_name: customerName,
                items: orderData.items || [],
                total_amount: orderData.total_amount || 0,
                delivery_info: orderData.delivery_info || '',
                order_type: orderData.type || 'product',
                status: 'pending'
            });

        if (error) throw error;
        console.log(`Order created for ${phoneNumber}`);
    } catch (error) {
        console.error('Error creating order:', error);
        // Re-throw error so AI can inform customer
        throw error;
    }
}

export async function generateRAGResponse(message: string, history: ChatMessage[] = [], phoneNumber?: string): Promise<RAGResponse> {
    try {
        // Check if user is asking about shipping cost
        const isShippingQuery = detectShippingIntent(message);
        let shippingContext = '';

        if (isShippingQuery) {
            const cityName = extractCityName(message);

            if (cityName) {
                // Try to get shipping cost
                try {
                    const destinations = await searchDestination(cityName);

                    if (destinations.length > 0) {
                        // Use first destination for simplicity
                        const dest = destinations[0];
                        // Assume origin is Jakarta (ID: 4117) and weight 1kg
                        const costs = await calculateMultipleCouriers();

                        shippingContext = '\n\n--- INFORMASI ONGKIR ---\n';
                        shippingContext += `Tujuan: ${dest.label}\n\n`;

                        for (const [courierName, services] of Object.entries(costs)) {
                            if (services.length > 0) {
                                shippingContext += `${courierName.toUpperCase()}:\n`;
                                services.forEach(service => {
                                    shippingContext += `  - ${service.service} (${service.description}): Rp ${service.cost.toLocaleString('id-ID')} (${service.etd})\n`;
                                });
                                shippingContext += '\n';
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error fetching shipping cost:', error);
                }
            }
        }

        // 1. Generate embedding for the user's message
        const queryEmbedding = await generateEmbedding(message);

        const supabase = await createClient();

        // 2a. Retrieve relevant documents (increased from 3 to 5 for better context)
        const { data: documents, error: docError } = await supabase.rpc('match_documents', {
            query_embedding: queryEmbedding,
            match_threshold: 0.5,
            match_count: 5,
        });

        if (docError) {
            console.error('Error searching documents:', docError);
        }

        // 2b. Retrieve relevant products (increased from 3 to 5 for better coverage)
        const { data: products, error: prodError } = await supabase.rpc('match_products', {
            query_embedding: queryEmbedding,
            match_threshold: 0.5,
            match_count: 5,
        });

        if (prodError) {
            console.error('Error searching products:', prodError);
        }

        const typedDocuments = documents as Document[] | null;
        const typedProducts = products as Product[] | null;

        // 3. Construct the context string
        let contextText = "";

        if (typedProducts && typedProducts.length > 0) {
            contextText += "--- PRODUK YANG TERSEDIA ---\n";
            contextText += typedProducts.map(p =>
                `ID: ${p.id}\nNama: ${p.name}\nDeskripsi: ${p.description}\nHarga: Rp ${p.price.toLocaleString('id-ID')}\nStok: ${p.stock}\nTipe: ${p.type || 'product'}`
            ).join('\n\n');
            contextText += "\n\n";

            // Debug: Log product IDs being sent to AI
            console.log('🔍 Products sent to AI:', typedProducts.map(p => ({ id: p.id, name: p.name })));
        }

        if (typedDocuments && typedDocuments.length > 0) {
            contextText += "--- INFORMASI DOKUMEN ---\n";
            contextText += typedDocuments.map((doc) => {
                const source = doc.metadata?.filename || doc.metadata?.source || 'Unknown';
                return `Sumber: ${source}\nKonten: ${doc.content}`;
            }).join('\n\n');
        }

        // Add shipping context if available
        if (shippingContext) {
            contextText += shippingContext;
        }

        if (!contextText) {
            contextText = "Tidak ada informasi produk atau dokumen yang relevan ditemukan.";
        }

        // 4. Get system message from database
        const baseSystemMessage = await getActiveSystemMessage();

        // Prepare the system prompt with context
        const orderInstruction = `
CRITICAL INSTRUCTION FOR ORDER CREATION:

ORDER CONFIRMATION PROCESS (IMPORTANT):
1. When customer provides order details (product/service + quantity + address), DO NOT create order immediately.
2. First, show a clear order summary in this format:

   📦 Detail Pesanan:
   • [Product/Service Name] - [qty] pcs/unit @ Rp [price]
   • Pengiriman: [delivery address]
   • Total: Rp [total_amount]

3. Then ask: "Apakah detail pesanan sudah benar? Ketik 'Ya' atau 'Konfirmasi' untuk melanjutkan."

4. ONLY create order (using [CREATE_ORDER] tag) AFTER customer explicitly confirms.
   Confirmation keywords: ya, oke, setuju, konfirmasi, lanjutkan, benar, betul

5. If customer says: tidak, batal, salah, ubah → ask what needs to be changed and start over.

6. Be patient. Wait for explicit confirmation. Do NOT create order prematurely.

ORDER TAG FORMAT (use only AFTER confirmation):
[CREATE_ORDER: {"type": "product"|"service", "items": [{"product_id": "uuid", "name": "...", "qty": 1, "price": 0}], "total_amount": 0, "delivery_info": "..."}]

Rules:
1. "items" MUST be an array.
2. Include "product_id" if you can match the product from available products list.
3. Always include "name" even if you have product_id.
4. Estimate price if unknown (can be 0).
`;

        const systemPrompt = `${baseSystemMessage}

${orderInstruction}

Konteks:
${contextText}
`;

        // 5. Initialize OpenAI client with API key from database
        const { getOpenAIApiKey } = await import('@/lib/settings/app-settings');
        const apiKey = await getOpenAIApiKey();

        const openai = new OpenAI({
            apiKey: apiKey,
        });


        // Limit history to avoid token limits
        const recentHistory = history.slice(-4);

        const apiMessages: ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...recentHistory.map((msg) => ({
                role: msg.role,
                content: msg.content
            })),
            { role: 'user', content: message }
        ];

        // 5. Call OpenAI
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: apiMessages,
            temperature: 0.3,
        });

        let responseMessage = completion.choices[0].message.content || 'Maaf, saya tidak dapat memproses permintaan Anda saat ini.';

        // Check for [UPDATE_NAME: ...] tag
        const nameTagRegex = /\[UPDATE_NAME:\s*(.*?)\]/;
        const match = responseMessage.match(nameTagRegex);

        if (match && match[1]) {
            const extractedName = match[1].trim();

            // Update name in database if phoneNumber is provided
            if (phoneNumber) {
                await updateContactName(phoneNumber, extractedName);
            }

            // Remove the tag from the response
            responseMessage = responseMessage.replace(match[0], '').trim();
        }

        // Check for [CREATE_ORDER] tag and process it
        const tagStart = responseMessage.indexOf('[CREATE_ORDER:');
        if (tagStart !== -1) {
            try {
                const jsonStart = responseMessage.indexOf('{', tagStart);
                const tagEnd = responseMessage.lastIndexOf(']');

                if (jsonStart !== -1 && tagEnd !== -1 && tagEnd > jsonStart) {
                    const jsonStr = responseMessage.substring(jsonStart, tagEnd);
                    const orderData = JSON.parse(jsonStr);

                    // Validate order data
                    if (orderData && Array.isArray(orderData.items) && orderData.items.length > 0) {
                        // Debug: Log order data from AI
                        console.log('📦 Order data from AI:', JSON.stringify(orderData, null, 2));

                        if (phoneNumber) {
                            try {
                                await createOrder(phoneNumber, orderData);
                                // Success - remove the tag from response
                                responseMessage = responseMessage.substring(0, tagStart) + responseMessage.substring(tagEnd + 1);
                            } catch (orderError) {
                                // Order creation failed (e.g., insufficient stock)
                                console.error('Order creation failed:', orderError);

                                // Remove the CREATE_ORDER tag
                                responseMessage = responseMessage.substring(0, tagStart) + responseMessage.substring(tagEnd + 1);

                                // Append error message to response
                                const errorMsg = orderError instanceof Error ? orderError.message : 'Gagal membuat pesanan';
                                responseMessage += `\n\n❌ Maaf, pesanan tidak dapat diproses. ${errorMsg}`;
                            }
                        } else {
                            // No phone number - just remove tag
                            responseMessage = responseMessage.substring(0, tagStart) + responseMessage.substring(tagEnd + 1);
                        }
                    } else {
                        console.error('Invalid order data structure:', orderData);
                    }
                }
            } catch (e) {
                console.error('Error parsing CREATE_ORDER tag:', e);
            }
        }

        // Extract unique sources
        const docSources = typedDocuments?.map((doc) => doc.metadata?.filename || doc.metadata?.source).filter(Boolean) as string[] || [];
        const prodSources = typedProducts?.map((p) => `Produk: ${p.name}`) || [];
        const sources = Array.from(new Set([...docSources, ...prodSources]));

        if (shippingContext) {
            sources.push('RajaOngkir API');
        }

        return {
            message: responseMessage,
            sources: sources,
        };

    } catch (error) {
        console.error('Error in generateRAGResponse:', error);
        throw error;
    }
}
