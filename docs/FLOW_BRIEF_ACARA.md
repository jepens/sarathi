# Flow "Brief Acara" — Sailendra Organizer

Draft WhatsApp Flow pertama untuk lead qualification: calon klien mengisi brief acara
terstruktur langsung di dalam chat WhatsApp, hasilnya masuk ke webhook Sarathi sebagai
data JSON yang siap dipetakan ke lead di CRM.

**File Flow JSON:** `flow-brief-acara.json` (2 layar, 10 field, 4 wajib)

> **Status:** Draft sudah dibuat di Flow Builder pada 12 Agu 2026 — nama `Brief Acara - Sailendra`,
> kategori *Penciptaan prospek*, **Flow ID `1338308915130746`**, Flow JSON versi `7.3`, 0 error,
> kedua layar terverifikasi tampil di preview. Belum di-publish.
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
        "flow_id": "1338308915130746",
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

Template `brief_acara_sailendra` (bahasa `id`, kategori Marketing) disiapkan lewat wizard
WhatsApp Manager pada 12 Agu 2026 — body 4 paragraf (termasuk ajakan membalas chat agar jalur
Nindra tetap terbuka), footer "Sailendra Organizer", tombol Flow **"Isi Brief Acara"** →
layar Brief Acara. Status: **draft wizard, belum dikirim untuk ditinjau**. Setelah disetujui
Meta, kirim dari Sarathi: `sendTemplateMessage({ templateName: 'brief_acara_sailendra',
language: 'id', to })`.

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

Catatan integrasi (sesuai implementasi di `flow-response.ts`):

- `response_json` adalah **string** — `JSON.parse()` dulu (`parseFlowResponse`, defensif → null bila tak terbaca).
- `tanggal_mulai` / `tanggal_selesai` = string `YYYY-MM-DD` (CalendarPicker single). Digabung jadi satu
  teks `event_date_pref` ("mulai s/d selesai", atau satu tanggal bila sama). CalendarPicker tak bisa
  memaksa urutan, jadi handler meng-clamp: bila `tanggal_selesai < tanggal_mulai`, selesai = mulai.
- Field opsional yang kosong / tidak ada diperlakukan sebagai null.
- Mapping ke CRM lewat `saveLeadInfo` (guard nama/email/lock tetap berlaku):
  `jenis_acara → event_interest` (label), `jumlah_peserta → participant_count` (midpoint range),
  `tanggal_* → event_date_pref`, `nama_perusahaan → company`, `nama_pic → contact_name`,
  `email_pic → email`, `budget → budget_range`, `catatan → notes` (prefiks `[Brief Acara]`),
  `source = whatsapp_flow`, `contact_type = lead`. Stage naik `new → qualifying` (tak pernah menurunkan).
- Idempoten: history insert memakai `wa_message_id`; redelivery Meta → 23505 → berhenti sebelum tulis lead / kirim konfirmasi.
- `flow_token` ikut terkirim di response — bisa dipakai sebagai korelasi (set saat mengirim flow).

## Kenapa desainnya begini

- **2 layar pendek** (6 + 4 field) — form panjang menurunkan completion rate; data acara dulu
  (komitmen rendah), data kontak belakangan.
- **Dropdown range** untuk peserta & budget — lebih cepat diisi dan langsung terstruktur untuk
  filter/pipeline, daripada angka bebas.
- **Field wajib hanya 4** — cukup untuk qualifying; sisanya bonus.
- Flow statis (tanpa endpoint) — tidak butuh enkripsi endpoint; upgrade ke `data_exchange`
  (cek ketersediaan tanggal real-time dari Calendar) bisa jadi fase 2.
