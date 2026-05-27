import { createClient } from '@/lib/supabase/server';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { ChatCompletionTool } from 'openai/resources/chat/completions';

// Lead pipeline stages — kept in sync with the CHECK constraint on
// whatsapp_chats.lead_stage (see migration 0002_eo_pivot_schema.sql).
export const LEAD_STAGES = [
    'new',
    'qualifying',
    'quoted',
    'scheduled',
    'booked',
    'won',
    'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

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
    {
        type: 'function',
        function: {
            name: 'create_order',
            description:
                'Create a new order in the database. Call this ONLY AFTER the customer has explicitly confirmed the order summary (e.g., replies "Ya", "Konfirmasi", "Oke"). The server re-prices every item from the products table and computes the total — any price you supply would be ignored, so do not include one. If the customer has not confirmed yet, do not call this tool; instead show them an order summary and ask for confirmation first.',
            strict: true,
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['product', 'service'],
                        description:
                            'Whether the order is for physical products (stock-tracked) or services (unlimited).',
                    },
                    items: {
                        type: 'array',
                        description:
                            'List of line items. Each item MUST reference a real catalog UUID. Use check_availability or list_products first if you do not have one.',
                        items: {
                            type: 'object',
                            properties: {
                                product_id: {
                                    type: 'string',
                                    description:
                                        'UUID of a product/service from the catalog. Required. Server rejects unknown ids.',
                                },
                                qty: {
                                    type: 'integer',
                                    description: 'Quantity ordered. Must be a positive integer.',
                                },
                            },
                            required: ['product_id', 'qty'],
                            additionalProperties: false,
                        },
                    },
                    delivery_info: {
                        type: 'string',
                        description:
                            'Free-text delivery address for products, or meeting place / link for services.',
                    },
                },
                required: ['type', 'items', 'delivery_info'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'save_lead_info',
            description:
                'Save or update structured lead/contact details whenever the customer reveals them in conversation — their name, email, event interest, participant count, location, preferred date, goals, or budget. Idempotent: safe to call repeatedly with partial info; the server only updates the fields you provide and leaves the rest untouched. Call this AS SOON AS each piece of info appears — do not batch or wait until the end of the conversation.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: ['string', 'null'],
                        description: 'Customer first name or full name as they introduced themselves.',
                    },
                    email: {
                        type: ['string', 'null'],
                        description: 'Customer email address (must look like a valid email).',
                    },
                    event_interest: {
                        type: ['string', 'null'],
                        description: 'Short label for what kind of event they want — e.g. "team building", "company gathering", "capacity building", "wedding".',
                    },
                    participant_count: {
                        type: ['integer', 'null'],
                        description: 'Approximate number of participants/attendees. Round to a single number even if they gave a range (use the midpoint).',
                    },
                    location_pref: {
                        type: ['string', 'null'],
                        description: 'Preferred event location/city — e.g. "Bandung", "Jabodetabek", "Bali".',
                    },
                    event_date_pref: {
                        type: ['string', 'null'],
                        description: 'Preferred event date — free-form ("akhir bulan", "Q1 2026", "15 Maret 2026"). Do NOT convert to ISO; keep what the user said.',
                    },
                    event_goals: {
                        type: ['string', 'null'],
                        description: 'Goals / value the client wants from the event — e.g. "memperkuat kolaborasi tim", "celebrate 10th anniversary".',
                    },
                    budget_range: {
                        type: ['string', 'null'],
                        description: 'Budget indication, free-form — e.g. "Rp 50jt", "150rb per orang", "belum ditentukan".',
                    },
                    source: {
                        type: ['string', 'null'],
                        description: 'How the lead found us, if mentioned: "whatsapp" | "instagram" | "referral" | "website" | other free-form.',
                    },
                    notes: {
                        type: ['string', 'null'],
                        description: 'Free-form note worth remembering for follow-up — preferences, constraints, special requests.',
                    },
                },
                required: [
                    'name', 'email', 'event_interest', 'participant_count',
                    'location_pref', 'event_date_pref', 'event_goals',
                    'budget_range', 'source', 'notes',
                ],
                additionalProperties: false,
            },
            strict: true,
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_lead_stage',
            description:
                'Advance the lead through the sales pipeline. Stages: "new" (just contacted) → "qualifying" (gathering needs) → "quoted" (price estimate given) → "scheduled" (online meeting booked) → "booked" (DP received, event confirmed) → "won" (event completed & paid) | "lost" (declined / went cold). Call this when the conversation crosses a stage boundary — for example, after you have given an initial price estimate, call with stage="quoted".',
            parameters: {
                type: 'object',
                properties: {
                    stage: {
                        type: 'string',
                        enum: [...LEAD_STAGES],
                        description: 'New pipeline stage for this contact.',
                    },
                    reason: {
                        type: ['string', 'null'],
                        description: 'Short reason for the transition — useful for "lost" or "won" or any non-obvious jump. Pass null if no reason needed.',
                    },
                },
                required: ['stage', 'reason'],
                additionalProperties: false,
            },
            strict: true,
        },
    },
    {
        type: 'function',
        function: {
            name: 'schedule_meeting',
            description:
                'Book an online consultation meeting with the human sales lead (MJ). Call this AFTER you have confirmed a specific date/time with the customer AND collected their email. The meeting is added to the company calendar; an actual meeting link is provisioned by the admin after the booking. On success, also call update_lead_stage with stage="scheduled".',
            parameters: {
                type: 'object',
                properties: {
                    meeting_at: {
                        type: 'string',
                        description:
                            'Meeting start time as ISO 8601 datetime in Asia/Jakarta (e.g. "2026-06-03T14:00:00+07:00"). MUST be a real future datetime — do NOT use placeholders like "TBD". If the customer only gave a vague time ("besok pagi"), pin it down first.',
                    },
                    notes: {
                        type: ['string', 'null'],
                        description:
                            'Optional context for MJ — what the customer wants to discuss (event type, peserta count, budget). Helps MJ prepare. Pass null if nothing extra to add.',
                    },
                },
                required: ['meeting_at', 'notes'],
                additionalProperties: false,
            },
            strict: true,
        },
    },
    {
        type: 'function',
        function: {
            name: 'handoff_to_human',
            description:
                'Escalate this conversation to MJ (Mang Jajang, the human Lead Consultant) when: (1) the customer asks to speak with someone directly, (2) negotiation requires authority you do not have (heavy discount, custom scope), (3) technical questions outside your knowledge, or (4) the customer is frustrated. This sets assigned_to="MJ" on the lead and adds a note. After calling this tool, share MJ\'s WhatsApp number (+62 812-8195-8110) in your reply and stop trying to close the sale yourself.',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description:
                            'Why this lead needs MJ — e.g. "customer asking for >20% discount", "wants to discuss custom event format", "frustrated with response time".',
                    },
                },
                required: ['reason'],
                additionalProperties: false,
            },
            strict: true,
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

