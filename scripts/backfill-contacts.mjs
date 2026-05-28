// Backfill contact/lead fields from existing WhatsApp chat history.
//
// Why: chats that happened BEFORE the save_lead_info tool was wired never had
// their lead fields populated, so the Contacts CRM card is mostly empty. This
// reads each contact's full message history, extracts structured lead info via
// the LLM (same shape as save_lead_info), and writes it back to whatsapp_chats.
//
// Policy (decided with the owner):
//   • FILL-EMPTY-ONLY — never overwrite a field that already has a value.
//   • contact_name is filled only if empty AND not locked (contact_name_locked).
//   • lead_stage is NEVER touched — pipeline stage stays a human decision.
//
// Run (dry-run, no writes — just prints what it WOULD fill):
//   node --env-file=.env.local scripts/backfill-contacts.mjs
// Run (actually write):
//   node --env-file=.env.local scripts/backfill-contacts.mjs --confirm
//
// Optional: limit to one contact for spot-checking:
//   node --env-file=.env.local scripts/backfill-contacts.mjs --phone=628123456789

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!url || !serviceKey || !openaiKey) {
    console.error(
        'Missing env. Run with: node --env-file=.env.local scripts/backfill-contacts.mjs'
    );
    process.exit(1);
}

const CONFIRM = process.argv.includes('--confirm');
const phoneArg = process.argv.find((a) => a.startsWith('--phone='));
const PHONE_FILTER = phoneArg ? phoneArg.split('=')[1] : null;
const MODEL = 'gpt-4o-mini';
const MAX_MESSAGES = 80; // cap transcript length per contact (cost guard)

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
const openai = new OpenAI({ apiKey: openaiKey });

// Descriptive fields we backfill (lead_stage intentionally excluded).
const TEXT_FIELDS = [
    'email',
    'event_interest',
    'location_pref',
    'event_date_pref',
    'event_goals',
    'budget_range',
    'source',
    'notes',
    'vendor_offering',
];

// JSON schema for structured extraction — mirrors save_lead_info args.
const EXTRACTION_SCHEMA = {
    type: 'object',
    properties: {
        name: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
        event_interest: { type: ['string', 'null'] },
        participant_count: { type: ['integer', 'null'] },
        location_pref: { type: ['string', 'null'] },
        event_date_pref: { type: ['string', 'null'] },
        event_goals: { type: ['string', 'null'] },
        budget_range: { type: ['string', 'null'] },
        source: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
        contact_type: { type: ['string', 'null'] },
        vendor_category: { type: ['string', 'null'] },
        vendor_offering: { type: ['string', 'null'] },
    },
    required: [
        'name', 'email', 'event_interest', 'participant_count',
        'location_pref', 'event_date_pref', 'event_goals',
        'budget_range', 'source', 'notes',
        'contact_type', 'vendor_category', 'vendor_offering',
    ],
    additionalProperties: false,
};

const SYSTEM_PROMPT = `Kamu adalah asisten data untuk Event Organizer "Sailendra".
Tugasmu: baca transkrip percakapan WhatsApp antara Customer dan admin (Nindra), lalu EKSTRAK informasi lead/kontak.

ATURAN KETAT:
- Ekstrak HANYA yang benar-benar disebutkan di transkrip. JANGAN mengarang/menebak.
- Jika sebuah info tidak ada, isi null. Lebih baik null daripada salah.
- name: nama customer sebagaimana ia memperkenalkan diri (bukan nama admin/Nindra).
- email: hanya kalau ada alamat email yang valid.
- event_interest: jenis acara singkat (mis. "team building", "gathering", "capacity building").
- participant_count: jumlah peserta sebagai 1 angka (pakai titik tengah bila rentang).
- location_pref: kota/lokasi yang diinginkan.
- event_date_pref: tanggal apa adanya seperti yang ditulis customer ("akhir bulan", "Q1 2026"). Jangan diubah ke format ISO.
- event_goals: tujuan/nilai acara.
- budget_range: indikasi budget apa adanya.
- source: dari mana customer tahu Sailendra, HANYA jika disebut (instagram/referral/website/teman). Jangan isi "whatsapp" secara default.
- notes: ringkasan singkat 1-2 kalimat hal penting untuk follow-up (preferensi, kendala, permintaan khusus). null jika tidak ada yang berarti.

KLASIFIKASI KONTAK (selalu tentukan contact_type):
- "lead"   = calon KLIEN yang ingin mengadakan acara (kasus normal).
- "vendor" = supplier/sales yang MENAWARKAN jasa/produk MEREKA ke Sailendra (catering, transport, ambulance, souvenir, seragam, ajakan partnership, dll).
- "other"  = bukan keduanya (spam, salah sambung, pertanyaan umum tak jelas).
Jika contact_type = "vendor", ISI JUGA:
- vendor_category: salah satu dari catering, venue, transport, entertainment, photography, decoration, mc, other.
- vendor_offering: deskripsi singkat apa yang ditawarkan (mis. "standby ambulance", "souvenir keramik ekspor", "seragam konveksi").
Jika bukan vendor, vendor_category dan vendor_offering = null.

JANGAN tertukar milik Sailendra dengan milik customer:
- Email "info@sailendra.co.id", nomor "0812-8195-8110"/"+62 812-8195-8110", dan nama "Nindra"/"MJ"/"Mang Jajang" adalah milik SAILENDRA. JANGAN dimasukkan sebagai data customer (isi null).
- "kak", "kakak", "pak", "bapak", "bu", "ibu", "mas", "mbak" adalah SAPAAN, bukan nama. Jika customer tidak menyebut nama asli, isi name = null.
- Gunakan null (JSON null) untuk info yang tidak ada — JANGAN menulis kata "null" sebagai teks.`;

