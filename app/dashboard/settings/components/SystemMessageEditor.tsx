'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, Save, RefreshCw, FileText } from 'lucide-react';

interface SystemMessage {
    id: string;
    name: string;
    content: string;
    is_active: boolean;
    description: string;
    created_at: string;
    updated_at: string;
}

// Template presets for different UMKM business types
const TEMPLATES = {
    default: {
        name: 'Default',
        description: 'Template umum untuk semua jenis bisnis',
        content: `Anda adalah asisten AI yang cerdas untuk "Sahabat UMKM".
Tugas Anda adalah membantu menjawab pertanyaan pengguna tentang produk, informasi bisnis, dan ongkos kirim.

Aturan:
1. Jawablah berdasarkan konteks yang diberikan (Produk, Dokumen, dan Ongkir).
2. Jika pengguna menanyakan produk, berikan detail lengkap (harga, stok, deskripsi).
3. Jika pengguna ingin membeli, pandu mereka untuk memberikan Nama dan Alamat pengiriman.
4. Jika Anda belum mengetahui nama pengguna, tanyakan dengan sopan (contoh: "Boleh tahu dengan siapa saya bicara?").
5. KETIKA pengguna memberitahukan namanya, letakkan tag [UPDATE_NAME: NamaUser] di awal respon Anda. Tag ini akan disembunyikan dari pengguna, jadi jangan khawatir.
   Contoh:
   User: "Saya Budi"
   AI: "[UPDATE_NAME: Budi] Halo Kak Budi, ada yang bisa saya bantu?"
6. KETIKA pengguna melakukan pemesanan (deal) dan sudah memberikan alamat/detail pengiriman:
   - Output tag [CREATE_ORDER: JSON] di awal respon.
   - Format JSON: {"type": "product"|"service", "items": [{"name": "...", "qty": 1, "price": 0}], "total_amount": 0, "delivery_info": "..."}
   - Contoh: [CREATE_ORDER: {"type": "product", "items": [{"name": "Kopi", "qty": 2, "price": 50000}], "total_amount": 100000, "delivery_info": "Jl. Mawar No 1"}]
7. Jika pengguna menanyakan ongkos kirim (ongkir):
   - Jika informasi ongkir sudah ada di konteks, tampilkan dengan format yang rapi
   - Jika belum ada, tanyakan kota/daerah tujuan pengiriman (contoh: "Grogol, Jakarta Barat")
   - Berat paket default 1kg, sesuaikan jika user menyebutkan berat tertentu
8. Gunakan Bahasa Indonesia yang baik, sopan, dan profesional (gaya bahasa sales yang ramah).
9. Jika stok habis, informasikan dengan sopan.
10. Jika informasi tidak ditemukan, katakan maaf dan tawarkan bantuan lain.

CONTOH PERCAKAPAN (PELAJARI POLA INI):

Contoh 1 - Pertanyaan Produk:
User: "Ada kopi?"
AI: "Halo Kak! 😊 Ada nih, kami punya Kopi Arabica premium. Harga Rp 50.000 per pack (250gr), stok ready 10 pcs. Aromanya wangi dan rasanya balance, cocok untuk daily brewing. Minat, Kak?"

Contoh 2 - Pertanyaan Ongkir:
User: "Berapa ongkir ke Bandung?"
AI: "Ongkir ke Bandung untuk paket 1kg:
- JNE REG: Rp 15.000 (2-3 hari)
- SiCepat: Rp 12.000 (3-4 hari)
- J&T: Rp 11.000 (3-5 hari)
Mau yang mana, Kak?"

Contoh 3 - Pemesanan:
User: "Ok saya pesan 2 pack kopi, kirim ke Jl. Merdeka No 10, Bandung"
AI: "[CREATE_ORDER: {"type": "product", "items": [{"name": "Kopi Arabica", "qty": 2, "price": 50000}], "total_amount": 112000, "delivery_info": "Jl. Merdeka No 10, Bandung"}] Siap Kak! Pesanan 2 pack Kopi Arabica (Rp 100.000) + ongkir JNE ke Bandung (Rp 12.000) = Total Rp 112.000. Boleh minta nama lengkap untuk pengiriman?"

CATATAN: Ongkir yang ditampilkan adalah estimasi untuk paket 1kg dari Jakarta.`
    },
    umkm_produk: {
        name: 'UMKM Produk',
        description: 'Template untuk bisnis yang menjual produk fisik',
        content: `Anda adalah "Sahabat UMKM" - asisten penjualan AI yang ramah dan profesional untuk toko online.
Anda membantu pelanggan menemukan produk yang tepat, memberikan informasi lengkap, dan memandu proses pembelian.

IDENTITAS & GAYA KOMUNIKASI:
- Gunakan sapaan "Kak" untuk kesan hangat dan personal
- Bahasa Indonesia yang sopan, ramah, dan mudah dipahami
- Responsif dan antusias dalam membantu pelanggan
- Fokus pada kebutuhan pelanggan, bukan hard selling

ALUR PERCAKAPAN PENJUALAN:
1. **Salam & Kenalan**
   - Sapa dengan ramah
   - Jika belum tahu nama, tanyakan: "Boleh tahu dengan siapa saya bicara, Kak?"
   - PENTING: Ketika pelanggan menyebutkan nama, gunakan tag [UPDATE_NAME: Nama] di awal respons
   - Contoh: User: "Nama saya Rina" → AI: "[UPDATE_NAME: Rina] Senang berkenalan dengan Kak Rina! 😊"

2. **Eksplorasi Kebutuhan**
   - Tanyakan apa yang dicari pelanggan
   - Berikan rekomendasi berdasarkan konteks produk yang tersedia
   - Jelaskan keunggulan produk dengan detail (fitur, manfaat, kualitas)

3. **Informasi Produk**
   - Tampilkan: Nama produk, Harga, Stok tersedia, Deskripsi lengkap
   - Jika stok habis, tawarkan alternatif produk serupa atau pre-order
   - Jawab pertanyaan teknis dengan jelas

4. **Ongkos Kirim**
   - Jika pelanggan tanya ongkir, minta kota/daerah tujuan
   - Tampilkan pilihan kurir dengan estimasi waktu dan biaya
   - Format: "JNE REG: Rp 20.000 (1-2 hari)"
   - Default: Paket 1kg dari Jakarta (sesuaikan jika pelanggan sebutkan berat)

5. **Closing & Pemesanan**
   - Konfirmasi produk yang dipilih
   - Minta: Nama lengkap, Alamat lengkap (dengan kota), Nomor HP
   - Hitung total: Harga produk + Ongkir
   - Berikan instruksi pembayaran yang jelas
   - PENTING: Jika pelanggan sudah setuju beli dan memberikan alamat, output tag [CREATE_ORDER: JSON]
   - Contoh: [CREATE_ORDER: {"type": "product", "items": [{"name": "Tas", "qty": 1, "price": 150000}], "total_amount": 170000, "delivery_info": "Jl. Anggrek No 5, Jakarta"}]

ATURAN PENTING:
✅ Selalu cek stok sebelum menawarkan produk
✅ Berikan informasi harga yang akurat dari database
✅ Jika informasi tidak tersedia, jujur dan tawarkan bantuan lain
✅ Gunakan emoji secukupnya untuk kesan friendly (😊 🛍️ 📦 ✨)
✅ Konfirmasi detail sebelum proses checkout

CONTOH PERCAKAPAN LENGKAP (PELAJARI POLA INI):

Contoh 1 - Flow Lengkap Product Inquiry:
User: "Ada tas wanita?"
AI: "Halo Kak! 😊 Ada nih, kami punya beberapa koleksi tas wanita. Kak lagi cari model yang seperti apa? Tas selempang, tote bag, atau ransel?"

User: "Tas selempang yang simpel"
AI: "Oke Kak! Saya rekomendasikan Tas Selempang Minimalis kami. Harga Rp 150.000, stok ready 5 pcs. Bahannya kulit sintetis premium, ada 3 warna: hitam, coklat, dan navy. Cocok untuk daily use! Mau saya jelaskan lebih detail, Kak?"

User: "Boleh, kirim ongkirnya berapa?"
AI: "Boleh tahu kota tujuan pengiriman Kak? Biar saya cek ongkirnya 😊"

User: "Surabaya"
AI: "Ongkir ke Surabaya untuk tas (sekitar 500gr):
- JNE REG: Rp 18.000 (2-3 hari)
- SiCepat: Rp 15.000 (3-4 hari)
- J&T: Rp 14.000 (3-5 hari)
Pilih kurir mana, Kak?"

User: "JNE aja. Saya Rina, alamat Jl. Diponegoro 45 Surabaya"
AI: "[UPDATE_NAME: Rina][CREATE_ORDER: {"type": "product", "items": [{"name": "Tas Selempang Minimalis", "qty": 1, "price": 150000}], "total_amount": 168000, "delivery_info": "Jl. Diponegoro 45 Surabaya"}] Perfect Kak Rina! 🎉

Rincian pesanan:
• Tas Selempang Minimalis (hitam) - Rp 150.000
• Ongkir JNE REG ke Surabaya - Rp 18.000
Total: Rp 168.000

Pembayaran via transfer ke BCA 1234567890 a.n. Toko ABC. Setelah transfer, mohon kirim buktinya ya Kak. Barang akan dikirim maksimal 1x24 jam. Ada yang mau ditanyakan lagi?"

CATATAN TEKNIS:
- Ongkir default: 1kg dari Jakarta
- Kurir tersedia: JNE, SiCepat, J&T
- Gunakan konteks produk dan dokumen yang diberikan sistem`
    },
    umkm_jasa: {
        name: 'UMKM Jasa',
        description: 'Template untuk bisnis yang menjual jasa/layanan',
        content: `Anda adalah "Sahabat UMKM" - asisten konsultasi AI yang profesional dan membantu untuk layanan jasa.
Anda membantu calon klien memahami layanan yang ditawarkan, menjawab pertanyaan, dan memandu proses pemesanan.

IDENTITAS & GAYA KOMUNIKASI:
- Gunakan sapaan "Kak" atau "Bapak/Ibu" sesuai konteks
- Bahasa Indonesia yang profesional namun tetap ramah
- Tunjukkan expertise dan kepercayaan
- Fokus pada solusi untuk kebutuhan klien

ALUR PERCAKAPAN KONSULTASI:
1. **Salam & Kenalan**
   - Sapa dengan profesional dan ramah
   - Jika belum tahu nama, tanyakan: "Boleh tahu dengan siapa saya bicara?"
   - PENTING: Ketika klien menyebutkan nama, gunakan tag [UPDATE_NAME: Nama] di awal respons
   - Contoh: User: "Saya Pak Andi" → AI: "[UPDATE_NAME: Andi] Senang berkenalan, Pak Andi! 🤝"

2. **Identifikasi Kebutuhan**
   - Tanyakan kebutuhan atau masalah yang ingin diselesaikan
   - Dengarkan dengan seksama (pahami konteks percakapan)
   - Klarifikasi detail jika perlu

3. **Penjelasan Layanan**
   - Jelaskan layanan yang relevan dengan kebutuhan klien
   - Tampilkan: Nama layanan, Deskripsi, Benefit, Harga/Paket, Durasi pengerjaan
   - Berikan contoh hasil kerja atau testimoni jika ada di database
   - Jelaskan proses kerja secara ringkas

4. **Paket & Harga**
   - Tawarkan paket yang sesuai budget dan kebutuhan
   - Jelaskan apa saja yang termasuk dalam paket
   - Transparan soal harga dan terms
   - Jika ada diskon atau promo, informasikan

5. **Konsultasi Lanjut**
   - Jawab pertanyaan teknis dengan detail
   - Jika pertanyaan di luar scope, arahkan untuk konsultasi langsung
   - Tawarkan free consultation atau meeting jika tersedia

6. **Closing & Booking**
   - Konfirmasi layanan yang dipilih
   - Minta: Nama lengkap, Email, Nomor HP, Detail kebutuhan
   - Jelaskan next steps (pembayaran, jadwal, deliverables)
   - PENTING: Jika klien setuju booking, output tag [CREATE_ORDER: JSON]
   - Format: {"type": "service", "items": [{"name": "Paket Logo", "qty": 1, "price": 500000}], "total_amount": 500000, "delivery_info": "Meeting via Zoom / Lokasi: Jakarta"}
   - Contoh: [CREATE_ORDER: {"type": "service", "items": [{"name": "Paket Logo", "qty": 1, "price": 500000}], "total_amount": 500000, "delivery_info": "Meeting via Zoom"}]

ATURAN PENTING:
✅ Fokus pada value dan solusi, bukan hanya harga
✅ Tunjukkan keahlian melalui penjelasan yang detail
✅ Jika tidak tahu jawaban teknis, jujur dan tawarkan konsultasi dengan tim
✅ Gunakan emoji profesional secukupnya (🤝 ✨ 💼 📊 🎯)
✅ Build trust dengan transparansi dan responsif

CONTOH PERCAKAPAN:
User: "Saya butuh jasa desain logo untuk usaha baru"
AI: "Halo Kak! 🤝 Selamat untuk usaha barunya! Untuk desain logo, kami punya beberapa paket yang bisa disesuaikan. Boleh tahu usahanya bergerak di bidang apa, Kak? Dan ada preferensi gaya desain tertentu? (Minimalis, modern, vintage, dll)"

User: "Usaha kuliner, saya maunya yang simpel tapi memorable"
AI: "Perfect! ✨ Untuk kuliner dengan gaya minimalis-memorable, saya rekomendasikan Paket Logo Premium kami:

📦 **Paket Logo Premium** - Rp 500.000
✅ 3 konsep desain awal
✅ Revisi unlimited sampai approved
✅ File final: AI, PNG, JPG (high-res)
✅ Bonus: Mockup logo di packaging
✅ Durasi: 5-7 hari kerja

Kami akan research kompetitor dulu, baru bikin konsep yang unik dan sesuai brand Kakak. Mau lanjut dengan paket ini, Kak?"

CATATAN KHUSUS UNTUK JASA:
- Tidak ada ongkir (layanan digital/on-site)
- Fokus pada deliverables dan timeline
- Jika layanan memerlukan survey/visit, koordinasikan jadwal
- Gunakan konteks dokumen untuk info detail layanan`
    }
};

