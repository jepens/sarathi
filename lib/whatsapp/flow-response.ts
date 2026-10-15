import type { SupabaseClient } from '@supabase/supabase-js';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import { resolveSendTarget } from '@/lib/whatsapp/recipient';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { whatsappLogger } from '@/lib/utils/logger';
import { saveLeadInfo, updateLeadStage } from '@/lib/ai/tools';
import { getBusinessProfile } from '@/lib/settings/business-profile';

// ---------------------------------------------------------------------------
// WhatsApp Flow submission handler (interactive → nfm_reply).
//
// Pairs the "Brief Acara" Flow (docs/flow-brief-acara.json — v1 Flow ID
// 1338308915130746, v2 "Brief Acara - Sailendra v2" Flow ID 1790632228793903
// with cakupan_paket) with the Nindra RAG assistant:
//
//   1. Store the submission in chat history (resets the 24h window, shows in
//      the inbox like any customer message). The wa_message_id unique index is
//      the idempotency gate — Meta delivers webhooks at-least-once, and a
//      duplicate delivery must not double-create the lead or double-send the
//      confirmation.
//   2. Upsert the structured answers into the CRM via the same guarded path
//      the AI uses (saveLeadInfo) + advance lead_stage new → qualifying.
//   3. logSystemMessage a summary so the brief lands in Nindra's conversation
//      context — the assistant must NOT re-ask what the form already answered.
//   4. Send a deterministic confirmation reply (no AI round-trip needed).
//
// Field ids/labels are kept in sync with docs/flow-brief-acara.json.
// ---------------------------------------------------------------------------

const JENIS_ACARA_LABELS: Record<string, string> = {
    team_building: 'Team Building',
    capacity_building: 'Capacity Building',
    company_gathering: 'Company Gathering',
    family_gathering: 'Family Gathering',
    outing: 'Outing / Outbound',
    corporate_event: 'Corporate Event',
    lainnya: 'Lainnya',
};

// mid = single-number approximation for whatsapp_chats.participant_count
// (integer column; the AI tool uses range midpoints the same way).
const JUMLAH_PESERTA_OPTIONS: Record<string, { label: string; mid: number }> = {
    lt_50: { label: '< 50 orang', mid: 30 },
    '50_100': { label: '50-100 orang', mid: 75 },
    '100_300': { label: '100-300 orang', mid: 200 },
    gt_300: { label: '> 300 orang', mid: 350 },
};

const BUDGET_LABELS: Record<string, string> = {
    lt_50jt: '< Rp50 juta',
    '50_100jt': 'Rp50-100 juta',
    '100_250jt': 'Rp100-250 juta',
    gt_250jt: '> Rp250 juta',
    tbd: 'Belum ditentukan',
};

const CAKUPAN_PAKET_LABELS: Record<string, string> = {
    all_in: 'All-in / paket lengkap (akomodasi, meals, transportasi, program)',
    program_saja: 'Program saja (outbound, team building, fun games)',
    belum_tahu: 'Belum tahu / perlu konsultasi',
};

export interface NfmReplyPayload {
    name?: unknown; // "flow"
    body?: unknown; // "Sent"
    response_json?: unknown; // JSON string with the flow's complete-payload
}

export interface HandleFlowReplyParams {
    supabase: SupabaseClient;
    orgId: string;
    phoneNumberId: string;
    accessToken: string;
    /** Canonical CRM key (phone_number PK in whatsapp_chats). */
    contactKey: string;
    bsuid: string | null;
    waId: string | null;
    inboundWamid: string | null;
    nfmReply: NfmReplyPayload;
}

/** Parse nfm_reply.response_json defensively. Returns null when unusable. */
export function parseFlowResponse(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
}

/** Non-empty trimmed string, else null. */
function str(data: Record<string, unknown>, key: string): string | null {
    const v = data[key];
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
}

/** "2026-09-01 s/d 2026-09-03" | single date | null. */
function formatDateRange(mulai: string | null, selesai: string | null): string | null {
    if (mulai && selesai) return mulai === selesai ? mulai : `${mulai} s/d ${selesai}`;
    return mulai ?? selesai;
}

interface BriefAcara {
    jenisLabel: string | null;
    pesertaLabel: string | null;
    pesertaMid: number | null;
    tanggal: string | null;
    lokasi: string | null;
    cakupanId: string | null;
    cakupanLabel: string | null;
    budgetLabel: string | null;
    namaPerusahaan: string | null;
    namaPic: string | null;
    emailPic: string | null;
    catatan: string | null;
}

