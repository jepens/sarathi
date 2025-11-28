import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { generateEmbedding } from '@/lib/ai/embedding';

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const supabase = await createClient();
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
    const { id } = await params;
    const body = await request.json();
    const { name, description, price, stock } = body;

    const updates: Record<string, unknown> = { ...body };

    if (name || description || price) {
        const { data: currentProduct, error: fetchError } = await supabase
            .from('products')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError) {
            return NextResponse.json({ error: fetchError.message }, { status: 500 });
        }

        const newName = name || currentProduct.name;
        const newDesc = description || currentProduct.description;
        const newPrice = price || currentProduct.price;
        const newStock = stock !== undefined ? stock : currentProduct.stock;

        const textToEmbed = `Product: ${newName}\nDescription: ${newDesc}\nPrice: ${newPrice}\nStock: ${newStock}`;

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