// --- Lead capture executors --------------------------------------------------

export interface SaveLeadInfoArgs {
    name?: string | null;
    email?: string | null;
    event_interest?: string | null;
    participant_count?: number | null;
    location_pref?: string | null;
    event_date_pref?: string | null;
    event_goals?: string | null;
    budget_range?: string | null;
    source?: string | null;
    notes?: string | null;
}

/**
 * Persist whatever lead fields the AI extracted from the conversation.
 *
 * Behaviour:
 *  - Only fields with a non-null/non-empty value are written; nulls from the
 *    model mean "I have nothing new to say about this field", not "clear it".
 *  - Upserts the row by phone_number so a brand-new lead is created if
 *    whatsapp_chats has no entry yet. (Normal flow inserts the row from the
 *    webhook, but this guards against ordering races.)
 *  - For `name` we also write to the existing `contact_name` column so the
 *    Contacts UI keeps working without UI changes.
 */
export async function saveLeadInfo(
    phoneNumber: string,
    args: SaveLeadInfoArgs
): Promise<string> {
    try {
        // service-role-or-server: called from WhatsApp webhook context (no
        // user cookies) — anon role can no longer touch whatsapp_chats.
        const supabase = await createServiceOrServerClient();

        const patch: Record<string, unknown> = {};
        const clean = (v: unknown) =>
            typeof v === 'string' ? v.trim() : v;

        const maybeSet = (key: string, value: unknown) => {
            const v = clean(value);
            if (v === null || v === undefined) return;
            if (typeof v === 'string' && v === '') return;
            patch[key] = v;
        };

        // contact_name is the legacy column the Contacts UI reads — keep it
        // in sync with the new lead-shaped `name` field.
        if (args.name && args.name.trim()) {
            patch.contact_name = args.name.trim();
        }
        maybeSet('email', args.email);
        maybeSet('event_interest', args.event_interest);
        maybeSet('participant_count', args.participant_count);
        maybeSet('location_pref', args.location_pref);
        maybeSet('event_date_pref', args.event_date_pref);
        maybeSet('event_goals', args.event_goals);
        maybeSet('budget_range', args.budget_range);
        maybeSet('source', args.source);
        maybeSet('notes', args.notes);

        if (Object.keys(patch).length === 0) {
            return JSON.stringify({ ok: true, updated: 0, note: 'no fields to update' });
        }

        patch.phone_number = phoneNumber;
        patch.updated_at = new Date().toISOString();

        const { error } = await supabase
            .from('whatsapp_chats')
            .upsert(patch, { onConflict: 'phone_number' });

        if (error) throw error;

        return JSON.stringify({
            ok: true,
            updated: Object.keys(patch).length - 2, // minus phone_number + updated_at
            fields: Object.keys(patch).filter(
                (k) => k !== 'phone_number' && k !== 'updated_at'
            ),
        });
    } catch (error) {
        console.error('Error in saveLeadInfo:', error);
        const msg = error instanceof Error ? error.message : 'Failed to save lead info';
        return JSON.stringify({ ok: false, error: msg });
    }
}

