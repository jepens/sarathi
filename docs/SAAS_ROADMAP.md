# Sarathi — SaaS Development Roadmap

> **Tujuan dokumen:** titik masuk tunggal untuk melanjutkan pengembangan Sarathi
> sebagai SaaS multi-tenant. Berisi status terkini, ringkasan arsitektur, apa
> yang sudah selesai, catatan operasional, dan backlog berprioritas. Untuk
> rencana teknis awal multi-tenancy lihat [PHASE1_MULTITENANCY.md](PHASE1_MULTITENANCY.md);
> untuk menghubungkan satu tenant lihat [ONBOARDING_EO.md](ONBOARDING_EO.md).
>
> _Konvensi: setiap perubahan skema = satu migrasi `supabase/migrations/NNNN_*.sql`.
> Selalu cari referensi library/API di context7 sebelum implementasi._

---

## 1. Visi

**Sarathi** ("Sarathi — by Sailendra") = SaaS vertikal untuk **Event Organizer**.
Inti produk: asisten WhatsApp ber-AI yang mengubah chat klien menjadi acara
ter-booking, dengan KB, pipeline lead, dan kalender per-tenant. Sailendra adalah
tenant pertama sekaligus perusahaan di balik produk.

## 2. Status terkini (per 2026-06-11)

| Aspek | Status |
|---|---|
| Mesin multi-tenant (DB + kode) | **Lengkap & terbukti terisolasi** (dry-run RLS Fase B) |
| Tenant live | **1** (Sailendra, org `5a11e024-0001-4000-8000-000000000001`) |
| Tenant kedua nyata | **Belum pernah** — semua bukti via simulasi; pilot Meta test number berikutnya |
| Deploy | **Easypanel di VPS sendiri** (BUKAN Vercel) — `nindra.sailendra.co.id` |
| Supabase | Free tier (implikasi: lihat §6) |
| Email auth | Resend (custom SMTP) |

**Artinya:** fokus berikutnya bukan menambah mesin, tapi **membuktikan alur
end-to-end dengan tenant kedua nyata**, lalu melengkapi kebutuhan self-serve
(tim, billing, embedded signup) berdasarkan friksi nyata yang ditemukan.

## 3. Arsitektur multi-tenant (ringkas)

| Lapis | Bagaimana | Pointer |
|---|---|---|
| **Tenant model** | `organizations` + `organization_members` (role owner/admin/staff); helper `private.is_org_member(org_id)` SECURITY DEFINER | migrasi `0025`, `0029` |
| **Isolasi data** | `org_id` di 12 tabel + RLS `is_org_member(org_id)` (pola "no-join" + helper) | `0027`–`0030` |
| **Resolusi org (UI)** | `getCurrentOrgId()` dari membership user (1 user = 1 org) | [lib/settings/org-context.ts](../lib/settings/org-context.ts) |
| **Resolusi org (service-role)** | webhook/queue resolve via `phone_number_id` → org; fallback env = Sailendra | [lib/whatsapp/credentials.ts](../lib/whatsapp/credentials.ts) |
| **WhatsApp per-tenant** | `whatsapp_integrations` (phone_number_id unik, access_token, **app_secret**, waba_id); webhook routing by phone_number_id + verifikasi signature pakai app_secret org tsb | `0032`, [app/api/webhook/whatsapp/route.ts](../app/api/webhook/whatsapp/route.ts) |
| **Kunci chat** | `whatsapp_chats` PK = **composite `(org_id, phone_number)`** (dua tenant bisa punya kontak dengan nomor sama) | `0033`–`0036` (expand/contract) |
| **Storage/KB per-org** | objek `documents` di-prefix `<org_id>/…` + RLS path-scoped; `documents`/`kb_sources` ber-`org_id` | `0038` |
| **Identitas AI per-tenant** | `business_profiles` (per-org; persona, hand-off, dll) → system message + tool descriptions di-template per tenant | `0039`, [lib/settings/business-profile.ts](../lib/settings/business-profile.ts) |
| **Antrian pesan** | `message_queue` + `claim_queue_jobs()` (atomic `FOR UPDATE SKIP LOCKED` + reclaim job stranded) | `0041`, [lib/whatsapp/queue-db.ts](../lib/whatsapp/queue-db.ts) |

**Config platform-global (bukan per-tenant):** Callback URL webhook + Verify Token
(`16381738`) — semua tenant pakai endpoint & token yang sama (routing oleh
phone_number_id), ditampilkan read-only ke tiap tenant. Kredensial OpenAI &
verify-token = env/app_settings global.

## 4. Yang sudah selesai (per fase)

| Fase | Isi | Migrasi |
|---|---|---|
| **0** | Rebrand → Helat (nama kini Sarathi); identitas Sailendra jadi BusinessProfile yang dapat dikonfigurasi | — |
| **1a/1c** | Fondasi isolasi: org + members + helper + `org_id` 11 tabel + RLS; `match_*` filter org | `0025`–`0030` |
| **1b** | Signup auto-buat org + owner; `/signup` + `/auth/confirm` | `0031` |
| **2a** | Kredensial WhatsApp per-org (entry manual, bukan Embedded Signup) | `0032` |
| **2b** | Webhook routing by phone_number_id + signature per-tenant + threading org_id | — |
| **2c** | `whatsapp_chats` → composite PK `(org_id, phone_number)` (expand/contract, zero-downtime) | `0033`–`0036` |
| **Sec** | Advisor fixes: revoke `handle_new_user` EXECUTE; `documents` bucket private | `0037` |
| **Storage** | Storage/KB per-org (`<org_id>/` prefix + RLS) | `0038` |
| **A** | Identitas AI per-tenant (`business_profiles`) — bot bicara sebagai tiap tenant | `0039` |
| **B** | Dry-run isolasi (0 kebocoran lintas-org); signup seed profil; checklist onboarding; runbook | `0040` |
| **Ops** | Queue atomic claim + reclaim + service cron Easypanel | `0041` |
| **Pilot fix** | Webhook config terlihat lintas-tenant; App Secret wajib (anti silent-reject) | — |

