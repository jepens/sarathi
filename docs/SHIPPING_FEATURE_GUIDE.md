# Shipping Cost Feature - User Guide

## 🚀 Cara Menggunakan Fitur Cek Ongkir

Fitur cek ongkir telah terintegrasi dengan chat AI. Pengguna dapat menanyakan ongkos kirim dengan cara yang natural.

### Contoh Percakapan

#### Contoh 1: Tanya Ongkir Langsung
```
User: "Berapa ongkir ke Jakarta Barat?"
AI: [Menampilkan pilihan ongkir dari berbagai kurir]
    "Ongkir ke GROGOL, GROGOL PETAMBURAN, JAKARTA BARAT, DKI JAKARTA:
     
     Jalur Nugraha Ekakurir (JNE):
     - CTC (JNE City Courier): Rp 10.000 (10 hari)
     - REG (Layanan Reguler): Rp 15.000 (2-3 hari)
     
     SiCepat Express:
     - REG (Reguler): Rp 9.000 (2-3 hari)
     
     J&T Express:
     - REG (Reguler): Rp 8.000 (3-4 hari)"
```

#### Contoh 2: Tanya Ongkir Setelah Tanya Produk
```
User: "Ada produk apa aja?"
AI: [Menampilkan daftar produk]

User: "Ongkirnya ke Bandung berapa?"
AI: [Menampilkan ongkir ke Bandung]
```

#### Contoh 3: AI Minta Klarifikasi
```
User: "Berapa ongkirnya?"
AI: "Baik, saya bisa bantu cek ongkir. Ke kota mana tujuan pengirimannya?"

User: "Surabaya"
AI: [Menampilkan ongkir ke Surabaya]
```

#### Contoh 4: Via WhatsApp
Fitur ini juga berfungsi 100% di WhatsApp. User bisa chat ke nomor bot dan menanyakan ongkir dengan cara yang sama.

## 🔧 Cara Kerja

### 1. Intent Detection
Sistem mendeteksi kata kunci terkait ongkir:
- "ongkir"
- "ongkos kirim"
- "biaya kirim"
- "shipping"
- "pengiriman"
- "kirim"

### 2. City Extraction
Sistem mencoba mengekstrak nama kota dari pertanyaan user menggunakan pattern:
- "ke [nama kota]"
- "tujuan [nama kota]"
- "daerah [nama kota]"

### 3. API Call
Jika nama kota terdeteksi:
1. Cari destinasi menggunakan `searchDestination()`
2. Hitung ongkir menggunakan `calculateMultipleCouriers()`
3. Tampilkan hasil dalam response AI

### 4. Default Values
- **Origin**: Jakarta (ID: 4117) - bisa diubah di `lib/ai/rag.ts`
- **Weight**: 1000 gram (1 kg)
- **Couriers**: JNE, SiCepat, J&T

## ⚙️ Konfigurasi

### Mengubah Origin (Lokasi Toko)
Edit file `lib/ai/rag.ts` baris ~84:
```typescript
// Ganti 4117 dengan subdistrict ID toko Anda
const costs = await calculateMultipleCouriers(4117, dest.id, 1000);
```

Untuk mendapatkan subdistrict ID:
1. Jalankan: `npx tsx scripts/test-komerce-api.ts`
2. Atau gunakan fungsi `searchDestination('nama kota')`

### Mengubah Berat Default
Edit file `lib/ai/rag.ts` baris ~84:
```typescript
// Ganti 1000 dengan berat dalam gram
const costs = await calculateMultipleCouriers(4117, dest.id, 2000); // 2kg
```

### Mengubah Kurir
Edit file `lib/shipping/rajaongkir.ts` fungsi `calculateMultipleCouriers`:
```typescript
export async function calculateMultipleCouriers(
    originId: number,
    destinationId: number,
    weight: number,
    couriers: string[] = ['jne', 'sicepat', 'jnt', 'tiki'] // Tambah/kurangi di sini
)
```

## 📝 Catatan Penting

1. **Estimasi**: Ongkir yang ditampilkan adalah estimasi untuk paket 1kg dari Jakarta (default)
2. **Akurasi**: Sistem menggunakan destinasi pertama dari hasil pencarian
3. **Fallback**: Jika kota tidak ditemukan, AI akan meminta klarifikasi
4. **Rate Limit**: Perhatikan rate limit API RajaOngkir di production

## 🐛 Troubleshooting

### Ongkir tidak muncul
- Pastikan `SHIPPING_COST_KOMERCE_API_KEY` sudah diset di `.env.local`
- Cek console log untuk error
- Pastikan nama kota cukup spesifik (misal: "Jakarta Barat" bukan hanya "Jakarta")

### Hasil tidak akurat
- Sistem menggunakan destinasi pertama dari hasil pencarian
- Untuk hasil lebih akurat, user bisa menyebutkan kecamatan (misal: "Grogol, Jakarta Barat")

### AI tidak mendeteksi intent
- Gunakan kata kunci yang jelas: "ongkir", "biaya kirim", dll
- Sebutkan kota tujuan dalam pertanyaan yang sama

## 🚀 Pengembangan Selanjutnya

Fitur yang bisa ditambahkan:
1. **Multiple destinations**: Tampilkan pilihan jika ada beberapa hasil
2. **Weight detection**: Ekstrak berat dari percakapan
3. **Origin selection**: Biarkan user pilih origin jika ada multiple toko
4. **Save preferences**: Simpan preferensi kurir user
5. **Tracking**: Integrasi dengan tracking resi

## 📚 File Terkait

- `lib/ai/rag.ts` - RAG system dengan shipping integration
- `lib/shipping/rajaongkir.ts` - Shipping service
- `docs/RAJAONGKIR_INTEGRATION.md` - Dokumentasi API lengkap
- `scripts/test-komerce-api.ts` - Testing script