function extractBrief(data: Record<string, unknown>): BriefAcara {
    const jenisId = str(data, 'jenis_acara');
    const pesertaId = str(data, 'jumlah_peserta');
    const budgetId = str(data, 'budget');
    const cakupanId = str(data, 'cakupan_paket');
    const peserta = pesertaId ? JUMLAH_PESERTA_OPTIONS[pesertaId] ?? null : null;
    return {
        jenisLabel: jenisId ? JENIS_ACARA_LABELS[jenisId] ?? jenisId : null,
        pesertaLabel: peserta?.label ?? pesertaId,
        pesertaMid: peserta?.mid ?? null,
        tanggal: formatDateRange(str(data, 'tanggal_mulai'), str(data, 'tanggal_selesai')),
        lokasi: str(data, 'lokasi'),
        cakupanId,
        cakupanLabel: cakupanId ? CAKUPAN_PAKET_LABELS[cakupanId] ?? cakupanId : null,
        budgetLabel: budgetId ? BUDGET_LABELS[budgetId] ?? budgetId : null,
        namaPerusahaan: str(data, 'nama_perusahaan'),
        namaPic: str(data, 'nama_pic'),
        emailPic: str(data, 'email_pic'),
        catatan: str(data, 'catatan'),
    };
}

function briefSummaryLines(b: BriefAcara): string[] {
    const lines: string[] = [];
    if (b.jenisLabel) lines.push(`Jenis acara: ${b.jenisLabel}`);
    if (b.pesertaLabel) lines.push(`Jumlah peserta: ${b.pesertaLabel}`);
    if (b.tanggal) lines.push(`Tanggal: ${b.tanggal}`);
    if (b.lokasi) lines.push(`Lokasi: ${b.lokasi}`);
    if (b.cakupanLabel) lines.push(`Cakupan paket: ${b.cakupanLabel}`);
    if (b.budgetLabel) lines.push(`Budget: ${b.budgetLabel}`);
    if (b.namaPerusahaan) lines.push(`Perusahaan/instansi: ${b.namaPerusahaan}`);
    if (b.namaPic) lines.push(`PIC: ${b.namaPic}`);
    if (b.emailPic) lines.push(`Email: ${b.emailPic}`);
    if (b.catatan) lines.push(`Catatan: ${b.catatan}`);
    return lines;
}

function confirmationMessage(b: BriefAcara): string {
    const sapaan = b.namaPic ? `Terima kasih, ${b.namaPic}!` : 'Terima kasih!';
    const acara = b.jenisLabel ? ` untuk ${b.jenisLabel}` : '';
    return (
        `${sapaan} Brief acara${acara} sudah kami terima. ` +
        'Tim Sailendra akan menyiapkan penawarannya dan segera menghubungi Anda. ' +
        'Sambil menunggu, silakan tanyakan apa saja soal paket, venue, atau aktivitas — saya siap bantu.'
    );
}

/**
 * Handle one nfm_reply submission end-to-end. Never throws — the webhook must
 * always return 200 to Meta regardless of what fails here.
 */
