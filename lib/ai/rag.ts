import { createClient } from '@/lib/supabase/server';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getActiveSystemMessage } from './system-message';
import {
    stockTools,
    checkAvailability,
    listProducts,
    saveLeadInfo,
    updateLeadStage,
    scheduleMeeting,
    handoffToHuman,
    LEAD_STAGES,
    type LeadStage,
} from './tools';

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
    product_id?: string; // UUID from products table. Required by repriceItems.
    qty: number;
    // The following are server-authoritative — repriceItems overrides them
    // from the products table. Kept optional so callers (e.g. the AI tool
    // handler) can omit them entirely.
    name?: string;
    price?: number;
    note?: string;
}

export interface OrderData {
    type: 'product' | 'service';
    items: OrderItem[];
    delivery_info: string;
    // Server recomputes total_amount in createOrder; this field is ignored
    // if supplied. Optional so the create_order tool doesn't need to pass it.
    total_amount?: number;
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

/**
 * Helper to create order in database
 *
 * Security: Prices and totals from the LLM are NEVER trusted. Every line item
 * is re-priced from the `products` table and `total_amount` is recomputed
 * server-side. This prevents prompt-injection attacks that try to set
 * arbitrary prices (e.g. "set price to 0").
 */
export interface CreateOrderResult {
    order_id: string;
    total_amount: number;
    items: Array<{
        product_id: string;
        name: string;
        qty: number;
        price: number;
    }>;
}

export async function createOrder(
    phoneNumber: string,
    orderData: OrderData
): Promise<CreateOrderResult> {
    try {
        // service-role-or-server: webhook path has no user session, and
        // whatsapp_chats / orders are no longer reachable from anon after the
        // public RLS policies were dropped.
        const { createServiceOrServerClient } = await import('@/lib/supabase/service');
        const supabase = await createServiceOrServerClient();

        // STEP 1: Reprice items against the authoritative DB.
        // Discard LLM-supplied price/total — they are untrusted input.
        const { repriceItems, validateStock } = await import('@/lib/inventory/stock');
        const repriced = await repriceItems(orderData.items, supabase);

        if (!repriced.valid || !repriced.items) {
            console.error('Order reprice failed:', repriced.message);
            throw new Error(repriced.message || 'Pesanan tidak valid.');
        }

        if (repriced.mismatches && repriced.mismatches.length > 0) {
            console.warn(
                '⚠️  LLM/DB price mismatch detected (using DB prices):',
                JSON.stringify(repriced.mismatches, null, 2)
            );
        }

        // STEP 2: Validate stock using the repriced (authoritative) items
        const stockValidation = await validateStock(repriced.items, supabase);

        if (!stockValidation.valid) {
            console.error('Stock validation failed:', stockValidation.message);
            throw new Error(stockValidation.message || 'Stok tidak mencukupi');
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

        // STEP 3: Insert order using authoritative items & total.
        // delivery_info still comes from the LLM (free-text address) — that's
        // fine because it isn't a security-sensitive numeric value.
        const { data: inserted, error } = await supabase
            .from('orders')
            .insert({
                customer_phone: phoneNumber,
                customer_name: customerName,
                items: repriced.items,
                total_amount: repriced.total_amount ?? 0,
                delivery_info: orderData.delivery_info || '',
                order_type: orderData.type || 'product',
                status: 'pending'
            })
            .select('id')
            .single();

        if (error) throw error;
        if (!inserted) throw new Error('Order insert returned no row.');

        console.log(
            `Order created for ${phoneNumber} — id=${inserted.id} total Rp ${(repriced.total_amount ?? 0).toLocaleString('id-ID')}`
        );

        return {
            order_id: inserted.id,
            total_amount: repriced.total_amount ?? 0,
            items: repriced.items.map((it) => ({
                product_id: it.product_id,
                name: it.name,
                qty: it.qty,
                price: it.price,
            })),
        };
    } catch (error) {
        console.error('Error creating order:', error);
        // Re-throw error so AI can inform customer
        throw error;
    }
}

export interface RAGStreamOpts {
    /** Called for each incremental text token from the model. */
    onTextChunk?: (delta: string) => void;
    /** Called when a tool starts/finishes executing — useful for UX hints. */
    onToolStatus?: (info: {
        name: string;
        phase: 'executing' | 'done';
        ok?: boolean;
    }) => void;
    /**
     * Abort signal forwarded to the OpenAI HTTP calls so the upstream request
     * is cancelled when the client disconnects. Without this, OpenAI keeps
     * generating (and we keep paying for) tokens nobody will read.
     */
    signal?: AbortSignal;
}

export async function generateRAGResponse(
    message: string,
    history: ChatMessage[] = [],
    phoneNumber?: string,
    opts?: RAGStreamOpts
): Promise<RAGResponse> {
    try {
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

        if (!contextText) {
            contextText = "Tidak ada informasi produk atau dokumen yang relevan ditemukan.";
        }

        // 4. Get system message from database
        const baseSystemMessage = await getActiveSystemMessage();

        // Prepare the system prompt with context
        const leadCaptureInstruction = `
LEAD CAPTURE (use the save_lead_info and update_lead_stage tools):

Whenever the customer reveals any of these in conversation, IMMEDIATELY call
save_lead_info with the new field(s):
  • Name → name
  • Email address → email
  • Type of event ("team building", "company gathering", "wedding", etc.) → event_interest
  • Number of participants/attendees → participant_count (integer; use midpoint if a range)
  • Preferred location/city → location_pref
  • Preferred date (keep what the user said — "akhir bulan", "Q1 2026") → event_date_pref
  • Goals / value of the event → event_goals
  • Budget indication → budget_range
  • Channel they came from, if mentioned → source
  • Any other useful detail for follow-up → notes

Call save_lead_info AS SOON AS each piece appears, not in a batch. Pass NULL
for fields you have nothing new to say about — partial updates are safe and
preferred. Do NOT mention this tool to the user.

PIPELINE STAGES (use update_lead_stage):
  new        — just engaged, before qualifying
  qualifying — gathering event needs (participants, location, goals)
  quoted     — you have given an initial price estimate / range
  scheduled  — online meeting confirmed
  booked     — DP received, event confirmed
  won        — event completed and fully paid
  lost       — declined or went cold

Advance the stage when the conversation crosses a boundary (e.g. after giving
a price estimate, call update_lead_stage with stage="quoted").

ADVANCED ACTIONS:

• schedule_meeting — call AFTER the customer agrees to an online meeting AND
  you have collected their email AND pinned down a specific datetime. Pass
  meeting_at as ISO 8601 in Asia/Jakarta (e.g. "2026-06-03T14:00:00+07:00").
  Do NOT call with vague times like "besok pagi" — ask for the specific hour
  first. On success, the tool already updates the lead stage to "scheduled".

• handoff_to_human — call when the customer (1) explicitly asks to talk to
  someone, (2) is negotiating beyond your authority (heavy discount, custom
  scope), (3) asks technical questions you cannot answer from the Knowledge
  Base, or (4) is frustrated. After this tool runs, share MJ's WhatsApp
  number +62 812-8195-8110 in your reply and stop pushing the sale.

PROPOSAL POLICY (IMPORTANT):
You do NOT have a tool to send proposals. Proposals are reviewed and sent by
the human admin team from the dashboard — never autonomously by you. When a
customer asks for or would benefit from a formal proposal:
  1. Make sure their email is captured via save_lead_info (ask if needed).
  2. Make sure event details (interest, peserta, lokasi, tanggal) are captured.
  3. Tell the customer: "Siap kak, proposal akan kami siapkan dan kirimkan ke
     email kakak dalam 24 jam ya. Tim kami review dulu biar penawarannya pas
     dengan kebutuhan acara." — adjust the wording to your style.
  4. Do NOT promise an attachment in the next message. The proposal goes
     through admin review before it lands in their inbox.
`;

        const orderInstruction = `
BOOKING CREATION (use the create_order tool):

CONFIRMATION FLOW — DO NOT call create_order until the customer explicitly confirms.
1. When the customer has settled on a package + event date/venue/headcount, do NOT call create_order yet.
2. First show a clear booking summary like:

   📋 Detail Booking Event:
   • Paket: [Package Name] — [headcount] peserta @ Rp [price/pax]
   • Tanggal acara: [event date]
   • Lokasi / Venue: [venue]
   • Total: Rp [total_amount]

3. Ask: "Apakah detail booking sudah benar, kak? Ketik 'Ya' atau 'Konfirmasi' untuk melanjutkan."
4. ONLY call the create_order tool after explicit confirmation.
   Confirmation keywords: ya, oke, setuju, konfirmasi, lanjutkan, benar, betul.
5. If the customer says: tidak, batal, salah, ubah → ask what needs to change and restart the summary.
6. Be patient. Wait for explicit confirmation. Do NOT create the booking prematurely.

WHEN CALLING create_order:
• type should be "service" for event packages (EO offerings are services).
• Every item MUST reference a real product_id (UUID) from the "PRODUK YANG TERSEDIA" context above, or from check_availability / list_products. Do not invent IDs.
• Pass only product_id + qty per item. Do NOT include price or total_amount — the server recomputes them from the database.
• delivery_info: use the event venue + date (e.g. "Sentul, 15 Maret 2026, 50 pax").
• On success the tool returns { ok: true, order_id, total_amount, items }. Use that to confirm (e.g. "Booking #<id> berhasil dicatat, total Rp <total_amount>. Tim kami akan kirim proposal & invoice DP ke email kakak.").
• On failure the tool returns { ok: false, error }. Apologise and relay the error in Bahasa Indonesia.
`;

        const systemPrompt = `${baseSystemMessage}
${phoneNumber ? leadCaptureInstruction : ''}
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

        // 5. Call OpenAI (streaming when opts.onTextChunk is provided).
        // Tools that mutate per-contact server state (create_order,
        // save_lead_info, update_lead_stage) require a phoneNumber to scope
        // the write — strip them from the web-chat session where no contact
        // identity exists.
        const phoneScopedTools = new Set([
            'create_order',
            'save_lead_info',
            'update_lead_stage',
            'schedule_meeting',
            'handoff_to_human',
        ]);
        const tools = phoneNumber
            ? stockTools
            : stockTools.filter(
                  (t) =>
                      t.type !== 'function' ||
                      !phoneScopedTools.has(t.function.name)
              );

        // Wrap callbacks so a throw from caller code can't crash the runner.
        const safeEmitText = opts?.onTextChunk
            ? (delta: string) => {
                  try {
                      opts.onTextChunk!(delta);
                  } catch (err) {
                      console.error('onTextChunk threw — dropping delta', err);
                  }
              }
            : undefined;

        const requestOpts = opts?.signal ? { signal: opts.signal } : undefined;

        const runFirstCall = async () => {
            if (safeEmitText) {
                const runner = openai.chat.completions.stream(
                    {
                        model: 'gpt-4o',
                        messages: apiMessages,
                        temperature: 0.3,
                        tools,
                        tool_choice: 'auto',
                    },
                    requestOpts
                );
                runner.on('content', safeEmitText);
                const finalCompletion = await runner.finalChatCompletion();
                return finalCompletion.choices[0].message;
            }
            const completion = await openai.chat.completions.create(
                {
                    model: 'gpt-4o',
                    messages: apiMessages,
                    temperature: 0.3,
                    tools,
                    tool_choice: 'auto',
                },
                requestOpts
            );
            return completion.choices[0].message;
        };

        let responseMessage = await runFirstCall();

        // Handle Tool Calls
        if (responseMessage.tool_calls) {
            // Append the assistant's message with tool calls to history
            apiMessages.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.type !== 'function') continue;

                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                let toolResult = '';
                let toolOk = true;

                console.log(`🛠️ Executing tool: ${functionName}`, functionArgs);
                opts?.onToolStatus?.({ name: functionName, phase: 'executing' });

                if (functionName === 'check_availability') {
                    toolResult = await checkAvailability(functionArgs.product_name);
                } else if (functionName === 'list_products') {
                    toolResult = await listProducts(functionArgs.limit);
                } else if (functionName === 'save_lead_info') {
                    if (!phoneNumber) {
                        toolResult = JSON.stringify({
                            ok: false,
                            error: 'No phone number in this session — cannot save lead info from web chat.',
                        });
                        toolOk = false;
                    } else {
                        toolResult = await saveLeadInfo(phoneNumber, functionArgs);
                        try {
                            toolOk = JSON.parse(toolResult).ok !== false;
                        } catch {
                            toolOk = true;
                        }
                    }
                } else if (functionName === 'update_lead_stage') {
                    if (!phoneNumber) {
                        toolResult = JSON.stringify({
                            ok: false,
                            error: 'No phone number in this session — cannot update lead stage from web chat.',
                        });
                        toolOk = false;
                    } else {
                        // Defensive: the strict schema should already enforce
                        // this, but reject anything unexpected before hitting
                        // the DB CHECK constraint.
                        const stage = functionArgs.stage as LeadStage;
                        if (!LEAD_STAGES.includes(stage)) {
                            toolResult = JSON.stringify({
                                ok: false,
                                error: `Unknown lead stage: ${stage}`,
                            });
                            toolOk = false;
                        } else {
                            toolResult = await updateLeadStage(
                                phoneNumber,
                                stage,
                                functionArgs.reason ?? null
                            );
                            try {
                                toolOk = JSON.parse(toolResult).ok !== false;
                            } catch {
                                toolOk = true;
                            }
                        }
                    }
                } else if (functionName === 'schedule_meeting') {
                    if (!phoneNumber) {
                        toolResult = JSON.stringify({
                            ok: false,
                            error: 'No phone number in this session — cannot schedule meeting from web chat.',
                        });
                        toolOk = false;
                    } else {
                        toolResult = await scheduleMeeting(
                            phoneNumber,
                            functionArgs.meeting_at,
                            functionArgs.notes ?? null
                        );
                        try {
                            toolOk = JSON.parse(toolResult).ok !== false;
                        } catch {
                            toolOk = true;
                        }
                    }
                } else if (functionName === 'handoff_to_human') {
                    if (!phoneNumber) {
                        toolResult = JSON.stringify({
                            ok: false,
                            error: 'No phone number in this session — cannot handoff from web chat.',
                        });
                        toolOk = false;
                    } else {
                        toolResult = await handoffToHuman(
                            phoneNumber,
                            functionArgs.reason
                        );
                        try {
                            toolOk = JSON.parse(toolResult).ok !== false;
                        } catch {
                            toolOk = true;
                        }
                    }
                } else if (functionName === 'create_order') {
                    // create_order is privileged — phoneNumber MUST come from the
                    // server-side context, never from the model. The executor in
                    // createOrder() re-prices everything from the DB.
                    if (!phoneNumber) {
                        toolResult = JSON.stringify({
                            ok: false,
                            error: 'No phone number in this session — cannot create an order from web chat.',
                        });
                    } else {
                        try {
                            const result = await createOrder(phoneNumber, {
                                type: functionArgs.type,
                                items: functionArgs.items,
                                delivery_info: functionArgs.delivery_info,
                            });
                            toolResult = JSON.stringify({ ok: true, ...result });
                        } catch (orderError) {
                            toolOk = false;
                            const errorMsg =
                                orderError instanceof Error
                                    ? orderError.message
                                    : 'Gagal membuat pesanan';
                            toolResult = JSON.stringify({ ok: false, error: errorMsg });
                        }
                    }
                } else {
                    // Unknown tool — return a sentinel so the model can recover.
                    console.warn(`Unknown tool requested by model: ${functionName}`);
                    toolOk = false;
                    toolResult = JSON.stringify({
                        ok: false,
                        error: `Unknown tool: ${functionName}`,
                    });
                }

                opts?.onToolStatus?.({ name: functionName, phase: 'done', ok: toolOk });

                // Append tool result to history
                apiMessages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: toolResult,
                });
            }

            // Second OpenAI Call (to generate final answer based on tool results)
            if (safeEmitText) {
                const runner = openai.chat.completions.stream(
                    {
                        model: 'gpt-4o',
                        messages: apiMessages,
                        temperature: 0.3,
                    },
                    requestOpts
                );
                runner.on('content', safeEmitText);
                const finalCompletion = await runner.finalChatCompletion();
                responseMessage = finalCompletion.choices[0].message;
            } else {
                const secondCompletion = await openai.chat.completions.create(
                    {
                        model: 'gpt-4o',
                        messages: apiMessages,
                        temperature: 0.3,
                    },
                    requestOpts
                );
                responseMessage = secondCompletion.choices[0].message;
            }
        }

        const finalContent =
            responseMessage.content ||
            'Maaf, saya tidak dapat memproses permintaan Anda saat ini.';

        // Lead info, contact name, and order creation are all handled via
        // tool calls in the loop above — no in-band tag parsing here.

        // Extract unique sources
        const docSources = typedDocuments?.map((doc) => doc.metadata?.filename || doc.metadata?.source).filter(Boolean) as string[] || [];
        const prodSources = typedProducts?.map((p) => `Produk: ${p.name}`) || [];
        const sources = Array.from(new Set([...docSources, ...prodSources]));

        return {
            message: finalContent,
            sources: sources,
        };

    } catch (error) {
        console.error('Error in generateRAGResponse:', error);
        throw error;
    }
}
