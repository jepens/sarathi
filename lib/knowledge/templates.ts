// Knowledge-base content templates surfaced in the dashboard editor
// (/dashboard/knowledge/editor), offered to every org. Admin picks one, edits
// inline, and saves — the route handler chunks + embeds it into `documents`.
// Every business fact (name, year, clients, areas, prices) is an [ISI: ...]
// placeholder the org fills with its own data, so no org is handed another
// business's identity or portfolio (F10). content/knowledge-base/*.md is
// Sailendra's own filled-in version, kept for repo reference only.

export interface KbTemplate {
    id: string;
    title: string;       // becomes the document file_name/source key
    description: string; // shown in the picker
    content: string;
}

export const KB_TEMPLATES: KbTemplate[] = [
    {
        id: 'layanan-dan-paket',
        title: 'Layanan & Paket Acara',
        description: 'Katalog layanan: team building, capacity building, gathering, family, MICE.',
        content: `# LAYANAN & PAKET ACARA

[ISI: nama bisnis] adalah Event Organizer spesialis [ISI: jenis acara], beroperasi sejak [ISI: tahun]. Fokus: [ISI: layanan utama]. [ISI: paket custom atau paket tetap?]

## 1. Team Building
Aktivitas untuk mempererat kerja sama, komunikasi, dan kepercayaan tim.
- Cocok untuk: divisi/perusahaan yang ingin meningkatkan kekompakan & morale.
- Format: indoor / outdoor / kombinasi (1 hari / 2 hari 1 malam).
- Contoh aktivitas: [ISI]
- Kapasitas: [ISI: mis. 50–200 peserta]
- Termasuk: [ISI: fasilitator, perlengkapan game, dokumentasi, P3K]

## 2. Capacity Building / Training
Pengembangan kompetensi & soft skill (experiential learning).
- Format: [ISI: workshop, outbound training, dll]
- Termasuk: [ISI: trainer, modul, sertifikat]

## 3. Company Gathering / Outing
Outing divisi, family day, year-end gathering.
- Termasuk: [ISI: konsep acara, MC, hiburan, katering, transport]

## 4. Family Gathering
Melibatkan keluarga karyawan.
- Termasuk: [ISI: games keluarga, hiburan anak, doorprize]

## 5. Acara Korporat Skala Besar / MICE
Gathering massal, awards night, anniversary, mudik bersama (ratusan–ribuan peserta).
- Termasuk: [ISI: manajemen acara end-to-end, vendor, panggung, sound]

## Add-on
[ISI: dokumentasi video, drone, merchandise, sewa bus, akomodasi, talent/MC, dekorasi]

## Yang membedakan kami
- Pengalaman sejak [ISI: tahun] untuk [ISI: jenis klien].
- Mengutamakan keselamatan & keamanan peserta.
- [ISI: keunggulan lain]

Untuk negosiasi teknis/budget, customer dihubungkan ke tim kami.`,
    },
    {
        id: 'harga-dan-pembayaran',
        title: 'Harga & Pembayaran',
        description: 'Model harga custom + termin DP/pelunasan + kebijakan reschedule.',
        content: `# HARGA & PEMBAYARAN

## Model harga
Custom, tidak kaku. Dipengaruhi: jumlah peserta, venue (hotel/resort/camping/dalam kota), durasi, kompleksitas konsep, kebutuhan tambahan (akomodasi, transport, katering, hiburan, dokumentasi).

## Indikasi harga (opsional — isi jika nyaman menyebut kisaran)
- Team Building: mulai [ISI: Rp __/pax] (min. [ISI] peserta)
- Capacity Building: mulai [ISI: Rp __/pax]
- Company Gathering / Outing: mulai [ISI: Rp __/pax]
- Family Gathering: mulai [ISI: Rp __/pax]
- MICE / skala besar: penawaran custom

## Termin pembayaran
- DP: [ISI: mis. 50% saat kontrak disepakati]
- Pelunasan: [ISI: sisa maks H-__ sebelum acara]
- Metode: transfer ke rekening resmi — [ISI: bank, no rek, a.n.]
- Invoice & kuitansi: [ISI: dikirim via email]

## Reschedule & pembatalan
- Reschedule: [ISI]
- Pembatalan: [ISI: ketentuan DP]

## Catatan untuk AI
Jika detail acara belum lengkap, JANGAN sebut angka final — kumpulkan jenis acara, jumlah peserta, lokasi, tanggal, lalu janjikan proposal ke email dalam 24 jam. Negosiasi khusus → hand-off ke tim kami.`,
    },
    {
        id: 'proses-pemesanan',
        title: 'Proses Pemesanan',
        description: 'Alur dari inquiry → proposal → DP → eksekusi → pasca-acara.',
        content: `# PROSES PEMESANAN

1. Konsultasi awal — jenis acara, jumlah peserta, lokasi/kota, tanggal, tujuan.
2. Penyusunan proposal — konsep, rundown, penawaran harga; dikirim ke email dalam [ISI: 1×24 jam].
3. Revisi & kesepakatan — penyesuaian konsep/budget; negosiasi teknis dengan tim kami.
4. Booking & DP — bayar DP [ISI: %] untuk mengunci tanggal.
5. Persiapan — koordinasi vendor/venue/logistik + technical meeting [ISI: H-__].
6. Pelunasan — maks [ISI: H-__] sebelum hari-H.
7. Eksekusi (hari-H) — fasilitator, MC, dokumentasi, P3K, manajemen lapangan.
8. Pasca-acara — [ISI: dokumentasi/laporan, evaluasi, testimoni].

## Administrasi
[ISI: kontrak/PKS, NPWP, faktur pajak, dll]

## Lead time ideal
Minimal [ISI: H-__ minggu] sebelum acara.

## Catatan untuk AI
Kumpulkan nama, email, jenis acara, jumlah peserta, lokasi, tanggal → janjikan proposal. Jangan bilang tanggal "fix" sebelum DP — pakai "tentatif".`,
    },
    {
        id: 'area-layanan-dan-venue',
        title: 'Area Layanan & Venue',
        description: 'Lokasi yang dilayani + tipe venue + logistik.',
        content: `# AREA LAYANAN & VENUE

## Area layanan
- [ISI: kota/area yang dilayani, satu per baris]
- [ISI: area lain / "luar area dengan kesepakatan khusus"]

## Tipe venue
- Hotel / Resort — gathering menginap, meeting + outing.
- Camping ground / alam terbuka — team building outdoor.
- Dalam kota / ballroom — training, awards night, gathering formal.
- [ISI: tipe lain — waterpark, villa, pantai]

## Rekomendasi venue (opsional)
[ISI: daftar venue partner per kota, atau biarkan AI bilang "tim akan rekomendasikan"]

## Logistik & akomodasi
- Transport: [ISI: bisa diatur / add-on]
- Akomodasi: [ISI]
- Konsumsi/katering: [ISI: termasuk / add-on]

## Catatan untuk AI
Lokasi di luar area di atas: jangan menolak — tawarkan diskusi dengan tim untuk pengaturan khusus.`,
    },
    {
        id: 'portofolio-dan-testimoni',
        title: 'Portofolio & Testimoni',
        description: 'Event lampau + testimoni (social proof).',
        content: `# PORTOFOLIO & TESTIMONI

## Klien & event unggulan
- [ISI: klien/instansi — nama, jenis acara, jumlah peserta, tahun]
- [ISI: klien/instansi lain]

Hanya cantumkan klien yang boleh disebut publik. Yang konfidensial: deskripsi umum (mis. "BUMN energi", "kementerian", "perusahaan FMCG").

## Skala pengalaman
- [ISI: skala acara yang pernah ditangani, mis. grup 50–200 peserta untuk outing divisi]

## Testimoni
[ISI: "….." — Nama/Jabatan, Perusahaan]

## Jenis acara yang pernah ditangani
[ISI: team building, family gathering, outbound training, year-end party, anniversary, onboarding, dll]

## Catatan untuk AI
Gunakan untuk membangun kepercayaan saat customer ragu, tanpa membocorkan detail konfidensial.`,
    },
];

export function getKbTemplate(id: string): KbTemplate | undefined {
    return KB_TEMPLATES.find((t) => t.id === id);
}