export async function handleFlowReply(params: HandleFlowReplyParams): Promise<void> {
    const {
        supabase, orgId, phoneNumberId, accessToken,
        contactKey, bsuid, waId, inboundWamid, nfmReply,
    } = params;

    try {
        const data = parseFlowResponse(nfmReply.response_json);
        if (!data) {
            whatsappLogger.warn(`nfm_reply from ${contactKey} had no parsable response_json — skipping`);
            return;
        }

        const brief = extractBrief(data);
        const lines = briefSummaryLines(brief);
        const historyContent = lines.length > 0
            ? `📋 Brief Acara (via form WhatsApp)\n${lines.join('\n')}`
            : '📋 Brief Acara (via form WhatsApp) — form dikirim tanpa isian terbaca';
        const nowIso = new Date().toISOString();

        // -- 1a. Chat summary upsert (mirrors the inbound-text path; resets the
        //        24h window via last_inbound_at).
        const chatPatch: Record<string, unknown> = {
            org_id: orgId,
            phone_number: contactKey,
            last_message: '📋 Mengisi form Brief Acara',
            last_message_at: nowIso,
            last_inbound_at: nowIso,
            updated_at: nowIso,
        };
        if (bsuid) chatPatch.bsuid = bsuid;
        if (waId) chatPatch.verified_phone = waId;
        const { error: chatError } = await supabase
            .from('whatsapp_chats')
            .upsert(chatPatch, { onConflict: 'org_id,phone_number' });
        if (chatError) whatsappLogger.error('flow-response: chat summary upsert failed', chatError);

        // -- 1b. History insert = idempotency gate. Meta redelivers webhooks;
        //        the unique index on wa_message_id turns a duplicate into 23505,
        //        and we stop BEFORE lead writes / confirmation send.
        const { error: msgError } = await supabase
            .from('whatsapp_messages')
            .insert({
                org_id: orgId,
                phone_number: contactKey,
                role: 'user',
                content: historyContent,
                wa_message_id: inboundWamid,
            });
        if (msgError) {
            if (msgError.code === '23505') {
                whatsappLogger.info(`Duplicate flow reply ${inboundWamid} — already processed, skipping`);
                return;
            }
            // Non-duplicate failure: log and continue — losing the history row
            // is bad, but losing the lead + confirmation is worse.
            whatsappLogger.error('flow-response: history insert failed', msgError);
        }

        // -- 2a. CRM upsert through the same guarded path the AI uses (name
        //        lock, junk filter, company-email guard all apply).
        const profile = await getBusinessProfile(supabase, orgId);
        const saveResult = await saveLeadInfo(
            orgId,
            contactKey,
            {
                name: brief.namaPic,
                company: brief.namaPerusahaan,
                email: brief.emailPic,
                event_interest: brief.jenisLabel,
                participant_count: brief.pesertaMid,
                location_pref: brief.lokasi,
                event_date_pref: brief.tanggal,
                budget_range: brief.budgetLabel,
                source: 'whatsapp_flow',
                notes: (() => {
                    // Cakupan paket rides in notes (v1 minimal path — no schema
                    // migration). Promote to a dedicated column later if the
                    // pipeline needs to filter on it.
                    const parts: string[] = [];
                    if (brief.cakupanLabel) parts.push(`Cakupan paket: ${brief.cakupanLabel}`);
                    if (brief.catatan) parts.push(brief.catatan);
                    return parts.length > 0 ? `[Brief Acara] ${parts.join(' — ')}` : null;
                })(),
                contact_type: 'lead',
            },
            profile,
            // notes are appended (never overwritten) with this author label —
            // the brief comes from the customer's form, not from the AI.
            'WhatsApp Flow'
        );
        whatsappLogger.info(`flow-response: saveLeadInfo → ${saveResult}`);

        // -- 2b. Advance the pipeline, but never DOWNGRADE: only new/unset
        //        moves to qualifying (a quoted/scheduled/booked lead who re-fills
        //        the form keeps their stage).
        const { data: stageRow } = await supabase
            .from('whatsapp_chats')
            .select('lead_stage')
            .eq('org_id', orgId)
            .eq('phone_number', contactKey)
            .maybeSingle();
        const currentStage = stageRow?.lead_stage ?? null;
        if (currentStage === null || currentStage === 'new') {
            await updateLeadStage(orgId, contactKey, 'qualifying', 'Mengisi form Brief Acara (WhatsApp Flow)');
        }

        // -- 3. Context for Nindra: the brief becomes a system message in the
        //       conversation history, so the RAG assistant knows what was
        //       answered and moves the conversation FORWARD instead of re-asking.
        const belumTahuCakupan = brief.cakupanId === 'belum_tahu';
        await logSystemMessage(
            orgId,
            contactKey,
            `Customer mengisi form Brief Acara (WhatsApp Flow). ${lines.join(' · ')}. ` +
            'Data sudah tersimpan ke CRM dan lead stage sudah disesuaikan. ' +
            'JANGAN tanyakan ulang data di atas — lanjutkan dengan langkah berikutnya ' +
            '(rekomendasikan paket yang cocok, tawarkan jadwal meeting/survei, atau jawab pertanyaan lain).' +
            (belumTahuCakupan
                ? ' PENTING: customer BELUM menentukan cakupan paket — jelaskan perbedaan all-in ' +
                  '(akomodasi, meals, transportasi, program — tanpa repot koordinasi vendor) vs ' +
                  'program saja (outbound/team building/fun games di lokasi mereka), lalu bantu memilih.'
                : '')
        );

        // -- 4. Deterministic confirmation (no AI round-trip; Nindra takes over
        //       naturally on the customer's next free-text message).
        try {
            const confirmText = confirmationMessage(brief);
            // Send to the resolved target (recovered phone if known, else the
            // key/BSUID), not the raw inbound `from`.
            const target = await resolveSendTarget(supabase, orgId, contactKey);
            const sendResult = await sendWhatsAppMessage(target, confirmText, { phoneNumberId, accessToken });
            const { error: outError } = await supabase
                .from('whatsapp_messages')
                .insert({
                    org_id: orgId,
                    phone_number: contactKey,
                    role: 'assistant',
                    content: confirmText,
                    wa_message_id: sendResult.waMessageId,
                    status: 'sent',
                    status_updated_at: new Date().toISOString(),
                });
            if (outError) whatsappLogger.error('flow-response: confirmation history write failed (NOT resending)', outError);
        } catch (sendErr) {
            whatsappLogger.error(`flow-response: confirmation send to ${contactKey} failed`, sendErr);
        }

        whatsappLogger.info(`Flow "Brief Acara" processed for ${contactKey} (${lines.length} field(s))`);
    } catch (error) {
        whatsappLogger.error('flow-response: unexpected error handling nfm_reply', error);
    }
}
