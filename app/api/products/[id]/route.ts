import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { generateEmbedding } from '@/lib/ai/embedding';
import { productPatchSchema } from '@/lib/products/schema';

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const { error } = await supabase
        .from('products')
        .delete()
        .eq('id', id);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Whitelist the editable columns (KEA-18). Unknown keys — id, org_id,
    // created_at, embedding, … — are dropped, never written.
    const parsed = productPatchSchema.safeParse(raw);
    if (!parsed.success) {
        return NextResponse.json(
            { error: parsed.error.issues[0]?.message ?? 'Data produk tidak valid' },
            { status: 400 }
        );
    }
    const { name, description, price } = parsed.data;
    const stock = parsed.data.stock ?? undefined;
    const type = parsed.data.type ?? undefined;

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = price;
    if (type !== undefined) updates.type = type;

    // Fetch current product data
    const { data: currentProduct, error: fetchError } = await supabase
        .from('products')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError) {
        return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    // Determine final values
    const newName = name || currentProduct.name;
    const newDesc = description || currentProduct.description;
    const newPrice = price !== undefined ? price : currentProduct.price;
    const newType = type || currentProduct.type || 'product';

    // Auto-adjust stock when converting to service
    let newStock = stock !== undefined ? stock : currentProduct.stock;
    if (newType === 'service') {
        newStock = 999999; // Unlimited availability for services
    }
    updates.stock = newStock;

    // Regenerate embedding if key fields changed
    if (name || description || price || type) {
        const textToEmbed = `Type: ${newType}\nName: ${newName}\nDescription: ${newDesc}\nPrice: ${newPrice}${newType === 'product' ? `\nStock: ${newStock}` : ''}`;

        try {
            const embedding = await generateEmbedding(textToEmbed);
            updates.embedding = embedding;
        } catch (e) {
            console.error("Embedding generation failed", e);
            return NextResponse.json({ error: 'Failed to generate embedding' }, { status: 500 });
        }
    }

    const { data, error } = await supabase
        .from('products')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}

