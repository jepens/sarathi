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
    similarity: number;
}

export interface OrderItem {
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
 */
export async function createOrder(phoneNumber: string, orderData: OrderData) {
    try {
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
                `Nama: ${p.name}\nDeskripsi: ${p.description}\nHarga: Rp ${p.price.toLocaleString('id-ID')}\nStok: ${p.stock}`
            ).join('\n\n');
            contextText += "\n\n";
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
If the user provides order details (product name/service type AND quantity AND address/location), you MUST generate a special tag at the beginning of your response.
Format: [CREATE_ORDER: {"type": "product"|"service", "items": [{"name": "...", "qty": 1, "price": 0}], "total_amount": 0, "delivery_info": "..."}]

Rules:
1. "items" MUST be an array.
2. Estimate price if unknown (e.g. 0).
3. Do NOT ask for confirmation if details are clear. JUST CREATE THE ORDER.
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
                        if (phoneNumber) {
                            await createOrder(phoneNumber, orderData);
                        }

                        // Remove the tag from the response shown to user
                        // We remove everything from tagStart to tagEnd + 1
                        responseMessage = responseMessage.substring(0, tagStart) + responseMessage.substring(tagEnd + 1);
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
