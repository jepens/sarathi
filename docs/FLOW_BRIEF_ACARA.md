# Flow "Brief Acara" — Sailendra Organizer

Draft WhatsApp Flow pertama untuk lead qualification: calon klien mengisi brief acara
terstruktur langsung di dalam chat WhatsApp, hasilnya masuk ke webhook Sarathi sebagai
data JSON yang siap dipetakan ke lead di CRM.

**File Flow JSON:** `flow-brief-acara.json` (2 layar, 9 field, 4 wajib)

> **Status:** Draft sudah dibuat di Flow Builder pada 12 Agu 2026 — nama `Brief Acara - Sailendra`,
> kategori *Penciptaan prospek*, **Flow ID `1338308915130746`**, Flow JSON versi `7.3`, 0 error,
> kedua layar terverifikasi tampil di preview. Belum di-publish.
>
> **Rev 13 Agu 2026 — v2 (cakupan paket):** v1 terlanjur DIPUBLISH (immutable), maka dibuat
> klon **"Brief Acara - Sailendra v2" — Flow ID `1790632228793903`, status Draf, 0 error** —
> dengan field baru `cakupan_paket` (RadioButtonsGroup, wajib, di ACARA sebelum budget):
> `all_in` / `program_saja` / `belum_tahu`. JSON di file ini = versi v2.
> **Update 13 Agu 2026:** v2 sudah DIPUBLISH oleh user; template `brief_acara_sailendra_v2`
> (terikat v2) sudah dikirim untuk ditinjau — lihat bagian Template di bawah.
>
> **Rev 12 Agu 2026 (SUDAH tersimpan di draft builder, 0 error):** + jenis "Corporate Event";
> budget pindah KONTAK → ACARA; tanggal jadi 2 field (Tanggal mulai + Tanggal selesai, mendukung
> event >1 hari); lokasi jadi wajib.
>
> ⚠️ Pelajaran teknis: validator builder TIDAK bisa meneruskan nilai CalendarPicker mode `range`
> (objek) antar layar via payload — selalu gagal "Missing property 'properties'" apa pun deklarasi
> data model-nya. Solusi: dua CalendarPicker mode `single` yang nilainya string `YYYY-MM-DD`.

| Layar | Field | Wajib | Tipe |
|---|---|---|---|
| ACARA | jenis_acara | ya | Dropdown (team_building, capacity_building, company_gathering, family_gathering, outing, corporate_event, lainnya) |
| ACARA | jumlah_peserta | ya | Dropdown (lt_50, 50_100, 100_300, gt_300) |
| ACARA | tanggal_mulai | tidak | CalendarPicker mode `single` → string `YYYY-MM-DD` |
| ACARA | tanggal_selesai | tidak | CalendarPicker mode `single` → string `YYYY-MM-DD`; acara 1 hari = samakan dengan mulai |
| ACARA | lokasi | **ya** | TextInput |
| ACARA | cakupan_paket | **ya** | RadioButtonsGroup (all_in, program_saja, belum_tahu) — v2; `belum_tahu` memicu Nindra menjelaskan & upsell |
| ACARA | budget | tidak | Dropdown (lt_50jt, 50_100jt, 100_250jt, gt_250jt, tbd) |
| KONTAK | nama_perusahaan | ya | TextInput |
| KONTAK | nama_pic | ya | TextInput |
| KONTAK | email_pic | tidak | TextInput (email) — nyambung ke fitur kirim proposal via Resend |
| KONTAK | catatan | tidak | TextArea (maks 300) |

## Draft di Flow Builder (sudah dibuat)

Draft dibuat lewat WhatsApp Manager → Flows → Mulai, kategori *Penciptaan prospek*,
template *Tanpa Endpoint*, lalu JSON default diganti dengan isi `flow-brief-acara.json`.

Untuk mengubahnya nanti: WhatsApp Manager → **Flows** → buka `Brief Acara - Sailendra` →
edit JSON di panel kiri → **Simpan**. Tombol **Jalankan** membuka mode uji interaktif;
menu ⋯ juga bisa mengirim draft ke nomor sendiri untuk dites di HP.

**Publish** nanti setelah puas — syarat akun sudah terpenuhi per 12 Agu 2026:
verifikasi bisnis ✅ (PT. Sailendra Dua Sejahtera, terverifikasi sejak 6 Mei 2025),
kualitas pesan ✅ (nomor +62 813-4994-9907 berperingkat **Tinggi**).
Catatan: setelah publish, flow tidak bisa diedit lagi — Meta akan membuatkan salinan
draft baru jika ingin mengubah (flow ID berubah).

## Mengirim flow dari Sarathi (Cloud API)

Dalam 24-jam window, kirim sebagai pesan interaktif tipe `flow`:

```json
{
  "messaging_product": "whatsapp",
  "to": "<nomor>",
  "type": "interactive",
  "interactive": {
    "type": "flow",
    "header": { "type": "text", "text": "Brief Acara" },
    "body": { "text": "Bantu kami memahami rencana acara Anda — isi form singkat ini (±1 menit)." },
    "footer": { "text": "Sailendra Organizer" },
    "action": {
      "name": "flow",
      "parameters": {
        "flow_message_version": "3",
        "flow_id": "1790632228793903",
        "flow_cta": "Isi Brief Acara",
        "flow_action": "navigate",
        "flow_action_payload": { "screen": "ACARA" },
        "mode": "draft"
      }
    }
  }
}
```

