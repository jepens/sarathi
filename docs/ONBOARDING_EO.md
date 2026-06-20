# Onboarding EO baru ke Sarathi

Panduan menghubungkan satu Event Organizer (tenant) baru sampai bot WhatsApp-nya
siap melayani klien. Dashboard menampilkan checklist versi ringkas dari langkah
ini di halaman utama sampai org mulai menerima chat.

Setiap tenant terisolasi penuh (RLS per `org_id`): data chat, KB, produk, profil,
dan kredensial WhatsApp satu org tidak pernah terlihat oleh org lain.

## 1. Daftar akun
- Buka `/signup`, isi **Nama Bisnis** (jadi nama org), email, password.
- Trigger `handle_new_user` otomatis membuat: organization, membership (owner),
  dan satu baris `business_profiles` awal (business_name = nama bisnis,
  assistant_name = "Asisten").
- Jika konfirmasi email aktif, verifikasi dulu lewat email.

## 2. Lengkapi Profil Bisnis — Settings → Profil Bisnis
Isi minimal: nama asisten, spesialisasi, **nama & nomor hand-off** (orang/nomor
WhatsApp tujuan eskalasi). Persona bot dan tool hand-off dibangun dari profil ini
— jadi bot bicara sebagai bisnis Anda, bukan default.

## 3. Hubungkan WhatsApp — Settings → WhatsApp
Dari Meta App (WhatsApp → API Setup) masukkan:
- **Phone Number ID** (unik per nomor; dipakai webhook untuk routing ke org ini)
- **WABA ID** (opsional)
- **Display phone** (opsional, untuk tampilan)
- **Access Token** dan **App Secret** (disimpan write-only; App Secret dipakai
  verifikasi signature webhook, Access Token untuk mengirim balasan)

## 4. Arahkan webhook Meta ke Sarathi
Di Meta App → WhatsApp → Configuration:
- **Callback URL**: URL Sarathi + `/api/webhook/whatsapp`
  (lihat Settings → WhatsApp, atau checklist di dashboard)
- **Verify Token**: token yang sama untuk semua tenant (webhook melakukan routing
  berdasarkan `phone_number_id` di payload, lalu verifikasi signature dengan
  `app_secret` org pemilik nomor tersebut)
- **Subscribe** ke field **`messages`** (dan `message_template_status_update` bila
  pakai template).

> Catatan: Embedded Signup (otomatis tanpa salin-tempel kredensial) butuh
> verifikasi Meta Tech-Provider — belum diaktifkan. Untuk sekarang setup manual.

## 5. Isi Knowledge Base — Knowledge
Upload brosur/paket (PDF/teks) atau tulis langsung di editor. File disimpan di
storage dengan prefix `<org_id>/…` (terisolasi per org); potongannya di-embed ke
tabel `documents` (juga per org). Bot hanya menjawab dari KB org-nya sendiri.

## 6. Tes
Kirim WhatsApp ke nomor tenant tersebut. Cek **Chats** di dashboard — pesan masuk
+ balasan bot muncul, persona sesuai Profil Bisnis. Setelah ada chat pertama,
checklist onboarding di dashboard otomatis hilang.

---

### Catatan operasional (deploy Easypanel/VPS)
- **Penguras antrian (cron).** `vercel.json` cron tidak aktif di luar Vercel.
  Antrian dikuras inline oleh webhook tiap pesan masuk, tapi job yang **di-retry**
  atau **nyangkut di `processing`** (worker restart) butuh pemicu berkala.
  Solusi: jalankan service cron mandiri dari `deploy/cron/` (lihat
  `deploy/cron/README.md`) — service Alpine kecil yang `GET /api/queue/process`
  tiap menit. Endpoint-nya **GET** dan dilindungi `CRON_SECRET` (header
  `Authorization: Bearer <CRON_SECRET>`); set `CRON_SECRET` yang sama di service
  app dan service cron. Alternatif: scheduler eksternal (cron-job.org) ke URL +
  header yang sama.
- Pengambilan job sudah **atomik** (`claim_queue_jobs`, `FOR UPDATE SKIP LOCKED`),
  jadi cron + drainer inline tidak akan membalas dobel, dan job yang stranded
  otomatis di-reclaim.
- Kredensial OpenAI & verify-token webhook bersifat global (env/app_settings),
  bukan per-org.
