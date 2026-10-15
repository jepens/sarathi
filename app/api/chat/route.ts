import { NextResponse } from 'next/server';
import { generateRAGResponse, ChatMessage } from '@/lib/ai/rag';
import { createClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/settings/org-context';

export async function POST(request: Request) {
    try {
        const supabase = await createClient();
        // The sandbox answers as the caller's OWN org (KB, products, persona) —
        // never the default org's.
        const access = await requireOrgMember(supabase);
        if (!access.ok) {
            return NextResponse.json({ error: access.error }, { status: access.status });
        }

        const { message, history } = await request.json();

        if (!message) {
            return NextResponse.json(
                { error: 'Message is required' },
                { status: 400 }
            );
        }

        const response = await generateRAGResponse(message, history as ChatMessage[], undefined, {
            orgId: access.orgId,
        });

        return NextResponse.json(response);

    } catch (error) {
        console.error('Error in chat route:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