export async function updateLeadStage(
    phoneNumber: string,
    stage: LeadStage,
    reason?: string | null
): Promise<string> {
    try {
        const supabase = await createServiceOrServerClient();

        const patch: Record<string, unknown> = {
            phone_number: phoneNumber,
            lead_stage: stage,
            updated_at: new Date().toISOString(),
        };
        if (reason && reason.trim()) {
            // Append to notes rather than clobbering — multiple transitions
            // accumulate a useful audit trail for whoever picks up the lead.
            const { data: row } = await supabase
                .from('whatsapp_chats')
                .select('notes')
                .eq('phone_number', phoneNumber)
                .maybeSingle();
            const stamp = new Date().toISOString();
            const line = `[${stamp}] → ${stage}: ${reason.trim()}`;
            patch.notes = row?.notes ? `${row.notes}\n${line}` : line;
        }

        const { error } = await supabase
            .from('whatsapp_chats')
            .upsert(patch, { onConflict: 'phone_number' });

        if (error) throw error;

        return JSON.stringify({ ok: true, stage });
    } catch (error) {
        console.error('Error in updateLeadStage:', error);
        const msg = error instanceof Error ? error.message : 'Failed to update lead stage';
        return JSON.stringify({ ok: false, error: msg });
    }
}

// --- Meeting / handoff / proposal executors ---------------------------------

export async function scheduleMeeting(
    phoneNumber: string,
    meetingAtIso: string,
    notes: string | null
): Promise<string> {
    try {
        const supabase = await createServiceOrServerClient();

        // Validate the ISO datetime here so a malformed value from the model
        // produces a clear error rather than getting written to Postgres and
        // surfacing as a calendar render bug later.
        const meetingDate = new Date(meetingAtIso);
        if (Number.isNaN(meetingDate.getTime())) {
            return JSON.stringify({
                ok: false,
                error: `Invalid meeting_at datetime: ${meetingAtIso}`,
            });
        }
        if (meetingDate.getTime() < Date.now() - 60_000) {
            return JSON.stringify({
                ok: false,
                error: 'meeting_at is in the past. Please pick a future datetime.',
            });
        }

        // Pull the contact's name so the order row is human-readable in the
        // dashboard without a join.
        const { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('contact_name, notes')
            .eq('phone_number', phoneNumber)
            .maybeSingle();

        const customerName = chat?.contact_name ?? 'Klien';

        // Insert as an order row of type=service, status=scheduled. The actual
        // meeting URL is left null — admin fills it in once they generate a
        // Zoom/GMeet link. The calendar still shows the booking time.
        const { data: inserted, error: insertErr } = await supabase
            .from('orders')
            .insert({
                customer_phone: phoneNumber,
                customer_name: customerName,
                items: [],
                total_amount: 0,
                status: 'scheduled',
                order_type: 'service',
                event_date: meetingDate.toISOString(),
                meeting_link: 'pending-link', // sentinel so calendar treats this as 'meetings'
                delivery_info: notes
                    ? `Online meeting — ${notes}`
                    : 'Online meeting (link pending)',
            })
            .select('id')
            .single();

        if (insertErr) throw insertErr;
        if (!inserted) throw new Error('Insert returned no row');

        // Move the lead to 'scheduled' and append an audit line so MJ sees
        // context when they pick up the meeting.
        const stamp = new Date().toISOString();
        const line = `[${stamp}] meeting booked for ${meetingDate.toISOString()}${notes ? ` — ${notes}` : ''}`;
        await supabase
            .from('whatsapp_chats')
            .update({
                lead_stage: 'scheduled',
                notes: chat?.notes ? `${chat.notes}\n${line}` : line,
                updated_at: stamp,
            })
            .eq('phone_number', phoneNumber);

        return JSON.stringify({
            ok: true,
            meeting_id: inserted.id,
            meeting_at: meetingDate.toISOString(),
            stage: 'scheduled',
        });
    } catch (error) {
        console.error('Error in scheduleMeeting:', error);
        const msg = error instanceof Error ? error.message : 'Failed to schedule meeting';
        return JSON.stringify({ ok: false, error: msg });
    }
}

export async function handoffToHuman(
    phoneNumber: string,
    reason: string
): Promise<string> {
    try {
        const supabase = await createServiceOrServerClient();

        const { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('notes')
            .eq('phone_number', phoneNumber)
            .maybeSingle();

        const stamp = new Date().toISOString();
        const line = `[${stamp}] HANDOFF to MJ: ${reason}`;
        const { error } = await supabase
            .from('whatsapp_chats')
            .update({
                assigned_to: 'MJ',
                notes: chat?.notes ? `${chat.notes}\n${line}` : line,
                updated_at: stamp,
            })
            .eq('phone_number', phoneNumber);

        if (error) throw error;

        return JSON.stringify({
            ok: true,
            assigned_to: 'MJ',
            mj_whatsapp: '+62 812-8195-8110',
        });
    } catch (error) {
        console.error('Error in handoffToHuman:', error);
        const msg = error instanceof Error ? error.message : 'Failed to handoff to human';
        return JSON.stringify({ ok: false, error: msg });
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
