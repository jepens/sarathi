import { createClient } from '@/lib/supabase/server';
import { generateEmbedding } from '@/lib/ai/embedding';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { searchDestination, calculateMultipleCouriers } from '@/lib/shipping/rajaongkir';
import { getActiveSystemMessage } from '@/lib/ai/system-message';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface RAGResponse {
    message: string;
    sources: string[];
}

interface Document {
    id: number;
    content: string;
    metadata: {
        filename?: string;
        source?: string;
        [key: string]: unknown;
    };
    similarity: number;
}

interface Product {
    id: number;
    name: string;
    description: string;
    price: number;
    stock: number;
    similarity: number;
}

/**
 * Helper function to detect if user is asking about shipping cost
 */
function detectShippingIntent(message: string): boolean {
    const shippingKeywords = ['ongkir', 'ongkos kirim', 'biaya kirim', 'shipping', 'pengiriman', 'kirim'];
    const lowerMessage = message.toLowerCase();
    return shippingKeywords.some(keyword => lowerMessage.includes(keyword));
}

/**
 * Helper function to extract city name from message
 */
function extractCityName(message: string): string | null {
    // Simple extraction - look for common patterns
    const patterns = [
        /ke\s+([a-z\s]+)/i,
        /tujuan\s+([a-z\s]+)/i,
        /daerah\s+([a-z\s]+)/i,
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match && match[1]) {
            return match[1].trim();
        }
    }

    return null;
}

/**
 * Helper to update contact name in database
 */
async function updateContactName(phoneNumber: string, name: string) {
    try {
        const supabase = await createClient();
        await supabase
            .from('whatsapp_chats')
            .update({ contact_name: name })
            .eq('phone_number', phoneNumber);
        console.log(`Updated contact name for ${phoneNumber} to ${name}`);
    } catch (error) {
        console.error('Error updating contact name:', error);
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
                    const destinations = await searchDestination(cityName, 3);

                    if (destinations.length > 0) {
                        // Use first destination for simplicity
                        const dest = destinations[0];
                        // Assume origin is Jakarta (ID: 4117) and weight 1kg
                        const costs = await calculateMultipleCouriers(4117, dest.id, 1000);

                        shippingContext = '\n\n--- INFORMASI ONGKIR ---\n';
                        shippingContext += `Tujuan: ${dest.label}\n\n`;

                        for (const [, services] of Object.entries(costs)) {
                            if (services.length > 0) {
                                shippingContext += `${services[0].name}:\n`;
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

        // 2a. Retrieve relevant documents
        const { data: documents, error: docError } = await supabase.rpc('match_documents', {
            query_embedding: queryEmbedding,
            match_threshold: 0.5,
            match_count: 3,
        });

        if (docError) {
            console.error('Error searching documents:', docError);
        }

        // 2b. Retrieve relevant products
        const { data: products, error: prodError } = await supabase.rpc('match_products', {
            query_embedding: queryEmbedding,
            match_threshold: 0.5,
            match_count: 3,
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
        const systemPrompt = `${baseSystemMessage}

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

