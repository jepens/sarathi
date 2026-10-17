# Brief keputusan Fase 2: akun Meta (D6) dan fitur Sailendra (D8)

> **Keputusan pemilik 2026-10-17:** D6 = **aplikasi Meta per klien** (ditinjau ulang sebelum tenant ke-6); D8 = **khusus Sailendra, sebagian dibuka nanti**. Rincian teknis: [`FASE2_DESIGN.md`](FASE2_DESIGN.md).

Untuk pemilik Sarathi · 17 Okt 2026 · Dibutuhkan 2 keputusan.

## Ringkas
- **D6:** pilot 1–5 UMKM memakai **aplikasi Meta per klien**. Tinjau ulang sebelum tenant ke-6, atau bila calon tenant harus tetap memakai aplikasi WhatsApp Business di nomornya.
- **D8:** fitur Sailendra **tetap khusus Sailendra** lewat saklar per org. Fitur umum dibuka per tenant di Fase 4.
- 14 pekerjaan fondasi bisa mulai sekarang. Paling mendesak: rotasi kunci yang bocor (0.2) dan versi API Meta yang berhenti 21 Jan 2027.
- Perkiraan jujur: Fase 2 butuh ±2–3 bulan, bukan ±2–3 minggu seperti di pelacak (docs/SAAS_PROGRESS.md:91).

## Istilah
- **WABA**: akun WhatsApp Business; tempat nomor, template, dan Flow.
- **Portofolio bisnis**: "kantor" perusahaan di Meta, pemilik aset.
- **Aplikasi Meta**: jalur teknis Sarathi ke WhatsApp, dengan *app secret* (kunci tanda tangan pesan masuk) dan *token* (kunci kirim).
- **Tech Provider**: status Meta untuk pengelola WhatsApp bisnis lain; perlu verifikasi bisnis dan *App Review* (pemeriksaan aplikasi lewat video demo).
- **Coexistence**: satu nomor dipakai di aplikasi WhatsApp Business dan Sarathi sekaligus.

## D6 — Model akun Meta
**Sama di kedua model:** tenant memiliki nomor dan WABA di portofolionya sendiri dan membayar biaya pesan langsung ke Meta. Saat berhenti, tenant membawa nomor dan templatenya. Belum ada coexistence: nomor dilepas dari aplikasi WhatsApp Business, atau pakai nomor baru. Portofolio baru hanya boleh memulai percakapan dengan 250 pelanggan per 24 jam; verifikasi bisnis menaikkannya ke 2.000.

| | **C · Aplikasi per klien** | **P · Satu aplikasi platform** |
|---|---|---|
| Cara kerja | Tim membuat aplikasi Meta di portofolio tiap klien | Klien membagikan WABA ke portofolio Sarathi |
| Pemilik | Klien: nomor, WABA, aplikasi | Klien: nomor, WABA; Sarathi akses partner |
| Syarat Meta | Tanpa App Review; perlu kebijakan privasi | Badan usaha terverifikasi, App Review, kebijakan privasi, fitur buat template (untuk video) |
| Biaya | Tanpa biaya Meta; jam tim naik per tenant | Tanpa biaya Meta; biaya awal mengurus badan usaha dan review |
| Tenant ke-2 | Saat kode siap | Saat kode siap **dan** review lolos (lamanya belum terverifikasi) |
| Kerja tim per tenant (perkiraan) | ±2–4 jam + tunggu Meta; merawat N aplikasi | ±2–3 jam + tunggu Meta; satu aplikasi |
| Risiko utama | Tim butuh akses admin di portofolio klien. Klien melihat app secret-nya, jadi bisa memalsukan pesan ke org-nya sendiri dan menguras anggaran AI. Belum pasti Meta menerima pola ini jangka panjang. | Meta membatasi 1 system user (akun mesin pemegang token) + 1 admin per portofolio, 10 setelah review tambahan; jadi satu token menjangkau banyak tenant. Satu app secret bocor = semua tenant terdampak. Review bisa tertunda atau ditolak. |
| Ke depan | Pindah ke P per tenant lewat "Assign partner" (klien membagikan WABA) | Siap untuk Embedded Signup (klien mendaftar sendiri lewat jendela Meta) dan coexistence (5.4) |

Varian P lewat portofolio Sailendra lebih cepat. Tetapi admin Business Manager Sailendra jadi bisa menjangkau WhatsApp semua tenant, dan belum pasti aplikasinya bisa dipindah ke badan usaha Sarathi nanti.

**Rekomendasi: C untuk pilot.**
1. Pilot tidak menunggu App Review atau keputusan badan usaha.
2. Sailendra sudah memakai pola ini, jadi tidak perlu pindah aplikasi.
3. Batas system user tidak jadi masalah, karena tiap klien punya portofolio sendiri.

Syarat: kuasa tertulis dan DPA (perjanjian pemrosesan data) dari tiap klien; akses tim atas nama orang, dengan verifikasi dua langkah, dicabut saat klien berhenti; kuota AI per org. Badan usaha tetap perlu untuk kontrak dan kebijakan privasi (3.8), tetapi tidak menghambat Meta. Butir 2.8 (Tech Provider) pindah ke 5.4.