async function extract(transcript) {
    const resp = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Transkrip percakapan:\n\n${transcript}` },
        ],
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'lead_extraction', strict: true, schema: EXTRACTION_SCHEMA },
        },
    });
    return JSON.parse(resp.choices[0].message.content);
}

const isEmpty = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// --- Defensive sanitisers (the LLM is not 100% reliable even with a schema) ---

// Junk the model sometimes emits instead of a real JSON null.
const JUNK_STRINGS = new Set([
    'null', 'undefined', 'tidak ada', 'tidak disebutkan', 'tidak diketahui',
    'n/a', 'na', '-', '—', 'unknown', 'none', 'belum ada', 'belum ditentukan',
]);
// Single-word honorifics that are greetings, not names.
const HONORIFICS = new Set([
    'kak', 'kakak', 'kk', 'pak', 'bapak', 'bu', 'ibu', 'mas', 'mbak',
    'sis', 'bro', 'mister', 'mr', 'mrs', 'ms',
]);

function cleanStr(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t) return null;
    if (JUNK_STRINGS.has(t.toLowerCase())) return null;
    return t;
}

function cleanName(v) {
    const n = cleanStr(v);
    if (!n) return null;
    if (n.length < 2) return null; // reject single letters like "P"
    if (HONORIFICS.has(n.toLowerCase())) return null;
    return n;
}

function cleanEmail(v) {
    const e = cleanStr(v);
    if (!e) return null;
    const low = e.toLowerCase();
    // Sailendra's own address (handed to vendors) is not the customer's email.
    if (low.endsWith('@sailendra.co.id')) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(low)) return null; // basic shape
    return e;
}

const CONTACT_TYPES = new Set(['lead', 'vendor', 'other']);
const VENDOR_CATEGORIES = new Set([
    'catering', 'venue', 'transport', 'entertainment',
    'photography', 'decoration', 'mc', 'other',
]);

function cleanContactType(v) {
    const t = cleanStr(v);
    if (!t) return null;
    const low = t.toLowerCase();
    return CONTACT_TYPES.has(low) ? low : null;
}

function cleanVendorCategory(v) {
    const t = cleanStr(v);
    if (!t) return null;
    const low = t.toLowerCase();
    return VENDOR_CATEGORIES.has(low) ? low : null;
}

// Internal Sailendra staff numbers — marked 'other', never lead/vendor.
const INTERNAL_NUMBERS = new Set([
    '6281281958110', // MJ / Mang Jajang (Lead Consultant)
]);
const normalizePhone = (p) => (p ?? '').replace(/\D/g, '');

async function main() {
    let query = sb
        .from('whatsapp_chats')
        .select(
            'phone_number, contact_name, contact_name_locked, contact_type, vendor_category, vendor_offering, email, event_interest, participant_count, location_pref, event_date_pref, event_goals, budget_range, source, notes'
        )
        .order('last_message_at', { ascending: false });
    if (PHONE_FILTER) query = query.eq('phone_number', PHONE_FILTER);

    const { data: chats, error } = await query;
    if (error) {
        console.error('Failed to load chats:', error.message);
        process.exit(1);
    }

    console.log(
        `\n${CONFIRM ? '🟢 WRITE MODE' : '🔍 DRY-RUN (no writes)'} — ${chats.length} kontak${PHONE_FILTER ? ` (filter ${PHONE_FILTER})` : ''}\n`
    );

    let processed = 0;
    let updated = 0;
    let skippedNoHistory = 0;
    let skippedNothingNew = 0;
    let fieldsFilledTotal = 0;

    for (const chat of chats) {
        processed++;

        // Internal staff (e.g. MJ): force 'other', skip LLM extraction entirely.
        if (INTERNAL_NUMBERS.has(normalizePhone(chat.phone_number))) {
            if ((chat.contact_type ?? 'lead') === 'other') {
                skippedNothingNew++;
                console.log(`· ${chat.phone_number}: internal (staff), sudah 'other'`);
            } else {
                fieldsFilledTotal += 1;
                console.log(`✓ ${chat.phone_number}: internal (staff) → contact_type="other"`);
                if (CONFIRM) {
                    const { error: upErr } = await sb
                        .from('whatsapp_chats')
                        .update({ contact_type: 'other', updated_at: new Date().toISOString() })
                        .eq('phone_number', chat.phone_number);
                    if (upErr) console.log(`   ⚠️  gagal menulis: ${upErr.message}`);
                    else updated++;
                }
            }
            continue;
        }

        const { data: msgs } = await sb
            .from('whatsapp_messages')
            .select('role, content, created_at')
            .eq('phone_number', chat.phone_number)
            .order('created_at', { ascending: true });

        const convo = (msgs ?? []).filter(
            (m) => m.role !== 'system' && m.content && m.content.trim()
        );
        if (convo.length === 0) {
            skippedNoHistory++;
            console.log(`— ${chat.phone_number}: tidak ada riwayat chat, dilewati`);
            continue;
        }

        const transcript = convo
            .slice(-MAX_MESSAGES)
            .map((m) => `${m.role === 'user' ? 'Customer' : 'Nindra'}: ${m.content.trim()}`)
            .join('\n');

        let extracted;
        try {
            extracted = await extract(transcript);
        } catch (e) {
            console.log(`✗ ${chat.phone_number}: gagal ekstraksi — ${e.message}`);
            continue;
        }

        // Build a FILL-EMPTY-ONLY patch, sanitising every value first.
        const patch = {};

        // name → contact_name, only if empty and not locked.
        const name = cleanName(extracted.name);
        if (name && isEmpty(chat.contact_name) && !chat.contact_name_locked) {
            patch.contact_name = name;
        }

        // contact_type → only upgrade from the default 'lead' to vendor/other
        // (never downgrade an already-classified row).
        const type = cleanContactType(extracted.contact_type);
        if ((type === 'vendor' || type === 'other') && (chat.contact_type ?? 'lead') === 'lead') {
            patch.contact_type = type;
        }

        // vendor_category → validated, fill-empty-only.
        const vendorCat = cleanVendorCategory(extracted.vendor_category);
        if (vendorCat && isEmpty(chat.vendor_category)) {
            patch.vendor_category = vendorCat;
        }

        if (
            extracted.participant_count != null &&
            Number.isFinite(extracted.participant_count) &&
            extracted.participant_count > 0 &&
            chat.participant_count == null
        ) {
            patch.participant_count = extracted.participant_count;
        }

        for (const f of TEXT_FIELDS) {
            const v = f === 'email' ? cleanEmail(extracted[f]) : cleanStr(extracted[f]);
            if (v !== null && isEmpty(chat[f])) {
                patch[f] = v;
            }
        }

        const filledKeys = Object.keys(patch);
        if (filledKeys.length === 0) {
            skippedNothingNew++;
            console.log(`· ${chat.phone_number} (${convo.length} pesan): tidak ada field kosong yang bisa diisi`);
            continue;
        }

        fieldsFilledTotal += filledKeys.length;
        const preview = filledKeys
            .map((k) => `${k}=${JSON.stringify(patch[k]).slice(0, 60)}`)
            .join(', ');
        console.log(`✓ ${chat.phone_number} (${convo.length} pesan) → ${preview}`);

        if (CONFIRM) {
            const { error: upErr } = await sb
                .from('whatsapp_chats')
                .update({ ...patch, updated_at: new Date().toISOString() })
                .eq('phone_number', chat.phone_number);
            if (upErr) {
                console.log(`   ⚠️  gagal menulis: ${upErr.message}`);
            } else {
                updated++;
            }
        }
    }

    console.log('\n──────── ringkasan ────────');
    console.log(`Diproses           : ${processed}`);
    console.log(`Tanpa riwayat      : ${skippedNoHistory}`);
    console.log(`Tidak ada yg diisi : ${skippedNothingNew}`);
    console.log(`Akan/telah diisi   : ${processed - skippedNoHistory - skippedNothingNew} kontak, ${fieldsFilledTotal} field`);
    if (CONFIRM) console.log(`Berhasil ditulis   : ${updated} kontak`);
    else console.log('\n(DRY-RUN — belum ada yang ditulis. Tambahkan --confirm untuk menyimpan.)');
    console.log('───────────────────────────\n');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
