// Seed real "Paket Acara" (event packages) into the products table WITH
// embeddings, so the AI can quote them and create bookings against them.
//
// Safety:
//   • Dry-run by default — prints what WOULD be inserted. Pass --confirm to write.
//   • Packages with price <= 0 are SKIPPED (you must set a real price first) so
//     we never create a "Rp 0" package in production. Edit the PACKAGES array
//     below, set real prices, then run with --confirm.
//   • Embedding text format matches app/api/products/route.ts so retrieval is
//     consistent with packages added via the dashboard.
//
// Run (preview):  node --env-file=.env.local scripts/seed-packages.mjs
// Run (write):    node --env-file=.env.local scripts/seed-packages.mjs --confirm

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// ─────────────────────────────────────────────────────────────────────────
// EDIT ME: set real names, descriptions, and PRICES before running --confirm.
// type 'service' = no stock (EO offerings). Price is the unit you quote
// (e.g. per pax, or a package starting price — be consistent & say so in the
// description). Leave price 0 to skip a row.
// ─────────────────────────────────────────────────────────────────────────
const PACKAGES = [
    {
        name: 'Paket Team Building',
        description:
            'Aktivitas team building (indoor/outdoor) untuk mempererat kerja sama & komunikasi tim. ' +
            'Termasuk fasilitator, perlengkapan game, dokumentasi, dan P3K. Harga per pax, min. [ISI] peserta. ' +
            '[ISI: detail inklusi & durasi]',
        price: 0, // [ISI: harga per pax]
        type: 'service',
    },
    {
        name: 'Paket Capacity Building / Training',
        description:
            'Pengembangan kompetensi & soft skill dengan metode experiential learning. ' +
            'Termasuk trainer/narasumber dan modul. [ISI: detail].',
        price: 0, // [ISI]
        type: 'service',
    },
    {
        name: 'Paket Company Gathering / Outing',
        description:
            'Acara kebersamaan perusahaan (outing, year-end gathering). Konsep acara, MC, hiburan, ' +
            'dan koordinasi logistik. [ISI: termasuk katering/transport/akomodasi?]',
        price: 0, // [ISI]
        type: 'service',
    },
    {
        name: 'Paket Family Gathering',
        description:
            'Acara yang melibatkan keluarga karyawan: games keluarga, hiburan anak, doorprize. [ISI: detail].',
        price: 0, // [ISI]
        type: 'service',
    },
    {
        name: 'Paket Acara Korporat Skala Besar (MICE)',
        description:
            'Manajemen acara end-to-end untuk gathering massal, awards night, anniversary, mudik bersama ' +
            '(ratusan–ribuan peserta). Penawaran custom sesuai kebutuhan. [ISI: detail].',
        price: 0, // [ISI: atau biarkan 0 dan tangani sebagai custom via proposal]
        type: 'service',
    },
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
if (!url || !serviceKey || !openaiKey) {
    console.error('Missing env. Run: node --env-file=.env.local scripts/seed-packages.mjs');
    process.exit(1);
}

const confirm = process.argv.includes('--confirm');
const openai = new OpenAI({ apiKey: openaiKey });
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

const toEmbed = (p) =>
    `Type: ${p.type}\nName: ${p.name}\nDescription: ${p.description}\nPrice: ${p.price}`;

console.log(confirm ? '\n=== SEED (WRITE) ===' : '\n=== SEED (DRY-RUN — tambah --confirm untuk menulis) ===');

let written = 0;
for (const p of PACKAGES) {
    if (!p.price || p.price <= 0) {
        console.log(`  ⏭  SKIP "${p.name}" — harga belum diisi (price=${p.price}).`);
        continue;
    }
    console.log(`  • "${p.name}" — Rp ${p.price.toLocaleString('id-ID')} (${p.type})`);
    if (!confirm) continue;

    const embedding = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: toEmbed(p).replace(/\n/g, ' '),
    });
    const { error } = await sb.from('products').insert({
        name: p.name,
        description: p.description,
        price: p.price,
        stock: p.type === 'service' ? 999999 : 0,
        type: p.type,
        embedding: embedding.data[0].embedding,
    });
    if (error) console.error(`     ✗ gagal insert "${p.name}": ${error.message}`);
    else {
        written++;
        console.log(`     ✓ inserted`);
    }
}

console.log(
    confirm
        ? `\nSelesai. ${written} paket ditulis. Hapus produk test lama (kopi arabica, dll) via dashboard Paket Acara.`
        : '\nDry-run selesai. Isi harga di PACKAGES lalu jalankan ulang dengan --confirm.'
);
