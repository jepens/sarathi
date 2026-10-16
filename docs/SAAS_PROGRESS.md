# Sarathi SaaS — Pelacak Fase & Progres

> Sumber temuan: [audits/AUDIT-2026-10-15.md](../audits/AUDIT-2026-10-15.md). Laporan ini berisi 73 temuan dengan ID `KEA-*` (keamanan), `KUA-*` (kualitas/arsitektur), `PER-*` (performa) dan `UXA-*` (UX).
> Dokumen ini **diperbarui setiap kali tugas dimulai atau selesai**: kolom status, kolom PR, dan log progres di bagian bawah.
>
> **Status:**
> - ⬜ belum dikerjakan
> - 🔄 sedang dikerjakan
> - 👀 PR menunggu review/merge
> - ✅ selesai (merged + diterapkan)
> - ⏸️ menunggu keputusan
> - 👤 aksi pemilik di luar kode (dashboard/akun pihak ketiga)

## Keputusan

### Sudah diputuskan (2026-10-15)

| Topik | Keputusan |
|---|---|
| Model SaaS | Multi-tenant bersama: satu deployment + satu project Supabase untuk banyak org; Sailendra = tenant #1 |
| Peluncuran | Pilot tertutup 1–5 UMKM, onboarding dibantu tim, invoice manual; self-serve & billing otomatis menyusul |
| WhatsApp | Dikelola tim Sarathi (tim menyiapkan Meta app/nomor & memasukkan kredensial), tanpa Embedded Signup dulu |
| Target tenant | UMKM umum (bukan hanya Event Organizer) |
| D1 · Migrasi DB ke produksi | PR di-review pemilik dulu, lalu Claude menerapkan via Supabase MCP dan memverifikasi (2026-10-15) |
| D2 · 2 akun + org pilot | Dipertahankan sebagai **tenant uji** isolasi; setelah 0.9 mereka hanya melihat org-nya sendiri (2026-10-15) |
| D3 · Batas tool tulis AI | AI hanya boleh menandai sampai `scheduled`. `booked/won/lost` hanya oleh manusia atau event pembayaran. Maksimal 1 meeting aktif per nomor. Ringkasan percakapan bukan role `system`. AI berhenti setelah handoff (2026-10-15). |
| Sign-up publik | Dimatikan via Supabase Management API atas persetujuan pemilik (2026-10-15) |
| D4 · Kejujuran AI | Persona default & preset: natural, tetapi jujur sebagai asisten virtual bila ditanya langsung; persona tersimpan tidak diubah otomatis (2026-10-16) |
| D12 · AI pasca-handoff | Tetap mati sampai operator menyalakan switch "AI aktif" (2026-10-16) |
| D13 · Horizon meeting | AI memesan meeting maksimal 30 hari ke depan (`MAX_BOOKING_HORIZON_DAYS`) (2026-10-16) |
| D9 · Keanggotaan org | **1 user = 1 org**. Tim Sarathi membantu tenant lewat peran platform-admin (Fase 3), bukan sebagai anggota tiap org; tanpa pemilih org (2026-10-16) |
| D16 · File KB lama (1.12) | Ke-15 objek legacy `documents` dipindah semua ke folder Sailendra. Nasib 13 duplikat yang tidak dipakai diputuskan setelah masa tunggu 72 jam (2026-10-16) |
| D17 · Skrip service-role (1.12) | Dijalankan Claude di mesin pemilik (`.env.local`). Hasil dry-run & verifikasi ditinjau dulu; setiap langkah yang mengubah data disetujui pemilik (2026-10-16) |
| D18 · `chat-media` privat (1.11) | Dialihkan segera setelah deploy terverifikasi; link publik lama berhenti ±1 jam kemudian (cache CDN) (2026-10-16) |
| D19 · Push di perangkat bersama | Perangkat mengikuti user yang sedang login; notifikasi user sebelumnya di perangkat itu berhenti (2026-10-16) |
| D20 · Dokumen 50–100 MB | Diterima dulu: tetap terkirim ke pelanggan, dashboard menampilkan keterangan "salinan tidak disimpan"; batas dinaikkan ke 100 MB setelah upgrade Pro (0.15) (2026-10-16) |
| D21 · Hapus kontak | File media kontak di storage ikut dihapus bersama kontaknya (PR kecil setelah `chat-media` privat) (2026-10-16) |

