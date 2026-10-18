# 🐛 Debugging Tools untuk WhatsApp Chat

## Tools yang Tersedia

### 1. 📊 Debug Dashboard (`/dashboard/debug-chats`)

**Fungsi**: Monitor real-time semua data di database

**Cara Akses**:
- Buka browser: `http://localhost:3000/dashboard/debug-chats`
- Atau klik menu "Debug Chats" di sidebar (hanya muncul di development)

**Fitur**:
- ✅ Tampilkan semua chat di tabel `whatsapp_chats`
- ✅ Tampilkan 50 pesan terakhir di tabel `whatsapp_messages`
- ✅ Auto-refresh setiap 5 detik
- ✅ Lihat format nomor telepon yang tersimpan
- ✅ Lihat role pesan (user/assistant/system)
- ✅ Lihat timestamp lengkap

**Kapan Digunakan**:
- Cek apakah data benar-benar tersimpan di database
- Verifikasi format nomor telepon
- Monitor pesan real-time saat testing
- Debug masalah UI vs database

---

### 2. 📝 Enhanced Webhook Logging

**Fungsi**: Log ringkas setiap data yang diterima webhook (tanpa isi pesan, payload, atau nomor utuh; audit KEA-21)

**Cara Akses**:
- Lihat terminal tempat `npm run dev` berjalan
- Log akan muncul otomatis saat webhook menerima data

**Output Log**:
```
[WhatsApp] Webhook received: object=whatsapp_business_account entries=1 changes=1 fields=messages messages=1 statuses=0
[WhatsApp] Message details - From: 6281*****789, Type: text
[WhatsApp] Received text message from 6281*****789 (4 chars)
[WhatsApp] Message from 6281*****789 added to queue
```

Nomor pelanggan selalu disamarkan (4 digit awal + 3 digit akhir) dan wamid tampil sebagai `wamid#h<hash>`; label yang sama berarti nomor atau pesan yang sama. Isi pesan dan payload tidak pernah dicetak.

**Kapan Digunakan**:
- Cek apakah webhook benar-benar menerima data dari WhatsApp
- Debug alur pesan (jumlah pesan/status per webhook)
- Mencocokkan nomor pengirim lewat 4 digit awal + 3 digit akhir
- Troubleshoot masalah webhook

---

### 3. 🧪 Test Webhook Script (`scripts/test-webhook.js`)

**Fungsi**: Simulasi pesan WhatsApp ke webhook lokal. Webhook hanya menerima
kiriman bertanda tangan untuk nomor aplikasi, jadi skrip menandatangani payload
dengan `WHATSAPP_APP_SECRET` dan memakai `WHATSAPP_PHONE_NUMBER_ID`: jalankan
dengan `--env-file=.env.local`. Skrip hanya mengirim ke mesin ini kecuali diberi
`--allow-remote`.

**Penting**: server yang dituju memakai kredensialnya sendiri (`.env.local`
server itu). Pesan uji tersimpan di database yang dipakai server itu, dan AI-nya
benar-benar mencoba membalas `TEST_PHONE` dari nomor WhatsApp di kredensial itu.
Karena itu `TEST_PHONE` wajib diisi dengan nomor milik Anda, dan sebaiknya server
lokal memakai database lokal, bukan produksi.

**Cara Menggunakan**:
```bash
# Basic test (TEST_PHONE wajib: nomor milik Anda)
TEST_PHONE=<nomor-anda> node --env-file=.env.local scripts/test-webhook.js

# Custom webhook URL (tetap mesin ini)
WEBHOOK_URL=http://localhost:3000/api/webhook/whatsapp TEST_PHONE=<nomor-anda> node --env-file=.env.local scripts/test-webhook.js
```
Skrip keluar dengan kode 1 bila ditolak (bukan mesin ini, env kurang, `TEST_PHONE`
kosong) atau bila webhook tidak menjawab 2xx.

**Output**:
```
🧪 Testing WhatsApp Webhook...

📍 Webhook URL: http://localhost:3000/api/webhook/whatsapp
📱 Test Phone: 6281234567890

✅ Response Status: 200 OK
📄 Response Body: EVENT_RECEIVED

✅ Webhook test SUCCESSFUL!

📋 Next Steps:
1. Check terminal logs for webhook processing
2. Open http://localhost:3000/dashboard/debug-chats
3. Look for phone number: 6281234567890
4. Verify message: "Test message from script"
```

**Kapan Digunakan**:
- Test webhook tanpa perlu kirim pesan WhatsApp asli
- Verifikasi webhook berfungsi lokal
- Debug tanpa perlu ngrok
- Test dengan nomor telepon berbeda

---

### 4. 📚 Dokumentasi Troubleshooting

#### `docs/TROUBLESHOOTING_CHAT.md`
- Penjelasan masalah umum
- Perbedaan pesan masuk vs keluar
- Cara test yang benar
- Solusi step-by-step

#### `docs/CHAT_DEBUG_ANALYSIS.md`
- Analisis root cause
- Checklist lengkap
- Panduan debugging detail
- Tips dan best practices

