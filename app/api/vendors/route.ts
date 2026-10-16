import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { NextResponse } from 'next/server';
import { VENDOR_CATEGORIES, isVendorCategory } from '@/lib/vendors/categories';

// M4 — Vendor management CRUD.
// Contact-only scope: name, category, contact_person, phone, email, address, notes.
// Schema enforces category ∈ enum via CHECK constraint; we also validate here
// so we can return a friendly 400 instead of a 500 from Postgres.

type VendorInput = {
    name?: unknown;
    category?: unknown;
    contact_person?: unknown;
    phone?: unknown;
    email?: unknown;
    address?: unknown;
    notes?: unknown;
    chat_phone?: unknown;
};

// chat_phone links a vendor to its WhatsApp contact (whatsapp_chats.phone_number,
// digits-only canonical key). Normalize to digits so it matches the FK target.
function normalizeChatPhone(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const digits = v.replace(/\D/g, '');
    return digits.length > 0 ? digits : null;
}

// Guard against `null`, arrays, primitives that would crash `.name` access.
function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeText(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
}

export async function GET(request: Request) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase } = access;

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');
    const search = searchParams.get('q');

    let query = supabase
        .from('vendors')
        .select('*')
        .order('created_at', { ascending: false });

    if (category && isVendorCategory(category)) {
        query = query.eq('category', category);
    }

    if (search && search.trim().length > 0) {
        // Sanitize before injecting into PostgREST .or() — strip filter-breaking
        // chars (same defense we apply in /api/leads).
        const safe = search.replace(/[,()%_]/g, ' ').trim().replace(/\s+/g, ' ');
        if (safe.length > 0) {
            query = query.or(
                `name.ilike.%${safe}%,contact_person.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`
            );
        }
    }

    const { data, error } = await query;

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ vendors: data ?? [] });
}

export async function POST(request: Request) {
    const access = await requireOrgContext();
    if (!access.ok) return accessDeniedResponse(access);
    const { supabase, orgId } = access;

    let rawBody: unknown;
    try {
        rawBody = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!isPlainObject(rawBody)) {
        return NextResponse.json(
            { error: 'Request body must be a JSON object' },
            { status: 400 }
        );
    }
    const body = rawBody as VendorInput;

    const name = normalizeText(body.name);
    const category = normalizeText(body.category);

    if (!name) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!category || !isVendorCategory(category)) {
        return NextResponse.json(
            { error: `category must be one of: ${VENDOR_CATEGORIES.join(', ')}` },
            { status: 400 }
        );
    }

    const fields = {
        name,
        category,
        contact_person: normalizeText(body.contact_person),
        phone: normalizeText(body.phone),
        email: normalizeText(body.email),
        address: normalizeText(body.address),
        notes: normalizeText(body.notes),
    };
    const chatPhone = normalizeChatPhone(body.chat_phone);

    // Promote-from-contact path: a contact maps to at most one directory row.
    // If one already exists for this chat_phone, update it instead of inserting
    // a duplicate (also guarded at the DB level by uq_vendors_org_chat_phone).
    if (chatPhone) {
        const { data: existing } = await supabase
            .from('vendors')
            .select('id')
            .eq('org_id', orgId)
            .eq('chat_phone', chatPhone)
            .maybeSingle();

        if (existing) {
            // Fill-don't-clear: only write fields the promote actually provided.
            // The promote form omits `address` (and may leave optionals blank), so
            // a blind update would wipe curated vendor data on a re-promote.
            const updatePatch: Record<string, string> = {};
            for (const [k, v] of Object.entries(fields)) {
                if (v !== null) updatePatch[k] = v;
            }
            const { data, error } = await supabase
                .from('vendors')
                .update(updatePatch)
                .eq('org_id', orgId)
                .eq('id', existing.id)
                .select()
                .single();
            if (error) {
                return NextResponse.json({ error: error.message }, { status: 500 });
            }
            return NextResponse.json(data);
        }
    }

    const { data, error } = await supabase
        .from('vendors')
        // Explicit org — the column DEFAULT is the seed org (KUA-4).
        .insert({ ...fields, org_id: orgId, chat_phone: chatPhone, created_by: access.userId })
        .select()
        .single();

    if (error) {
        // FK violation: chat_phone doesn't reference a real contact.
        if (error.code === '23503') {
            return NextResponse.json(
                { error: 'chat_phone tidak cocok dengan kontak mana pun' },
                { status: 400 }
            );
        }
        // Unique violation: a directory row for this contact already exists
        // (race with the check above).
        if (error.code === '23505') {
            return NextResponse.json(
                { error: 'Kontak ini sudah ada di direktori vendor' },
                { status: 409 }
            );
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}
