# Troubleshooting: Chat Tidak Muncul di Dashboard

## Masalah
Chat yang dikirim tidak muncul di `/dashboard/chats`

## Penyebab Umum

### 1. **Arah Pesan Salah**
WhatsApp Business API hanya mengirim webhook untuk **pesan yang MASUK ke nomor bisnis**.

✅ **BENAR** (akan muncul di dashboard):
- Nomor Pribadi (Customer) → Nomor Bisnis (Anda)
- Pesan ini akan memicu webhook dan tersimpan di database

❌ **SALAH** (tidak akan muncul otomatis):
- Nomor Bisnis (Anda) → Nomor Pribadi (Customer)
- Pesan ini TIDAK memicu webhook
- Harus dikirim via dashboard `/dashboard/chats` agar tersimpan

### 2. **Format Nomor Telepon Berbeda**
Pastikan format nomor konsisten:
- WhatsApp API menggunakan format: `62812XXXXXXXX` (tanpa +)
- Jika Anda simpan dengan format berbeda, chat tidak akan match

### 3. **Webhook Belum Dikonfigurasi**
Pastikan webhook sudah terdaftar di Meta Developer Console:
- URL: `https://your-domain.com/api/webhook/whatsapp`
- Verify Token: Sesuai dengan setting di `/dashboard/settings`

### 4. **Database Belum Ter-update**
Cek apakah data benar-benar tersimpan:
- Buka: `/dashboard/debug-chats`
- Lihat apakah nomor telepon muncul di tabel `whatsapp_chats`
- Lihat apakah pesan muncul di tabel `whatsapp_messages`

## Cara Test yang Benar

### Test 1: Pesan Masuk (Incoming)
1. Buka WhatsApp di HP (nomor pribadi)
2. Kirim pesan ke nomor bisnis WhatsApp Anda
3. Tunggu 5-10 detik
4. Refresh halaman `/dashboard/chats`
5. Chat seharusnya muncul ✅

### Test 2: Pesan Keluar (Outgoing) dari Dashboard
1. Buka `/dashboard/chats`
2. Pilih kontak atau buat chat baru
3. Ketik pesan dan kirim
4. Pesan akan tersimpan dan terkirim ke WhatsApp ✅

### Test 3: Debug Database
1. Buka `/dashboard/debug-chats`
2. Lihat semua data di tabel `whatsapp_chats` dan `whatsapp_messages`
3. Cek apakah nomor telepon yang Anda test ada di sana
4. Halaman ini auto-refresh setiap 5 detik

## Solusi

### Jika Chat dari Nomor Pribadi Tidak Muncul:

1. **Cek Webhook Logs**
   - Lihat terminal/console saat mengirim pesan
   - Seharusnya ada log: `Webhook received:` dan `Received message from...`
   - Jika tidak ada log, webhook tidak menerima data

2. **Cek Webhook Configuration**
   - Buka Meta Developer Console
   - Pastikan webhook URL benar
   - Pastikan verify token match
   - Pastikan webhook sudah "subscribed" ke event `messages`

3. **Cek Format Nomor**
   - Buka `/dashboard/debug-chats`
   - Lihat format nomor yang tersimpan
   - Pastikan konsisten (contoh: `62812XXXXXXXX`)

4. **Cek Database Permissions**
   - Pastikan RLS (Row Level Security) tidak memblokir insert
   - Cek di Supabase Dashboard → Table Editor

### Jika Chat dari Dashboard Tidak Muncul:

1. **Cek Browser Console**
   - Buka Developer Tools (F12)
   - Lihat apakah ada error saat kirim pesan
   - Cek network tab untuk response dari `/api/chat/send`

2. **Cek Authentication**
   - Pastikan Anda sudah login
   - Cek apakah session masih valid

3. **Cek WhatsApp Settings**
   - Buka `/dashboard/settings`
   - Pastikan Access Token dan Phone Number ID sudah diisi

## Debugging Steps

1. **Enable Enhanced Logging** ✅ (sudah diimplementasi)
   - Webhook sekarang log semua data yang diterima
   - Lihat terminal untuk detail lengkap

2. **Gunakan Debug Page** ✅ (baru dibuat)
   - Buka `/dashboard/debug-chats`
   - Monitor real-time data di database

3. **Test Webhook Manually**
   ```bash
   # Test webhook verification
   curl "https://your-domain.com/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test123"
   
   # Should return: test123
   ```

4. **Check Supabase Logs**
   - Buka Supabase Dashboard
   - Logs → Database Logs
   - Lihat apakah ada error saat insert data

## Catatan Penting

⚠️ **WhatsApp Business API Limitation**:
- Webhook hanya menerima pesan MASUK (dari customer ke bisnis)
- Pesan KELUAR (dari bisnis ke customer) TIDAK memicu webhook
- Untuk pesan keluar, harus disimpan manual via API `/api/chat/send`

✅ **Implementasi Saat Ini**:
- Pesan masuk: Otomatis tersimpan via webhook ✅
- Pesan keluar dari dashboard: Tersimpan via `/api/chat/send` ✅
- Pesan keluar dari AI: Tersimpan via queue processor ✅

## Next Steps

1. Buka `/dashboard/debug-chats` untuk melihat data real-time
2. Test kirim pesan dari nomor pribadi ke nomor bisnis
3. Lihat apakah data muncul di debug page
4. Jika muncul di debug tapi tidak di `/dashboard/chats`, ada masalah di UI
5. Jika tidak muncul di debug, ada masalah di webhook/database
