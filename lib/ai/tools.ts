import { createServiceOrServerClient } from '@/lib/supabase/service';
import { ChatCompletionTool } from 'openai/resources/chat/completions';
import { type BusinessProfile } from '@/lib/settings/business-profile';
import {
    validateMeetingWindow,
    validateMeetingDay,
    validateMeetingHorizon,
    jakartaDayRangeUtc,
    meetingTitle,
    normalizeMeetingIso,
    meetingSlotsOverlap,
    MAX_MEETINGS_PER_DAY,
    MEETING_BUFFER_MIN,
} from '@/lib/meetings/rules';
import { getZoomConfig, createZoomMeeting } from '@/lib/zoom/client';
import { sendMeetingInvite } from '@/lib/meetings/notify';
import { notifySalesWhatsApp } from '@/lib/meetings/notify-whatsapp';
import {
    AI_SETTABLE_LEAD_STAGES,
    appendLabelledNote,
    clampProductLimit,
    customerMeetingLimitMessage,
    escapeLikePattern,
    findActiveMeeting,
    HUMAN_ONLY_LEAD_STAGES,
    humanStageLockedError,
    isHumanOnlyLeadStage,
    isSameMeetingInstant,
} from './guardrails';

export { AI_SETTABLE_LEAD_STAGES } from './guardrails';

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

