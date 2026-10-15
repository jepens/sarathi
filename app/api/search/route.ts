import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';
import { generateEmbedding } from '@/lib/ai/embedding';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    try {
        const access = await requireOrgContext();
        if (!access.ok) return accessDeniedResponse(access);
        const { supabase, orgId } = access;

        const { query } = await request.json();

        if (!query) {
            return NextResponse.json(
                { error: 'Query is required' },
                { status: 400 }
            );
        }

        // Generate embedding for the search query
        const queryEmbedding = await generateEmbedding(query);

        // Search for similar documents using the match_documents function
        const { data: results, error } = await supabase.rpc('match_documents', {
            query_embedding: queryEmbedding,
            match_threshold: 0.5, // Minimum similarity threshold
            match_count: 5, // Return top 5 results
            filter_org_id: orgId, // only the caller's own KB
        });

        if (error) {
            console.error('Error searching documents:', error);
            return NextResponse.json(
                { error: 'Failed to search documents' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            query,
            results: results || [],
            count: results?.length || 0,
        });
    } catch (error) {
        console.error('Error in POST /api/search:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