---

## 🚀 Workflow Debugging

### Scenario 1: Chat Tidak Muncul di Dashboard

**Step 1: Cek Webhook Logs**
```bash
# Kirim pesan dari WhatsApp
# Lihat terminal, harusnya ada log:
[WhatsApp] Webhook received: object=whatsapp_business_account ... messages=1
[WhatsApp] Received text message from 6281*****789 (N chars)
```

**Hasil**:
- ✅ Ada log → Lanjut Step 2
- ❌ Tidak ada log → Webhook tidak menerima data, cek konfigurasi Meta

**Step 2: Cek Database**
```bash
# Buka browser
http://localhost:3000/dashboard/debug-chats

# Tunggu 5 detik (auto-refresh)
# Cek apakah nomor muncul di tabel
```

**Hasil**:
- ✅ Data muncul → Database OK, masalah di UI
- ❌ Data tidak muncul → Masalah di webhook/database

**Step 3: Test dengan Script**
```bash
# Test webhook lokal
TEST_PHONE=<nomor-anda> node --env-file=.env.local scripts/test-webhook.js

# Cek debug dashboard
http://localhost:3000/dashboard/debug-chats
```

**Hasil**:
- ✅ Test berhasil → Webhook OK, masalah di WhatsApp config
- ❌ Test gagal → Webhook error, cek code

---

### Scenario 2: Format Nomor Berbeda

**Problem**: Chat tersimpan tapi tidak match

**Debug**:
1. Buka `/dashboard/debug-chats`
2. Lihat kolom "Phone Number" di tabel chats
3. Bandingkan format:
   - WhatsApp: `62812XXXXXXXX`
   - Database: `+62812XXXXXXXX` atau `0812XXXXXXXX`
4. Jika berbeda, perlu normalisasi

**Solution**: Tambahkan fungsi normalisasi nomor di webhook

---

### Scenario 3: Webhook Tidak Accessible

**Problem**: Meta tidak bisa kirim data ke webhook

**Debug**:
```bash
# Development: Gunakan ngrok
ngrok http 3000

# Copy URL: https://xxxx.ngrok.io
# Update di Meta: https://xxxx.ngrok.io/api/webhook/whatsapp

# Test dari luar
curl https://xxxx.ngrok.io/api/webhook/whatsapp
```

**Solution**: 
- Development: Gunakan ngrok
- Production: Pastikan domain + SSL aktif

---

## 📋 Checklist Debugging

Sebelum mulai debug, pastikan:

- [ ] App running (`npm run dev`)
- [ ] Terminal terbuka (untuk lihat logs)
- [ ] Browser DevTools terbuka (F12)
- [ ] `/dashboard/debug-chats` terbuka di tab lain
- [ ] WhatsApp settings sudah dikonfigurasi
- [ ] Webhook URL sudah terdaftar di Meta

---

## 🎯 Quick Commands

```bash
# Run app
npm run dev

# Test webhook lokal (TEST_PHONE wajib: nomor milik Anda)
TEST_PHONE=<nomor-anda> node --env-file=.env.local scripts/test-webhook.js

# Expose lokal ke internet (development)
ngrok http 3000

# Check database (via Supabase CLI)
supabase db pull

# View logs
# (Lihat terminal npm run dev)
```

---

## 💡 Tips

1. **Selalu cek terminal logs** saat testing
2. **Gunakan `/dashboard/debug-chats`** untuk verifikasi database
3. **Test dengan script** sebelum test dengan WhatsApp asli
4. **Format nomor harus konsisten** (62XXXXXXXXXX tanpa +)
5. **Webhook hanya untuk pesan MASUK**, bukan pesan KELUAR
6. **Gunakan ngrok** untuk development agar Meta bisa akses webhook
7. **Cek browser console** untuk error frontend
8. **Hard refresh** (Ctrl+Shift+R) jika UI tidak update

---

## 🆘 Troubleshooting Common Issues

### Issue: "Webhook tidak menerima data"
**Solution**: 
- Cek Meta Developer Console → Webhook configuration
- Pastikan URL benar dan accessible
- Pastikan subscribe ke event `messages`
- Test dengan `curl` atau Postman

### Issue: "Data tidak tersimpan di database"
**Solution**:
- Cek Supabase logs
- Cek RLS policies
- Cek foreign key constraints
- Test dengan script lokal

### Issue: "Chat muncul di debug tapi tidak di /dashboard/chats"
**Solution**:
- Hard refresh browser
- Clear cache
- Cek browser console untuk error
- Cek Supabase Realtime status

### Issue: "Format nomor berbeda"
**Solution**:
- Lihat format di `/dashboard/debug-chats`
- Tambahkan normalisasi di webhook
- Update semua nomor ke format yang sama

---

## 📞 Support

Jika masih ada masalah setelah menggunakan semua tools ini:

1. Screenshot terminal logs
2. Screenshot `/dashboard/debug-chats`
3. Screenshot browser console (F12)
4. Screenshot Meta webhook config
5. Kirim semua ke developer

---

**Last Updated**: 2025-11-29