// PostgREST `or` filter matching chats whose stage the AI may still change:
// unset (legacy NULL rows) or not a human-owned stage. Used as a WHERE guard on
// AI-driven stage writes so the human-stage lock is enforced by the database,
// not by a read-then-write in app code.
const NOT_HUMAN_STAGE_FILTER = `lead_stage.is.null,lead_stage.not.in.(${HUMAN_ONLY_LEAD_STAGES.join(',')})`;

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
                        description: 'Free-form note worth remembering for follow-up — preferences, constraints, special requests. Appended as a new AI-labelled line; it never replaces existing notes. Pass null if there is nothing NEW to note.',
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
                'Advance the lead through the early sales pipeline. You may set ONLY these stages: "new" (just contacted) → "qualifying" (gathering needs) → "quoted" (price estimate given) → "scheduled" (online meeting booked). Later stages — booked (DP received), won, lost — are confirmed by the human team only; never try to set them, even if the customer says they have paid or want to cancel (tell them the team will confirm). Call this when the conversation crosses a stage boundary — for example, after you have given an initial price estimate, call with stage="quoted".',
            parameters: {
                type: 'object',
                properties: {
                    stage: {
                        type: 'string',
                        enum: [...AI_SETTABLE_LEAD_STAGES],
                        description: 'New pipeline stage for this contact (new, qualifying, quoted or scheduled only).',
                    },
                    reason: {
                        type: ['string', 'null'],
                        description: 'Short reason for the transition — useful for any non-obvious jump. Pass null if no reason needed.',
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
            name: 'check_meeting_availability',
            description:
                `Check whether an online meeting slot is FREE — call this BEFORE proposing or confirming a time to the customer. Read-only: it does NOT book anything. Enforces the same rules as booking: weekdays only (Senin–Jumat), 10:00–22:00 WIB, no clash with another meeting (15-minute buffer), max 4/day, and max 1 upcoming meeting per customer. Result JSON: { available: boolean, reason: string }. If available is false, relay the reason and offer another working-day time — never confirm a slot you haven't checked. If true, show the confirmation summary and wait for the customer's agreement before calling schedule_meeting.`,
            parameters: {
                type: 'object',
                properties: {
                    meeting_at: {
                        type: 'string',
                        description:
                            'Requested meeting start as ISO 8601 in Asia/Jakarta WITH the +07:00 offset (e.g. "2026-06-03T14:00:00+07:00"). Must be a concrete future weekday datetime.',
                    },
                },
                required: ['meeting_at'],
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
                `Book an online consultation meeting with the human sales lead (${p.handoffName}). Call this AFTER you have confirmed a specific date/time with the customer. Meetings run ONLY on weekdays (Senin–Jumat) during business hours 10:00–22:00 WIB — Sabtu & Minggu are closed, so never propose a weekend. On success the tool reserves the slot, auto-creates a Zoom link, and emails a calendar invite. HOW TO REPLY based on the result JSON: if "join_url" is present, SHARE THAT LINK DIRECTLY in your WhatsApp reply together with the date/time — this is the primary way the customer receives it (do not just say "check your email"); when "customer_emailed" is also true, add that a calendar invite was sent to their email too. If "link_status" is "pending" (no join_url), tell the customer the team will send the link shortly. If it returns ok:false (a weekend, outside business hours, the requested time clashes with another meeting, or that day is already full), apologise and offer another WORKING-DAY time. A customer may hold only ONE upcoming meeting: if the result has "customer_limit": true, do NOT try to book another time — remind the customer of their existing meeting and say the team can reschedule it. On success also call update_lead_stage with stage="scheduled".`,
            parameters: {
                type: 'object',
                properties: {
                    meeting_at: {
                        type: 'string',
                        description:
                            'Meeting start time as ISO 8601 datetime in Asia/Jakarta (e.g. "2026-06-03T14:00:00+07:00"). MUST be a real future datetime on a WEEKDAY (Mon–Fri) — never a Saturday/Sunday. Do NOT use placeholders like "TBD". If the customer only gave a vague time ("besok pagi"), pin it down first.',
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
                `Escalate this conversation to ${p.handoffName} (the human Lead Consultant) when: (1) the customer asks to speak with someone directly, (2) negotiation requires authority you do not have (heavy discount, custom scope), (3) technical questions outside your knowledge, or (4) the customer is frustrated. This assigns the lead to the human team, adds a note, and switches OFF automatic AI replies for this chat — your reply to this turn is the last automatic message, so make it complete.${p.handoffPhone ? ` After calling this tool, share ${p.handoffName}'s WhatsApp number (${p.handoffPhone}) in your reply and stop trying to close the sale yourself.` : ' After calling this tool, tell the customer a team member will follow up, and stop trying to close the sale yourself.'}`,
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

export async function checkAvailability(orgId: string, productName: string) {
    try {
        // service-role-or-server + explicit org filter: the WhatsApp/queue path
        // has no user session (a cookie client is anon → RLS returns 0 rows), and
        // service role bypasses RLS, so the org_id filter is what scopes the
        // catalog to this conversation's tenant.
        const supabase = await createServiceOrServerClient();

        // ilike with wildcards for broad fuzzy matching; the model-supplied name
        // is escaped so a stray % or _ is matched literally.
        const { data: products, error } = await supabase
            .from('products')
            .select('id, name, price, stock, type, description')
            .eq('org_id', orgId)
            .ilike('name', `%${escapeLikePattern(String(productName ?? '').trim())}%`)
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
    profile: BusinessProfile,
    // Label stamped on the appended notes line — 'AI' for the model's tool
    // call; other server-side callers (e.g. the WhatsApp Flow) pass their own.
    notesAuthor: string = 'AI'
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
        const cleanedNotes = cleanLeadStr(args.notes);

        // Single read of the existing row when we need its current state:
        //  - contact_name_locked  → don't let the AI clobber a manual name.
        //  - contact_type         → don't let the AI downgrade a vendor/other
        //                           classification back to "lead".
        //  - contact_type_locked  → don't let the AI override a human's manual
        //                           classification, nor stamp vendor detail onto
        //                           a contact a human confirmed as non-vendor.
        //  - notes                → append to (never overwrite) operator notes.
        let existing: {
            contact_name_locked?: boolean;
            contact_type?: string | null;
            contact_type_locked?: boolean;
            notes?: string | null;
        } | null = null;
        if (cleanedName || incomingType || hasVendorDetail || cleanedNotes) {
            const { data } = await supabase
                .from('whatsapp_chats')
                .select('contact_name_locked, contact_type, contact_type_locked, notes')
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

        // notes is also edited by operators (and carries the handoff / stage
        // audit trail), so append a timestamped, author-labelled line instead of
        // overwriting it. A repeat of the same note is skipped (null).
        if (cleanedNotes) {
            const merged = appendLabelledNote(existing?.notes, cleanedNotes, notesAuthor);
            if (merged !== null) patch.notes = merged;
        }

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
    reason?: string | null,
    opts?: {
        // AI path: refuse to move a lead OUT of a human-owned stage
        // (booked/won/lost) — that decision belongs to the team (KEA-12).
        protectHumanStages?: boolean;
    }
): Promise<string> {
    try {
        const supabase = await createServiceOrServerClient();

        // Columns written on this transition (org_id/phone_number are added
        // only for the upsert path, which may create the chat row).
        const fields: Record<string, unknown> = {
            lead_stage: stage,
            updated_at: new Date().toISOString(),
        };
        const hasReason = !!(reason && reason.trim());
        let row: { notes?: string | null; lead_stage?: string | null } | null = null;
        if (hasReason || opts?.protectHumanStages) {
            const { data } = await supabase
                .from('whatsapp_chats')
                .select('notes, lead_stage')
                .eq('org_id', orgId)
                .eq('phone_number', phoneNumber)
                .maybeSingle();
            row = data;
        }
        if (opts?.protectHumanStages && isHumanOnlyLeadStage(row?.lead_stage)) {
            return JSON.stringify({
                ok: false,
                stage: row?.lead_stage,
                error: humanStageLockedError(String(row?.lead_stage)),
            });
        }
        if (reason && hasReason) {
            // Append to notes rather than clobbering — multiple transitions
            // accumulate a useful audit trail for whoever picks up the lead.
            const stamp = new Date().toISOString();
            const line = `[${stamp}] → ${stage}: ${reason.trim()}`;
            fields.notes = row?.notes ? `${row.notes}\n${line}` : line;
        }

        if (opts?.protectHumanStages && row) {
            // Conditional write so the DATABASE enforces the human-stage lock:
            // if an operator set booked/won/lost between the read above and
            // this write, the WHERE guard matches no row and nothing changes.
            const { data: updated, error } = await supabase
                .from('whatsapp_chats')
                .update(fields)
                .eq('org_id', orgId)
                .eq('phone_number', phoneNumber)
                .or(NOT_HUMAN_STAGE_FILTER)
                .select('lead_stage');
            if (error) throw error;
            if (Array.isArray(updated) && updated.length === 0) {
                const { data: latest } = await supabase
                    .from('whatsapp_chats')
                    .select('lead_stage')
                    .eq('org_id', orgId)
                    .eq('phone_number', phoneNumber)
                    .maybeSingle();
                return JSON.stringify({
                    ok: false,
                    stage: latest?.lead_stage ?? null,
                    error: humanStageLockedError(String(latest?.lead_stage ?? 'booked/won/lost')),
                });
            }
            return JSON.stringify({ ok: true, stage });
        }

        const { error } = await supabase
            .from('whatsapp_chats')
            .upsert({ org_id: orgId, phone_number: phoneNumber, ...fields }, { onConflict: 'org_id,phone_number' });

        if (error) throw error;

        return JSON.stringify({ ok: true, stage });
    } catch (error) {
        console.error('Error in updateLeadStage:', error);
        const msg = error instanceof Error ? error.message : 'Failed to update lead stage';
        return JSON.stringify({ ok: false, error: msg });
    }
}

// --- Meeting / handoff / proposal executors ---------------------------------

// Read-only availability check for a proposed meeting slot. Applies the SAME
// rules as the atomic booking (weekday, business hours, conflict with buffer,
// daily cap) but writes nothing — so the AI can verify a slot BEFORE showing the
// confirmation summary, instead of promising a slot that turns out to be taken.
// The reserve RPC remains the final authority against races at booking time.
export async function checkMeetingAvailability(
    orgId: string,
    meetingAtIso: string,
    // When known (WhatsApp path), also applies the max-1-active-meeting-per-
    // customer rule (migration 0059) so the AI never proposes a second slot.
    phoneNumber?: string
): Promise<string> {
    try {
        const meetingDate = new Date(normalizeMeetingIso(meetingAtIso));
        if (Number.isNaN(meetingDate.getTime())) {
            return JSON.stringify({ available: false, reason: `Format tanggal/jam tidak valid: ${meetingAtIso}` });
        }
        if (meetingDate.getTime() < Date.now() - 60_000) {
            return JSON.stringify({ available: false, reason: 'Jam itu sudah lewat. Tawarkan waktu yang akan datang.' });
        }
        const horizonCheck = validateMeetingHorizon(meetingDate);
        if (!horizonCheck.ok) {
            return JSON.stringify({ available: false, reason: horizonCheck.error });
        }
        const dayCheck = validateMeetingDay(meetingDate);
        if (!dayCheck.ok) {
            return JSON.stringify({ available: false, reason: dayCheck.error });
        }
        const durationMin = resolveMeetingDuration();
        const windowCheck = validateMeetingWindow(meetingDate, durationMin);
        if (!windowCheck.ok) {
            return JSON.stringify({ available: false, reason: windowCheck.error });
        }

        const supabase = await createServiceOrServerClient();

        if (phoneNumber) {
            const { data: own, error: ownErr } = await supabase
                .from('orders')
                .select('event_date, meeting_duration_min, status')
                .eq('org_id', orgId)
                .eq('order_type', 'service')
                .eq('customer_phone', phoneNumber)
                .not('meeting_link', 'is', null)
                .gte('event_date', new Date(Date.now() - 24 * 60 * 60_000).toISOString());
            if (ownErr) throw ownErr;
            const active = findActiveMeeting(own ?? []);
            // The customer re-checking the exact slot they already hold (e.g.
            // a retry after a pending-link result) is not a second meeting —
            // mirror reserve_meeting_slot's idempotency step and report it as
            // their existing booking instead of a customer_limit refusal.
            if (active && isSameMeetingInstant(active.event_date, meetingDate)) {
                return JSON.stringify({
                    available: true,
                    already_booked: true,
                    meeting_at: meetingDate.toISOString(),
                    reason: 'Slot ini sudah tercatat sebagai jadwal meeting customer ini (bukan booking baru). Ingatkan jadwalnya; bila link belum terkirim, schedule_meeting dengan jam yang sama aman dipanggil — hanya melengkapi/mengirim ulang link, tidak membuat meeting baru.',
                });
            }
            if (active) {
                return JSON.stringify({
                    available: false,
                    customer_limit: true,
                    existing_meeting_at: active.event_date,
                    reason: customerMeetingLimitMessage(active.event_date),
                });
            }
        }

        const { startUtcIso, endUtcIso } = jakartaDayRangeUtc(meetingDate);
        const { data: existing, error } = await supabase
            .from('orders')
            .select('event_date, meeting_duration_min')
            .eq('org_id', orgId)
            .eq('order_type', 'service')
            .not('meeting_link', 'is', null)
            .gte('event_date', startUtcIso)
            .lt('event_date', endUtcIso);
        if (error) throw error;

        const rows = existing ?? [];
        if (rows.length >= MAX_MEETINGS_PER_DAY) {
            return JSON.stringify({ available: false, reason: `Kuota meeting hari itu sudah penuh (maksimal ${MAX_MEETINGS_PER_DAY}/hari). Tawarkan tanggal lain.` });
        }
        const reqMs = meetingDate.getTime();
        const clash = rows.some((r) =>
            meetingSlotsOverlap(
                new Date(r.event_date as string).getTime(),
                (r.meeting_duration_min as number | null) ?? 60,
                reqMs,
                durationMin,
                MEETING_BUFFER_MIN,
            ),
        );
        if (clash) {
            return JSON.stringify({ available: false, reason: `Jam itu bentrok dengan meeting lain (butuh jeda minimal ${MEETING_BUFFER_MIN} menit antar-meeting). Tawarkan jam lain.` });
        }

        return JSON.stringify({ available: true, reason: 'Slot tersedia — silakan konfirmasi ke customer lalu jadwalkan.', meeting_at: meetingDate.toISOString() });
    } catch (err) {
        // Keep the raw detail in the log only — the "reason" is relayed to the
        // customer, so return a generic localized message, not an internal error.
        console.error('Error in checkMeetingAvailability:', err);
        return JSON.stringify({ available: false, reason: 'Maaf, gagal cek ketersediaan slot. Coba lagi sebentar ya.' });
    }
}

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

        // Booking horizon: no meetings further out than MAX_BOOKING_HORIZON_DAYS.
        const horizonCheck = validateMeetingHorizon(meetingDate);
        if (!horizonCheck.ok) {
            return JSON.stringify({ ok: false, error: horizonCheck.error });
        }

        // Working days only: Saturday & Sunday are treated as holidays.
        const dayCheck = validateMeetingDay(meetingDate);
        if (!dayCheck.ok) {
            return JSON.stringify({ ok: false, error: dayCheck.error });
        }

        // Business hours: the meeting must start ≥10:00 and end ≤22:00 WIB.
        const windowCheck = validateMeetingWindow(meetingDate, durationMin);
        if (!windowCheck.ok) {
            return JSON.stringify({ ok: false, error: windowCheck.error });
        }

        // Pull the contact context for the meeting title + invite.
        const { data: chat } = await supabase
            .from('whatsapp_chats')
            .select('contact_name, notes, company, event_interest, email, lead_stage')
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber)
            .maybeSingle();

        // Require the customer's NAME and COMPANY/INSTANSI on file before booking
        // — collected earlier via conversation / save_lead_info. Backstop for the
        // system-message rule so a meeting is never scheduled for an unidentified
        // lead even if the model skips ahead.
        const missingIdentity: string[] = [];
        if (!chat?.contact_name?.trim()) missingIdentity.push('nama');
        if (!chat?.company?.trim()) missingIdentity.push('perusahaan/instansi');
        if (missingIdentity.length > 0) {
            return JSON.stringify({
                ok: false,
                error: `Minta ${missingIdentity.join(' & ')} customer dulu (simpan via save_lead_info) sebelum menjadwalkan meeting.`,
            });
        }

        const customerName = chat?.contact_name ?? 'Klien';
        // "COMPANY - Event", e.g. "SIEMENS - Employee Gathering 2026".
        const title = meetingTitle(chat?.company, chat?.event_interest, customerName);
        const deliveryInfo = notes ? `Online meeting — ${notes}` : 'Online meeting';

        // Reserve the slot ATOMICALLY — enforces max 4/WIB-day even under
        // concurrent bookings (migration 0054 counts + inserts under an advisory
        // lock). Returns the new row's id, or null when the day is already full.
        // Done BEFORE creating the Zoom room so a full day never wastes one.
        const { startUtcIso, endUtcIso } = jakartaDayRangeUtc(meetingDate);
        const { data: reserve, error: reserveErr } = await supabase.rpc('reserve_meeting_slot', {
            p_org: orgId,
            p_phone: phoneNumber,
            p_name: customerName,
            p_event_date: meetingDate.toISOString(),
            p_delivery_info: deliveryInfo,
            p_day_start: startUtcIso,
            p_day_end: endUtcIso,
            p_max: MAX_MEETINGS_PER_DAY,
            p_duration_min: durationMin,
            p_buffer_min: MEETING_BUFFER_MIN,
        });
        if (reserveErr) throw reserveErr;
        const reservation = (reserve ?? {}) as {
            meeting_id: string | null;
            created: boolean;
            full: boolean;
            conflict: boolean;
            // Migration 0059: this customer already holds another active meeting.
            customer_limit?: boolean;
            existing_meeting_id?: string | null;
            existing_event_date?: string | null;
        };
        if (reservation.customer_limit) {
            return JSON.stringify({
                ok: false,
                customer_limit: true,
                existing_meeting_at: reservation.existing_event_date ?? null,
                error: customerMeetingLimitMessage(reservation.existing_event_date),
            });
        }
        if (reservation.conflict) {
            return JSON.stringify({
                ok: false,
                error: `Jam itu bentrok dengan jadwal meeting lain (butuh jeda minimal ${MEETING_BUFFER_MIN} menit antar-meeting). Tawarkan jam lain kepada customer.`,
            });
        }
        if (reservation.full || !reservation.meeting_id) {
            return JSON.stringify({
                ok: false,
                error: 'Kuota meeting untuk tanggal itu sudah penuh (maksimal 4 per hari). Tawarkan tanggal lain kepada customer.',
            });
        }
        const meetingId = reservation.meeting_id;
        const alreadyBooked = !reservation.created;

        // For an idempotent hit, read what link the earlier attempt stored. We
        // (re)create Zoom + email ONLY when there's no real link yet — so a repeat
        // call whose first attempt died mid-flow self-heals (finishes the link +
        // email + stage bump) instead of returning a half-done booking, while a
        // fully-booked repeat just re-shares the link (no duplicate Zoom / email).
        // A fresh reservation is always 'pending-link', so skip the read there.
        let priorLink: string | null = null;
        if (alreadyBooked) {
            const { data: existingRow } = await supabase
                .from('orders')
                .select('meeting_link')
                .eq('id', meetingId)
                .eq('org_id', orgId)
                .maybeSingle();
            priorLink =
                existingRow?.meeting_link && existingRow.meeting_link !== 'pending-link'
                    ? existingRow.meeting_link
                    : null;
        }

        // Auto-provision a Zoom link when none is stored yet and Zoom is
        // configured; otherwise keep the 'pending-link' placeholder. A Zoom
        // failure is non-fatal — the booking still succeeds as pending.
        let joinUrl: string | null = priorLink;
        let meetingPassword: string | null = null;
        let justCreatedLink = false;
        // Why the link is still pending, if it is — surfaced in the result and
        // persisted so a silent 'pending-link' can be diagnosed without reading
        // container logs. null once a real link exists (fresh or self-healed).
        let zoomError: string | null = null;
        if (!joinUrl) {
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
                    justCreatedLink = true;
                } catch (zoomErr) {
                    zoomError = zoomErr instanceof Error ? zoomErr.message : String(zoomErr);
                    console.error('Zoom meeting creation failed, keeping pending-link:', zoomError);
                }
            } else {
                // getZoomConfig() null = a ZOOM_* env var is unset. This path is
                // otherwise fully silent (no throw, no log), which is exactly why
                // a mis-wired env goes unnoticed — so log it explicitly.
                zoomError = 'Zoom not configured (ZOOM_* env vars missing) — booking kept as pending-link.';
                console.warn(`schedule_meeting: ${zoomError} org=${orgId}`);
            }
        }

        // Store the Zoom link when we just created one this run. The duration is
        // already persisted by the reserve RPC at insert time, so there's nothing
        // else to update on the pending-link fallback.
        if (justCreatedLink && joinUrl) {
            const { error: linkErr } = await supabase
                .from('orders')
                .update({ meeting_link: joinUrl })
                .eq('id', meetingId)
                .eq('org_id', orgId);
            // A Zoom room was created (and about to be emailed) — if persisting
            // it fails, don't let it silently revert to 'pending-link'.
            if (linkErr) {
                zoomError = `Zoom link created but failed to save: ${linkErr.message}`;
                console.error('Failed to persist Zoom link:', linkErr);
            }
        }

        // Email the invite (+ .ics) ONLY when we just created the link this run,
        // so an idempotent hit that already had a link doesn't re-email. Track
        // whether the CUSTOMER specifically received it. Non-fatal — a mail
        // failure never fails the booking.
        let customerEmailed = false;
        let salesNotified = false;
        if (justCreatedLink && joinUrl) {
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

        // Notify the sales team on WhatsApp for every NEW booking (not idempotent
        // repeats), regardless of whether the Zoom link is ready yet — the
        // template fills "menyusul" when it's still pending. Sent as an approved
        // Meta template so it works outside the 24h window. Non-fatal, env-gated.
        let salesWaNotified = false;
        if (!alreadyBooked) {
            try {
                const wa = await notifySalesWhatsApp({
                    customerName,
                    company: chat?.company,
                    eventInterest: chat?.event_interest,
                    start: meetingDate,
                    joinUrl,
                });
                salesWaNotified = wa.sent;
                if (!wa.sent && wa.skippedReason) {
                    console.warn('Sales WA notify skipped:', wa.skippedReason);
                }
            } catch (waErr) {
                console.error('Sales WA notify failed:', waErr);
            }
        }

        // Ensure the lead is 'scheduled' (idempotent — safe to repeat on a retry)
        // and add an audit line only for a fresh booking, not on every repeat.
        // Never pull a lead back out of a human-owned stage (booked/won/lost).
        const stamp = new Date().toISOString();
        const keepHumanStage = isHumanOnlyLeadStage(chat?.lead_stage);
        const chatPatch: Record<string, unknown> = { updated_at: stamp };
        if (!alreadyBooked) {
            // Record WHY the link is pending on the audit line so it's queryable.
            const pendingSuffix = !joinUrl ? ` — LINK PENDING: ${zoomError ?? 'no link'}` : '';
            const line = `[${stamp}] meeting booked for ${meetingDate.toISOString()} (${title})${notes ? ` — ${notes}` : ''}${pendingSuffix}`;
            chatPatch.notes = chat?.notes ? `${chat.notes}\n${line}` : line;
        }
        await supabase
            .from('whatsapp_chats')
            .update(chatPatch)
            .eq('org_id', orgId)
            .eq('phone_number', phoneNumber);
        // The stage bump is a separate, DB-guarded write: the chat row was read
        // seconds ago (before Zoom + notifications), so an operator may have set
        // booked/won/lost since — the WHERE guard then leaves their stage alone.
        let stageWritten = false;
        if (!keepHumanStage) {
            const { data: staged, error: stageErr } = await supabase
                .from('whatsapp_chats')
                .update({ lead_stage: 'scheduled' })
                .eq('org_id', orgId)
                .eq('phone_number', phoneNumber)
                .or(NOT_HUMAN_STAGE_FILTER)
                .select('lead_stage');
            if (stageErr) console.error('schedule_meeting: stage bump failed:', stageErr);
            stageWritten = !stageErr && (!Array.isArray(staged) || staged.length > 0);
        }

        return JSON.stringify({
            ok: true,
            meeting_id: meetingId,
            meeting_at: meetingDate.toISOString(),
            title,
            join_url: joinUrl,
            link_status: joinUrl ? 'created' : 'pending',
            zoom_error: zoomError,
            customer_emailed: customerEmailed,
            sales_notified: salesNotified,
            sales_wa_notified: salesWaNotified,
            already_booked: alreadyBooked,
            // 'scheduled' when bumped; otherwise the stage as last read (a human
            // stage, or unknown if a human changed it mid-booking).
            stage: stageWritten ? 'scheduled' : keepHumanStage ? chat?.lead_stage : null,
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
        const line = `[${stamp}] HANDOFF to ${profile.handoffName}: ${reason} (AI auto-reply dimatikan setelah balasan ini)`;
        // ai_enabled is deliberately NOT written here. The handoff reply still
        // has to be generated (second OpenAI call) and sent; if either fails the
        // queue retries the turn, and a retry must not hit the "AI disabled"
        // skip path and leave the customer with no answer at all. Instead
        // generateRAGResponse returns disableAi=true and the WhatsApp queue
        // switches ai_enabled off (org-scoped) right AFTER a successful send.
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
            ai_auto_reply: 'off_after_this_reply',
        });
    } catch (error) {
        console.error('Error in handoffToHuman:', error);
        const msg = error instanceof Error ? error.message : 'Failed to handoff to human';
        return JSON.stringify({ ok: false, error: msg });
    }
}

export async function listProducts(orgId: string, limit: number = 10) {
    try {
        // Same scoping as checkAvailability: service role (no session in the
        // webhook path) + explicit org filter.
        const supabase = await createServiceOrServerClient();

        const { data: products, error } = await supabase
            .from('products')
            .select('id, name, price, stock, type')
            .eq('org_id', orgId)
            .limit(clampProductLimit(limit));

        if (error) throw error;

        if (!products || products.length === 0) {
            return JSON.stringify({
                message: "Belum ada produk di katalog.",
                products: []
            });
        }

        // id included: create_order needs a real catalog UUID, and its schema
        // tells the model to get one from check_availability OR list_products.
        const result = products.map(p => ({
            id: p.id,
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
