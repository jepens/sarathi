import { getOpenAIApiKey } from '@/lib/settings/app-settings';
import { getBusinessProfile } from '@/lib/settings/business-profile';
import { getCurrentOrgId } from '@/lib/settings/org-context';
import { SupabaseClient } from '@supabase/supabase-js';

// FNA = Form Need Analysis. The structured client requirements the admin
// reviews right before sending a proposal, plus an optional AI-written
// narrative. A copy is frozen onto the proposals row at send time so we always
// know which brief a given proposal was built against, even after the live
// whatsapp_chats fields drift.

export interface FnaSnapshot {
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
    notes: string | null;
    source: string | null;
    ai_summary: string | null;
    captured_at: string;
}

function cleanStr(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
}

function cleanCount(v: unknown): number | null {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        return Math.round(n);
    }
    return null;
}

// Coerce an untrusted client-supplied object into a storable FnaSnapshot.
// captured_at is always stamped server-side. Returns null only when the input
// is not an object at all (caller treats that as "no FNA provided").
export function normalizeFnaSnapshot(input: unknown): FnaSnapshot | null {
    if (!input || typeof input !== 'object') return null;
    const o = input as Record<string, unknown>;
    return {
        event_interest: cleanStr(o.event_interest),
        participant_count: cleanCount(o.participant_count),
        location_pref: cleanStr(o.location_pref),
        event_date_pref: cleanStr(o.event_date_pref),
        event_goals: cleanStr(o.event_goals),
        budget_range: cleanStr(o.budget_range),
        notes: cleanStr(o.notes),
        source: cleanStr(o.source),
        ai_summary: cleanStr(o.ai_summary),
        captured_at: new Date().toISOString(),
    };
}

interface ChatCrmRow {
    contact_name: string | null;
    event_interest: string | null;
    participant_count: number | null;
    location_pref: string | null;
    event_date_pref: string | null;
    event_goals: string | null;
    budget_range: string | null;
    notes: string | null;
    source: string | null;
}

export interface FnaSummaryResult {
    ok: boolean;
    summary?: string;
    error?: string;
}

// Generate a concise needs-analysis narrative from the chat history + the
// structured CRM fields. Internal-only (admin reference), so plain Indonesian
// bullets are fine — no WhatsApp formatting concerns. Uses the cheap fast model
// since this is an on-demand admin action, mirroring summarizeConversation.
export async function generateFnaSummary(
    phoneNumber: string,
    supabase: SupabaseClient
): Promise<FnaSummaryResult> {
    const orgId = await getCurrentOrgId(supabase);
    if (!orgId) return { ok: false, error: 'Organisasi tidak ditemukan.' };
    const profile = await getBusinessProfile(supabase, orgId);
    const { data: crm } = await supabase
        .from('whatsapp_chats')
        .select(
            'contact_name, event_interest, participant_count, location_pref, event_date_pref, event_goals, budget_range, notes, source'
        )
        .eq('phone_number', phoneNumber)
        .maybeSingle<ChatCrmRow>();

    const { data: messages } = await supabase
        .from('whatsapp_messages')
        .select('role, content')
        .eq('phone_number', phoneNumber)
        .order('created_at', { ascending: false })
        .limit(40);

    const history = (messages ?? []).reverse();
    if (history.length === 0 && !crm) {
        return { ok: false, error: 'Belum ada riwayat chat untuk lead ini.' };
    }

    const transcript = history
        .map(
            (m) =>
                `${m.role === 'user' ? 'Customer' : m.role === 'assistant' ? profile.assistantName : 'System'}: ${m.content}`
        )
        .join('\n');

    const known = crm
        ? [
              crm.event_interest && `Jenis acara: ${crm.event_interest}`,
              crm.participant_count && `Jumlah peserta: ${crm.participant_count}`,
              crm.location_pref && `Lokasi: ${crm.location_pref}`,
              crm.event_date_pref && `Tanggal: ${crm.event_date_pref}`,
              crm.event_goals && `Tujuan: ${crm.event_goals}`,
              crm.budget_range && `Budget: ${crm.budget_range}`,
              crm.notes && `Catatan: ${crm.notes}`,
          ]
              .filter(Boolean)
              .join('\n')
        : '';

    try {
        // Lazy import so the OpenAI SDK stays out of bundles that only need the
        // pure normalizeFnaSnapshot helper (e.g. the proposal send route).
        const { default: OpenAI } = await import('openai');
        const apiKey = await getOpenAIApiKey();
        const openai = new OpenAI({ apiKey });

        const res = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.2,
            max_tokens: 400,
            messages: [
                {
                    role: 'system',
                    content:
                        `Anda asisten event organizer ${profile.businessName}. Buat ringkasan "Form Need Analysis" (analisa kebutuhan klien) ` +
                        'dalam Bahasa Indonesia berdasarkan percakapan WhatsApp dan data yang sudah tercatat. ' +
                        'Tulis 4-7 poin bullet padat (pakai tanda "-") yang mencakup: jenis & tujuan acara, jumlah peserta, ' +
                        'lokasi & tanggal, indikasi budget, kebutuhan/preferensi khusus, dan hal yang masih perlu dikonfirmasi. ' +
                        'Hanya fakta dari percakapan — jangan mengarang detail yang tidak disebut. Jika suatu poin belum diketahui, ' +
                        'tulis "(belum disebutkan)". Tanpa basa-basi pembuka/penutup.',
                },
                {
                    role: 'user',
                    content:
                        (known ? `DATA TERCATAT:\n${known}\n\n` : '') +
                        `TRANSKRIP CHAT:\n${transcript || '(tidak ada)'}`,
                },
            ],
        });

        const summary = res.choices[0]?.message?.content?.trim();
        if (!summary) {
            return { ok: false, error: 'Model tidak mengembalikan ringkasan.' };
        }
        return { ok: true, summary };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Gagal membuat ringkasan FNA';
        console.error('generateFnaSummary failed:', err);
        return { ok: false, error: msg };
    }
}
