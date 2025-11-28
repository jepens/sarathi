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
    const { name, description, price, stock } = body;

    if (!name || !description || !price) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Generate embedding for the product
    const textToEmbed = `Product: ${name}\nDescription: ${description}\nPrice: ${price}\nStock: ${stock}`;
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
            stock: stock || 0,
            embedding
        })
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}