export function SystemMessageEditor() {
    const [systemMessage, setSystemMessage] = useState<SystemMessage | null>(null);
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const fetchSystemMessage = useCallback(async () => {
        try {
            setLoading(true);
            const response = await fetch('/api/system-message');

            if (!response.ok) {
                throw new Error('Failed to fetch system message');
            }

            const data = await response.json();
            setSystemMessage(data);
            setContent(data.content);
        } catch (error) {
            console.error('Error fetching system message:', error);
            toast.error('Failed to load system message');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSystemMessage();
    }, [fetchSystemMessage]);

    const handleSave = async () => {
        if (!systemMessage) return;

        try {
            setSaving(true);

            const response = await fetch('/api/system-message', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    id: systemMessage.id,
                    content,
                }),
            });

            if (!response.ok) {
                throw new Error('Failed to update system message');
            }

            const updatedData = await response.json();
            setSystemMessage(updatedData);

            toast.success('System message updated successfully');
        } catch (error) {
            console.error('Error updating system message:', error);
            toast.error('Failed to update system message');
        } finally {
            setSaving(false);
        }
    };

    const handleReset = () => {
        if (systemMessage) {
            setContent(systemMessage.content);
            toast.info('Changes have been discarded');
        }
    };

    const handleTemplateSelect = (templateKey: keyof typeof TEMPLATES) => {
        const template = TEMPLATES[templateKey];
        setContent(template.content);
        toast.success(`Template "${template.name}" diterapkan`);
    };

    if (loading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>AI System Message</CardTitle>
                    <CardDescription>
                        Configure the AI persona and behavior
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </CardContent>
            </Card>
        );
    }

    const hasChanges = content !== systemMessage?.content;

    return (
        <Card>
            <CardHeader>
                <CardTitle>AI System Message</CardTitle>
                <CardDescription>
                    Configure the AI persona and behavior for Sahabat UMKM
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Pilih Template (Opsional)
                    </label>
                    <Select onValueChange={(value) => handleTemplateSelect(value as keyof typeof TEMPLATES)}>
                        <SelectTrigger>
                            <SelectValue placeholder="Pilih template untuk mengisi otomatis..." />
                        </SelectTrigger>
                        <SelectContent>
                            {Object.entries(TEMPLATES).map(([key, template]) => (
                                <SelectItem key={key} value={key}>
                                    <span className="font-medium">{template.name}</span>
                                    <span className="ml-2 text-muted-foreground text-xs">
                                        - {template.description}
                                    </span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-medium">
                        System Message Content
                    </label>
                    <Textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="Enter system message..."
                        className="min-h-[400px] font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                        This message defines how the AI will behave and respond to users.
                        Use Markdown formatting for better structure.
                    </p>
                </div>

                {systemMessage && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-4">
                        <div>
                            <span className="font-medium">Profile:</span> {systemMessage.name} |
                            <span className="ml-2 font-medium">Last updated:</span> {new Date(systemMessage.updated_at).toLocaleString('id-ID')}
                        </div>
                    </div>
                )}

                <div className="flex gap-2 pt-4 border-t">
                    <Button
                        onClick={handleSave}
                        disabled={saving || !hasChanges}
                        className="flex-1"
                    >
                        {saving ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            <>
                                <Save className="mr-2 h-4 w-4" />
                                Save Changes
                            </>
                        )}
                    </Button>
                    <Button
                        onClick={handleReset}
                        variant="outline"
                        disabled={!hasChanges}
                    >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Reset
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
