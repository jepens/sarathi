# Rebranding: Helat → **Sarathi**

> Status: **Rencana disetujui** (konsep, palet, mark, cakupan terkunci) — siap Fase 0.
> Tanggal: 2026-06-20. Menggantikan nama produk "Helat" (lihat sejarah: Sailendra Assistant → Helat → Sarathi).

## Keputusan terkunci

| Aspek | Keputusan |
|---|---|
| Nama / ejaan | **Sarathi** (baca: *sa-ra-ti*), lockup **"Sarathi by Sailendra"** |
| Palet | **Kanaka & Nila** — emas heritage + nila/indigo, dark-default |
| Mark | **Chakra-dial** — roda berjari (kereta + dial), satu jari emas = tahap aktif |
| Tipografi | **Tetap**: Space Grotesk (display) + JetBrains Mono (telemetri) + Inter (body) |
| Cakupan tahap ini | **Marketing + auth + PWA dulu**; dashboard (kokpit) = fase lanjutan |

**Prinsip:** rebrand ini *meng-upgrade* build yang ada, bukan membuangnya. Signature "live pipeline rail" dan disiplin "ruang kendali" dipertahankan; keberanian dibelanjakan di **mark** + **aksen nila**.

---

## 1. Konsep & narasi — *"Sang Sais"*

Helat (perayaan/tiket) → **Sarathi (sais yang mengemudikan kereta)**. Produk = **kursi kemudi (kokpit)** bisnis EO. Pipeline di-reframe jadi **lintasan/jalur** menuju "Won". Pemilik = Arjuna di musim wedding; **Sarathi = AI yang menyetir & menjaga laju.**

**Sistem metafora → fitur nyata (sidebar):**

| Metafora | Fitur |
|---|---|
| Sang sais menyetir | AI Chat + WhatsApp Inbox |
| Tali kendali (otomasi) | Follow-up, auto-reply |
| Lintasan / jalur | Pipeline (inquiry → Won) |
| Menjaga laju | Follow-up reminders |
| Membaca medan | Calendar + Laporan (anti-bentrok) |
| Keretanya | Bisnis EO — dashboard = kursi kemudi |

**Positioning:** *Bukan sekadar CRM/chatbot — Sarathi yang menyetir tiap lead sampai booking.*

**Tagline:** utama → "Anda yang punya hajat. Sarathi yang menyetir." · sub → "Dari chat WhatsApp, jadi acara ter-booking." (dipertahankan).

**Nada suara:** tenang, cekatan, kawan ahli (bukan korporat). Sentence case, kata kerja aktif, Bahasa Indonesia.

---

## 2. Sistem visual

### Palet "Kanaka & Nila" (dark-default)
Insight: **Kresna**, sang Sarathi agung, berkulit **nila**; kereta & mataharinya **emas**. *"Nila"* = indigo dalam bahasa Indonesia.

| Token | Hex | Peran |
|---|---|---|
| `--brand-ink` | `#0B0B0E` | base malam |
| `--brand-surface` | `#16161C` | kartu/panel |
| `--brand-bone` | `#F4F1E9` | teks terang |
| `--brand-muted` | `#8B8A94` | teks sekunder |
| `--brand-gold` | `#E6B450` | **Kanaka** — aksen primer (menang/perayaan) |
| `--brand-brass` | `#B8862F` | hairline / grid wash |
| `--brand-indigo` | `#4F46E5` | **Nila** — aksen sais/AI |
| `--brand-indigo-lit` | `#818CF8` | state aktif / teks indigo on-dark |

Warna fungsional pipeline tetap: slate `#94A3B8`, blue `#60A5FA`, amber `#FBBF24`, cyan `#22D3EE`, emerald `#34D399`.

### Tipografi
Tetap. Space Grotesk = suara signage ruang-kendali; JetBrains Mono = angka tabular telemetri; Inter = body. Tidak menambah font baru (risiko implementasi rendah).

### Mark — "Chakra-dial"
Roda berjari (chakra) dalam tile kotak-membulat (mengganti ikon `Ticket`).
- Pelek + hub + **6 jari** (gema 6 tahap pipeline).
- **Satu jari/segmen emas menyala** = tahap aktif → roda terbaca sebagai **dial/progress**.
- Sisanya brass/muted. Adaptif light/dark via `currentColor`; aksen emas tetap.
- Implementasi: komponen SVG inline `components/sarathi-mark.tsx`, scalable ke favicon.
- Makna berlapis: kereta + dial kokpit + gerak maju; gema roda Konark / heritage Nusantara (selaras Sailendra/Borobudur).

### Motif & signature
Pertahankan **live pipeline rail** (reframe label → *lintasan*). Grid kuningan halus, garis-laju tipis, numerals tabular.

---