### Menunggu keputusan

| # | Topik | Dibutuhkan untuk | Status |
|---|---|---|---|
| D14 | Penanda dokumen KB internal vs publik (agar AI tak mengutip dokumen internal) | Fase 4 | ⏸️ |
| D15 | CTA landing: tetap "Mulai gratis" → login, atau "Ajukan pilot" ke kanal kontak tim Sarathi (WA/email) | Fase 0 (0.14) / Fase 4 | ⏸️ |
| D5 | Tipe bisnis 1–5 calon tenant pilot | Fase 4 | ⏸️ |
| D6 | Model akun Meta (app per klien vs app platform Sarathi) & entitas legal pemilik Sarathi | Fase 2 | ⏸️ |
| D7 | Kunci OpenAI milik platform (dengan metering) vs dibawa tenant; model default | Fase 3 | ⏸️ |
| D8 | Fitur khusus Sailendra (Portal, proposal/FNA, Flow Brief Acara, Zoom) untuk tenant lain | Fase 2 / 4 | ⏸️ |
| D10 | Branding "by Sailendra" di dashboard tenant | Fase 4 | ⏸️ |
| D11 | Kebijakan retensi data (UU PDP) | Fase 3 / 5 | ⏸️ |

## Fase 0 — Tutup celah yang berlaku sekarang (±1–2 hari)

