# Runbook: pindah ke domain netral (D28)

Keputusan pemilik 2026-11-14 (D28): sebelum tenant ke-2, Sarathi pindah dari `nindra.sailendra.co.id` ke domain netral. Alasannya, tim tenant tidak seharusnya login di domain bermerek Sailendra/Nindra.

Tidak ada perubahan kode yang wajib. Semuanya diatur lewat konfigurasi berikut.

## Sebelum pindah
1. **DNS dan Easypanel**: arahkan domain baru ke server. Tambahkan domain itu ke service **app** di Easypanel *di samping* domain lama, lalu tunggu sertifikat TLS aktif. Domain lama tetap hidup selama masa transisi.
2. **Cloudflare Turnstile**: tambahkan hostname baru ke daftar domain widget. Kalau tidak, CAPTCHA login gagal di domain baru.
3. **Supabase Auth** (Authentication → URL Configuration): tambahkan domain baru ke *Redirect URLs*. Undangan dan reset password memakai *Site URL*, jadi URL itu diganti di langkah 6.

## Pindah
4. **Env `NEXT_PUBLIC_APP_URL`** di service app: ganti ke domain baru, lalu **build ulang**. Nilai `NEXT_PUBLIC_*` ditanam saat build, jadi restart saja tidak cukup.
5. **Webhook Meta** (App Dashboard aplikasi Sailendra → WhatsApp → Configuration): ganti *Callback URL* ke `https://<domain-baru>/api/webhook/whatsapp/<webhook_key>`, dengan key dari `scripts/wa-provision.mjs --phase=status` (D34: hanya host yang berubah; webhook key dan *verify token* tetap sama). Meta langsung memverifikasi URL baru, jadi build dari langkah 4 harus sudah live.
6. **Supabase Auth Site URL**: ganti ke domain baru.
7. **Service cron** (`deploy/cron`): ganti `TARGET_URL` ke `https://<domain-baru>/api/queue/process`, lalu deploy ulang service cron.

## Sesudah pindah
8. **Uji asap**:
   - login di domain baru (CAPTCHA tampil);
   - kirim pesan WhatsApp masuk; balasan AI datang;
   - Settings menampilkan "Dikelola tim Sarathi · Terhubung";
   - antrean jalan: log cron menunjukkan 200.
9. **Pengguna dashboard** perlu login ulang di domain baru, karena cookie sesi terikat ke domain. Mereka juga perlu mengaktifkan ulang notifikasi push dan memasang ulang PWA, karena langganan push terikat ke origin.
10. **Pantau alarm** (`webhook_error`, `webhook_payload_invalid`) selama 24 jam.
11. **Domain lama** baru dilepas dari Easypanel setelah tidak ada lagi trafik webhook atau cron ke sana. Cek log akses Easypanel.

## Tenant ke-2
Nomor tenant ke-2 langsung memakai domain baru sejak awal (URL webhook per aplikasi, tugas 2.2c dan runbook onboarding 2.9).

## Tidak tercakup di sini
- **Email bermerek Sailendra** pada fitur khusus Sailendra (proposal, undangan meeting; D26) tetap memakai pengirim Sailendra.
- **Kredit "by Sailendra"** di dashboard dan landing termasuk D10 (Fase 4).
