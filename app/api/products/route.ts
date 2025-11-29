import { createClient } from '@/lib/supabase/server';
import { generateEmbedding } from '@/lib/ai/embedding';
import { NextResponse } from 'next/server';

export async function GET() {
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ products: data });
}

export async function POST(request: Request) {
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { name, description, price, stock, type = 'product' } = body;

    if (!name || !description || !price) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Validate type
    if (type !== 'product' && type !== 'service') {
        return NextResponse.json({ error: 'Invalid type. Must be "product" or "service"' }, { status: 400 });
    }

    // Auto-set stock for services (unlimited availability)
    const finalStock = type === 'service' ? 999999 : (stock || 0);

    // Generate embedding for the product/service
    const textToEmbed = `Type: ${type}\nName: ${name}\nDescription: ${description}\nPrice: ${price}${type === 'product' ? `\nStock: ${finalStock}` : ''}`;
    let embedding = null;

    try {
        embedding = await generateEmbedding(textToEmbed);
    } catch (e) {
        console.error("Embedding generation failed", e);
        return NextResponse.json({ error: 'Failed to generate embedding' }, { status: 500 });
    }

    const { data, error } = await supabase
        .from('products')
        .insert({
            name,
            description,
            price,
            stock: finalStock,
            type,
            embedding
        })
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}

