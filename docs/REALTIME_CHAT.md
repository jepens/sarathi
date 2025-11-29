# Mengaktifkan Real-time Chat

## Masalah
Chat di `/dashboard/chats` memerlukan refresh halaman untuk melihat pesan baru.

## Solusi yang Diimplementasikan

### 1. Polling Fallback (Sudah Aktif)
Aplikasi sekarang menggunakan **polling otomatis** sebagai fallback:
- **Chat List**: Refresh setiap 30 detik
- **Chat Messages**: Refresh setiap 10 detik

Ini akan bekerja **tanpa konfigurasi tambahan** dan memberikan pengalaman yang cukup real-time.

### 2. Supabase Realtime (Opsional - Lebih Optimal)
Untuk pengalaman yang lebih real-time (instant updates), aktifkan Supabase Realtime:

#### Langkah-langkah:
1. Buka **Supabase Dashboard** → Project Anda
2. Pergi ke **Database** → **Replication**
3. Aktifkan replication untuk tabel berikut:
   - `whatsapp_chats`
   - `whatsapp_messages`
4. Klik toggle untuk mengaktifkan **Realtime**

#### Atau via SQL:
```sql
-- Aktifkan realtime untuk tabel whatsapp_chats
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_chats;

-- Aktifkan realtime untuk tabel whatsapp_messages
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_messages;
```

## Cara Kerja
- **Jika Realtime aktif**: Chat akan update secara instant saat ada pesan baru
- **Jika Realtime tidak aktif**: Polling akan mengambil alih dan refresh otomatis setiap 10-30 detik
- **Tidak perlu refresh manual** dalam kedua kasus

## Testing
1. Buka `/dashboard/chats` di dua browser/tab berbeda
2. Kirim pesan dari satu tab
3. Pesan akan muncul di tab lain:
   - **Instant** jika Realtime aktif
   - **Dalam 10-30 detik** jika hanya polling

## Catatan
- Polling sudah cukup untuk kebanyakan use case
- Realtime lebih baik untuk volume chat yang tinggi
- Implementasi ini menghindari kompleksitas WebSocket manual
