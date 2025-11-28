# System Message Configuration - Quick Setup Guide

## 🚀 Setup Steps

### 1. Run Database Migration

Buka **Supabase SQL Editor** dan jalankan script berikut:

```sql
-- File: database/system_message_schema.sql
-- Copy dan paste seluruh isi file ke SQL Editor
```

**Script ini akan:**
- ✅ Membuat tabel `system_message`
- ✅ Membuat trigger untuk memastikan hanya 1 system message aktif
- ✅ Insert default system message untuk Sahabat UMKM
- ✅ Setup auto-update timestamp

### 2. Verifikasi Instalasi

Cek di Supabase Table Editor apakah tabel `system_message` sudah ada dengan 1 row bernama 'default' dan `is_active = true`.

### 3. Akses Admin Dashboard

1. Buka aplikasi di browser: `http://localhost:3000`
2. Navigate ke **Dashboard → Settings**
3. Scroll ke bawah hingga menemukan section **AI System Message**
4. Anda akan melihat textarea besar dengan system message default

### 4. Edit System Message (Opsional)

1. Edit content system message sesuai kebutuhan
2. Klik **Save Changes**
3. Test perubahan di Chat Interface atau WhatsApp

## 📝 Contoh Penggunaan

### Membuat System Message Baru via API

```bash
curl -X POST http://localhost:3000/api/system-message \
  -H "Content-Type: application/json" \
  -d '{
    "name": "aggressive_sales",
    "content": "Anda adalah sales agresif yang fokus closing deal...",
    "description": "Aggressive sales persona",
    "is_active": false
  }'
```

### Mengaktifkan System Message Lain

```bash
curl -X PUT http://localhost:3000/api/system-message \
  -H "Content-Type: application/json" \
  -d '{
    "id": "uuid-dari-system-message",
    "is_active": true
  }'
```

## ✅ Verifikasi

Test sistem dengan:

1. **Web Chat**: Buka `/dashboard/chat` dan coba tanya produk
2. **WhatsApp**: Kirim pesan ke WhatsApp number yang terhubung

AI seharusnya merespon sesuai dengan karakter yang didefinisikan di system message.

## 🔍 Troubleshooting

### System Message tidak muncul di Settings

**Solusi:**
1. Pastikan migration sudah dijalankan
2. Check browser console untuk errors
3. Verify API endpoint accessible: `curl http://localhost:3000/api/system-message`

### Perubahan tidak apply

**Solusi:**
1. System message di-fetch per request, tidak di-cache
2. Refresh halaman chat
3. Untuk WhatsApp, kirim pesan baru (bukan reply)

### Error "No system message found"

**Solusi:**
1. Pastikan ada minimal 1 system message dengan `is_active = true`
2. Jika tidak ada, RAG akan menggunakan fallback hardcoded message
3. Insert default message manually via Supabase Table Editor

## 📚 Dokumentasi Lengkap

Lihat: [`docs/SYSTEM_MESSAGE.md`](../docs/SYSTEM_MESSAGE.md)

## 🎯 Best Practices

1. **Backup Before Edit**: Salin content lama sebelum edit besar
2. **Test Locally First**: Test di web chat sebelum production
3. **Clear Instructions**: System message harus jelas dan spesifik
4. **Use Structure**: Gunakan markdown headers untuk organisasi
5. **Keep It Focused**: Jangan terlalu panjang, fokus pada essentials

---

**Need Help?** Check documentation or raise an issue di repository.
