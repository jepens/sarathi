# WABA Webhook Technical Reference

Informasi teknis mengenai implementasi Webhook WhatsApp Business API (WABA) yang digunakan dalam aplikasi Sahabat UMKM.

## Lokasi File Utama
`app/api/webhook/whatsapp/route.ts`

## Deskripsi Endpoint
Endpoint ini melayani permintaan dari Meta/WhatsApp Platform untuk verifikasi webhook dan penerimaan event (pesan masuk).

### 1. Verifikasi Webhook (GET)
Digunakan oleh Meta saat pendaftaran atau perubahan konfigurasi webhook di Dashboard Developer.
- **Tujuan**: Memvalidasi bahwa server ini memang milik Anda.
- **Logika**: 
  - Memeriksa parameter `hub.mode` (harus `subscribe`).
  - Memeriksa `hub.verify_token` melalui fungsi `checkVerifyToken` di `lib/settings/app-settings.ts`.
  - Jika valid, mengembalikan `hub.challenge`.
- **Lokasi Kode**: Baris 12-29 di `route.ts`.

### 2. Penerimaan Pesan (POST)
Endpoint utama untuk menerima data JSON dari WhatsApp saat terjadi interaksi dari pengguna.
- **Tujuan**: Memproses pesan masuk, mengelola riwayat chat, dan memicu respon AI.
- **Alur Kerja**:
  1. **Verifikasi Signature**: Memeriksa header `x-hub-signature-256` untuk memastikan request berasal dari Meta (aktif di mode produksi).
  2. **Parsing Data**: Mengambil data pesan (sender number, message body, type).
  3. **Rate Limiting**: Memeriksa batas pengiriman pesan per user menggunakan `checkRateLimit`.
  4. **Antrian (Queue)**: Memasukkan pesan ke dalam antrian database menggunakan `enqueueMessage`.
  5. **Pengolahan Asinkron**: Memanggil `processQueue` secara "fire and forget" untuk menanggapi pesan sesegera mungkin.
  6. **Riwayat Chat**: Menyimpan pesan ke tabel `whatsapp_chats` (ringkasan) dan `whatsapp_messages` (detail log).
- **Lokasi Kode**: Baris 31-142 di `route.ts`.

## Dependensi & Modul Terkait
- **`lib/settings/app-settings.ts`**: Mengelola konfigurasi token verifikasi (`WHATSAPP_VERIFY_TOKEN`).
- **`lib/whatsapp/security.ts`**: Logika verifikasi tanda tangan (signature verification).
- **`lib/whatsapp/rate-limiter-db.ts`**: Pembatasan jumlah pesan di tingkat database.
- **`lib/whatsapp/queue-db.ts`**: Manajemen antrian pesan masuk untuk performa yang lebih stabil.
- **`lib/whatsapp/client.ts`**: Fungsi untuk mengirim pesan balik ke pengguna.
- **`lib/whatsapp/history.ts`**: Pencatatan aktivitas sistem ke log riwayat.

## Konfigurasi Meta Dashboard
Untuk mengaktifkan webhook ini, gunakan pengaturan berikut di Meta App Dashboard:
- **Callback URL**: `https://[domain-aplikasi]/api/webhook/whatsapp`
- **Verify Token**: Sesuai dengan nilai di `.env` (`WHATSAPP_VERIFY_TOKEN`) atau pengaturan di database `app_settings`.
- **Webhook Fields**: Pastikan untuk berlangganan (subscribe) ke field `messages`.

## Penanganan Keamanan
- **Service Role Key**: Database operations di dalam webhook menggunakan Supabase Service Role Key untuk melewati RLS (Row Level Security), karena webhook dipanggil oleh sistem eksternal (Meta) tanpa session user.
- **Signature Verification**: Validasi HMAC SHA256 dari payload untuk mencegah serangan spoofing.
