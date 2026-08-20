import { z } from 'zod';

// Shared lead-intake schema + constants. Imported by BOTH client components
// (the Add-Lead form and the CSV import dialog) and server routes (POST
// /api/leads, /api/leads/import), so this module MUST stay client-safe — no
// server-only imports (supabase/server, openai, node:crypto, etc.).

// --- Pipeline stages ---------------------------------------------------------
// MUST stay in sync with LEAD_STAGES in lib/ai/tools.ts, the STAGES array in
// PipelineBoard.tsx, and the CHECK constraint on whatsapp_chats.lead_stage
// (migration 0002). Duplicated here — not imported from lib/ai/tools.ts —
// because that module pulls in server-only deps.
export const LEAD_STAGE_VALUES = [
    'new',
    'qualifying',
    'quoted',
    'scheduled',
    'booked',
    'won',
    'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGE_VALUES)[number];

export const LEAD_STAGE_OPTIONS: { value: LeadStage; label: string }[] = [
    { value: 'new', label: 'New' },
    { value: 'qualifying', label: 'Qualifying' },
    { value: 'quoted', label: 'Quoted' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'booked', label: 'Booked' },
    { value: 'won', label: 'Won' },
    { value: 'lost', label: 'Lost' },
];

// --- Lead sources ------------------------------------------------------------
// Sources a human can pick when entering a lead manually / via CSV. 'whatsapp'
// is intentionally NOT here — it's reserved for leads the WhatsApp webhook
// creates, and is handled by sourceLabel() for display only.
export const LEAD_SOURCE_VALUES = [
    'manual',
    'event',
    'referral',
    'walk_in',
    'instagram',
    'website',
    'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCE_VALUES)[number];

export const LEAD_SOURCE_OPTIONS: { value: LeadSource; label: string }[] = [
    { value: 'manual', label: 'Manual' },
    { value: 'event', label: 'Event / Pameran' },
    { value: 'referral', label: 'Referral' },
    { value: 'walk_in', label: 'Walk-in' },
    { value: 'instagram', label: 'Instagram' },
    { value: 'website', label: 'Website' },
    { value: 'other', label: 'Lainnya' },
];

const SOURCE_LABELS: Record<string, string> = {
    ...Object.fromEntries(LEAD_SOURCE_OPTIONS.map((o) => [o.value, o.label])),
    whatsapp: 'WhatsApp',
    // Lead captured from the "Brief Acara" WhatsApp Flow (see lib/whatsapp/flow-response.ts).
    whatsapp_flow: 'WhatsApp Flow',
};

/** Human label for any source value (incl. 'whatsapp' and null → "WhatsApp"). */
export function sourceLabel(source: string | null | undefined): string {
    if (!source) return 'WhatsApp'; // legacy WA leads have null source
    return SOURCE_LABELS[source] ?? source;
}

// --- Phone normalization -----------------------------------------------------
/**
 * Normalize an Indonesian phone number to bare international digits (62…).
 * Returns null when the input is empty or not a plausible phone number, in
 * which case the caller assigns a synthetic `manual:<uuid>` identity instead.
 *   "0812-3456-789" → "62812345789"   "+62 812 …" → "62812…"   "" → null
 */
export function normalizePhone(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let s = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '');
    if (!/^\d+$/.test(s)) return null;
    if (s.startsWith('0')) s = '62' + s.slice(1);
    else if (s.startsWith('8')) s = '62' + s; // bare local mobile (8xx…)
    // Must resolve to an Indonesian number (62…) of plausible length. A foreign
    // country code or too-short garbage is rejected so it never becomes a fake
    // lead identity / verified_phone (the WhatsApp auto-merge key). Rejected
    // input surfaces as a validation error; the lead can still be saved without
    // a phone (it gets a synthetic `manual:<uuid>` identity instead).
    if (!s.startsWith('62') || s.length < 10 || s.length > 15) return null;
    return s;
}

/**
 * True when a phone is a synthetic, phone-less identity (`manual:<uuid>`) rather
 * than a real number. Leads saved without a phone get such an identity (see
 * createOrFillLead), and several read sites must treat it as "no real phone".
 * Centralised here so the `manual:` prefix lives in exactly one place.
 */
export function isSyntheticPhone(phone: string | null | undefined): boolean {
    return !!phone && phone.startsWith('manual:');
}

/**
 * True when a value is a REAL dialable phone: bare international digits, 8–15
 * long (E.164 without the +). A synthetic `manual:<uuid>` identity OR a WhatsApp
 * Business-Scoped User ID (BSUID, e.g. "ID.26557548613939612" / "US.1349…")
 * fails this. Use it to decide whether an identifier may go in Meta's `to` field
 * (a BSUID must go in `recipient` instead) or be shown/dialed as a phone.
 */
export function isDialablePhone(value: string | null | undefined): value is string {
    return typeof value === 'string' && /^[0-9]{8,15}$/.test(value);
}

// --- Field cleaners (shared by form + CSV) -----------------------------------
// CSV cells arrive as strings (we parse without dynamicTyping to preserve
// leading zeros on phones); form fields are strings too. These turn blank
// cells into `undefined` so optional()/default() behave.
function cleanText(v: unknown): unknown {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    return t === '' ? undefined : t;
}

function cleanEnum(v: unknown): unknown {
    const t = cleanText(v);
    return typeof t === 'string' ? t.toLowerCase().replace(/\s+/g, '_') : t;
}

// Like cleanText but for the numeric field: only strings and numbers are
// meaningful. null/false/[]/{} must become undefined (an unknown count) rather
// than fall through to z.coerce.number(), which would silently coerce them to 0.
function cleanCount(v: unknown): unknown {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const t = v.trim();
        return t === '' ? undefined : t;
    }
    return undefined; // booleans/arrays/objects → unknown, never 0
}

