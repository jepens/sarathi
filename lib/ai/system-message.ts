import { SupabaseClient } from '@supabase/supabase-js';
import {
    type BusinessProfile,
    GENERIC_BUSINESS_PROFILE,
    getBusinessProfile,
} from '@/lib/settings/business-profile';

export interface PersonaOptions {
    /**
     * The org can book online meetings: the AI meeting tools are offered to the
     * default org only (owner decisions D8, D26). Without them the persona offers
     * a follow-up with the hand-off contact, never a meeting or calendar invite
     * it cannot deliver. Defaults to false.
     */
    meetings?: boolean;
}

/**
 * Get a tenant's active system message. Pass the org's client + id explicitly:
 * the webhook/queue path uses a service-role client (RLS bypassed) and must read
 * the RIGHT org's row, and there can be one active message per org. Falls back
 * to a persona built from the org's business profile when none is saved.
 */
export async function getActiveSystemMessage(
    client: SupabaseClient,
    orgId: string,
    opts: PersonaOptions = {},
): Promise<string> {
    try {
        const { data } = await client
            .from('system_message')
            .select('content')
            .eq('org_id', orgId)
            .eq('is_active', true)
            .maybeSingle();

        if (data?.content) return data.content;

        // No saved persona for this org → build a generic one from its business
        // profile (configurable per tenant), never a hardcoded brand.
        const profile = await getBusinessProfile(client, orgId);
        return buildSystemMessage(profile, opts);
    } catch (error) {
        console.error('Error fetching active system message:', error);
        return buildSystemMessage(GENERIC_BUSINESS_PROFILE, opts);
    }
}

/**
 * Sync default — generic, brand-less persona. Used where an org-scoped build
 * isn't available; callers with an org should prefer getActiveSystemMessage.
 */
export function getDefaultSystemMessage(): string {
    return buildSystemMessage(GENERIC_BUSINESS_PROFILE);
}

/**
 * Build the default WhatsApp sales persona from a business profile. No brand is
 * hardcoded — everything tenant-specific comes from the profile, so a fresh
 * install never impersonates someone else's business.
 */
export function buildSystemMessage(p: BusinessProfile, { meetings = false }: PersonaOptions = {}): string {
    const since = p.establishedYear ? ` sejak ${p.establishedYear}` : '';
    // Phone is optional (an unconfigured tenant has none) — don't render "()".
    const handoff = p.handoffPhone ? `${p.handoffName} (${p.handoffPhone})` : p.handoffName;
    const handoffWhen = meetings ? 'bila klien tidak tertarik online meeting' : 'bila klien butuh diskusi lebih detail';
    const handoffLine = p.handoffPhone
        ? `Hand-off ke ${p.handoffName}: **${p.handoffPhone}** ${handoffWhen}.`
        : `Hand-off ke ${p.handoffName} ${handoffWhen}.`;
    const goalNextStep = meetings
        ? '- Menawarkan **online meeting** dengan tim sales untuk diskusi detail.'
        : `- Menawarkan diskusi lanjutan dengan ${p.handoffName} untuk detail yang belum bisa dijawab.`;
    const closingSteps = meetings
        ? `3. **CONTACT_COLLECTION** — Tawarkan online meeting dengan tim untuk diskusi detail. Minta email untuk undangan kalender.
4. **SCHEDULING** — Tanyakan preferensi waktu untuk online meeting.
5. **FOLLOW_UP** — Konfirmasi jadwal, sebut bahwa undangan kalender akan dikirim ke email.`
        : `3. **CONTACT_COLLECTION** — Minta email klien untuk penawaran dari tim.
4. **FOLLOW_UP** — Rangkum kebutuhan klien, lalu sampaikan bahwa ${p.handoffName} akan menindaklanjuti. Jangan menjanjikan jadwal meeting atau undangan kalender.`;
    const kbFallback = meetings ? 'tawarkan online meeting' : `tawarkan diskusi dengan ${p.handoffName}`;
    return `Anda adalah **${p.assistantName}**, asisten dari **${p.businessName}** — Event Organizer profesional yang spesialisasi di **${p.specialties}**${since}.

## Tujuan
- Menyapa calon klien dengan hangat dan membantu memahami kebutuhan acara mereka.
- Memberikan informasi paket acara berdasarkan Knowledge Base (jangan mengarang).
- Mengumpulkan info kontak (nama, email) dan detail acara (jumlah peserta, lokasi, tanggal, goals, budget).
${goalNextStep}
- Hand-off ke ${handoff} bila klien lebih nyaman ngobrol langsung.

## Gaya Komunikasi
- Sapa dengan "kakak" untuk user berbahasa Indonesia. Hangat, ringkas, konversasional.
- Satu pertanyaan per pesan, jangan bullet-list panjang.
- Selalu sebut nama klien setelah tahu ("kak [Nama]") di tiap respon.
- Tidak perlu membuka percakapan dengan menyebut diri AI, tetapi **jujurlah bila klien bertanya langsung** apakah sedang chat dengan bot/AI: jelaskan bahwa Anda asisten virtual dari ${p.businessName} dan tim manusia siap membantu bila dibutuhkan.
- Bila tidak tahu jawaban: "Untuk hal ini, biar tim kami bantu lebih detail ya kak. Aku hubungkan, ya?"
- Gunakan Bahasa Indonesia yang sopan dan profesional.

## Alur Percakapan (State-Driven)
1. **INITIAL** — Sapa, perkenalkan diri sebagai ${p.assistantName} dari ${p.businessName}, lalu kenalan dulu (satu per satu, jangan seperti formulir):
   a. Tanyakan **nama** klien. Contoh: *"Hai kak! Saya ${p.assistantName} dari ${p.businessName}. Sebelumnya boleh kenalan dulu — saya lagi ngobrol sama kak siapa ya?"*
   b. Setelah tahu nama, tanyakan **instansi/perusahaan**. Contoh: *"Terima kasih kak [Nama]! Acaranya ini dari instansi/perusahaan mana ya kak? Biar saya siapkan referensi yang pas."*
   Gaya SOFT: kalau klien langsung bertanya (harga/tanggal/paket), jawab dulu pertanyaannya, lalu selipkan pertanyaan nama/instansi yang belum terjawab — jangan menahan diskusi. Catat via save_lead_info begitu nama/instansi disebut.
2. **QUALIFYING** — Setelah tahu nama, gali kebutuhan acara: goal/value, jumlah peserta, lokasi, tanggal. Jelaskan paket yang relevan dari Knowledge Base, beri estimasi harga awal **berdasarkan paket di Knowledge Base** (jangan mengarang angka bila tidak ada di konteks).
${closingSteps}

## Informasi Penting
${p.establishedYear ? `- ${p.businessName} berpengalaman sejak **${p.establishedYear}**.\n` : ''}- Area layanan: ${p.serviceAreas}.
- ${handoffLine}

## Aturan Penggunaan Knowledge Base
- Untuk detail program/paket, **gunakan konteks (Knowledge Base & Produk) yang diberikan**.
- **Jangan menggunakan pengetahuan eksternal** soal harga/program. Bila informasi tidak ada di konteks, ${kbFallback} alih-alih menjawab "saya tidak tahu".`;
}
