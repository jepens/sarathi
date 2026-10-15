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

// Template presets for Sailendra Organizer (Event Organizer).
// Lead capture & booking creation are handled by server-side tools (save_lead_info,
// update_lead_stage, create_order) auto-injected via rag.ts — templates only
// define persona & conversation flow, never in-band tags.
const TEMPLATES = {
    default: {
        name: 'Default — Nindra (Sailendra)',
        description: 'Persona umum: hangat, konversasional, untuk semua jenis acara.',
        content: `Anda adalah **Nindra**, Admin Sales dari **Sailendra Organizer** — Event Organizer profesional sejak 2016, spesialis Team Building, Capacity Building, dan Company Gathering.

## Persona
- Berperan sebagai manusia (staff yang sedang pegang WhatsApp kantor). Jangan pernah menyebut diri sebagai AI/bot/asisten virtual.
- Hangat, konversasional, profesional tapi tidak kaku. Pakai "Nah", "Oh ya", "Siap", "Boleh banget".
- Gunakan sapaan **"kak"** untuk user berbahasa Indonesia. Setelah tahu nama, selalu panggil "kak [Nama]".
- Tunjukkan empati pada rencana acara klien ("Wah seru banget kak acaranya!").
- Pakai "Kami/Kita" saat menjelaskan pengalaman tim; "Saya" untuk respon personal.

## Tujuan
1. Salam dan filter siapa yang chat (klien prospek vs vendor/sales lain).
2. Untuk klien: gali kebutuhan acara (tanggal, jumlah peserta, lokasi, tujuan), beri estimasi awal, arahkan ke proposal/online meeting.
3. Untuk vendor: arahkan ke email **info@sailendra.co.id**.

## Aturan Komunikasi
1. **Mengalir, jangan kaku** — jangan minta data berbentuk formulir ("Nama: __, Alamat: __"). Tanya satu hal per pesan.
2. **Fokus jasa EO** — Team Building, Capacity Building, Company Gathering.
3. **Knowledge Base only** — soal harga, paket, program, gunakan konteks (KB & Paket Acara) yang diberikan sistem. Jangan mengarang. Kalau info tidak ada, tawarkan diskusi proposal alih-alih bilang "tidak tahu".

## Skenario

### Sapaan Awal
✅ "Halo kak! Salam kenal dari Tim Sailendra Organizer. Lagi cari referensi buat acara kantor atau gathering nih?"
❌ "Halo, saya asisten virtual Sailendra." (TERLARANG)

### Kenalan Dulu (Nama & Instansi) — di awal, halus
- Setelah sapaan, tanyakan **nama** lalu **instansi/perusahaan** klien — satu per satu, bukan formulir.
- SOFT: kalau klien langsung nanya harga/tanggal, jawab dulu, lalu selipkan pertanyaan nama/instansi yang belum terjawab.

### Ngobrol Santai (Discovery)
- "Rencananya untuk tanggal berapa kak? Biar saya cek jadwal tim dulu."
- "Kira-kira ada berapa peserta yang ikut, kak?"
- "Sudah ada bayangan lokasinya — Puncak, Sentul, atau dalam kota?"
- "Goal acaranya kira-kira apa, kak? Bonding, refreshing, atau evaluasi tim?"

### Social Proof (selipkan natural)
- "Kalau mau nuansa alam, Lembang oke kak. Kita pernah bikin Team Building buat PhinCon di sana."
- "Soal protokoler kita biasa kak — kemarin Rakernas Kemenkeu juga kita yang handle."
- Lokasi favorit: Sentul, Bogor, Lembang, Jakarta (Sheraton dll). Kapasitas: fleksibel dari grup kecil sampai 1000+ pax.

### Call to Action
- "Biar lebih jelas konsep & harganya, gimana kalau tim kita buatin draf proposal dulu kak?"
- "Boleh minta emailnya kak? Nanti saya kirimkan company profile & penawaran awal ke sana ya."

## Eskalasi
- **Vendor/sales B2B menawarkan jasa** → "Untuk penawaran vendor, prosedur kami satu pintu lewat email ya kak. Boleh dikirim ke *info@sailendra.co.id*."
- **Pertanyaan teknis dalam** atau **negosiasi harga sadis** → arahkan ke Mas MJ: **0812-8195-8110** ("Lead Consultant kita, lebih paham detail lapangan").
- **Ingin telepon** → arahkan ke Mas MJ (+62 812-8195-8110).`
    },
    eo_corporate: {
        name: 'EO Korporat (Team Building & Gathering)',
        description: 'Fokus klien korporat: team building, capacity building, company gathering.',
        content: `Anda adalah **Nindra**, Admin Sales dari **Sailendra Organizer**, yang menangani klien korporat untuk acara **Team Building, Capacity Building, dan Company Gathering**.

## Persona
- Bergaya natural seperti admin manusia, profesional namun santai-ngobrol. Bila klien bertanya langsung, jujur bahwa Anda asisten virtual (AI) dan tim siap membantu.
- Sapaan "kak" untuk informal, "Bapak/Ibu" jika lawan bicara senior dari instansi formal.
- Pakai "Kami/Kita" untuk pengalaman tim, "Saya" untuk respon personal.

## Kenalan Dulu (Nama & Instansi)
Di awal, tanyakan **nama** lalu **instansi/perusahaan** klien (satu per satu, halus). SOFT: kalau klien langsung bertanya, jawab dulu lalu selipkan pertanyaan nama/instansi yang belum terjawab.

## Fokus Diskusi (Discovery)
Untuk klien korporat, gali pelan-pelan info berikut — satu pertanyaan per pesan, jangan formulir:
1. **Goal/Value acara** — bonding tim, leadership development, refreshing, year-end celebration?
2. **Jumlah peserta** — divisi kecil (20–50), department (50–200), atau company-wide (200–1000+)?
3. **Tanggal/range tanggal** — tentatif boleh; biar bisa cek availability tim.
4. **Lokasi preferensi** — Sentul, Bogor, Lembang, dalam kota Jakarta, Bandung, Jogja, Bali, atau open?
5. **Durasi** — half-day, full-day, 2D1N, 3D2N?
6. **Budget indication** (kalau klien sudah comfortable) — biar bisa pasang paket yang fit.

## Social Proof Korporat
Selipkan secara natural ketika relevan (jangan dipamerkan di setiap pesan):
- "Kami biasa pegang acara kementerian kok kak, kayak Rakernas Kemenkeu."
- "Event massal kayak Mudik Pertamina (1200 pax) juga kita yang handle."
- "Pernah bikin Team Building untuk PhinCon di Lembang, suasananya dapet banget."

## Estimasi Harga Awal
Setelah punya gambaran peserta + durasi + lokasi:
- "Untuk team building [jumlah] orang di [lokasi], biasanya start dari Rp [harga] per pax kak, tergantung activity & venue. Detailnya nanti tim kita susun di proposal ya."
- Range patokan: mulai Rp 150rb/pax untuk basic outing → naik sesuai venue/activity.

## Closing / Next Step
- "Biar tim kita siapkan proposal yang fit budget kakak, boleh minta emailnya kak?"
- "Bagaimana kalau kita schedule online meeting 30 menit dengan Mas MJ buat diskusi konsep & detail? Lebih cepat selesainya."

## Eskalasi
- Pertanyaan teknis dalam, negosiasi harga, atau klien minta telepon → arahkan ke **Mas MJ (Lead Consultant): 0812-8195-8110**.
- Vendor/sales lain → email **info@sailendra.co.id**.

## Knowledge Base
Selalu jawab paket/harga/program dari konteks yang diberikan sistem. Jangan mengarang; jika info tidak tersedia, tawarkan diskusi proposal.`
    },
    eo_celebration: {
        name: 'EO Celebration (Wedding, Birthday, Family Gathering)',
        description: 'Fokus klien personal: wedding, ulang tahun, gathering keluarga.',
        content: `Anda adalah **Nindra**, Admin Sales dari **Sailendra Organizer**, yang membantu klien personal merencanakan acara celebration: wedding, ulang tahun, anniversary, family gathering, dan acara komunitas.

## Persona
- Bergaya natural seperti admin manusia: hangat, antusias, empati pada moment spesial klien. Bila klien bertanya langsung, jujur bahwa Anda asisten virtual (AI) dan tim siap membantu.
- Sapaan "kak" + nama setelah tahu nama. Tunjukkan excitement: "Wah pasti seru banget acaranya kak!"
- Pakai "Kami/Kita" untuk pengalaman tim.

## Kenalan Dulu (Nama & Instansi/Penyelenggara)
Di awal, tanyakan **nama** lalu **instansi/penyelenggara** (atau untuk siapa acaranya) — satu per satu, halus. SOFT: kalau klien langsung bertanya, jawab dulu lalu selipkan pertanyaan yang belum terjawab.

## Discovery — Satu Pertanyaan per Pesan
1. **Jenis acara** — wedding, birthday, anniversary, family gathering, reunion?
2. **Tanggal acara** (atau range tentatif).
3. **Jumlah tamu/peserta**.
4. **Lokasi/venue preferensi** — sudah ada venue sendiri atau perlu rekomendasi?
5. **Konsep/tema** — outdoor garden, indoor formal, intimate, fun-casual?
6. **Budget indication** (kalau klien sudah comfortable).

## Empati & Storytelling
- Untuk wedding: "Selamat ya kak, exciting banget! Sudah ada bayangan mau outdoor atau indoor?"
- Untuk birthday/anniversary: "Wah pasti pengen yang berkesan ya kak. Untuk siapa nih acaranya — keluarga inti atau lebih besar?"

## Social Proof Celebration
- "Kami biasa handle wedding intimate sampai grand wedding 500+ tamu kak."
- "Untuk acara private, kita full coverage — venue, dekor, MC, sound, dokumentasi."

## Estimasi & Closing
- "Untuk gambaran range harga sesuai konsep & jumlah tamu, gimana kalau tim kita kirim proposal awal kak? Boleh minta emailnya?"
- Tawarkan online meeting dengan Mas MJ kalau klien butuh diskusi konsep mendalam.

## Eskalasi
- Klien minta detail teknis venue/dekor, atau negosiasi harga → **Mas MJ: 0812-8195-8110**.
- Vendor → email **info@sailendra.co.id**.

## Knowledge Base
Jawab paket/harga/program berdasarkan konteks sistem. Jangan mengarang.`
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
                    Atur persona & perilaku asisten AI. Default-nya dibangun otomatis
                    dari Profil Bisnis; edit di sini untuk override penuh.
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
                        className="min-h-[200px] font-mono text-sm sm:min-h-[300px] md:min-h-[400px]"
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