## 5. Cara onboard / tes tenant

Runbook lengkap: [ONBOARDING_EO.md](ONBOARDING_EO.md). Ringkas untuk **pilot
Meta test number**:

1. Deploy branch (force-build di Easypanel) agar perbaikan live.
2. Buat/siapkan Meta app dengan test number (phone_number_id berbeda dari env Sailendra).
3. `/signup` org baru → konfirmasi email (via Resend) → login.
4. **Profil Bisnis** (nama asisten + hand-off) → **WhatsApp** (phone_number_id,
   access token, **App Secret wajib**) → **Webhook Meta** (paste Callback URL +
   Verify Token, subscribe `messages`) → **Knowledge** (upload KB kecil).
5. Tambahkan nomor Anda ke recipient test number → kirim WhatsApp.

**Bukti yang dicari:** bot membalas sebagai persona pilot (bukan Sailendra), dan
chat hanya tampil di dashboard org pilot (tidak di Sailendra, dan sebaliknya).

## 6. Catatan operasional (Easypanel/VPS + Supabase free tier)

- **Deploy:** push ke `main` → Easypanel. Jika build gagal cepat tanpa output =
  cache builder korup → **force-build** (clear cache) menyelesaikannya (bukan disk).
- **Queue cron:** `vercel.json` cron tidak aktif di luar Vercel. Jalankan service
  cron mandiri dari [deploy/cron/](../deploy/cron/) (GET `/api/queue/process` tiap
  menit). Set `CRON_SECRET` sama di service app & cron. Pengambilan job sudah
  atomik (`claim_queue_jobs`) → aman dari balasan dobel.
- **Email auth:** Resend via custom SMTP. **Masih perlu** (terpisah dari provider):
  template "Confirm signup" pakai URL `token_hash` → `/auth/confirm`, Redirect-URLs
  allow-list, dan Site URL benar.
- **Secrets:** OpenAI key, WhatsApp env (fallback Sailendra), verify token = global.
  Token tenant disimpan di kolom RLS-protected (rencana: Supabase Vault).
- **Pro-tier tertunda:** leaked-password protection (Auth → Attack Protection)
  aktif saat upgrade dari free tier.

## 7. Backlog berprioritas (langkah berikutnya)

> Urutan rekomendasi: buktikan dulu (pilot) → lengkapi self-serve berdasarkan
> friksi nyata → baru fitur skala.

1. **Pilot tenant kedua (Meta test number)** — validasi end-to-end + isolasi nyata. _(sedang berjalan)_
2. **Tim / multi-user per org** — undang staf (role admin/staff sudah ada di enum, UI invite belum). Tanpa ini satu org = satu user.
3. **Billing / langganan** — paket + batas + gating fitur. Ditunda atas permintaan; perlu sebelum jual ke publik.
4. **Meta Embedded Signup** — hilangkan entry kredensial manual; **butuh verifikasi Meta Tech-Provider** (lead time panjang — mulai ajukan lebih awal).
5. **Secrets → Supabase Vault** — pindahkan access_token/app_secret tenant dari kolom ke Vault.
6. **De-Sailendra sisa hardcode** — preset persona `SystemMessageEditor`, kode proposal (deprecated), KB seed ([lib/knowledge/templates.ts](../lib/knowledge/templates.ts), `content/knowledge-base/*`), docs (README/PRD).
7. **Bersih-bersih DB saat tenant ke-2 mendarat** — drop `kb_sources` global `UNIQUE(title)`; drop `org_id` DEFAULT di documents/kb_sources/orders/proposals/vendors/message_queue (fail-loud); migrasi 15 objek bucket legacy ke prefix Sailendra; tambah `org_id` ke `rate_limits` (kini di-namespace di kode).
8. **Pro-tier security** — leaked-password protection setelah upgrade.

**Utang lain (catat, prioritas rendah):** `scripts/backfill-contacts.mjs` masih
phone-only; webhook punya forward hardcoded `MUDIK_PHONE_NUMBER_ID` →
mudik.buildwithabdul.com (milik proyek "Mudik" terpisah, load-bearing di sana,
bukan urusan Sarathi).

## 8. Landmine yang sudah diketahui (baca sebelum mengubah)

- **`app_settings` punya `UNIQUE(key)` global** → tak bisa menyimpan baris per-org.
  Karena itu identitas per-tenant pakai tabel `business_profiles` terpisah, dan
  Callback URL/Verify Token diperlakukan platform-global.
- **App Secret wajib** per tenant — kalau null, `verifyWhatsAppSignature` menolak
  semua pesan (403) dan bot diam tanpa error terlihat.
- **Jalur service-role mem-bypass RLS** → setiap insert/update di webhook/queue/
  tools **harus** set `org_id`; lupa satu = kebocoran lintas-tenant. (Audit di §3 PHASE1.)
- **Perubahan skema breaking** pada tabel hot (mis. PK chat) pakai pola
  **expand/contract** (additive → deploy → breaking → cleanup) untuk zero-downtime.
- **styled-jsx memecah hydration** di Next 16 (Turbopack + react-compiler) →
  pakai `globals.css` / Tailwind arbitrary values, jangan styled-jsx.
- **Easypanel build gagal cepat tanpa output** = cache builder, bukan kode →
  force-build. `*.sh` harus LF (lihat `.gitattributes`) atau crond gagal.

---

_Dokumen ini hidup — perbarui saat fase selesai atau keputusan berubah._