**Berubah ke P bila:** calon tenant wajib tetap memakai aplikasi WhatsApp Business di nomor yang sama; target lebih dari ±5 tenant atau pendaftaran mandiri; Meta atau penasihat hukum menolak pola C; klien menolak memberi akses admin; atau badan usaha Sarathi sudah terverifikasi (mulai P paralel).

Sumber: [batas system user](https://developers.facebook.com/docs/business-management-apis/system-users/overview), [tanpa review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review.md), [coexistence](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users.md), [pembayaran](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview.md), [batas 250](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits.md).

## D8 — Fitur khusus Sailendra
Fitur ini memakai akun Sailendra (Zoom, email, nomor WhatsApp, Portal), dan sebagian belum dikunci per org. Begitu nomor kedua dirutekan, booking tenant lain akan membuat ruang Zoom Sailendra dan memberi tahu sales Sailendra (lib/ai/tools.ts:971,1019,1047). Jadi **saklar per org (nyala/mati fitur per tenant) wajib ada sebelum tenant ke-2, apa pun jawaban D8.**

| Fitur | Keterikatan | Saran |
|---|---|---|
| Portal Sailendra | Aplikasi Sailendra; tombol tampil di semua org | Khusus Sailendra |
| Proposal email/PDF, FNA (ringkasan kebutuhan), nomor SLDR | Merek dan pengirim Sailendra | Khusus Sailendra |
| Flow "Brief Acara" | Di WABA Sailendra; setiap balasan Flow dijawab "Tim Sailendra" | Khusus Sailendra; tenant lain: simpan saja |
| Zoom otomatis | Satu akun Zoom Sailendra | Khusus Sailendra; tenant lain "link menyusul" |
| Email undangan meeting | Pengirim dan kotak masuk Sailendra | Saklar; nanti "<Bisnis> via Sarathi" |
| Notifikasi sales, digest, notifikasi order | Nomor dan template Sailendra | Fitur umum: buka per tenant di Fase 4 |
| Preset persona/KB, teks "MJ" | Terlihat semua tenant | Netralkan sebelum tenant ke-2 |
| Menu EO (Paket Acara, Vendor) | Hanya cocok untuk EO | Modul per jenis usaha (4.1) |

**Rekomendasi:** khusus Sailendra sekarang; fitur umum dibuka per tenant di Fase 4 setelah tenant punya template sendiri. Portal, proposal/FNA, Brief Acara, dan Zoom tetap khusus Sailendra.

## Fondasi yang bisa mulai sekarang (tidak bergantung D6)
S ≤1 hari, M 2–4 hari, L 1–2 minggu kerja engineer, belum termasuk review dan masa uji.
1. Rotasi kunci yang bocor (0.2), oleh pemilik — S
2. Cek awal baca-saja: semua nomor di aplikasi Sailendra, Vault, tabel integrasi — S
3. Versi API Meta (Graph API) di satu tempat, naik ke v25.0 — S
4. Kunci tabel integrasi WhatsApp dari anggota org — S
5. Perbaiki dokumen yang keliru — S
6. Alarm minimal ke tim (pesan dibuang, antrean gagal) — M
7. Perkuat webhook (saluran pesan masuk): cek tanda tangan dulu, proses semua pesan, aman saat Meta mengirim ulang — L
8. Semua jalur kirim memakai kredensial (kunci akses) org masing-masing — M
9. Saklar fitur per org — M
10. Netralkan identitas Sailendra/MJ di preset dan teks AI — M
11. Daftar template dan Flow per WABA — L
12. Pengaturan per org; rahasia Zoom/Portal di Vault (brankas terenkripsi) — L
13. Kuota AI minimal per org — M
14. Zona waktu dan aturan meeting per org — L (S bila semua tenant WIB)

Setelah D6 = C: URL webhook per aplikasi (M), skrip provisioning (M; rahasia diketik pemilik sendiri, tidak lewat Claude), pindah Sailendra (S), runbook dan gladi (M).
Gerbang tenant ke-2: 0067 diterapkan (PR #47 sudah di-merge; menurut repo kontraknya belum diterapkan), Fase 1 tuntas, butir 1–13 selesai, dokumen 3.8 ditandatangani, D8 dicatat per tenant.

## Fakta yang harus dikonfirmasi ke Meta (semua belum terverifikasi)
- Bolehkah tim mengelola banyak aplikasi milik klien sebagai "developer langsung" jangka panjang?
- Bisakah WABA dibuat di Business Suite di Indonesia tanpa aplikasi developer? (WABA dari aplikasi developer tidak bisa dipakai di Embedded Signup nanti.)
- Dokumen verifikasi bisnis yang diterima untuk usaha Indonesia, dan lama verifikasi serta App Review.
- Metode pembayaran Meta yang bisa dipakai UMKM.
- Apakah field `user_id_update` sudah bisa didaftarkan (subscribe) di dasbor.
- Apakah versi data webhook diatur per aplikasi di dasbor.
- Lama Meta mengirim ulang: 36 jam atau 7 hari (dokumen Meta berbeda).
- Bila P: bisakah aplikasi yang lolos review dipindah ke badan usaha lain?
- Untuk penasihat hukum: klausul 4.7 (penyedia AI) di syarat WhatsApp Business.
