import { createClient } from '@/lib/supabase/server';
import { createServiceOrServerClient } from '@/lib/supabase/service';
import { ChatCompletionTool } from 'openai/resources/chat/completions';
import { type BusinessProfile } from '@/lib/settings/business-profile';
import {
    validateMeetingWindow,
    jakartaDayRangeUtc,
    meetingTitle,
    normalizeMeetingIso,
    MAX_MEETINGS_PER_DAY,
} from '@/lib/meetings/rules';
import { getZoomConfig, createZoomMeeting } from '@/lib/zoom/client';
import { sendMeetingInvite } from '@/lib/meetings/notify';

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

// Built per-tenant: the tool DESCRIPTIONS (what the model reads) are templated
// from the org's business profile, so a tenant's bot references its own
// hand-off contact / company email / assistant name — never Sailendra's. The
// parameter SCHEMAS are identical for every tenant (strict mode only constrains
// `parameters`, not `description`).
export function buildTools(p: BusinessProfile): ChatCompletionTool[] {
    return [
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
                'Save or update structured contact details whenever they are revealed in conversation — name, email, event interest, participant count, location, preferred date, goals, budget, AND whether this contact is a client lead or a vendor (contact_type). Idempotent: safe to call repeatedly with partial info; the server only updates the fields you provide and leaves the rest untouched. Call this AS SOON AS each piece of info appears — do not batch or wait until the end of the conversation.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: ['string', 'null'],
                        description: 'Customer first/full name as they introduced themselves. A bare honorific or greeting ("kak", "kakak", "pak", "bu", "mas", "mbak") is NOT a name — pass null until they give a real name.',
                    },
                    company: {
                        type: ['string', 'null'],
                        description: 'Instansi/perusahaan/organisasi lead (mis. "PT Astra", "Kemenkeu", "Universitas Indonesia"). Untuk acara korporat/instansi. Pass null jika perorangan atau belum disebut.',
                    },
                    email: {
                        type: ['string', 'null'],
                        description: `Customer's OWN email address (must look valid).${p.businessEmail ? ` NEVER pass ${p.businessName}'s own address ${p.businessEmail} — that is the company address ${p.assistantName} hands to vendors, not the customer's.` : ''}`,
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
                    contact_type: {
                        type: ['string', 'null'],
                        description:
                            'Who is this contact? DEFAULT IS "lead". Anyone asking about, planning, pricing, or booking an event for themselves/their company is a "lead" (a CLIENT) — even if they mention vendors or budgets. Only use "vendor" when the person is clearly SELLING/OFFERING their OWN goods or services TO Sailendra (e.g. "saya supplier catering, mau menawarkan paket", a sales rep pitching transport/souvenirs/partnership). "other" = clearly neither (spam, wrong number). If there is ANY doubt between lead and vendor, choose "lead". Pass null if you truly cannot tell yet — do NOT guess "vendor".',
                    },
                    vendor_category: {
                        type: ['string', 'null'],
                        description:
                            'ONLY when contact_type="vendor": the supplier category. One of: "catering", "venue", "transport", "entertainment", "photography", "decoration", "mc", "other". Pass null if not a vendor or category unclear.',
                    },
                    vendor_offering: {
                        type: ['string', 'null'],
                        description:
                            'ONLY when contact_type="vendor": short description of what they offer — e.g. "standby ambulance", "souvenir keramik ekspor", "seragam konveksi". Pass null otherwise.',
                    },
                },
                required: [
                    'name', 'company', 'email', 'event_interest', 'participant_count',
                    'location_pref', 'event_date_pref', 'event_goals',
                    'budget_range', 'source', 'notes',
                    'contact_type', 'vendor_category', 'vendor_offering',
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
                `Book an online consultation meeting with the human sales lead (${p.handoffName}). Call this AFTER you have confirmed a specific date/time (business hours 10:00–22:00 WIB) with the customer. On success the tool reserves the slot, auto-creates a Zoom link, and emails a calendar invite. HOW TO REPLY based on the result JSON: if "join_url" is present, SHARE THAT LINK DIRECTLY in your WhatsApp reply together with the date/time — this is the primary way the customer receives it (do not just say "check your email"); when "customer_emailed" is also true, add that a calendar invite was sent to their email too. If "link_status" is "pending" (no join_url), tell the customer the team will send the link shortly. If it returns ok:false (outside business hours, or that day is already full), apologise and offer another time. On success also call update_lead_stage with stage="scheduled".`,
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
                `Escalate this conversation to ${p.handoffName} (the human Lead Consultant) when: (1) the customer asks to speak with someone directly, (2) negotiation requires authority you do not have (heavy discount, custom scope), (3) technical questions outside your knowledge, or (4) the customer is frustrated. This assigns the lead to the human team and adds a note.${p.handoffPhone ? ` After calling this tool, share ${p.handoffName}'s WhatsApp number (${p.handoffPhone}) in your reply and stop trying to close the sale yourself.` : ' After calling this tool, tell the customer a team member will follow up, and stop trying to close the sale yourself.'}`,
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
}

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
    company?: string | null;
    email?: string | null;
    event_interest?: string | null;
    participant_count?: number | null;
    location_pref?: string | null;
    event_date_pref?: string | null;
    event_goals?: string | null;
    budget_range?: string | null;
    source?: string | null;
    notes?: string | null;
    contact_type?: string | null;
    vendor_category?: string | null;
    vendor_offering?: string | null;
}

