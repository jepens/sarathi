# Settings Migration Guide

## Overview
Aplikasi sekarang mendukung konfigurasi melalui dashboard `/dashboard/settings` untuk memudahkan pengelolaan kredensial tanpa perlu redeploy.

## 🎯 Settings yang Dapat Dikonfigurasi

### 1. WhatsApp Integration
- **Webhook URL** - Auto-generated dari domain aplikasi
- **Verify Token** - Token untuk verifikasi webhook
- **Access Token** 🔐 - WhatsApp Business API Access Token
- **Phone Number ID** - ID nomor WhatsApp Business
- **App Secret** 🔐 - Secret untuk validasi signature webhook (opsional)

### 2. AI Configuration
- **OpenAI API Key** 🔐 - API key untuk fitur AI Chat dan RAG

### 3. Shipping Integration (Opsional)
- **Komerce API Key** 🔐 - API key untuk kalkulasi ongkir

### 4. System Message
- **AI System Message** - Prompt sistem untuk AI assistant

## 📝 Langkah Migration

### Step 1: Jalankan Database Migration

1. Buka Supabase SQL Editor
2. Jalankan file `database/add_app_settings.sql`:
   ```sql
   -- File ini akan menambahkan kolom settings baru
   ```

### Step 2: Migrate Environment Variables ke Database

1. Buka file `database/migrate_env_to_settings.sql`
2. **Replace placeholder values** dengan nilai dari `.env.local` Anda:
   ```sql
   UPDATE app_settings 
   SET value = 'YOUR_ACTUAL_WHATSAPP_ACCESS_TOKEN' 
   WHERE key = 'whatsapp_access_token' AND value = '';
   ```
3. Jalankan script di Supabase SQL Editor
4. Verifikasi dengan query di bagian bawah script

### Step 3: Verifikasi di Dashboard

1. Buka `/dashboard/settings`
2. Cek semua tabs (WhatsApp, AI, Shipping, System)
3. Pastikan semua nilai sudah terisi dengan benar
4. Status badge harus menunjukkan "Active" (hijau)

### Step 4: Update .env.local (Opsional)

Setelah migration berhasil, Anda bisa:
- **Hapus** environment variables yang sudah di-manage via dashboard
- **Atau tetap simpan** sebagai backup (aplikasi akan prioritas database)

Environment variables yang **TIDAK PERLU** dihapus:
```env
# Tetap di .env.local (hardcoded saat deployment)
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

Environment variables yang **BISA DIHAPUS** (sudah di database):
```env
# Bisa dihapus karena sudah di /dashboard/settings
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_APP_SECRET=...
OPENAI_API_KEY=...
SHIPPING_COST_KOMERCE_API_KEY=...
```

## 🔒 Keamanan

1. **Sensitive fields** ditampilkan sebagai password (masked)
2. **Show/Hide toggle** dengan icon mata untuk melihat nilai
3. **Edit mode** - Harus klik "Edit Configuration" sebelum bisa ubah
4. **Database storage** - Semua settings disimpan di table `app_settings`

## 🎨 Fitur UI

- **Tabs Navigation** - Organized by category
- **Status Badges** - Active/Inactive indicator
- **Copy Button** - Quick copy untuk Webhook URL dan Verify Token
- **Generate Token** - Random token generator untuk Verify Token
- **Secure Input** - Password-style input dengan show/hide toggle

## 🔄 Fallback Behavior

Aplikasi menggunakan **database-first approach**:
1. Cek database (`app_settings` table)
2. Jika kosong, throw error dengan pesan "Please configure in /dashboard/settings"
3. **Tidak ada fallback ke .env** (wajib diisi via dashboard)

## 📊 Monitoring

Cek status konfigurasi:
```sql
SELECT 
    key, 
    CASE 
        WHEN value = '' THEN '❌ Empty'
        ELSE '✅ Configured'
    END as status,
    description
FROM app_settings
WHERE key IN (
    'whatsapp_access_token',
    'whatsapp_phone_number_id',
    'whatsapp_app_secret',
    'whatsapp_verify_token',
    'openai_api_key',
    'shipping_api_key'
)
ORDER BY key;
```

## 🐛 Troubleshooting

### Error: "WhatsApp Access Token not configured"
**Solusi**: Buka `/dashboard/settings` → Tab WhatsApp → Edit → Isi Access Token

### Error: "OpenAI API Key not configured"
**Solusi**: Buka `/dashboard/settings` → Tab AI → Edit → Isi OpenAI API Key

### Settings tidak tersimpan
**Solusi**: 
1. Cek RLS policies di table `app_settings`
2. Pastikan user authenticated
3. Cek browser console untuk error

### Badge masih "Inactive" padahal sudah diisi
**Solusi**:
1. Refresh halaman
2. Cek database apakah value benar-benar tersimpan
3. Pastikan tidak ada spasi di awal/akhir value

## 📚 File yang Diubah

- `lib/settings/app-settings.ts` - Helper functions
- `app/dashboard/settings/page.tsx` - Main settings page
- `app/dashboard/settings/actions.ts` - Server actions
- `app/dashboard/settings/components/WebhookSettings.tsx` - WhatsApp settings
- `app/dashboard/settings/components/AISettings.tsx` - AI settings (NEW)
- `app/dashboard/settings/components/ShippingSettings.tsx` - Shipping settings (NEW)
- `app/dashboard/settings/components/SettingsTabs.tsx` - Tabs component (NEW)
- `app/dashboard/settings/components/SecureInput.tsx` - Secure input component (NEW)
- `components/ui/tabs.tsx` - Radix UI tabs (NEW)
- `database/add_app_settings.sql` - Database migration (NEW)
- `database/migrate_env_to_settings.sql` - Migration script (NEW)

## ✅ Checklist Post-Migration

- [ ] Database migration berhasil
- [ ] Environment variables di-migrate ke database
- [ ] Semua tabs di `/dashboard/settings` bisa dibuka
- [ ] Status badge menunjukkan "Active" untuk WhatsApp dan AI
- [ ] Bisa edit dan save settings
- [ ] WhatsApp webhook masih berfungsi
- [ ] AI Chat masih berfungsi
- [ ] Tidak ada error di console/logs