const optionalText = z.preprocess(cleanText, z.string().optional());
const optionalEmail = z.preprocess(
    cleanText,
    z.email({ error: 'Format email tidak valid' }).optional()
);
const optionalCount = z.preprocess(
    cleanCount,
    z.coerce
        .number({ error: 'Jumlah peserta harus angka' })
        .int('Jumlah peserta harus bilangan bulat')
        .min(0, 'Jumlah peserta tidak boleh negatif')
        // Cap well under int4 max (2147483647) so an absurd value is a clean 400
        // validation error instead of a Postgres "integer out of range" 500.
        .max(1_000_000, 'Jumlah peserta tidak masuk akal')
        .optional()
);
const optionalPhone = z.preprocess(
    cleanText,
    z
        .string()
        .refine((v) => normalizePhone(v) !== null, {
            error: 'Nomor HP tidak valid (contoh: 08123456789)',
        })
        .optional()
);
const sourceField = z.preprocess(cleanEnum, z.enum(LEAD_SOURCE_VALUES).default('manual'));
const stageField = z.preprocess(cleanEnum, z.enum(LEAD_STAGE_VALUES).default('new'));

// --- The shared input schema -------------------------------------------------
// Base shape — every field optional. Used as-is to validate a partial EDIT
// (PATCH) of an existing lead, where the "at least one identifier" rule below
// doesn't apply.
export const leadFieldsSchema = z.object({
    contact_name: optionalText,
    company: optionalText,
    phone_number: optionalPhone,
    email: optionalEmail,
    event_interest: optionalText,
    participant_count: optionalCount,
    location_pref: optionalText,
    event_date_pref: optionalText,
    event_goals: optionalText,
    budget_range: optionalText,
    source: sourceField,
    lead_stage: stageField,
    assigned_to: optionalText,
    notes: optionalText,
});

// Create-form schema: additionally requires at least one identifying field.
export const leadInputSchema = leadFieldsSchema.refine(
    (d) => Boolean(d.contact_name || d.phone_number || d.email),
    {
        error: 'Minimal isi salah satu: nama, nomor HP, atau email',
        path: ['contact_name'],
    }
);

export type LeadInput = z.infer<typeof leadInputSchema>;
/** The plain field keys (no stage/source) — used to map CSV columns. */
export type LeadFieldKey = keyof z.input<typeof leadFieldsSchema>;