| # | Tugas | Temuan | Status | PR / Catatan |
|---|---|---|---|---|
| 0.1 | Matikan "Allow new users to sign up" di Supabase Auth | KEA-1 | ✅ | 2026-10-15: `disable_signup=true` via Management API; terverifikasi di `GET /auth/v1/settings`. CAPTCHA Auth sudah aktif. Trigger `handle_new_user` tidak lagi auto-join → migrasi 0060 di [#36](https://github.com/jepens/sahabat_umkm/pull/36) |
| 0.2 | Rotasi kunci OpenAI, token System User & App Secret WhatsApp, kunci Komerce | KEA-13 | 👤 | Kunci yang bocor = kunci aktif saat ini |
| 0.3 | Hapus `log_deploy.md` & nilai rahasia di `database/migrate_env_to_settings.sql`; pemindai secret di CI | KEA-13 | ✅ | [#35](https://github.com/jepens/sahabat_umkm/pull/35) merged: file dihapus, SQL diganti placeholder, job CI gitleaks. **Rotasi kunci tetap wajib (0.2)** |
| 0.4 | Tangani 2 akun + org pilot sisa | KEA-2 | ✅ | D2: dipertahankan sebagai tenant uji. Setelah deploy #36: `getCurrentOrgId` berbasis keanggotaan; tiap akun pilot hanya anggota org-nya sendiri (diverifikasi di DB) |
| 0.5 | Patch dependensi (Next.js ≥ 16.3.8, sharp, postcss) + Node 22 di `nixpacks.toml` | KEA-10, KEA-22 | ✅ | [#35](https://github.com/jepens/sahabat_umkm/pull/35): Next 16.3.8, audit 0, Node 22 — **live di produksi** (build Easypanel sukses) |
| 0.6 | Migrasi RLS: 4 tabel `USING(true)` → `is_org_member(org_id)`; `push_subscriptions.user_id` | KEA-3 | ✅ | [#36](https://github.com/jepens/sahabat_umkm/pull/36) merged; migrasi 0058 diterapkan 2026-10-16 & terverifikasi (policy, kolom, 1 baris push tanpa pemilik terhapus) |
| 0.7 | Storage: policy per prefix org untuk `chat-media` & `proposals` | KEA-4 | ✅ | [#36](https://github.com/jepens/sahabat_umkm/pull/36) + 0058 (policy `chat-media`/`proposals` per org terverifikasi). Lanjutan: 1.11, 1.12 |
| 0.8 | Cabut EXECUTE `reserve_meeting_slot` dari `authenticated`; cabut anon di `match_*` | KEA-5, KEA-25 | ✅ | 0058: `reserve_meeting_slot` hanya service_role; `match_*` tanpa anon — terverifikasi via `has_function_privilege` |
| 0.9 | `getCurrentOrgId()` wajib keanggotaan (`organization_members`) | KEA-2 | ✅ | [#36](https://github.com/jepens/sahabat_umkm/pull/36) merged; + 0060: user baru tidak auto-join org Sailendra (terverifikasi) |
| 0.10 | `updateOrderStatus` wajib login + baca order dari DB; validasi input documents/products | KEA-19, KEA-18 | ✅ | [#36](https://github.com/jepens/sahabat_umkm/pull/36) merged |
| 0.11 | Tool AI katalog (`checkAvailability`/`listProducts`) pakai service role + filter org | KUA-3 | ✅ | [#37](https://github.com/jepens/sahabat_umkm/pull/37) merged (`e7ef424`) |
| 0.12 | Batas tool tulis AI (tahap, batas meeting per nomor, ringkasan bukan role system, handoff mematikan AI) | KEA-12 | ✅ | [#37](https://github.com/jepens/sahabat_umkm/pull/37) merged; migrasi 0059 diterapkan & terverifikasi. D3/D12/D13 diterapkan; sisa: D14 (penanda KB internal, Fase 4) |
| 0.13 | Security headers; logout mencabut push; hapus default verify token; hapus halaman debug | KEA-24, KEA-23, KEA-27, KUA-22 | ✅ | [#35](https://github.com/jepens/sahabat_umkm/pull/35): headers, verify token fail-closed, debug 404. [#36](https://github.com/jepens/sahabat_umkm/pull/36): logout mencabut push, verify token hanya untuk org default |
| 0.14 | Persona tidak menyangkal AI; perbaiki copy landing/login | UXA-3, UXA-4 | 🔄 | UXA-3 ✅ di [#37](https://github.com/jepens/sahabat_umkm/pull/37) (persona jujur bila ditanya, D4). UXA-4 sebagian di PR copy/pelacak: klaim "terisolasi penuh" & "gaya Sailendra" dihapus. Sisa: CTA landing (D15), tautan Privasi/Ketentuan (3.8), copy UMKM & branding footer (4.2, D10) |
| 0.15 | Upgrade Supabase Pro + uji restore backup | PER-1 | 👤 | Berbayar |

## Fase 1 — Fondasi multi-tenant (±2–3 minggu, wajib sebelum tenant ke-2)

| # | Tugas | Temuan | Status | PR / Catatan |
|---|---|---|---|---|
| 1.1 | Rantai migrasi bisa di-replay (`supabase init`, baseline skema, `migration repair`, perbaiki dua file 0004) | KUA-1 | ✅ | [#39](https://github.com/jepens/sahabat_umkm/pull/39): baseline 00010/00011 + 0004→00041; replay 64 migrasi; fingerprint lokal **identik** produksi. Baseline TIDAK diterapkan ke produksi. Setelah 0062: produksi = replay (563 baris, md5 bf973342…) |
| 1.2 | Suite pgTAP isolasi tenant + job CI | KUA-13 | ✅ | [#39](https://github.com/jepens/sahabat_umkm/pull/39): pgTAP dua org, dua user, anon (tanpa asersi vakum) + job CI `db-tests`; alur fingerprint dua tahap untuk PR migrasi. Kini 695 test (17 file) per PR 0064/0065 |
| 1.3 | `requireOrgContext()` berbasis keanggotaan + `proxy.ts` + `getClaims()` | KEA-2, KUA-14 | ✅ | [#40](https://github.com/jepens/sahabat_umkm/pull/40): `requireOrgContext()` di 49 handler + semua server action; mode strict (`getUser`) untuk integrasi & notifikasi order; `proxy.ts` + `getClaims`; 503 saat Auth terganggu. **Live** (deploy manual Easypanel, diverifikasi 2026-10-16) |
| 1.4 | Semua penulis mengirim `org_id` eksplisit → cabut 13 `DEFAULT` org Sailendra | KUA-4 | ✅ | [#41](https://github.com/jepens/sahabat_umkm/pull/41): semua penulis ke 13 tabel mengirim `org_id` eksplisit; 0062 mencabut 13 `DEFAULT` (diterapkan setelah deploy, 2026-10-16). Insert tanpa org kini gagal (23502), tidak lagi masuk ke Sailendra |
| 1.5 | Unique/FK per org; FK komposit `chat_labels → labels` | KUA-5 | 🔄 | Inti selesai di [#41](https://github.com/jepens/sahabat_umkm/pull/41): 0061 unique per org (`system_message`, `vendors`, `app_settings`, `labels`) + FK komposit `chat_labels → labels`; 0062 men-drop 4 unique global. `push_subscriptions_endpoint_key` sengaja **tetap global** (pengecualian yang ditinjau, D19: perangkat mengikuti user yang sedang login); perangkat dipindah lewat RPC `register_push_subscription` (0065, tanpa service role; diterapkan 2026-10-16, [#44](https://github.com/jepens/sahabat_umkm/pull/44)). Guard 13 di `070` mengunci: unique (termasuk PK alami) tanpa `org_id` hanya kunci ini + `whatsapp_integrations_phone_number_id_key`. ✅ setelah 0065 diterapkan dan rute baru live |
| 1.6 | Trigger vendor & persona sadar org | KEA-14 | ✅ | [#41](https://github.com/jepens/sahabat_umkm/pull/41): trigger vendor hanya menyentuh org yang sama; 1 persona aktif per org (index unik parsial) |
| 1.7 | Pisahkan setting platform vs tenant di `app_settings` | KEA-9 | ✅ | [#41](https://github.com/jepens/sahabat_umkm/pull/41): tabel `platform_settings` (khusus service role); key platform keluar dari `app_settings` (0062); `verify_webhook_token` hanya membaca `platform_settings` |
| 1.8 | Persona bisa dibuat untuk org baru | KUA-6 | ✅ | [#41](https://github.com/jepens/sahabat_umkm/pull/41): `PUT /api/system-message` dengan id `default` membuat persona pertama org baru; id tak dikenal → 404 |
| 1.9 | Realtime: filter org + mitigasi event DELETE | KEA-15, PER-8 | 🔄 | Langkah 0 selesai: 0063 (cabut hak tabel anon) diterapkan 2026-10-16 ([#43](https://github.com/jepens/sahabat_umkm/pull/43)); anon key tidak lagi menerima kolom event DELETE. Langkah 1 selesai: **0064 (expand) diterapkan** 2026-10-16 ([#44](https://github.com/jepens/sahabat_umkm/pull/44)) — bus Realtime per org: topik privat `org:<uuid>` (policy `realtime.messages` hanya-terima, terikat ke topik yang di-join), 15 trigger statement-level yang memanggil fungsi `SECURITY DEFINER`, payload v1 tanpa nomor/teks (`orders` ikut live). Langkah 2 (PR klien, belum di-deploy): `OrgRealtimeProvider` — satu channel privat `org:<uuid>` per tab, satu-satunya pemilik `.channel(` (uji struktural; tidak ada lagi `postgres_changes`), RESYNC di setiap SUBSCRIBED/tab terlihat/online, channel dibuat ulang (backoff 1–30 dtk) bila server menutupnya (token kedaluwarsa, akses dicabut) atau rejoin terus gagal; semua tampilan refetch lewat PostgREST/RLS per org, polling ChatList/ChatWindow tetap, Bookings ikut live. Kontrak **0068** (kosongkan `supabase_realtime`, guard 10 tanpa filter schema) diterapkan hanya setelah build ini live, semua tab di-reload dan `realtime.subscription` = 0; lalu owner mematikan "Allow public access". Uji end-to-end lokal dengan server Realtime nyata lulus (join privat, 2 broadcast v1 tanpa teks/nomor, org lain/anon/topik rusak ditolak, channel publik bernama sama tidak menerima apa pun, re-join otomatis setelah token kedaluwarsa). Sebelum itu belum boleh ada tenant ke-2 dengan data nyata; setelah ada, 0068 tidak boleh di-rollback dengan menambah tabel lagi ke publikasi |
| 1.10 | Peran minimal owner/admin vs staff untuk aksi sensitif | KEA-17 | ➡️ | Dipindah ke Fase 3 (3.2) bersama undangan & manajemen tim — keputusan pemilik 2026-10-16 (tenant pilot awalnya 1 owner) |
| 1.11 | `chat-media` jadi bucket privat + signed URL (bacaan via URL publik masih lolos) | KEA-4 | ⬜ | Lanjutan dari 0.7 |
| 1.12 | Policy bucket `documents` tanpa fallback COALESCE ke org seed + pindahkan 15 objek legacy ke prefix org | KEA-4 | 🔄 | [#45](https://github.com/jepens/sahabat_umkm/pull/45): 0066 + skrip `scripts/migrate-legacy-kb-objects.mjs` + runbook `docs/RUNBOOK_LEGACY_KB_OBJECTS.md` (D16/D17). Produksi 2026-10-16: plan, `copy` 15 salinan (15:22 UTC) + verify, **0066 diterapkan** (`20261016154903`): 8 baris di-relink, policy tanpa COALESCE; verify: **awal masa tunggu `2026-10-16T16:02:21Z`**; uji asap pemilik lulus dan jeda KB berakhir (objek 0 byte dari unggahan kosong dihapus atas persetujuan, lihat 3.9). Sisa: merge PR, `delete-originals` (paling cepat 2026-10-19T16:02:21Z), cek akhir, keputusan D16 untuk 13 duplikat (`remove-copies --unreferenced-only`), lalu langkah 9: hapus `--out` + salinan kedua manifest ≤30 hari setelah cek akhir (UU PDP, D11) |
| 1.13 | `filter_org_id` wajib di `match_*` (termasuk `/api/search`) | KEA-25 | ✅ | [#41](https://github.com/jepens/sahabat_umkm/pull/41): `match_documents`/`match_products` fail-closed untuk `filter_org_id` NULL (0061); semua pemanggil mengirim org |
| 1.14 | Tes RLS/Storage dua-org di branch/staging Supabase | KUA-13 | ✅ | [#39](https://github.com/jepens/sahabat_umkm/pull/39): termasuk policy Storage. TODO 1.12 diselesaikan oleh 0066; 1 tes TODO tersisa (1.11) |

## Fase 2 — WhatsApp & integrasi per tenant, model "dikelola tim" (±2–3 minggu)

| # | Tugas | Temuan | Status | PR / Catatan |
|---|---|---|---|---|
| 2.1 | `whatsapp_integrations` → secret di Vault + RLS deny-by-default | KEA-16 | ⬜ | |
| 2.2 | Webhook routing per `phone_number_id` (fail-closed, loop semua `entry/changes`); semua jalur kirim pakai kredensial org | KEA-6 | ⬜ | |
| 2.3 | Setting per org (Zoom, email pengirim, notifikasi, digest, aturan) + Vault | KUA-7 | ⬜ | |
| 2.4 | Integrasi milik Sailendra (Portal, Zoom/email Sailendra) di balik flag per org | KEA-7 | ⬜ | |
| 2.5 | Template & Flow per WABA + handler status template | KUA-17 | ⬜ | |
| 2.6 | Zona waktu & aturan meeting per org | KUA-18 | ⬜ | |
| 2.7 | Versi Graph API terpusat & dinaikkan | KUA-16 | ⬜ | |
| 2.8 | Pendaftaran Meta Tech Provider (paralel, non-kode) | — | 👤 | |

## Fase 3 — Provisioning, operasi & kepatuhan pilot (±2–3 minggu)

| # | Tugas | Temuan | Status | PR / Catatan |
|---|---|---|---|---|
| 3.1 | Peran platform-admin + provisioning tenant + undangan + set/reset password | UXA-1, KEA-20 | ⬜ | |
| 3.2 | Konteks tenant di shell dashboard; manajemen tim minimal | UXA-7, UXA-6 | ⬜ | |
| 3.3 | Status tenant + saklar AI per org | KUA-8 | ⬜ | |
| 3.4 | Metering `usage_events` (token OpenAI, pesan WA) + kuota endpoint AI | KUA-9, KEA-8 | ⬜ | |
| 3.5 | Observabilitas: log ber-`org_id` tanpa PII + error monitoring | KUA-2, KEA-21 | ⬜ | |
| 3.6 | Staging + gerbang CI sebelum deploy + health check | PER-2 | ⬜ | |
| 3.7 | Keandalan antrean: idempotensi retry, timeout OpenAI, fire-and-forget, paginasi | KUA-15, PER-3, PER-4, PER-5 | ⬜ | |
| 3.8 | Ketentuan Layanan, Kebijakan Privasi, DPA, daftar sub-pemroses, cek PSE | KEA-11 | 👤 | |
| 3.9 | KB: unggahan yang *ingest*-nya gagal atau menghasilkan 0 potongan (mis. file kosong) tidak boleh meninggalkan objek yatim di `documents` (objek tanpa baris tidak tampil dan tidak bisa dihapus user; UU PDP) | Temuan uji asap 0066 | ⬜ | Ditemukan 2026-10-16 saat uji asap 1.12; objeknya sudah dihapus atas persetujuan pemilik. Perbaikan: tolak file kosong di upload-zone, dan `/api/ingest` menghapus objeknya bila gagal atau 0 potongan |

## Fase 4 — Generalisasi UMKM minimum (±2–4 minggu)

| # | Tugas | Temuan | Status | PR / Catatan |
|---|---|---|---|---|
| 4.1 | `business_type` + timezone + terminologi + `org_modules` + gating navigasi/API/tool AI | KUA-12 | ⬜ | |
| 4.2 | Lepaskan identitas Sailendra dari output ke pelanggan, preset & template notifikasi | KUA-10, KUA-11, UXA-2 | ⬜ | |
| 4.3 | Notifikasi order via template bila di luar jendela 24 jam | UXA-5 | ⬜ | |
| 4.4 | Profil identitas tenant yang lebih kaya (logo, warna, pengirim, alamat) | KUA-20 | ⬜ | |
| 4.5 | Template tipe bisnis + pulihkan preset UMKM dari `761dac7` | KUA-12 | ⬜ | |
| 4.6 | `pipeline_stages` & field kustom (bila tenant pilot non-EO butuh) | KUA-12 | ⬜ | |

## Fase 5 — Setelah pilot: komersial & skala

| # | Tugas | Temuan | Status | PR / Catatan |
|---|---|---|---|---|
| 5.1 | Billing langganan + UI paket/pemakaian | KUA-19, UXA-8 | ⬜ | |
| 5.2 | Skala: fairness antrean, rate limiter per tenant, RLS set-based, index ANN, higiene index | PER-6, PER-9, PER-7, PER-10, PER-11 | ⬜ | |
| 5.3 | Siklus hidup data: retensi, ekspor/offboarding tenant, audit log | KUA-21 | ⬜ | |
| 5.4 | Self-serve signup (org baru + CAPTCHA server-side) + Embedded Signup | — | ⬜ | |
| 5.5 | Perapian | KEA-26, KEA-28, KUA-23, KUA-24, KUA-25, UXA-9 | ⬜ | KEA-28 bagian tabel + default privileges selesai lewat 0063 ([#43](https://github.com/jepens/sahabat_umkm/pull/43)); sisa: EXECUTE anon/authenticated pada `cleanup_*` |

## Log progres

| Tanggal | Catatan |
|---|---|
| 2026-10-15 | Audit kesiapan SaaS selesai ([laporan](../audits/AUDIT-2026-10-15.md)): 7 Kritis, 25 Tinggi, 32 Sedang, 9 Rendah. Tracker ini dibuat. Sign-up Supabase masih terbuka. |
| 2026-10-15 | Keputusan D1–D3 diambil. **Sign-up publik ditutup** (0.1 ✅). Fase 0 dimulai dalam 3 PR: PR-A isolasi tenant & akses (0058), PR-B hardening + docs, PR-C batas tool AI (0059). PR-A & PR-C dikerjakan agen di worktree terpisah + review adversarial; PR-B dikerjakan langsung. |
| 2026-10-15 | PR dibuka: [#35](https://github.com/jepens/sahabat_umkm/pull/35) hardening + docs, [#36](https://github.com/jepens/sahabat_umkm/pull/36) isolasi tenant (0058 + 0060), [#37](https://github.com/jepens/sahabat_umkm/pull/37) batas tool AI (0059). Review adversarial: #36 approve (major di luar cakupan → 0060), #37 1 major + 6 minor → semua diperbaiki. Uji integrasi gabungan: 268 test lulus, build ✓. Migrasi **belum** diterapkan (menunggu review pemilik, D1). |
| 2026-10-16 | [#35](https://github.com/jepens/sahabat_umkm/pull/35) di-merge (`9c92dde`). Migrasi **0058 + 0060 diterapkan** ke produksi via Supabase MCP dan terverifikasi (policy 4 tabel + 2 bucket, grant RPC, trigger `handle_new_user`; advisor: tidak ada temuan baru). [#36](https://github.com/jepens/sahabat_umkm/pull/36) di-merge (`1ddba83`). Keputusan D4/D12/D13 diambil dan diterapkan di [#37](https://github.com/jepens/sahabat_umkm/pull/37). Deploy Easypanel belum terlihat di header produksi saat dicek — perlu konfirmasi auto-deploy. |
| 2026-10-16 | [#37](https://github.com/jepens/sahabat_umkm/pull/37) di-merge (`e7ef424`) setelah CI hijau pada kode gabungan (main digabung ke branch: 272 test lulus). Migrasi **0059 diterapkan** & terverifikasi. **Semua kode Fase 0 sudah di `main` dan semua migrasi aktif.** ⚠️ Deploy Easypanel belum terdeteksi: setelah 15+ menit produksi masih build lama (tanpa security header baru, `/design-system` masih 200) — perlu dicek di Easypanel. Migrasi 0058/0059/0060 kompatibel dengan kode lama, jadi produksi tetap berjalan normal. |
| 2026-10-16 | **Deploy Fase 0 live** (build Easypanel #37 sukses): 6 security header aktif, `/design-system` 404, halaman debug di-redirect. Pipeline WhatsApp belum bisa diverifikasi dari data (belum ada pesan masuk sejak deploy) — kirim 1 pesan uji. Keputusan D9: 1 user = 1 org. **Fase 1 dimulai.** |
| 2026-10-16 | [#38](https://github.com/jepens/sahabat_umkm/pull/38) di-merge (`c0dd059`). **Pipeline WhatsApp terverifikasi pasca-deploy**: sejak 09.00 WIB 10 pesan masuk / 10 balasan bot, 10 job antrean `completed`, 0 gagal. Fase 1 gelombang 1: F1-B (konteks org + proxy.ts) selesai & di-review (approve); F1-A (migrasi reproducible + pgTAP) terhenti karena batas sesi — pekerjaan diamankan sebagai commit WIP, fingerprint replay lokal **identik** dengan produksi; dilanjutkan. |
| 2026-10-16 | Fase 1 gelombang 1 selesai: [#39](https://github.com/jepens/sahabat_umkm/pull/39) (F1-A, 2 major + 4 minor review diperbaiki) dan [#40](https://github.com/jepens/sahabat_umkm/pull/40) (F1-B, 1 major + 9 minor diperbaiki). Uji integrasi gabungan: 466 test, `next build` ✓ (Proxy terdeteksi). Keputusan: 1.10 (peran) dipindah ke Fase 3. |
| 2026-10-16 | [#39](https://github.com/jepens/sahabat_umkm/pull/39) di-merge (`8e48cb6`) dan [#40](https://github.com/jepens/sahabat_umkm/pull/40) di-merge (`c43008c`). Ternyata **deploy produksi manual** (pemilik menekan Deploy di Easypanel; merge tidak men-deploy apa pun). Setelah deploy, #40 terverifikasi live: body 401 baru dan `/dashboard` → `/login`. |
| 2026-10-16 | **Fase 1 gelombang 2 selesai ([#41](https://github.com/jepens/sahabat_umkm/pull/41)).** Urutannya: 0061 (expand) diterapkan sebelum merge dan diverifikasi; fingerprint 570 baris cocok dengan kueri hash produksi. #41 di-merge (`4cfe994`), lalu deploy manual. Build baru dipastikan live lewat log Supabase: server membaca `platform_settings`, bukan `app_settings`. Sesudah itu **0062 (contract) diterapkan**. Verifikasi: tidak ada lagi `DEFAULT org_id`, unique global sudah di-drop, key platform hanya di `platform_settings`, token webhook valid, dan log bersih (0 pelanggaran NOT NULL/ON CONFLICT). **Skema produksi kini identik dengan replay migrasi** (563 baris, md5 bf973342…). |
| 2026-10-16 | Fase 1 gelombang 3 dimulai. Desain read-only (6 PR, kritik adversarial: 3 major sudah dimasukkan ke rencana). Keputusan pemilik D16–D21. [#43](https://github.com/jepens/sahabat_umkm/pull/43): **0063 diterapkan** (versi `20261016132423`): 0 relasi `public` dengan hak anon, default ACL postgres/public tanpa anon, `authenticated` tetap normal; skema produksi = replay (563 baris, md5 d64ce891…). **Gerbang tenant ke-2:** belum boleh ada data nyata tenant lain sebelum 0067 (`chat-media` privat) dan 0068 (kontrak Realtime + "Allow public access" mati) live. |
| 2026-10-16 | [#44](https://github.com/jepens/sahabat_umkm/pull/44): **0064 + 0065 diterapkan** (versi `20261016143849`, `20261016143924`). 0064: 15 trigger di 5 tabel, 1 policy `realtime.messages` (SELECT, `authenticated`), broadcaster SECURITY DEFINER tanpa EXECUTE untuk peran API; 0065: RPC SECURITY DEFINER (anon tidak bisa, `authenticated` bisa; WARN advisor disengaja). Antrean sehat; skema produksi = replay (591 baris, md5 d438f1ae…). Sisa 1.5: deploy rute push. PR 0066 (dokumen legacy): latihan penuh di stack lokal terpisah lulus (plan/copy/verify, guard menolak, 0066, hapus oleh user, delete-originals, restore dari salinan & backup). |
| 2026-10-16 | [#45](https://github.com/jepens/sahabat_umkm/pull/45) (dokumen legacy, 1.12): review adversarial 3 lensa sebelum 0066 (0 blocker, 0 major; simulasi read-only relink 8 / guard 0-0-0). Atas persetujuan pemilik: `plan`, `copy` 15 salinan + verify, lalu **0066 diterapkan** (`20261016154903`). Temuan minor diperbaiki di PR: masa tunggu dihitung dari verify setelah 0066, plan ulang mengenali baris yang sudah di-relink, fase `remove-copies`, `--only-user-deleted` untuk rollback, validasi `backup_file`, typecheck skrip di CI, tes paritas guard, kasus uuid huruf besar dan `..` di 170. Skema produksi = replay (591 baris, md5 21e99794…). |
| 2026-10-17 | [#45](https://github.com/jepens/sahabat_umkm/pull/45) putaran 2 (temuan review atas perbaikan sebelumnya): alat rollback bisa dipakai dalam kondisi nyata (`--only-user-deleted` tidak lagi terhalang salinan rusak entri lain; `remove-copies` ikut menghapus sisa entri yang dihapus user dan menghapus awal masa tunggu), D16 lewat `remove-copies --unreferenced-only` (ditandai `d16_deleted_at`; `verify`, `copy`, dan `restore` melewatinya), `plan` ulang ditolak setelah `copy` kecuali `--allow-replan`, `--soak-hours` di bawah 72 ditolak di luar stack lokal, masa tunggu dicetak dan direset kalau 0066 di-revert, tes paritas memeriksa setiap salinan guard dan mengunci sha256 0066. Runbook: urutan rollback (jeda KB, `--only-user-deleted` sebelum dan sesudah revert), langkah 8b, dan catatan produksi. Latihan E2E di stack lokal terpisah: rollback selama masa tunggu, serta D16 lalu rollback setelah langkah 7; pgTAP 745 lulus. |
| 2026-10-17 | [#45](https://github.com/jepens/sahabat_umkm/pull/45) putaran 3 (review adversarial atas putaran 2: 0 blocker, 0 major, 9 minor/nit terkonfirmasi): `restore` yang terputus bisa diulang (objek yang sudah ditulis dicatat kalau sama dengan manifest); SQL revert dibuat skrip (`--phase=revert-sql`, idempoten, tanpa nama file) menggantikan SQL header 0066; baris manifest yang tidak menunjuk salinan maupun aslinya membuat `verify` gagal dan `copy`/`remove-copies` berhenti; setiap fase yang melihat revert menghapus awal masa tunggu; `copy`/`restore` menunggu D16 yang terputus; `plan` menolak setelah langkah 7; pengingat salinan kedua manifest; tes paritas peka huruf dalam literal dan membandingkan setiap salinan utuh (15 mutan tertangkap). Runbook: jeda KB sampai `remove-copies`, langkah "kalau sebuah langkah menolak", salinan kedua sampai langkah 9. Latihan E2E putaran 3 lulus. |
