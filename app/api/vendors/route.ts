import { createClient } from '@/lib/supabase/server';
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
};

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
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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

    const insertRow = {
        name,
        category,
        contact_person: normalizeText(body.contact_person),
        phone: normalizeText(body.phone),
        email: normalizeText(body.email),
        address: normalizeText(body.address),
        notes: normalizeText(body.notes),
        created_by: user.id,
    };

    const { data, error } = await supabase
        .from('vendors')
        .insert(insertRow)
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}