// --- Lead-field sanitisers (defense-in-depth) --------------------------------
// The model occasionally mis-attributes Sailendra's OWN contact details to the
// customer — most commonly the email info@sailendra.co.id (the address Nindra
// hands to vendors) — or treats a greeting like "kak"/"pak" as a name. These
// run server-side so a bad save_lead_info call can never write that junk,
// regardless of what the model passes. (Same guardrails as the history
// backfill in scripts/backfill-contacts.mjs.)

// Tokens the model sometimes emits instead of leaving a field null.
const LEAD_JUNK_STRINGS = new Set([
    'null', 'undefined', 'tidak ada', 'tidak disebutkan', 'tidak diketahui',
    'n/a', 'na', '-', '—', 'unknown', 'none',
]);
// Single-word honorifics — greetings, not names.
const NAME_HONORIFICS = new Set([
    'kak', 'kakak', 'kk', 'pak', 'bapak', 'bu', 'ibu', 'mas', 'mbak',
    'sis', 'bro', 'mister', 'mr', 'mrs', 'ms',
]);

function cleanLeadStr(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t) return null;
    if (LEAD_JUNK_STRINGS.has(t.toLowerCase())) return null;
    return t;
}

function cleanLeadName(v: unknown): string | null {
    const n = cleanLeadStr(v);
    if (!n) return null;
    if (n.length < 2) return null; // reject single letters like "P"
    if (NAME_HONORIFICS.has(n.toLowerCase())) return null;
    return n;
}

// Reject the business's OWN email — the address the assistant hands to vendors,
// never a customer's. The company domain comes from the tenant's profile, so
// each tenant guards against its own address (not a hardcoded one).
function cleanLeadEmail(v: unknown, companyDomain: string): string | null {
    const e = cleanLeadStr(v);
    if (!e) return null;
    const low = e.toLowerCase();
    if (companyDomain.length > 1 && low.endsWith(companyDomain)) return null; // company's own address
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(low)) return null; // basic shape
    return e;
}

// Contact classification + vendor category. Kept in sync with the CHECK
// constraints on whatsapp_chats (migration 0017) and public.vendors.category.
const CONTACT_TYPES = new Set(['lead', 'vendor', 'other']);
const VENDOR_CATEGORIES = new Set([
    'catering', 'venue', 'transport', 'entertainment',
    'photography', 'decoration', 'mc', 'other',
]);

function cleanContactType(v: unknown): 'lead' | 'vendor' | 'other' | null {
    const t = cleanLeadStr(v);
    if (!t) return null;
    const low = t.toLowerCase();
    return CONTACT_TYPES.has(low) ? (low as 'lead' | 'vendor' | 'other') : null;
}

function cleanVendorCategory(v: unknown): string | null {
    const t = cleanLeadStr(v);
    if (!t) return null;
    const low = t.toLowerCase();
    return VENDOR_CATEGORIES.has(low) ? low : null;
}

