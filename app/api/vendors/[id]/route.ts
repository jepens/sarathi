import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { VENDOR_CATEGORIES, isVendorCategory } from '@/lib/vendors/categories';

// UUID v4-ish guard. We don't need strict v4 semantics — just enough to
// reject obvious garbage before hitting Postgres and getting a 500.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type VendorPatch = {
    name?: unknown;
    category?: unknown;
    contact_person?: unknown;
    phone?: unknown;
    email?: unknown;
    address?: unknown;
    notes?: unknown;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeOptional(v: unknown): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
        return NextResponse.json({ error: 'Invalid vendor id' }, { status: 400 });
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
    const body = rawBody as VendorPatch;

    const patch: Record<string, string | null> = {};

    if (body.name !== undefined) {
        const v = normalizeOptional(body.name);
        if (v === null || v === undefined) {
            return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
        }
        patch.name = v;
    }

    if (body.category !== undefined) {
        const v = normalizeOptional(body.category);
        if (!v || !isVendorCategory(v)) {
            return NextResponse.json(
                { error: `category must be one of: ${VENDOR_CATEGORIES.join(', ')}` },
                { status: 400 }
            );
        }
        patch.category = v;
    }

    for (const field of ['contact_person', 'phone', 'email', 'address', 'notes'] as const) {
        const v = normalizeOptional(body[field]);
        if (v !== undefined) patch[field] = v;
    }

    if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('vendors')
        .update(patch)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        if (error.code === 'PGRST116') {
            return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
        return NextResponse.json({ error: 'Invalid vendor id' }, { status: 400 });
    }

    const { error } = await supabase.from('vendors').delete().eq('id', id);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
