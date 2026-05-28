# Knowledge Base — konten untuk AI (Nindra)

Folder ini berisi **template konten** yang dipakai untuk "mengisi otak" AI Sailendra.
Makin lengkap & akurat isinya, makin pintar jawaban Nindra ke customer di WhatsApp.

## Cara pakai

1. **Edit setiap file** — ganti semua `[ISI: ...]` dengan data Sailendra yang sebenarnya
   (harga, termin pembayaran, nama paket, dll). Hapus baris/section yang tidak relevan.
2. **Simpan sebagai .txt atau .md** (sudah .md — bisa langsung).
3. **Upload via dashboard** → menu **Knowledge Base** → upload tiap file.
   Sistem otomatis memotong (chunk) + membuat embedding, lalu AI bisa mengutipnya.
4. Untuk **Paket Acara** (yang dipakai AI untuk quote harga & buat booking), lihat
   bagian khusus di bawah.

## Penting

- **Jangan masukkan harga karangan.** Kosongkan / tandai "hubungi tim" kalau belum pasti —
  lebih baik AI bilang "akan dicek tim" daripada menyebut harga salah.
- **Satu topik = satu file** memudahkan retrieval. Jangan gabung semua jadi satu file raksasa.
- **Update berkala.** Kalau ada paket/harga/kebijakan baru, edit file → upload ulang.
- File di sini **tidak otomatis aktif** — harus di-upload via dashboard dulu.

## Daftar file

| File | Isi | Status setelah Anda isi |
|---|---|---|
| `01-layanan-dan-paket.md` | Katalog layanan: team building, gathering, dll | Upload ke Knowledge Base |
| `02-harga-dan-pembayaran.md` | Model harga + termin DP/pelunasan | Upload ke Knowledge Base |
| `03-proses-pemesanan.md` | Alur dari inquiry → proposal → DP → eksekusi | Upload ke Knowledge Base |
| `04-area-layanan-dan-venue.md` | Lokasi yang dilayani + tipe venue | Upload ke Knowledge Base |
| `05-portofolio-dan-testimoni.md` | Event lampau + testimoni (social proof) | Upload ke Knowledge Base |

## Paket Acara (produk/layanan yang bisa di-quote AI)

Selain dokumen di atas, AI juga membaca tabel **Paket Acara** untuk menyebut paket + harga
dan membuat booking. Dua cara mengisinya:

- **Manual (disarankan):** dashboard → **Paket Acara** → Tambah Paket. Embedding dibuat otomatis.
- **Bulk (opsional):** edit harga di `scripts/seed-packages.mjs` lalu jalankan
  `node --env-file=.env.local scripts/seed-packages.mjs --confirm`.
  Tanpa `--confirm` script hanya menampilkan preview (dry-run), tidak menulis DB.

> Catatan: produk contoh lama (`kopi arabica`, `konsultasi team building`) adalah data test —
> hapus dari menu Paket Acara setelah paket asli masuk.