> `"mode": "draft"` hanya untuk pengujian selama flow belum di-publish. Hapus field ini
> (default `published`) setelah flow di-publish.

Di luar 24-jam window: buat template dengan tombol tipe FLOW (Kelola template → tombol → Flow),
lalu kirim lewat `sendTemplateMessage` seperti biasa.

## Template pesan (re-engagement)

**Template resmi: `brief_acara_sailendra_v2`** (bahasa `id`, kategori Marketing) — dikirim
untuk ditinjau 13 Agu 2026, status *Sedang ditinjau*. Body 4 paragraf (termasuk ajakan
membalas chat agar jalur Nindra tetap terbuka), footer "Sailendra Organizer", tombol Flow
**"Isi Brief Acara"** → **flow v2** (`1790632228793903`), layar awal Brief Acara.
Setelah disetujui Meta, kirim dari Sarathi:
`sendTemplateMessage({ templateName: 'brief_acara_sailendra_v2', language: 'id', to })`.

> ⚠️ Ada template lama `brief_acara_sailendra` (status Aktif) yang terikat **flow v1 tanpa
> pertanyaan cakupan paket** — JANGAN dipakai. Setelah `brief_acara_sailendra_v2` aktif:
> hapus template lama itu di Kelola template, dan flow v1 (`1338308915130746`) boleh
> di-Hentikan (deprecate) dari daftar Flows.

## Menerima hasil isian (webhook) — SUDAH DIIMPLEMENTASI

Handler `nfm_reply` live di kode (12 Agu 2026):

- **`lib/whatsapp/flow-response.ts`** — parse `response_json` → simpan ke riwayat chat
  (reset 24h window, idempoten via `wa_message_id`/23505) → upsert CRM lewat `saveLeadInfo`
  (guard nama/email/lock tetap berlaku; peserta → midpoint; source `whatsapp_flow`) →
  naikkan `lead_stage` ke `qualifying` HANYA jika masih `new`/kosong → `logSystemMessage`
  ringkasan brief supaya Nindra tidak menanyakan ulang → kirim balasan konfirmasi deterministik.
- **`app/api/webhook/whatsapp/route.ts`** — blok `messageType === 'interactive'` baru di antara
  blok `contacts` dan `text`.

Label/id di `flow-response.ts` harus tetap sinkron dengan `flow-brief-acara.json` bila flow diubah.

Balasan masuk lewat webhook yang sudah ada, sebagai pesan tipe `interactive` dengan
`interactive.type = "nfm_reply"`:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "nfm_reply",
    "nfm_reply": {
      "name": "flow",
      "body": "Sent",
      "response_json": "{\"jenis_acara\":\"team_building\",\"jumlah_peserta\":\"50_100\",\"lokasi\":\"Bandung\",\"budget\":\"50_100jt\",\"tanggal_mulai\":\"2026-09-01\",\"tanggal_selesai\":\"2026-09-03\",\"nama_perusahaan\":\"PT Contoh\",\"nama_pic\":\"Budi\",\"email_pic\":\"budi@contoh.co.id\",\"catatan\":\"...\",\"flow_token\":\"...\"}"
    }
  }
}
```

Catatan integrasi:

- `response_json` adalah **string** — `JSON.parse()` dulu.
- `tanggal_mulai` / `tanggal_selesai` = string `YYYY-MM-DD` (CalendarPicker single) → simpan sebagai
  `event_start_date` + `event_end_date`; acara 1 hari berarti keduanya sama. Validasi ringan di
  handler: jika `tanggal_selesai < tanggal_mulai`, anggap selesai = mulai.
- Field opsional yang tidak diisi bisa berupa string kosong / tidak ada — perlakukan sebagai null.
- Mapping ke CRM: `jenis_acara → event_type`, `jumlah_peserta → participant_range`,
  `tanggal_mulai/tanggal_selesai → event_start_date/event_end_date`, `nama_perusahaan/nama_pic/email_pic → lead/contact`,
  lalu panggil logika yang sama dengan tool `save_lead_info` + naikkan stage `new → qualifying`.
- `flow_token` ikut terkirim di response — bisa dipakai sebagai korelasi (set saat mengirim flow).

## Kenapa desainnya begini

- **2 layar pendek** (4 + 5 field) — form panjang menurunkan completion rate; data acara dulu
  (komitmen rendah), data kontak belakangan.
- **Dropdown range** untuk peserta & budget — lebih cepat diisi dan langsung terstruktur untuk
  filter/pipeline, daripada angka bebas.
- **Field wajib hanya 4** — cukup untuk qualifying; sisanya bonus.
- Flow statis (tanpa endpoint) — tidak butuh enkripsi endpoint; upgrade ke `data_exchange`
  (cek ketersediaan tanggal real-time dari Calendar) bisa jadi fase 2.
