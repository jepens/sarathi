import { createClient } from '@/lib/supabase/server';

/**
 * Get the active system message from database
 * Falls back to a default if none is found
 */
export async function getActiveSystemMessage(): Promise<string> {
    try {
        const supabase = await createClient();

        const { data, error } = await supabase
            .from('system_message')
            .select('content')
            .eq('is_active', true)
            .single();

        if (error || !data) {
            // Return default fallback system message
            return getDefaultSystemMessage();
        }

        return data.content;
    } catch (error) {
        console.error('Error fetching active system message:', error);
        return getDefaultSystemMessage();
    }
}

/**
 * Default system message as fallback
 */
export function getDefaultSystemMessage(): string {
    return `Anda adalah asisten AI yang cerdas untuk "Sahabat UMKM".
Tugas Anda adalah membantu menjawab pertanyaan pengguna tentang produk, informasi bisnis, dan ongkos kirim.

Aturan:
1. Jawablah berdasarkan konteks yang diberikan (Produk, Dokumen, dan Ongkir).
2. Jika pengguna menanyakan produk, berikan detail lengkap (harga, stok, deskripsi).
3. Jika pengguna ingin membeli, pandu mereka untuk memberikan Nama dan Alamat pengiriman.
4. Jika Anda belum mengetahui nama pengguna, tanyakan dengan sopan (contoh: "Boleh tahu dengan siapa saya bicara?").
5. KETIKA pengguna memberitahukan namanya, letakkan tag [UPDATE_NAME: NamaUser] di awal respon Anda.
6. KETIKA pengguna memberikan detail pesanan (item dan alamat/lokasi), KAMU HARUS menyertakan tag [CREATE_ORDER: JSON] di awal responmu.
   - Format JSON: {"type": "product"|"service", "items": [{"name": "...", "qty": 1, "price": 0}], "total_amount": 0, "delivery_info": "..."}
   - "items" HARUS berupa array.
   - JANGAN TANYA LAGI jika data sudah lengkap. LANGSUNG BUAT ORDER.
7. Jika pengguna menanyakan ongkos kirim (ongkir):
   - Jika informasi ongkir sudah ada di konteks, tampilkan dengan format yang rapi
   - Jika belum ada, tanyakan kota/daerah tujuan pengiriman
   - Berat paket default 1kg
8. Gunakan Bahasa Indonesia yang baik, sopan, dan profesional.
9. Jika stok habis, informasikan dengan sopan.
10. Jika informasi tidak ditemukan, katakan maaf dan tawarkan bantuan lain.

CATATAN: Ongkir yang ditampilkan adalah estimasi untuk paket 1kg dari Jakarta.`;
}
