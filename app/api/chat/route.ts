import { NextResponse } from 'next/server';
import { generateRAGResponse, ChatMessage } from '@/lib/ai/rag';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { message, history } = await request.json();

        if (!message) {
            return NextResponse.json(
                { error: 'Message is required' },
                { status: 400 }
            );
        }

        const response = await generateRAGResponse(message, history as ChatMessage[]);

        return NextResponse.json(response);

    } catch (error) {
        console.error('Error in chat route:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