const normalizePhone = (p: string) => (p ?? '').replace(/\D/g, '');

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
    orgId: string,
    phoneNumber: string,
    args: SaveLeadInfoArgs,
    profile: BusinessProfile
): Promise<string> {
    try {
        // The tenant's own hand-off staff is not a customer — skip lead capture
        // so we never tag their number as a lead/vendor.
        const internalNumber = normalizePhone(profile.handoffPhone);
        if (internalNumber && normalizePhone(phoneNumber) === internalNumber) {
            return JSON.stringify({ ok: true, updated: 0, note: 'internal number — lead capture skipped' });
        }

        // service-role-or-server: called from WhatsApp webhook context (no
        // user cookies) — anon role can no longer touch whatsapp_chats.
        const supabase = await createServiceOrServerClient();

        const patch: Record<string, unknown> = {};

        const maybeSet = (key: string, value: unknown) => {
            const v = cleanLeadStr(value);
            if (v === null) return;
            patch[key] = v;
        };

        const cleanedName = cleanLeadName(args.name);
        const incomingType = cleanContactType(args.contact_type);
        const cleanedVendorCategory = cleanVendorCategory(args.vendor_category);
        const cleanedVendorOffering = cleanLeadStr(args.vendor_offering);
        const hasVendorDetail = !!(cleanedVendorCategory || cleanedVendorOffering);

        // Single read of the existing row when we need its current state:
        //  - contact_name_locked  → don't let the AI clobber a manual name.
        //  - contact_type         → don't let the AI downgrade a vendor/other
        //                           classification back to "lead".
        //  - contact_type_locked  → don't let the AI override a human's manual
        //                           classification, nor stamp vendor detail onto
        //                           a contact a human confirmed as non-vendor.
        let existing: {
            contact_name_locked?: boolean;
            contact_type?: string | null;
            contact_type_locked?: boolean;
        } | null = null;
        if (cleanedName || incomingType || hasVendorDetail) {
            const { data } = await supabase
                .from('whatsapp_chats')
                .select('contact_name_locked, contact_type, contact_type_locked')
                .eq('org_id', orgId)
                .eq('phone_number', phoneNumber)
                .maybeSingle();
            existing = data;
        }

        // contact_name — honorific/junk filtered (cleanLeadName) + lock check.
        if (cleanedName && !existing?.contact_name_locked) {
            patch.contact_name = cleanedName;
        }

        // contact_type — respect a manual lock first (a human classified this
        // contact; never let the AI override). Otherwise apply vendor/other
        // freely; only set "lead" when the row isn't already classified, so the
        // AI can't flip a vendor back.
        if (incomingType && !existing?.contact_type_locked) {
            const current = existing?.contact_type ?? 'lead';
            if (incomingType !== 'lead' || current === 'lead') {
                patch.contact_type = incomingType;
            }
        }

        // email: reject the tenant's own company address + malformed values.
        const companyDomain = '@' + (profile.businessEmail.split('@')[1] ?? '').toLowerCase();
        const cleanedEmail = cleanLeadEmail(args.email, companyDomain);
        if (cleanedEmail) patch.email = cleanedEmail;

        // vendor detail — only meaningful for vendors. Skip when a human has
        // locked this contact to a non-vendor type, so we never stamp vendor
        // metadata onto a confirmed client.
        const lockedNonVendor =
            !!existing?.contact_type_locked && existing?.contact_type !== 'vendor';
        if (!lockedNonVendor) {
            if (cleanedVendorCategory) patch.vendor_category = cleanedVendorCategory;
            if (cleanedVendorOffering) patch.vendor_offering = cleanedVendorOffering;
        }

        // participant_count: keep only a positive integer.
        if (
            typeof args.participant_count === 'number' &&
            Number.isFinite(args.participant_count) &&
            args.participant_count > 0
        ) {
            patch.participant_count = Math.round(args.participant_count);
        }

        maybeSet('company', args.company);
        maybeSet('event_interest', args.event_interest);
        maybeSet('location_pref', args.location_pref);
        maybeSet('event_date_pref', args.event_date_pref);
        maybeSet('event_goals', args.event_goals);
        maybeSet('budget_range', args.budget_range);
        maybeSet('source', args.source);
        maybeSet('notes', args.notes);

        if (Object.keys(patch).length === 0) {
            return JSON.stringify({ ok: true, updated: 0, note: 'no fields to update' });
        }

        patch.org_id = orgId;
        patch.phone_number = phoneNumber;
        patch.updated_at = new Date().toISOString();

        const { error } = await supabase
            .from('whatsapp_chats')
            .upsert(patch, { onConflict: 'org_id,phone_number' });

        if (error) throw error;

        return JSON.stringify({
            ok: true,
            updated: Object.keys(patch).length - 3, // minus org_id + phone_number + updated_at
            fields: Object.keys(patch).filter(
                (k) => k !== 'org_id' && k !== 'phone_number' && k !== 'updated_at'
            ),
        });
    } catch (error) {
        console.error('Error in saveLeadInfo:', error);
        const msg = error instanceof Error ? error.message : 'Failed to save lead info';
        return JSON.stringify({ ok: false, error: msg });
    }
}

