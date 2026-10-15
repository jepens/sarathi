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

### Menunggu keputusan

| # | Topik | Dibutuhkan untuk | Status |
|---|---|---|---|
| D4 | Persona default: bot mengaku asisten AI bila ditanya | Fase 0 (0.14) | ⏸️ |
| D5 | Tipe bisnis 1–5 calon tenant pilot | Fase 4 | ⏸️ |
| D6 | Model akun Meta (app per klien vs app platform Sarathi) & entitas legal pemilik Sarathi | Fase 2 | ⏸️ |
| D7 | Kunci OpenAI milik platform (dengan metering) vs dibawa tenant; model default | Fase 3 | ⏸️ |
| D8 | Fitur khusus Sailendra (Portal, proposal/FNA, Flow Brief Acara, Zoom) untuk tenant lain | Fase 2 / 4 | ⏸️ |
| D9 | Bolehkah satu user menjadi anggota beberapa org (perlu "org aktif") | Fase 1 | ⏸️ |
| D10 | Branding "by Sailendra" di dashboard tenant | Fase 4 | ⏸️ |
| D11 | Kebijakan retensi data (UU PDP) | Fase 3 / 5 | ⏸️ |

## Fase 0 — Tutup celah yang berlaku sekarang (±1–2 hari)

| # | Tugas | Temuan | Status | PR / Catatan |
|---|---|---|---|---|
| 0.1 | Matikan "Allow new users to sign up" di Supabase Auth | KEA-1 | ✅ | 2026-10-15: `disable_signup=true` via Management API; terverifikasi di `GET /auth/v1/settings`. CAPTCHA Auth sudah aktif. Sisa: trigger `handle_new_user` (0043) masih auto-join → ditangani di Fase 1 (undangan). |
| 0.2 | Rotasi kunci OpenAI, token System User & App Secret WhatsApp, kunci Komerce | KEA-13 | 👤 | Kunci yang bocor = kunci aktif saat ini |
| 0.3 | Hapus `log_deploy.md` & nilai rahasia di `database/migrate_env_to_settings.sql`; pemindai secret di CI | KEA-13 | 🔄 | PR-B (`chore/fase0-hardening`): file dihapus, SQL diganti placeholder, job CI gitleaks v8.30.1 (hanya commit PR). Rotasi kunci tetap wajib (0.2). |
| 0.4 | Tangani 2 akun + org pilot sisa | KEA-2 | ⬜ | D2: dipertahankan sebagai tenant uji; verifikasi isolasinya setelah 0.9 diterapkan |
| 0.5 | Patch dependensi (Next.js ≥ 16.3.8, sharp, postcss) + Node 22 di `nixpacks.toml` | KEA-10, KEA-22 | 🔄 | PR-B: Node 22 selesai; `npm audit fix` menunggu agen PR-A/PR-C selesai (node_modules dipakai bersama) |
| 0.6 | Migrasi RLS: 4 tabel `USING(true)` → `is_org_member(org_id)`; `push_subscriptions.user_id` | KEA-3 | 🔄 | PR-A (`fix/fase0-tenant-isolation`, migrasi 0058) — agen implementor |
| 0.7 | Storage: policy per prefix org untuk `chat-media` & `proposals` | KEA-4 | 🔄 | PR-A (0058). `chat-media` privat + signed URL = langkah lanjutan |
| 0.8 | Cabut EXECUTE `reserve_meeting_slot` dari `authenticated`; cabut anon di `match_*` | KEA-5, KEA-25 | 🔄 | PR-A (0058) |
| 0.9 | `getCurrentOrgId()` wajib keanggotaan (`organization_members`) | KEA-2 | 🔄 | PR-A; fitur kredensial env dibatasi ke org default |
| 0.10 | `updateOrderStatus` wajib login + baca order dari DB; validasi input documents/products | KEA-19, KEA-18 | 🔄 | PR-A |
| 0.11 | Tool AI katalog (`checkAvailability`/`listProducts`) pakai service role + filter org | KUA-3 | 🔄 | PR-C (`fix/fase0-ai-guardrails`) — agen implementor |
| 0.12 | Batas tool tulis AI (tahap, batas meeting per nomor, ringkasan bukan role system, handoff mematikan AI) | KEA-12 | 🔄 | PR-C (migrasi 0059). D3: AI maksimal sampai `scheduled` |
| 0.13 | Security headers; logout mencabut push; hapus default verify token; hapus halaman debug | KEA-24, KEA-23, KEA-27, KUA-22 | 🔄 | PR-B: headers, verify token fail-closed, halaman debug 404 di produksi. PR-A: logout mencabut push + tampilan verify token hanya untuk org default |
| 0.14 | Persona tidak menyangkal AI; perbaiki copy landing/login | UXA-3, UXA-4 | ⏸️ D4 | |
| 0.15 | Upgrade Supabase Pro + uji restore backup | PER-1 | 👤 | Berbayar |

## Fase 1 — Fondasi multi-tenant (±2–3 minggu, wajib sebelum tenant ke-2)

| # | Tugas | Temuan | Status | PR / Catatan |
|---|---|---|---|---|
| 1.1 | Rantai migrasi bisa di-replay (`supabase init`, baseline skema, `migration repair`, perbaiki dua file 0004) | KUA-1 | ⬜ | |
| 1.2 | Suite pgTAP isolasi tenant + job CI | KUA-13 | ⬜ | |
| 1.3 | `requireOrgContext()` berbasis keanggotaan + `proxy.ts` + `getClaims()` | KEA-2, KUA-14 | ⬜ | |
| 1.4 | Semua penulis mengirim `org_id` eksplisit → cabut 13 `DEFAULT` org Sailendra | KUA-4 | ⬜ | |
| 1.5 | Unique/FK per org; FK komposit `chat_labels → labels` | KUA-5 | ⬜ | |
| 1.6 | Trigger vendor & persona sadar org | KEA-14 | ⬜ | |
| 1.7 | Pisahkan setting platform vs tenant di `app_settings` | KEA-9 | ⬜ | |
| 1.8 | Persona bisa dibuat untuk org baru | KUA-6 | ⬜ | |
| 1.9 | Realtime: filter org + mitigasi event DELETE | KEA-15, PER-8 | ⬜ | |
| 1.10 | Peran minimal owner/admin vs staff untuk aksi sensitif | KEA-17 | ⬜ | |

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
| 5.5 | Perapian | KEA-26, KEA-28, KUA-23, KUA-24, KUA-25, UXA-9 | ⬜ | |

## Log progres

| Tanggal | Catatan |
|---|---|
| 2026-10-15 | Audit kesiapan SaaS selesai ([laporan](../audits/AUDIT-2026-10-15.md)): 7 Kritis, 25 Tinggi, 32 Sedang, 9 Rendah. Tracker ini dibuat. Sign-up Supabase masih terbuka. |
| 2026-10-15 | Keputusan D1–D3 diambil. **Sign-up publik ditutup** (0.1 ✅). Fase 0 dimulai dalam 3 PR: PR-A isolasi tenant & akses (0058), PR-B hardening + docs, PR-C batas tool AI (0059). PR-A & PR-C dikerjakan agen di worktree terpisah + review adversarial; PR-B dikerjakan langsung. |