// --- CSV template + column mapping -------------------------------------------
// The standard template we hand users (Indonesian headers). `field` is the DB
// key, `header` the column name in the CSV, `example` seeds the sample row.
export const LEAD_CSV_COLUMNS: {
    field: LeadFieldKey;
    header: string;
    example: string;
}[] = [
    { field: 'contact_name', header: 'nama', example: 'Budi Santoso' },
    { field: 'company', header: 'instansi', example: 'PT Astra' },
    { field: 'phone_number', header: 'nomor_hp', example: '08123456789' },
    { field: 'email', header: 'email', example: 'budi@email.com' },
    { field: 'event_interest', header: 'jenis_acara', example: 'Pernikahan' },
    { field: 'participant_count', header: 'jumlah_pax', example: '200' },
    { field: 'location_pref', header: 'lokasi', example: 'Bandung' },
    { field: 'event_date_pref', header: 'tanggal', example: '2026-09-12' },
    { field: 'budget_range', header: 'budget', example: '50-75 juta' },
    { field: 'event_goals', header: 'tujuan', example: 'Resepsi 2 sesi' },
    { field: 'source', header: 'sumber', example: 'event' },
    { field: 'lead_stage', header: 'stage', example: 'new' },
    { field: 'assigned_to', header: 'pic', example: 'Sari' },
    { field: 'notes', header: 'catatan', example: 'Ketemu di pameran' },
];

function normalizeHeader(h: string): string {
    return h
        .trim()
        .toLowerCase()
        .replace(/[\s\-./]+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
}

// Canonical header → field, plus common synonyms, so auto-mapping survives
// slightly-off column names from real spreadsheets.
const HEADER_LOOKUP: Record<string, LeadFieldKey> = {
    ...Object.fromEntries(
        LEAD_CSV_COLUMNS.map((c) => [normalizeHeader(c.header), c.field])
    ),
    nama_lengkap: 'contact_name',
    name: 'contact_name',
    instansi: 'company',
    perusahaan: 'company',
    organisasi: 'company',
    institusi: 'company',
    nama_perusahaan: 'company',
    nama_instansi: 'company',
    company: 'company',
    no_hp: 'phone_number',
    nohp: 'phone_number',
    hp: 'phone_number',
    telepon: 'phone_number',
    telp: 'phone_number',
    phone: 'phone_number',
    whatsapp: 'phone_number',
    wa: 'phone_number',
    surel: 'email',
    acara: 'event_interest',
    jenis: 'event_interest',
    pax: 'participant_count',
    jumlah: 'participant_count',
    peserta: 'participant_count',
    kota: 'location_pref',
    lokasi_acara: 'location_pref',
    tanggal_acara: 'event_date_pref',
    anggaran: 'budget_range',
    sumber_lead: 'source',
    tahap: 'lead_stage',
    penanggung_jawab: 'assigned_to',
    sales: 'assigned_to',
    keterangan: 'notes',
    catatan_tambahan: 'notes',
};

/** Best-guess field for a detected CSV header, or null if unrecognized. */
export function fieldForHeader(header: string): LeadFieldKey | null {
    return HEADER_LOOKUP[normalizeHeader(header)] ?? null;
}

// --- CSV export --------------------------------------------------------------
// The lead fields an export reads. Both the Pipeline `Lead` and the Contacts
// `Contact` shapes satisfy this.
export interface LeadCsvSource {
    contact_name: string | null;
    company: string | null;
    phone_number: string;
    email: string | null;
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
    source: string | null;
    lead_stage: string | null;
    assigned_to: string | null;
    notes: string | null;
}

// Map a lead to a CSV row keyed by the SAME Indonesian headers as the import
// template (LEAD_CSV_COLUMNS), so an export can be edited and re-imported.
export function leadToCsvRow(l: LeadCsvSource): Record<string, string> {
    return {
        nama: l.contact_name ?? '',
        instansi: l.company ?? '',
        // Synthetic phone-less identities export as blank (not "manual:<uuid>").
        nomor_hp: isSyntheticPhone(l.phone_number) ? '' : l.phone_number,
        email: l.email ?? '',
        jenis_acara: l.event_interest ?? '',
        jumlah_pax: l.participant_count != null ? String(l.participant_count) : '',
        lokasi: l.location_pref ?? '',
        tanggal: l.event_date_pref ?? '',
        budget: l.budget_range ?? '',
        tujuan: l.event_goals ?? '',
        // Raw source value (blank for WhatsApp/null) so the row re-imports cleanly.
        sumber:
            l.source && (LEAD_SOURCE_VALUES as readonly string[]).includes(l.source)
                ? l.source
                : '',
        stage: l.lead_stage ?? '',
        pic: l.assigned_to ?? '',
        catatan: l.notes ?? '',
    };
}
