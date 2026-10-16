# Runbook — memindahkan objek legacy bucket `documents` (migrasi 0066)

Tracker **1.12** (audit KEA-4). Keputusan pemilik:

- **D16**: ke-15 objek legacy di root bucket `documents` dipindah **semua** ke
  folder org seed (`5a11e024-0001-4000-8000-000000000001/<nama yang sama>`).
  Nasib 13 duplikat yang tidak dipakai diputuskan setelah masa tunggu (langkah 8b).
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
  `manifest.json` (nama objek, id baris, sha256, awal masa tunggu) dan
  `backup/` (byte file). Isinya dokumen bisnis (UU PDP): jangan dibagikan.
- **Simpan salinan kedua `manifest.json` saja** (tanpa `backup/`) di lokasi
  privat lain sejak langkah 2 sampai langkah 8, dan **perbarui** salinan itu
  setiap kali sebuah fase menulis manifest (`copy`, `verify` yang mencatat
  awal masa tunggu, `delete-originals`, `restore`, `remove-copies`). Manifest
  adalah satu-satunya catatan baris mana milik objek mana (deteksi "dihapus
  user") dan id baris untuk SQL rollback.
- **Jangan pernah `plan` ulang** setelah langkah 2: skrip menolak bucket yang
  sudah disalin. Kalau manifest hilang, pulihkan dari salinan kedua.
  `--allow-replan` hanya dipakai atas keputusan manusia; dalam mode itu,
  objek tanpa salinan setelah 0066 dicatat sebagai "dihapus user" dan tidak
  pernah disalin lagi.
- **Jangan pernah memberi `--soak-hours` di produksi.** Skrip menolak nilai di
  bawah 72 untuk proyek non-lokal kecuali dengan `--allow-short-soak`, yang
  hanya untuk latihan.
- `--expect-ref` = ref proyek produksi (bagian subdomain dari
  `NEXT_PUBLIC_SUPABASE_URL`). Skrip menolak kalau ref di env berbeda.

Perintah dasar (dari checkout branch PR, `<out>` dan `<ref>` diisi):

```bash
node --env-file=D:/bedul/apk/AI/sarathi/.env.local scripts/migrate-legacy-kb-objects.mjs \
    --phase=<plan|copy|verify|delete-originals|restore|remove-copies> --expect-ref=<ref> --out=<out> [--confirm]
```

Tanpa `--confirm`, fase yang menulis hanya *dry-run*. Log hanya memuat nomor
urut, id objek, ukuran, dan awalan sha256, **tanpa nama file**.

## Langkah

| # | Langkah | Mengubah data? | Persetujuan pemilik |
|---|---|---|---|
| 0 | Sarankan **jeda KB** ke anggota org seed (tidak ada unggah/hapus dokumen KB) dari langkah 1 sampai cek pasca-0066 di langkah 5. | — | — |
| 1 | `--phase=plan` | Tidak (menulis `--out` saja) | Tinjau angka |
| 2 | `--phase=copy` (*dry-run*), lalu `--phase=copy --confirm`; simpan salinan kedua `manifest.json` | Ya (Storage: 15 salinan) | **Ya, sebelum `--confirm`** |
| 3 | `--phase=verify` + kueri agregat di bawah | Tidak | — |
| 4 | Terapkan 0066 lewat Supabase MCP (`apply_migration`, blob LF). Guard-nya menolak kalau ada salinan yang belum ada. | Ya (relink 8 baris + policy) | **Ya (D1)** |
| 5 | `--phase=verify` (mencatat **awal masa tunggu**), cek pasca-0066, uji asap oleh pemilik di dashboard, lalu akhiri jeda KB. Di PR: tutup blok fingerprint dan merge. | Uji asap: ya (unggah + hapus 1 file kecil) | **Ya, untuk uji asap** |
| 6 | Masa tunggu **72 jam sejak awal masa tunggu**. Objek asli tetap ada, tetapi tidak terjangkau user. | — | — |
| 7 | `--phase=delete-originals` (*dry-run*), lalu `--confirm` | Ya (Storage: hapus objek asli) | **Ya, sebelum `--confirm`** |
| 8 | Cek akhir (`verify` + dua kueri) | Tidak | — |
| 8b | Keputusan **D16** untuk 13 salinan duplikat yang tidak dipakai: disimpan, atau dihapus dengan `--phase=remove-copies --unreferenced-only` (*dry-run* dulu, lalu `--confirm`). | Bila dihapus: ya | **Ya** |
| 9 | Hapus `--out` (dan salinan kedua manifest) **30 hari** setelah langkah 8 lulus, kecuali pemilik menetapkan lain (terkait D11). Backup entri yang dihapus user boleh dihapus lebih awal. | Ya (lokal) | **Ya** |

### 1. Plan — angka yang diharapkan (hitungan read-only produksi, 2026-10-16)

- `root-level objects : 15`; `root-level folders : 0`
- `destinations : 15 absent, 0 identical, 0 different`
- `documents rows`: file-backed **8** (root source 8 → **2** objek, blocking **0**), editor **7**
- `objects with rows : 2 (rows 8), without rows 13`

Kalau angkanya berbeda (ada objek atau baris baru, atau `blocking > 0`):
**berhenti dan diskusikan**. Plan menolak dan tidak menulis apa pun kalau ada
masalah. Plan kedua (sebelum langkah 2) harus memakai `--out` baru. Setelah
langkah 2, plan menolak (lihat Prasyarat); dengan `--allow-replan`, ia mencetak
tahap salinan (`copy stage`) dan jumlah baris yang sudah di-relink, dan tetap
mengenali baris itu sebagai milik objeknya.

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

1. `--phase=verify`: harus `relinked 8, still root 0`. Verify pertama yang
   melihat 0066 berlaku **mencatat awal masa tunggu** (`soak_started_at` di
   manifest), dan `delete-originals` menghitung 72 jam dari situ, bukan dari
   waktu `copy`.
2. Kueri:

   ```sql
   select count(*) filter (where left(metadata->>'source', 37) = org_id::text || '/') as prefixed,
          count(*) filter (where strpos(metadata->>'source', '/') = 0) as still_root
   from public.documents
   where coalesce(metadata->>'origin', '') <> 'editor' and metadata ? 'source';
   ```

   Harus `8 | 0`. Policy `documents bucket org members` tidak lagi memuat `COALESCE`.
3. Daftar KB di dashboard menampilkan entri yang sama.
4. **Uji asap (pemilik, di dashboard; persetujuan):** unggah file `.txt` kecil,
   tunggu sampai ter-*ingest*, lalu hapus. Setelah itu jumlah objek di folder
   seed harus kembali ke 15 (`select count(*) from storage.objects where
   bucket_id = 'documents' and (storage.foldername(name))[1] = '<seed>'`),
   karena DELETE /api/documents menelan error storage.
5. Akhiri jeda KB.
6. Di PR: refresh `production.txt`, hapus blok *pending* 0066, perbarui kalimat
   expected-diff (md5) di `supabase/README.md`, tambahkan versi 0066 ke log
   pelacak, lalu merge.

### 6–7. Masa tunggu, lalu hapus objek asli

`delete-originals` mencetak awal masa tunggu, `--soak-hours`, waktu selesai,
dan sisa jamnya. Ia menolak, tanpa menghapus apa pun, kalau:

- awal masa tunggu belum tercatat, atau 72 jam sejak itu belum lewat;
- `verify` belum bersih;
- masih ada baris berbasis file yang menunjuk objek root (0066 belum
  berlaku), atau ada baris manifest yang tidak menunjuk salinannya;
- objek root di nama yang sama bukan objek yang tercatat di manifest.

Entri KB yang dihapus user selama masa tunggu (semua barisnya hilang) dianggap
**dihapus oleh user**: objek aslinya ikut dihapus, dan isinya **tidak pernah**
disalin atau dipulihkan lagi. Tepat sebelum objek asli dihapus, salinannya
diverifikasi ulang.

### 8. Cek akhir

1. `--phase=verify`: harus `copies ok` = 15 dikurangi entri yang dihapus user,
   `failed 0`, `originals still present 0`.
2. Tidak ada sumber yang menggantung (harus 0):

   ```sql
   select count(*) from public.documents d
   where coalesce(d.metadata->>'origin', '') <> 'editor' and d.metadata ? 'source'
     and not exists (select 1 from storage.objects o
                     where o.bucket_id = 'documents' and o.name = d.metadata->>'source');
   ```

3. Tidak ada objek root:

   ```sql
   select count(*) filter (where (storage.foldername(name))[1] is null) as root_level
   from storage.objects where bucket_id = 'documents';
   ```

   Harus 0.

### 8b. Keputusan D16

Kalau pemilik memutuskan 13 duplikat dihapus: `--phase=remove-copies
--unreferenced-only` (*dry-run*, lalu `--confirm`). Mode ini hanya menyentuh
entri yang **tidak punya baris** saat plan dan tidak dihapus user, hanya
setelah objek aslinya hilang (sesudah langkah 7), hanya kalau salinannya sama
dengan sha256 di manifest, dan hanya kalau tidak ada baris yang menunjuk
salinan itu. Entri tersebut ditandai `d16_deleted_at`, sehingga `verify`,
`copy`, dan `restore` tidak menyentuhnya lagi (backup-nya tetap disimpan
sampai langkah 9). Kalau prosesnya terputus, jalankan ulang: entri yang
penghapusannya sudah dimulai hanya ditandai.

Setelah langkah 8 dan 8b, tracker 1.12 → ✅.

## Rollback per tahap

Bagian ini **menggantikan** teks rollback di header 0066 (migrasi itu sudah
diterapkan, jadi file-nya tidak boleh diubah). Setiap tulis saat rollback:
*dry-run* dulu, lalu persetujuan pemilik sebelum `--confirm` atau
`apply_migration`.

`--phase=remove-copies` hanya menghapus kunci `dest` di manifest yang masih
sama dengan sha256 manifest:

- **entri hidup:** salinannya dihapus hanya selama objek aslinya (objek di
  manifest) masih ada dan tidak ada baris yang menunjuk salinan itu; objek
  aslinya tidak pernah disentuh;
- **entri yang dihapus user:** sisa entri itu dihapus semua, baik salinan
  maupun objek aslinya;
- **entri D16:** tidak disentuh.

Satu penolakan menghentikan seluruh proses sebelum ada yang ditulis. Setelah
`--confirm`, awal masa tunggu yang tercatat dihapus, sehingga penyalinan ulang
nanti memulai masa tunggu dari awal.

- **Setelah langkah 2–3 (sebelum 0066):** `--phase=remove-copies` (*dry-run*,
  lalu `--confirm`). Tidak ada hal lain yang berubah.
- **Setelah langkah 4–6 (masa tunggu):**
  1. **Jeda KB** sejak langkah ini sampai migrasi revert diterapkan.
  2. `--phase=delete-originals --only-user-deleted` (*dry-run*, lalu
     `--confirm`): objek asli entri yang dihapus user dihapus dulu, supaya
     file itu tidak terbaca lagi saat fallback 0038 kembali. Mode ini tidak
     terhalang oleh salinan rusak milik entri lain.
  3. Migrasi lanjutan yang mengembalikan teks policy 0038 dan me-relink balik
     **hanya** id baris di manifest (SQL ada di header 0066).
  4. `--phase=delete-originals --only-user-deleted` **sekali lagi**, untuk
     entri yang terhapus di antara langkah 2 dan 3.
  5. `--phase=remove-copies` (*dry-run*, lalu `--confirm`). Awal masa tunggu
     yang tercatat ikut dihapus.
- **Setelah langkah 7:** jeda KB (langkah 1 di atas), lalu
  `--phase=restore` (*dry-run*, lalu `--confirm`): objek asli dikembalikan
  dari salinan, atau dari `backup/` kalau salinannya juga hilang; entri yang
  dihapus user dan entri D16 tidak dipulihkan. Lalu langkah 2–5 di atas.
  Langkah 2 dan 4 di sini hanya menghapus objek asli entri yang dihapus user
  **setelah** restore (biasanya tidak ada), dan tidak terhalang oleh salinan
  yang hilang.

## Catatan produksi (2026-10-16)

- Langkah 1: `plan` sesuai angka di atas (15 objek, ±7,4 MB, 4 isi berbeda:
  11 PDF identik dan 2 TXT identik tidak dipakai; 2 TXT dipakai, masing-masing
  4 baris).
- Langkah 2: `copy --confirm` atas persetujuan pemilik, 15:21:52–15:22:03 UTC.
  Langkah 3: `verify` ok, kueri agregat 15/15/15/15.
- Langkah 4: 0066 diterapkan atas persetujuan pemilik (versi
  `20261016154903`, 15:49 UTC) setelah review adversarial 3 lensa (0 blocker,
  0 major). Cek: 8 baris ber-prefix, 0 masih root, 7 baris editor utuh, policy
  tanpa COALESCE, 0 sumber menggantung; skema produksi = replay (591 baris).
- Langkah 5.1: `verify` dengan skrip versi baru: ok, `relinked 8, still root
  0`; **awal masa tunggu `2026-10-16T16:02:21Z`**, jadi `delete-originals`
  paling cepat **2026-10-19T16:02:21Z** (Senin, 23.02 WIB). Salinan kedua
  manifest sudah disimpan setelah verify itu.
- Berikutnya: uji asap oleh pemilik (5.4), merge PR, lalu langkah 6–9.

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

### Latihan putaran 2 (2026-10-17, skrip versi akhir PR ini, stack yang sama)

Data latihan sama dengan di atas. pgTAP: 18 file, 745 tes lulus (satu-satunya
TODO: 1.11). SQL revert yang dipakai persis teks rollback di header 0066.

**A. Rollback selama masa tunggu**

1. `plan` ulang setelah `copy` ditolak dan tidak menulis manifest. Setelah
   0066 dengan `--allow-replan`: `copy stage after-0066`, dan entri yang
   salinannya dihapus user dicatat "dihapus user".
2. `verify` pertama setelah 0066 mencatat awal masa tunggu. `delete-originals`
   ditolak (`72.0 h left`).
3. User menghapus entri A. Salinan satu entri lain sengaja dihapus, sehingga
   `verify` gagal 1. `delete-originals --only-user-deleted` tetap jalan dan
   hanya menghapus objek asli A.
4. `remove-copies` sebelum revert berhenti sebelum menulis apa pun (5 baris
   masih menunjuk salinan).
5. User menghapus entri B saat 0066 masih berlaku, lalu SQL revert diterapkan.
   Anggota bisa membaca lagi objek asli B di root (celah yang ditutup langkah
   rollback 4). `--only-user-deleted` kedua menghapusnya, dan setelah itu baca
   root ditolak.
6. `remove-copies --confirm`: 12 salinan dihapus, 3 dilewati (sudah tidak
   ada), awal masa tunggu dihapus. Dijalankan ulang, tidak ada yang dihapus.
   Kondisi akhir: root 13, folder seed 0, 7 baris editor utuh.

**B. Maju sampai D16, lalu rollback setelah langkah 7**

1. `plan`, `copy`, `verify`, 0066, `verify`, lalu `delete-originals
   --soak-hours=0` (hanya boleh di stack lokal): root 0, folder seed 15.
2. `remove-copies --unreferenced-only` *dry-run*: 13 dihapus, 2 dilewati
   (dipakai). Proses yang terputus disimulasikan (satu entri sudah ditandai
   mulai dan salinannya hilang): `verify` menyebut D16 yang terputus, lalu
   jalan ulang menghapus 12 dan menandai 1. `verify`: ok, `removed under D16
   13`. `copy` dan `restore` melewati ke-13 entri itu.
3. Rollback setelah langkah 7: `restore` mengembalikan 2 objek asli dari
   salinan (13 entri D16 dilewati), `--only-user-deleted` (0), revert,
   `--only-user-deleted` (0), lalu `remove-copies` (2 dihapus, 13 entri D16
   dilewati). Kondisi akhir: root 2, folder seed 0, 8 baris unggahan kembali
   menunjuk root, 7 baris editor, dan anggota membaca root lewat fallback 0038.