export async function updateLeadStage(
    orgId: string,
    phoneNumber: string,
    stage: LeadStage,
    reason?: string | null
): Promise<string> {
    try {
        const supabase = await createServiceOrServerClient();

        const patch: Record<string, unknown> = {
            org_id: orgId,
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
                .eq('org_id', orgId)
                .eq('phone_number', phoneNumber)
                .maybeSingle();
            const stamp = new Date().toISOString();
            const line = `[${stamp}] → ${stage}: ${reason.trim()}`;
            patch.notes = row?.notes ? `${row.notes}\n${line}` : line;
        }

        const { error } = await supabase
            .from('whatsapp_chats')
            .upsert(patch, { onConflict: 'org_id,phone_number' });

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
    orgId: string,
    phoneNumber: string,
    meetingAtIso: string,
    notes: string | null
): Promise<string> {
    try {
        const supabase = await createServiceOrServerClient();

        // Normalize the model's datetime to WIB when it omits an offset (a common
        // LLM slip) so a naive value isn't parsed in the host TZ (UTC in prod) and
        // silently booked 7 hours off. Then validate it's a real future datetime.
        const meetingDate = new Date(normalizeMeetingIso(meetingAtIso));
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

        const durationMin = resolveMeetingDuration();

        // Business hours: the meeting must start ≥10:00 and end ≤22:00 WIB.
        const windowCheck = validateMeetingWindow(meetingDate, durationMin);
        if (!windowCheck.ok) {
            return JSON.stringify({ ok: false, error: windowCheck.error });
        }

        // Pull the contact context for the meeting title + invite.
        const { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('contact_name, notes, company, event_interest, email')
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber)
            .maybeSingle();

        const customerName = chat?.contact_name ?? 'Klien';
        // "COMPANY - Event", e.g. "SIEMENS - Employee Gathering 2026".
        const title = meetingTitle(chat?.company, chat?.event_interest, customerName);
        const deliveryInfo = notes ? `Online meeting — ${notes}` : 'Online meeting';

        // Reserve the slot ATOMICALLY — enforces max 4/WIB-day even under
        // concurrent bookings (migration 0054 counts + inserts under an advisory
        // lock). Returns the new row's id, or null when the day is already full.
        // Done BEFORE creating the Zoom room so a full day never wastes one.
        const { startUtcIso, endUtcIso } = jakartaDayRangeUtc(meetingDate);
        const { data: reservedId, error: reserveErr } = await supabase.rpc('reserve_meeting_slot', {
            p_org: orgId,
            p_phone: phoneNumber,
            p_name: customerName,
            p_event_date: meetingDate.toISOString(),
            p_delivery_info: deliveryInfo,
            p_day_start: startUtcIso,
            p_day_end: endUtcIso,
            p_max: MAX_MEETINGS_PER_DAY,
        });
        if (reserveErr) throw reserveErr;
        if (!reservedId) {
            return JSON.stringify({
                ok: false,
                error: 'Kuota meeting untuk tanggal itu sudah penuh (maksimal 4 per hari). Tawarkan tanggal lain kepada customer.',
            });
        }
        const meetingId = reservedId as string;

        // Auto-provision a Zoom link when configured; otherwise the row keeps its
        // 'pending-link' placeholder for the admin to fill in. A Zoom failure is
        // non-fatal — the booking still succeeds as pending.
        let joinUrl: string | null = null;
        let meetingPassword: string | null = null;
        if (getZoomConfig()) {
            try {
                const zoom = await createZoomMeeting({
                    topic: title,
                    start: meetingDate,
                    durationMin,
                    timezone: 'Asia/Jakarta',
                    agenda: notes,
                });
                joinUrl = zoom.joinUrl;
                meetingPassword = zoom.password;
            } catch (zoomErr) {
                console.error('Zoom meeting creation failed, keeping pending-link:', zoomErr);
            }
        }
        // Persist the real duration (so the calendar renders the correct block
        // length) and, when we got one, the Zoom link. Runs unconditionally so
        // meeting_duration_min is stored even on the pending-link fallback.
        const orderPatch: Record<string, unknown> = { meeting_duration_min: durationMin };
        if (joinUrl) orderPatch.meeting_link = joinUrl;
        await supabase
            .from('orders')
            .update(orderPatch)
            .eq('id', meetingId)
            .eq('org_id', orgId);

        // Email the invite (+ .ics) to sales + the customer when we have a link.
        // Track whether the CUSTOMER specifically received it, so the bot never
        // claims "emailed to you" when only sales was on the recipient list.
        // Non-fatal — a mail failure never fails the booking.
        let customerEmailed = false;
        let salesNotified = false;
        if (joinUrl) {
            try {
                const notify = await sendMeetingInvite({
                    uid: `meeting-${meetingId}@sarathi`,
                    title,
                    start: meetingDate,
                    durationMin,
                    joinUrl,
                    meetingPassword,
                    notes,
                    customer: { name: chat?.contact_name, email: chat?.email },
                });
                salesNotified = notify.sent;
                const custEmail = chat?.email?.trim().toLowerCase();
                customerEmailed = notify.sent && !!custEmail && notify.recipients.includes(custEmail);
                if (!notify.sent && notify.skippedReason) {
                    console.warn('Meeting invite email skipped:', notify.skippedReason);
                }
            } catch (mailErr) {
                console.error('Meeting invite email failed:', mailErr);
            }
        }

        // Move the lead to 'scheduled' and append an audit line so MJ sees
        // context when they pick up the meeting.
        const stamp = new Date().toISOString();
        const line = `[${stamp}] meeting booked for ${meetingDate.toISOString()} (${title})${notes ? ` — ${notes}` : ''}`;
        await supabase
            .from('whatsapp_chats')
            .update({
                lead_stage: 'scheduled',
                notes: chat?.notes ? `${chat.notes}\n${line}` : line,
                updated_at: stamp,
            })
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber);

        return JSON.stringify({
            ok: true,
            meeting_id: meetingId,
            meeting_at: meetingDate.toISOString(),
            title,
            join_url: joinUrl,
            link_status: joinUrl ? 'created' : 'pending',
            customer_emailed: customerEmailed,
            sales_notified: salesNotified,
            stage: 'scheduled',
        });
    } catch (error) {
        console.error('Error in scheduleMeeting:', error);
        const msg = error instanceof Error ? error.message : 'Failed to schedule meeting';
        return JSON.stringify({ ok: false, error: msg });
    }
}

// Meeting length in minutes, from MEETING_DURATION_MIN. Defaults to 40 (the hard
// cap on a free Zoom account); raise to 60 on Zoom Pro. Clamped to a sane range.
function resolveMeetingDuration(): number {
    const n = parseInt(process.env.MEETING_DURATION_MIN ?? '', 10);
    if (Number.isFinite(n) && n >= 10 && n <= 240) return n;
    return 40;
}

export async function handoffToHuman(
    orgId: string,
    phoneNumber: string,
    reason: string,
    profile: BusinessProfile
): Promise<string> {
    try {
        const supabase = await createServiceOrServerClient();

        const { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('notes')
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber)
            .maybeSingle();

        const stamp = new Date().toISOString();
        const line = `[${stamp}] HANDOFF to ${profile.handoffName}: ${reason}`;
        const { error } = await supabase
            .from('whatsapp_chats')
            .update({
                assigned_to: profile.handoffName,
                notes: chat?.notes ? `${chat.notes}\n${line}` : line,
                updated_at: stamp,
            })
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber);

        if (error) throw error;

        return JSON.stringify({
            ok: true,
            assigned_to: profile.handoffName,
            handoff_whatsapp: profile.handoffPhone || null,
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
