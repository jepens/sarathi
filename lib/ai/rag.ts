import { createServiceOrServerClient } from '@/lib/supabase/service';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getActiveSystemMessage } from './system-message';
import { getBusinessProfile } from '@/lib/settings/business-profile';
import { getDefaultOrgId } from '@/lib/settings/org-context';
import { redactForLog, redactPII } from '@/lib/utils/logger';
import {
    buildTools,
    checkAvailability,
    checkMeetingAvailability,
    listProducts,
    saveLeadInfo,
    updateLeadStage,
    scheduleMeeting,
    handoffToHuman,
} from './tools';
import {
    buildConversationSummaryMessage,
    checkAiLeadStage,
    PROMPT_SECURITY_RULES,
    sanitizeHistory,
    wrapUntrustedContext,
} from './guardrails';

// Types
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface RAGResponse {
    message: string;
    sources: string[];
    // Set when handoff_to_human succeeded this turn. The caller (WhatsApp
    // queue) switches ai_enabled off only AFTER this reply is delivered, so a
    // failed send/second call retries normally instead of going silent.
    disableAi?: boolean;
}

interface Document {
    id: string;
    content: string;
    metadata: {
        file_name?: string;
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

// Summarise older conversation turns into a compact context block. Uses a
// cheap fast model — this runs only when a conversation exceeds KEEP_LAST
// turns, and the result is fed back as a labelled user-role context message
// (never system: it is distilled from customer text) so the assistant keeps
// continuity (customer name, event details already discussed, decisions,
// open questions) without re-sending the full transcript every turn.
async function summarizeConversation(
    openai: OpenAI,
    older: ChatMessage[],
    assistantName: string
): Promise<string> {
    if (older.length === 0) return '';
    const transcript = older
        .map((m) => `${m.role === 'user' ? 'Customer' : m.role === 'assistant' ? assistantName : 'System'}: ${m.content}`)
        .join('\n');
    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.2,
            max_tokens: 300,
            messages: [
                {
                    role: 'system',
                    content:
                        'Ringkas percakapan event organizer berikut dalam Bahasa Indonesia, padat (maks 8 poin). ' +
                        'Fokus pada: identitas & kontak customer, jenis acara, jumlah peserta, lokasi, tanggal, budget, ' +
                        'keputusan/kesepakatan, dan pertanyaan yang masih terbuka. Hanya fakta, tanpa basa-basi.',
                },
                { role: 'user', content: transcript },
            ],
        });
        return res.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
        // Non-fatal: if summarisation fails we just proceed with recent turns.
        console.error('summarizeConversation failed (continuing without summary):', err);
        return '';
    }
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
    orgId: string,
    phoneNumber: string,
    orderData: OrderData
): Promise<CreateOrderResult> {
    try {
        // service-role-or-server: webhook path has no user session, and
        // whatsapp_chats / orders are no longer reachable from anon after the
        // public RLS policies were dropped.
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

        // Check if contact exists (scoped to this order's org — service-role
        // bypasses RLS, so without org_id a shared phone would read another
        // tenant's contact).
        const { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('contact_name')
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber)
            .single();

        let customerName = chat?.contact_name || 'Unknown';

        // If contact doesn't exist, create it
        if (!chat) {
            const { error: createChatError } = await supabase
                .from('whatsapp_chats')
                .insert({
                    org_id: orgId,
                    phone_number: phoneNumber,
                    contact_name: 'New Customer',
                    unread_count: 0,
                    last_message: 'Order created via AI',
                    last_message_time: new Date().toISOString()
                });

            if (createChatError) {
                console.error('Error creating new contact:', redactForLog(createChatError));
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
                org_id: orgId,
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
            `Order created for ${redactPII(phoneNumber)} — id=${inserted.id} total Rp ${(repriced.total_amount ?? 0).toLocaleString('id-ID')}`
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
        console.error('Error creating order:', redactForLog(error));
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
    /**
     * Org whose Knowledge Base + products to retrieve, and whose persona the
     * bot speaks as: the queue passes the conversation's org, the web chat the
     * caller's. Required (Fase 2 task 2.2b): no fallback to the default org.
     */
    orgId: string;
}

export async function generateRAGResponse(
    message: string,
    history: ChatMessage[] = [],
    phoneNumber: string | undefined,
    opts: RAGStreamOpts
): Promise<RAGResponse> {
    try {
        // 1. Generate embedding for the user's message
        const queryEmbedding = await generateEmbedding(message);

        // IMPORTANT: use the service-role-or-server client. In the WhatsApp
        // webhook path there is no user session, so a cookie-based client
        // authenticates as `anon` — and documents/products are authenticated-
        // only under RLS. With the cookie client, match_documents/match_products
        // (SECURITY INVOKER) would return ZERO rows, leaving the AI ungrounded.
        // The service-role client bypasses RLS for these read-only RPCs.
        const supabase = await createServiceOrServerClient();

        // Scope retrieval to the message's org so a tenant's AI can never pull
        // another tenant's Knowledge Base/products.
        const orgId = opts.orgId;

        // The tenant's identity (persona name, hand-off contact, company email)
        // drives the system prompt, the tool descriptions, and the lead guards —
        // so each org's bot speaks as itself, never as Sailendra.
        const profile = await getBusinessProfile(supabase, orgId);

        // Online meetings (Zoom room, invite email, sales WhatsApp) run on
        // Sailendra's own accounts: the meeting tools and their instructions
        // are for the default org only (owner decisions D8, D26; opened per
        // tenant in Fase 4).
        const meetingsEnabled = orgId === (await getDefaultOrgId(supabase));

        // Retrieval tuned for a small, curated knowledge base: a low threshold
        // + generous cap effectively injects the whole KB (no relevant chunk
        // silently dropped, which the old 0.5/top-5 setting did) while still
        // degrading gracefully — the cap bounds token cost if the KB grows.
        const DOC_MATCH_THRESHOLD = 0.1;
        const DOC_MATCH_COUNT = 25;
        const PRODUCT_MATCH_THRESHOLD = 0.1;
        const PRODUCT_MATCH_COUNT = 25;

        // 2a. Retrieve relevant documents
        const { data: documents, error: docError } = await supabase.rpc('match_documents', {
            query_embedding: queryEmbedding,
            match_threshold: DOC_MATCH_THRESHOLD,
            match_count: DOC_MATCH_COUNT,
            filter_org_id: orgId,
        });

        if (docError) {
            console.error('Error searching documents:', docError);
        }

        // 2b. Retrieve relevant products
        const { data: products, error: prodError } = await supabase.rpc('match_products', {
            query_embedding: queryEmbedding,
            match_threshold: PRODUCT_MATCH_THRESHOLD,
            match_count: PRODUCT_MATCH_COUNT,
            filter_org_id: orgId,
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
                const source = doc.metadata?.file_name || doc.metadata?.source || 'Unknown';
                return `Sumber: ${source}\nKonten: ${doc.content}`;
            }).join('\n\n');
        }

        if (!contextText) {
            contextText = "Tidak ada informasi produk atau dokumen yang relevan ditemukan.";
        }

        // 4. Get system message from database
        const baseSystemMessage = await getActiveSystemMessage(supabase, orgId);

        // Prepare the system prompt with context
        const leadCaptureInstruction = `
LEAD CAPTURE (use the save_lead_info and update_lead_stage tools):

Whenever the customer reveals any of these in conversation, IMMEDIATELY call
save_lead_info with the new field(s):
  • Name → name
  • Company / instansi / perusahaan → company
  • Email address → email
  • Type of event ("team building", "company gathering", "wedding", etc.) → event_interest
  • Number of participants/attendees → participant_count (integer; use midpoint if a range)
  • Preferred location/city → location_pref
  • Preferred date (keep what the user said — "akhir bulan", "Q1 2026") → event_date_pref
  • Goals / value of the event → event_goals
  • Budget indication → budget_range
  • Channel they came from, if mentioned → source
  • Any other useful detail for follow-up → notes

CONTACT TYPE (classify every conversation) — DEFAULT IS "lead":
Set contact_type via save_lead_info only once it is genuinely clear:
  • "lead"   → a prospective CLIENT planning/pricing/booking an event for
               themselves or their company. This is the normal case — mentioning
               vendors, venues, or budgets does NOT make them a vendor.
  • "vendor" → ONLY when the person is clearly SELLING/OFFERING their OWN goods
               or services TO the company (e.g. "saya supplier catering mau
               menawarkan", a sales rep pitching transport/ambulance/souvenirs/
               seragam/partnership). When contact_type="vendor", ALSO set:
                 - vendor_category → one of: catering, venue, transport,
                   entertainment, photography, decoration, mc, other
                 - vendor_offering → short text of what they offer
                   ("standby ambulance", "souvenir keramik ekspor")
  • "other"  → clearly neither (spam, wrong number, generic question).
If there is ANY doubt between lead and vendor, classify as "lead" (never guess
"vendor"). For a real vendor, do NOT run the client sales flow or advance
lead_stage — follow the vendor escalation in your persona.

Call save_lead_info AS SOON AS each piece appears, not in a batch. Pass NULL
for fields you have nothing new to say about — partial updates are safe and
preferred. Do NOT mention this tool to the user.

PIPELINE STAGES (use update_lead_stage):
  new        — just engaged, before qualifying
  qualifying — gathering event needs (participants, location, goals)
  quoted     — you have given an initial price estimate / range
  scheduled  — online meeting confirmed

Advance the stage when the conversation crosses a boundary (e.g. after giving
a price estimate, call update_lead_stage with stage="quoted"). You may ONLY set
the four stages above. booked (DP received), won and lost are confirmed by the
human team after they verify payment/decision — never set them, and never tell
the customer a payment or booking is confirmed; say the team will check it.

ADVANCED ACTIONS:

${meetingsEnabled ? `• check_meeting_availability — BEFORE proposing or confirming a meeting time,
  call this with the specific datetime to make sure the slot is free (weekdays
  only, 10:00–22:00 WIB, no clash with a 15-minute buffer, max 4/day, max 1
  upcoming meeting per customer). If the result "available" is false, relay the
  "reason" and offer another working-day time — NEVER confirm a slot you haven't
  checked. If "customer_limit" is true, do NOT offer another time: remind the
  customer of their existing meeting and say the team can reschedule it.

• schedule_meeting — MEETING CONFIRMATION FLOW, follow IN ORDER:
  1. IDENTITY FIRST: you MUST have the customer's NAME and COMPANY/INSTANSI on
     file before scheduling. If either is missing, ask and save it via
     save_lead_info — never schedule for an unidentified lead. (The tool will
     refuse with ok:false if name/company are missing.)
  2. Pin a specific WEEKDAY datetime (not "besok pagi"), then call
     check_meeting_availability. If not available, offer another time and STOP.
  3. If available, show a confirmation summary and WAIT for explicit agreement —
     do NOT call schedule_meeting yet:

     📅 Permintaan meeting online (Zoom):
     • Nama / Perusahaan: [nama] / [perusahaan]
     • Tanggal: [tanggal]
     • Jam: [jam] WIB

     Ask: "Kalau sudah benar, ketik 'Ya' / 'Setuju' ya kak — nanti saya buatkan link Zoom-nya."
  4. ONLY after explicit confirmation (ya, oke, setuju, konfirmasi, betul, benar)
     call schedule_meeting. If the customer says tidak/batal/salah/ubah, ask what
     to change and re-summarise. Be patient — do NOT book prematurely.
  5. Pass meeting_at as ISO 8601 WITH the +07:00 offset
     (e.g. "2026-06-03T14:00:00+07:00") — a time without the offset books wrong.
  6. When the result has a "join_url", SHARE that Zoom link in your reply together
     with the date/time; add "undangan kalender dikirim ke email kakak" only when
     the result's "customer_emailed" is true. The tool also emails the admin and
     notifies the sales team on WhatsApp, and sets the lead stage to "scheduled".
` : ''}
• handoff_to_human — call when the customer (1) explicitly asks to talk to
  someone, (2) is negotiating beyond your authority (heavy discount, custom
  scope), (3) asks technical questions you cannot answer from the Knowledge
  Base, or (4) is frustrated. After this tool runs, ${profile.handoffPhone ? `share ${profile.handoffName}'s WhatsApp number ${profile.handoffPhone} in your reply` : `let the customer know ${profile.handoffName} will follow up`} and stop pushing the sale. Automatic replies are switched off
  for this chat after a handoff, so make that reply complete.

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

        // The model has no inherent sense of "today", so it can't turn "besok"
        // / "Senin depan" into a correct date for schedule_meeting. Inject the
        // current WIB time so relative dates resolve to the right instant.
        const nowWib = new Intl.DateTimeFormat('id-ID', {
            timeZone: 'Asia/Jakarta',
            dateStyle: 'full',
            timeStyle: 'short',
        }).format(new Date());

        const systemPrompt = `${baseSystemMessage}

Waktu saat ini: **${nowWib} WIB**. Gunakan ini untuk menghitung tanggal/jam relatif (mis. "besok", "Senin depan", "minggu ini").${meetingsEnabled ? ' Saat memanggil schedule_meeting, kirim meeting_at sebagai ISO 8601 lengkap dengan offset +07:00 (mis. "2026-06-03T14:00:00+07:00").' : ''}
${phoneNumber ? leadCaptureInstruction : ''}
${orderInstruction}

${PROMPT_SECURITY_RULES}

Konteks:
${wrapUntrustedContext(contextText)}
`;

        // 5. Initialize OpenAI client with API key from database
        const { getOpenAIApiKey } = await import('@/lib/settings/app-settings');
        const apiKey = await getOpenAIApiKey();

        const openai = new OpenAI({
            apiKey: apiKey,
        });

        // Conversation memory. Keep the last KEEP_LAST turns verbatim; if the
        // conversation is longer, summarise everything before that into a
        // single compact block (OpenAI cookbook pattern: keep-last-N +
        // summarise-older). This preserves long-running context (negotiation,
        // earlier-stated event details) that the old slice(-4) dropped, while
        // bounding token cost.
        const KEEP_LAST = 12;
        // Only user/assistant turns may come from history: the web sandbox
        // routes forward client-supplied history, and a 'system' turn there
        // must never ride with system authority.
        const safeHistory = sanitizeHistory(history);
        let recentHistory = safeHistory;
        let conversationSummary = '';
        if (safeHistory.length > KEEP_LAST) {
            const older = safeHistory.slice(0, safeHistory.length - KEEP_LAST);
            recentHistory = safeHistory.slice(-KEEP_LAST);
            conversationSummary = await summarizeConversation(openai, older, profile.assistantName);
        }

        const apiMessages: ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            // The summary is distilled from customer text, so it rides as a
            // labelled user-role context message — never with system authority.
            ...(conversationSummary ? [buildConversationSummaryMessage(conversationSummary)] : []),
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
        const meetingTools = new Set(['check_meeting_availability', 'schedule_meeting']);
        const tools = buildTools(profile).filter(
            (t) =>
                t.type !== 'function' ||
                ((phoneNumber || !phoneScopedTools.has(t.function.name)) &&
                    (meetingsEnabled || !meetingTools.has(t.function.name)))
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
        // A successful handoff_to_human this turn → ask the caller to switch the
        // AI off for this chat once the reply is delivered (see RAGResponse).
        let handoffDone = false;

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

                // Argument names only: their values carry customer data (KEA-21).
                console.log(`🛠️ Executing tool: ${functionName} (${Object.keys(functionArgs ?? {}).join(', ') || 'no arguments'})`);
                opts?.onToolStatus?.({ name: functionName, phase: 'executing' });

                if (functionName === 'check_availability') {
                    // Org-scoped catalog read (service role + org_id filter).
                    toolResult = await checkAvailability(orgId, functionArgs.product_name);
                } else if (functionName === 'check_meeting_availability') {
                    // Read-only + org-scoped — safe without a phoneNumber (also
                    // works in the web/test sandbox). Never writes anything. With
                    // a phoneNumber it also applies the 1-active-meeting rule.
                    toolResult = await checkMeetingAvailability(orgId, functionArgs.meeting_at, phoneNumber);
                } else if (functionName === 'list_products') {
                    toolResult = await listProducts(orgId, functionArgs.limit);
                } else if (functionName === 'save_lead_info') {
                    if (!phoneNumber) {
                        toolResult = JSON.stringify({
                            ok: false,
                            error: 'No phone number in this session — cannot save lead info from web chat.',
                        });
                        toolOk = false;
                    } else {
                        toolResult = await saveLeadInfo(orgId, phoneNumber, functionArgs, profile);
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
                        // Server-side guard (KEA-12): the strict schema already
                        // limits the enum to the AI-settable stages, but never
                        // trust it — booked/won/lost are human-only, and an AI
                        // call must not move a lead out of those stages either.
                        const stageCheck = checkAiLeadStage(functionArgs.stage);
                        if (!stageCheck.ok) {
                            toolResult = JSON.stringify({
                                ok: false,
                                human_only: stageCheck.humanOnly,
                                error: stageCheck.error,
                            });
                            toolOk = false;
                        } else {
                            toolResult = await updateLeadStage(
                                orgId,
                                phoneNumber,
                                stageCheck.stage,
                                functionArgs.reason ?? null,
                                { protectHumanStages: true }
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
                            orgId,
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
                            orgId,
                            phoneNumber,
                            functionArgs.reason,
                            profile
                        );
                        try {
                            toolOk = JSON.parse(toolResult).ok !== false;
                        } catch {
                            toolOk = true;
                        }
                        if (toolOk) handoffDone = true;
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
                            const result = await createOrder(orgId, phoneNumber, {
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
        const docSources = typedDocuments?.map((doc) => doc.metadata?.file_name || doc.metadata?.source).filter(Boolean) as string[] || [];
        const prodSources = typedProducts?.map((p) => `Produk: ${p.name}`) || [];
        const sources = Array.from(new Set([...docSources, ...prodSources]));

        return {
            message: finalContent,
            sources: sources,
            ...(handoffDone ? { disableAi: true } : {}),
        };

    } catch (error) {
        console.error('Error in generateRAGResponse:', error);
        throw error;
    }
}