## 3. Implementasi token (Tailwind v4)

Tambah di [app/globals.css](../app/globals.css):
1. Definisikan `--brand-*` di `:root` (accent brand sama untuk light/dark; ink/bone bisa diatur per-tema bila perlu).
2. Map ke `@theme inline`: `--color-brand-gold: var(--brand-gold)` dst → muncul utility `bg-brand-gold`, `text-brand-indigo`, `border-brand-brass`.
3. **Refactor hex hardcoded → token** di marketing/auth/signup. Hasil: re-skin berikutnya = ubah satu file.

Verifikasi dokumen terkini Tailwind v4 `@theme` + `next/font` via **context7** saat eksekusi.

---

## 4. Peta scope (file-by-file)

**Teks "Helat" → "Sarathi":**

| File | Lokasi |
|---|---|
| [components/brand.tsx](../components/brand.tsx) | wordmark (sumber utama) + mark |
| [components/auth/auth-shell.tsx](../components/auth/auth-shell.tsx) | wordmark `Helat` + mark Ticket |
| [components/mobile-nav.tsx](../components/mobile-nav.tsx) | "Navigasi Helat" (sr-only) |
| [app/layout.tsx](../app/layout.tsx) | title, applicationName, appleWebApp.title |
| [app/manifest.ts](../app/manifest.ts) | name, short_name, deskripsi |
| [app/page.tsx](../app/page.tsx) | header wordmark + footer credit |
| [app/signup/SignupForm.tsx](../app/signup/SignupForm.tsx) | "Kebijakan Privasi Helat" |
| [app/dashboard/page.tsx](../app/dashboard/page.tsx) | "Selamat datang di Helat …" |
| [app/dashboard/OnboardingChecklist.tsx](../app/dashboard/OnboardingChecklist.tsx) | 2 string |
| [public/offline.html](../public/offline.html) | `<title>` + `.mark` |
| [public/sw.js](../public/sw.js) | cache `helat-v1` → `sarathi-v1` (auto-invalidasi cache PWA lama) |

**Aset:** regen `icon-192x192`, `icon-512x512`, `icon-512-maskable`, `apple-icon`, favicon dari mark baru (pakai [scripts/generate-icons.mjs](../scripts/generate-icons.mjs) + dep `canvas`). **`sailendra-white/black.png` tetap.**

**TIDAK disentuh:** Business Profile tenant ([lib/settings/business-profile.ts](../lib/settings/business-profile.ts)) & konten knowledge-base tenant — itu data tenant, terpisah dari brand produk.

---

## 5. Roadmap bertahap

- [x] **Fase 0 — Token fondasi**: `--brand-*` + map `@theme` di globals.css. ✓ 2026-06-20
- [x] **Fase 1 — Verbal swap**: Helat→Sarathi di semua UI/metadata/PWA + bump cache sw. ✓ 2026-06-20
- [x] **Fase 2 — Mark + aset + nila**: `components/sarathi-mark.tsx` (Chakra-dial), refactor hex→token di 5 file marketing/auth (0 hex tersisa), regen ikon PWA + `app/icon.png` favicon, aksen nila di hero. ✓ build hijau 2026-06-20
- [x] **Fase 3 — Kokpit dashboard**: mark Chakra-dial di sidebar `brand.tsx`, active-nav rail emas (`before:bg-brand-gold`), kartu onboarding bernuansa emas, chart Laporan pakai palet brand (revenue emas, kategori emas+nila). ✓ build hijau 2026-06-20. *Pendekatan terukur:* `--primary`/`--ring` shadcn sengaja dibiarkan netral agar UI data tetap bersih — brand masuk lewat aksen, bukan membanjiri.
- [x] **Fase 4 — Docs/label deploy**: SAAS_ROADMAP, ONBOARDING_EO, PHASE1_MULTITENANCY, MOBILE_UX_AUDIT, `deploy/cron/Dockerfile` → Sarathi (jejak rename "Helat" dipertahankan di tabel histori roadmap & di dokumen ini). ✓ 2026-06-20. **Sisa di sisi Anda:** amankan domain & cek merek.

> Catatan: semua belum di-commit (user yang commit). Verifikasi: `tsc --noEmit` & `npm run build` keduanya exit 0. Sisa "Helat" yang sengaja dibiarkan: dokumen ini + satu baris histori di SAAS_ROADMAP.

## 6. Risiko & catatan
- "Sarathi" = nama portal SIM India (mParivahan) → SEO generik ramai (ironisnya on-theme). Mitigasi: domain spesifik (`sarathi.id` / `pakaisarathi.com`), selalu "by Sailendra", cek merek sebelum final.
- Marketing/auth saat ini selalu-gelap dengan hex hardcoded → wajib ditokenisasi di Fase 2 agar konsisten.
