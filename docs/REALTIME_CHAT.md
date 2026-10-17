# Real-time Chat (bus Realtime per org)

## Cara Kerja
Dashboard memakai **satu channel Realtime privat per tab** dengan topik
`org:<uuid org>` (`components/realtime/org-realtime-provider.tsx`, tracker 1.9).
Trigger database (migrasi 0064) mengirim sinyal kecil `{v, table, op, n, ids}`
per statement untuk `whatsapp_chats`, `whatsapp_messages`, `labels`,
`chat_labels` dan `orders` — tanpa nomor telepon dan tanpa isi pesan. Tampilan
lalu mengambil ulang datanya lewat PostgREST, di bawah RLS per org. Hanya
anggota org yang bisa join topik org tersebut.

Polling tetap aktif sebagai cadangan:
- **Chat List**: refresh setiap 30 detik
- **Chat Messages**: refresh setiap 10 detik

Setelah channel tersambung (juga setelah tersambung ulang), saat tab kembali
terlihat dan saat perangkat kembali online, semua tampilan mengambil ulang
datanya (RESYNC), jadi perubahan yang terlewat tetap muncul.

## JANGAN aktifkan Replication / `supabase_realtime` untuk tabel
Migrasi 0068 mengosongkan publikasi `supabase_realtime`, dan publikasi itu harus
tetap kosong: Postgres Changes mengirim kolom kunci setiap DELETE (termasuk
nomor telepon pelanggan) ke semua pelanggan dari org mana pun (audit KEA-15).

- Jangan menjalankan `ALTER PUBLICATION supabase_realtime ADD TABLE ...`.
- Jangan menyalakan toggle Realtime per tabel di Dashboard → Database →
  Replication.
- Guard 10 di `supabase/tests/database/070_catalog_guards.test.sql` gagal bila
  ada tabel di publikasi itu.

Tabel baru yang perlu live: tambahkan tiga trigger `trg_org_broadcast_*` (lihat
`supabase/README.md`, bagian "Realtime org bus"), lalu dengarkan tabel itu di
komponen dengan `useOrgRealtime` / `useOrgRefetch`.

## Testing
1. Buka `/dashboard/chats` di dua tab berbeda.
2. Kirim pesan dari satu tab, atau terima pesan WhatsApp.
3. Tab lain berubah dalam ±1 detik. Di console browser terlihat
   `[realtime] org:<uuid> live (SUBSCRIBED)`.
4. Bila channel terputus, statusnya `paused`, lalu kembali `live` sendiri tanpa
   reload (polling tetap berjalan selama itu).
