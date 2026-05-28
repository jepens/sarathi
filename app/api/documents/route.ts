import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

interface DocumentMetadata {
    file_name?: string;
    source?: string;
    file_type?: string;
    created_at?: string;
    chunk_index?: number;
}

interface DocumentRecord {
    id: string;
    content: string;
    metadata: DocumentMetadata;
}

interface UniqueDocument {
    id: string;
    file_name: string;
    file_type: string;
    created_at: string;
    chunk_count: number;
}

export async function GET() {
    try {
        const supabase = await createClient();

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Fetch all documents with their metadata
        const { data: documents, error } = await supabase
            .from('documents')
            .select('id, content, metadata');

        if (error) {
            console.error('Error fetching documents:', error);
            return NextResponse.json(
                { error: 'Failed to fetch documents' },
                { status: 500 }
            );
        }

        // Group chunks by file_name to get unique documents
        const uniqueDocuments = new Map<string, UniqueDocument>();

        (documents as DocumentRecord[])?.forEach((doc) => {
            const metadata = doc.metadata;
            const fileName = metadata?.file_name || metadata?.source || 'unknown';
            const fileType = metadata?.file_type || 'text/plain';
            const createdAt = metadata?.created_at || new Date().toISOString();

            if (!uniqueDocuments.has(fileName)) {
                uniqueDocuments.set(fileName, {
                    id: doc.id,
                    file_name: fileName,
                    file_type: fileType,
                    created_at: createdAt,
                    chunk_count: 1,
                });
            } else {
                const existing = uniqueDocuments.get(fileName);
                if (existing) {
                    existing.chunk_count += 1;
                }
            }
        });

        // Convert to array and sort by created_at from metadata
        const result = Array.from(uniqueDocuments.values()).sort((a, b) => {
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });

        return NextResponse.json({
            documents: result,
            total: result.length,
            total_chunks: documents?.length || 0,
        });
    } catch (error) {
        console.error('Error in GET /api/documents:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const fileName = searchParams.get('fileName');

        if (!fileName) {
            return NextResponse.json(
                { error: 'fileName parameter is required' },
                { status: 400 }
            );
        }

        const supabase = await createClient();

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Find document chunks that match the filename in metadata
        // We check both file_name and source fields for backward compatibility
        const { data: matchingDocs, error: fetchError } = await supabase
            .from('documents')
            .select('id')
            .or(`metadata->>file_name.eq.${fileName},metadata->>source.eq.${fileName}`);

        if (fetchError) {
            console.error('Error fetching documents:', fetchError);
            return NextResponse.json(
                { error: 'Failed to fetch documents' },
                { status: 500 }
            );
        }

        const idsToDelete = matchingDocs?.map((doc) => doc.id) || [];

        if (idsToDelete.length === 0) {
            return NextResponse.json(
                { error: 'Document not found' },
                { status: 404 }
            );
        }

        // Delete all chunks of this document from database
        const { error: dbError } = await supabase
            .from('documents')
            .delete()
            .in('id', idsToDelete);

        if (dbError) {
            console.error('Error deleting from database:', dbError);
            return NextResponse.json(
                { error: 'Failed to delete document from database' },
                { status: 500 }
            );
        }

        // Delete file from storage
        const { error: storageError } = await supabase.storage
            .from('documents')
            .remove([fileName]);

        if (storageError) {
            console.error('Error deleting from storage:', storageError);
            // Don't fail the request if storage deletion fails
            // The database record is already deleted
        }

        // If this document was authored in the dashboard editor, also drop its
        // canonical source row so it doesn't linger in the editor list.
        // Best-effort — editor-authored docs use file_name === source === title.
        const { error: kbSourceError } = await supabase
            .from('kb_sources')
            .delete()
            .eq('title', fileName);
        if (kbSourceError) {
            console.error('Error deleting kb_source (non-fatal):', kbSourceError);
        }

        return NextResponse.json({
            success: true,
            message: 'Document deleted successfully',
        });
    } catch (error) {
        console.error('Error in DELETE /api/documents:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
