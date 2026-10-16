# Runbook — memindahkan objek legacy bucket `documents` (migrasi 0066)

Tracker **1.12** (audit KEA-4). Keputusan pemilik:

- **D16**: ke-15 objek legacy di root bucket `documents` dipindah **semua** ke
  folder org seed (`5a11e024-0001-4000-8000-000000000001/<nama yang sama>`).
  Nasib 13 duplikat yang tidak dipakai diputuskan setelah masa tunggu 72 jam.
- **D17**: skrip dijalankan Claude di mesin pemilik memakai `.env.local`.
  Hasil *dry-run* dan verifikasi ditinjau dulu, dan **setiap langkah yang
  mengubah data disetujui pemilik**.

Alat: `scripts/migrate-legacy-kb-objects.mjs` (Storage API dengan
service-role key) dan `supabase/migrations/0066_documents_storage_org_prefix_only.sql`.
Objek storage **tidak pernah** dipindah atau diganti nama lewat SQL.

## Prasyarat

- PR 0066 sudah di-review dan disetujui.
- `.env.local` di checkout utama berisi `NEXT_PUBLIC_SUPABASE_URL` produksi dan
  `SUPABASE_SERVICE_ROLE_KEY`. Isinya tidak pernah dicetak.
- Direktori `--out` **di luar semua repo**, misalnya
  `%USERPROFILE%\sarathi-kb-legacy-2026-10`. Direktori ini menampung
  `manifest.json` (nama objek, id baris, sha256) dan `backup/` (byte file).
  Isinya dokumen bisnis (UU PDP): jangan dibagikan, dan hapus setelah masa
  simpan yang disepakati (langkah 9).
- `--expect-ref` = ref proyek produksi (bagian subdomain dari
  `NEXT_PUBLIC_SUPABASE_URL`). Skrip menolak kalau ref di env berbeda.

Perintah dasar (dari checkout branch PR, `<out>` dan `<ref>` diisi):

```bash
node --env-file=D:/bedul/apk/AI/sarathi/.env.local scripts/migrate-legacy-kb-objects.mjs \
    --phase=<plan|copy|verify|delete-originals|restore> --expect-ref=<ref> --out=<out> [--confirm]
```

Tanpa `--confirm`, fase yang menulis hanya *dry-run*. Log hanya memuat nomor
urut, id objek, ukuran, dan awalan sha256, **tanpa nama file**.

## Langkah

| # | Langkah | Mengubah data? | Persetujuan pemilik |
|---|---|---|---|
| 0 | Umumkan **jeda KB** ke anggota org seed: tidak ada unggah atau hapus dokumen KB sampai langkah 5 selesai. | — | — |
| 1 | `--phase=plan` | Tidak (menulis `--out` saja) | Tinjau angka |
| 2 | `--phase=copy` (*dry-run*), lalu `--phase=copy --confirm` | Ya (Storage: 15 salinan) | **Ya, sebelum `--confirm`** |
| 3 | `--phase=verify` + kueri agregat di bawah | Tidak | — |
| 4 | Terapkan 0066 lewat Supabase MCP (`apply_migration`, blob LF). Guard-nya menolak kalau ada salinan yang belum ada. | Ya (relink 8 baris + policy) | **Ya (D1)** |
| 5 | Cek pasca-0066 + uji asap, lalu akhiri jeda KB. | Tidak / uji kecil | — |
| 6 | Masa tunggu **72 jam**. Objek asli tetap ada, tetapi tidak terjangkau user. | — | — |
| 7 | `--phase=delete-originals` (*dry-run*), lalu `--confirm` | Ya (Storage: hapus objek asli) | **Ya, sebelum `--confirm`** |
| 8 | Cek akhir | Tidak | — |
| 9 | Hapus `--out` setelah masa simpan yang disepakati | Ya (lokal) | **Ya** |

### 1. Plan — angka yang diharapkan (hitungan read-only produksi, 2026-10-16)

- `root-level objects : 15`; `root-level folders : 0`
- `destinations : 15 absent, 0 identical, 0 different`
- `documents rows`: file-backed **8** (root source 8 → **2** objek, blocking **0**), editor **7**
- `objects with rows : 2 (rows 8), without rows 13`

Kalau angkanya berbeda (ada objek atau baris baru, atau `blocking > 0`):
**berhenti dan diskusikan**. Plan menolak dan tidak menulis apa pun kalau ada
masalah. Plan kedua harus memakai `--out` baru.

### 2. Copy

*Dry-run* harus menunjukkan `to copy 15, ... need a human 0`. Setelah pemilik
setuju, jalankan dengan `--confirm`. Setiap salinan langsung diverifikasi
(ukuran, tipe konten, sha256 dari hasil unduhan). Kalau ada yang tidak cocok,
salinan itu dihapus lagi dan proses berhenti. Proses aman diulang karena
salinan yang identik dilewati.

### 3. Verify

`verify ok`, dengan `copies ok 15 ... originals still present 15`. Kueri
agregat lewat MCP `execute_sql` (read-only, tanpa nama):

```sql
select count(*) as root_objects, count(c.id) as copies,
       count(*) filter (where c.metadata->>'size' = o.metadata->>'size') as same_size,
       count(*) filter (where c.metadata->>'mimetype' = o.metadata->>'mimetype') as same_mime
from storage.objects o
left join storage.objects c
  on c.bucket_id = 'documents' and c.name = '5a11e024-0001-4000-8000-000000000001/' || o.name
where o.bucket_id = 'documents' and (storage.foldername(o.name))[1] is null;
```

Harus 15 di keempat kolom.

### 4. Migrasi 0066

Terapkan dengan `apply_migration` (nama `0066_documents_storage_org_prefix_only`,
isi blob LF dari branch PR). Guard di dalamnya menolak, dan seluruh migrasi
di-*rollback*, kalau ada baris yang belum ber-prefix org, objek root tanpa
salinan berukuran sama, atau objek di folder bukan-uuid.

### 5. Pasca-0066

```sql
select count(*) filter (where left(metadata->>'source', 37) = org_id::text || '/') as prefixed,
       count(*) filter (where strpos(metadata->>'source', '/') = 0) as still_root
from public.documents
where coalesce(metadata->>'origin', '') <> 'editor' and metadata ? 'source';
```

Harus `8 | 0`. Cek juga:

- policy `documents bucket org members` tidak lagi memuat `COALESCE`;
- daftar KB di dashboard menampilkan entri yang sama;
- uji asap: sebagai user seed, unggah file `.txt` kecil, tunggu sampai ter-*ingest*, lalu hapus.

Setelah semua lulus, akhiri jeda KB. Lalu, di PR: refresh `production.txt`,
hapus blok *pending* 0066, dan merge.

### 6–7. Masa tunggu, lalu hapus objek asli

`delete-originals` menolak sebelum 72 jam lewat (`--soak-hours`, default 72),
selama `verify` belum bersih, atau kalau objek root di nama yang sama bukan
objek di manifest.

Entri KB yang dihapus user selama masa tunggu (semua barisnya hilang) dianggap
**dihapus oleh user**: objek aslinya ikut dihapus, dan isinya **tidak pernah**
disalin atau dipulihkan lagi. Tepat sebelum objek asli dihapus, salinannya
diverifikasi ulang.

### 8. Cek akhir

```sql
select count(*) filter (where (storage.foldername(name))[1] is null) as root_level,
       count(*) filter (where (storage.foldername(name))[1] = '5a11e024-0001-4000-8000-000000000001') as seed_prefixed
from storage.objects where bucket_id = 'documents';
```

Harus `root_level = 0`, dan `seed_prefixed` minimal 15 dikurangi entri yang
dihapus user. Setelah itu tracker 1.12 → ✅.

## Rollback per tahap

- **Setelah langkah 2–3:** hapus salinan lewat Storage API; tidak ada hal lain yang berubah.
- **Setelah langkah 4–6:** migrasi lanjutan yang mengembalikan teks policy 0038 dan me-relink balik **hanya** id baris di manifest (SQL lengkap ada di header 0066), lalu hapus salinan.
- **Setelah langkah 7:** `--phase=restore --confirm` (objek asli dikembalikan dari salinan, atau dari `backup/` kalau salinannya juga hilang; entri yang dihapus user tidak dipulihkan), lalu lanjutkan seperti tahap sebelumnya.

## Latihan (2026-10-16, stack lokal terpisah `sarathi-docs`, port 588xx)

Data latihan dibuat menyerupai produksi: 15 objek root (2 dipakai, 11 PDF
identik, 2 TXT identik; nama memuat spasi, koma, dan kurung), 8 baris unggahan,
7 baris editor, dan 1 anggota org seed. Hasilnya:

1. Sebelum 0066, anggota bisa membaca dan me-list ke-15 objek root (fallback COALESCE).
2. `plan`: angka sesuai, 0 penghalang, log tanpa nama file. `--expect-ref` yang salah ditolak, `--out` di dalam repo ditolak, dan tidak ada yang ditulis.
3. `copy`: *dry-run* 15, `--confirm` 15 (terverifikasi), dijalankan ulang tetap idempoten. `verify`: 15 ok.
4. 0066 dengan satu objek root tanpa salinan: **ditolak dan di-rollback** (relink tidak terjadi). Tanpa objek itu: berhasil, 8 baris ber-prefix, 7 baris editor utuh, policy tanpa COALESCE. Anggota tidak bisa lagi membaca atau me-list root, tetapi melihat 15 file di folder org.
5. User menghapus satu entri KB selama masa tunggu: `verify` menandainya sebagai *deleted by the user*; `copy` ulang tidak menghidupkannya; `delete-originals` ditolak sebelum masa tunggu habis.
6. `delete-originals --confirm` (masa tunggu 0 untuk latihan): root 0, folder seed 14.
7. Bencana (salinan satu objek juga hilang): `restore` mengembalikan 13 objek dari salinan dan 1 dari backup, entri yang dihapus user tidak dipulihkan. Lalu `copy`, `verify`, dan `delete-originals` lagi. Kondisi akhir: root 0, folder seed 14, 5 baris ber-prefix, 7 baris editor.
